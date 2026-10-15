/**
 * Pins the execution semantics of the browser-side workflow engine
 * (src/utils/workflowExecution.js) node type by node type, so the engine can
 * be restructured without changing what a saved workflow does when it runs.
 *
 * tests/workflow-canvas-interactions.test.mjs already covers the happy path
 * (exec chain + data edges), note/idea skipping, Stop and the Sequence
 * fan-out order. This file covers everything else the engine decides:
 *   - how a node's data inputs are gathered (BeginPlay field handles,
 *     on-demand evaluation of pin-less variable nodes, null/undefined inputs
 *     dropped, one input unwrapped vs several kept as an array);
 *   - every variable node's value coercion, including the error messages for
 *     invalid JSON;
 *   - Make Array / Delay / Transformation (no-Worker fallback) / Set+Get
 *     Variable / Comparison;
 *   - control flow: Branch (true/false pins, object `condition`, non-boolean
 *     input), Switch (case-N pins, default pin), For Loop (array input vs
 *     `iterations`, the loop body seeing each item, Completed pin,
 *     per-iteration status updates), converging paths running a node once;
 *   - BeginPlay inputs: run-time values beat connected values, and connected
 *     variables arrive already evaluated (parsed JSON for Array/Object, env
 *     substitution for String) because the generic input gathering runs the
 *     pin-less source nodes before the BeginPlay body looks at them;
 *   - errors: a throwing node reports 'error' status, the run returns the
 *     message and nothing downstream executes; an error inside a For Loop
 *     body only stops that body chain and the run itself still succeeds;
 *   - interactive SSH hand-off: the engine parks on onInteractiveSSH with the
 *     env-substituted config and uses whatever the terminal resolves with;
 *   - unknown node types yield null and do not stop the run.
 *
 * The engine's module graph reaches Dexie (environment variables live in
 * IndexedDB), so it is bundled with esbuild and loaded in jsdom with
 * fake-indexeddb - the same recipe as the other workflow tests.
 *
 * Run:  node tests/workflow-engine.test.mjs
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

// ---------- bundle the engine (+ env-var store) with esbuild ----------
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
fs.writeFileSync(ENTRY, `
import { executeWorkflowInBrowser } from '@worktree/src/utils/workflowExecution.js';
import { setEnvironmentVariable } from '@worktree/src/utils/workflows.js';
window.__engine = executeWorkflowInBrowser;
window.__setEnv = setEnvironmentVariable;
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
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

// ---------- jsdom + fake-indexeddb environment ----------
// fake-indexeddb/auto installs indexedDB on globalThis; Dexie looks it up on
// window, so the window gets the same objects (as tests/helpers/jsdom-documents-env.mjs).
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
const engine = window.__engine;
const setEnv = window.__setEnv;

// ---------- graph helpers ----------
const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const exec = (source, target, sourceHandle = 'exec-out') => ({
  id: `x-${source}-${sourceHandle}-${target}`, source, target, sourceHandle, targetHandle: 'exec-in', type: 'execution',
});
const data = (source, target, targetHandle = 'data-in', sourceHandle = 'data-out') => ({
  id: `d-${source}-${sourceHandle}-${target}-${targetHandle}`, source, target, sourceHandle, targetHandle, type: 'data',
});
/** Run a graph and collect the status stream alongside the outputs. */
async function run(nodes, edges, inputs = {}, extra = {}) {
  const updates = [];
  const result = await engine({ nodes, edges }, inputs, (id, status, payload) => updates.push({ id, status, payload }), extra.onInteractiveSSH || null, extra.shouldAbort || null);
  return { ...result, updates, statuses: updates.map((u) => `${u.id}:${u.status}`) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 1;
try {
  await setEnv('GREETING', 'hello');
  await setEnv('HOST', 'db.internal');

  // ============ input gathering ============================================
  {
    const r = await run([
      node('bp', 'beginplay'), node('s', 'string', { value: '{{GREETING}} world' }), node('res', 'result'),
    ], [exec('bp', 'res'), data('s', 'res')]);
    check('string variable: {{VAR}} placeholders are substituted and the value flows to Result',
      !r.error && r.outputs.res === 'hello world', JSON.stringify(r.outputs));
    check('data-only variable nodes are evaluated on demand, never queued (no processing status of their own)',
      !r.statuses.includes('s:processing') && r.outputs.s === 'hello world', r.statuses.join(','));
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('a', 'string', { value: 'a' }), node('b', 'integer', { value: 2 }), node('res', 'result'),
    ], [exec('bp', 'res'), data('a', 'res'), data('b', 'res')]);
    check('several data inputs arrive as an array in edge order', eq(r.outputs.res, ['a', 2]), JSON.stringify(r.outputs.res));
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('g', 'variablereference', { variableName: 'missing' }), node('a', 'string', { value: 'only' }), node('res', 'result'),
    ], [exec('bp', 'res'), data('g', 'res'), data('a', 'res')]);
    check('undefined/null inputs are dropped, a single remaining input is unwrapped', r.outputs.res === 'only', JSON.stringify(r.outputs.res));
  }
  {
    const r = await run([node('bp', 'beginplay'), node('res', 'result')], [exec('bp', 'res')]);
    check('a node with no data edges receives null', r.outputs.res === null && !r.error, JSON.stringify(r.outputs));
  }

  // ============ variable coercion ==========================================
  {
    const r = await run([
      node('bp', 'beginplay'),
      node('i1', 'integer', { value: '17' }), node('i2', 'integer', { value: 'abc' }), node('i3', 'integer', { value: 3 }),
      node('b1', 'boolean', { value: true }), node('b2', 'boolean', {}),
      node('o', 'object', { value: '{"k": [1]}' }), node('arr', 'array', { value: '[1, "x"]' }),
      node('t', 'text', { value: 'line {{HOST}}' }),
      node('v1', 'visualizer'), node('v2', 'visualizer'), node('v3', 'visualizer'), node('v4', 'visualizer'),
      node('v5', 'visualizer'), node('v6', 'visualizer'), node('v7', 'visualizer'), node('v8', 'visualizer'),
    ], [
      exec('bp', 'v1'), exec('v1', 'v2'), exec('v2', 'v3'), exec('v3', 'v4'), exec('v4', 'v5'), exec('v5', 'v6'), exec('v6', 'v7'), exec('v7', 'v8'),
      data('i1', 'v1'), data('i2', 'v2'), data('i3', 'v3'), data('b1', 'v4'), data('b2', 'v5'), data('o', 'v6'), data('arr', 'v7'), data('t', 'v8'),
    ]);
    check('integer: numeric strings parse, garbage becomes 0, numbers pass through',
      r.outputs.v1 === 17 && r.outputs.v2 === 0 && r.outputs.v3 === 3, JSON.stringify([r.outputs.v1, r.outputs.v2, r.outputs.v3]));
    check('boolean: configured value, defaulting to false', r.outputs.v4 === true && r.outputs.v5 === false);
    check('object/array: JSON text is parsed', eq(r.outputs.v6, { k: [1] }) && eq(r.outputs.v7, [1, 'x']));
    check('text: substitutes {{VAR}} like string', r.outputs.v8 === 'line db.internal');
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('b', 'boolean', { value: false }), node('s', 'string', { value: 'yes' }), node('res', 'result'),
    ], [exec('bp', 'res'), data('s', 'b'), data('b', 'res')]);
    check('boolean: a connected input wins over the configured value (Boolean(input))', r.outputs.res === true);
  }
  {
    const r = await run([node('bp', 'beginplay'), node('o', 'object', { value: '{oops' }), node('res', 'result')], [exec('bp', 'res'), data('o', 'res')]);
    check('object: invalid JSON fails the run with "Invalid JSON in Object variable"',
      r.error === 'Invalid JSON in Object variable' && r.statuses.includes('res:error'), r.error);
    const r2 = await run([node('bp', 'beginplay'), node('a', 'array', { value: '{"not": "array"}' }), node('res', 'result')], [exec('bp', 'res'), data('a', 'res')]);
    check('array: non-array JSON fails with "Invalid JSON in Array variable: Value is not an array"',
      r2.error === 'Invalid JSON in Array variable: Value is not an array', r2.error);
  }

  // ============ Make Array / Delay / Transformation ========================
  {
    const r = await run([
      node('bp', 'beginplay'), node('s', 'string', { value: 'a, b ,c' }), node('m', 'makearray', { delimiter: ',' }),
      node('arr', 'array', { value: '[9]' }), node('m2', 'makearray'), node('m3', 'makearray', { delimiter: ';' }),
      node('res', 'result'),
    ], [exec('bp', 'm'), exec('m', 'm2'), exec('m2', 'm3'), exec('m3', 'res'), data('s', 'm'), data('arr', 'm2'), data('m2', 'res')]);
    check('makearray: splits on the delimiter and trims; arrays pass through; no input gives []',
      eq(r.outputs.m, ['a', 'b', 'c']) && eq(r.outputs.m2, [9]) && eq(r.outputs.m3, []), JSON.stringify([r.outputs.m, r.outputs.m2, r.outputs.m3]));
  }
  {
    const t0 = Date.now();
    const r = await run([
      node('bp', 'beginplay'), node('n', 'integer', { value: 60 }), node('d', 'delay', { duration: 5000 }), node('res', 'result'),
    ], [exec('bp', 'd'), exec('d', 'res'), data('n', 'd'), data('d', 'res')]);
    const took = Date.now() - t0;
    check('delay: a numeric input overrides the configured duration and the input is passed through',
      r.outputs.res === 60 && took >= 55 && took < 2000, `${took}ms`);
    const t1 = Date.now();
    const r2 = await run([
      node('bp', 'beginplay'), node('o', 'object', { value: '{"duration": 40, "x": 1}' }), node('d', 'delay', { duration: 5000 }), node('res', 'result'),
    ], [exec('bp', 'd'), exec('d', 'res'), data('o', 'd'), data('d', 'res')]);
    check('delay: an object input with `duration` overrides and is passed through',
      eq(r2.outputs.res, { duration: 40, x: 1 }) && Date.now() - t1 < 2000);
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('o', 'object', { value: '{"x": 21}' }), node('t', 'transformation', { code: 'return input.x * 2;' }),
      node('t2', 'transformation', { code: '' }), node('res', 'result'),
    ], [exec('bp', 't'), exec('t', 't2'), exec('t2', 'res'), data('o', 't'), data('t', 't2'), data('t2', 'res')]);
    check('transformation: the snippet runs against `input`; an empty snippet passes input through',
      r.outputs.t === 42 && r.outputs.t2 === 42 && r.outputs.res === 42, JSON.stringify(r.outputs));
    const r2 = await run([
      node('bp', 'beginplay'), node('t', 'transformation', { code: 'throw new Error("nope")' }), node('res', 'result'),
    ], [exec('bp', 't'), exec('t', 'res')]);
    check('transformation: snippet errors are prefixed "Transformation error:" and fail the run',
      r2.error === 'Transformation error: nope' && r2.statuses.includes('t:error') && !r2.statuses.includes('res:processing'), r2.error);
  }

  // ============ Set / Get Variable, Comparison =============================
  {
    const r = await run([
      node('bp', 'beginplay'), node('s', 'string', { value: 'payload' }), node('set', 'storage', { variableName: 'v' }),
      node('get', 'variablereference', { variableName: 'v' }), node('res', 'result'),
    ], [exec('bp', 'set'), exec('set', 'res'), data('s', 'set'), data('get', 'res')]);
    check('storage returns { stored, variableName, value } and Get Variable reads it back later in the run',
      eq(r.outputs.set, { stored: true, variableName: 'v', value: 'payload' }) && r.outputs.res === 'payload', JSON.stringify(r.outputs));
  }
  {
    const cmp = (operator, l, r) => run([
      node('bp', 'beginplay'), node('l', 'integer', { value: l }), node('r', 'integer', { value: r }),
      node('c', 'comparison', { operator }), node('res', 'result'),
    ], [exec('bp', 'res'), data('l', 'c', 'left-in'), data('r', 'c', 'right-in'), data('c', 'res')]);
    const outs = await Promise.all([cmp('>', 2, 1), cmp('<', 2, 1), cmp('==', 2, 2), cmp('!=', 2, 2), cmp('>=', 2, 2), cmp('<=', 3, 2), cmp('??', 1, 1)]);
    check('comparison: all six operators via left-in/right-in, unknown operator is false',
      eq(outs.map((o) => o.outputs.res), [true, false, true, false, true, false, false]), JSON.stringify(outs.map((o) => o.outputs.res)));
  }

  // ============ control flow ===============================================
  {
    const branchRun = (condNode) => run([
      node('bp', 'beginplay'), condNode, node('br', 'branch'), node('yes', 'visualizer'), node('no', 'visualizer'),
    ], [exec('bp', 'br'), exec('br', 'yes', 'true'), exec('br', 'no', 'false'), data('c', 'br'), data('br', 'yes'), data('br', 'no')]);
    const t = await branchRun(node('c', 'boolean', { value: true }));
    const f = await branchRun(node('c', 'boolean', { value: false }));
    const obj = await branchRun(node('c', 'object', { value: '{"condition": true}' }));
    const str = await branchRun(node('c', 'string', { value: 'true' }));
    check('branch: true input follows the TRUE pin only, false the FALSE pin only',
      t.statuses.includes('yes:complete') && !t.statuses.includes('no:processing') &&
      f.statuses.includes('no:complete') && !f.statuses.includes('yes:processing'));
    check('branch: an object with a boolean `condition` is honoured, anything else counts as false',
      obj.statuses.includes('yes:complete') && str.statuses.includes('no:complete') && !str.statuses.includes('yes:processing'));
    check('branch: downstream nodes receive the branch input as its data (not the routing marker)',
      t.outputs.yes === true && eq(obj.outputs.yes, { condition: true }) && eq(t.outputs.br, true), JSON.stringify(t.outputs));
  }
  {
    const switchRun = (value) => run([
      node('bp', 'beginplay'), node('s', 'string', { value }), node('sw', 'switch', { cases: [{ value: 'a' }, { value: 'b' }] }),
      node('ca', 'visualizer'), node('cb', 'visualizer'), node('def', 'visualizer'),
    ], [exec('bp', 'sw'), exec('sw', 'ca', 'case-0'), exec('sw', 'cb', 'case-1'), exec('sw', 'def', 'default'), data('s', 'sw'), data('sw', 'cb')]);
    const a = await switchRun('a');
    const b = await switchRun('b');
    const z = await switchRun('zzz');
    const ran = (r) => ['ca', 'cb', 'def'].filter((id) => r.statuses.includes(`${id}:complete`));
    check('switch: the matching case pin runs and nothing else; no match takes the DEFAULT pin',
      eq(ran(a), ['ca']) && eq(ran(b), ['cb']) && eq(ran(z), ['def']), `${ran(a)}/${ran(b)}/${ran(z)}`);
    check('switch: its data output is the matched input value', b.outputs.cb === 'b' && b.outputs.sw === 'b');
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('arr', 'array', { value: '["x", "y"]' }), node('loop', 'forloop'),
      node('body', 'visualizer'), node('done', 'visualizer'), node('tail', 'string', { value: 'end' }),
    ], [exec('bp', 'loop'), exec('loop', 'body', 'loop-body'), exec('loop', 'done', 'completed'), data('arr', 'loop'), data('loop', 'body'), data('tail', 'done')]);
    const bodyItems = r.updates.filter((u) => u.id === 'body' && u.status === 'complete').map((u) => u.payload);
    check('forloop: the body runs once per array item and sees the current item on the loop\'s data pin',
      eq(bodyItems, ['x', 'y']), JSON.stringify(bodyItems));
    check('forloop: the Completed pin runs after the last iteration; the body target is never seeded as a start node',
      r.statuses.lastIndexOf('done:complete') > r.statuses.lastIndexOf('body:complete') && r.outputs.done === 'end' && r.statuses.indexOf('body:processing') > r.statuses.indexOf('loop:processing'),
      r.statuses.join(','));
    const r2 = await run([
      node('bp', 'beginplay'), node('loop', 'forloop', { iterations: 3 }), node('body', 'visualizer'),
    ], [exec('bp', 'loop'), exec('loop', 'body', 'loop-body'), data('loop', 'body')]);
    check('forloop: without an array input it iterates 0..iterations-1',
      eq(r2.updates.filter((u) => u.id === 'body' && u.status === 'complete').map((u) => u.payload), [0, 1, 2]));
  }
  {
    // bp -> seq -> (Then 0: vis, Then 1: vis) : a node reachable from two paths runs once
    const r = await run([
      node('bp', 'beginplay'), node('seq', 'sequence', { outputCount: 2 }), node('vis', 'visualizer'), node('res', 'result'),
    ], [exec('bp', 'seq'), exec('seq', 'vis', 'output-0'), exec('seq', 'vis', 'output-1'), exec('vis', 'res')]);
    check('converging execution paths run a node only once',
      r.statuses.filter((s) => s === 'vis:processing').length === 1 && r.statuses.filter((s) => s === 'res:complete').length === 1, r.statuses.join(','));
  }

  // ============ BeginPlay inputs ===========================================
  {
    const graph = [
      node('bp', 'beginplay', { inputs: { name: { type: 'string', default: '' }, count: { type: 'string', default: '' }, list: { type: 'string', default: '' }, cfg: { type: 'string', default: '' }, none: { type: 'string', default: '' } } }),
      node('s', 'string', { value: '{{GREETING}}' }), node('i', 'integer', { value: '5' }), node('a', 'array', { value: '[1, 2]' }), node('o', 'object', { value: '{"z": 1}' }),
      node('res', 'result'),
    ];
    const edges = [
      exec('bp', 'res'),
      data('s', 'bp', 'input-name'), data('i', 'bp', 'input-count'), data('a', 'bp', 'input-list'), data('o', 'bp', 'input-cfg'),
      data('bp', 'res', 'data-in', 'output-count'),
    ];
    const r = await run(graph, edges, { name: 'given' });
    check('beginplay: a run-time input value wins over the connected variable, unconnected inputs are null',
      r.outputs.bp.name === 'given' && r.outputs.bp.none === null, JSON.stringify(r.outputs.bp));
    check('beginplay: connected String (env-substituted) and Integer values are coerced like their nodes',
      r.outputs.bp.count === 5 && (await run(graph, edges, {})).outputs.bp.name === 'hello');
    check('beginplay: connected Array/Object variables arrive parsed (same as a direct data edge)',
      eq(r.outputs.bp.list, [1, 2]) && eq(r.outputs.bp.cfg, { z: 1 }), JSON.stringify([r.outputs.bp.list, r.outputs.bp.cfg]));
    check('beginplay: an output-<name> handle delivers just that field downstream', r.outputs.res === 5, JSON.stringify(r.outputs.res));
    const r2 = await run(graph, edges, { name: '', count: null });
    check('beginplay: empty-string / null run-time values do not override connected values',
      r2.outputs.bp.name === 'hello' && r2.outputs.bp.count === 5);
  }

  // ============ errors, abort, unknown types, SSH hand-off =================
  {
    const r = await run([
      node('bp', 'beginplay'), node('o', 'object', { value: 'bad' }), node('v', 'visualizer'), node('res', 'result'),
    ], [exec('bp', 'v'), exec('v', 'res'), data('o', 'v')]);
    check('a throwing node reports error status, the run returns its message and downstream nodes never start',
      r.error === 'Invalid JSON in Object variable' && r.statuses.includes('v:error') && !r.statuses.includes('res:processing') && r.outputs.bp !== undefined,
      r.statuses.join(','));
  }
  {
    const r = await run([
      node('bp', 'beginplay'), node('loop', 'forloop', { iterations: 2 }), node('bad', 'object', { value: 'bad' }),
      node('body', 'visualizer'), node('after', 'visualizer'), node('done', 'visualizer'),
    ], [exec('bp', 'loop'), exec('loop', 'body', 'loop-body'), exec('body', 'after'), exec('loop', 'done', 'completed'), data('bad', 'body')]);
    check('an error inside a loop body stops that body chain only: no error status outside it and the run still succeeds',
      r.error === null && r.statuses.filter((s) => s === 'body:error').length === 2 && !r.statuses.includes('after:processing') && r.statuses.includes('done:complete'),
      `${r.error} ${r.statuses.join(',')}`);
  }
  {
    let aborted = false;
    const p = run([
      node('bp', 'beginplay'), node('d', 'delay', { duration: 80 }), node('res', 'result'),
    ], [exec('bp', 'd'), exec('d', 'res')], {}, { shouldAbort: () => aborted });
    await sleep(20);
    aborted = true;
    const r = await p;
    check('shouldAbort stops the run before the next node (no error, Result never runs)',
      r.error === null && !r.statuses.includes('res:processing') && r.statuses.includes('d:processing'), r.statuses.join(','));
  }
  {
    const r = await run([node('bp', 'beginplay'), node('weird', 'markdown', { content: 'x' }), node('res', 'result')], [exec('bp', 'weird'), exec('weird', 'res')]);
    check('an unknown node type yields null and the run continues', r.error === null && r.outputs.weird === null && r.statuses.includes('res:complete'));
  }
  {
    const seen = [];
    const r = await run([
      node('bp', 'beginplay'),
      node('ssh', 'ssh', { host: '{{HOST}}', port: '2222', username: 'root', command: 'uptime', interactive: true, password: '' }),
      node('res', 'result'),
    ], [exec('bp', 'ssh'), exec('ssh', 'res'), data('ssh', 'res')], {}, {
      onInteractiveSSH: async (nodeId, config) => { seen.push({ nodeId, config }); return { stdout: 'up', exitCode: 0, success: true }; },
    });
    check('interactive SSH: the engine hands the env-substituted config to onInteractiveSSH and uses the terminal\'s result as the node output',
      seen.length === 1 && seen[0].nodeId === 'ssh' && eq(seen[0].config, { host: 'db.internal', port: 2222, username: 'root', authMethod: 'agent', password: '', command: 'uptime', sshOptions: '' }) &&
      eq(r.outputs.ssh, { stdout: 'up', exitCode: 0, success: true }) && eq(r.outputs.res, { stdout: 'up', exitCode: 0, success: true }),
      JSON.stringify(seen));
    const r2 = await run([node('bp', 'beginplay'), node('ssh', 'ssh', { host: 'h', command: 'ls' }), node('res', 'result')], [exec('bp', 'ssh'), exec('ssh', 'res')]);
    check('ssh: missing host/username/command fails the run', r2.error === 'SSH requires host, username, and command', r2.error);
  }

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
