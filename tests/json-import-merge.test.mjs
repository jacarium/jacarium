#!/usr/bin/env node
/**
 * The merge option of the Kanban, Tasks and Workflow "Import from JSON"
 * dialogs (src/utils/jsonImportMerge.js runJsonImport, through
 * kanbanImport.js runBoardsImport / taskInstancesImport.js
 * runInstancesImport / workflowsImport.js runWorkflowsImport), proved
 * against the REAL utils and src/db/database.js on Dexie over
 * fake-indexeddb. Per entity:
 *   merge on   a newer copy updates the local row, an older one is skipped,
 *              an identical one is skipped, a new one is added; a dry run
 *              writes nothing and reports exactly those counts; a renamed
 *              copy with the local row's syncId still matches; an invalid
 *              item is reported, not thrown;
 *   merge off  everything is added as new (the behaviour the pages had);
 *   boards     cards inside a matched board merge by yjsId (newer wins,
 *              unknown ones are added, local ones the file does not mention
 *              are kept) - the board is never replaced whole.
 *
 * Run:  node tests/json-import-merge.test.mjs
 * Preconditions: npm install; npm install --no-save fake-indexeddb (SKIP without it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const resolvable = (name) => { try { req.resolve(name); return true; } catch { return false; } };
for (const dep of ['esbuild', 'dexie']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
if (!resolvable('fake-indexeddb')) { console.log('SKIP: fake-indexeddb not installed (npm install --no-save fake-indexeddb)'); process.exit(0); }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'json-import-merge-'));
let failures = 0; let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 300)}` : ''}`); }
}

// ---------- environment ----------
const lsStore = new Map([['db_migration_complete', 'true'], ['workflows_migration_complete', 'true'], ['env_vars_migration_complete', 'true']]);
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k), key: (i) => Array.from(lsStore.keys())[i] ?? null, get length() { return lsStore.size; },
};
globalThis.window = globalThis;
await import(req.resolve('fake-indexeddb/auto'));

const { build } = await import(req.resolve('esbuild'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
fs.writeFileSync(ENTRY, [
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
  `export { runBoardsImport, validateBoardsImport } from ${JSON.stringify(path.join(REPO, 'src/utils/kanbanImport.js'))};`,
  `export { runInstancesImport } from ${JSON.stringify(path.join(REPO, 'src/utils/taskInstancesImport.js'))};`,
  `export { runWorkflowsImport } from ${JSON.stringify(path.join(REPO, 'src/utils/workflowsImport.js'))};`,
  `export { describeJsonImport } from ${JSON.stringify(path.join(REPO, 'src/components/common/JsonImportStats.jsx'))};`,
  `export { createBoard, getBoards, createCard, getCards } from ${JSON.stringify(path.join(REPO, 'src/utils/kanban.js'))};`,
  `export { createInstance, getAllInstances } from ${JSON.stringify(path.join(REPO, 'src/utils/taskwarriorInstances.js'))};`,
  `export { createWorkflow, getWorkflows } from ${JSON.stringify(path.join(REPO, 'src/utils/workflows.js'))};`,
].join('\n'));
await build({ entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', logLevel: 'silent', jsx: 'automatic', loader: { '.js': 'jsx' } });
const api = req(BUNDLE);
const { db, runBoardsImport, runInstancesImport, runWorkflowsImport, describeJsonImport, createBoard, getBoards, createCard, getCards, createInstance, getAllInstances, createWorkflow, getWorkflows } = api;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[')) return; realLog(...a); };
const realError = console.error;
console.error = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[')) return; realError(...a); };

const DAY = 86400000;
const plus = (d) => new Date(Date.now() + d * DAY).toISOString();
const totals = (r) => ({ created: r.totals.created, updated: r.totals.updated, filled: r.totals.filled, skipped: r.totals.skipped, invalid: r.totals.invalid });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => JSON.parse(JSON.stringify(v));

async function wipe() {
  await Promise.all([db.kanbanBoards.clear(), db.kanbanCards.clear(), db.taskwarriorInstances.clear(), db.workflows.clear()]);
}

/**
 * The common scenario: two local rows (a, b); a file with a NEWER copy of a
 * (one field changed), an OLDER identical copy of b, and a new row c.
 * `entity` supplies the create / list / run functions and the field names.
 */
async function scenario(entity) {
  const { name, create, list, run, keyField, changeField, changedValue, a, b, c, defaults } = entity;
  await wipe();
  const idA = await create(a);
  await create(b);
  const localA = (await list()).find((r) => r[keyField] === a[keyField]);
  const rows = () => list();
  const file = [
    { ...clone(a), [changeField]: changedValue, updatedAt: plus(1) },
    { ...clone(b), updatedAt: plus(-1) },
    clone(c),
  ];

  // dry run, merge on
  const dry = await run(file, { dryRun: true, mergeMode: true });
  check(`${name}: merge dry run reports 1 added, 1 updated (newer), 1 skipped (older), 0 errors`, same(totals(dry), { created: 1, updated: 1, filled: 0, skipped: 1, invalid: 0 }), JSON.stringify(totals(dry)));
  check(`${name}: merge dry run writes nothing`, (await rows()).length === 2 && same((await rows()).find((r) => r[keyField] === a[keyField])[changeField], localA[changeField]));
  const text = describeJsonImport(dry, { noun: entity.noun, plural: entity.plural, importLabel: 'Import' });
  check(`${name}: the dry-run headline reads "1 ${entity.noun} would be added, 1 updated (newer), 1 skipped (older or identical), 0 errors"`, text.headline === `1 ${entity.noun} would be added, 1 updated (newer), 1 skipped (older or identical), 0 errors`, text.headline);
  check(`${name}: the dry-run title names the merge mode`, text.title === `Dry run (merge into existing ${entity.plural}) - nothing was written`, text.title);
  check(`${name}: the samples name the records`, (dry.summary[entity.type].samples.updated || []).some((s) => s.includes(a[keyField])) && (dry.summary[entity.type].samples.created || []).some((s) => s.includes(c[keyField])), JSON.stringify(dry.summary[entity.type].samples));

  // real merge
  const real = await run(file, { mergeMode: true });
  const after = await rows();
  check(`${name}: merge import: the newer copy updated the row, the older was skipped, the new one added`, same(totals(real), { created: 1, updated: 1, filled: 0, skipped: 1, invalid: 0 }) && after.length === 3, JSON.stringify(totals(real)) + ' rows=' + after.length);
  const updatedA = after.find((r) => r[keyField] === a[keyField]);
  check(`${name}: the updated row kept its local id and took the file's field`, updatedA && updatedA.id === (typeof idA === 'object' ? idA.id : idA) && same(updatedA[changeField], changedValue), JSON.stringify(updatedA && updatedA[changeField]));
  const keptB = after.find((r) => r[keyField] === b[keyField]);
  check(`${name}: the older copy left the local row untouched`, keptB && same(keptB[changeField], b[changeField] ?? defaults?.[changeField]), JSON.stringify(keptB && keptB[changeField]));
  check(`${name}: the new row was added with the importer's defaults`, after.some((r) => r[keyField] === c[keyField] && (r.category || 'General') === (c.category || 'General')));

  // identical copy -> skipped; renamed copy with the syncId -> updated
  const identical = await run([clone(after.find((r) => r[keyField] === c[keyField]))], { dryRun: true, mergeMode: true });
  check(`${name}: an identical copy is skipped`, same(totals(identical), { created: 0, updated: 0, filled: 0, skipped: 1, invalid: 0 }), JSON.stringify(totals(identical)));
  if (updatedA.syncId) {
    const renamed = { ...clone(updatedA), [keyField]: `${a[keyField]} (renamed)`, updatedAt: plus(2) };
    const dryRenamed = await run([renamed], { dryRun: true, mergeMode: true });
    check(`${name}: a renamed copy carrying the local syncId still matches (updated, not added)`, same(totals(dryRenamed), { created: 0, updated: 1, filled: 0, skipped: 0, invalid: 0 }), JSON.stringify(totals(dryRenamed)));
  } else {
    check(`${name}: rows carry a syncId`, false, 'no syncId on the stored row');
  }
  const invalid = await run([clone(c), 'not an object', null], { dryRun: true, mergeMode: true });
  check(`${name}: invalid items are reported, not thrown`, invalid.totals.invalid === 2 && invalid.summary[entity.type].errors.length === 2, JSON.stringify(totals(invalid)));

  // merge off: everything added as new, even the copies
  const before = (await rows()).length;
  const dryOff = await run(file, { dryRun: true, mergeMode: false });
  check(`${name}: merge off dry run reports every item as new and writes nothing`, same(totals(dryOff), { created: 3, updated: 0, filled: 0, skipped: 0, invalid: 0 }) && (await rows()).length === before, JSON.stringify(totals(dryOff)));
  const off = await run(file, { mergeMode: false });
  check(`${name}: merge off adds every item as a new row (the old behaviour)`, same(totals(off), { created: 3, updated: 0, filled: 0, skipped: 0, invalid: 0 }) && (await rows()).length === before + 3, `${before} -> ${(await rows()).length}`);
  const offText = describeJsonImport(off, { noun: entity.noun, plural: entity.plural, importLabel: 'Import' });
  check(`${name}: merge off wording counts only additions`, offText.headline === `3 ${entity.plural} added` && offText.title === `Import complete (add as new ${entity.plural})`, offText.headline + ' / ' + offText.title);
}

try {
  await scenario({
    name: 'boards', noun: 'board', plural: 'boards', type: 'kanbanBoards',
    create: createBoard, list: getBoards, run: runBoardsImport, keyField: 'title', changeField: 'columns',
    changedValue: [{ id: 'todo', title: 'To Do' }, { id: 'review', title: 'Review' }, { id: 'done', title: 'Done' }],
    a: { title: 'Release checklist', category: 'Work', columns: [{ id: 'todo', title: 'To Do' }, { id: 'done', title: 'Done' }] },
    b: { title: 'Garden plan', category: 'Home', columns: [{ id: 'ideas', title: 'Ideas' }] },
    c: { title: 'Reading list', category: 'Home', columns: [{ id: 'next', title: 'Next' }] },
  });
  await scenario({
    name: 'instances', noun: 'instance', plural: 'instances', type: 'taskwarriorInstances',
    create: createInstance, list: getAllInstances, run: runInstancesImport, keyField: 'name', changeField: 'description', changedValue: 'The office TaskWarrior data (moved)',
    a: { name: 'Work tasks', category: 'Work', description: 'The office TaskWarrior data', rcPath: '~/.taskrc-work', dataPath: '~/.task-work' },
    b: { name: 'Home tasks', category: 'Home', description: 'Chores', rcPath: '~/.taskrc-home', dataPath: '~/.task-home' },
    c: { name: 'Side project', category: 'Home', description: '', rcPath: '', dataPath: '' },
  });
  await scenario({
    name: 'workflows', noun: 'workflow', plural: 'workflows', type: 'workflows',
    create: createWorkflow, list: getWorkflows, run: runWorkflowsImport, keyField: 'title', changeField: 'nodes',
    changedValue: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } }, { id: 'dump', type: 'command', position: { x: 200, y: 0 }, data: { label: 'pg_dump' } }],
    a: { title: 'Nightly backup', category: 'Ops', nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } }], edges: [] },
    b: { title: 'Deploy docs', category: 'Ops', nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } }], edges: [] },
    c: { title: 'Rotate keys', category: 'Security', nodes: [], edges: [] },
  });

  // ---- instances: isActive is machine state
  await wipe();
  await createInstance({ name: 'Work tasks', category: 'Work', isActive: true });
  const activeFile = [{ name: 'Work tasks', category: 'Work', description: 'now with a description', isActive: false, updatedAt: plus(1) }, { name: 'Other', category: 'Work', isActive: true }];
  await runInstancesImport(activeFile, { mergeMode: true });
  const inst = await getAllInstances();
  check('instances: a merge keeps the local active flag and adds new instances inactive', inst.find((i) => i.name === 'Work tasks').isActive === 1 && inst.find((i) => i.name === 'Other').isActive === 0, JSON.stringify(inst.map((i) => [i.name, i.isActive])));

  // ---- workflows: cloud fields stay local
  await wipe();
  const wfId = await createWorkflow({ title: 'Shared', category: 'Ops', nodes: [], edges: [], inCloud: true, ownerId: 'me' });
  await runWorkflowsImport([{ title: 'Shared', category: 'Ops', nodes: [{ id: 'n' }], edges: [], inCloud: false, ownerId: 'someone-else', updatedAt: plus(1) }], { mergeMode: true });
  const wf = (await getWorkflows()).find((w) => w.id === wfId);
  check('workflows: an update takes nodes/edges but keeps the local cloud fields', wf && wf.nodes.length === 1 && wf.inCloud === true && wf.ownerId === 'me', JSON.stringify(wf && [wf.nodes.length, wf.inCloud, wf.ownerId]));

  // ---- boards: cards merge by yjsId inside the matched board
  await wipe();
  const board = await createBoard({ title: 'Release checklist', category: 'Work', columns: [{ id: 'todo', title: 'To Do' }] });
  const x = await createCard({ boardId: board.id, title: 'Write notes', status: 'todo', position: 0 });
  const z = await createCard({ boardId: board.id, title: 'Local only', status: 'todo', position: 1 });
  const cardsFile = [{
    title: 'Release checklist', category: 'Work', columns: [{ id: 'todo', title: 'To Do' }], updatedAt: plus(1),
    cards: [
      { yjsId: x.yjsId, title: 'Write release notes', status: 'todo', position: 0, updatedAt: plus(1) },
      { yjsId: 'brand-new-card', title: 'Tag the build', status: 'todo', position: 2 },
      { title: 'No id card', status: 'todo', position: 3 },
    ],
  }];
  const cardsDry = await runBoardsImport(cardsFile, { dryRun: true, mergeMode: true });
  check('boards: a dry run reports the cards on their own row (1 updated, 2 added)', cardsDry.summary.kanbanCards && cardsDry.summary.kanbanCards.updated === 1 && cardsDry.summary.kanbanCards.created === 2 && (await getCards(board.id)).length === 2, JSON.stringify(cardsDry.summary.kanbanCards));
  await runBoardsImport(cardsFile, { mergeMode: true });
  const cards = await getCards(board.id);
  check('boards: cards merge by yjsId - the newer copy updated, the unknown ones added, the local-only card kept', cards.length === 4 && cards.find((c) => c.id === x.id).title === 'Write release notes' && cards.some((c) => c.id === z.id) && cards.some((c) => c.yjsId === 'brand-new-card'), JSON.stringify(cards.map((c) => [c.title, c.yjsId])));
  check('boards: the board row never stores the cards array', !('cards' in (await getBoards())[0]));
  const offCards = await runBoardsImport(cardsFile, { mergeMode: false });
  const boards = await getBoards();
  check('boards: merge off adds the board and its cards as new', offCards.totals.created === 4 && boards.length === 2 && (await getCards(boards.find((b) => b.id !== board.id).id)).length === 3, JSON.stringify(totals(offCards)));
} catch (e) {
  check('the run completed', false, e.stack || e.message);
}
console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures ? 1 : 0);
