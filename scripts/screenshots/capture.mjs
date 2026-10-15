#!/usr/bin/env node
/**
 * Marketing screenshots of the app with synthetic content (scripts/screenshots/content.mjs).
 *
 *   node scripts/screenshots/capture.mjs [--out <dir>] [--theme dark|neutral|light|all] [--contrast neutral|light|dark|none]
 *                                        [--only a,b,c] [--phone|--no-phone] [--backend-port <n>] [--keep]
 *
 * What it runs (and stops again): the Flask backend in accounts mode with a
 * throwaway HOME (scratch accounts database, reports root, Taskwarrior data),
 * the Vite dev server and headless Chrome with a throwaway profile - through
 * tests/helpers/live-documents-app.mjs, the same driver the live tests use.
 * The owner's real data is never read: no ~/.jacarium.env, no ~/.task, no
 * app profile. The AI chat shows a stored conversation; no provider is called
 * (the models list is stubbed in the page). Google Calendar is never contacted
 * (the auth status is stubbed so the week shows the cached, seeded events).
 *
 * See README.md next to this file for prerequisites and the shot list.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, REPO, sleep } from '../../tests/helpers/live-documents-app.mjs';
import { dismissWhatsNew } from '../../tests/helpers/visual-snapshots.mjs';
import * as C from './content.mjs';

// ---- arguments ----
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(name);
if (flag('--help') || flag('-h')) {
  console.log(`usage: node scripts/screenshots/capture.mjs [--out <dir>] [--theme dark|neutral|light|all] [--contrast <t>] [--only <ids>] [--phone|--no-phone] [--keep]

  --out <dir>      output directory (default ~/Desktop/jacarium-screenshots)
  --theme <t>      dark (Jacaranda, default), neutral (Dark neutral), light, or all;
                   files of a non-default theme get a -neutral / -light suffix
  --contrast <t>   one extra Documents shot in this theme for contrast (default neutral; none to skip)
  --only <ids>     comma-separated shot ids to capture (see README.md); default: all
  --phone          only the phone shots;  --no-phone: skip them
  --backend-port   port for the scratch backend (default 8080, or the next free one when that is taken)
  --keep           leave the servers and Chrome running afterwards (debugging)
`);
  process.exit(0);
}
const OUT = path.resolve(opt('--out', path.join(os.homedir(), 'Desktop', 'jacarium-screenshots')));
const THEME_NAMES = ['dark', 'neutral', 'light'];
const THEMES = { dark: ['dark'], neutral: ['neutral'], light: ['light'], all: THEME_NAMES }[opt('--theme', 'dark')];
if (!THEMES) { console.error('--theme must be dark, neutral, light or all'); process.exit(2); }
const CONTRAST = opt('--contrast', 'neutral');
if (![...THEME_NAMES, 'none'].includes(CONTRAST)) { console.error('--contrast must be dark, neutral, light or none'); process.exit(2); }
const suffix = (theme) => (theme === 'dark' ? '' : `-${theme}`);
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',').map((s) => s.trim())) : null;
const PHONE_ONLY = flag('--phone');
const NO_PHONE = flag('--no-phone');
const KEEP = flag('--keep');

const portFree = (port) => new Promise((resolve) => { const srv = createServer(); srv.once('error', () => resolve(false)); srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true))); });
// Vite must be on 5173 (the backend's CORS allow-list); the scratch backend
// takes 8080 unless something else (the desktop app, say) holds it.
const VITE_PORT = 5173;
if (!(await portFree(VITE_PORT))) { console.error(`port ${VITE_PORT} is busy (a dev server running?) - stop it and rerun`); process.exit(1); }
let FLASK_PORT = Number(opt('--backend-port', 8080));
if (!flag('--backend-port')) { while (!(await portFree(FLASK_PORT))) FLASK_PORT++; }
else if (!(await portFree(FLASK_PORT))) { console.error(`port ${FLASK_PORT} is busy`); process.exit(1); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const MOCK = path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'out', 'sosreport-web-01-2026-10-13-abcdef');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!fs.existsSync(PYTHON)) { console.error('backend/venv missing - see docs/DEVELOPMENT.md (Python dependencies)'); process.exit(1); }
if (!fs.existsSync(MOCK)) { console.error(`diagnostics mock missing - run: python3 tests/fixtures/diagnostics-mock/generate.py`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// ---- scratch data + backend (accounts mode, throwaway HOME) ----
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-shots-'));
const REPORTS = path.join(DATA, 'reports');
fs.mkdirSync(REPORTS, { recursive: true });
fs.cpSync(MOCK, path.join(REPORTS, path.basename(MOCK)), { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_')));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...env, HOME: DATA, PORT: String(FLASK_PORT), FLASK_DEBUG: '0', JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: REPORTS, JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } };
if (!up) { console.error('the backend did not start (port 8080 busy?)\n' + backendLog.slice(-1500)); stopBackend(); process.exit(1); }
const setupCode = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
log(`backend up on :${FLASK_PORT}; scratch data in`, DATA);

const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'jacarium-shots-' });
if (app.skip) { console.error(app.skip); stopBackend(); process.exit(1); }

// ---- page helpers ----
const ev = (s) => app.evaluate(s);
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };
const PHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
const metrics = async (m) => { await app.send('Emulation.setDeviceMetricsOverride', m); await sleep(400); };
// No motion, no caret, no scrollbars; the sidebar headers' central-server
// indicator (a red dot while no central server is linked) is hidden.
const stabilize = () => ev(`(() => { if (document.getElementById('__shots')) return; const s = document.createElement('style'); s.id = '__shots'; s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; } ::-webkit-scrollbar { display: none; } .w-2.h-2.rounded-full.bg-red-500 { display: none; }'; document.head.appendChild(s); })()`);
const tidy = () => ev(`(() => { for (const el of document.querySelectorAll('[role="alert"]')) el.remove(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); })()`);
const files = [];
async function shot(name) {
  await stabilize();
  await tidy();
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 898 });
  await sleep(300);
  const r = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f = path.join(OUT, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  files.push(f);
  log('shot', name);
}
const clickNav = async (label) => { const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('nav button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`); if (!ok) throw new Error('no nav item ' + label); await sleep(2500); };
const clickTitled = (title) => ev(`(() => { const b = document.querySelector('button[title=${JSON.stringify(title)}]'); if (!b) return false; b.click(); return true; })()`);
const reload = async (ms = 7000) => { await app.send('Page.reload'); await sleep(ms); await stabilize(); await dismissWhatsNew(app); await app.waitFor(`!!document.querySelector('nav button') || !!document.querySelector('[data-testid="brand-hero"]')`, 20000); };
const api = (p, body, method = 'POST') => ev(`fetch('http://localhost:${FLASK_PORT}${p}', { method: ${JSON.stringify(method)}, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`);
const setInput = (label, value) => ev(`(() => { const lab = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)})); const input = lab ? (lab.control || lab.parentElement.querySelector('input')) : null; if (!input) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); return true; })()`);
const escape = async () => { await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(400); };
// 'dark' is the Jacaranda theme (app-theme 'dark'), 'neutral' the grey dark
// (app-theme 'dark-neutral': .dark plus data-dark-variant="neutral"), 'light' the light one.
const setTheme = async (theme) => {
  const isDark = theme !== 'light';
  await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: isDark ? 'dark' : 'light' }] });
  await ev(`localStorage.setItem('app-theme', ${JSON.stringify(theme === 'neutral' ? 'dark-neutral' : theme)}); document.documentElement.classList.${isDark ? 'add' : 'remove'}('dark'); document.documentElement.${theme === 'neutral' ? "setAttribute('data-dark-variant', 'neutral')" : "removeAttribute('data-dark-variant')"}`);
  await sleep(400);
};
// Preview on (the toolbar button cycles OFF -> Preview -> Preview (all) -> OFF).
const preview = async () => { const t = await ev(`(document.querySelector('button[title="Preview"], button[title="Edit"], button[title^="Preview (all documents)"]') || {}).title`); if (t === 'Preview') { await clickTitled('Preview'); await sleep(1500); } };
const openDocRow = async (title) => { const ok = await ev(`(() => { const rows = Array.from(document.querySelectorAll('.sc-row')).filter((r) => r.getBoundingClientRect().left < 400 && r.textContent.includes(${JSON.stringify(title)})); if (!rows.length) return false; rows[0].click(); return true; })()`); if (!ok) throw new Error('no document row ' + title); await sleep(1500); };
// Requests the page makes that must never reach a real service: the AI
// model list (so the stored conversation shows), the Google Calendar auth
// status (so the week view shows the cached events without the set-up
// banner) and the calendar sync that would follow (fails quietly).
// The Log Viewer tab lives in an opaque-origin srcdoc frame (sandbox="allow-scripts"),
// out of reach of the parent page and of a plain CDP session, so its "Load Logs"
// button is pressed by a script appended to that frame's own srcdoc while
// window.__shotsAutoLoadLogs is set.
const STUBS = `(() => {
  globalThis.__JACARIUM_BACKEND_URL = ${JSON.stringify(`http://localhost:${FLASK_PORT}`)};
  const AUTO = '<script>window.addEventListener("load", () => setTimeout(() => { const b = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.trim() === "Load Logs"); if (b) b.click(); }, 1500));<\\/script>';
  const inject = (v) => (window.__shotsAutoLoadLogs && typeof v === 'string' && v.includes('Load Logs')) ? v + AUTO : v;
  const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
  Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { get: desc.get, set(v) { desc.set.call(this, inject(v)); }, configurable: true });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) { return setAttribute.call(this, name, (this instanceof HTMLIFrameElement && String(name).toLowerCase() === 'srcdoc') ? inject(value) : value); };
  const orig = window.fetch;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/\\/api\\/ai\\/models(\\?|$)/.test(url)) return json({ anthropic: [], openai: [], gemini: [], ollama: ['llama3.1:8b'], ssh: [] });
    if (/\\/api\\/calendar\\/auth-status(\\?|$)/.test(url)) return json({ reachable: true, configured: true, authenticated: true });
    if (/\\/api\\/calendar\\/sync(\\?|$)/.test(url)) throw new TypeError('calendar sync is stubbed in screenshots');
    return orig(input, init);
  };
})()`;

// index.md rows: file stem (without a theme suffix) -> [feature, caption suggestion]
const CAPTIONS = {
  '01-documents': ['Documents - preview with categories and tabs', 'Runbooks, incident reviews and checklists side by side - Markdown with code, tables and checklists, organised the way your team works.'],
  '02-documents-editor': ['Documents - Markdown editor', 'Write in plain Markdown with line numbers and a formatting toolbar; preview is one click away.'],
  '02-documents-split': ['Documents - split view', 'Source on the left, a rendered document on the right: two panes, each with its own preview.'],
  '03-documents-mermaid': ['Documents - Mermaid diagrams', 'Describe an architecture in a Mermaid fence and see the diagram rendered in the document.'],
  '04-kanban': ['Kanban boards', 'Plan the quarter on a board: tags, priorities, assignees and due dates on every card.'],
  '05-tasks': ['Tasks (Taskwarrior)', 'Your Taskwarrior tasks with projects, priorities, due dates and urgency - start a timer, annotate, filter.'],
  '06-workflow-builder': ['Workflow Builder', 'Wire up checks and notifications on a canvas: HTTP requests, comparisons, branches and results.'],
  '07-robin-chat': ['Robin AI chat', 'Ask Robin about a stuck rollout and get commands you can paste - with the provider you choose, including local models.'],
  '08-diagnostics-processes': ['Diagnostics - Processes', 'Open a sosreport and read it as charts: process states, top CPU and memory consumers.'],
  '08-diagnostics-log-viewer': ['Diagnostics - Log Viewer', 'Thousands of journal lines, counted by process and severity, filtered by date, level and text.'],
  '09-calendar-week': ['Calendars - week view', 'Your calendars next to your work: a week of stand-ups, reviews and maintenance windows.'],
  '10-settings-about': ['Settings - About', 'Jacarium: everything you know and use for technical work, in one place.'],
  '11-sign-in': ['Sign-in page (browser build)', 'Run it on your own server: every teammate signs in to their own documents, tasks and settings.'],
  '12-whats-new': ["What's New", 'Every release explained in the app, grouped by what changed.'],
  'phone-sign-in': ['Sign-in page at phone width', 'The same server, from your phone.'],
  'phone-documents': ['Documents at phone width', 'Read a runbook on the go.'],
  'phone-kanban': ['Kanban at phone width', 'The board, one column at a time.'],
};
function writeIndex() {
  const rows = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort().map((f) => {
    const stem = f.replace(/\.png$/, '');
    const base = stem.replace(/-(light|neutral)$/, '');
    const [feature, caption] = CAPTIONS[base] || ['', ''];
    const theme = /-light$/.test(stem) ? 'light' : /-neutral$/.test(stem) ? 'Dark (neutral)' : 'Jacaranda dark';
    const size = /^phone-/.test(stem) ? '393x852 @3x' : '1440x900 @2x';
    return `| \`${f}\` | ${feature}${feature ? ' (' + theme + ', ' + size + ')' : ''} | ${caption} |`;
  });
  const text = `# Jacarium screenshots\n\nGenerated by \`node scripts/screenshots/capture.mjs\` (synthetic content, see scripts/screenshots/README.md).\n\n| File | Feature | Caption suggestion |\n|------|---------|--------------------|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'index.md'), text);
}

const wanted = (id, phone = false) => (!ONLY || ONLY.has(id)) && (phone ? !NO_PHONE : !PHONE_ONLY);
let userId = null;
try {
  await app.send('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });
  await metrics(DESKTOP);
  await stabilize();

  // ---- the throwaway administrator ----
  await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]')`, 20000);
  const created = await api('/api/auth/setup', { setupCode, username: C.ACCOUNT.username, password: C.ACCOUNT.password, displayName: C.ACCOUNT.displayName });
  if (created.status !== 201) throw new Error('account setup failed: ' + JSON.stringify(created));
  userId = created.json.user.id;

  // ---- sign-in page (signed out) ----
  if (wanted('sign-in') || wanted('phone-sign-in', true)) {
    await api('/api/auth/logout');
    await reload(5000);
    await app.waitFor(`/Sign in to Jacarium/.test(document.body.textContent)`, 15000);
    await setInput('Username', C.ACCOUNT.username);
    await setInput('Password', C.ACCOUNT.password);
    for (const theme of THEMES) {
      const sfx = suffix(theme);
      await setTheme(theme);
      if (wanted('sign-in')) await shot(`11-sign-in${sfx}`);
      if (wanted('phone-sign-in', true)) { await metrics(PHONE); await sleep(400); await shot(`phone-sign-in${sfx}`); await metrics(DESKTOP); }
    }
  }

  // ---- sign in and seed ----
  const signedIn = await api('/api/auth/login', { username: C.ACCOUNT.username, password: C.ACCOUNT.password });
  if (signedIn.status !== 200) throw new Error('sign-in failed');
  await ev(`localStorage.setItem('app-theme', 'dark'); localStorage.setItem('whatsNewLastSeen', ${JSON.stringify(pkg.version)});`);
  await reload();

  // Taskwarrior: the account's own ~/.task under the scratch HOME
  const home = path.join(DATA, 'users', String(userId));
  fs.mkdirSync(path.join(home, '.task'), { recursive: true });
  fs.writeFileSync(path.join(home, '.taskrc'), `# Jacarium - Taskwarrior configuration (this account)\ndata.location=${path.join(home, '.task')}\nconfirmation=off\n`);
  const task = (...a) => new Promise((res) => { const r = spawn('task', a, { env: { ...env, HOME: home, TASKRC: path.join(home, '.taskrc'), TASKDATA: path.join(home, '.task') }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; r.stdout.on('data', (d) => { out += d; }); r.stderr.on('data', (d) => { out += d; }); r.on('error', () => res({ code: -1, out: 'task not found' })); r.on('exit', (code) => res({ code, out })); });
  for (const t of C.TASKS) { const r = await task('add', ...t); if (r.code !== 0) log('task add failed:', r.out.trim().slice(0, 200)); }
  for (const [n, ...a] of C.TASK_ACTIONS) await task(String(n), ...a);

  const seeded = await ev(`(async () => {
    const { db } = await import('/src/db/database.js');
    const C = ${JSON.stringify({ CATEGORIES: C.CATEGORIES, DOCUMENTS: C.DOCUMENTS, KANBAN: C.KANBAN, WORKFLOW: C.WORKFLOW, CALENDARS: C.CALENDARS, EVENTS: C.EVENTS, REPORTS: C.TASK_REPORTS, INSTANCE: C.TASK_INSTANCE })};
    const now = new Date().toISOString();
    const uuid = () => crypto.randomUUID();
    let pos = 0;
    for (const c of C.CATEGORIES) await db.documentCategories.add({ name: c.name, icon: c.icon, position: pos++, createdAt: now, updatedAt: now });
    const docIds = [];
    for (const d of C.DOCUMENTS) docIds.push(await db.documents.add({ title: d.title, content: d.content, category: d.category, locked: false, updatedAt: d.updatedAt, stableId: uuid() }));
    const boardId = await db.kanbanBoards.add({ title: C.KANBAN.title, category: C.KANBAN.category, columns: C.KANBAN.columns, createdAt: new Date(C.KANBAN.createdAt), updatedAt: new Date(C.KANBAN.updatedAt) });
    let p = 0;
    for (const card of C.KANBAN.cards) { p++; await db.kanbanCards.add({ ...card, boardId, yjsId: uuid(), position: p, createdAt: new Date(C.KANBAN.createdAt + p * 86400000), updatedAt: new Date(C.KANBAN.createdAt + p * 86400000) }); }
    const wfId = await db.workflows.add({ title: C.WORKFLOW.title, category: C.WORKFLOW.category, nodes: C.WORKFLOW.nodes, edges: C.WORKFLOW.edges, inCloud: false, ownerId: null, cloudLastUpdated: null, createdAt: C.WORKFLOW.createdAt, updatedAt: C.WORKFLOW.updatedAt });
    for (const cal of C.CALENDARS) await db.syncedCalendars.put({ ...cal, description: '', accessRole: 'owner', primary: false, syncEnabled: true, lastSynced: Date.now(), syncStatus: 'synced', eventCount: C.EVENTS.filter((e) => e.calendarId === cal.id).length, createdAt: Date.now(), updatedAt: Date.now() });
    await db.calendarEvents.bulkPut(C.EVENTS.map((e) => ({ ...e, lastFetched: Date.now() })));
    const instId = await db.taskwarriorInstances.add({ ...C.INSTANCE, rcPath: '~/.taskrc', dataPath: '~/.task', isActive: 1, inCloud: 0, ownerId: null, permissions: null, cloudDocumentId: null, createdAt: now, updatedAt: now });
    for (const r of C.REPORTS) await db.customReports.add({ ...r, createdAt: now, updatedAt: now });
    return { docIds, boardId, wfId, instId };
  })()`);
  const docs = Object.fromEntries(C.DOCUMENTS.map((d, i) => [d.title, seeded.docIds[i]]));
  const tab = (t) => ({ id: docs[t], title: t, category: C.DOCUMENTS.find((d) => d.title === t).category, inCloud: false });
  const LS = {
    documentOpenTabs: C.OPEN_DOCUMENTS.map(tab),
    currentDocumentId: docs[C.OPEN_DOCUMENTS[0]],
    expandedDocumentCategories: C.CATEGORIES.map((c) => c.name),
    templateSidebarCollapsed: true,
    'document-sidebar-width': 300,
    currentKanbanBoardId: seeded.boardId,
    kanbanOpenTabs: [{ id: seeded.boardId, title: C.KANBAN.title, category: C.KANBAN.category, inCloud: false, type: 'board' }],
    expandedKanbanCategories: [C.KANBAN.category],
    currentWorkflowId: seeded.wfId,
    workflowOpenTabs: [{ id: seeded.wfId, title: C.WORKFLOW.title, category: C.WORKFLOW.category, inCloud: false }],
    expandedWorkflowCategories: [C.WORKFLOW.category],
    expandedTaskInstanceCategories: [C.TASK_INSTANCE.category],
    expandedReportCategories: [...new Set(C.TASK_REPORTS.map((r) => r.category))],
    calendarOpenTabs: C.CALENDARS.map((c) => c.id),
    activeCalendarTab: C.CALENDARS[0].id,
    calendarViewMode: 'week',
    calendarTemplateSidebarCollapsed: true,
    [`aiChatPageConversations:${userId}`]: [C.CHAT],
  };
  await ev(`(() => { const L = ${JSON.stringify(LS)}; for (const [k, v] of Object.entries(L)) localStorage.setItem(k, JSON.stringify(v)); localStorage.setItem('diagnosticsReportsDirectory', ${JSON.stringify(REPORTS)}); localStorage.setItem(${JSON.stringify(`aiChatPageCurrentConversation:${userId}`)}, ${JSON.stringify(String(C.CHAT.id))}); })()`);
  await reload();
  await sleep(2000);

  // ---- the pages, per theme ----
  for (const theme of THEMES) {
    const sfx = suffix(theme);
    await setTheme(theme);
    await reload();
    await sleep(2000);

    if (wanted('documents') || wanted('editor')) {
      await clickNav('Documents');
      await openDocRow(C.OPEN_DOCUMENTS[0]);
      await preview();
      if (wanted('documents')) await shot(`01-documents${sfx}`);
      if (wanted('editor')) { await clickTitled('Edit'); await sleep(1200); await shot(`02-documents-editor${sfx}`); }
    }
    if (wanted('mermaid')) {
      await clickNav('Documents');
      await openDocRow(C.MERMAID_DOCUMENT);
      await preview();
      await app.waitFor(`!!document.querySelector('.markdown-preview svg')`, 20000);
      await sleep(1500);
      await shot(`03-documents-mermaid${sfx}`);
    }
    if (wanted('split')) {
      // the split view: the runbook's source on the left, a second document
      // (the architecture one, in its own preview) on the right - the state
      // "Open in Right Side" from the sidebar's context menu produces
      await clickNav('Documents');
      const right = C.SPLIT_RIGHT_DOCUMENT;
      await ev(`(async () => {
        const { db } = await import('/src/db/database.js');
        const doc = await db.documents.get(${JSON.stringify(docs[right])});
        localStorage.setItem('documentOpenTabs', ${JSON.stringify(JSON.stringify(C.OPEN_DOCUMENTS.filter((t) => t !== right).map(tab)))});
        localStorage.setItem('currentDocumentId', ${JSON.stringify(JSON.stringify(docs[C.OPEN_DOCUMENTS[0]]))});
        localStorage.setItem('documentSplitViewEnabled', 'true');
        localStorage.setItem('document-split-position', '50');
        localStorage.setItem('documentRightPane', JSON.stringify({ currentDocument: doc, title: doc.title, content: doc.content, category: doc.category, openTabs: [{ id: doc.id, title: doc.title, category: doc.category, inCloud: false }] }));
      })()`);
      await reload();
      await clickNav('Documents');
      await sleep(1500);
      // left pane in source mode, right pane in preview (each pane has its own toolbar button)
      const buttons = () => ev(`Array.from(document.querySelectorAll('button[title="Preview"], button[title="Edit"]')).map((b) => ({ title: b.title, x: b.getBoundingClientRect().left })).sort((a, b) => a.x - b.x)`);
      let b = await buttons();
      if (b[0]?.title === 'Edit') { await ev(`Array.from(document.querySelectorAll('button[title="Edit"]')).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0].click()`); await sleep(800); b = await buttons(); }
      if (b[1]?.title === 'Preview') { await ev(`Array.from(document.querySelectorAll('button[title="Preview"]')).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).pop().click()`); }
      await app.waitFor(`document.querySelectorAll('.markdown-preview').length === 1 && !!document.querySelector('textarea')`, 15000);
      await app.waitFor(`!!document.querySelector('.markdown-preview svg')`, 20000);
      await sleep(1500);
      await shot(`02-documents-split${sfx}`);
      await ev(`(() => { localStorage.setItem('documentSplitViewEnabled', 'false'); localStorage.setItem('documentRightPane', JSON.stringify({ currentDocument: null, title: '', content: '', category: 'General', openTabs: [] })); localStorage.setItem('documentOpenTabs', ${JSON.stringify(JSON.stringify(C.OPEN_DOCUMENTS.map(tab)))}); })()`);
      await reload();
    }
    if (wanted('kanban')) {
      // three columns plus the "Add Column" slot fit at 1440 px only without the inner sidebar
      await clickNav('Kanban');
      await ev(`localStorage.setItem('innerSidebarVisible', 'false')`); await reload(); await clickNav('Kanban'); await sleep(1200);
      await shot(`04-kanban${sfx}`);
      await ev(`localStorage.setItem('innerSidebarVisible', 'true')`); await reload();
    }
    if (wanted('tasks')) { await clickNav('Tasks'); await sleep(5000); await shot(`05-tasks${sfx}`); }
    if (wanted('workflow')) {
      await clickNav('Workflow Builder');
      await sleep(2500);
      await ev(`(() => { const b = document.querySelector('.react-flow__controls-fitview'); b && b.click(); })()`);
      await sleep(1200);
      await shot(`06-workflow-builder${sfx}`);
    }
    if (wanted('chat')) {
      await clickNav('Robin');
      await sleep(2500);
      await ev(`(() => { const el = Array.from(document.querySelectorAll('div')).find((d) => d.scrollHeight > d.clientHeight + 50 && d.getBoundingClientRect().left > 300 && d.querySelector('pre')); if (el) el.scrollTop = 0; })()`);
      await sleep(400);
      await shot(`07-robin-chat${sfx}`);
    }
    if (wanted('diagnostics') || wanted('log-viewer')) {
      await clickNav('Diagnostics');
      const opened = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(${JSON.stringify(path.basename(MOCK))})); if (!b) return false; b.click(); return true; })()`, 20000);
      if (!opened) throw new Error('the synthetic sosreport is not listed');
      await app.waitFor(`document.querySelectorAll('div.cursor-pointer span').length > 0`, 20000);
      const openTab = async (label) => { await ev(`(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); s && s.closest('div.cursor-pointer').click(); })()`); await sleep(5000); };
      if (wanted('diagnostics')) { await openTab('Processes'); await shot(`08-diagnostics-processes${sfx}`); }
      if (wanted('log-viewer')) {
        await ev(`window.__shotsAutoLoadLogs = true`);
        await openTab('Log Viewer');
        await sleep(9000); // the frame presses "Load Logs" itself; the journal streams in
        await ev(`window.__shotsAutoLoadLogs = false`);
        await shot(`08-diagnostics-log-viewer${sfx}`);
      }
    }
    if (wanted('calendar')) {
      await clickNav('Calendars');
      await sleep(2500);
      await ev(`(() => { const hour = Array.from(document.querySelectorAll('div, span')).find((el) => el.children.length === 0 && /^(8 AM|08:00)$/.test(el.textContent.trim())); if (hour) hour.scrollIntoView({ block: 'start' }); })()`);
      await sleep(800);
      await shot(`09-calendar-week${sfx}`);
    }
    if (wanted('about')) {
      await clickNav('Documents');
      await ev(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'about' } }))`);
      await app.waitFor(`!!document.querySelector('[data-testid="about-settings"]')`, 8000);
      await sleep(1500);
      await shot(`10-settings-about${sfx}`);
      await escape();
    }
    if (wanted('whats-new')) {
      await clickNav('Documents');
      await openDocRow(C.OPEN_DOCUMENTS[0]);
      await preview();
      await ev(`window.dispatchEvent(new Event('toggleWhatsNew'))`);
      await sleep(1500);
      await shot(`12-whats-new${sfx}`);
      await dismissWhatsNew(app);
    }

    // ---- phone (the inner sidebar hidden, as a phone user would) ----
    if (wanted('phone-documents', true) || wanted('phone-kanban', true)) {
      await metrics(PHONE);
      await clickNav('Documents');
      await openDocRow(C.OPEN_DOCUMENTS[0]);
      await preview();
      await ev(`localStorage.setItem('innerSidebarVisible', 'false')`);
      await reload();
      await sleep(1500);
      if (wanted('phone-documents', true)) { await clickNav('Documents'); await preview(); await sleep(800); await shot(`phone-documents${sfx}`); }
      if (wanted('phone-kanban', true)) { await clickNav('Kanban'); await sleep(1200); await shot(`phone-kanban${sfx}`); }
      await ev(`localStorage.setItem('innerSidebarVisible', 'true')`);
      await metrics(DESKTOP);
    }
  }
  // ---- the contrast shot: the Documents page once more in another theme ----
  if (CONTRAST !== 'none' && !THEMES.includes(CONTRAST) && wanted('documents')) {
    await metrics(DESKTOP);
    await setTheme(CONTRAST);
    await reload();
    await sleep(2000);
    await clickNav('Documents');
    await openDocRow(C.OPEN_DOCUMENTS[0]);
    await preview();
    await shot(`01-documents${suffix(CONTRAST)}`);
  }
  const errors = app.errors.filter((e) => !/favicon|ResizeObserver|stubbed/.test(e));
  if (errors.length) log('page exceptions:', errors.slice(0, 5).join(' | ').slice(0, 800));
  writeIndex();
  log(`${files.length} screenshot(s) in ${OUT} (index.md updated)`);
} catch (e) {
  console.error('FAILED', e.stack || e);
  console.error(backendLog.slice(-1200));
  process.exitCode = 1;
} finally {
  if (KEEP) { log('--keep: Chrome, Vite and the backend are still running; scratch data in', DATA); }
  else { await app.close(); stopBackend(); fs.rmSync(DATA, { recursive: true, force: true }); }
}
