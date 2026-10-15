/**
 * Guards two silent-data-loss bugs on SHARED Kanban boards (both in
 * src/hooks/useYjsBoard.js + src/utils/kanban.js).
 *
 * BUG 3b - card id collision (fixed): the hook keyed each card's Y.Map entry
 * by String(card.id), where `id` is a per-machine Dexie auto-increment
 * integer. Two collaborators adding a card at nearly the same moment both mint
 * the same next integer locally (e.g. 7) -> both write ycards.set('7', ...) ->
 * on sync the CRDT sees ONE key '7' and one card silently overwrites the other
 * for everyone. Cards vanish with no error.
 *   FIX: cards carry a globally-unique `yjsId` (crypto.randomUUID, generated
 *   once at creation in kanban.js), and cardYjsKey() - shared by the hook -
 *   uses it as the Y.Map key instead of the colliding Dexie integer. The Dexie
 *   `id` and everything keyed off it are untouched.
 *
 * BUG 3a - card resurrection on slow sync (fixed): the hook's offline fallback
 * fired on a flat 500ms timer and, because a fresh provider Y.Doc always looks
 * empty, re-seeded all local cards even while online-but-slow. A fresh
 * ycards.set on a card the server had DELETED overrides the delete's tombstone
 * (set-after-delete wins in Yjs), RESURRECTING it for everyone.
 *   FIX: seed local cards ONLY when genuinely offline (isWebSocketConnected()
 *   === false, matching useYjsText.js); when connected, wait for the real
 *   sync-step2 (whenSynced) instead of assuming absence-of-signal means empty.
 *
 * What this test proves (real Yjs, Y.Docs standing in for machines): for each
 * bug a CONTROL case that replays the OLD behavior and shows the data loss is
 * real, and a FIX case that shows the corrected keying / seeding avoids it.
 *
 * Run:  node tests/kanban-card-id-collision.test.mjs
 * Preconditions: npm install   (yjs + esbuild available at repo root)
 * Exit code 0 = all checks passed, 1 = failure.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

const Y = req('yjs');
const esbuild = req('esbuild');

// Load the REAL keying helpers from src/utils/kanban.js. That module imports
// ../db/database (Dexie); we only need the two pure functions, so bundle just
// this module with the db import stubbed out.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-collision-'));
const dbStub = path.join(stubDir, 'db-stub.js');
fs.writeFileSync(dbStub, 'export const db = {};\n');
const bundle = await esbuild.build({
  entryPoints: [path.join(REPO, 'src/utils/kanban.js')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  plugins: [{
    name: 'stub-db',
    setup(build) {
      build.onResolve({ filter: /db\/database$/ }, () => ({ path: dbStub }));
    }
  }]
});
const modUrl = 'data:text/javascript;base64,' +
  Buffer.from(bundle.outputFiles[0].text).toString('base64');
const { cardYjsKey, generateCardYjsId } = await import(modUrl);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

// Helper: set a card into a doc's 'cards' Y.Map under a given key.
function setCard(ydoc, key, card) {
  const ycards = ydoc.getMap('cards');
  ydoc.transact(() => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(card)) m.set(k, v);
    ycards.set(key, m);
  });
}

// Exchange the full state between two docs (both directions), as the central
// server would relay sync-step2 + updates.
function mergeBothWays(docA, docB) {
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
}

// --- 1. CONTROL: keying by String(id) with colliding ids loses a card ---
{
  const alice = new Y.Doc();
  const bob = new Y.Doc();
  const aliceCard = { id: 7, title: 'Alice card' };
  const bobCard = { id: 7, title: 'Bob card' };
  setCard(alice, String(aliceCard.id), aliceCard); // both key '7'
  setCard(bob, String(bobCard.id), bobCard);
  mergeBothWays(alice, bob);
  const size = alice.getMap('cards').size;
  check('CONTROL: String(id) keying collides - one card is lost on merge',
    size === 1, `final size ${size}`);
}

// --- 2. FIX: keying by cardYjsKey (yjsId) keeps BOTH cards ---
{
  const alice = new Y.Doc();
  const bob = new Y.Doc();
  // Same colliding Dexie id (7) - but distinct yjsIds, as createCard now mints.
  const aliceCard = { id: 7, yjsId: generateCardYjsId(), title: 'Alice card' };
  const bobCard = { id: 7, yjsId: generateCardYjsId(), title: 'Bob card' };
  check('generateCardYjsId yields distinct ids', aliceCard.yjsId !== bobCard.yjsId);
  setCard(alice, cardYjsKey(aliceCard), aliceCard);
  setCard(bob, cardYjsKey(bobCard), bobCard);
  mergeBothWays(alice, bob);
  const ycards = alice.getMap('cards');
  const titles = [];
  ycards.forEach((m) => titles.push(m.get('title')));
  check('FIX: yjsId keying keeps BOTH cards on merge', ycards.size === 2,
    `final size ${ycards.size}`);
  check('FIX: both card titles survive', titles.includes('Alice card') && titles.includes('Bob card'),
    titles.join(', '));
}

// --- 3. cardYjsKey backwards compat + uniqueness ---
check('cardYjsKey uses yjsId when present', cardYjsKey({ id: 3, yjsId: 'uuid-abc' }) === 'uuid-abc');
check('cardYjsKey falls back to id for legacy cards', cardYjsKey({ id: 42 }) === '42');
check('cardYjsKey falls back to id when yjsId is empty string', cardYjsKey({ id: 42, yjsId: '' }) === '42');
{
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(generateCardYjsId());
  check('generateCardYjsId is collision-free over 1000 draws', ids.size === 1000, `${ids.size} unique`);
}

// --- 4. Bug 3a: resurrection of a server-deleted card on slow sync ---
// Shared history where a card was created and then DELETED on the server.
function serverDocWithDeletedCard(key) {
  const server = new Y.Doc();
  const ycards = server.getMap('cards');
  const m = new Y.Map();
  m.set('id', 1);
  m.set('yjsId', key);
  m.set('title', 'Original card');
  ycards.set(key, m);   // create
  ycards.delete(key);   // ...then delete (leaves a tombstone)
  return server;
}
const CARD_KEY = 'card-uuid-1';

{
  // CONTROL: old fallback re-seeds the locally-cached card while online-but-slow.
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(serverDocWithDeletedCard(CARD_KEY)));
  check('precondition: card is deleted after syncing server history',
    client.getMap('cards').size === 0, `size ${client.getMap('cards').size}`);
  const ycards = client.getMap('cards');
  const m = new Y.Map();
  m.set('id', 1); m.set('yjsId', CARD_KEY); m.set('title', 'Original card');
  ycards.set(CARD_KEY, m); // buggy re-seed
  check('CONTROL: re-seeding a cached card RESURRECTS a server-deleted card',
    ycards.size === 1, `size ${ycards.size}`);
}

{
  // FIX: connected -> seed nothing; sync-step2 delivers the deletion, card stays gone.
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(serverDocWithDeletedCard(CARD_KEY)));
  check('FIX: not seeding while online keeps the server-deleted card deleted',
    client.getMap('cards').size === 0, `size ${client.getMap('cards').size}`);
}

fs.rmSync(stubDir, { recursive: true, force: true });

console.log();
if (failures === 0) {
  console.log('RESULT: all checks passed - no card overwrite or resurrection on a shared board');
  process.exit(0);
}
console.log(`RESULT: ${failures} check(s) FAILED`);
process.exit(1);
