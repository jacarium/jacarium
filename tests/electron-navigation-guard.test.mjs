/**
 * Guards the Electron navigation / window-open policy in
 * electron/navigation-guard.cjs (installed on every BrowserWindow by
 * electron/main.cjs).
 *
 * THE BUG: nothing in electron/ intercepted `will-navigate` or new-window
 * creation. Only DocumentEditor's preview pane intercepted anchor clicks
 * (and only for http/https/mailto). Any other way of triggering navigation
 * from renderer content - a link in a synced document rendered elsewhere,
 * an <iframe>, a form, window.open(), a javascript:/file:/data: URL - could
 * navigate the privileged window (the one carrying preload.cjs and
 * window.electronAPI) to an arbitrary remote origin, or pop a new Electron
 * window with the same preload attached.
 *
 * THE FIX: installNavigationGuards() cancels every navigation that is not
 * the app's own entry document (packaged file:// index.html, or the Vite
 * dev-server origin), routes http(s)/mailto targets to the OS browser via
 * the same shell.openExternal path the renderer already uses, drops
 * everything else, denies every window.open() (external targets again go
 * to the OS browser) and refuses <webview> attachment. No legitimate flow
 * needs in-app remote navigation: Google Calendar OAuth runs in the backend
 * via InstalledAppFlow.run_local_server (system browser) and every "open
 * link" site in src/ already uses electronAPI.openExternal.
 *
 * What this test proves (against the REAL module, with a fake webContents):
 *   - classification: same-document file:// (any query/hash, e.g.
 *     ?standalone=tools) and same-origin dev-server URLs are allowed; other
 *     file paths, other origins, javascript:, data:, custom schemes are not;
 *     http/https/mailto are "external", everything else "block";
 *   - will-navigate / will-redirect: allowed targets are not cancelled;
 *     external targets are cancelled AND handed to openExternal; blocked
 *     targets are cancelled and NOT handed to openExternal;
 *   - setWindowOpenHandler always returns {action:'deny'}, calling
 *     openExternal only for http(s)/mailto;
 *   - will-attach-webview is cancelled;
 *   - a failing openExternal is logged, never thrown.
 *
 * Run:  node tests/electron-navigation-guard.test.mjs
 * Preconditions: none (plain Node, the module has no Electron imports).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  classifyNavigation,
  classifyWindowOpen,
  isAppNavigation,
  installNavigationGuards
} = require(path.join(here, '..', 'electron', 'navigation-guard.cjs'));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const FILE_ENTRY = 'file:///Applications/Jacarium.app/Contents/Resources/app/dist/index.html';
const DEV_ENTRY = 'http://localhost:5173';

// ---------- classification ----------
check('file: same document allowed', isAppNavigation(FILE_ENTRY, FILE_ENTRY));
check('file: same document with ?standalone= allowed', isAppNavigation(`${FILE_ENTRY}?standalone=tools`, FILE_ENTRY));
check('file: same document with #hash allowed', isAppNavigation(`${FILE_ENTRY}#/documents`, FILE_ENTRY));
check('file: OTHER file path blocked', classifyNavigation('file:///etc/passwd', FILE_ENTRY) === 'block');
check('file: sibling html in dist blocked', classifyNavigation(FILE_ENTRY.replace('index.html', 'other.html'), FILE_ENTRY) === 'block');
check('dev: same origin allowed', classifyNavigation(`${DEV_ENTRY}/?standalone=kanban`, DEV_ENTRY) === 'allow');
check('dev: same origin deep path allowed', classifyNavigation(`${DEV_ENTRY}/some/route`, DEV_ENTRY) === 'allow');
check('dev: different port is external', classifyNavigation('http://localhost:8080/', DEV_ENTRY) === 'external');
check('dev: https origin is external', classifyNavigation('https://localhost:5173/', DEV_ENTRY) === 'external');
check('remote https is external (packaged)', classifyNavigation('https://example.com/phish', FILE_ENTRY) === 'external');
check('remote http is external (packaged)', classifyNavigation('http://example.com/', FILE_ENTRY) === 'external');
check('mailto is external', classifyNavigation('mailto:a@b.c', FILE_ENTRY) === 'external');
check('javascript: blocked', classifyNavigation('javascript:alert(1)', FILE_ENTRY) === 'block');
check('data: blocked', classifyNavigation('data:text/html,<script>1</script>', FILE_ENTRY) === 'block');
check('custom scheme blocked', classifyNavigation('ssh://host', FILE_ENTRY) === 'block');
check('garbage blocked', classifyNavigation('not a url', FILE_ENTRY) === 'block');
check('empty blocked', classifyNavigation('', FILE_ENTRY) === 'block');
check('window.open http -> external', classifyWindowOpen('https://example.com') === 'external');
check('window.open same app url -> block (never a new window)', classifyWindowOpen(FILE_ENTRY) === 'block');
check('window.open javascript: -> block', classifyWindowOpen('javascript:1') === 'block');

// ---------- wiring on a fake webContents ----------
function fakeWebContents() {
  const handlers = {};
  return {
    handlers,
    windowOpenHandler: null,
    on(event, fn) { handlers[event] = fn; },
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  };
}
function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const opened = [];
const logs = [];
const wc = fakeWebContents();
installNavigationGuards(wc, {
  appEntryUrl: FILE_ENTRY,
  openExternal: async (url) => { opened.push(url); },
  log: (m) => logs.push(m)
});

check('installs will-navigate, will-redirect, will-attach-webview and window-open handlers',
  typeof wc.handlers['will-navigate'] === 'function'
  && typeof wc.handlers['will-redirect'] === 'function'
  && typeof wc.handlers['will-attach-webview'] === 'function'
  && typeof wc.windowOpenHandler === 'function');

let ev = fakeEvent();
wc.handlers['will-navigate'](ev, `${FILE_ENTRY}?standalone=tools`);
check('will-navigate: in-app target not cancelled', !ev.prevented);

ev = fakeEvent();
wc.handlers['will-navigate'](ev, 'https://attacker.example/steal');
await sleep(0);
check('will-navigate: remote target cancelled', ev.prevented);
check('will-navigate: remote target handed to openExternal', opened.includes('https://attacker.example/steal'));

opened.length = 0;
ev = fakeEvent();
wc.handlers['will-navigate'](ev, 'file:///etc/passwd');
await sleep(0);
check('will-navigate: other file:// cancelled and NOT opened externally', ev.prevented && opened.length === 0);

ev = fakeEvent();
wc.handlers['will-navigate'](ev, 'javascript:alert(1)');
await sleep(0);
check('will-navigate: javascript: cancelled and NOT opened externally', ev.prevented && opened.length === 0);

ev = fakeEvent();
wc.handlers['will-redirect'](ev, 'https://redirect.example/');
await sleep(0);
check('will-redirect: remote cancelled + opened externally', ev.prevented && opened.includes('https://redirect.example/'));

opened.length = 0;
let decision = wc.windowOpenHandler({ url: 'https://example.com/doc' });
await sleep(0);
check('window.open(https): denied + opened externally', decision.action === 'deny' && opened.includes('https://example.com/doc'));

opened.length = 0;
decision = wc.windowOpenHandler({ url: FILE_ENTRY });
await sleep(0);
check('window.open(app url): denied, nothing opened', decision.action === 'deny' && opened.length === 0);

decision = wc.windowOpenHandler({ url: 'javascript:void 0' });
await sleep(0);
check('window.open(javascript:): denied, nothing opened', decision.action === 'deny' && opened.length === 0);

ev = fakeEvent();
wc.handlers['will-attach-webview'](ev);
check('will-attach-webview cancelled', ev.prevented);

// openExternal failure must be logged, never thrown
const wc2 = fakeWebContents();
const logs2 = [];
installNavigationGuards(wc2, {
  appEntryUrl: DEV_ENTRY,
  openExternal: async () => { throw new Error('no browser'); },
  log: (m) => logs2.push(m)
});
let threw = false;
try {
  wc2.handlers['will-navigate'](fakeEvent(), 'https://example.com/');
  await sleep(0);
} catch {
  threw = true;
}
check('openExternal failure is logged, not thrown', !threw && logs2.some((m) => /openExternal failed/.test(m)));

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
