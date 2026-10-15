/**
 * Guards against "a slow initial sync duplicates the entire text document" in
 * src/hooks/useYjsText.js.
 *
 * THE BUG (fixed): the hook captured a "server has content" flag from a
 * FRESHLY created provider Y.Doc (ytext.length is always 0 at that moment,
 * regardless of what the server actually holds). Its 3-second fallback then
 * branched on that always-false flag and, while merely connected-but-slow
 * (cold snapshot load, reconnect backoff, normal latency), seeded the full
 * local IndexedDB body as new CRDT insert ops. When the REAL sync-step2 then
 * arrived carrying the server's actual content, the two merged and the
 * document DUPLICATED itself for every peer (server "Hello" + seeded "Hello"
 * -> "HelloHello"). The old "server echoes back our content" comment was
 * wrong: isLocalChangeRef only suppresses the local DOM echo, it does nothing
 * at the CRDT op level, so the duplicate insert still synced out.
 *
 * THE FIX under test: seed local content ONLY on positive confirmation we are
 * genuinely OFFLINE (isWebSocketConnected() === false). When connected, do NOT
 * seed on a timer at all - wait for the real sync-step2 (whenSynced /
 * provider.synced), the one definitive answer about the server's state.
 *
 * What this test proves (real Yjs, Y.Docs standing in for client + server):
 *   1. CONTROL / bug repro: seeding the local body BEFORE sync-step2 arrives,
 *      then applying the server's real content, duplicates the document.
 *   2. FIX: not seeding while online -> applying sync-step2 yields the server
 *      body exactly once.
 *   3. OFFLINE path unchanged: seeding the local body while offline (no server
 *      content will arrive) preserves it as a single copy.
 *
 * Run:  node tests/yjs-text-seed-duplication.test.mjs
 * Preconditions: npm install   (yjs available at repo root)
 * Exit code 0 = all checks passed, 1 = failure.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const Y = req('yjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

// A "server" update carrying the document body, as sync-step2 would deliver it.
function serverDocWithText(text) {
  const server = new Y.Doc();
  server.getText('content').insert(0, text);
  return server;
}

const LOCAL_BODY = 'Hello World';   // the client's local IndexedDB copy
const SERVER_BODY = 'Hello World';  // what the server actually holds

// --- 1. CONTROL: old fallback seeds local body, THEN sync-step2 -> duplicate
{
  const client = new Y.Doc();
  client.getText('content').insert(0, LOCAL_BODY); // buggy pre-sync seed
  Y.applyUpdate(client, Y.encodeStateAsUpdate(serverDocWithText(SERVER_BODY)));
  const result = client.getText('content').toString();
  check('CONTROL: seeding local body before sync DUPLICATES the document',
    result === LOCAL_BODY + SERVER_BODY, `got "${result}"`);
}

// --- 2. FIX: connected -> seed nothing; sync-step2 delivers body once
{
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(serverDocWithText(SERVER_BODY)));
  const result = client.getText('content').toString();
  check('FIX: not seeding while online yields the server body exactly once',
    result === SERVER_BODY, `got "${result}"`);
}

// --- 3. OFFLINE path unchanged: genuinely offline -> seeding local is correct
{
  const client = new Y.Doc();
  client.getText('content').insert(0, LOCAL_BODY);
  const result = client.getText('content').toString();
  check('OFFLINE: seeding local body while offline preserves it (single copy)',
    result === LOCAL_BODY, `got "${result}"`);
}

console.log();
if (failures === 0) {
  console.log('RESULT: all checks passed - a slow sync no longer duplicates the document');
  process.exit(0);
}
console.log(`RESULT: ${failures} check(s) FAILED`);
process.exit(1);
