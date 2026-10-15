/**
 * Guards the recovery from a stale page after a redeploy
 * (src/utils/chunkReload.js, src/components/StartupError.jsx, wired in
 * src/main.jsx):
 *   - a chunk-load failure (Safari / Chrome / Firefox / Vite wordings)
 *     reloads the page exactly once (sessionStorage flag);
 *   - the same failure after that reload does NOT reload again: the error
 *     screen shows, with a Reload button and the hard-reload hint;
 *   - an unrelated error never reloads;
 *   - once the app started, the flag is cleared so the NEXT redeploy may
 *     reload again;
 *   - no storage at all: reload once per page load, never a loop.
 * Run: node tests/chunk-reload.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['react', 'esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom`); process.exit(1); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-reload-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import StartupError from '@worktree/src/components/StartupError.jsx';
export * as chunk from '@worktree/src/utils/chunkReload.js';
export function mount(props) { const root = createRoot(document.getElementById('root')); root.render(<StartupError {...props} />); return root; }
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'warning',
});
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.test/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MouseEvent']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
const { chunk, mount } = createRequire(import.meta.url)(BUNDLE);

try {
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const wordings = [
    new TypeError('Importing a module script failed.'),                         // Safari
    new TypeError('Failed to fetch dynamically imported module: https://x/assets/DocumentsPage-abc.js'), // Chrome
    new TypeError('error loading dynamically imported module: https://x/assets/a.js'), // Firefox
    new Error('Unable to preload CSS for /assets/a.css'),                        // Vite preload
    { payload: new Error('Failed to fetch dynamically imported module') },      // vite:preloadError event
    { reason: new TypeError('Importing a module script failed.') },             // unhandledrejection event
  ];
  check('every chunk-load wording is recognised', wordings.every((e) => chunk.isChunkLoadError(e)));
  check('an unrelated error is not', !chunk.isChunkLoadError(new Error('Cannot read properties of undefined')) && !chunk.isChunkLoadError(null));

  const s1 = storage(); let reloads = 0;
  const first = chunk.recoverFromChunkLoadError(wordings[0], { storage: s1, reload: () => { reloads++; } });
  const second = chunk.recoverFromChunkLoadError(wordings[1], { storage: s1, reload: () => { reloads++; } });
  check('the first stale-chunk failure reloads the page once', first === 'reloaded' && reloads === 1);
  check('the same failure after the reload does not reload again (the error screen shows instead)', second === 'failed' && reloads === 1);
  check('an unrelated error never reloads', chunk.recoverFromChunkLoadError(new Error('boom'), { storage: s1, reload: () => { reloads++; } }) === 'not-chunk' && reloads === 1);
  chunk.clearChunkReloadFlag(s1);
  check('once the app started the flag is cleared: the next redeploy may reload again', chunk.recoverFromChunkLoadError(wordings[2], { storage: s1, reload: () => { reloads++; } }) === 'reloaded' && reloads === 2);
  let noStorageReloads = 0;
  check('without storage it still reloads (once per page load)', chunk.recoverFromChunkLoadError(wordings[0], { storage: null, reload: () => { noStorageReloads++; } }) === 'reloaded' && noStorageReloads === 1);

  // the error screen
  const root = mount({ error: new TypeError('Importing a module script failed.'), staleChunk: true });
  await sleep(50);
  const el = document.querySelector('[data-testid="startup-error"]');
  check('the error screen names the error and the stale-page cause', el && /could not start/.test(el.textContent) && /Importing a module script failed/.test(el.textContent) && /server was updated/.test(el.textContent) && el.dataset.staleChunk === 'true');
  check('...with a Reload button and the hard-reload hint', !!document.querySelector('[data-testid="startup-reload"]') && /hard-reload the page \((Cmd|Ctrl)\+Shift\+R/.test(el.textContent), el?.textContent.slice(-120));
  root.unmount();
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
