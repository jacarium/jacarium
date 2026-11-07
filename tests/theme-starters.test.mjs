/**
 * The starter themes (src/utils/themeStarters.js) and the Theme page built
 * on them (Settings > Theme: the scheme gallery and Customize):
 *
 *  1. every starter validates against the theme schema, raises no contrast
 *     warning, derives the tokens, and is frozen (a read-only template);
 *     themeFromStarter gives a new id each time and leaves the starter alone;
 *     a palette is a scheme of its own ('starter-nord') applied from the
 *     template
 *  2. the built-in starters agree with the app's schemes: the gradient
 *     names / stops with ThemeContext's GRADIENT_THEMES, the surfaces with
 *     the tokens in src/index.css, the marks with the gradient themes' paint
 *  3. each palette carries its source URL and licence in the module's
 *     header; the starters are never exported (nothing in the export reads
 *     them) and never stored; the gallery is built from the shared
 *     primitives as a radio group
 *  4. jsdom: the gallery lists every scheme (a tile with the mark in the
 *     scheme's logo colours and the swatch strip; Auto active); a click
 *     switches at once (a palette from its template, nothing stored); the
 *     arrow keys / Home / End choose; Customize is prefilled from the scheme
 *     on screen ("Nord (custom)") with no warning; an edit previews live
 *     and Save as new theme creates a theme of the user's under a new id,
 *     chosen; on it, Save saves in place, Save as new copies, Reset returns;
 *     switching tiles with changes asks first; Delete removes it; Export
 *     JSON opens the ExportJsonModal (the theme file, selected, Copy to the
 *     clipboard, Download) and the copied text imports through Import JSON
 *     (paste, Dry Run, Import) as the identical theme under a new id
 *
 * Needs esbuild, jsdom and fake-indexeddb for part 4 (skipped without).
 * Run: node tests/theme-starters.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = await import(path.join(REPO, 'src/utils/themeStarters.js'));
const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
const { THEME_STARTERS, themeFromStarter, themeCopy, starterForScheme, starterSchemeTheme, schemeStarter, isStarterScheme, starterSchemeId, schemeModel } = st;

// ---------------------------------------------------------------------------
// 1. every starter
// ---------------------------------------------------------------------------
const builtIn = THEME_STARTERS.filter((s) => s.group === 'Built-in schemes');
const palettes = THEME_STARTERS.filter((s) => s.group === 'Palettes');
const crazy = THEME_STARTERS.filter((s) => s.group === 'Crazy');
check('the starters: 8 built-in schemes (Light, Jacaranda, the neutral dark, the five gradient themes) 11 palettes and 6 Crazy showcase schemes, unique ids and names', builtIn.length === 8 && palettes.length === 11 && crazy.length === 6 && new Set(THEME_STARTERS.map((s) => s.id)).size === 25 && new Set(THEME_STARTERS.map((s) => s.name)).size === 25, THEME_STARTERS.map((s) => s.id).join());
check('the Crazy group: Synthwave 84, Aurora Borealis, Lava Lamp, Deep Ocean, Cotton Candy, Toxic Neon, each with a gradient rail (linear or radial), validated, no contrast warning', crazy.map((s) => s.id).join() === 'synthwave-84,aurora-borealis,lava-lamp,deep-ocean,cotton-candy,toxic-neon' && crazy.every((s) => ['linear', 'radial'].includes(s.theme.fills.rail.type)) && crazy.every((s) => { const t = themeFromStarter(s); return ct.contrastWarnings(t).every((w) => w.ratio >= w.min); }), crazy.map((s) => s.id).join());
check('the palettes asked for: Nord, Dracula, Solarized dark and light, Gruvbox dark, One Dark, Tokyo Night, Catppuccin Mocha and Latte, GitHub dark and light', ['nord', 'dracula', 'solarized-dark', 'solarized-light', 'gruvbox-dark', 'one-dark', 'tokyo-night', 'catppuccin-mocha', 'catppuccin-latte', 'github-dark', 'github-light'].every((id) => palettes.some((s) => s.id === id)));
for (const s of THEME_STARTERS) {
  let theme = null, err = '';
  try { theme = themeFromStarter(s); } catch (e) { err = e.message; }
  const warnings = theme ? ct.contrastWarnings(theme).filter((w) => w.ratio < w.min) : [];
  const tokens = theme ? ct.deriveTokens(theme) : {};
  check(`${s.name}: validates, no contrast warning, ${Object.keys(tokens).length} tokens derived, the mark's arch in them`, !!theme && warnings.length === 0 && Object.keys(tokens).length >= 60 && tokens['--mark-arch'] === s.theme.colors.markArch && tokens['--os-canvas'] === s.theme.colors.canvas && ct.BASES.includes(theme.base), err || JSON.stringify(warnings.map((w) => `${w.what} ${w.ratio}<${w.min}`)));
  // the AI chat bubbles: the user's text on its bubble and the reply's links on the secondary card read (4.5:1)
  const chatUser = theme ? ct.contrastRatio(tokens['--chat-user-text'], tokens['--chat-user-bg']) : 0;
  const chatLink = theme ? ct.contrastRatio(tokens['--chat-link'], s.theme.colors.cardSecondary) : 0;
  check(`${s.name}: the chat bubbles read - user text ${chatUser.toFixed(2)}:1 on the bubble, reply links ${chatLink.toFixed(2)}:1 on the secondary card`, chatUser >= 4.5 && chatLink >= 4.5, JSON.stringify([tokens['--chat-user-text'], tokens['--chat-user-bg'], tokens['--chat-link'], s.theme.colors.cardSecondary]));
}
{
  const nord = palettes.find((s) => s.id === 'nord');
  const before = JSON.stringify(nord);
  const a = themeFromStarter(nord), b = themeFromStarter(nord, [a]);
  check('themeFromStarter: a fresh ct- id each time, the name made unique against the existing list, the colours copied', /^ct-/.test(a.id) && /^ct-/.test(b.id) && a.id !== b.id && a.name === 'Nord' && b.name === 'Nord (copy)' && a.colors !== nord.theme.colors && a.colors.canvas === '#2e3440' && a.createdAt && a.updatedAt);
  a.colors.canvas = '#000000';
  check('...the starter is untouched afterwards and frozen through (colours, fills, the list)', JSON.stringify(nord) === before && Object.isFrozen(THEME_STARTERS) && Object.isFrozen(nord) && Object.isFrozen(nord.theme.colors) && Object.isFrozen(nord.theme.fills.rail));
  const copy = themeCopy(a, [a]);
  check('themeCopy: a new id and "(copy)" after the name, the colours and fill kept', copy.id !== a.id && /^ct-/.test(copy.id) && copy.name === 'Nord (copy)' && copy.colors.canvas === '#000000' && copy.fills.rail.color === a.fills.rail.color);
  check('starterForScheme: the built-in scheme ids resolve (gradient-red-purple -> Magma, dark -> Jacaranda, light); auto and a custom scheme do not', starterForScheme('gradient-red-purple').name === 'Magma' && starterForScheme('dark').name === 'Jacaranda (dark)' && starterForScheme('light').name === 'Light' && starterForScheme('dark-neutral').name === 'Dark (neutral)' && starterForScheme('auto') === null && starterForScheme('custom-ct-x') === null && starterForScheme('nord') === null);
  const t1 = starterSchemeTheme('starter-nord'), t2 = starterSchemeTheme('starter-nord');
  check('a palette as a scheme: isStarterScheme / starterSchemeId / schemeStarter, starterSchemeTheme one frozen validated theme per palette (Nord\'s canvas), null for a built-in or unknown id', isStarterScheme('starter-nord') && !isStarterScheme('nord') && !isStarterScheme('custom-ct-x') && starterSchemeId(nord) === 'starter-nord' && schemeStarter('starter-nord') === nord && schemeStarter('starter-dark') === null && t1 === t2 && Object.isFrozen(t1) && t1.colors.canvas === '#2e3440' && /^ct-/.test(t1.id) && starterSchemeTheme('starter-x') === null && starterSchemeTheme('dark') === null);
  const mine = { ...t1, id: 'ct-mine00000000', name: 'Mine' };
  check('schemeModel: Auto through the system (dark / light), a built-in scheme through its starter, a palette, a saved theme by its scheme id, null otherwise', schemeModel('auto', [], true) === starterForScheme('dark').theme && schemeModel('auto', [], false) === starterForScheme('light').theme && schemeModel('gradient-red-purple', []) === starterForScheme('gradient-red-purple').theme && schemeModel('starter-nord', []) === t1 && schemeModel('custom-ct-mine00000000', [mine]) === mine && schemeModel('custom-ct-none', [mine]) === null);
}

// ---------------------------------------------------------------------------
// 2. the built-in starters against the app's schemes
// ---------------------------------------------------------------------------
{
  const ctxSrc = read('src/contexts/ThemeContext.jsx');
  const css = read('src/index.css');
  let agree = true, detail = [];
  for (const key of ['gradient-red-purple', 'gradient-blue-purple', 'gradient-green-blue', 'gradient-orange-red', 'gradient-pink-purple']) {
    const m = ctxSrc.match(new RegExp(`'${key}': \\{[^}]*name: '([^']+)'[^}]*from: '([^']+)'[^}]*to: '([^']+)'`));
    const s = starterForScheme(key);
    const ok = !!m && !!s && s.name === m[1] && s.theme.fills.rail.type === 'linear' && s.theme.fills.rail.stops[0].color === m[2].toLowerCase() && s.theme.fills.rail.stops[1].color === m[3].toLowerCase();
    if (!ok) { agree = false; detail.push(`${key}: ${m && m.slice(1).join('/')} vs ${s && s.name}/${s && JSON.stringify(s.theme.fills.rail)}`); }
    const mark = css.match(new RegExp(`\\[data-theme="${key}"\\]\\s*\\{\\s*--mark-arch:\\s*(#[0-9a-fA-F]{6});\\s*--mark-blossom:\\s*(#[0-9a-fA-F]{6})`));
    if (!mark || !s || s.theme.colors.markArch !== mark[1].toLowerCase() || s.theme.colors.markBlossom !== mark[2].toLowerCase()) { agree = false; detail.push(`${key} mark: ${mark && mark.slice(1).join('/')} vs ${s && s.theme.colors.markArch}/${s && s.theme.colors.markBlossom}`); }
  }
  check('the gradient starters carry ThemeContext\'s names and from / to stops as a linear rail, and the marks index.css paints for [data-theme="gradient-*"]', agree, detail.join(' | '));
  const neutral = css.slice(css.indexOf('.dark[data-dark-variant="neutral"]'), css.indexOf('.dark[data-dark-variant="neutral"]') + 12000);
  const n = starterForScheme('dark-neutral').theme.colors;
  const tok = (block, name) => (block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`)) || [])[1]?.toLowerCase();
  check('the neutral dark starter takes the .dark[data-dark-variant="neutral"] tokens (canvas, card, secondary card, border, the text colours)', tok(neutral, '--os-canvas') === n.canvas && tok(neutral, '--os-card') === n.card && tok(neutral, '--os-card-secondary') === n.cardSecondary && tok(neutral, '--os-border') === n.border && tok(neutral, '--os-text-primary') === n.textPrimary && tok(neutral, '--os-text-secondary') === n.textSecondary, JSON.stringify([tok(neutral, '--os-canvas'), tok(neutral, '--os-card'), tok(neutral, '--os-card-secondary'), tok(neutral, '--os-border'), tok(neutral, '--os-text-primary'), tok(neutral, '--os-text-secondary'), n]));
  const j = starterForScheme('dark').theme.colors, l = starterForScheme('light').theme.colors;
  const darkDefaults = ct.defaultTheme('dark').colors, lightDefaults = ct.defaultTheme('light').colors;
  check('the Jacaranda and Light starters are the editor\'s dark and light bases (the defaults a blank theme has)', j.canvas === darkDefaults.canvas && j.accent === darkDefaults.accent && l.canvas === lightDefaults.canvas && l.card === '#ffffff' && starterForScheme('light').theme.base === 'light');
  check('ThemeContext applies a palette scheme from its template (starterSchemeTheme) and falls back to Auto for an unknown one; the sidebar paints the rail fill for token schemes (custom or palette)', /if \(!custom && isStarterScheme\(themeMode\)\) \{\s*custom = starterSchemeTheme\(themeMode\);\s*if \(!custom\) themeMode = 'auto';/.test(ctxSrc) && /export const isTokenScheme = \(scheme\) => isCustomScheme\(scheme\) \|\| isStarterScheme\(scheme\);/.test(ctxSrc) && /isTokenScheme\(theme\)/.test(read('src/components/CompactSidebar.jsx')));
}

// ---------------------------------------------------------------------------
// 3. provenance; never exported, never stored; the gallery's build
// ---------------------------------------------------------------------------
{
  const src = read('src/utils/themeStarters.js');
  const header = src.slice(0, src.indexOf('export const THEME_STARTERS'));
  const missing = palettes.filter((s) => !s.source || !s.source.url || !header.includes(s.source.url) || !/^(MIT)$/.test(s.source.licence) || !new RegExp(`${s.source.name.replace(/[()]/g, '\\$&')}\\s+${s.source.licence}\\s+${s.source.url.replace(/[./]/g, '\\$&')}`).test(header));
  check('every palette names its source URL and licence (all MIT) in the module header and on the starter', missing.length === 0, missing.map((s) => s.id).join());
  check('the names are the palettes\' names only: no logo or wordmark file is referenced', !/\.(svg|png)/.test(src) && !/logo/i.test(src.replace(/logo colours|logoTone/g, '')));
  check('the export reads the stored themes only (nothing of the starters): exportDatabase and importDatabase do not import themeStarters', !/themeStarters/.test(read('src/utils/exportDatabase.js')) && !/themeStarters/.test(read('src/utils/importDatabase.js')) && /customThemesExportSection\(loadCustomThemes\(\)\)/.test(read('src/utils/exportDatabase.js')));
  const gallery = read('src/components/common/modals/settings/SchemeGallery.jsx');
  check('the gallery is a radio group of tiles (role radio, aria-checked, a roving tab stop, the arrows / Home / End) with the BrandMark, one tile per scheme, the groups by heading only (no nested cards or one-off borders)', /role="radiogroup"/.test(gallery) && /role="radio"/.test(gallery) && /aria-checked=\{active\}/.test(gallery) && /tabIndex=\{i === activeIndex \? 0 : -1\}/.test(gallery) && /ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1/.test(gallery) && /BrandMark size=\{28\}/.test(gallery) && /scheme-card-\$\{id\}/.test(gallery) && !/rounded-(lg|xl|md|full)/.test(gallery) && !/<Card|<Group/.test(gallery) && (gallery.match(/text-xs font-medium text-os-text-primary mb-2/g) || []).length === 1);
  const editor = read('src/components/common/modals/settings/CustomThemeEditor.jsx');
  check('Customize sits in the Theme section itself (the editor is no nested card; its buttons come from the page)', !/<Card/.test(editor) && /\{footer\}/.test(editor) && /data-testid="custom-theme-editor"/.test(editor));
  const modal = read('src/components/common/ExportJsonModal.jsx');
  check('ExportJsonModal (src/components/common): the shared TextArea read-only, selected on open, Copy through the app\'s clipboard helper, Download through downloadBlob, no chord handler of its own (Ctrl/Cmd+A / +C are the textarea\'s; the registry owns the chords)', /import \{ Button, ButtonRow, TextArea \} from '\.\.\/ui\/primitives'/.test(modal) && /readOnly/.test(modal) && /boxRef\.current\?\.select\(\)/.test(modal) && /copyToClipboard\(text\)/.test(modal) && /downloadBlob\(new Blob\(\[text\]/.test(modal) && !/onKeyDown/.test(modal) && !/ctrlKey|metaKey/.test(modal));
}

// ---------------------------------------------------------------------------
// 4. jsdom: the page
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed (part 4)`); console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-starters-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import ThemeSettings from '@worktree/src/components/common/modals/settings/ThemeSettings.jsx';
  import { ThemeProvider, useTheme } from '@worktree/src/contexts/ThemeContext.jsx';
  export { act } from 'react';
  export * as React from 'react';
  export { createRoot, ThemeProvider };
  export function Harness() { const { theme, setTheme } = useTheme(); return React.createElement(ThemeSettings, { theme, setTheme, zoomFactor: 1, setZoomFactor() {} }); }
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
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'FileReader', 'File', 'Blob']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// the clipboard and the download, captured
let clipboardText = null;
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { clipboardText = t; }, readText: async () => clipboardText }, configurable: true });
const downloads = [];
const createObjectURL = (blob) => { downloads.push({ blob }); return 'blob:captured'; };
window.URL.createObjectURL = createObjectURL; window.URL.revokeObjectURL = () => {};
globalThis.URL.createObjectURL = createObjectURL; globalThis.URL.revokeObjectURL = () => {};   // the bundle's bare `URL` is Node's
window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads[downloads.length - 1].filename = this.download; };
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|not mocked|Failed to/.test(String(a[0] ?? ''))) return; origErr(...a); };
console.warn = () => {};
const { Harness, ThemeProvider, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const text = (s) => ($(s) ? $(s).textContent.trim() : '');
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(30); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }); await act(async () => { await sleep(20); }); };
const clickText = (label) => click($$('button').filter((b) => b.textContent.trim() === label).pop());
const key = async (el, k) => { await act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); await act(async () => { await sleep(20); }); };
const setValue = async (el, value) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); await act(async () => { await sleep(20); }); };
const stored = () => JSON.parse(localStorage.getItem('jacarium-custom-themes') || '[]');
const appTheme = () => localStorage.getItem('app-theme');
const active = () => $('[data-testid^="scheme-card-"][aria-checked="true"]')?.dataset.testid;
const rootVar = (n) => document.documentElement.style.getPropertyValue(n);
const nameValue = () => $('[data-testid="custom-theme-name"]')?.value;
const hex = (k) => $(`[data-testid="custom-theme-color-${k}-hex"]`)?.value;

try {
  await render(React.createElement(ThemeProvider, null, React.createElement(Harness)));
  const tiles = $$('[data-testid="scheme-gallery"] [data-testid^="scheme-card-"]');
  check('4. the gallery at the top: a radio group of 26 tiles (Auto, Light, Jacaranda, Dark, the five gradient schemes, the eleven palettes, the six Crazy ones), Auto active with the tab stop, Your themes empty, no select', $('[data-testid="scheme-gallery"]')?.getAttribute('role') === 'radiogroup' && tiles.length === 26 && tiles[0].dataset.testid === 'scheme-card-auto' && tiles[0].getAttribute('aria-checked') === 'true' && tiles[0].tabIndex === 0 && tiles[1].tabIndex === -1 && tiles.every((t) => t.getAttribute('role') === 'radio') && !!$('[data-testid="scheme-gallery-empty"]') && !$('[data-testid="theme-color-scheme"]'), tiles.map((t) => t.dataset.testid).join());
  const nordTile = $('[data-testid="scheme-card-starter-nord"]');
  const swatches = nordTile ? Array.from(nordTile.querySelectorAll('span[title]')).map((s) => [s.title, s.style.background]) : [];
  check('4. a tile shows the mark in the scheme\'s logo colours and the five swatches (rail, background, card, accent, text)', !!nordTile && nordTile.querySelector('svg') !== null && nordTile.querySelector('span[style]').style.getPropertyValue('--mark-arch') === '#88c0d0' && swatches.map((s) => s[0]).join() === 'rail,background,card,accent,text' && /46, 52, 64|#2e3440/.test(swatches[1][1]) && /136, 192, 208|#88c0d0/.test(swatches[3][1]), JSON.stringify(swatches));
  check('4. Customize is prefilled from the scheme on screen (Auto -> Light on this harness\'s light system): "Light (custom)", Save as new theme, Reset disabled, no Delete', nameValue() === 'Light (custom)' && hex('canvas') === '#f5f5f5' && text('[data-testid="custom-theme-save"]') === 'Save as new theme' && $('[data-testid="custom-theme-reset"]').disabled && !$('[data-testid="custom-theme-delete"]') && !$('[data-testid="custom-theme-save-as-new"]'), JSON.stringify([nameValue(), hex('canvas')]));
  await click(nordTile);
  check('4. clicking Nord switches at once: app-theme starter-nord, data-theme, the tokens from the template, the tile active, nothing stored, Customize "Nord (custom)" with no warning', appTheme() === 'starter-nord' && document.documentElement.getAttribute('data-theme') === 'starter-nord' && rootVar('--os-canvas') === '#2e3440' && active() === 'scheme-card-starter-nord' && stored().length === 0 && nameValue() === 'Nord (custom)' && hex('accent') === '#88c0d0' && !$('[data-testid="custom-theme-warnings"]') && document.documentElement.classList.contains('dark'), JSON.stringify([appTheme(), rootVar('--os-canvas'), active(), nameValue()]));
  await key(nordTile, 'ArrowRight');
  const afterRight = appTheme();
  await key($('[data-testid^="scheme-card-"][aria-checked="true"]'), 'End');
  const afterEnd = [appTheme(), document.documentElement.classList.contains('dark'), document.activeElement?.dataset?.testid];
  await key($('[data-testid^="scheme-card-"][aria-checked="true"]'), 'Home');
  const afterHome = appTheme();
  await key($('[data-testid^="scheme-card-"][aria-checked="true"]'), 'ArrowUp');
  const afterUp = appTheme();
  check('4. the keyboard: ArrowRight chooses Dracula, End the last tile (Toxic Neon, a dark scheme, the focus with it), Home Auto, ArrowUp wraps to the last', afterRight === 'starter-dracula' && afterEnd[0] === 'starter-toxic-neon' && afterEnd[1] === true && afterEnd[2] === 'scheme-card-starter-toxic-neon' && afterHome === 'auto' && afterUp === 'starter-toxic-neon', JSON.stringify([afterRight, afterEnd, afterHome, afterUp]));
  await click(nordTile);

  // Customize: an edit previews, Save as new theme creates one
  await setValue($('[data-testid="custom-theme-color-accent-hex"]'), '#ff8800');
  check('4. an edit previews live (the accent on <html>), Reset enabled, Import JSON disabled while there are changes', rootVar('--os-blue') === '#ff8800' && !$('[data-testid="custom-theme-reset"]').disabled && $('[data-testid="custom-theme-import"]').disabled, rootVar('--os-blue'));
  await click($('[data-testid="custom-theme-save"]'));
  let list = stored();
  const id0 = list[0]?.id;
  check('4. Save as new theme: "Nord (custom)" stored under a new ct- id with the change, chosen, its tile active under Your themes, Customize now the theme\'s own (Delete, Save as new, Save disabled, Reset disabled)', list.length === 1 && /^ct-/.test(id0) && list[0].name === 'Nord (custom)' && list[0].colors.accent === '#ff8800' && list[0].colors.canvas === '#2e3440' && appTheme() === `custom-${id0}` && active() === `scheme-card-custom-${id0}` && !$('[data-testid="scheme-gallery-empty"]') && !!$('[data-testid="custom-theme-delete"]') && !!$('[data-testid="custom-theme-save-as-new"]') && $('[data-testid="custom-theme-save"]').disabled && $('[data-testid="custom-theme-reset"]').disabled && text('[data-testid="custom-theme-save"]') === 'Save', JSON.stringify([list.map((t) => [t.id, t.name, t.colors.accent]), appTheme(), active()]));
  check('4. ...the scheme paints from the saved theme (no preview left): the accent token stays', rootVar('--os-blue') === '#ff8800');
  // Save in place
  await setValue($('[data-testid="custom-theme-name"]'), 'Nord mine');
  check('4. a change on a theme of yours enables Save', !$('[data-testid="custom-theme-save"]').disabled);
  await click($('[data-testid="custom-theme-save"]'));
  list = stored();
  check('4. Save saves it in place: the same id, the new name, its tile renamed, Save disabled again', list.length === 1 && list[0].id === id0 && list[0].name === 'Nord mine' && /Nord mine/.test(text(`[data-testid="scheme-card-custom-${id0}"]`)) && $('[data-testid="custom-theme-save"]').disabled && appTheme() === `custom-${id0}`, JSON.stringify(list.map((t) => [t.id, t.name])));
  // Save as new
  await setValue($('[data-testid="custom-theme-color-canvas-hex"]'), '#111111');
  await click($('[data-testid="custom-theme-save-as-new"]'));
  list = stored();
  const id1 = list[1]?.id;
  check('4. Save as new keeps the original and adds "Nord mine (copy)" with the change, chosen', list.length === 2 && list[0].colors.canvas === '#2e3440' && list[1].name === 'Nord mine (copy)' && list[1].colors.canvas === '#111111' && id1 !== id0 && appTheme() === `custom-${id1}` && nameValue() === 'Nord mine (copy)', JSON.stringify(list.map((t) => [t.name, t.colors.canvas])));
  // Reset
  await setValue($('[data-testid="custom-theme-color-accent-hex"]'), '#00ff00');
  const previewed = rootVar('--os-blue');
  await click($('[data-testid="custom-theme-reset"]'));
  check('4. Reset returns to the saved values: the previewed accent goes back, Reset disabled', previewed === '#00ff00' && hex('accent') === '#ff8800' && rootVar('--os-blue') === '#ff8800' && $('[data-testid="custom-theme-reset"]').disabled, JSON.stringify([previewed, hex('accent'), rootVar('--os-blue')]));
  // the dirty switch
  await setValue($('[data-testid="custom-theme-color-accent-hex"]'), '#00ff00');
  await click($('[data-testid="scheme-card-light"]'));
  const asked = /Discard your changes\?/.test(document.body.textContent);
  await clickText('Cancel');
  check('4. a tile clicked with unsaved changes asks first; Cancel keeps the scheme and the changes', asked && appTheme() === `custom-${id1}` && hex('accent') === '#00ff00' && !/Discard your changes\?/.test(document.body.textContent), JSON.stringify([asked, appTheme(), hex('accent')]));
  await click($('[data-testid="scheme-card-light"]'));
  await clickText('Discard and switch');
  check('4. "Discard and switch" applies Light and refills Customize from it; the theme kept its saved accent', appTheme() === 'light' && nameValue() === 'Light (custom)' && $('[data-testid="custom-theme-reset"]').disabled && stored()[1].colors.accent === '#ff8800' && !document.documentElement.classList.contains('dark'), JSON.stringify([appTheme(), nameValue()]));

  // Export: the modal, Copy, Download; the round trip
  await click($(`[data-testid="scheme-card-custom-${id1}"]`));
  await click($('[data-testid="custom-theme-export"]'));
  await act(async () => { await sleep(80); });
  const box = $('[data-testid="export-json-text"]');
  const file = box ? JSON.parse(box.value) : null;
  check('4. Export JSON opens the ExportJsonModal with the theme file as JSON in a read-only box, focused and fully selected', !!$('[data-testid="export-theme-modal"]') && !!box && box.readOnly && file?.format === 'jacarium-theme' && file.theme.name === 'Nord mine (copy)' && file.theme.colors.canvas === '#111111' && document.activeElement === box && box.selectionStart === 0 && box.selectionEnd === box.value.length, JSON.stringify([box?.selectionStart, box?.selectionEnd, box?.value.length]));
  await click($('[data-testid="export-json-copy"]'));
  check('4. Copy writes the JSON to the clipboard through the app\'s helper and says "Copied"', clipboardText === box.value && text('[data-testid="export-json-copy"]') === 'Copied');
  await click($('[data-testid="export-json-download"]'));
  const dl = downloads[downloads.length - 1];
  check('4. Download writes the same JSON as <name>.jacarium-theme.json', !!dl && dl.filename === ct.themeFileName(file.theme) && dl.filename.endsWith('.jacarium-theme.json') && dl.blob.size === Buffer.byteLength(box.value) && dl.blob.type === 'application/json', JSON.stringify(dl && [dl.filename, dl.blob.size, dl.blob.type]));
  await click($('[data-testid="export-json-close"]'));
  check('4. Close leaves the page as it was', !$('[data-testid="export-theme-modal"]') && appTheme() === `custom-${id1}`);
  await click($('[data-testid="custom-theme-import"]'));
  await setValue($('[data-testid="import-json-input"]'), clipboardText);
  await clickText('Dry Run');
  check('4. the copied JSON pasted into Import JSON: Dry Run says "1 theme would be added" as "Nord mine (copy) (imported)" (the name exists), nothing written', /1 theme would be added/.test(text('[data-testid="import-dry-run-lines"]')) && /"Nord mine \(copy\) \(imported\)" would be added \(renamed: "Nord mine \(copy\)" exists\)/.test(text('[data-testid="import-dry-run-lines"]')) && stored().length === 2, text('[data-testid="import-dry-run-lines"]'));
  await clickText('Import Theme');
  list = stored();
  const strip = (t) => JSON.stringify({ base: t.base, colors: t.colors, fills: t.fills, logoTone: t.logoTone });
  check('4. Import adds the identical theme under a new id, chosen and applied', list.length === 3 && list[2].name === 'Nord mine (copy) (imported)' && list[2].id !== id1 && strip(list[2]) === strip(list[1]) && appTheme() === `custom-${list[2].id}` && rootVar('--os-canvas') === '#111111' && /Imported "Nord mine \(copy\) \(imported\)"/.test(text('[data-testid="custom-theme-notice"]')), JSON.stringify(list.map((t) => [t.id, t.name])));
  await click($('[data-testid="custom-theme-import"]'));
  await setValue($('[data-testid="import-json-input"]'), JSON.stringify({ ...file, theme: { ...file.theme, colors: { ...file.theme.colors, card: 'url(javascript:alert(1))' }, background: 'linear-gradient(red, blue)' } }));
  await clickText('Dry Run');
  const errText = text('[data-testid="import-theme-modal"]');
  check('4. a tampered file: the Validation Error names the reasons, nothing imported', /Validation Error/.test(errText) && /Not imported: unknown keys: background/.test(errText) && /Card: not a colour/.test(errText) && stored().length === 3, errText.slice(-300));
  await clickText('Cancel');
  // Delete
  await click($('[data-testid="custom-theme-delete"]'));
  await clickText('Delete');
  list = stored();
  check('4. Delete (confirmed) removes the chosen theme; the scheme goes back to Auto, Customize to "Light (custom)"', list.length === 2 && list.map((t) => t.name).join() === 'Nord mine,Nord mine (copy)' && appTheme() === 'auto' && active() === 'scheme-card-auto' && nameValue() === 'Light (custom)', JSON.stringify([list.map((t) => t.name), appTheme(), active()]));
  await render(null);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
