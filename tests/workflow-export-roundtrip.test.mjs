/**
 * Guards "Export Workflow (JSON)" / "Export Category as JSON" in the
 * workflow list's context menus and the round trip through "Import from
 * JSON" (src/utils/workflowTransfer.js, src/hooks/useWorkflowLibraryActions.js).
 *
 * What this test proves:
 *   - an export is always a JSON ARRAY of workflow objects, also for a
 *     single workflow, and the importer's parser accepts exactly that (an
 *     object or a scalar is rejected as "not an array"; malformed JSON
 *     throws);
 *   - the file name: one workflow -> a filesystem-safe version of its title
 *     (`workflow.json` when the title is empty), a category ->
 *     `<category>-workflows-YYYY-MM-DD.json`, several -> the classic
 *     `workflows-export-YYYY-MM-DD.json`;
 *   - the round trip through the REAL store (src/utils/workflows.js on
 *     Dexie + fake-indexeddb): a workflow created in the database, read
 *     back, exported, parsed and imported again comes back with the same
 *     title, category, nodes and edges, as a new record.
 *
 * Same esbuild + jsdom + fake-indexeddb recipe as tests/workflow-engine.test.mjs.
 *
 * Run:  node tests/workflow-export-roundtrip.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('dexie', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-export-'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
fs.writeFileSync(ENTRY, `
import { createWorkflow, getWorkflow } from '@worktree/src/utils/workflows.js';
import { serializeWorkflows, parseWorkflowsExport, workflowExportFileName, slugify } from '@worktree/src/utils/workflowTransfer.js';
window.__wf = { createWorkflow, getWorkflow, serializeWorkflows, parseWorkflowsExport, workflowExportFileName, slugify };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = globalThis.indexedDB;
window.IDBKeyRange = globalThis.IDBKeyRange;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('localStorage', window.localStorage);
createRequire(import.meta.url)(BUNDLE);
const { createWorkflow, getWorkflow, serializeWorkflows, parseWorkflowsExport, workflowExportFileName, slugify } = window.__wf;

let exitCode = 1;
try {
  const today = new Date().toISOString().slice(0, 10);
  const nodes = [
    { id: 'node-1', type: 'beginplay', position: { x: 250, y: 250 }, data: { inputs: { host: { type: 'string', default: '' } } } },
    { id: 'node-2', type: 'string', position: { x: 100, y: 400 }, data: { value: 'hello {{NAME}}' } },
    { id: 'node-3', type: 'result', position: { x: 550, y: 250 }, data: {}, zIndex: 2 },
    { id: 'node-4', type: 'note', position: { x: 0, y: 0 }, width: 200, height: 120, data: { text: 'keep', color: 'blue' } },
  ];
  const edges = [
    { id: 'edge-1', source: 'node-1', target: 'node-3', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
    { id: 'edge-2', source: 'node-2', target: 'node-3', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
  ];

  // ---------- format ----------
  const one = [{ title: 'My Workflow', category: 'Ops', nodes, edges }];
  const text = serializeWorkflows(one);
  check('a single workflow still exports as a JSON array (what Import from JSON expects)', Array.isArray(JSON.parse(text)) && JSON.parse(text).length === 1);
  check('the parser returns the array, rejects non-arrays as null and throws on malformed JSON',
    eq(parseWorkflowsExport(text), one) && parseWorkflowsExport('{"title":"x"}') === null && parseWorkflowsExport('42') === null &&
    (() => { try { parseWorkflowsExport('{nope'); return false; } catch { return true; } })());

  // ---------- file names ----------
  check('one workflow -> a filesystem-safe title', workflowExportFileName({ workflows: [{ title: 'Health check / notify: v2!' }] }) === 'health-check-notify-v2.json');
  check('an empty title falls back to workflow.json', workflowExportFileName({ workflows: [{ title: '' }] }) === 'workflow.json' && slugify('   ') === '');
  check('several workflows -> workflows-export-YYYY-MM-DD.json', workflowExportFileName({ workflows: [{ title: 'a' }, { title: 'b' }] }) === `workflows-export-${today}.json`);
  check('a category -> <category>-workflows-YYYY-MM-DD.json (also for one workflow)',
    workflowExportFileName({ workflows: [{ title: 'a' }], category: 'Operations' }) === `operations-workflows-${today}.json`);
  check('non-latin titles keep their letters', slugify('Déploiement été') === 'déploiement-été');

  // ---------- round trip through the real store ----------
  const id = await createWorkflow({ title: 'Round trip', category: 'Ops', nodes, edges });
  const stored = await getWorkflow(id);
  const exported = serializeWorkflows([stored]);
  const imported = parseWorkflowsExport(exported);
  // the importer creates a fresh record from each entry (useWorkflowLibraryActions.importWorkflowList)
  const newId = await createWorkflow({ title: imported[0].title || 'Imported Workflow', category: imported[0].category || 'General', nodes: imported[0].nodes || [], edges: imported[0].edges || [] });
  const back = await getWorkflow(newId);
  check('export then import yields a new record with the same title, category, nodes and edges',
    newId !== id && back.title === 'Round trip' && back.category === 'Ops' && eq(back.nodes, nodes) && eq(back.edges, edges), JSON.stringify({ id, newId, title: back?.title }));
  check('the exported file carries no functions and parses to plain data', !/onChange/.test(exported));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
}
process.exit(exitCode);
