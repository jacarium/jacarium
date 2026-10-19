#!/usr/bin/env node
/**
 * The task's done checkbox on the Tasks page works and is visible.
 *
 * "How do I mark a task done? I can only see Delete": the checkbox in
 * src/components/tasks/TaskItem.jsx was an EMPTY <button> - the clean-up
 * "no icons in text buttons" (v3.0.2) took its Circle / CheckCircle icons
 * out, misled by tests/ui-consistency.test.mjs counting the icon's
 * conditional className string as button text (fixed there too). The
 * button still toggled the task; it just rendered as nothing.
 *
 * Proved with the REAL TasksPage mounted in jsdom over fake-indexeddb
 * (fetch stubbed to fail: no backend, every TaskWarrior CLI call is a
 * harmless no-op, the local cache still updates):
 *   1. every pending task shows a Circle inside a button named
 *      "Mark as done" (aria-pressed=false, data-testid="task-done-toggle");
 *   2. clicking it completes the task in the local cache (status
 *      'completed', end set), the icon switches to CheckCircle and the
 *      button reads "Mark as not done" (aria-pressed=true); the completed
 *      task is listed under the completed filter;
 *   3. clicking it again restores the task to pending;
 *   4. a read-only item (a report's list) keeps the icon but is disabled;
 *   5. the icons are the lucide ones with the token colours (green when
 *      done, muted otherwise, hover blue only when editable).
 *
 * Synthetic data only.
 *
 * Run:  node tests/task-done-checkbox.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 *   (prints "SKIP:" and exits 0 when the test-only deps are missing)
 * Exit code 0 = all checks passed (or skipped), 1 = failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function resolvable(name) { try { req.resolve(name); return true; } catch { return false; } }
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
for (const dep of ['fake-indexeddb', 'jsdom']) {
  if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'task-done-checkbox-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = console.log;
let failures = 0;
let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) report(`PASS: ${name}`);
  else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 400)}` : ''}`); }
}
async function waitFor(fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(25);
  }
}

// ---------- source-level ----------
const itemSrc = fs.readFileSync(path.join(REPO, 'src/components/tasks/TaskItem.jsx'), 'utf8');
check('TaskItem imports CheckCircle and Circle from lucide-react and renders one of them inside the done button',
  /import \{[^}]*\bCheckCircle\b[^}]*\bCircle\b[^}]*\} from 'lucide-react'/.test(itemSrc) &&
  /data-testid="task-done-toggle"\s*>\s*\{isCompleted \? \(\s*<CheckCircle className="w-4 h-4 text-green-500" \/>\s*\) : \(\s*<Circle className=\{`w-4 h-4 text-os-text-muted \$\{!isReadOnly \? 'hover:text-os-blue transition-colors' : ''\}`\} \/>/.test(itemSrc));

// ---------- bundle ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import TasksPage from '@worktree/src/components/TasksPage.jsx';
import TaskItem from '@worktree/src/components/tasks/TaskItem.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { db } from '@worktree/src/db/database.js';
import { createTask, getTasks } from '@worktree/src/utils/tasks.js';
import { createInstance } from '@worktree/src/utils/taskwarriorInstances.js';

const api = { db, createTask, getTasks, createInstance };
let setView = null;
let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  if (view.kind === 'tasks') return React.createElement(TasksPage, { key: view.key });
  if (view.kind === 'item') return React.createElement(TaskItem, { key: view.key, onUpdate: () => {}, onDelete: () => {}, onToggleComplete: view.props.onToggleComplete || (() => {}), onStart: () => {}, onStop: () => {}, onAnnotate: () => {}, onDenotate: () => {}, projects: [], isSelected: false, onToggleSelection: () => {}, ...view.props });
  return null;
}
api.mount = (kind, props = {}) => setView({ kind, props, key: ++key });
api.unmount = () => setView(null);
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Host)));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
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

// ---------- jsdom + fake IndexedDB ----------
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) {
  define(name, window[name]);
}
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver);
window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
const fetchLog = [];
const failingFetch = (url, options = {}) => {
  fetchLog.push(`${options.method || 'GET'} ${String(url)}`);
  return Promise.reject(new Error('no backend in test'));
};
define('fetch', failingFetch); window.fetch = failingFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const now = new Date().toISOString();
const iconOf = (btn) => btn.querySelector('svg')?.getAttribute('class') || '';
const toggles = () => Array.from(document.querySelectorAll('[data-testid="task-done-toggle"]'));

/* ---------- 1. the real Tasks page ---------- */
const inst = await H.createInstance({ name: 'Platform work', category: 'General', isActive: 1, dataPath: '/tmp/synthetic-platform' });
const pending = await H.createTask({ uuid: 'done-test-1', description: 'Investigate pod evictions', status: 'pending', instanceId: inst.id, entry: now, modified: now });
await H.createTask({ uuid: 'done-test-2', description: 'Rotate the edge certificates', status: 'pending', instanceId: inst.id, entry: now, modified: now });
H.mount('tasks');
await waitFor(() => H.mount);
let btn = await waitFor(() => toggles().length === 2 ? toggles()[0] : null, 15000);
check('the Tasks page lists two pending tasks, each with a done checkbox button', !!btn && toggles().length === 2, toggles().length);
// let the page's own mount-time backend calls (install check, auto-sync) settle before clicking
await waitFor(() => (fetchLog.length >= 1 && !document.querySelector('.animate-spin') ? true : null), 10000);
await sleep(300);
btn = toggles()[0];
const firstName = btn?.closest('[class*="group"]')?.textContent || '';
check('a pending task\'s checkbox shows the Circle icon, is named "Mark as done" and is not pressed',
  !!btn && /lucide-circle\b/.test(iconOf(btn)) && !/lucide-circle-check/.test(iconOf(btn)) && btn.getAttribute('aria-label') === 'Mark as done' && btn.getAttribute('title') === 'Mark as done' && btn.getAttribute('aria-pressed') === 'false' && !btn.disabled,
  `${iconOf(btn)} ${btn?.getAttribute('aria-label')} pressed=${btn?.getAttribute('aria-pressed')}`);
check('the checkbox icon uses the token colours (muted, blue on hover) and is visible (not sr-only / hidden)',
  /text-os-text-muted/.test(iconOf(btn)) && /hover:text-os-blue/.test(iconOf(btn)) && !/sr-only|hidden/.test(btn.className));

click(btn);
const row = await waitFor(async () => { const t = await H.db.tasks.get(pending); return t && t.status === 'completed' ? t : null; }, 8000);
check('clicking it completes the task in the local cache (status completed, end set)', !!row && typeof row.end === 'string' && row.end.length > 10, JSON.stringify(row && { status: row.status, end: row.end }));
// the default filter hides completed tasks: switch to the completed view and find the task again
const doneBtn = await waitFor(() => {
  const all = toggles();
  return all.find((b) => b.getAttribute('aria-pressed') === 'true') || null;
}, 8000) || await (async () => {
  const filter = Array.from(document.querySelectorAll('button, [role="tab"], option')).find((b) => /^(completed|done)$/i.test(b.textContent.trim()));
  if (filter) click(filter);
  return waitFor(() => toggles().find((b) => b.getAttribute('aria-pressed') === 'true') || null, 8000);
})();
check('the completed task\'s checkbox shows CheckCircle in green, reads "Mark as not done" and is pressed',
  !!doneBtn && /lucide-circle-check/.test(iconOf(doneBtn)) && /text-green-500/.test(iconOf(doneBtn)) && doneBtn.getAttribute('aria-label') === 'Mark as not done' && doneBtn.getAttribute('aria-pressed') === 'true',
  doneBtn ? `${iconOf(doneBtn)} ${doneBtn.getAttribute('aria-label')}` : `not found; toggles=${toggles().length} fetch=${fetchLog.slice(-3).join(',')}`);
const cliCalls = fetchLog.filter((l) => /taskwarrior/.test(l)).length;
check('the toggle also tried to sync the change to TaskWarrior (the CLI call, failing harmlessly without a backend)', cliCalls >= 1, fetchLog.join(','));

if (doneBtn) {
  click(doneBtn);
  const back = await waitFor(async () => { const t = await H.db.tasks.get(pending); return t && t.status === 'pending' ? t : null; }, 8000);
  check('clicking it again restores the task to pending (end cleared)', !!back && !back.end, JSON.stringify(back && { status: back.status, end: back.end }));
}
H.unmount();
await sleep(100);

/* ---------- 2. a read-only item ---------- */
let toggled = 0;
H.mount('item', { task: { id: 991, uuid: 'ro-1', description: 'Report row', status: 'pending', entry: now, modified: now }, isReadOnly: true, onToggleComplete: () => { toggled += 1; } });
let ro = await waitFor(() => document.querySelector('[data-testid="task-done-toggle"]'));
check('a read-only item still shows the Circle icon but its checkbox is disabled (no hover colour)',
  !!ro && ro.disabled && /lucide-circle\b/.test(iconOf(ro)) && !/hover:text-os-blue/.test(iconOf(ro)), ro ? `${ro.disabled} ${iconOf(ro)}` : 'none');
if (ro) click(ro);
await sleep(100);
check('clicking the disabled checkbox does nothing', toggled === 0, toggled);
H.unmount();
await sleep(50);

/* ---------- 3. an editable item calls back ---------- */
H.mount('item', { task: { id: 992, uuid: 'rw-1', description: 'Editable row', status: 'completed', entry: now, modified: now }, onToggleComplete: () => { toggled += 1; } });
const rw = await waitFor(() => document.querySelector('[data-testid="task-done-toggle"]'));
check('a completed editable item shows the green CheckCircle and is enabled', !!rw && !rw.disabled && /lucide-circle-check/.test(iconOf(rw)) && /text-green-500/.test(iconOf(rw)), rw ? iconOf(rw) : 'none');
if (rw) click(rw);
await sleep(50);
check('clicking it calls onToggleComplete once', toggled === 1, toggled);

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
