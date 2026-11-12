/**
 * Settings > Theme and Settings > Debug (src/components/common/modals/
 * settings/ThemeSettings.jsx, DebugSettings.jsx): the Appearance & Behavior
 * section that lived under General became two categories of the rail -
 * Theme (Color Scheme) and Debug (the debug status bar) - with the
 * behaviour kept: everything applies as you make it, the debug bar exists
 * in the desktop app only. The UI Scale control is gone from Theme: the
 * window's zoom stays the desktop's View menu (Cmd/Ctrl +, - and 0, the
 * factor persisted by electron/main.cjs); the app's text and interface size
 * is Settings > Accessibility > Text size.
 *
 *   static: the rail order and ids (General, Editor, Theme, Performance, Integrations,
 *     AI Providers, Shortcuts, Debug, About), the dialog rendering the two
 *     panels with the state it already kept, General without the section,
 *     the controls, the props or the zoom table, the footer's "apply as you
 *     make them" for every non-env tab, openAppSettings('theme' | 'debug')
 *     reaching the dialog's initialTab unchanged;
 *   jsdom, the REAL panels: on the desktop (a fake bridge) the Color Scheme
 *     select changes the theme at once, no UI Scale select anywhere, the
 *     debug toggle switches the bar; in a browser Debug shows the
 *     desktop-only note instead of a switch;
 *   jsdom, the REAL dialog (the shortcuts test's harness): opened with
 *     initialTab 'theme' it shows the Theme panel, with 'debug' the Debug
 *     panel, and General shows neither control.
 *
 * Needs esbuild, jsdom and fake-indexeddb. Run: node tests/settings-theme-debug.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------
const modal = read('src/components/common/modals/SettingsModal.jsx');
const general = read('src/components/common/modals/settings/GeneralSettings.jsx');
const themeSrc = read('src/components/common/modals/settings/ThemeSettings.jsx');
const debugSrc = read('src/components/common/modals/settings/DebugSettings.jsx');
check('the rail: General, Editor, Theme, Performance, Accessibility, Integrations, AI Providers, Shortcuts, Debug, About (ids theme, performance and debug)', /\{ id: 'general', label: 'General' \},\s*\{ id: 'editor', label: 'Editor' \},\s*\{ id: 'theme', label: 'Theme' \},\s*\{ id: 'performance', label: 'Performance' \},\s*\{ id: 'accessibility', label: 'Accessibility' \},\s*\{ id: 'integrations'/.test(modal) && /\{ id: 'ai', label: SETTINGS_FIELDS\.ai\.tab \},\s*\.\.\.\(isMobile \? \[\] : \[\{ id: 'shortcuts', label: 'Shortcuts' \}\]\),\s*\.\.\.\(accounts && admin[^\n]*\n\s*\{ id: 'debug', label: 'Debug' \},\s*\{ id: 'about', label: 'About' \}/.test(modal));
check('the dialog renders ThemeSettings (theme only: no zoom state, mirror or handler left) and DebugSettings from the state it kept, and General gets none of those props', /activeTab === 'theme' && \(\s*<ThemeSettings theme=\{theme\} setTheme=\{setTheme\} \/>/.test(modal) && !/zoomFactor|handleZoomChange|getZoomFactor|onZoomFactorChanged/.test(modal) && /activeTab === 'debug' && \(\s*<DebugSettings debugBarEnabled=\{debugBarEnabled\} setDebugBarEnabled=\{handleDebugBarChange\} \/>/.test(modal) && !/<GeneralSettings[\s\S]*?setTheme=/.test(modal) && !/<GeneralSettings[\s\S]*?setZoomFactor=/.test(modal) && !/<GeneralSettings[\s\S]*?setDebugBarEnabled=/.test(modal));
check('General no longer has the section, the controls, the props or the zoom table', !/Appearance & Behavior/.test(general) && !/Color Scheme/.test(general) && !/UI Scale/.test(general) && !/debug status bar/.test(general) && !/ZOOM_LEVELS|closestZoomLevel|setTheme|setZoomFactor|setDebugBarEnabled/.test(general) && !/GRADIENT_THEMES|DARK_THEMES/.test(general));
check('ThemeSettings has the scheme gallery (one picker: the tiles, no select) with the hints, and no UI Scale control, zoom table or zoom props any more', /<SchemeGallery theme=\{theme\} customThemes=\{customThemes\} onSelect=\{select\}/.test(themeSrc) && !/theme-color-scheme/.test(themeSrc) && /Auto follows the system and uses Jacaranda as its dark theme/.test(themeSrc) && !/UI Scale|ZOOM_LEVELS|closestZoomLevel|zoomSupported|setZoomFactor|zoomFactor/.test(themeSrc));
check('DebugSettings has the debug status bar toggle with its hint, desktop-only, and the note for a browser', /<Toggle label="Show debug status bar" checked=\{debugBarEnabled === true\} onChange=\{setDebugBarEnabled\} testId="debug-status-bar-toggle"/.test(debugSrc) && /Live FPS plus CPU and memory usage/.test(debugSrc) && /window\.electronAPI\?\.setDebugBarEnabled/.test(debugSrc) && /testId="debug-desktop-only"/.test(debugSrc));
check('both panels use the shared primitives (Section, Field, Select, Toggle, Note) and no one-off styling', /from '\.\/ui'/.test(themeSrc) && /from '\.\/ui'/.test(debugSrc) && !/style=\{\{(?!\s*background: GRADIENT_THEMES)/.test(themeSrc) && !/style=\{\{/.test(debugSrc));
check("the footer keeps 'Changes on this tab apply as you make them.' for every tab but Integrations / AI Providers (Theme and Debug included)", /const envTab = activeTab === 'integrations' \|\| activeTab === 'ai';/.test(modal) && /'Changes on this tab apply as you make them\.'/.test(modal));
check("openAppSettings('theme' | 'debug') reaches the dialog: the opener's tab goes to initialTab as it is", /if \(isOpen\) setActiveTab\(initialTab \|\| 'general'\);/.test(modal) && /setAppSettingsTab\(event\?\.detail\?\.tab \|\| 'general'\)/.test(read('src/components/CompactSidebar.jsx')) && /export function openAppSettings\(tab = 'general'/.test(read('src/utils/openSettings.js')));
const openersAtGeneral = [...read('src/components/features/documents/DocumentSidebar.jsx').matchAll(/openAppSettings\('general'\)/g)].length + [...read('src/utils/centralAvailability.js').matchAll(/openAppSettings\('general'\)/g)].length;
check('the openers that go to General do so for General itself (the Settings menu item, the home-server hint) - none for the scheme, the scale or the debug bar', openersAtGeneral === 2 && !/openAppSettings\('general'[^)]*(theme|scale|zoom|debug)/i.test(read('src/components/features/documents/DocumentSidebar.jsx')));

// ---------------------------------------------------------------------------
// jsdom
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-theme-debug-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  export { act } from 'react';
  export * as React from 'react';
  export { createRoot };
  export { default as ThemeSettings } from '@worktree/src/components/common/modals/settings/ThemeSettings.jsx';
  export { default as DebugSettings } from '@worktree/src/components/common/modals/settings/DebugSettings.jsx';
  export { default as SettingsModal } from '@worktree/src/components/common/modals/SettingsModal.jsx';
  export { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
  export { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
  export { initializePlatform } from '@worktree/src/utils/platform.js';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'sessionStorage']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url) => { const u = String(url); if (/\/api\/capabilities/.test(u)) return json({ auth: { mode: 'none' }, capabilities: { settings: false } }); return json({ error: 'not mocked ' + u }, 404); };
define('fetch', stubFetch); window.fetch = stubFetch;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|Error loading|not mocked|Failed to/.test(String(a[0] ?? ''))) return; origErr(...a); };
console.warn = () => {};
const { ThemeSettings, DebugSettings, SettingsModal, ThemeProvider, NotificationProvider, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(30); }); };
const select = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }); };

// ---- the panels on the desktop (a fake bridge) ----
const calls = { zoom: [], debug: [], theme: [] };
window.electronAPI = { isElectron: true, setZoomFactor: async (f) => { calls.zoom.push(f); }, setDebugBarEnabled: async (on) => { calls.debug.push(on); }, getDebugBarEnabled: async () => false };
await render(React.createElement(ThemeSettings, { theme: 'auto', setTheme: (t) => calls.theme.push(t) }));
check('desktop Theme: the scheme gallery (Auto active, Light, the dark themes, the gradient themes, the palettes) and no UI Scale select', !!$('[data-testid="scheme-gallery"]') && $('[data-testid="scheme-card-auto"]')?.getAttribute('aria-checked') === 'true' && !!$('[data-testid="scheme-card-light"]') && !!$('[data-testid="scheme-card-dark-neutral"]') && !!$('[data-testid="scheme-card-gradient-red-purple"]') && !!$('[data-testid="scheme-card-starter-nord"]') && !$('[data-testid="theme-ui-scale"]') && !/UI Scale/.test(document.body.textContent));
await click($('[data-testid="scheme-card-light"]'));
check('...changing the scheme calls setTheme at once (no Save)', calls.theme.join() === 'light');
check('...and nothing in the panel touches the zoom bridge', calls.zoom.length === 0);
await render(React.createElement(DebugSettings, { debugBarEnabled: false, setDebugBarEnabled: (on) => calls.debug.push(on) }));
const toggle = $('[data-testid="debug-status-bar-toggle"]');
check('desktop Debug: the "Show debug status bar" toggle, off', !!toggle && !$('[data-testid="debug-desktop-only"]'));
await click(toggle.matches('input') ? toggle : (toggle.querySelector('input,button') || toggle));
check('...the toggle switches the bar on at once', calls.debug.join() === 'true', calls.debug.join());
await render(null);

// ---- the panels in a browser ----
window.electronAPI = undefined;
await render(React.createElement(ThemeSettings, { theme: 'auto', setTheme: () => {} }));
check('browser Theme: the scheme gallery, no UI Scale', !!$('[data-testid="scheme-gallery"]') && !$('[data-testid="theme-ui-scale"]') && !/UI Scale/.test(document.body.textContent));
await render(React.createElement(DebugSettings, { debugBarEnabled: false, setDebugBarEnabled: () => {} }));
check('browser Debug: the desktop-only note instead of a switch', !!$('[data-testid="debug-desktop-only"]') && !$('[data-testid="debug-status-bar-toggle"]'));
await render(null);

// ---- the real dialog, opened on each tab ----
window.electronAPI = {
  isElectron: true, setZoomFactor: async () => {}, getZoomFactor: async () => 0.9, setDebugBarEnabled: async () => {}, getDebugBarEnabled: async () => false, onDebugBarChanged: () => () => {},
  getMachineId: async () => 'm', getUsername: async () => 'user', getHostname: async () => 'host', getAppVersion: async () => '0.0.0', getProfileName: async () => 'default',
  homeServerStatus: async () => ({ linked: false }), homeServerVersion: async () => ({ desktop: { app: '0.0.0', protocol: 2 }, server: { reachable: false, linked: false } }),
};
const dialog = (tab) => React.createElement(NotificationProvider, null, React.createElement(ThemeProvider, null, React.createElement(SettingsModal, { key: tab, isOpen: true, onClose: () => {}, initialTab: tab })));
await render(dialog('theme'));
const railLabels = () => $$('[data-testid="settings-modal"] .sc-rail-tab').map((t) => t.textContent.trim());
check("the dialog opened at 'theme': the rail with Theme after Editor and Debug before About, the Theme panel shown", railLabels().join() === 'General,Editor,Theme,Performance,Accessibility,Integrations,AI Providers,Shortcuts,Debug,About' && !!$('[data-testid="theme-section"]') && !!$('[data-testid="scheme-gallery"]'), railLabels().join());
check('...the footer says the tab applies as you go', /Changes on this tab apply as you make them\./.test($('[data-testid="settings-modal"]')?.parentElement?.textContent || document.body.textContent));
await render(dialog('debug'));
check("the dialog opened at 'debug': the Debug panel with the toggle", !!$('[data-testid="debug-section"]') && !!$('[data-testid="debug-status-bar-toggle"]'));
await render(dialog('general'));
const body = $('[data-testid="settings-body"]')?.textContent || '';
check('the dialog opened at General: no Color Scheme, UI Scale or debug status bar there any more', !/Color Scheme|UI Scale|debug status bar/.test(body) && !$('[data-testid="scheme-gallery"]') && !$('[data-testid="debug-status-bar-toggle"]'));
await render(null);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
