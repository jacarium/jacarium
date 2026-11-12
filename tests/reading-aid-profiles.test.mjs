#!/usr/bin/env node
/**
 * The accessibility profiles (src/utils/readingAidProfiles.js and the cards
 * of src/components/common/modals/settings/ProfileGallery.jsx):
 *  1. the data: every profile normalises to itself (no value a future
 *     normaliser would change), applying one gives exactly its values with
 *     every other option back at the default (no stacking), matching finds
 *     the active profile and "Custom", the last applied profile is
 *     remembered for the "based on" note, cycling wraps around;
 *  2. jsdom: the gallery is a radio group whose cards carry names and
 *     descriptions, the matching card is checked (a check mark, not colour
 *     alone), clicking applies, a manual change shows Custom based on the
 *     profile, the arrows move and choose, Reset brings Default back; the
 *     shell's shortcuts cycle.
 *
 * Needs esbuild, jsdom and fake-indexeddb for part 2. Run: node tests/reading-aid-profiles.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RA = await import(path.join(REPO, 'src/utils/readingAids.js'));
const P = await import(path.join(REPO, 'src/utils/readingAidProfiles.js'));

// ---- 1. the data
{
  const ids = P.PROFILES.map((p) => p.id);
  check(`1. ${ids.length} profiles, unique ids, each with a name, a one-line description, settings and a preview: ${ids.join(', ')}`, new Set(ids).size === ids.length && ids.length >= 6 && ids.length <= 9 && P.PROFILES.every((p) => p.name && p.description && !/\n/.test(p.description) && p.settings && typeof p.settings === 'object' && p.preview && p.preview.kind));
  const selfNormal = P.PROFILES.filter((p) => { const full = { ...RA.DEFAULT_READING_AIDS, ...p.settings }; const n = RA.normalizeReadingAids(full); return !Object.keys(RA.DEFAULT_READING_AIDS).every((k) => n[k] === full[k]) || Object.keys(p.settings).some((k) => !(k in RA.DEFAULT_READING_AIDS)); });
  check('1. every profile normalises to itself: each value is one the normaliser keeps, each key an option that exists', selfNormal.length === 0, selfNormal.map((p) => p.id).join());
  check('1. Default is the defaults; the others each change something', RA.isDefaultReadingAids(P.profileSettings('default')) && P.PROFILES.filter((p) => p.id !== 'default').every((p) => !RA.isDefaultReadingAids(P.profileSettings(p.id))));
  const d = P.profileSettings('dyslexia');
  check('1. Dyslexia friendly: Lexend with Atkinson Hyperlegible Mono for code (OpenDyslexic Mono has no maintained package), 0.05 em letters, 0.2 em words, left, 70 ch, line height 1.8, a one-line highlight ruler', d.font === 'lexend' && d.codeFont === 'atkinsonMono' && d.letterSpacing === 0.05 && d.wordSpacing === 0.2 && d.textAlign === 'left' && d.lineWidth === 70 && d.lineHeight === 1.8 && d.ruler && d.rulerLines === 1 && d.rulerMode === 'highlight' && d.highContrast === false, JSON.stringify(d));
  const lv = P.profileSettings('lowVision');
  check('1. Low vision: 150 % with the interface too, high contrast, links, Atkinson Hyperlegible and its Mono for code', lv.textScale === 150 && lv.scaleChrome && lv.highContrast && lv.highlightLinks && lv.font === 'atkinson' && lv.codeFont === 'atkinsonMono' && !lv.ruler);
  const f = P.profileSettings('focus');
  check('1. Focus: a three-line mask ruler, 60 % saturation, hidden images, 70 ch; Comfortable: 1.8 / 1.5 em / 80 ch / 110 % / links; Calm: 60 %, hidden images and reduced motion only; Focus reduces motion too; the three colour-blind profiles set their kind and links', f.ruler && f.rulerLines === 3 && f.rulerMode === 'mask' && f.saturation === 60 && f.hideImages && f.lineWidth === 70 && (() => { const c = P.profileSettings('comfortable'); return c.lineHeight === 1.8 && c.paragraphSpacing === 1.5 && c.lineWidth === 80 && c.textScale === 110 && c.highlightLinks; })() && (() => { const c = P.profileSettings('calm'); return c.saturation === 60 && c.hideImages && c.reduceMotion === 'on' && Object.keys(RA.DEFAULT_READING_AIDS).filter((k) => c[k] !== RA.DEFAULT_READING_AIDS[k]).length === 3; })() && f.reduceMotion === 'on' && P.profileSettings('cvRed').colorVision === 'protanopia' && P.profileSettings('cvGreen').colorVision === 'deuteranopia' && P.profileSettings('cvBlue').colorVision === 'tritanopia' && P.profileSettings('cvBlue').highlightLinks);
  // applying: a fake store
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  RA.saveReadingAids({ highContrast: true, greyscale: true, lineWidth: 100 }, store);   // a messy start
  const applied = P.applyProfile('dyslexia', store);
  check('1. applying a profile gives exactly its values - the messy start (high contrast, greyscale, 100 ch) is gone, nothing stacks - and remembers the profile', JSON.stringify(applied) === JSON.stringify(P.profileSettings('dyslexia')) && JSON.stringify(RA.loadReadingAids(store)) === JSON.stringify(P.profileSettings('dyslexia')) && P.lastProfile(store) === 'dyslexia' && P.matchProfile(RA.loadReadingAids(store)) === 'dyslexia');
  RA.saveReadingAids({ lineHeight: 2 }, store);
  const st = P.profileState(RA.loadReadingAids(store), store);
  check('1. a manual change makes it Custom, based on the profile applied last', st.match === null && st.basedOn === 'dyslexia');
  check('1. matching is exact: the defaults are Default, a profile\'s values its id, anything else null; an unknown profile applies nothing', P.matchProfile(RA.DEFAULT_READING_AIDS) === 'default' && P.matchProfile(P.profileSettings('focus')) === 'focus' && P.matchProfile({ saturation: 61, hideImages: true }) === null && P.applyProfile('nope', store) === null);
  RA.resetReadingAids(store);
  check('1. Reset to defaults matches Default again', P.profileState(RA.loadReadingAids(store), store).match === 'default');
  check('1. cycling: next after Default is the second profile, previous from Default wraps to the last; from a custom mix it continues from the profile applied last', P.cycleProfile(1, store) === P.PROFILES[1].id && (P.applyProfile('default', store), P.cycleProfile(-1, store) === P.PROFILES[P.PROFILES.length - 1].id) && (P.applyProfile('focus', store), RA.saveReadingAids({ lineHeight: 2 }, store), P.cycleProfile(1, store) === P.PROFILES[P.PROFILES.findIndex((p) => p.id === 'focus') + 1].id));
  const reg = await import(path.join(REPO, 'src/shortcuts/registry.js'));
  check('1. the shortcuts: Next / Previous accessibility profile in the Reading group, everywhere, unassigned; the shell cycles on them', ['reading.profileNext', 'reading.profilePrev'].every((id) => { const a = reg.actionById(id); return a && a.group === 'reading' && a.scope === 'global' && a.defaults.mac === null && a.defaults.other === null; }) && /useShortcut\('reading\.profileNext', \(\) => \{ cycleProfile\(1\)/.test(read('src/components/JQLBuilder.jsx')) && /useShortcut\('reading\.profilePrev', \(\) => \{ cycleProfile\(-1\)/.test(read('src/components/JQLBuilder.jsx')));
}

// ---- 2. jsdom
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed (part 2)`); console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-aid-profiles-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import AccessibilitySettings from '@worktree/src/components/common/modals/settings/AccessibilitySettings.jsx';
  import { useAppReadingAids } from '@worktree/src/components/common/ReadingAidsSurface.jsx';
  export { act } from 'react';
  export * as React from 'react';
  export { createRoot, AccessibilitySettings, useAppReadingAids };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'empty' },
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
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(/.test(String(a[0] ?? ''))) return; origErr(...a); };
const { AccessibilitySettings, useAppReadingAids, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(20); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }); await act(async () => { await sleep(10); }); };
const key = async (el, k) => { await act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); await act(async () => { await sleep(10); }); };
const select = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); await act(async () => { await sleep(10); }); };
const stored = () => JSON.parse(localStorage.getItem(RA.READING_AIDS_KEY) || 'null');
const checkedId = () => { const c = $('[data-testid="ra-profiles"] [role="radio"][aria-checked="true"]'); return c ? c.getAttribute('data-testid').replace('ra-profile-', '') : null; };
const html = document.documentElement;
const Shell = () => { useAppReadingAids(); return null; };

try {
  await render(React.createElement('div', null, React.createElement(Shell), React.createElement(AccessibilitySettings)));
  const cards = $$('[data-testid="ra-profiles"] [role="radio"]');
  check('2. the gallery is a radio group at the top of the page with one card per profile, each named, described (aria-describedby) and with a preview; Default is checked at the defaults, with a check mark; it holds the tab stop', $('[data-testid="ra-profiles"]')?.getAttribute('role') === 'radiogroup' && cards.length === P.PROFILES.length && cards.every((c) => c.textContent.trim().length > 10 && document.getElementById(c.getAttribute('aria-describedby')) && c.querySelector('[data-preview]')) && checkedId() === 'default' && !!$('[data-testid="ra-profile-default"] [aria-label="selected"]') && $('[data-testid="ra-profile-default"]').tabIndex === 0 && $('[data-testid="ra-profile-focus"]').tabIndex === -1 && $('[data-testid="ra-profiles-block"]').compareDocumentPosition($('[data-testid="ra-group-app"]')) & 4 && /Profile: Default/.test($('[data-testid="ra-profile-state"]').textContent));
  await click($('[data-testid="ra-profile-dyslexia"]'));
  check('2. clicking Dyslexia friendly applies it at once: its values stored, <html> carrying Lexend, the letter spacing and the ruler, the card checked, the state line naming it', JSON.stringify(RA.loadReadingAids()) === JSON.stringify(P.profileSettings('dyslexia')) && /Lexend/.test(html.style.getPropertyValue('--ra-font-family')) && html.style.getPropertyValue('--ra-letter-spacing') === '0.05em' && html.classList.contains('ra-ruler') && checkedId() === 'dyslexia' && /Profile: Dyslexia friendly/.test($('[data-testid="ra-profile-state"]').textContent) && $('#ra-font').value === 'lexend', JSON.stringify([stored(), html.getAttribute('style')]));
  await click($('[data-testid="ra-profile-lowVision"]'));
  check('2. then Low vision: nothing of Dyslexia friendly stays (no ruler, no letter spacing), high contrast and the interface scale on', JSON.stringify(RA.loadReadingAids()) === JSON.stringify(P.profileSettings('lowVision')) && !html.classList.contains('ra-ruler') && !html.style.getPropertyValue('--ra-letter-spacing') && html.classList.contains('ra-high-contrast') && html.classList.contains('ra-scale-chrome') && checkedId() === 'lowVision');
  await select($('#ra-line-height'), '2');
  check('2. a manual change: no card checked, the state line says Custom (based on Low vision)', checkedId() === null && /Custom \(based on Low vision\)/.test($('[data-testid="ra-profile-state"]').textContent) && $('[data-testid="ra-profile-lowVision"]').tabIndex === 0);
  await key($('[data-testid="ra-profile-lowVision"]'), 'ArrowRight');
  check('2. ArrowRight from the based-on card moves to and applies the next profile (Focus)', checkedId() === 'focus' && JSON.stringify(RA.loadReadingAids()) === JSON.stringify(P.profileSettings('focus')) && document.activeElement === $('[data-testid="ra-profile-focus"]'));
  await key($('[data-testid="ra-profile-focus"]'), 'Home');
  check('2. Home chooses Default', checkedId() === 'default' && RA.isDefaultReadingAids(RA.loadReadingAids()));
  await key($('[data-testid="ra-profile-default"]'), 'ArrowLeft');
  check('2. ArrowLeft from Default wraps to the last profile (Calm)', checkedId() === 'calm');
  await click($('[data-testid="ra-reset"]'));
  check('2. Reset to defaults brings Default back', checkedId() === 'default' && stored() === null);
  await render(null);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
