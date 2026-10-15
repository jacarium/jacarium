/**
 * Google Calendar is optional (src/utils/calendarAuth.js, calendarSync.js,
 * CalendarsPage.jsx, CalendarConnectState.jsx): like Jira (cfff842) nothing
 * calendar-related runs unless the backend's auth-status says the calendar
 * is connected, and the page shows a calm state instead of "Sync Failed".
 *
 * Real modules over jsdom (esbuild bundle, fake-indexeddb, mocked fetch):
 *   - the three states from one cached GET /auth-status: unconfigured,
 *     disconnected (configured, no token), unavailable (browser
 *     deployment: no sign-in there); every fetcher rejects with the typed
 *     CalendarNotConnectedError without a request and without console.error;
 *     a settings save ('settingsSaved') re-reads the status (no restart);
 *   - connected: the calendars request goes out; a 401 answer becomes the
 *     typed error and drops the cache;
 *   - connectGoogleCalendar: the backend's own message is passed through
 *     (400 not configured, 501 browser), "complete the sign-in in your
 *     browser" is announced only after the backend answered 202, the status
 *     is polled until authenticated or the failure message;
 *   - the Calendars page mounted (NotificationProvider around it): in each
 *     not-connected state no toast at all, no /calendars or /sync request,
 *     the matching empty state (the unconfigured one is the shared
 *     IntegrationNotConfigured with its button to Settings > Integrations,
 *     the Jira one); connected: the calendars are listed;
 *   - statically: the auto-sync and background sync are armed only while
 *     connected, the old "Opening browser" announcement is gone, the JQL
 *     builder uses the same shared component, the settings panel and the
 *     docs/DESKTOP.md explain the Desktop-app client and the home server limitation.
 * Run: node tests/google-calendar-optional.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie', 'jsdom']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---- static ----
const page = read('src/components/CalendarsPage.jsx');
check('CalendarsPage reads the connection state from calendarAuth and gates the sync handlers on it', /calendarConnectionState/.test(page) && /connectionStateRef\.current !== 'connected'/.test(page));
check('CalendarsPage arms the auto-sync and the background sync only while connected', /if \(!autoSyncEnabled \|\| !isConnected\)/.test(page) && /if \(!isConnected\) return;\s*\n\s*syncCalendar\(/.test(page));
check('CalendarsPage re-reads the status after a settings save', /settingsSaved/.test(page));
check('CalendarsPage no longer announces "Opening browser" before the request; it waits for onBrowserOpened', !/Opening browser/i.test(page) && /onBrowserOpened/.test(page));
check('CalendarsPage renders CalendarConnectState / CalendarConnectBanner', /<CalendarConnectState/.test(page) && /<CalendarConnectBanner/.test(page));
const connect = read('src/components/features/calendars/CalendarConnectState.jsx');
const shared = read('src/components/common/IntegrationNotConfigured.jsx');
const jql = read('src/components/JQLBuilder.jsx');
check("the unconfigured state is the shared IntegrationNotConfigured (the Jira one), its button opening the integration's own section", /<IntegrationNotConfigured/.test(connect) && /<IntegrationNotConfigured/.test(jql) && /openAppSettings\('integrations', \{ section \}\)/.test(shared) && /isn't set up/.test(shared) && /section="calendar"/.test(connect) && /section="jira"/.test(jql));
check('the not-set-up texts are one short sentence each, without a README mention or a Google Cloud link', !/README|console\.cloud\.google/.test(connect) && /to see and sync your calendars here\.'/.test(connect) && !/Nothing is contacted/.test(connect) && !/Nothing is contacted|README/.test(jql.slice(jql.indexOf('<IntegrationNotConfigured'), jql.indexOf('<IntegrationNotConfigured') + 400)));
const settings = read('src/components/common/modals/settings/integrations/GoogleCalendarSettings.jsx');
check('the settings panel explains the Desktop app client and the home server limitation', /Desktop app/.test(settings) && /desktop app/.test(settings));
const desktopDoc = read('docs/DESKTOP.md');
const section = desktopDoc.slice(desktopDoc.indexOf('\n## Google Calendar\n'), desktopDoc.indexOf('\n## Connection indicator\n'));
check('docs/DESKTOP.md has a Google Calendar section: Desktop app client, where to paste, the browser/home server limitation', section.length > 500 && /Desktop app/.test(section) && /Settings > Integrations > Google Calendar/.test(section) && /home server/.test(section) && /Web application/.test(section));
const backend = read('backend/google_calendar.py');
check('the backend refuses the sign-in outside auth mode app-token and starts the desktop flow on a thread', /def sign_in_available/.test(backend) && /SIGN_IN_UNAVAILABLE/.test(backend) && /threading\.Thread\(target=_run_sign_in/.test(backend));

// ---- jsdom + the real modules ----
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.example.test/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!dom.window.ResizeObserver) { dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = dom.window.ResizeObserver; }
if (!dom.window.matchMedia) { dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); }
await import(req.resolve('fake-indexeddb/auto'));
// fake-indexeddb/auto installs onto `window` when one exists: make both globals agree
for (const k of ['indexedDB', 'IDBKeyRange']) { const v = globalThis[k] || dom.window[k]; globalThis[k] = v; dom.window[k] = v; }

// the backend, as the test wants it
let authStatus = { configured: false, authenticated: false, signInAvailable: true, signInPending: false, signInError: null, message: "Google Calendar isn't set up: add your Google OAuth client ID and secret in Settings > Integrations > Google Calendar." };
let authenticateAnswer = { status: 400, body: { success: false, code: 'NOT_CONFIGURED', message: 'OAuth credentials not configured' } };
let calendarsAnswer = { status: 200, body: { calendars: [{ id: 'synthetic-primary', summary: 'Synthetic calendar', primary: true, backgroundColor: '#4285f4', foregroundColor: '#ffffff', accessRole: 'owner' }] } };
const calls = [];
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url), 'https://console.example.test');
  calls.push({ path: u.pathname, method: options.method || 'GET' });
  if (u.pathname === '/api/calendar/auth-status') return answer(200, { ...authStatus });
  if (u.pathname === '/api/calendar/authenticate') return answer(authenticateAnswer.status, authenticateAnswer.body);
  if (u.pathname === '/api/calendar/calendars') return answer(calendarsAnswer.status, calendarsAnswer.body);
  if (u.pathname === '/api/calendar/sync') return answer(200, { success: true, events: [] });
  if (u.pathname === '/api/capabilities') return answer(200, { authMode: 'none', capabilities: {} });
  return answer(404, { error: 'not found' });
};
const dataCalls = () => calls.filter((c) => c.path !== '/api/calendar/auth-status' && c.path !== '/api/capabilities');
const statusCalls = () => calls.filter((c) => c.path === '/api/calendar/auth-status').length;
const errors = [];
const realError = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const realLog = console.log; const realWarn = console.warn;
const quiet = () => { console.log = () => {}; console.warn = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; };

const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-optional-'));
const ENTRY = path.join(WORK, 'entry.mjs');
const BUNDLE = path.join(WORK, 'bundle.cjs');
fs.writeFileSync(ENTRY, `
  export * as auth from '@worktree/src/utils/calendarAuth.js';
  export * as sync from '@worktree/src/utils/calendarSync.js';
  export { default as CalendarConnectState, CalendarConnectBanner } from '@worktree/src/components/features/calendars/CalendarConnectState.jsx';
  export { default as IntegrationNotConfigured } from '@worktree/src/components/common/IntegrationNotConfigured.jsx';
  export { default as IntegrationsSettings } from '@worktree/src/components/common/modals/settings/IntegrationsSettings.jsx';
  export { default as CalendarsPage } from '@worktree/src/components/CalendarsPage.jsx';
  export { NotificationProvider, useNotifications } from '@worktree/src/contexts/NotificationContext.jsx';
  export { db } from '@worktree/src/db/database.js';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty' }, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});
quiet();
const m = createRequire(import.meta.url)(BUNDLE);
const { auth, sync, React, createRoot, act } = m;
loud();

async function rejects(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function gatedEverywhere(label, code) {
  calls.length = 0; errors.length = 0;
  quiet();
  const a = await rejects(() => sync.fetchCalendarsFromGoogle());
  const b = await rejects(() => sync.syncCalendar('synthetic-primary', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'));
  const c = await rejects(() => sync.syncAllCalendars());
  loud();
  check(`${label}: fetchCalendarsFromGoogle / syncCalendar / syncAllCalendars reject with ${code}`, a?.code === code && b?.code === code && c?.code === code, JSON.stringify([a?.code, b?.code, c?.code, a?.message]));
  check(`${label}: ...without a calendar request`, dataCalls().length === 0, JSON.stringify(dataCalls()));
  check(`${label}: ...and without console.error`, errors.length === 0, errors.join(' | '));
  return a;
}

// ---- 1. not configured ----
auth.invalidateCalendarAuthStatus();
let status = await auth.getCalendarAuthStatus();
check('1. unconfigured: the state is "unconfigured" from one auth-status read', auth.calendarConnectionState(status) === 'unconfigured' && statusCalls() === 1, JSON.stringify(status));
const e1 = await gatedEverywhere('1. unconfigured', 'CALENDAR_NOT_CONFIGURED');
check('1. unconfigured: the message says where to set it up', /Settings > Integrations > Google Calendar/.test(e1?.message || ''), e1?.message);
check('1. unconfigured: the status stayed cached (no second read)', statusCalls() === 0);

// ---- 2. the owner saves the client in Settings: configured, no token ----
authStatus = { ...authStatus, configured: true, message: 'Not authenticated. Please sign in with Google.' };
window.dispatchEvent(new window.Event('settingsSaved'));
status = await auth.getCalendarAuthStatus();
check('2. after settingsSaved the status is re-read: "disconnected" (no restart)', auth.calendarConnectionState(status) === 'disconnected', JSON.stringify(status));
await gatedEverywhere('2. disconnected', 'CALENDAR_NOT_CONNECTED');

// ---- 3. the browser deployment: no sign-in there ----
authStatus = { ...authStatus, signInAvailable: false };
auth.invalidateCalendarAuthStatus();
status = await auth.getCalendarAuthStatus();
check('3. signInAvailable false: the state is "unavailable"', auth.calendarConnectionState(status) === 'unavailable');
const e3 = await gatedEverywhere('3. unavailable', 'CALENDAR_SIGN_IN_UNAVAILABLE');
check('3. unavailable: the message names the desktop app', /desktop app/.test(e3?.message || ''), e3?.message);
authStatus = { ...authStatus, signInAvailable: true };

// ---- 4. (a state that used to exist here is gone) / 5. connected ----
authStatus = { ...authStatus, authenticated: true };
auth.invalidateCalendarAuthStatus();
status = await auth.getCalendarAuthStatus();
check('5. connected: the state is "connected"', auth.calendarConnectionState(status) === 'connected');
calls.length = 0; errors.length = 0;
quiet(); const cals = await sync.fetchCalendarsFromGoogle(); loud();
check('5. connected: the calendars request goes out and the calendar is cached', cals.length === 1 && cals[0].id === 'synthetic-primary' && dataCalls().some((c) => c.path === '/api/calendar/calendars'), JSON.stringify(dataCalls()));
// the token is revoked meanwhile: the backend's 401 is the typed state, not an error, and the cache is dropped
calendarsAnswer = { status: 401, body: { error: 'Not authenticated' } };
calls.length = 0; errors.length = 0;
quiet(); const e5 = await rejects(() => sync.fetchCalendarsFromGoogle()); loud();
check('5. a 401 from the backend becomes the typed CALENDAR_NOT_CONNECTED error, no console.error', e5?.code === 'CALENDAR_NOT_CONNECTED' && errors.length === 0, `${e5?.code} ${errors.join(' | ')}`);
calls.length = 0;
await auth.getCalendarAuthStatus();
check('5. ...and the status is read again afterwards', statusCalls() === 1);
calendarsAnswer = { status: 200, body: { calendars: [{ id: 'synthetic-primary', summary: 'Synthetic calendar', primary: true }] } };

// ---- 6. connectGoogleCalendar: the backend's message, "complete in your browser" only after 202 ----
const events = [];
const onBrowserOpened = (msg) => events.push(['browser', msg]);
authStatus = { ...authStatus, configured: false, authenticated: false };
auth.invalidateCalendarAuthStatus();
calls.length = 0; events.length = 0;
let err = await rejects(() => auth.connectGoogleCalendar({ onBrowserOpened, pollMs: 5 }));
check("6. 400 not configured: the backend's message is passed through, nothing announced", err?.message === 'OAuth credentials not configured' && err?.code === 'NOT_CONFIGURED' && events.length === 0, `${err?.message} ${JSON.stringify(events)}`);
authenticateAnswer = { status: 501, body: { success: false, code: 'SIGN_IN_UNAVAILABLE', message: 'Google sign-in is not available on the home server yet: it opens a browser on the machine that runs the backend. Connect Google Calendar from the desktop app.' } };
err = await rejects(() => auth.connectGoogleCalendar({ onBrowserOpened, pollMs: 5 }));
check('6. 501 browser deployment: the message is passed through with its code', /desktop app/.test(err?.message || '') && err?.code === 'SIGN_IN_UNAVAILABLE' && events.length === 0, err?.message);
// the desktop: 202, the browser opens, the status is polled until the token is there
authStatus = { ...authStatus, configured: true, authenticated: false, signInPending: true };
authenticateAnswer = { status: 202, body: { success: true, started: true, message: 'Complete the Google sign-in in the browser window that just opened.' } };
calls.length = 0; events.length = 0;
let polls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => { const u = new URL(String(url), 'https://x'); if (u.pathname === '/api/calendar/auth-status') { polls++; if (polls >= 3) authStatus = { ...authStatus, authenticated: true, signInPending: false }; } if (u.pathname === '/api/calendar/authenticate') events.push(['post']); return realFetch(url, options); };
const done = await auth.connectGoogleCalendar({ onBrowserOpened, pollMs: 5 });
check('6. 202: "complete the sign-in in your browser" is announced only after the POST answered, then the status is polled until authenticated', events[0]?.[0] === 'post' && events[1]?.[0] === 'browser' && /browser window/.test(events[1]?.[1] || '') && done?.authenticated === true && polls >= 3, JSON.stringify({ events, polls, done }));
// the user declined: the failure message from auth-status
authStatus = { ...authStatus, authenticated: false, signInPending: true, signInError: null };
polls = 0; events.length = 0;
globalThis.fetch = async (url, options) => { const u = new URL(String(url), 'https://x'); if (u.pathname === '/api/calendar/auth-status') { polls++; if (polls >= 2) authStatus = { ...authStatus, signInPending: false, signInError: 'Authentication failed: access_denied' }; } return realFetch(url, options); };
err = await rejects(() => auth.connectGoogleCalendar({ onBrowserOpened, pollMs: 5 }));
check("6. a failed sign-in rejects with the backend's failure message", err?.message === 'Authentication failed: access_denied' && events.length === 1, err?.message);
globalThis.fetch = realFetch;

// ---- 7. the components ----
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(30); }); };
const q = (sel) => document.querySelector(sel);
const h = React.createElement;
let openEvents = [];
window.addEventListener('openAppSettings', (e) => openEvents.push(e.detail));
await render(h(m.CalendarConnectState, { state: 'unconfigured', onConnect: () => {} }));
check("7. unconfigured renders \"Google Calendar isn't set up\" with the Settings > Integrations hint", q('[data-testid="calendar-unconfigured"]') && /Google Calendar isn't set up/.test(q('[data-testid="calendar-unconfigured"]').textContent) && /Settings > Integrations > Google Calendar/.test(q('[data-testid="calendar-unconfigured"]').textContent), q('[data-testid="calendar-unconfigured"]')?.textContent);
await act(async () => { q('[data-testid="calendar-open-settings"]').click(); });
check("7. ...its button opens Settings > Integrations on the Google Calendar section", openEvents.length === 1 && openEvents[0].tab === 'integrations' && openEvents[0].section === 'calendar', JSON.stringify(openEvents));
check('7. ...the text is one short sentence (no README, no Google Cloud link)', !/README|Google Cloud/.test(q('[data-testid="calendar-unconfigured"]').textContent) && (q('[data-testid="calendar-unconfigured"]').textContent.match(/\. /g) || []).length <= 1, q('[data-testid="calendar-unconfigured"]').textContent);
// the Integrations tab lands on the requested section (the dialog passes the opener's section through)
const activeSubTab = () => q('[role="tab"][aria-selected="true"]')?.textContent;
await render(h(m.IntegrationsSettings, { settings: {}, handleChange: () => {}, initialSection: 'calendar' }));
check('7. IntegrationsSettings opened for "calendar" shows the Google Calendar section', activeSubTab() === 'Google Calendar' && /OAuth 2.0 Client ID/.test(document.body.textContent), activeSubTab());
await render(h(m.IntegrationsSettings, { settings: {}, handleChange: () => {}, initialSection: 'jira' }));
check('7. ...and for "jira" the JIRA section', activeSubTab() === 'JIRA', activeSubTab());
await render(h(m.IntegrationsSettings, { settings: {}, handleChange: () => {} }));
check('7. ...JIRA by default', activeSubTab() === 'JIRA', activeSubTab());
let connectClicks = 0;
await render(h(m.CalendarConnectState, { state: 'disconnected', onConnect: () => { connectClicks++; } }));
await act(async () => { q('[data-testid="calendar-connect"]').click(); });
check('7. disconnected renders "Connect Google Calendar" and the button signs in', /Connect Google Calendar/.test(q('[data-testid="calendar-disconnected"]')?.textContent || '') && connectClicks === 1);
await render(h(m.CalendarConnectState, { state: 'unavailable' }));
check('7. unavailable renders "Connect Google Calendar from the desktop app"', /Connect Google Calendar from the desktop app/.test(q('[data-testid="calendar-unavailable"]')?.textContent || ''));
await render(h(m.CalendarConnectBanner, { state: 'disconnected', onConnect: () => {} }));
check('7. the banner over a cached calendar: "not connected", with a Connect action', q('[data-testid="calendar-banner-disconnected"]') && q('[data-testid="calendar-banner-connect"]'));
openEvents = [];
await render(h(m.IntegrationNotConfigured, { name: 'Jira', section: 'jira', testId: 'jira-unconfigured', description: 'Add your Jira URL and API token in Settings > Integrations > Jira.' }));
await act(async () => { q('[data-testid="jira-unconfigured-open-settings"]').click(); });
check("7. the shared component renders Jira's state the same way (\"Jira isn't set up\", \"Open Jira settings\"), opening the JIRA section", /Jira isn't set up/.test(q('[data-testid="jira-unconfigured"]')?.textContent || '') && /Open Jira settings/.test(q('[data-testid="jira-unconfigured"]')?.textContent || '') && openEvents[0]?.tab === 'integrations' && openEvents[0]?.section === 'jira', JSON.stringify(openEvents));
await render(null);

// ---- 8. the Calendars page mounted: no toast, no request, the matching state ----
let seen = [];
function Probe() { const { notifications, history } = m.useNotifications(); seen = [...history, ...notifications]; return null; }
const mountPage = async () => {
  seen = []; calls.length = 0; errors.length = 0;
  auth.invalidateCalendarAuthStatus();
  quiet();
  await render(h(m.NotificationProvider, null, h(Probe), h(m.CalendarsPage)));
  await act(async () => { await sleep(250); });
  loud();
};
const toasts = () => seen.map((n) => `${n.type}:${n.title}`);
const pageState = () => q('[data-testid="calendar-connect-state"]')?.getAttribute('data-state');
// a calendar cached from step 5 is still there: the page keeps showing it, with the strip above it
authStatus = { ...authStatus, configured: true, authenticated: false, signInAvailable: true, signInPending: false, signInError: null };
try {
  await mountPage();
  check('8. page (disconnected, cached calendar): the cached calendar stays listed with the "not connected" strip, no toast, no request', /Synthetic calendar/.test(document.body.textContent) && !!q('[data-testid="calendar-banner-disconnected"]') && seen.length === 0 && dataCalls().length === 0 && errors.length === 0, `${toasts().join(', ')} ${JSON.stringify(dataCalls())} ${errors.join(' | ')}`);
} catch (e) {
  check('8. page (disconnected, cached calendar) mounts', false, e?.stack || e);
}
await render(null);
// nothing cached: the empty states
quiet();
await m.db.syncedCalendars.clear();
if (m.db.calendarEvents) await m.db.calendarEvents.clear();
loud();
for (const k of ['calendarOpenTabs', 'activeCalendarTab']) localStorage.removeItem(k);
const pageCases = [
  ['unconfigured', { configured: false, authenticated: false, signInAvailable: true }, 'calendar-unconfigured'],
  ['disconnected', { configured: true, authenticated: false, signInAvailable: true }, 'calendar-disconnected'],
  ['unavailable', { configured: true, authenticated: false, signInAvailable: false }, 'calendar-unavailable'],
];
for (const [state, s, testId] of pageCases) {
  authStatus = { ...authStatus, ...s, signInPending: false, signInError: null };
  try {
    await mountPage();
    check(`8. page (${state}): the ${state} state is shown`, pageState() === state && !!q(`[data-testid="${testId}"]`), `${pageState()} ${document.body.textContent.slice(0, 200)}`);
    check(`8. page (${state}): no toast at all (no "Sync Failed")`, seen.length === 0, toasts().join(', '));
    check(`8. page (${state}): no /calendars or /sync request, no console.error`, dataCalls().length === 0 && errors.length === 0, JSON.stringify(dataCalls()) + ' ' + errors.join(' | '));
  } catch (e) {
    check(`8. page (${state}) mounts`, false, e?.stack || e);
  }
  await render(null);
}
// connected: the calendars are fetched and listed, the automatic sync runs, nothing fails
authStatus = { ...authStatus, configured: true, authenticated: true, signInAvailable: true };
try {
  await mountPage();
  await act(async () => { await sleep(300); });
  check('8. page (connected): the calendar list is fetched and the synthetic calendar is shown', dataCalls().some((c) => c.path === '/api/calendar/calendars') && /Synthetic calendar/.test(document.body.textContent), JSON.stringify(dataCalls()));
  check('8. page (connected): no error toast, no console.error', !seen.some((n) => n.type === 'error') && errors.length === 0, toasts().join(', ') + ' ' + errors.join(' | '));
} catch (e) {
  check('8. page (connected) mounts', false, e?.stack || e);
}
await render(null);

console.error = realError;
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
