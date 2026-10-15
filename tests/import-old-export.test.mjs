/**
 * Exports made under the previous app name import into Jacarium unchanged:
 * the rename kept no fallback reads of the old database or storage names,
 * so a user's route is Export Database before, Import Database after. The
 * fixtures in tests/fixtures/old-export/ were written by the pre-rename
 * code (see the README there) from a synthetic database:
 *
 *   support-console-3.0.1-format2.json       the desktop/browser export
 *                                            (formatVersion 2, tasks per
 *                                            instance, a media attachment)
 *   support-console-2.6.0-format1.json       the same data in the older
 *                                            flat-tasks format (formatVersion 1)
 *   support-console-3.0.1-account-backup.json the server's account backup
 *                                            (backend/account_data.build_export)
 *
 * Proved against the real src/utils/importDatabase.js + src/db/database.js
 * on real Dexie over fake-indexeddb:
 *   1. replace mode restores every table of the format-2 file (counts, the
 *      attachment's Blob, the localStorage keys);
 *   2. merge mode with the format-1 file on top of that database creates no
 *      duplicates (same documents, same tasks) and the dry run agrees;
 *   3. replace mode with the account backup wipes that database and leaves
 *      exactly the backup's rows, media restored;
 *   4. the fixtures pass the Import dialog's file check and carry no live
 *      data (synthetic hosts and names only).
 *
 * Run:  node tests/import-old-export.test.mjs
 * Preconditions: npm install (esbuild, dexie); npm install --no-save fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'old-export');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('dexie', 'Run: npm install');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

let failures = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${!cond && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!cond) failures++; };

// ---------- environment: fake IndexedDB, localStorage, no backend ----------
const lsStore = new Map([['db_migration_complete', 'true'], ['env_vars_migration_complete', 'true']]);
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  key: (i) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size; },
};
globalThis.window = globalThis;
globalThis.fetch = async () => { throw new TypeError('fetch failed: no backend in this test'); };
await import(req.resolve('fake-indexeddb/auto'));

// ---------- bundle the real modules under test ----------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'import-old-export-'));
const { build } = await import(req.resolve('esbuild'));
const ENTRY = path.join(WORK, 'entry.mjs');
const BUNDLE = path.join(WORK, 'bundle.cjs');
fs.writeFileSync(ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { db, DATABASE_NAME } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
  `export * as customContent from ${JSON.stringify(path.join(REPO, 'src/utils/customContentDB.js'))};`,
].join('\n'));
await build({ entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { mergeImportDatabase, replaceImportDatabase, planReplaceImport, mergeTotals, db, DATABASE_NAME, customContent } = req(BUNDLE);

const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const format2 = load('support-console-3.0.1-format2.json');
const format1 = load('support-console-2.6.0-format1.json');
const backup = load('support-console-3.0.1-account-backup.json');

// the Import dialog's file check (src/components/common/modals/ImportDBModal.jsx)
const dialogAccepts = (d) => d && typeof d === 'object' && d.version && Array.isArray(d.documents) && Array.isArray(d.documentTemplates) && Array.isArray(d.jqlTemplates) && Array.isArray(d.engineTemplates);
const base64Bytes = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64').length;
const blobOf = async (row) => row && row.blob instanceof Blob ? { size: row.blob.size, type: row.blob.type } : { size: -1, type: String(row && row.blob) };
const snapshot = async () => ({
  documents: await db.documents.toArray(),
  categories: await db.documentCategories.toArray(),
  docTemplates: await db.documentTemplates.count(),
  jql: await db.templates.count(),
  engine: await db.engineTemplates.count(),
  workflows: await db.workflows.count(),
  boards: await db.kanbanBoards.toArray(),
  cards: await db.kanbanCards.count(),
  instances: await db.taskwarriorInstances.toArray(),
  tasks: await db.tasks.toArray(),
  reports: await db.customReports.count(),
  calendar: await db.calendarEventTemplates.count(),
  ssh: await db.sshCommands.count(),
  openshift: await db.openshiftTemplates.count(),
  gtfoFunctions: await db.gtfobinsFunctions.count(),
  gtfoExecutables: await db.gtfobinsExecutables.count(),
  media: await db.media.toArray(),
  grids: (await customContent.getAllCustomGrids()).length,
  quizzes: (await customContent.getAllCustomQuizzes()).length,
});

console.log('\n--- the fixtures ---');
check('the database of the renamed app is "Jacarium" (no fallback to the old name)', DATABASE_NAME === 'Jacarium', DATABASE_NAME);
for (const [name, d] of [['format2', format2], ['format1', format1], ['account backup', backup]]) check(`${name}: the Import dialog accepts the file`, dialogAccepts(d));
check('format2 is formatVersion 2 with tasks per instance; format1 and the backup are formatVersion 1 with flat tasks',
  format2.formatVersion === 2 && format2.taskwarriorTasks && !format2.tasks && format1.formatVersion === 1 && Array.isArray(format1.tasks) && backup.formatVersion === 1 && Array.isArray(backup.tasks));
const raw = ['support-console-3.0.1-format2.json', 'support-console-2.6.0-format1.json', 'support-console-3.0.1-account-backup.json'].map((f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8')).join('\n');
const scan = spawnSync('bash', ['scripts/privacy-scan.sh', '--dir', FIXTURES], { cwd: REPO, encoding: 'utf8' });
check('the fixtures pass the privacy scan (synthetic hosts and names only)', scan.status === 0, (scan.stdout + scan.stderr).trim().split('\n').slice(-3).join(' / '));
check('the fixtures do not mention the new name (they predate it)', !/Jacarium/i.test(raw));

console.log('\n--- 1. replace mode: the format-2 export ---');
const plan2 = await planReplaceImport(format2);
const r2 = await replaceImportDatabase(format2);
const s2 = await snapshot();
check('documents, categories and templates are restored', s2.documents.length === 3 && s2.categories.length === 2 && s2.docTemplates === 1 && s2.jql === 1 && s2.engine === 1, JSON.stringify({ d: s2.documents.length, c: s2.categories.length, t: s2.docTemplates, j: s2.jql, e: s2.engine }));
check('workflows, boards, cards, instances and tasks are restored', s2.workflows === 1 && s2.boards.length === 1 && s2.cards === 3 && s2.instances.length === 1 && s2.tasks.length === 4, JSON.stringify({ w: s2.workflows, b: s2.boards.length, k: s2.cards, i: s2.instances.length, t: s2.tasks.length }));
check('the tasks belong to the restored instance', s2.tasks.every((t) => t.instanceId === s2.instances[0].id), JSON.stringify(s2.tasks.map((t) => t.instanceId)));
check('reports, calendar templates, ssh commands, openshift templates, gtfobins rows are restored', s2.reports === 1 && s2.calendar === 1 && s2.ssh === 1 && s2.openshift === 1 && s2.gtfoFunctions === 1 && s2.gtfoExecutables === 1, JSON.stringify({ r: s2.reports, c: s2.calendar, s: s2.ssh, o: s2.openshift, f: s2.gtfoFunctions, x: s2.gtfoExecutables }));
check('custom grids and quizzes (the separate content database) are restored', s2.grids === 1 && s2.quizzes === 1, `${s2.grids} ${s2.quizzes}`);
const media2 = await blobOf(s2.media[0]);
check('the attachment comes back as a Blob of the exported bytes and type', s2.media.length === 1 && media2.size === base64Bytes(format2.media[0].data) && media2.type === 'image/png' && s2.media[0].filename === format2.media[0].filename, JSON.stringify(media2));
check('the document that embeds the attachment still references it', s2.documents.some((d) => /attachment:diagram\.png/.test(d.content || '')));
check('the localStorage keys of the export are applied', Object.keys(format2.localStorage).every((k) => localStorage.getItem(k) != null) && Object.keys(format2.localStorage).length === 3, Object.keys(format2.localStorage).join(','));
check('the dry run announced the same document count the import produced', plan2 && plan2.documents && plan2.documents.created === 3 && r2 && typeof r2 === 'object', JSON.stringify(plan2 && plan2.documents));

console.log('\n--- 2. merge mode: the format-1 export on top ---');
const dry = await mergeImportDatabase(format1, { dryRun: true });
const dryTotals = mergeTotals(dry);
const m1 = await mergeImportDatabase(format1);
const s1 = await snapshot();
check('the same documents merge in place (no duplicates)', s1.documents.length === 3 && m1.documents.created === 0, JSON.stringify(m1.documents));
check('categories, templates, boards and cards are not duplicated', s1.categories.length === 2 && s1.docTemplates === 1 && s1.jql === 1 && s1.engine === 1 && s1.boards.length === 1 && s1.cards === 3, JSON.stringify({ c: s1.categories.length, t: s1.docTemplates, b: s1.boards.length, k: s1.cards }));
check('the flat tasks of the older format match the restored tasks by uuid (still 4, one instance)', s1.tasks.length === 4 && s1.instances.length === 1, `${s1.tasks.length} tasks, ${s1.instances.length} instances`);
check('the attachment is kept once', s1.media.length === 1);
check('the dry run reports the same totals as the real merge', JSON.stringify(dryTotals) === JSON.stringify(mergeTotals(m1)), `${JSON.stringify(dryTotals)} vs ${JSON.stringify(mergeTotals(m1))}`);
check('merging creates nothing new anywhere', mergeTotals(m1).created === 0, JSON.stringify(mergeTotals(m1)));

console.log('\n--- 3. replace mode: the account backup wipes and restores ---');
await replaceImportDatabase(backup);
const s3 = await snapshot();
check('exactly the backup\'s documents and category remain', s3.documents.length === 2 && s3.categories.length === 1 && s3.documents.every((d) => backup.documents.some((b) => b.title === d.title)), JSON.stringify(s3.documents.map((d) => d.title)));
check('the backup\'s board, card, instance and task replace the previous ones', s3.boards.length === 1 && s3.cards === 1 && s3.instances.length === 1 && s3.tasks.length === 1 && s3.boards[0].name === backup.kanbanBoards[0].name, JSON.stringify({ b: s3.boards.map((b) => b.name), k: s3.cards, i: s3.instances.length, t: s3.tasks.length }));
const media3 = await blobOf(s3.media[0]);
check('the backup\'s media replaces the previous attachment (one Blob, the backup bytes)', s3.media.length === 1 && media3.size === base64Bytes(backup.media[0].data) && s3.media[0].filename === backup.media[0].filename, JSON.stringify(media3));
check('tables the backup has no rows for are empty after replace (templates, workflows, reports, ssh, openshift)', s3.docTemplates === 0 && s3.workflows === 0 && s3.reports === 0 && s3.ssh === 0 && s3.openshift === 0, JSON.stringify({ t: s3.docTemplates, w: s3.workflows, r: s3.reports, s: s3.ssh, o: s3.openshift }));

console.log('\n--- 4. instance paths from another machine are rewritten to ~/.task/<name> ---');
// an export from the previous desktop app or a server carries absolute paths; this device must never use or
// recreate those folders: import gives the instance this app's ~/.task/<slug> form (src/utils/taskwarriorPaths.js)
const foreign = JSON.parse(JSON.stringify(format2));
foreign.taskwarriorInstances = [
  { ...foreign.taskwarriorInstances[0], name: 'Work', rcPath: '/Users/someone/.config/support-console-work/backend/.taskrc', dataPath: '/Users/someone/.config/support-console-work/backend/.task' },
  { ...foreign.taskwarriorInstances[0], id: 2, syncId: '11111111-2222-4333-8444-666666666666', name: 'Server Ops', rcPath: '/data/users/abc/.task/ops/taskrc', dataPath: '/data/users/abc/.task/ops' },
  { ...foreign.taskwarriorInstances[0], id: 3, syncId: '11111111-2222-4333-8444-777777777777', name: 'Home', rcPath: '~/.task/home/taskrc', dataPath: '~/.task/home' },
];
foreign.taskwarriorTasks = { Work: format2.taskwarriorTasks.Work, 'Server Ops': [], Home: [] };
await replaceImportDatabase(foreign);
const after4 = Object.fromEntries((await db.taskwarriorInstances.toArray()).map((i) => [i.name, { rc: i.rcPath, data: i.dataPath }]));
check('replace: an old desktop path becomes ~/.task/work + ~/.task/work/.taskrc (the rc keeps its name)', after4.Work && after4.Work.data === '~/.task/work' && after4.Work.rc === '~/.task/work/.taskrc', JSON.stringify(after4.Work));
check('replace: a server path becomes ~/.task/server-ops (slug of the name)', after4['Server Ops'] && after4['Server Ops'].data === '~/.task/server-ops' && after4['Server Ops'].rc === '~/.task/server-ops/taskrc', JSON.stringify(after4['Server Ops']));
check('replace: a ~/ path is kept as it is', after4.Home && after4.Home.data === '~/.task/home' && after4.Home.rc === '~/.task/home/taskrc', JSON.stringify(after4.Home));
const workId = (await db.taskwarriorInstances.where('name').equals('Work').first()).id;
check('replace: the tasks still hang off the rewritten instance', (await db.tasks.count()) === 4 && (await db.tasks.toArray()).every((t) => t.instanceId === workId));
// merge of the same foreign file: nothing is turned back into an absolute path
const m4 = await mergeImportDatabase(foreign);
const afterMerge = Object.fromEntries((await db.taskwarriorInstances.toArray()).map((i) => [i.name, i.dataPath]));
check('merge: no instance ends up with an absolute path, none is duplicated', Object.values(afterMerge).every((d) => d.startsWith('~/')) && Object.keys(afterMerge).length === 3 && m4.taskwarriorInstances.created === 0, JSON.stringify(afterMerge));

fs.rmSync(WORK, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
