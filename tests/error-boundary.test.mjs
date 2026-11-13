#!/usr/bin/env node
/**
 * The shared error boundary (src/components/common/ErrorBoundary.jsx): a
 * popup or page that throws while rendering shows the fallback where it
 * would have been, the rest of the tree (the rail) stays, the error goes to
 * the notification channel, and "Reload this view" mounts the children
 * again. The REAL component runs under jsdom (React 19). Plus the wiring:
 * the root (src/main.jsx), the shell's page slot (JQLBuilder) and every
 * createPortal in src/components render inside a boundary.
 *
 * Preconditions: npm install, plus the test-only deps the jsdom tests share
 *   (npm install --no-save jsdom fake-indexeddb - see tests/run-all.sh).
 * Run: node tests/error-boundary.test.mjs
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---------- the wiring (static) ----------
const main = read('src/main.jsx');
check('src/main.jsx renders the app inside the boundary (scope app)', /render\(<ErrorBoundary scope="app"><App \/><\/ErrorBoundary>\)/.test(main) && /import ErrorBoundary from '\.\/components\/common\/ErrorBoundary\.jsx'/.test(main));
const shell = read('src/components/JQLBuilder.jsx');
check('the shell\'s page slot sits inside a page boundary that resets when the page changes', /<ErrorBoundary scope="page" label=\{[^\n]*\} resetKeys=\{\[currentPage\]\}>\s*<Suspense fallback=\{<PageLoadingFallback \/>\}>/.test(shell) && /<\/Suspense>\s*<\/ErrorBoundary>/.test(shell));
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.jsx?$/.test(e.name)) files.push(p); } };
walk(path.join(REPO, 'src/components'));
const unguarded = [];
let portals = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (!/createPortal\(/.test(text)) continue;
  const rel = path.relative(REPO, f);
  if (rel === 'src/components/common/ErrorBoundary.jsx') continue;
  const hasImport = /import ErrorBoundary from '[^']*ErrorBoundary'/.test(text);
  for (const m of text.matchAll(/createPortal\(/g)) {
    portals++;
    const after = text.slice(m.index, m.index + 400);
    if (!hasImport || !/<ErrorBoundary scope="popup"/.test(after)) unguarded.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
  }
}
check(`every createPortal in src/components (${portals}) renders its layer inside a popup boundary`, unguarded.length === 0, unguarded.join(', '));
const boundary = read('src/components/common/ErrorBoundary.jsx');
check('the boundary reports to the console and the notification channel (NOTIFY_EVENT), with theme tokens only', /componentDidCatch/.test(boundary) && /NOTIFY_EVENT/.test(boundary) && /console\.error/.test(boundary) && !/#[0-9a-fA-F]{3,8}\b/.test(boundary) && /bg-os-card|text-os-text-primary/.test(boundary));
const hook = read('src/hooks/usePopupPosition.js');
check('usePopupPosition never lets a measurement error escape its layout effect (placement skipped, the popup kept where it was, warned once)', /try \{ placeNow\(\); \} catch \(e\) \{/.test(hook) && /Object\.assign\(node\.style, before\)/.test(hook));

// ---------- jsdom ----------
for (const dep of ['jsdom', 'esbuild']) { try { req.resolve(dep); } catch { console.log(`Missing test-only dependency "${dep}". Install it without saving: npm install --no-save jsdom fake-indexeddb`); process.exit(failed ? 1 : 0); } }
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://console.example.test/' });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver']) {
  if (window[key] !== undefined) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { build } = await import(req.resolve('esbuild'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'error-boundary-'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
fs.writeFileSync(ENTRY, `
  export { default as ErrorBoundary } from '@worktree/src/components/common/ErrorBoundary.jsx';
  export { NOTIFY_EVENT } from '@worktree/src/contexts/NotificationContext.jsx';
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
const { ErrorBoundary, NOTIFY_EVENT, React, createRoot, act } = req(BUNDLE);
const realError = console.error; const realWarn = console.warn;
const quiet = () => { console.error = () => {}; console.warn = () => {}; };
const loud = () => { console.error = realError; console.warn = realWarn; };
const h = React.createElement;

let explode = true;
function Bomb() { if (explode) throw new Error('menu exploded'); return h('div', { 'data-testid': 'menu-ok' }, 'menu rendered'); }
const notified = [];
window.addEventListener(NOTIFY_EVENT, (e) => notified.push(e.detail));

const root = createRoot(document.getElementById('root'));
const render = (el) => act(() => { root.render(el); });
quiet();
await render(h('div', null,
  h('nav', { 'data-testid': 'rail' }, 'rail'),
  h(ErrorBoundary, { scope: 'page', label: 'the Documents page' }, h(Bomb))));
loud();
const fb = () => document.querySelector('[data-testid="error-boundary"]');
check('a page that throws shows the page fallback with the error, and the rail stays', !!fb() && fb().getAttribute('data-scope') === 'page' && /Something went wrong in the Documents page/.test(fb().textContent) && /menu exploded/.test(fb().textContent) && document.querySelector('[data-testid="rail"]')?.textContent === 'rail', document.body.innerHTML.slice(0, 400));
check('the error reached the notification channel', notified.length === 1 && notified[0].type === 'error' && /the Documents page/.test(notified[0].title) && /menu exploded/.test(notified[0].message), JSON.stringify(notified));
explode = false;
await act(async () => { document.querySelector('[data-testid="error-boundary-reset"]').click(); await sleep(10); });
check('"Reload this view" mounts the children again', !fb() && !!document.querySelector('[data-testid="menu-ok"]'), document.body.innerHTML.slice(0, 300));

// the popup scope: a small fallback, Close resets through onReset (the owner closes the menu)
explode = true; let closed = 0;
quiet();
await render(h('div', null, h('nav', { 'data-testid': 'rail' }, 'rail'), h(ErrorBoundary, { scope: 'popup', label: 'This menu', onReset: () => { closed++; } }, h(Bomb))));
loud();
check('a popup that throws shows the small popup fallback ("could not open"), the rail stays', !!fb() && fb().getAttribute('data-scope') === 'popup' && /This menu could not open: menu exploded/.test(fb().textContent) && !!document.querySelector('[data-testid="rail"]'), document.body.innerHTML.slice(0, 300));
explode = false;   // the owner closes the menu on reset; here the content simply renders again
await act(async () => { fb().querySelector('button').click(); await sleep(10); });
check('its Close resets the boundary and tells the owner (onReset); the content renders again', closed === 1 && notified.length === 2 && !fb() && !!document.querySelector('[data-testid="menu-ok"]'), JSON.stringify({ closed, notified: notified.length }));

// resetKeys: the page boundary resets when the page changes
explode = true;
function Page({ page }) { if (page === 'broken') throw new Error('page broke'); return h('div', { 'data-testid': 'page-ok' }, page); }
quiet();
await render(h(ErrorBoundary, { scope: 'page', resetKeys: ['broken'] }, h(Page, { page: 'broken' })));
loud();
check('a broken page shows the fallback', !!fb());
await render(h(ErrorBoundary, { scope: 'page', resetKeys: ['documents'] }, h(Page, { page: 'documents' })));
check('changing the page (resetKeys) resets the boundary and the new page renders', !fb() && document.querySelector('[data-testid="page-ok"]')?.textContent === 'documents', document.body.innerHTML.slice(0, 300));

// a child that throws on every mount can never spin the boundary: one automatic retry, then the fallback stays
let attempts = 0;
function AlwaysBroken() { attempts++; throw new Error('always broken'); }
quiet();
await render(h(ErrorBoundary, { key: 'always', scope: 'page', resetKeys: ['k1'] }, h(AlwaysBroken)));
const afterFirst = attempts;
await render(h(ErrorBoundary, { key: 'always', scope: 'page', resetKeys: ['k2'] }, h(AlwaysBroken)));   // the auto retry: mounts again, throws again
const afterRetry = attempts;
await render(h(ErrorBoundary, { key: 'always', scope: 'page', resetKeys: ['k3'] }, h(AlwaysBroken)));   // within a second: no retry
await render(h(ErrorBoundary, { key: 'always', scope: 'page', resetKeys: ['k4'] }, h(AlwaysBroken)));
loud();
check('a child that throws on every mount gets one automatic retry (it mounted once more), then the fallback stays (data-gave-up) and no further mounts happen', afterRetry > afterFirst && attempts === afterRetry && !!fb() && fb().getAttribute('data-gave-up') === 'true' && /failed again right after a retry/.test(fb().textContent), JSON.stringify({ afterFirst, afterRetry, attempts, gaveUp: fb() && fb().getAttribute('data-gave-up') }));
quiet();
await act(async () => { document.querySelector('[data-testid="error-boundary-reset"]').click(); await sleep(10); });
loud();
check('a click on Reload still tries once more (it mounts again and the fallback shows again)', attempts > afterRetry && !!fb(), JSON.stringify({ attempts, afterRetry }));

await act(() => { root.unmount(); });
try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
