/**
 * Guards the two document-sync performance fixes:
 *
 * HALF 1 - handleAutoSave's cloud snapshot uploads (DocumentsPage.jsx):
 *   Investigated finding: for a document with LIVE Yjs sync (inCloud +
 *   cloudDocumentId), body typing goes through yjs.updateContent and never
 *   updates DocumentsPage's `content` state, so the 1s autosave debounce never
 *   fires for it - live-Yjs body typing was NEVER the upload storm (S1 proves
 *   0 uploads). The real problems were:
 *     a) a cloud document WITHOUT a cloudDocumentId (never engaged Yjs):
 *        every debounce-settle uploaded a full snapshot, forever, because the
 *        autosave path never fed the freshly-assigned cloudDocumentId back
 *        into the open editor. Fixed: after the first autosave upload the
 *        cloud metadata is merged into the editor state (same
 *        handleCloudUploadSuccess pattern as explicit "Share with the Team"), so
 *        Yjs engages and later body typing stops uploading snapshots (S3).
 *     b) title/category edits on a live-Yjs doc (e.g. sidebar rename): the
 *        autosave wrote the STALE React `content` state (frozen at doc-open
 *        time, since Yjs bypasses it) back over the Yjs-fresh IndexedDB copy
 *        and uploaded that stale body in the snapshot, regressing every
 *        peer's stored copy. Fixed: for live-Yjs docs autosave persists only
 *        title/category and uploads the IndexedDB (Yjs-fresh) body (S2).
 *
 * HALF 2 - handleCloudDocumentsReceived full reload (DocumentsPage.jsx):
 *   Every incoming documents-update from ANY peer for ANY document used to
 *   trigger a full loadDocuments() (entire list + categories + current/right
 *   doc refresh). Now cloudSync.processDocumentQueue reports per-document
 *   results ({action, documentId}) in the cloudDocumentsReceived event and
 *   the handler updates ONLY the affected documents in state - including the
 *   pre-existing deleted-tab cleanup, now driven by the removal results
 *   instead of a before/after reload diff. S2-S5 assert ZERO
 *   loadDocuments() calls on the receiving client while updates, creations
 *   and removals still land in its sidebar/tabs/editor.
 *
 * Self-contained end-to-end test, NO mocks (same pattern as
 * tests/cloud-upload-live-sync.test.mjs): real jacarium-central, real
 * DocumentsPage/DocumentSidebar/DocumentEditor tree in jsdom per "machine"
 * (alice@account-test / bob@account-test), real socket.io + Yjs + (fake-)IndexedDB.
 * Call counts are measured from each client's captured console log
 * ('[AutoSave] Syncing to cloud:' / '[DocumentsPage] loadDocuments() called').
 *
 * Run:  node tests/doc-sync-targeted-updates.test.mjs
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-sync-targeted-'));
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
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
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
    this.logPath = path.join(WORKDIR, `${name}.log`);
    this.log = fs.createWriteStream(this.logPath);
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
  // Count occurrences of a log pattern in this client's captured console
  // output (real app console.log lines - our call-count instrumentation).
  logCount(pattern) {
    let txt = '';
    try { txt = fs.readFileSync(this.logPath, 'utf8'); } catch { /* not yet */ }
    return txt.split(pattern).length - 1;
  }
  kill() { try { this.proc.kill(); } catch { /* ignore */ } }
}

const AUTOSAVE_UPLOAD = '[AutoSave] Syncing to cloud:'; // left-pane autosave snapshot upload
const FULL_RELOAD = '[DocumentsPage] loadDocuments() called'; // the full-reload path

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
const LIVE = 'E2E Perf Live Doc';
const LIVE_RENAMED = 'E2E Perf Live Doc R1';
const SNAP = 'E2E Perf Snapshot Doc';

const alice = new Client('alice', {
  MACHINE_ID: 'alice@account-test', SERVER_URL,
  CREATE_DOCS_JSON: JSON.stringify([
    { title: LIVE, content: 'hello from alice', category: 'General' },
    // The "cloud doc that never engaged Yjs" shape: inCloud but NO
    // cloudDocumentId (e.g. synced before cloudDocumentId existed).
    {
      title: SNAP, content: 'snap start', category: 'General',
      inCloud: true, ownerId: 'alice@account-test', cloudLastUpdated: Date.now(),
    },
  ]),
});
const bob = new Client('bob', { MACHINE_ID: 'bob@account-test', SERVER_URL });

async function pollBobDoc(title, pred = () => true, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    const r = await bob.cmd('docs');
    const d = (r.docs || []).find((x) => x.title === title);
    if (d && pred(d)) return d;
    await sleep(delay);
  }
  return null;
}

let exitCode = 1;
try {
  await Promise.all([alice.readyPromise, bob.readyPromise]);
  await sleep(1500);
  check('alice websocket connected+authenticated', (await alice.cmd('status')).connected);
  check('bob websocket connected+authenticated', (await bob.cmd('status')).connected);

  // ---- Setup: alice uploads LIVE to the cloud, bob opens it (live Yjs) ----
  const open = await alice.cmd('click-doc', { title: LIVE });
  check('alice opened live doc via sidebar click', open.ok, open.error);
  await alice.cmd('ctx-doc', { title: LIVE });
  const up = await alice.cmd('click-menu', { label: 'Share with the Team' });
  check('alice clicked Share with the Team', up.ok, up.error);
  await sleep(2500);
  const ed1 = await alice.cmd('editor-doc');
  check('alice live doc engaged Yjs (cloudDocumentId in editor)',
    !!(ed1.document && ed1.document.cloudDocumentId), JSON.stringify(ed1.document));
  const bobLive = await pollBobDoc(LIVE);
  check('bob received the live doc', !!bobLive, JSON.stringify(bobLive));
  const bOpen = await bob.cmd('click-doc', { title: LIVE });
  check('bob opened live doc via sidebar click', bOpen.ok, bOpen.error);
  await sleep(1500); // let bob's Yjs session sync

  // =========================================================================
  // S1 - HALF 1: body typing in a LIVE-Yjs doc must cause ZERO snapshot
  // uploads (Yjs is the live channel; content state never re-arms autosave).
  // =========================================================================
  const s1Uploads = alice.logCount(AUTOSAVE_UPLOAD);
  const s1BobReloads = bob.logCount(FULL_RELOAD);
  await alice.cmd('type', { text: ' YJSTYPED1' });
  await sleep(1600); // > 1s debounce: an armed autosave WOULD fire here
  await alice.cmd('type', { text: ' YJSTYPED2' });
  await sleep(1600);
  await alice.cmd('type', { text: ' YJSTYPED3' });
  await sleep(1600);
  await sleep(600); // log flush

  let bobSaw = null;
  for (let i = 0; i < 20; i++) {
    const t = await bob.cmd('textarea');
    bobSaw = t.value;
    if (bobSaw && bobSaw.includes('YJSTYPED3')) break;
    await sleep(500);
  }
  check('S1: bob sees live-Yjs body typing (Yjs channel works)',
    !!(bobSaw && bobSaw.includes('YJSTYPED3')), JSON.stringify(bobSaw));
  const s1UploadsDelta = alice.logCount(AUTOSAVE_UPLOAD) - s1Uploads;
  check('S1: live-Yjs body typing triggered 0 autosave snapshot uploads',
    s1UploadsDelta === 0, `uploads=${s1UploadsDelta}`);
  const s1BobReloadsDelta = bob.logCount(FULL_RELOAD) - s1BobReloads;
  check('S1: live-Yjs body typing triggered 0 full reloads on bob',
    s1BobReloadsDelta === 0, `reloads=${s1BobReloadsDelta}`);

  // =========================================================================
  // S2 - HALF 1(b): a title rename of the live-Yjs doc still uploads ONE
  // snapshot (title/category don't travel over Yjs) but that snapshot must
  // carry the Yjs-fresh body, not the stale doc-open-time React content -
  // and (HALF 2) it must not trigger a full reload on bob.
  // =========================================================================
  const s2Uploads = alice.logCount(AUTOSAVE_UPLOAD);
  const s2BobReloads = bob.logCount(FULL_RELOAD);
  const ren = await alice.cmd('rename-doc', { title: LIVE, newTitle: LIVE_RENAMED });
  check('S2: alice renamed live doc via sidebar inline edit', ren.ok, ren.error);
  await sleep(3000); // rename -> 1s autosave debounce -> upload -> broadcast
  const s2UploadsDelta = alice.logCount(AUTOSAVE_UPLOAD) - s2Uploads;
  check('S2: title rename triggered exactly 1 snapshot upload',
    s2UploadsDelta === 1, `uploads=${s2UploadsDelta}`);

  const aDocs = (await alice.cmd('docs')).docs || [];
  const aRenamed = aDocs.find((d) => d.title === LIVE_RENAMED);
  check('S2: alice local copy kept the Yjs-typed body after rename autosave',
    !!(aRenamed && aRenamed.content.includes('YJSTYPED3')),
    aRenamed ? `contentLen=${aRenamed.contentLen}` : 'renamed doc missing');

  // NOTE: peers key cloud docs by (ownerId, title), so on bob the rename
  // arrives as a CREATE under the new title (pre-existing sync semantics,
  // not under test here) - what matters is that the snapshot body is fresh.
  const bobRenamed = await pollBobDoc(LIVE_RENAMED);
  check('S2: bob received the renamed doc snapshot', !!bobRenamed, JSON.stringify(bobRenamed));
  check('S2: bob\'s snapshot carries the Yjs-fresh body (no stale-content clobber)',
    !!(bobRenamed && bobRenamed.content.includes('YJSTYPED3')),
    bobRenamed ? `content=${JSON.stringify(bobRenamed.content.slice(0, 80))}` : 'missing');
  const s2SawInSidebar = (await bob.cmd('page-contains', { text: LIVE_RENAMED })).contains;
  check('S2: renamed doc appears in bob\'s sidebar (targeted created-merge)', s2SawInSidebar);
  const s2BobReloadsDelta = bob.logCount(FULL_RELOAD) - s2BobReloads;
  check('S2: bob did NOT full-reload for the incoming update',
    s2BobReloadsDelta === 0, `reloads=${s2BobReloadsDelta}`);

  // =========================================================================
  // S3 - HALF 1(a): a cloud doc with NO cloudDocumentId (never engaged Yjs).
  // First body-typing debounce uploads one snapshot (the only sync channel it
  // has) - but that first upload must feed the newly-assigned cloudDocumentId
  // back into the open editor so Yjs engages and FURTHER typing uploads
  // nothing.
  // =========================================================================
  const sOpen = await alice.cmd('click-doc', { title: SNAP });
  check('S3: alice opened snapshot doc', sOpen.ok, sOpen.error);
  await sleep(400);
  const sEd = await alice.cmd('editor-doc');
  check('S3: snapshot doc starts WITHOUT cloudDocumentId (not Yjs-enabled)',
    !!(sEd.document && sEd.document.inCloud && !sEd.document.cloudDocumentId),
    JSON.stringify(sEd.document));

  const s3aUploads = alice.logCount(AUTOSAVE_UPLOAD);
  const s3BobReloads = bob.logCount(FULL_RELOAD);
  await alice.cmd('type', { text: ' SNAPTYPED1' });
  // The 1s debounce fires, saves, uploads - and must engage Yjs.
  let engaged = null;
  for (let i = 0; i < 16; i++) {
    const e = await alice.cmd('editor-doc');
    if (e.document && e.document.cloudDocumentId) { engaged = e.document; break; }
    await sleep(500);
  }
  check('S3: first autosave upload engaged Yjs on the open editor',
    !!engaged, JSON.stringify(engaged || (await alice.cmd('editor-doc')).document));
  const s3aDelta = alice.logCount(AUTOSAVE_UPLOAD) - s3aUploads;
  check('S3: first typing burst uploaded exactly 1 snapshot',
    s3aDelta === 1, `uploads=${s3aDelta}`);
  await sleep(2000); // let the new Yjs session become ready

  const s3bUploads = alice.logCount(AUTOSAVE_UPLOAD);
  await alice.cmd('type', { text: ' SNAPTYPED2' });
  await sleep(1700);
  await alice.cmd('type', { text: ' SNAPTYPED3' });
  await sleep(1700);
  await sleep(600); // log flush
  const s3bDelta = alice.logCount(AUTOSAVE_UPLOAD) - s3bUploads;
  check('S3: post-engage body typing uploaded 0 snapshots (Yjs took over)',
    s3bDelta === 0, `uploads=${s3bDelta}`);
  const aSnap = ((await alice.cmd('docs')).docs || []).find((d) => d.title === SNAP);
  check('S3: no keystrokes lost across the Yjs engage (all bursts persisted)',
    !!(aSnap && aSnap.content.includes('SNAPTYPED1') && aSnap.content.includes('SNAPTYPED2') && aSnap.content.includes('SNAPTYPED3')),
    aSnap ? JSON.stringify(aSnap.content) : 'missing');

  const bobSnap = await pollBobDoc(SNAP, (d) => !!d.cloudDocumentId);
  check('S3: bob received snapshot doc with cloudDocumentId', !!bobSnap, JSON.stringify(bobSnap));
  const s3BobReloadsDelta = bob.logCount(FULL_RELOAD) - s3BobReloads;
  check('S3: bob full reloads for the whole burst storm = 0',
    s3BobReloadsDelta === 0, `reloads=${s3BobReloadsDelta}`);

  // Bob opens the snapshot doc - live Yjs must serve alice's full content.
  const bSnapOpen = await bob.cmd('click-doc', { title: SNAP });
  check('S3: bob opened snapshot doc', bSnapOpen.ok, bSnapOpen.error);
  let bobSnapVal = null;
  for (let i = 0; i < 16; i++) {
    const t = await bob.cmd('textarea');
    bobSnapVal = t.value;
    if (bobSnapVal && bobSnapVal.includes('SNAPTYPED3')) break;
    await sleep(500);
  }
  check('S3: bob\'s editor shows the Yjs-synced snapshot doc content',
    !!(bobSnapVal && bobSnapVal.includes('SNAPTYPED3')), JSON.stringify(bobSnapVal));

  // =========================================================================
  // S4 - HALF 2: one peer syncing ONE document updates exactly that document
  // on the other peer - open tab AND current editor included - with ZERO
  // full reloads.
  // =========================================================================
  // 4a: a doc bob does NOT have open (list-only update)
  const s4aBobReloads = bob.logCount(FULL_RELOAD);
  const bobBefore = await pollBobDoc(LIVE_RENAMED);
  await alice.cmd('click-doc', { title: LIVE_RENAMED });
  await alice.cmd('ctx-doc', { title: LIVE_RENAMED });
  const sync1 = await alice.cmd('click-menu', { label: 'Sync Changes' });
  check('S4a: alice clicked Sync Changes on renamed doc', sync1.ok, sync1.error);
  const bobAfter = await pollBobDoc(LIVE_RENAMED,
    (d) => d.cloudLastUpdated > (bobBefore ? bobBefore.cloudLastUpdated : 0), 16);
  check('S4a: bob\'s stored copy took the update', !!bobAfter,
    JSON.stringify({ before: bobBefore && bobBefore.cloudLastUpdated, after: bobAfter && bobAfter.cloudLastUpdated }));
  await sleep(700); // let bob's event handler finish + log flush
  const s4aBobReloadsDelta = bob.logCount(FULL_RELOAD) - s4aBobReloads;
  check('S4a: bob full reloads for the single-doc update = 0',
    s4aBobReloadsDelta === 0, `reloads=${s4aBobReloadsDelta}`);

  // 4b: the doc bob has open AND active (bob's current editor must refresh)
  const s4bBobReloads = bob.logCount(FULL_RELOAD);
  const bEdBefore = await bob.cmd('editor-doc');
  check('S4b: bob\'s active doc is the snapshot doc',
    !!(bEdBefore.document && bEdBefore.document.title === SNAP), JSON.stringify(bEdBefore.document));
  await alice.cmd('click-doc', { title: SNAP });
  await alice.cmd('ctx-doc', { title: SNAP });
  const sync2 = await alice.cmd('click-menu', { label: 'Sync Changes' });
  check('S4b: alice clicked Sync Changes on snapshot doc', sync2.ok, sync2.error);
  let bEdAfter = null;
  for (let i = 0; i < 16; i++) {
    const e = await bob.cmd('editor-doc');
    if (e.document && e.document.title === SNAP &&
        e.document.cloudLastUpdated > (bEdBefore.document.cloudLastUpdated || 0)) { bEdAfter = e.document; break; }
    await sleep(500);
  }
  check('S4b: bob\'s OPEN ACTIVE editor doc refreshed from the targeted update',
    !!bEdAfter, JSON.stringify(bEdAfter || (await bob.cmd('editor-doc')).document));
  await sleep(700);
  const s4bBobReloadsDelta = bob.logCount(FULL_RELOAD) - s4bBobReloads;
  check('S4b: bob full reloads for the open-doc update = 0',
    s4bBobReloadsDelta === 0, `reloads=${s4bBobReloadsDelta}`);

  // =========================================================================
  // S5 - HALF 2: a genuine removal still closes the right tab(s) on the peer
  // (the deleted-tab cleanup survives losing the full-reload diff) - again
  // with ZERO full reloads.
  // =========================================================================
  // bob currently has tabs [LIVE, SNAP], SNAP active. Alice (owner) removes
  // SNAP from the cloud -> bob (non-owner) must delete his copy and close the
  // tab, switching the editor to a remaining tab.
  const s5BobReloads = bob.logCount(FULL_RELOAD);
  await alice.cmd('ctx-doc', { title: SNAP });
  const rm = await alice.cmd('click-menu', { label: 'Stop Sharing' });
  check('S5: alice clicked Stop Sharing on snapshot doc', rm.ok, rm.error);
  let bobGone = false;
  for (let i = 0; i < 20; i++) {
    const r = await bob.cmd('docs');
    if (!(r.docs || []).some((d) => d.title === SNAP)) { bobGone = true; break; }
    await sleep(500);
  }
  check('S5: bob\'s local copy of the removed doc was deleted', bobGone);
  await sleep(700); // let tab cleanup render
  const s5Tab = (await bob.cmd('page-contains', { text: SNAP })).contains;
  check('S5: removed doc\'s tab + sidebar row are gone on bob', !s5Tab);
  const bEdFinal = await bob.cmd('editor-doc');
  check('S5: bob\'s editor switched to a remaining tab',
    !!(bEdFinal.document && bEdFinal.document.title !== SNAP), JSON.stringify(bEdFinal.document));
  const s5BobReloadsDelta = bob.logCount(FULL_RELOAD) - s5BobReloads;
  check('S5: bob full reloads for the removal = 0',
    s5BobReloadsDelta === 0, `reloads=${s5BobReloadsDelta}`);

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  alice.kill(); bob.kill(); server.kill();
  await sleep(300);
  process.exit(exitCode);
}
