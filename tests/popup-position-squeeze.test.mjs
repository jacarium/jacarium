#!/usr/bin/env node
/**
 * usePopupPosition's edge cases (src/hooks/usePopupPosition.js), the real
 * hook under jsdom with the geometry stubbed:
 *  - a fixed popup first painted at its row's right edge near the window's
 *    right edge is squeezed to its minimum width there; the hook measures it
 *    from the window's left edge instead and places the flipped popup so it
 *    ends at the anchor's left edge (not short by the squeeze);
 *  - a measurement that throws (an anchor gone mid-scroll) never escapes the
 *    layout effect: the popup keeps its place, the tree stays mounted and a
 *    warning is logged once.
 *
 * Preconditions: npm install, plus the test-only deps the jsdom tests share
 *   (npm install --no-save jsdom fake-indexeddb - see tests/run-all.sh).
 * Run: node tests/popup-position-squeeze.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dep of ['jsdom', 'esbuild']) { try { req.resolve(dep); } catch { console.log(`Missing test-only dependency "${dep}". Install it without saving: npm install --no-save jsdom fake-indexeddb`); process.exit(0); } }

const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://console.example.test/' });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver']) {
  if (window[key] !== undefined) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });

const { build } = await import(req.resolve('esbuild'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-squeeze-'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
fs.writeFileSync(ENTRY, `
  export { usePopupPosition } from '@worktree/src/hooks/usePopupPosition.js';
  export { placePopup } from '@worktree/src/utils/popupPlacement.js';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});
const { usePopupPosition, placePopup, React, createRoot, act } = req(BUNDLE);
const h = React.createElement;

// the maths alone: side right, flipped left, ends at the anchor's left edge
const anchor = { left: 1141, top: 120, right: 1359, bottom: 160 };
const placed = placePopup({ anchor, popup: { width: 200, height: 300 }, viewport: { width: 1400, height: 900 }, side: 'right', gap: 0 });
check('placePopup side right near the window\'s edge flips left: left = anchor.left - width (941), placement "left"', placed.left === 941 && placed.placement === 'left', JSON.stringify(placed));
const squeezed = placePopup({ anchor, popup: { width: 180, height: 300 }, viewport: { width: 1400, height: 900 }, side: 'right', gap: 0 });
check('... and from a squeezed 180 px width it would end 20 px short (961): the hook must measure the natural width', squeezed.left === 961);

// the hook: the popup's measured width depends on where it sits (shrink-to-fit near the right edge), like a
// fixed element with `left` set: 180 px when left > 1200, its natural 200 px otherwise
const NATURAL = 200; const MIN = 180;
const geometry = (el) => { const left = parseFloat(el.style.left) || 0; const width = left > 1200 ? MIN : NATURAL; return { left, top: 120, right: left + width, bottom: 420, width, height: 300, x: left, y: 120 }; };
let throwNext = 0; let measured = 0;
function Popup({ open }) {
  const ref = React.useRef(null);
  usePopupPosition(ref, { open, anchor: () => anchor, deps: [open], side: 'right', gap: 0 });
  return h('div', { ref: (el) => { ref.current = el; if (el && !el.__stubbed) { el.__stubbed = true; el.getBoundingClientRect = () => { measured++; if (throwNext > 0) { throwNext--; throw new Error('measurement failed'); } return geometry(el); }; Object.defineProperty(el, 'scrollHeight', { value: 300 }); Object.defineProperty(el, 'offsetHeight', { value: 300 }); Object.defineProperty(el, 'clientHeight', { value: 300 }); } }, 'data-testid': 'popup', style: { position: 'fixed', left: '1359px', top: '120px' } }, 'menu');
}
const root = createRoot(document.getElementById('root'));
await act(() => { root.render(h('div', null, h('nav', { 'data-testid': 'rail' }, 'rail'), h(Popup, { open: true }))); });
const popup = () => document.querySelector('[data-testid="popup"]');
check('the hook places the flipped popup at the anchor\'s left edge minus its natural width (left 941px), not from the squeezed width', popup() && popup().style.left === '941px', popup() && popup().style.left);
check('the measurement happened from the window\'s left edge (the width read was the natural one)', measured >= 1 && parseFloat(popup().style.left) + NATURAL === anchor.left);

// a measurement that throws: no unmount, a warning once, the popup keeps its place
const warnings = []; const realWarn = console.warn; console.warn = (...a) => warnings.push(a.map(String).join(' '));
throwNext = 1;
await act(() => { root.render(h('div', null, h('nav', { 'data-testid': 'rail' }, 'rail'), h(Popup, { open: true, key: 'again' }))); });
console.warn = realWarn;
check('a measurement that throws leaves the tree mounted (the rail and the popup are there), the popup at its previous place (never at the measuring position), warned once', !!document.querySelector('[data-testid="rail"]') && !!popup() && popup().style.left === '1359px' && warnings.filter((w) => /usePopupPosition\] placement skipped/.test(w)).length === 1, JSON.stringify({ warnings, left: popup() && popup().style.left }));
await act(async () => { window.dispatchEvent(new window.Event('resize')); await sleep(40); });
check('... and the next placement (a window resize) puts it right again', popup() && popup().style.left === '941px', popup() && popup().style.left);

await act(() => { root.unmount(); });
try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
