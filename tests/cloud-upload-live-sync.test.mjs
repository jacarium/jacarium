/**
 * Guards against the "Upload to Cloud doesn't engage live sync" bug:
 * after Alice right-clicks a document -> "Share with the Team", her continued
 * typing must reach Bob live (via Yjs through the central server) WITHOUT a
 * second manual "Sync Changes". Historical root causes covered:
 *   1. the still-open editor's `document` prop never received
 *      inCloud/cloudDocumentId, so yjsEnabled never flipped (Alice side), and
 *   2. createDocument() dropped cloudDocumentId when the receiving machine
 *      stored the broadcast copy, so the receiver could never join the Yjs
 *      room (Bob side).
 *
 * This is a self-contained end-to-end test with NO test framework:
 *   - spins up a REAL jacarium-central (random free port, temp DATA_DIR),
 *   - bundles the REAL app (DocumentsPage + DocumentSidebar + DocumentEditor +
 *     real cloudWebSocket/cloudCentralSync/yjsProvider/documents modules) with
 *     esbuild and mounts it in two jsdom "machines" (alice@account-test / bob@account-test)
 *     connected over real socket.io,
 *   - drives the actual UI: sidebar click to open, contextmenu ->
 *     "Share with the Team", real input events for typing,
 *   - asserts on the receiving side's stored record and live editor content.
 *
 * Run:  node tests/cloud-upload-live-sync.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - central server deps installed:     cd jacarium-central && npm ci
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 * Per-client and server logs are written to a temp dir printed at startup.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

// ---------- precondition checks ----------
function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');
if (!fs.existsSync(path.join(REPO, 'jacarium-central', 'node_modules'))) {
  console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-upload-live-sync-'));
console.log('work/log dir:', WORKDIR);

// ---------- bundle the real app for the jsdom clients ----------
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle-client.cjs');
await build({
  entryPoints: [path.join(here, 'helpers', 'client-app.mjs')],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

// ---------- test scaffolding ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

class Client {
  constructor(name, env) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.log = fs.createWriteStream(path.join(WORKDIR, `${name}.log`));
    this.readyPromise = new Promise((resolve) => { this.onReady = resolve; });
    this.proc = spawn('node', [path.join(here, 'helpers', 'run-client.mjs')], {
      cwd: REPO,
      env: { ...process.env, CLIENT_BUNDLE: BUNDLE, ACCOUNT_TICKET_KEY, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      this.log.write(d);
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (line.startsWith('@@RES ')) {
          const obj = JSON.parse(line.slice(6));
          const p = this.pending.get(obj.id);
          if (p) { this.pending.delete(obj.id); p(obj); }
        } else if (line.startsWith('@@EVT ')) {
          const obj = JSON.parse(line.slice(6));
          if (obj.ready) this.onReady(obj);
          if (obj.fatal) console.error(`[${this.name}] FATAL:`, obj.fatal);
        }
      }
    });
    this.proc.stderr.on('data', (d) => this.log.write(d));
  }
  cmd(cmd, args = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} cmd ${cmd} timeout`));
      }, timeoutMs);
      this.pending.set(id, (obj) => { clearTimeout(t); resolve(obj); });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }
  kill() { try { this.proc.kill(); } catch { /* ignore */ } }
}

const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// the key the spawned central server and the clients' fake home server share (tests/helpers/run-client.mjs mints the account tickets with it)
const ACCOUNT_TICKET_KEY = '0123456789abcdef'.repeat(4);

// ---------- start the real central server ----------
const DATA_DIR = path.join(WORKDIR, 'server-data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const serverLog = fs.createWriteStream(path.join(WORKDIR, 'server.log'));
const server = spawn('node', ['server.js'], {
  cwd: path.join(REPO, 'jacarium-central'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ACCOUNT_TICKET_KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => serverLog.write(d));
server.stderr.on('data', (d) => serverLog.write(d));
await sleep(1200);

// ---------- scenario ----------
const DOC = 'E2E Live Doc';
const alice = new Client('alice', {
  MACHINE_ID: 'alice@account-test', SERVER_URL,
  CREATE_DOC_TITLE: DOC, CREATE_DOC_CONTENT: 'hello from alice',
});
const bob = new Client('bob', { MACHINE_ID: 'bob@account-test', SERVER_URL });

let exitCode = 1;
try {
  await Promise.all([alice.readyPromise, bob.readyPromise]);
  await sleep(1500);
  check('alice websocket connected+authenticated', (await alice.cmd('status')).connected);
  check('bob websocket connected+authenticated', (await bob.cmd('status')).connected);

  // Alice opens the document through the real sidebar
  const open = await alice.cmd('click-doc', { title: DOC });
  check('alice opened doc via sidebar click', open.ok, open.error);
  const ta0 = await alice.cmd('textarea');
  check('alice editor shows content', ta0.value === 'hello from alice', JSON.stringify(ta0.value));

  // Alice right-clicks the doc -> Upload to Cloud (real context-menu path)
  const ctx = await alice.cmd('ctx-doc', { title: DOC });
  check('context menu shows Share with the Team', (ctx.buttons || []).includes('Share with the Team'), JSON.stringify(ctx.buttons));
  const up = await alice.cmd('click-menu', { label: 'Share with the Team' });
  check('clicked Share with the Team', up.ok, up.error);
  await sleep(2500); // upload + onCloudUploadSuccess + loadDocuments + broadcast

  // Alice side: the STILL-OPEN editor must now carry the cloud metadata
  const ed1 = await alice.cmd('editor-doc');
  check('alice editor document.inCloud flipped true (real tree)',
    ed1.document && ed1.document.inCloud === true, JSON.stringify(ed1.document));
  check('alice editor document.cloudDocumentId present (real tree)',
    !!(ed1.document && ed1.document.cloudDocumentId), JSON.stringify(ed1.document));

  // Bob side: the received copy must keep the shared Yjs room id
  let bobDoc = null;
  for (let i = 0; i < 20 && !bobDoc; i++) {
    const r = await bob.cmd('docs');
    bobDoc = (r.docs || []).find((d) => d.title === DOC) || null;
    if (!bobDoc) await sleep(500);
  }
  check('bob received the document', !!bobDoc, JSON.stringify(bobDoc));
  check('bob stored cloudDocumentId (can join the Yjs room)',
    !!(bobDoc && bobDoc.cloudDocumentId), JSON.stringify(bobDoc && bobDoc.cloudDocumentId));

  // Bob opens the doc in his real editor
  const bOpen = await bob.cmd('click-doc', { title: DOC });
  check('bob opened doc via sidebar click', bOpen.ok, bOpen.error);
  await sleep(1500); // let bob's yjs session sync

  // Alice keeps typing AFTER the upload — the exact reported bug scenario
  await alice.cmd('type', { text: ' LIVE-EDIT-1' });
  await sleep(500);
  await alice.cmd('type', { text: ' LIVE-EDIT-2' });

  // Bob must see it live, without any manual re-sync
  let bobSaw = false; let lastVal = null;
  for (let i = 0; i < 24; i++) {
    const t = await bob.cmd('textarea');
    lastVal = t.value;
    if (t.value && t.value.includes('LIVE-EDIT-2')) { bobSaw = true; break; }
    await sleep(500);
  }
  check("bob sees alice's post-upload typing live (no manual re-sync)", bobSaw, JSON.stringify(lastVal));

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  alice.kill(); bob.kill(); server.kill();
  await sleep(300);
  process.exit(exitCode);
}
