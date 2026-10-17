/**
 * Guards the phone-layout gate (src/utils/mobile.js, src/hooks/useIsMobile.js):
 *   - the decision: a phone-wide viewport AND a coarse pointer, never in
 *     the desktop app (window.electronAPI.isElectron) - a laptop browser
 *     narrowed to a phone's width keeps the desktop layout;
 *   - detectMobile reads both media queries and is false without matchMedia;
 *   - subscribeMobile re-evaluates on either query's change (resize,
 *     rotation) and unsubscribes cleanly;
 *   - applyMobileAttribute mirrors it on <html data-mobile>, and
 *     isMobileLayout reads it back;
 *   - the React hook (useIsMobile) and the provider (useMobile) follow a
 *     flip at runtime and answer "not mobile" outside the provider.
 * Run: node tests/mobile-detection.test.mjs   (needs jsdom: npm install --no-save jsdom fake-indexeddb)
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };

const { decideMobile, detectMobile, subscribeMobile, applyMobileAttribute, isMobileLayout, PHONE_WIDTH_QUERY, COARSE_POINTER_QUERY } = await import(path.join(REPO, 'src', 'utils', 'mobile.js'));

// ---- a fake window whose media queries can be flipped ----
function fakeWindow({ narrow = true, coarse = true, electron = false } = {}) {
  const lists = {};
  const state = { [PHONE_WIDTH_QUERY]: narrow, [COARSE_POINTER_QUERY]: coarse };
  const win = {
    matchMedia: (q) => {
      if (!lists[q]) {
        const listeners = new Set();
        lists[q] = {
          get matches() { return !!state[q]; },
          addEventListener: (_, fn) => listeners.add(fn),
          removeEventListener: (_, fn) => listeners.delete(fn),
          fire: () => { for (const fn of listeners) fn({ matches: !!state[q] }); },
          listeners,
        };
      }
      return lists[q];
    },
    set: (q, value) => { state[q] = value; lists[q]?.fire(); },
    lists,
  };
  if (electron) win.electronAPI = { isElectron: true };
  return win;
}

// ---- the decision ----
check('phone width + coarse pointer = mobile', decideMobile({ narrow: true, coarse: true, electron: false }) === true);
check('a narrow laptop browser window (fine pointer) is not mobile', decideMobile({ narrow: true, coarse: false, electron: false }) === false);
check('a wide touch screen (a tablet in landscape) is not mobile', decideMobile({ narrow: false, coarse: true, electron: false }) === false);
check('never inside Electron, whatever the screen', decideMobile({ narrow: true, coarse: true, electron: true }) === false);

// ---- detectMobile ----
check('detectMobile: a phone', detectMobile(fakeWindow()) === true);
check('detectMobile: a desktop browser', detectMobile(fakeWindow({ narrow: false, coarse: false })) === false);
check('detectMobile: the desktop app on a touch screen', detectMobile(fakeWindow({ electron: true })) === false);
check('detectMobile: no window / no matchMedia (tests, SSR) is false', detectMobile(undefined) === false && detectMobile({}) === false);
check('detectMobile: a matchMedia that throws is false, not an error', detectMobile({ matchMedia: () => { throw new Error('nope'); } }) === false);

// ---- subscription ----
{
  const win = fakeWindow({ narrow: false });
  let calls = 0;
  const off = subscribeMobile(win, () => { calls++; });
  check('subscribeMobile listens on both queries', win.lists[PHONE_WIDTH_QUERY].listeners.size === 1 && win.lists[COARSE_POINTER_QUERY].listeners.size === 1);
  win.set(PHONE_WIDTH_QUERY, true);
  check('...a resize into phone width notifies, and the decision flips', calls === 1 && detectMobile(win) === true);
  win.set(COARSE_POINTER_QUERY, false);
  check('...a pointer change notifies too, and flips it back', calls === 2 && detectMobile(win) === false);
  off();
  win.set(PHONE_WIDTH_QUERY, false);
  check('...nothing after unsubscribing', calls === 2 && win.lists[PHONE_WIDTH_QUERY].listeners.size === 0);
  check('subscribeMobile without matchMedia is a no-op that still returns a function', typeof subscribeMobile({}, () => {}) === 'function');
}

// ---- the document attribute ----
{
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } };
  const doc = { documentElement: root };
  applyMobileAttribute(doc, true);
  check('applyMobileAttribute sets <html data-mobile="true">', root.attrs['data-mobile'] === 'true' && isMobileLayout(doc) === true);
  applyMobileAttribute(doc, false);
  check('...and removes it entirely when not mobile', !('data-mobile' in root.attrs) && isMobileLayout(doc) === false);
  check('applyMobileAttribute without a document does nothing', (applyMobileAttribute(null, true), true));
  check('isMobileLayout without a document is false', isMobileLayout(undefined) === false);
}

// ---- the hook and the provider, in jsdom ----
let jsdomOk = true;
try { req.resolve('jsdom'); req.resolve('esbuild'); } catch { jsdomOk = false; }
if (!jsdomOk) {
  console.log('SKIP: jsdom/esbuild missing - the React hook is not checked (npm install --no-save jsdom fake-indexeddb)');
} else {
  const { JSDOM } = await import(req.resolve('jsdom'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.test/' });
  const win = dom.window;
  const state = { [PHONE_WIDTH_QUERY]: true, [COARSE_POINTER_QUERY]: true };
  const lists = {};
  win.matchMedia = (q) => {
    if (!lists[q]) { const listeners = new Set(); lists[q] = { get matches() { return !!state[q]; }, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn), listeners }; }
    return lists[q];
  };
  const flip = (q, value) => { state[q] = value; for (const fn of lists[q]?.listeners || []) fn({ matches: value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent']) {
    try { Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true }); } catch { /* read-only in this runtime */ }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { build } = await import(req.resolve('esbuild'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-detection-'));
  const entry = path.join(WORK, 'entry.mjs');
  fs.writeFileSync(entry, `
    import React, { act } from 'react';
    import { createRoot } from 'react-dom/client';
    import { MobileProvider, useMobile } from '@worktree/src/contexts/MobileContext.jsx';
    import { useIsMobile } from '@worktree/src/hooks/useIsMobile.js';
    export { React, act, createRoot, MobileProvider, useMobile, useIsMobile };
  `);
  const out = path.join(WORK, 'bundle.cjs');
  await build({
    entryPoints: [entry], bundle: true, outfile: out, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
    } }], logLevel: 'error',
  });
  const { React, act, createRoot, MobileProvider, useMobile, useIsMobile } = req(out);
  const seen = { hook: null, ctx: null };
  function Probe() { seen.hook = useIsMobile(); seen.ctx = useMobile(); return React.createElement('span', { 'data-mobile-probe': String(seen.ctx.isMobile) }); }
  const root = createRoot(win.document.getElementById('root'));
  await act(async () => { root.render(React.createElement(MobileProvider, null, React.createElement(Probe))); });
  check('useIsMobile answers true on a phone and marks the document', seen.hook === true && win.document.documentElement.getAttribute('data-mobile') === 'true');
  check('useMobile inside the provider is mobile, drawer and sheet closed', seen.ctx.isMobile === true && seen.ctx.sidebarOpen === false && seen.ctx.moreOpen === false);
  await act(async () => { seen.ctx.openSidebar(); });
  check('openSidebar opens the drawer', seen.ctx.sidebarOpen === true);
  await act(async () => { seen.ctx.openMore(); });
  check('openMore closes the drawer and opens the sheet (one overlay at a time)', seen.ctx.sidebarOpen === false && seen.ctx.moreOpen === true);
  await act(async () => { flip(COARSE_POINTER_QUERY, false); });
  check('a flip of the pointer query at runtime switches the layout off and clears the attribute', seen.hook === false && seen.ctx.isMobile === false && win.document.documentElement.getAttribute('data-mobile') === null);
  check('...and the context is then the inert desktop one (no-op actions)', seen.ctx.moreOpen === false && (seen.ctx.openMore(), seen.ctx.moreOpen === false));
  await act(async () => { flip(COARSE_POINTER_QUERY, true); });
  check('...and back on again', seen.hook === true && seen.ctx.isMobile === true);
  await act(async () => { root.unmount(); });
  const outside = { ctx: null };
  function Outside() { outside.ctx = useMobile(); return null; }
  const root2 = createRoot(win.document.getElementById('root'));
  await act(async () => { root2.render(React.createElement(Outside)); });
  check('outside the provider (the desktop app, standalone windows) useMobile is not mobile', outside.ctx.isMobile === false && typeof outside.ctx.toggleSidebar === 'function');
  await act(async () => { root2.unmount(); });
  fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
