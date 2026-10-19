/**
 * Guards the Documents editor's /task slash command - the "Quick Tasks"
 * floating window (src/components/features/documents/QuickTasks.jsx, wired
 * into src/components/features/documents/DocumentEditor.jsx next to /ai and
 * /wf; pure form logic in src/utils/quickTasks.js).
 *
 * THE FEATURE: typing "/task" in the editor opens a popup with an Instance
 * dropdown (TaskWarrior instances - db.taskwarriorInstances, the ones the
 * Tasks page manages), task text, an optional Due date and priority. The
 * Due date field is the Tasks page's own DatePicker
 * (src/components/common/inputs/DatePicker.jsx) and is stored exactly as
 * TaskItem's due-date editor stores it ("YYYY-MM-DD" -> "YYYY-MM-DDT00:00:00Z").
 * The task is created "now" (entry/modified = now, no scheduled/wait dates)
 * through the Tasks page's own createTask() so the row carries every
 * default/indexed field (uuid, status, entry/modified, instanceId, tags,
 * project, ...) and is read back through that feature's normal list path
 * (getTasks / getInstanceTasks) - indistinguishable from a task added on
 * that page.
 *
 * What this proves, with the REAL DocumentEditor mounted in jsdom over a
 * fake IndexedDB (nothing touches the user's data or the network - fetch is
 * stubbed to fail so the best-effort TaskWarrior CLI push is a no-op):
 *   - the pure helpers: default-instance choice (popup's last-used key, then
 *     the Tasks page's key, then the active instance, then the first),
 *     the due-date conversion, validation rules, the created row;
 *   - "/task" opens the Quick Tasks window (and only at a word boundary,
 *     like /wf and /ai); "/wf" and "/ai" still open their own windows;
 *   - Esc closes it and leaves the document untouched;
 *   - the Instance dropdown lists every instance and preselects the active
 *     one on first use, the last-used one afterwards;
 *   - inline validation: empty text - no row is written;
 *   - the form has no start/end time inputs but a Due date DatePicker;
 *     Esc while its calendar is open closes only the calendar;
 *   - submitting creates the task in the CHOSEN instance with the given
 *     text/priority, `due` exactly as the Tasks page would store the picked
 *     day, entry set to "now" and no scheduled/wait, visible via getTasks()
 *     and getInstanceTasks(), with the store's defaults; leaving the due
 *     date empty stores no due; the popup closes, the
 *     "/task" token is removed from the document and nothing else is
 *     inserted; a success notification is recorded;
 *   - with no instances the window says so and the submit button is
 *     disabled;
 *   - source guards: the textarea placeholder advertises /task.
 *
 * Real rendering / contrast in both themes is covered by
 * tests/documents-quick-tasks-theme.test.mjs (headless Chrome).
 *
 * Run:  node tests/documents-quick-tasks.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('react-dom', 'Run: npm install');
requireResolvable('dexie', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-quick-tasks-'));

let exitCode = 1;
try {
  // =====================================================================
  // Section 1: pure helpers (plain ESM, no DOM needed)
  // =====================================================================
  {
    const H = await import(path.join(REPO, 'src', 'utils', 'quickTasks.js'));
    const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
    const instances = [
      { id: 7, name: 'Alpha', isActive: 0 },
      { id: 3, name: 'Beta', isActive: 1 },
      { id: 9, name: 'Gamma', isActive: 0 },
    ];
    check('section 1: default instance is the active one when nothing is stored', H.pickDefaultInstanceId(instances, mem()) === 3);
    check('section 1: default instance falls back to the first one when none is active',
      H.pickDefaultInstanceId(instances.map((i) => ({ ...i, isActive: 0 })), mem()) === 7);
    let s = mem(); s.setItem(H.TASKS_PAGE_INSTANCE_KEY, JSON.stringify(9));
    check('section 1: the instance open on the Tasks page (currentTaskInstanceId, JSON) wins over the active one', H.pickDefaultInstanceId(instances, s) === 9);
    s.setItem(H.QUICK_TASK_LAST_INSTANCE_KEY, JSON.stringify(7));
    check('section 1: the popup\'s own last-used instance wins over the Tasks page one', H.pickDefaultInstanceId(instances, s) === 7);
    s = mem(); s.setItem(H.QUICK_TASK_LAST_INSTANCE_KEY, JSON.stringify(42));
    check('section 1: a stored id that no longer exists is ignored', H.pickDefaultInstanceId(instances, s) === 3);
    s = mem(); s.setItem(H.QUICK_TASK_LAST_INSTANCE_KEY, '{not json');
    check('section 1: a corrupt stored value is ignored', H.pickDefaultInstanceId(instances, s) === 3);
    check('section 1: no instances -> null', H.pickDefaultInstanceId([], mem()) === null && H.pickDefaultInstanceId(null, mem()) === null);

    check('section 1: no start/end time helpers are exported any more (task is created "now")', !('localDateTimeToIso' in H));
    check('section 1: due date is stored exactly like TaskItem stores it ("YYYY-MM-DD" -> "YYYY-MM-DDT00:00:00Z")',
      H.dueDateToStored('2026-10-15') === '2026-10-15T00:00:00Z');
    check('section 1: empty / malformed due -> null', H.dueDateToStored('') === null && H.dueDateToStored(null) === null && H.dueDateToStored('2026-10-15T10:00') === null && H.dueDateToStored('nope') === null);

    const v = (form) => H.validateQuickTask({ instanceId: 1, ...form });
    check('section 1: validation - text required', v({ description: '   ' }).description === 'Task text is required' && !v({ description: 'x' }).description);
    check('section 1: validation - instance required', H.validateQuickTask({ description: 'x', instanceId: null }).instance && H.validateQuickTask({ description: 'x', instanceId: '' }).instance);
    check('section 1: validation - text + instance is all it takes (due optional)', Object.keys(v({ description: 'x' })).length === 0 && Object.keys(v({ description: 'x', due: '2026-10-15' })).length === 0);
    check('section 1: validation - malformed due flagged, no start/end comparison exists', !!v({ description: 'x', due: 'bad' }).due && !v({ description: 'x', start: 'a', end: 'b' }).end);

    const now = new Date('2026-09-29T12:00:00.000Z');
    const row = H.buildQuickTask({ description: '  Rotate certs  ', due: '2026-10-15', priority: 'H', instanceId: 3 }, now);
    check('section 1: built row - description trimmed, pending, instanceId, priority, due as the Tasks page stores it, entry/modified = now',
      row.description === 'Rotate certs' && row.status === 'pending' && row.instanceId === 3 && row.priority === 'H'
      && row.due === '2026-10-15T00:00:00Z' && row.entry === now.toISOString() && row.modified === now.toISOString(), JSON.stringify(row));
    check('section 1: built row never sets scheduled/wait/until/start/end (left to createTask defaults)',
      ['scheduled', 'wait', 'until', 'start', 'end'].every((k) => !(k in row)));
    const bare = H.buildQuickTask({ description: 'x', instanceId: 1, priority: 'ZZ' }, now);
    check('section 1: built row - no due -> null, unknown priority -> default (none, like the Tasks page)',
      bare.due === null && bare.priority === H.QUICK_TASK_DEFAULT_PRIORITY && H.QUICK_TASK_DEFAULT_PRIORITY === '');
    check('section 1: priority options are TaskWarrior\'s L/M/H plus none', JSON.stringify(H.QUICK_TASK_PRIORITIES.map((p) => p.value)) === JSON.stringify(['', 'L', 'M', 'H']));
  }

  // =====================================================================
  // Section 2: source guards
  // =====================================================================
  const editorSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
  check('section 2: the editor placeholder advertises the "/" commands (callouts, Quick Workflow, Quick AI, Quick Task)', /\/ for commands and templates \(callouts, Quick Workflow, Quick AI, Quick Task\)/.test(editorSrc));
  check('section 2: DocumentEditor imports and renders QuickTasks', /import QuickTasks from '\.\/QuickTasks'/.test(editorSrc) && /<QuickTasks\b/.test(editorSrc));
  const popupSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'QuickTasks.jsx'), 'utf8');
  check('section 2: QuickTasks creates through the Tasks page\'s createTask helper', /import \{ createTask, syncToTaskWarrior \} from '\.\.\/\.\.\/\.\.\/utils\/tasks'/.test(popupSrc));
  check('section 2: QuickTasks has no native date/time inputs and never writes scheduled', !/datetime-local|type="date"|type="time"|scheduled/.test(popupSrc));
  check('section 2: QuickTasks reuses the Tasks page\'s DatePicker component', /import DatePicker from '\.\.\/\.\.\/common\/inputs\/DatePicker'/.test(popupSrc) && /<DatePicker\b/.test(popupSrc)
    && /import DatePicker from '\.\.\/common\/inputs\/DatePicker'/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'tasks', 'TaskItem.jsx'), 'utf8')));
  check('section 2: QuickTasks uses no hard-coded colours', !/#[0-9a-fA-F]{3,8}\b/.test(popupSrc.replace(/\/\*[\s\S]*?\*\//g, '')) && !/rgba?\(/.test(popupSrc));

  // =====================================================================
  // Section 3: the real editor in jsdom
  // =====================================================================
  const ENTRY = path.join(WORKDIR, 'entry.jsx');
  fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { BUILTIN_COMMANDS } from '@worktree/src/utils/slashCommands.js';
import { NotificationProvider, useNotifications } from '@worktree/src/contexts/NotificationContext.jsx';
import { db } from '@worktree/src/db/database.js';
import { getTasks } from '@worktree/src/utils/tasks.js';
import { getAllInstances, getInstanceTasks, createInstance } from '@worktree/src/utils/taskwarriorInstances.js';

const api = { getTasks, getAllInstances, getInstanceTasks, createInstance, db, history: [] };
let setContentExternal = null;

function Probe() {
  const { history } = useNotifications();
  api.history = history;
  return null;
}

function Host() {
  const [content, setContent] = React.useState('');
  setContentExternal = setContent;
  api.getContent = () => content;
  return React.createElement(DocumentEditor, {
    documentId: 1,
    document: { id: 1, title: 'Notes', inCloud: false },
    content,
    onContentChange: (e) => setContent(e.target.value),
    templates: BUILTIN_COMMANDS, // as the Documents page hands them in: the built-in "/" commands, then its templates
    locked: false,
    isOnline: true,
  });
}

api.setContent = (v) => setContentExternal && setContentExternal(v);
window.__harness = api;
createRoot(document.getElementById('root')).render(
  React.createElement(NotificationProvider, null, React.createElement(Probe), React.createElement(Host))
);
`);

  const { build } = await import(req.resolve('esbuild'));
  const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
  await build({
    entryPoints: [ENTRY],
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
        b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
        b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          try { return { path: req.resolve(args.path) }; } catch { return null; }
        });
      },
    }],
    logLevel: 'warning',
  });

  // ---------- jsdom + fake IndexedDB (same bootstrap as tests/helpers/run-client.mjs) ----------
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
  // No backend in this test: the popup's best-effort TaskWarrior CLI push must fail fast and harmlessly
  let fetchCalls = 0;
  const failingFetch = () => { fetchCalls++; return Promise.reject(new Error('no backend in test')); };
  define('fetch', failingFetch); window.fetch = failingFetch;
  // Silence the app's chatty console.log/error without hiding test output
  const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
  const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error/.test(s)) return; fn(...a); };
  console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

  createRequire(import.meta.url)(BUNDLE);
  const { document } = window;
  const H = window.__harness;
  const textarea = await waitFor(() => document.querySelector('textarea'));
  check('section 3: the real DocumentEditor mounted in jsdom', !!textarea);

  const setNative = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  };
  // Real typing shape: value spliced at the caret, caret advanced, input event -> React onChange
  const typeAtEnd = (text) => {
    const ta = document.querySelector('textarea');
    setNative(ta, ta.value + text);
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const setInput = (el, value) => { setNative(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const setSelect = (el, value) => { setNative(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const popup = () => document.querySelector('[data-testid="quick-tasks-popup"]');
  // the "/" popup: typing opens it with the command highlighted; Enter runs the command (nothing runs on typing alone)
  const slashPopup = () => Array.from(document.querySelectorAll('span')).find((s) => /Commands and templates/.test(s.textContent))?.closest('.fixed') || null;
  const pressEnter = () => document.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  // "/task", then Enter on the Quick Task entry the popup offers: the window opens (typing alone opens nothing)
  const openQuickTasks = async () => {
    typeAtEnd('/task');
    await waitFor(() => { const sp = slashPopup(); return sp && sp.querySelector('[data-slash-entry="quick-task"]') ? sp : null; });
    pressEnter();
    return waitFor(popup);
  };
  const alerts = () => Array.from(popup()?.querySelectorAll('[role="alert"]') || []).map((e) => e.textContent.trim());
  const resetDoc = async (text) => {
    H.setContent(text);
    await waitFor(() => document.querySelector('textarea').value === text);
  };
  const submitBtn = () => popup()?.querySelector('[data-testid="quick-tasks-submit"]');
  const instanceSelect = () => popup()?.querySelector('#quick-task-instance');
  const options = () => Array.from(instanceSelect()?.options || []).filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.textContent }));

  // Two synthetic instances - Alpha is the active one (Tasks page's notion)
  const alpha = await H.createInstance({ name: 'Alpha Lab', category: 'General', isActive: 1 });
  const beta = await H.createInstance({ name: 'Beta Lab', category: 'Ops', isActive: 0 });
  check('section 3: two synthetic instances seeded', (await H.getAllInstances()).length === 2);

  // ---- /task + Enter opens Quick Tasks ----
  await resetDoc('Notes\n');
  typeAtEnd('/task');
  const offered = await waitFor(() => { const sp = slashPopup(); return sp && sp.querySelector('[data-slash-entry="quick-task"]') ? sp : null; });
  check('section 3: typing "/task" offers Quick Task in the "/" popup and opens nothing yet', !!offered && !popup(), JSON.stringify({ offered: !!offered, window: !!popup(), entries: Array.from(document.querySelectorAll('[data-slash-entry]')).map((e) => e.getAttribute('data-slash-entry')) }));
  pressEnter();
  let p = await waitFor(popup);
  check('section 3: Enter on the Quick Task entry opens the Quick Tasks window', !!p && /Quick Tasks/.test(p.textContent) && !slashPopup());
  const dueField = () => popup()?.querySelector('[data-testid="quick-task-due"]');
  const dueButton = () => dueField()?.querySelector('button');
  const calendar = () => dueField()?.querySelector('.fixed');
  check('section 3: fields in order: Instance, task text, Due date (DatePicker button), Priority - no start/end/native time inputs',
    !!p && (() => {
      const ids = Array.from(p.querySelectorAll('select, input')).map((e) => e.id);
      const order = Array.from(p.querySelectorAll('#quick-task-instance, #quick-task-description, [data-testid="quick-task-due"], #quick-task-priority')).map((e) => e.id || e.dataset.testid);
      return JSON.stringify(ids) === JSON.stringify(['quick-task-instance', 'quick-task-description', 'quick-task-priority'])
        && JSON.stringify(order) === JSON.stringify(['quick-task-instance', 'quick-task-description', 'quick-task-due', 'quick-task-priority'])
        && p.querySelectorAll('input[type="datetime-local"], input[type="date"], input[type="time"], #quick-task-start, #quick-task-end').length === 0
        && !!dueButton() && /No due date/.test(dueButton().textContent);
    })(), p ? Array.from(p.querySelectorAll('select, input, button')).map((e) => e.id || e.textContent.trim()).join(',') : 'no popup');
  await waitFor(() => options().length === 2);
  check('section 3: the Instance dropdown lists every instance with its category', JSON.stringify(options()) === JSON.stringify([
    { value: String(alpha.id), label: 'Alpha Lab (General)' }, { value: String(beta.id), label: 'Beta Lab (Ops)' }]), JSON.stringify(options()));
  check('section 3: the active instance is preselected on first use', instanceSelect().value === String(alpha.id));
  check('section 3: priority defaults to none', p.querySelector('#quick-task-priority').value === '');
  check('section 3: the task text input gets focus', await waitFor(() => document.activeElement && document.activeElement.id === 'quick-task-description'));

  // ---- Esc closes, document untouched ----
  p.querySelector('#quick-task-description').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('section 3: Esc closes the window', await waitFor(() => !popup()));
  check('section 3: cancelling leaves the document as typed (the "/task" stays, like /wf and /ai)', document.querySelector('textarea').value === 'Notes\n/task');
  check('section 3: cancelling creates nothing', (await H.getTasks()).length === 0);

  // ---- /task only at a word boundary ----
  await resetDoc('path');
  typeAtEnd('/task');
  await sleep(150);
  pressEnter();
  await sleep(150);
  check('section 3: "path/task" (no word boundary) offers nothing and opens nothing (Enter runs no command)', !popup() && !slashPopup() && /^path\/task/.test(document.querySelector('textarea').value), document.querySelector('textarea').value);

  // ---- /wf and /ai still work (through the popup, with Enter) ----
  await resetDoc('Notes\n');
  typeAtEnd('/wf');
  await waitFor(() => slashPopup());
  pressEnter();
  const wf = await waitFor(() => Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Quick Workflow' && !s.closest('[data-slash-entry]')));
  check('section 3: "/wf" + Enter still opens Quick Workflow', !!wf && !popup());
  if (wf) { wf.closest('.drag-handle').querySelector('button').click(); }
  await waitFor(() => !Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'Quick Workflow'));
  await resetDoc('Notes\n');
  typeAtEnd('/ai');
  await waitFor(() => slashPopup());
  pressEnter();
  const ai = await waitFor(() => Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Quick AI' && !s.closest('[data-slash-entry]')));
  check('section 3: "/ai" + Enter still opens Quick AI', !!ai && !popup());
  if (ai) {
    const input = ai.closest('.fixed').querySelector('input');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  check('section 3: Quick AI closed again', await waitFor(() => !Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'Quick AI')));

  // ---- validation ----
  await resetDoc('Notes\n');
  p = await openQuickTasks();
  await waitFor(() => options().length === 2);
  submitBtn().click();
  check('section 3: submitting without text shows an inline error', await waitFor(() => alerts().includes('Task text is required')), alerts().join(' | '));
  check('section 3: ... and writes nothing', (await H.getTasks()).length === 0 && !!popup());
  setInput(p.querySelector('#quick-task-description'), 'Rotate the lab certificates');
  check('section 3: typing text clears nothing prematurely - still no row', (await H.getTasks()).length === 0);

  // ---- due date via the Tasks page's DatePicker ----
  dueButton().click();
  check('section 3: clicking the Due date field opens the DatePicker calendar inside the window', !!(await waitFor(calendar)));
  p.querySelector('#quick-task-description').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('section 3: Esc with the calendar open closes only the calendar, the window stays', await waitFor(() => !calendar()) && !!popup());
  dueButton().click();
  await waitFor(calendar);
  // Pick the 15th of the month the calendar opened on (today's month): a
  // current-month day button, i.e. not one of the dimmed neighbour-month days
  const viewNow = new Date();
  const day15 = Array.from(calendar().querySelectorAll('button')).find((b) => b.textContent.trim() === '15' && !b.className.includes('opacity-40'));
  check('section 3: the calendar shows the current month with a selectable 15th', !!day15);
  day15.click();
  const expectedDue = `${viewNow.getFullYear()}-${String(viewNow.getMonth() + 1).padStart(2, '0')}-15`;
  check('section 3: picking a day closes the calendar and shows the date on the field',
    await waitFor(() => !calendar()) && dueButton().textContent.includes(new Date(expectedDue + 'T00:00:00').toLocaleDateString()), dueButton().textContent);

  // ---- create in the chosen (non-default) instance ----
  const before = Date.now();
  setSelect(instanceSelect(), String(beta.id));
  setSelect(p.querySelector('#quick-task-priority'), 'H');
  check('section 3: chose the Beta instance and High priority', instanceSelect().value === String(beta.id) && p.querySelector('#quick-task-priority').value === 'H');
  submitBtn().click();
  check('section 3: the window closes after a successful create', await waitFor(() => !popup()));
  const betaTasks = await waitFor(async () => { const t = await H.getInstanceTasks(beta.id); return t.length ? t : null; });
  check('section 3: exactly one task in the chosen instance (getInstanceTasks - the Tasks page read path)', Array.isArray(betaTasks) && betaTasks.length === 1);
  check('section 3: none in the other instance', (await H.getInstanceTasks(alpha.id)).length === 0);
  const t = betaTasks && betaTasks[0];
  check('section 3: text / priority as entered', !!t && t.description === 'Rotate the lab certificates' && t.priority === 'H', JSON.stringify(t));
  check('section 3: created "now": entry and modified are within a few seconds of the click',
    !!t && Math.abs(Date.parse(t.entry) - before) < 10000 && Math.abs(Date.parse(t.modified) - before) < 10000, t && `${t.entry} vs ${new Date(before).toISOString()}`);
  check('section 3: due stored exactly as the Tasks page stores a picked due date ("YYYY-MM-DDT00:00:00Z")',
    !!t && t.due === `${expectedDue}T00:00:00Z`, t && t.due);
  check('section 3: no other dates - scheduled/wait/until/start/end are null, like a task added on the Tasks page',
    !!t && ['scheduled', 'wait', 'until', 'start', 'end'].every((k) => t[k] === null), t && JSON.stringify(t));
  check('section 3: row carries the store defaults (uuid, pending, instanceId, tags/project/annotations/depends, recur)',
    !!t && typeof t.uuid === 'string' && t.uuid.length >= 32 && t.status === 'pending' && t.instanceId === beta.id
    && Array.isArray(t.tags) && t.project === '' && Array.isArray(t.annotations) && Array.isArray(t.depends)
    && t.recur === null && typeof t.id === 'number', t && JSON.stringify(Object.keys(t)));
  const all = await H.getTasks();
  check('section 3: getTasks() (the Tasks page list) returns it, filterable by instanceId like TasksPage.loadTasks does',
    all.length === 1 && all.filter((x) => x.instanceId === beta.id).length === 1);
  check('section 3: "/task" was removed from the document and nothing was inserted', await waitFor(() => document.querySelector('textarea').value === 'Notes\n'), JSON.stringify(document.querySelector('textarea').value));
  check('section 3: a success notification was recorded (the app\'s usual feedback)',
    await waitFor(() => H.history.some((n) => n.type === 'success' && n.title === 'Task created' && /Rotate the lab certificates/.test(n.message) && /Beta Lab/.test(n.message))),
    JSON.stringify(H.history.map((n) => [n.type, n.title, n.message])));
  check('section 3: the best-effort TaskWarrior CLI push was attempted and failed harmlessly (no backend)', await waitFor(() => fetchCalls > 0) && (await H.getTasks()).length === 1);
  check('section 3: the chosen instance is remembered for next time', window.localStorage.getItem('quickTasksLastInstanceId') === JSON.stringify(beta.id));

  // ---- last-used instance preselected on reopen ----
  p = await openQuickTasks();
  await waitFor(() => options().length === 2 && instanceSelect().value === String(beta.id));
  check('section 3: reopening preselects the last-used instance', instanceSelect().value === String(beta.id));
  check('section 3: reopening starts from a clean form (no due date)', p.querySelector('#quick-task-description').value === '' && p.querySelector('#quick-task-priority').value === '' && /No due date/.test(dueButton().textContent));
  // Backdrop click closes like /wf and /ai
  p.previousElementSibling.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('section 3: clicking the backdrop closes the window', await waitFor(() => !popup()));

  // ---- Enter in the text field submits ----
  await resetDoc('Notes\n');
  p = await openQuickTasks();
  await waitFor(() => options().length === 2);
  setInput(p.querySelector('#quick-task-description'), 'Check the backups');
  p.querySelector('#quick-task-description').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('section 3: Enter in the text field creates the task', await waitFor(() => !popup()) && await waitFor(async () => (await H.getTasks()).length === 2));
  const t2 = (await H.getTasks()).find((x) => x.description === 'Check the backups');
  check('section 3: leaving the due date empty stores no due (null), no priority, last-used instance', !!t2 && t2.scheduled === null && t2.due === null && t2.priority === '' && t2.instanceId === beta.id, t2 && JSON.stringify(t2));

  // ---- no instances ----
  await H.db.taskwarriorInstances.clear();
  await resetDoc('Notes\n');
  p = await openQuickTasks();
  check('section 3: with no instances the window explains it and disables submit',
    !!(await waitFor(() => p.querySelector('[data-testid="quick-tasks-no-instances"]'))) && submitBtn().disabled && instanceSelect().disabled,
    p ? p.textContent.slice(0, 200) : 'no popup');
  submitBtn().click();
  await sleep(100);
  check('section 3: ... and nothing can be created', (await H.getTasks()).length === 2 && !!popup());
  p.querySelector('#quick-task-description').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('section 3: Esc still closes it', await waitFor(() => !popup()));

  console.log = origLog; console.error = origErr; console.warn = origWarn;
  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (err) {
  // an exception is a failure of the run, counted and shown like a failed check
  console.error('UNEXPECTED ERROR:', err && err.stack || err);
  results.push({ name: `UNEXPECTED ERROR: ${err && err.message || err}`, pass: false });
  exitCode = 1;
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(exitCode);
