/**
 * Guards the renderer-side sandbox for workflow "transformation" nodes
 * (src/utils/workflowExecution.js).
 *
 * THE BUG: a transformation node's user-written snippet was executed with
 * `new Function('input', code)` directly in the privileged Electron renderer,
 * where `window.electronAPI` (the preload bridge: env vars, SSH execution,
 * the backend auth token, ...) is in scope. Workflows are synced between
 * machines through the central server, so a hostile snippet could read the
 * bridge and exfiltrate secrets or pivot to code execution the moment the
 * recipient clicked Run.
 *
 * THE FIX: the snippet now runs inside a dedicated Web Worker built from a
 * blob (TRANSFORMATION_WORKER_SOURCE). A worker has no DOM, no window and no
 * preload bridge, and before evaluating the snippet the worker deletes and
 * pins every global that could reach the network, load more code or touch
 * storage (fetch, XMLHttpRequest, WebSocket, importScripts, indexedDB, ...).
 * Data crosses the boundary by structured clone only. Environments without
 * Worker (jsdom) use runTransformationRestricted, a strict-mode Function
 * with the dangerous globals shadowed.
 *
 * What this test proves:
 *   - the worker source is a valid standalone script;
 *   - legitimate transforms keep working through the worker protocol
 *     (string / array / object reshaping, promise results, error surfacing,
 *     non-cloneable return values falling back to their JSON projection);
 *   - inside the worker, fetch / XMLHttpRequest / WebSocket / importScripts /
 *     navigator / indexedDB are gone and cannot be reassigned, and there is
 *     no window / document / electronAPI;
 *   - the no-Worker fallback also runs the legit transforms and hides
 *     process / require / globalThis.
 *
 * Node has no Web Worker, so the worker source is executed in a
 * worker_threads Worker with a faithful shim: `self === globalThis` (as in
 * a real DedicatedWorkerGlobalScope), a `postMessage` bound to parentPort,
 * and stand-ins for the browser-only globals the sandbox is expected to
 * remove. Self-contained, no test framework.
 *
 * Run:  node tests/workflow-transform-sandbox.test.mjs
 * Preconditions: none beyond Node (no deps).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SOURCE_FILE = path.join(REPO, 'src', 'utils', 'workflowExecution.js');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = fs.readFileSync(SOURCE_FILE, 'utf8');

// The executor must no longer evaluate snippets in its own realm (comments
// stripped: the case body deliberately documents why `new Function` is banned).
const transformationCase = src
  .slice(src.indexOf("case 'transformation':"), src.indexOf("case 'delay':"))
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('transformation case does not call new Function in the renderer realm',
  transformationCase.length > 0 && !/new Function\(/.test(transformationCase) && /runTransformation\(/.test(transformationCase));

const workerMatch = src.match(/const TRANSFORMATION_WORKER_SOURCE = `([\s\S]*?)`;\n/);
check('worker source present', Boolean(workerMatch));
const workerSource = workerMatch ? workerMatch[1] : '';

let parses = true;
try { new Function(workerSource); } catch (e) { parses = false; console.log('  parse error:', e.message); }
check('worker source parses as a standalone script', parses);

/** Run one snippet through the worker source under a faithful self shim. */
function runInWorker(code, input) {
  return new Promise((resolve) => {
    const shim = `
      const { parentPort } = require('node:worker_threads');
      // Faithful to a real DedicatedWorkerGlobalScope: self === globalThis
      globalThis.self = globalThis;
      // Browser-only globals the sandbox is expected to remove
      globalThis.XMLHttpRequest = function () {};
      globalThis.importScripts = function () {};
      globalThis.indexedDB = {};
      globalThis.caches = {};
      globalThis.postMessage = (m) => parentPort.postMessage(m);
      ${workerSource}
      parentPort.on('message', (data) => self.onmessage({ data }));
    `;
    const w = new Worker(shim, { eval: true });
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, error: 'timeout' }); }, 5000);
    w.on('message', (msg) => { clearTimeout(timer); w.terminate(); resolve(msg); });
    w.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'worker error: ' + e.message }); });
    w.postMessage({ code, input });
  });
}

// ---------- legitimate transforms through the worker ----------
let r;
r = await runInWorker('return input.toUpperCase()', 'hello');
check('worker: string transform', r.ok && r.result === 'HELLO', JSON.stringify(r));
r = await runInWorker('return input.map(x => x * 2)', [1, 2, 3]);
check('worker: array transform', r.ok && eq(r.result, [2, 4, 6]), JSON.stringify(r));
r = await runInWorker('return { n: input.user.name, c: input.items.length }', { user: { name: 'a' }, items: [1, 2] });
check('worker: JSON reshape', r.ok && eq(r.result, { n: 'a', c: 2 }), JSON.stringify(r));
r = await runInWorker('return input * 2 + 1', 20);
check('worker: arithmetic', r.ok && r.result === 41, JSON.stringify(r));
r = await runInWorker('return Promise.resolve(input + 1)', 41);
check('worker: promise result is awaited', r.ok && r.result === 42, JSON.stringify(r));
r = await runInWorker('const x = 1;', 1);
check('worker: no return -> undefined', r.ok && r.result === undefined, JSON.stringify(r));
r = await runInWorker('throw new Error("boom")', 1);
check('worker: snippet error surfaces', !r.ok && /boom/.test(r.error), JSON.stringify(r));
r = await runInWorker('return (', 1);
check('worker: syntax error surfaces', !r.ok && r.error, JSON.stringify(r));
r = await runInWorker('return { f() {}, v: 1 }', 1);
check('worker: non-cloneable result falls back to JSON projection', r.ok && eq(r.result, { v: 1 }), JSON.stringify(r));

// ---------- hostile probes inside the worker ----------
r = await runInWorker('return typeof fetch', 1);
check('worker: bare fetch is gone', r.ok && r.result === 'undefined', JSON.stringify(r));
r = await runInWorker(
  'return [typeof self.fetch, typeof self.XMLHttpRequest, typeof self.WebSocket, typeof self.importScripts, typeof self.navigator, typeof self.indexedDB, typeof self.caches].join("/")', 1);
check('worker: network/loader/storage globals removed',
  r.ok && r.result === 'undefined/undefined/undefined/undefined/undefined/undefined/undefined', JSON.stringify(r));
r = await runInWorker('self.fetch = function () { return 1 }; return typeof self.fetch', 1);
check('worker: removed globals cannot be reassigned', r.ok && r.result === 'undefined', JSON.stringify(r));
r = await runInWorker('try { Object.defineProperty(self, "fetch", { value: 1 }); } catch (e) { return "blocked" } return typeof self.fetch', 1);
check('worker: removed globals cannot be redefined', r.ok && (r.result === 'blocked' || r.result === 'undefined'), JSON.stringify(r));
r = await runInWorker('return [typeof window, typeof document, typeof electronAPI].join("/")', 1);
check('worker: no window / document / electronAPI', r.ok && r.result === 'undefined/undefined/undefined', JSON.stringify(r));

// ---------- fallback path (no Worker available, e.g. jsdom) ----------
const fallbackMatch = src.match(/function runTransformationRestricted[\s\S]*?\n}\n/);
check('fallback function present', Boolean(fallbackMatch));
if (fallbackMatch) {
  const runTransformationRestricted = new Function(fallbackMatch[0] + '; return runTransformationRestricted;')();
  check('fallback: string transform', runTransformationRestricted('return input.toUpperCase()', 'hi') === 'HI');
  check('fallback: array transform', eq(runTransformationRestricted('return input.map(x => x * 2)', [1, 2]), [2, 4]));
  check('fallback: JSON reshape', eq(runTransformationRestricted('return { k: Object.keys(input) }', { a: 1 }), { k: ['a'] }));
  check('fallback: process / require / globalThis / window shadowed',
    runTransformationRestricted('return [typeof process, typeof require, typeof globalThis, typeof window].join("/")', 1)
      === 'undefined/undefined/undefined/undefined');
}

const failed = results.filter((x) => !x.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
