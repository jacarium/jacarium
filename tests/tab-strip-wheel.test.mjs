#!/usr/bin/env node
/**
 * A plain mouse wheel scrolls the desktop tab strips sideways
 * (src/hooks/useWheelScrollsStrip.js attachWheelScroll, attached by the
 * shared document TabBar - Documents, Kanban, Tasks, Workflows, Tools - and
 * by the Calendars TabBar and the ToolsTabBar). In jsdom, over the real
 * handler:
 *   - an overflowing strip: wheel deltaY moves scrollLeft by deltaY (down ->
 *     right, up -> left), clamped to the strip, and the event is prevented
 *     so the page does not scroll too; deltaMode lines / pages are scaled;
 *   - a horizontal delta (trackpad), Shift+wheel and Ctrl+wheel are left to
 *     the browser (scrollLeft untouched, not prevented);
 *   - a strip that does not overflow intercepts nothing;
 *   - the detach function removes the listener.
 * The three strips carrying the hook are checked in the source.
 *
 * Run: node tests/tab-strip-wheel.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const resolvable = (n) => { try { req.resolve(n); return true; } catch { return false; } };
if (!resolvable('jsdom')) { console.log('SKIP: jsdom not installed (npm install --no-save jsdom)'); process.exit(0); }
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const { JSDOM } = await import(req.resolve('jsdom'));
const { window } = new JSDOM('<!doctype html><html><body><div id="strip"></div><div id="narrow"></div></body></html>', { pretendToBeVisual: true });
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-strip-wheel-'));
const BUNDLE = path.join(WORK, 'hook.cjs');
await build({ entryPoints: [path.join(REPO, 'src/hooks/useWheelScrollsStrip.js')], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { attachWheelScroll } = req(BUNDLE);

/** A strip of `scrollWidth` content in a `clientWidth` box (jsdom has no layout). */
function makeStrip(el, { scrollWidth, clientWidth }) {
  let left = 0;
  Object.defineProperty(el, 'scrollWidth', { get: () => scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { get: () => clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { get: () => left, set: (v) => { left = v; }, configurable: true });
  return el;
}
const wheel = (el, init) => {
  const ev = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
};

const strip = makeStrip(window.document.getElementById('strip'), { scrollWidth: 2000, clientWidth: 500 });
const detach = attachWheelScroll(strip);

check('wheel down (deltaY 120) on an overflowing strip scrolls it right by 120 and is prevented', wheel(strip, { deltaY: 120, deltaX: 0 }) === true && strip.scrollLeft === 120, String(strip.scrollLeft));
check('wheel up (deltaY -50) scrolls it back left', wheel(strip, { deltaY: -50, deltaX: 0 }) === true && strip.scrollLeft === 70, String(strip.scrollLeft));
check('deltaMode 1 (lines) is scaled to pixels', wheel(strip, { deltaY: 3, deltaX: 0, deltaMode: 1 }) === true && strip.scrollLeft === 70 + 48, String(strip.scrollLeft));
check('deltaMode 2 (pages) scrolls by the strip width', wheel(strip, { deltaY: 1, deltaX: 0, deltaMode: 2 }) === true && strip.scrollLeft === 118 + 500, String(strip.scrollLeft));
check('the scroll is clamped to the strip', wheel(strip, { deltaY: 100000, deltaX: 0 }) === true && strip.scrollLeft === 1500, String(strip.scrollLeft));
check('...and to zero', wheel(strip, { deltaY: -100000, deltaX: 0 }) === true && strip.scrollLeft === 0, String(strip.scrollLeft));
strip.scrollLeft = 300;
check('a horizontal delta (trackpad swipe) is left to the browser', wheel(strip, { deltaY: 10, deltaX: 80 }) === false && strip.scrollLeft === 300, String(strip.scrollLeft));
check('an equal delta is left to the browser too', wheel(strip, { deltaY: 40, deltaX: 40 }) === false && strip.scrollLeft === 300);
check('Shift+wheel is left to the browser', wheel(strip, { deltaY: 100, deltaX: 0, shiftKey: true }) === false && strip.scrollLeft === 300);
check('Ctrl+wheel (zoom) is left to the browser', wheel(strip, { deltaY: 100, deltaX: 0, ctrlKey: true }) === false && strip.scrollLeft === 300);

const narrow = makeStrip(window.document.getElementById('narrow'), { scrollWidth: 400, clientWidth: 500 });
attachWheelScroll(narrow);
check('a strip that does not overflow intercepts nothing', wheel(narrow, { deltaY: 120, deltaX: 0 }) === false && narrow.scrollLeft === 0);

detach();
check('after detach the strip is left alone', wheel(strip, { deltaY: 120, deltaX: 0 }) === false && strip.scrollLeft === 300);
check('attaching to nothing is a no-op', typeof attachWheelScroll(null) === 'function');

// ---- the strips that carry it
const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
for (const rel of ['src/components/features/documents/TabBar.jsx', 'src/components/features/calendars/TabBar.jsx', 'src/components/features/tools/ToolsTabBar.jsx']) {
  const s = src(rel);
  check(`${rel} attaches the wheel scroll to its .sc-tab-strip`, /useWheelScrollsStrip\(/.test(s) && /sc-tab-strip/.test(s));
}
check('the shared document TabBar serves Documents, Kanban, Tasks, Workflows and Tools', ['DocumentsPage', 'KanbanPage', 'TasksPage', 'WorkflowBuilder', 'ToolsPage'].every((p) => /features\/documents\/TabBar'/.test(src(`src/components/${p}.jsx`))));

console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
