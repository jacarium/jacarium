/**
 * Guards against two collaborative-cursor rendering bugs in DocumentEditor
 * (both observed in real multi-machine testing of cloud documents):
 *
 * Bug 1 - "Cursor flicker": while both users type at the same time, the
 *   remote peer's cursor briefly renders at a wrong position (jumping toward
 *   the beginning of the line) before snapping back. Root cause: awareness
 *   cursor positions are ABSOLUTE character indices computed against the
 *   sender's document state; when the receiver's document has concurrent
 *   edits the sender hadn't seen yet, that index lands in the wrong place
 *   until the peer re-broadcasts. Fixed by carrying Yjs RELATIVE positions
 *   (anchor/head) in the awareness cursor field and re-resolving them against
 *   the live local Y.Doc on every text change - immune to message timing.
 *   The test has both simulated machines type rapidly at the same time while
 *   a MutationObserver records EVERY rendered frame of the remote cursor
 *   overlay; since the observed peer only ever types at the end of the
 *   document, every rendered frame must show its cursor exactly at
 *   end-of-content - any deviating frame is the flicker.
 *
 * Bug 2 - "Cursor invisible in large documents": the overlay's vertical
 *   position was computed as (logicalLineNumber - 1) * lineHeight, ignoring
 *   soft line wrapping, while the textarea itself wraps long lines across
 *   multiple visual rows. In a large document with wrapped lines the computed
 *   `top` falls thousands of pixels above the cursor's real location, so
 *   viewport culling silently drops the overlay - the remote cursor never
 *   shows. Fixed by computing `top` from lineLayoutData's cumulative
 *   wrap-aware per-line heights (the same system the gutter uses).
 *   The test builds a 1200-line document whose first 1000 lines each wrap
 *   into 2 visual rows (via stubbed textarea geometry), parks the remote
 *   peer's cursor at the end, scrolls the viewer to the cursor's TRUE visual
 *   position (must be rendered there, at the exact wrap-aware coordinates)
 *   and to the naive un-wrapped position (must NOT be rendered there).
 *
 * Self-contained end-to-end test in the style of cloud-upload-live-sync:
 * real jacarium-central, real socket.io, real Yjs, the real DocumentsPage/
 * DocumentEditor tree mounted in jsdom for each simulated machine.
 *
 * Run:  node tests/collab-cursor-rendering.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:               npm install
 *   - central server deps installed:     cd jacarium-central && npm ci
 *   - test-only deps:                    npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cursor-rendering-'));
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
    this.machineId = env.MACHINE_ID; // the identity the owner grants Read & Write to
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

// Rendering constants mirrored from DocumentEditor's overlay math
const LINE_H = 22.4;     // 1.6 line-height * 14px font
const CHAR_W = 8.4;      // jsdom measures 0, so the editor falls back to 8.4
const PAD_TOP = 16;      // textarea py-4 top padding added to overlay top
const PAD_LEFT = 24;     // textarea px-6 left padding added to overlay left

/**
 * Shared flow: owner uploads its pre-created doc to the cloud, the other
 * machine receives the broadcast copy and opens it, then waits until its
 * editor holds the full synced content.
 */
async function shareAndOpen(owner, receiver, title, expectedLen) {
  const open = await owner.cmd('click-doc', { title });
  check(`${owner.name} opened doc via sidebar click`, open.ok, open.error);

  const ctx = await owner.cmd('ctx-doc', { title });
  check(`${owner.name} context menu shows Share with the Team`,
    (ctx.buttons || []).includes('Share with the Team'), JSON.stringify(ctx.buttons));
  const up = await owner.cmd('click-menu', { label: 'Share with the Team' });
  check(`${owner.name} clicked Share with the Team`, up.ok, up.error);
  await sleep(2500);

  let doc = null;
  for (let i = 0; i < 20 && !doc; i++) {
    const r = await receiver.cmd('docs');
    doc = (r.docs || []).find((d) => d.title === title && d.cloudDocumentId) || null;
    if (!doc) await sleep(500);
  }
  check(`${receiver.name} received the cloud document`, !!doc, doc ? undefined : 'not received');

  // Both machines type in these scenarios, so the receiver needs Read &
  // Write: the central server refuses live edits from anyone else and the
  // receiver's editor is read-only until the grant arrives.
  const grant = await owner.cmd('grant-write', { title, identity: receiver.machineId });
  check(`${owner.name} granted ${receiver.name} Read & Write`, grant.ok, grant.error);

  const rOpen = await receiver.cmd('click-doc', { title });
  check(`${receiver.name} opened doc via sidebar click`, rOpen.ok, rOpen.error);

  let len = -1;
  let readOnly = true;
  for (let i = 0; i < 30; i++) {
    const t = await receiver.cmd('textarea');
    len = t.value ? t.value.length : -1;
    readOnly = t.readOnly !== false;
    if (len === expectedLen && !readOnly) break;
    await sleep(500);
  }
  check(`${receiver.name} editor fully synced (${expectedLen} chars)`, len === expectedLen, `got ${len}`);
  check(`${receiver.name} editor is editable (the grant arrived)`, !readOnly);
}

let exitCode = 1;
const clients = [];
try {
  // ================================================================
  // Scenario 1 (Bug 1): cursor flicker while both users type at once
  // ================================================================
  console.log('\n--- Scenario 1: simultaneous typing must never flicker the remote cursor ---');
  const DOC1 = 'Flicker Doc';
  const BASE1 = 'alpha line\nbravo line'; // alice types at end of line 1, bob at end of doc
  const alice1 = new Client('alice1', {
    MACHINE_ID: 'alice1@account-test', SERVER_URL,
    CREATE_DOC_TITLE: DOC1, CREATE_DOC_CONTENT: BASE1,
  });
  const bob1 = new Client('bob1', { MACHINE_ID: 'bob1@account-test', SERVER_URL });
  clients.push(alice1, bob1);

  await Promise.all([alice1.readyPromise, bob1.readyPromise]);
  await sleep(1500);
  check('alice1 websocket connected', (await alice1.cmd('status')).connected);
  check('bob1 websocket connected', (await bob1.cmd('status')).connected);

  await shareAndOpen(alice1, bob1, DOC1, BASE1.length);

  // Park the carets: alice at end of line 1, bob at end of the document.
  await alice1.cmd('set-cursor', { pos: 'alpha line'.length });
  await bob1.cmd('set-cursor', { pos: BASE1.length });
  await sleep(800);

  // Record every rendered frame of bob's cursor overlay on alice's screen.
  await alice1.cmd('watch-cursor', { name: 'bob1' });

  // Both machines type rapidly AT THE SAME TIME (the reported repro).
  const A_CHARS = 60, B_CHARS = 40;
  await Promise.all([
    alice1.cmd('burst-type', { text: 'a'.repeat(A_CHARS), intervalMs: 10 }, 60000),
    bob1.cmd('burst-type', { text: 'b'.repeat(B_CHARS), intervalMs: 20 }, 60000),
  ]);
  await sleep(1500); // let all in-flight updates land

  const watch = await alice1.cmd('unwatch-cursor');
  const samples = watch.samples || [];

  // Sanity: both editors converged on the same, expected content.
  const aFinal = (await alice1.cmd('textarea')).value;
  const bFinal = (await bob1.cmd('textarea')).value;
  const expectedFinal = 'alpha line' + 'a'.repeat(A_CHARS) + '\nbravo line' + 'b'.repeat(B_CHARS);
  check('scenario 1: both editors converged to the expected content',
    aFinal === expectedFinal && bFinal === expectedFinal,
    `aliceLen=${aFinal && aFinal.length} bobLen=${bFinal && bFinal.length} expected=${expectedFinal.length}`);

  // Ground truth: bob only ever types at the very END of the document, so at
  // EVERY instant his cursor is at end-of-content - i.e. every rendered frame
  // of his overlay must sit at (last line, last column) OF THE CONTENT AS
  // RENDERED IN THAT SAME FRAME. Any deviating frame is the flicker bug.
  const frames = [];
  let seen = false;
  for (const s of samples) {
    if (s.present) seen = true;
    if (seen) frames.push(s);
  }
  const mismatches = [];
  let lineStartJumps = 0;
  for (const s of frames) {
    if (!s.present) { mismatches.push({ ...s, why: 'overlay missing' }); continue; }
    const expTop = (s.lineCount - 1) * LINE_H + PAD_TOP - s.scrollTop;
    const expLeft = s.lastLineLen * CHAR_W + PAD_LEFT - s.scrollLeft;
    if (Math.abs(s.top - expTop) > 0.5 || Math.abs(s.left - expLeft) > 0.5) {
      mismatches.push({ ...s, expTop, expLeft });
      if (Math.abs(s.left - PAD_LEFT) <= 0.5 && expLeft > PAD_LEFT + CHAR_W) lineStartJumps++;
    }
  }
  check('scenario 1: cursor overlay was actually rendered and re-rendered during typing',
    frames.length >= 5, `rendered frames: ${frames.length}`);
  check('scenario 1: NO rendered frame ever showed the remote cursor away from its true position (no flicker)',
    mismatches.length === 0,
    `${mismatches.length}/${frames.length} bad frames (${lineStartJumps} at line start), e.g. ${JSON.stringify(mismatches.slice(0, 3))}`);

  alice1.kill(); bob1.kill();
  await sleep(300);

  // =====================================================================
  // Scenario 2 (Bug 2): remote cursor must render in a large wrapped doc
  // =====================================================================
  console.log('\n--- Scenario 2: remote cursor in a large document with soft-wrapped lines ---');
  // Geometry stubbed on alice2's textarea: 336px wide -> floor(336/8.4) = 40
  // chars per visual row. 1000 lines x 80 chars wrap into 2 rows each; the
  // remaining 200 lines x 20 chars are 1 row each.
  const TA_W = 336, TA_H = 448;
  const CHARS_PER_ROW = Math.floor(TA_W / CHAR_W); // 40
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`L${i}`.padEnd(80, 'x'));
  for (let i = 1000; i < 1200; i++) lines.push(`S${i}`.padEnd(20, 'y'));
  const BIG = lines.join('\n');
  const LAST_LINE_LEN = 20;
  const visualRowsBeforeLast = 1000 * Math.ceil(80 / CHARS_PER_ROW) + 199 * 1; // 2199
  const TRUE_TOP = visualRowsBeforeLast * LINE_H;          // 49257.6 (wrap-aware)
  const NAIVE_TOP = (lines.length - 1) * LINE_H;           // 26857.6 (wrap-blind)
  const TRUE_SCROLL = 48900;   // viewport [48900..49348]: contains TRUE_TOP only
  const NAIVE_SCROLL = 26800;  // viewport [26800..27248]: contains NAIVE_TOP only

  const DOC2 = 'Big Wrapped Doc';
  const alice2 = new Client('alice2', {
    MACHINE_ID: 'alice2@account-test', SERVER_URL,
    CREATE_DOC_TITLE: DOC2, CREATE_DOC_CONTENT: BIG,
    TA_CLIENT_WIDTH: String(TA_W), TA_CLIENT_HEIGHT: String(TA_H),
  });
  const bob2 = new Client('bob2', { MACHINE_ID: 'bob2@account-test', SERVER_URL });
  clients.push(alice2, bob2);

  await Promise.all([alice2.readyPromise, bob2.readyPromise]);
  await sleep(1500);
  check('alice2 websocket connected', (await alice2.cmd('status')).connected);
  check('bob2 websocket connected', (await bob2.cmd('status')).connected);

  await shareAndOpen(alice2, bob2, DOC2, BIG.length);

  // Bob parks his cursor at the very end of the document (line 1200).
  await bob2.cmd('set-cursor', { pos: BIG.length });
  await sleep(1000); // awareness propagation + render

  // Alice scrolls to where bob's cursor REALLY is (wrap-aware position).
  await alice2.cmd('scroll-to', { top: TRUE_SCROLL });
  await sleep(700); // scroll state throttle (100ms in perf mode) + render
  const atTrue = await alice2.cmd('cursor-overlay', { name: 'bob2' });
  const expTop2 = TRUE_TOP + PAD_TOP - TRUE_SCROLL;
  const expLeft2 = LAST_LINE_LEN * CHAR_W + PAD_LEFT;
  check("scenario 2: bob's cursor IS rendered at its true visual position in the wrapped document",
    atTrue.present, JSON.stringify(atTrue));
  check(`scenario 2: rendered top matches wrap-aware position (expected ~${expTop2.toFixed(1)}px)`,
    atTrue.present && Math.abs(atTrue.top - expTop2) <= 2,
    `top=${atTrue.top} left=${atTrue.left}`);
  check(`scenario 2: rendered left matches column position (expected ~${expLeft2.toFixed(1)}px)`,
    atTrue.present && Math.abs(atTrue.left - expLeft2) <= 2,
    `left=${atTrue.left}`);

  // At the naive (wrap-blind) position the cursor must NOT appear - it was
  // exactly this ghost location the pre-fix code rendered it at.
  await alice2.cmd('scroll-to', { top: NAIVE_SCROLL });
  await sleep(700);
  const atNaive = await alice2.cmd('cursor-overlay', { name: 'bob2' });
  check("scenario 2: bob's cursor is NOT rendered at the wrap-blind ghost position",
    !atNaive.present, JSON.stringify(atNaive));

  alice2.kill(); bob2.kill();

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  clients.forEach((c) => c.kill());
  server.kill();
  await sleep(300);
  process.exit(exitCode);
}
