#!/usr/bin/env node
/**
 * The Settings dialog's scope switch (src/components/common/modals/
 * SettingsModal.jsx, settings/CopySettingsSheet.jsx, settings/fields.jsx,
 * src/services/settingsStore.js): This device | My account | Everyone.
 *
 * The REAL dialog in jsdom with a mocked desktop bridge (window.electronAPI:
 * the device file, the home-server link, the scope controller - plain
 * values and set / not set only, as the real preload gives) and a mocked
 * backend fetch; then without the bridge as a signed-in browser.
 *   1. desktop, not linked: no switch, no banner, the device file loads;
 *   2. desktop, linked, running on This device: the switch with the three
 *      options, This device checked; the banner with "Use my account's
 *      settings"; the migration sheet opens once (lists the device file's
 *      plain keys with values and its secrets by name, conflicts with the
 *      account's values; Not now closes it and the flag stops a second
 *      offer); no provenance tags in this scope;
 *   3. switching to My account calls the controller (setScope) and loads
 *      the account's values; every field carries its provenance tag ("your
 *      account" / "everyone" / "not set"); secrets show set / not set, no
 *      value anywhere in the DOM; the "last synced" line; the localhost
 *      hint on the endpoint; Save sends values, write-only secrets and
 *      ifRevision to the controller; a 409 shows the conflict and a Reload;
 *   4. unsaved edits: choosing another scope asks Save / Discard / Stay;
 *   5. Everyone as a non-administrator: read-only (a disabled fieldset, no
 *      Save button, the "set by the administrator" note); as an
 *      administrator: editable, loaded from /api/admin/settings;
 *   6. the controller's change event (a revocation) flips the dialog back
 *      to This device; the General tab's Home server section says which
 *      settings the computer uses and offers the copy;
 *   7. the migration sheet's Copy sends the ticked plain keys and secrets
 *      (by name) to the controller and switches the scope;
 *   8. the web (no bridge, signed in): My account | Everyone only, tags from
 *      the account's values and the inherited defaults.
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/settings-scope-ui.test.mjs
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
for (const dep of ['esbuild', 'react', 'react-dom', 'dexie']) { if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
for (const dep of ['jsdom', 'fake-indexeddb']) { if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed`); process.exit(0); } }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-scope-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = console.log;
let failures = 0; let total = 0;
function check(name, cond, detail = '') { total += 1; if (cond) report(`PASS: ${name}`); else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 6000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

// ---------- bundle ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SettingsModal from '@worktree/src/components/common/modals/SettingsModal.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
import { initializePlatform } from '@worktree/src/utils/platform.js';
let setView = null; let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  return React.createElement(SettingsModal, { key: view.key, isOpen: true, onClose: () => {}, initialTab: view.tab || 'ai' });
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
window.__harness = { mount: (opts = {}) => whenReady(() => setView({ ...opts, key: ++key })), unmount: () => whenReady(() => setView(null)), initializePlatform };
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(ThemeProvider, null, React.createElement(Host))));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'warning',
});

// ---------- jsdom ----------
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'DOMParser']) define(key, window[key]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;

// ---------- the mocked backend (apiFetch) and home server (homeServerFetch) ----------
const SECRET = 'sk-ant-must-never-show-1234567890';
let capabilities = { auth: { mode: 'app-token' }, capabilities: { settings: false } };
let adminSettings = { values: { DEFAULT_AI_TEMPERATURE: '0.2', HF_EMBEDDING_MODEL: 'BAAI/bge-small-en-v1.5' }, secrets: { OPENAI_API_KEY: true }, revision: 1, revisions: { DEFAULT_AI_TEMPERATURE: 1 } };
let accountSettings = { values: { DEFAULT_AI_PROVIDER: 'ollama', DEFAULT_AI_MODEL: 'qwen3:30b', CUSTOM_AI_ENDPOINT: 'http://ollama.lan:11434/api/chat' }, secrets: { ANTHROPIC_API_KEY: true }, inherited: { DEFAULT_AI_TEMPERATURE: '0.2', OPENAI_API_KEY: true }, revision: 3, revisions: { DEFAULT_AI_PROVIDER: 2, DEFAULT_AI_MODEL: 3, CUSTOM_AI_ENDPOINT: 1, ANTHROPIC_API_KEY: 1 } };
let me = { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user' };
const calls = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const route = (method, u, body) => {
  if (/\/api\/capabilities/.test(u)) return json(capabilities);
  if (/\/api\/ai\/models/.test(u)) return json({ anthropic: [], openai: [], gemini: [], ollama: ['qwen3:30b'], defaults: { provider: 'ollama', model: 'qwen3:30b' } });
  if (/\/api\/auth\/me/.test(u)) return json({ user: me });
  if (/\/api\/version/.test(u)) return json({ app: '3.2.8', protocol: 2, capabilities: { desktopAdmin: true } });
  if (/\/api\/admin\/settings/.test(u)) { if (method === 'PUT') { calls.push({ url: u, body }); return json({ ok: true, ...adminSettings }); } return json(adminSettings); }
  if (/\/api\/settings$/.test(u)) { if (method === 'PUT') { calls.push({ url: u, body }); return json({ ok: true, ...accountSettings }); } return json(accountSettings); }
  if (/\/api\/sync\/status/.test(u)) return json({ enabled: true, settingsRevision: 3 });
  return json({ error: 'not mocked ' + u }, 404);
};
const fetchLog = [];
const stubFetch = async (url, init = {}) => { fetchLog.push(`${init.method || 'GET'} ${String(url)}`); return route(init.method || 'GET', String(url), init.body ? JSON.parse(init.body) : null); };
define('fetch', stubFetch); window.fetch = stubFetch;

// the desktop bridge: the profile's own file and the scope controller (state only, never a secret value)
const deviceFile = { values: { DEFAULT_AI_PROVIDER: 'anthropic', JIRA_URL: 'https://jira.example.test', CUSTOM_AI_ENDPOINT: 'http://localhost:11434/api/chat' }, secrets: { ANTHROPIC_API_KEY: true, JIRA_PAT: true } };
let linked = false;
let controller = { scope: 'device', linked: false, available: false, values: {}, secrets: {}, sources: {}, revision: 0, revisions: {}, lastSynced: null, offline: false, error: null, keychain: true };
const ipc = [];
const changeListeners = new Set();
const changeListener = (state) => { for (const fn of changeListeners) fn(state); };
const accountState = () => ({ ...controller, linked, available: linked && controller.scope === 'account', values: { ...accountSettings.values }, secrets: { ...accountSettings.secrets }, sources: { DEFAULT_AI_PROVIDER: 'account', DEFAULT_AI_MODEL: 'account', CUSTOM_AI_ENDPOINT: 'account', ANTHROPIC_API_KEY: 'account', DEFAULT_AI_TEMPERATURE: 'everyone', OPENAI_API_KEY: 'everyone', HF_EMBEDDING_MODEL: 'everyone' }, revision: accountSettings.revision, revisions: { ...accountSettings.revisions }, lastSynced: linked ? '2026-10-20T10:41:00.000Z' : null });
const electronAPI = {
  isElectron: true,
  readSettings: async () => ({ values: { ...deviceFile.values }, secrets: { ...deviceFile.secrets } }),
  writeSettings: async (payload) => { ipc.push(['writeSettings', payload]); return { values: { ...deviceFile.values, ...payload.values }, secrets: { ...deviceFile.secrets } }; },
  homeServerStatus: async () => (linked ? { linked: true, url: 'https://pi.console', username: 'alice', userId: 'u1', displayName: 'Alice', role: me.role, deviceName: 'mac', encrypted: true } : { linked: false }),
  homeServerFetch: async (p, init = {}) => { const r = await route(init.method || 'GET', `https://pi.console${p}`, init.body ? JSON.parse(init.body) : null); return { ok: r.ok, status: r.status, text: await r.text() }; },
  homeServerVersion: async () => ({ desktop: { app: '3.2.8', protocol: 2 }, server: { reachable: true, linked, url: 'https://pi.console', app: '3.2.8', protocol: 2, legacy: false, capabilities: { desktopAdmin: true } } }),
  getZoomFactor: async () => 0.9, getDebugBarEnabled: async () => false,
  getUsername: async () => 'robin', getHostname: async () => 'mac', getAppToken: async () => 'app-token', getAppVersion: async () => '3.2.8',
  openExternal: async () => {}, readEnvFile: async () => ({ ...deviceFile.values }),
  accountSettingsState: async () => accountState(),
  accountSettingsSetScope: async (scope) => { ipc.push(['setScope', scope]); controller.scope = scope; return accountState(); },
  accountSettingsRefresh: async () => accountState(),
  accountSettingsWrite: async (payload) => { ipc.push(['write', payload]); if (payload.ifRevision && payload.ifRevision.DEFAULT_AI_MODEL !== undefined && payload.ifRevision.DEFAULT_AI_MODEL < accountSettings.revisions.DEFAULT_AI_MODEL) { const e = new Error('Changed on another device - reload the settings'); e.conflicts = [{ key: 'DEFAULT_AI_MODEL', revision: accountSettings.revisions.DEFAULT_AI_MODEL, current: 'llama3' }]; throw e; } const merged = { ...accountSettings.values, ...payload.values }; for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k]; accountSettings = { ...accountSettings, values: merged, revision: accountSettings.revision + 1 }; return accountState(); },
  accountSettingsDeviceSummary: async () => ({ values: { ...deviceFile.values }, secretKeys: Object.keys(deviceFile.secrets) }),
  accountSettingsCopyFromDevice: async (choice) => { ipc.push(['copy', choice]); controller.scope = 'account'; return { copied: [...choice.plainKeys, ...choice.secretKeys], state: accountState() }; },
  onAccountSettingsChanged: (cb) => { changeListeners.add(cb); return () => { changeListeners.delete(cb); }; },
};
window.electronAPI = electronAPI;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|Error loading|not mocked/.test(String(a[0] ?? ''))) return; origErr(...a); };
const origLog = console.log; console.log = (...a) => { if (/^(PASS|FAIL|SKIP|\n|---)/.test(String(a[0] ?? ''))) origLog(...a); };
const origWarn = console.warn; console.warn = () => {};

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const setNative = (el, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const text = () => document.body.textContent;
const tags = () => $$('[data-testid="provenance-tag"]').map((t) => t.getAttribute('data-provenance'));
async function open(tab = 'ai') {
  H.unmount(); await waitFor(() => (!$('[data-testid="settings-modal"]') ? true : null));
  H.mount({ tab });
  await waitFor(() => $('[data-testid="settings-modal"]'));
  await waitFor(() => (!/Loading settings/.test(text()) ? true : null));
  await sleep(150);
}
const scopeButtons = () => $$('[data-testid^="scope-"][role="radio"]').map((b) => `${b.getAttribute('data-testid').slice(6)}:${b.getAttribute('aria-checked')}`);

/* 1. desktop, not linked */
report('\n--- 1. desktop, not linked ---');
await open('ai');
check('no scope switch, no banner: the device file is the only scope', !$('[data-testid="settings-scope"]') && !$('[data-testid="scope-device-banner"]'));
check('the device file loads (its provider shows) and no provenance tag is drawn', $('select, input') && /anthropic/.test($$('select').map((s) => s.value).join()) && tags().length === 0, $$('select').map((s) => s.value).join());

/* 2. linked, This device */
report('\n--- 2. desktop, linked, running on This device ---');
linked = true; controller.scope = 'device';
window.localStorage.clear();
await open('ai');
check('the switch shows This device | My account | Everyone (view) with This device checked', scopeButtons().join() === 'device:true,account:false,server:false' && /Everyone \(view\)/.test($('[data-testid="scope-server"]')?.textContent || ''), scopeButtons().join());
check('the banner: this computer uses its own settings; "Use my account\'s settings" offered', !!$('[data-testid="scope-device-banner"]') && !!$('[data-testid="scope-use-account"]'));
const sheet = await waitFor(() => $('[data-testid="copy-settings-sheet"]'));
check('the migration sheet opens once for a linked profile still on This device', !!sheet);
await waitFor(() => $('[data-testid="copy-JIRA_URL"]'));
check('it lists the device file\'s plain keys with their values and its secrets by name only', !!$('[data-testid="copy-JIRA_URL"]') && /https:\/\/jira\.example\.test/.test(sheet.textContent) && !!$('[data-testid="copy-ANTHROPIC_API_KEY"]') && /\(set\)/.test(sheet.textContent) && !sheet.textContent.includes(SECRET), sheet.textContent.slice(0, 400) + ' || ' + sheet.innerHTML.slice(0, 300));
if (!$('[data-testid="copy-JIRA_URL"]')) { report(`\n${total - failures}/${total} checks passed`); process.exit(1); }
check('a key the account already sets is flagged and unticked by default; the others are ticked', !!$('[data-testid="copy-conflict-DEFAULT_AI_PROVIDER"]') && $('[data-testid="copy-DEFAULT_AI_PROVIDER"]').checked === false && $('[data-testid="copy-JIRA_URL"]').checked === true && $('[data-testid="copy-JIRA_PAT"]').checked === true);
check('the localhost explanation is on the sheet', /"localhost" in an endpoint means the device that makes the call/.test(sheet.textContent));
click($('[data-testid="copy-not-now"]'));
await waitFor(() => (!$('[data-testid="copy-settings-sheet"]') ? true : null));
check('Not now closes it and remembers the answer', !$('[data-testid="copy-settings-sheet"]') && Object.keys(window.localStorage).some((k) => /settingsScopeMigrationAnswered/.test(k)));
await open('ai');
check('...so it does not open again', !$('[data-testid="copy-settings-sheet"]') && !!$('[data-testid="scope-device-banner"]'));
check('no provenance tags on This device', tags().length === 0);

/* 3. My account */
report('\n--- 3. My account ---');
ipc.length = 0;
click($('[data-testid="scope-account"]'));
await waitFor(() => ($('[data-testid="scope-account"]')?.getAttribute('aria-checked') === 'true' ? true : null));
await waitFor(() => (tags().length > 0 ? true : null));
check('choosing My account tells the controller (the computer now runs on the account) and loads the account values', ipc.some((c) => c[0] === 'setScope' && c[1] === 'account') && /qwen3:30b/.test($$('input').map((i) => i.value).join()), JSON.stringify(ipc));
const subTab = async (label) => { const b = $$('button').find((x) => x.textContent.trim() === label); click(b); await sleep(150); };
check('the Default Settings panel: every field carries a provenance tag - provider and model "your account", temperature "everyone" (the defaults), max tokens "not set"', tags().join() === 'your account,your account,everyone,not set', tags().join());
check('the temperature label reads everyone, the model label your account', (() => { const t = $$('label').find((l) => /Temperature/.test(l.textContent)); const m = $$('label').find((l) => /Model/.test(l.textContent)); return /everyone/.test(t?.textContent || '') && /your account/.test(m?.textContent || ''); })(), $$('label').map((l) => l.textContent.trim()).join(' | '));
await subTab('Custom/Ollama');
check('the Custom/Ollama panel: the endpoint set on the account is tagged "your account", its key "not set"', tags().join() === 'your account,not set' && /your account/.test($$('label').find((l) => /Custom Endpoint URL/.test(l.textContent))?.textContent || ''), tags().join());
check('the localhost hint sits under the endpoint field', !!$('[data-testid="endpoint-localhost-hint"]') && /device that makes the call/.test($('[data-testid="endpoint-localhost-hint"]').textContent));
await subTab('Anthropic');
check('the Anthropic panel: the key stored on the account shows as set, tagged "your account"; no secret value anywhere in the DOM', /your account/.test($$('label').find((l) => /Anthropic API Key/.test(l.textContent))?.textContent || '') && !text().includes(SECRET) && !document.body.innerHTML.includes(SECRET), $$('label').find((l) => /Anthropic API Key/.test(l.textContent))?.textContent);
check('the "last synced" line names the server', /Last synced .* with pi\.console/.test($('[data-testid="scope-synced"]')?.textContent || ''), $('[data-testid="scope-synced"]')?.textContent);
await subTab('Default Settings');
check('the account note: the computer runs on the account\'s settings, secrets stay in the keychain', /runs on your account.s settings/.test($('[data-testid="scope-account-note"]')?.textContent || ''));
// save: the model changes; ifRevision travels; a 409 shows
const modelInput = $$('input').find((i) => i.value === 'qwen3:30b');
setNative(modelInput, 'mistral'); await sleep(50);
accountSettings.revisions.DEFAULT_AI_MODEL = 5;  // "the phone saved meanwhile"
click($('[data-testid="settings-save"]'));
await waitFor(() => $('[data-testid="scope-conflict"]'));
check('Save sends the values, the typed secrets only and ifRevision to the controller; a stale key is refused (409) with the conflict and a Reload', ipc.some((c) => c[0] === 'write' && c[1].values.DEFAULT_AI_MODEL === 'mistral' && c[1].ifRevision && c[1].ifRevision.DEFAULT_AI_MODEL === 3 && Object.keys(c[1].secrets).length === 0) && /Changed on another device/.test(text()) && !!$('[data-testid="scope-conflict"]'), JSON.stringify(ipc.filter((c) => c[0] === 'write')));
click($('[data-testid="scope-conflict"] button'));
await waitFor(() => (!$('[data-testid="scope-conflict"]') ? true : null));
await waitFor(() => $$('input').find((i) => i.value === 'qwen3:30b'));
setNative($$('input').find((i) => i.value === 'qwen3:30b'), 'mistral'); await sleep(50);
click($('[data-testid="settings-save"]'));
await waitFor(() => (accountSettings.values.DEFAULT_AI_MODEL === 'mistral' ? true : null), 8000);
check('after a reload (revision 5 now) the save goes through to the account', accountSettings.values.DEFAULT_AI_MODEL === 'mistral' && ipc.some((c) => c[0] === 'write' && c[1].ifRevision?.DEFAULT_AI_MODEL === 5), JSON.stringify(ipc.filter((c) => c[0] === 'write').map((c) => c[1].ifRevision)));

/* 4. unsaved guard */
report('\n--- 4. unsaved changes when switching ---');
setNative($$('input').find((i) => i.value === 'mistral'), 'phi'); await sleep(50);
click($('[data-testid="scope-device"]'));
await waitFor(() => $('[data-testid="scope-unsaved"]'));
check('switching with unsaved edits asks: Save then switch / Discard and switch / Stay', !!$('[data-testid="scope-save-first"]') && !!$('[data-testid="scope-discard"]') && !!$('[data-testid="scope-stay"]') && $('[data-testid="scope-account"]').getAttribute('aria-checked') === 'true');
click($('[data-testid="scope-stay"]'));
await sleep(50);
check('Stay keeps the scope and the edit', !$('[data-testid="scope-unsaved"]') && $('[data-testid="scope-account"]').getAttribute('aria-checked') === 'true' && $$('input').some((i) => i.value === 'phi'));
click($('[data-testid="scope-device"]'));
await waitFor(() => $('[data-testid="scope-discard"]'));
click($('[data-testid="scope-discard"]'));
await waitFor(() => ($('[data-testid="scope-device"]')?.getAttribute('aria-checked') === 'true' ? true : null));
await sleep(150);
check('Discard and switch: This device again, its own file loaded (the edit gone, the device provider anthropic), the controller told', $('[data-testid="scope-device"]').getAttribute('aria-checked') === 'true' && ipc.filter((c) => c[0] === 'setScope').pop()?.[1] === 'device' && !$$('input').some((i) => i.value === 'phi') && $$('select').some((sel) => sel.value === 'anthropic'), $$('select').map((sel) => sel.value).join());

/* 5. Everyone */
report('\n--- 5. Everyone ---');
click($('[data-testid="scope-server"]'));
await waitFor(() => $('[data-testid="settings-panels-readonly"]'));
check('as a non-administrator Everyone is a view: a disabled fieldset, no Save button, the note', !!$('[data-testid="settings-panels-readonly"]') && $('[data-testid="settings-panels-readonly"]').disabled === true && !$('[data-testid="settings-save"]') && /Set by the administrator of pi\.console/.test($('[data-testid="scope-server-note"]')?.textContent || ''));
check('...showing the server defaults, no tags', /0\.2/.test($$('input').map((i) => i.value).join()) && tags().length === 0);
me = { ...me, role: 'admin' };
await open('ai');
click($('[data-testid="scope-server"]'));
await waitFor(() => $('[data-testid="settings-panels-editable"]'));
check('as an administrator Everyone is editable, with Save and the password note', !!$('[data-testid="settings-panels-editable"]') && !!$('[data-testid="settings-save"]') && /saving asks for your password/.test($('[data-testid="scope-server-note"]')?.textContent || '') && /^Everyone$/.test($('[data-testid="scope-server"]').textContent.trim()), `${$('[data-testid="scope-server-note"]')?.textContent} | editable=${!!$('[data-testid="settings-panels-editable"]')}`);
calls.length = 0;
await waitFor(() => $$('input').find((i) => i.value === '0.2'));
const tempInput = $$('input').find((i) => i.value === '0.2');
if (!tempInput) { check('the temperature field (0.2) is present on the admin view', false, $$('input').map((i) => i.value).join()); report(`\n${total - failures}/${total} checks passed`); process.exit(1); }
setNative(tempInput, '0.5'); await sleep(50);
click($('[data-testid="settings-save"]'));
await waitFor(() => (calls.some((c) => /admin\/settings/.test(c.url)) ? true : null));
check('Save as an administrator PUTs /api/admin/settings over the home server (the step-up retry is auth.js\'s)', calls.some((c) => /admin\/settings/.test(c.url) && c.body.values.DEFAULT_AI_TEMPERATURE === '0.5' && c.body.ifRevision), JSON.stringify(calls));
me = { ...me, role: 'user' };

/* 6. revocation + the General tab */
report('\n--- 6. the controller\'s change event, the General tab ---');
controller.scope = 'account';
await open('ai');
await waitFor(() => ($('[data-testid="scope-account"]')?.getAttribute('aria-checked') === 'true' ? true : null));
controller.scope = 'device';
changeListener({ ...accountState(), scope: 'device', available: false });  // the link record stays, the account settings are gone
await waitFor(() => ($('[data-testid="scope-device"]')?.getAttribute('aria-checked') === 'true' ? true : null));
check('a wipe reported by the main process (a revoked token) flips the dialog back to This device', $('[data-testid="scope-device"]')?.getAttribute('aria-checked') === 'true' && !!$('[data-testid="scope-device-banner"]'), scopeButtons().join());
controller.scope = 'device';
await open('general');
const hs = await waitFor(() => $('[data-testid="home-server-settings-scope"]'));
check('General > Home server says which settings the computer uses and offers the copy', !!hs && /uses its own settings/.test(hs.textContent) && !!$('[data-testid="home-server-copy-settings"]'));
click($('[data-testid="home-server-copy-settings"]'));
const sheet2 = await waitFor(() => $('[data-testid="copy-settings-sheet"]'));
check('...which opens the migration sheet again', !!sheet2);

/* 7. the copy */
report('\n--- 7. Copy ---');
ipc.length = 0;
await waitFor(() => $('[data-testid="copy-JIRA_URL"]'));
check('keys the account already holds (the provider, the endpoint, the Anthropic key) are unticked by default; the others ticked', $('[data-testid="copy-DEFAULT_AI_PROVIDER"]').checked === false && $('[data-testid="copy-CUSTOM_AI_ENDPOINT"]').checked === false && $('[data-testid="copy-ANTHROPIC_API_KEY"]').checked === false && $('[data-testid="copy-JIRA_URL"]').checked === true && $('[data-testid="copy-JIRA_PAT"]').checked === true);
click($('[data-testid="copy-CUSTOM_AI_ENDPOINT"]')); await sleep(30);  // tick: replace the account's endpoint with this device's
click($('[data-testid="copy-confirm"]'));
await waitFor(() => (!$('[data-testid="copy-settings-sheet"]') ? true : null), 8000);
const copy = ipc.find((c) => c[0] === 'copy');
check('Copy sends the ticked plain keys and secrets BY NAME to the controller (the unticked ones stay), then the scope is My account', !!copy && copy[1].plainKeys.sort().join() === 'CUSTOM_AI_ENDPOINT,JIRA_URL' && copy[1].secretKeys.join() === 'JIRA_PAT' && ipc.some((c) => c[0] === 'setScope' && c[1] === 'account'), JSON.stringify(ipc));

/* 8. the web */
report('\n--- 8. the web, signed in ---');
delete window.electronAPI;
capabilities = { auth: { mode: 'accounts', user: { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user' }, admin: false }, capabilities: { settings: true } };
await H.initializePlatform();
await open('ai');
check('a browser signed in: My account | Everyone (view) only, My account checked', scopeButtons().join() === 'account:true,server:false', scopeButtons().join());
check('the tags come from the account values and the inherited defaults', tags().includes('your account') && tags().includes('everyone') && tags().includes('not set'), tags().join() + ' || ' + fetchLog.slice(-8).join(' ; ') + ' || electronAPI=' + typeof window.electronAPI);
check('the inherited note lists the defaults keys', /Inherited from the server defaults until you set your own: DEFAULT_AI_TEMPERATURE, OPENAI_API_KEY/.test(text()));
check('an inherited field names the server default next to its tag ("everyone: 0.2") since the field itself is the account\'s (empty)', $$('[data-testid="provenance-tag"]').some((t) => t.getAttribute('data-provenance') === 'everyone' && /everyone: 0\.2/.test(t.textContent)), $$('[data-testid="provenance-tag"]').map((t) => t.textContent).join(' | '));
calls.length = 0;
setNative($$('input').find((i) => i.value === 'mistral'), 'gemma'); await sleep(50);
click($('[data-testid="settings-save"]'));
await waitFor(() => (calls.length ? true : null));
check('Save PUTs /api/settings with ifRevision', calls.some((c) => /\/api\/settings$/.test(c.url) && c.body.values.DEFAULT_AI_MODEL === 'gemma' && c.body.ifRevision), JSON.stringify(calls));

/* 9. wording */
report('\n--- 9. wording ---');
const uiFiles = ['src/components/common/modals/SettingsModal.jsx', 'src/components/common/modals/settings/CopySettingsSheet.jsx', 'src/components/common/modals/settings/GeneralSettings.jsx', 'src/components/common/modals/settings/ai-providers/CustomAISettings.jsx', 'electron/account-settings.cjs', 'docs/DESKTOP.md', 'docs/SELF_HOSTING.md'];
const offenders = uiFiles.filter((f) => /\b(this|the|your) (Mac|computer)\b/i.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
check('the feature says "this device", never "Mac" or "computer" (the app runs on Linux too)', offenders.length === 0, offenders.join(', '));
check('the sheet\'s title is "Copy this device\'s settings to your account?"', /Copy this device&apos;s settings to your account/.test(fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/CopySettingsSheet.jsx'), 'utf8')));

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
