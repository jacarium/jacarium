/**
 * Custom themes in the database import's summaries (Import Database): the
 * real src/utils/importDatabase.js runImport against fake-indexeddb, driven
 * through ImportDBModal under jsdom:
 *
 *  - the Dry Run in replace mode and in merge mode shows the "Custom themes"
 *    row with New / Replaced / Unchanged / Invalid and the invalid entry's
 *    reason, and writes nothing
 *  - the real import shows the same row in the result table and the themes
 *    land in storage (a new one added, a newer copy replaces, an older copy
 *    leaves the stored one alone)
 *
 * Needs esbuild, jsdom and fake-indexeddb (npm install --no-save jsdom
 * fake-indexeddb). Run: node tests/custom-themes-db-import.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb', 'dexie']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(0); } }

const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-themes-db-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export { default as ImportDBModal } from '@worktree/src/components/common/modals/ImportDBModal.jsx';
  export { runImport } from '@worktree/src/utils/importDatabase.js';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
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
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'FileReader', 'File', 'Blob']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|not mocked|Failed to/.test(String(a[0] ?? ''))) return; origErr(...a); };
console.warn = () => {}; console.log = ((orig) => (...a) => { if (/^(PASS|FAIL|SKIP|\n|All checks|\d+ check)/.test(String(a[0] ?? ''))) orig(...a); })(console.log);
const { ImportDBModal, runImport, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const text = (s) => ($(s) ? $(s).textContent.trim() : '');
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(30); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }); for (let i = 0; i < 40; i++) { await act(async () => { await sleep(50); }); if (!$$('button').some((b) => /Running|Importing/.test(b.textContent))) break; } };
const clickText = (label) => click($$('button').find((b) => b.textContent.trim() === label));
const stored = () => JSON.parse(localStorage.getItem('jacarium-custom-themes') || '[]');

// the stored themes and the file: A is new, B's copy is older (unchanged), C's copy is newer (replaced), one entry is junk
const mk = (id, name, updatedAt) => ({ ...ct.defaultTheme('dark', name), id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt });
const B = mk('ct-bbbbbbbb0000', 'Bravo', '2026-03-01T00:00:00.000Z');
const C = mk('ct-cccccccc0000', 'Charlie', '2026-01-02T00:00:00.000Z');
localStorage.setItem('jacarium-custom-themes', JSON.stringify([B, C]));
const file = {
  version: '1.0', exportDate: '2026-11-01T10:00:00.000Z', documents: [], documentTemplates: [], jqlTemplates: [], engineTemplates: [],
  customThemes: { formatVersion: 1, themes: [mk('ct-aaaaaaaa0000', 'Alpha', '2026-02-01T00:00:00.000Z'), { ...B, updatedAt: '2026-02-01T00:00:00.000Z' }, { ...C, name: 'Charlie (newer)', updatedAt: '2026-05-01T00:00:00.000Z' }, { bogus: true }] },
};
const rowFor = (label) => {
  const headers = $$('[data-testid="import-stats"] thead th').map((th) => th.textContent.trim());
  const tr = $$('[data-testid="import-stats"] tbody tr').find((r) => r.querySelector('td') && r.querySelector('td').textContent.includes(label));
  if (!tr) return null;
  const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
};

try {
  const before = JSON.stringify(stored());
  await render(React.createElement(ImportDBModal, { isOpen: true, onClose() {}, onImport: (data, merge) => runImport(data, merge, { dryRun: false }), onDryRun: (data, merge) => runImport(data, merge, { dryRun: true }) }));
  const input = $('input[type="file"][accept="application/json"]');
  const f = new window.File([JSON.stringify(file)], 'jacarium-db.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(80); });
  check('the Import Summary preview lists "4 custom themes" (the entries in the file)', text('[data-testid="import-preview-custom-themes"]') === '4 custom themes', text('[data-testid="import-preview-custom-themes"]'));

  // replace mode (the default) - dry run
  await clickText('Dry Run');
  let row = rowFor('Custom themes');
  check('Dry Run (replace mode): the "Custom themes" row with New 1, Replaced 1, Unchanged 1, Invalid 1', !!row && /Dry run \(replace mode\)/.test(text('[data-testid="import-stats"]')) && row.New === '1' && row.Replaced === '1' && row.Unchanged === '1' && row.Invalid === '1', JSON.stringify(row) + ' ' + text('[data-testid="import-stats"]').slice(0, 200));
  check('...the invalid entry is explained with its reason', /not a valid theme \(unknown keys, a bad colour or fill, a name over 60 characters\)/.test(text('[data-testid="import-stats"]')) && /1 entry/.test(text('[data-testid="import-stats"]')));
  check('...and nothing was written', JSON.stringify(stored()) === before);

  // merge mode - dry run
  await click($('[data-testid="import-db-modal"] input[type="checkbox"]') || $$('input[type="checkbox"]')[0]);
  check('toggling merge mode clears the stale result', !$('[data-testid="import-stats"]'));
  await clickText('Dry Run');
  row = rowFor('Custom themes');
  check('Dry Run (keep existing data mode): the same "Custom themes" row and columns', !!row && /Dry run \(keep existing data mode\)/.test(text('[data-testid="import-stats"]')) && row.New === '1' && row.Replaced === '1' && row.Unchanged === '1' && row.Invalid === '1' && JSON.stringify(stored()) === before, JSON.stringify(row) + ' ' + text('[data-testid="import-stats"]').slice(0, 200));

  // the real import (merge mode)
  await clickText('Import Database');
  row = rowFor('Custom themes');
  check('Import Database: the result table carries the "Custom themes" row with the same counts', !!row && /Import complete \(keep existing data mode\)/.test(text('[data-testid="import-stats"]')) && row.New === '1' && row.Replaced === '1' && row.Unchanged === '1' && row.Invalid === '1', JSON.stringify(row) + ' ' + text('[data-testid="import-stats"]').slice(0, 200));
  const after = stored();
  check('...the themes landed: Alpha added, Charlie replaced by the newer copy, Bravo kept (the older copy ignored), the junk dropped', after.length === 3 && after.find((t) => t.id === 'ct-aaaaaaaa0000')?.name === 'Alpha' && after.find((t) => t.id === 'ct-cccccccc0000')?.name === 'Charlie (newer)' && after.find((t) => t.id === 'ct-bbbbbbbb0000')?.updatedAt === B.updatedAt, JSON.stringify(after.map((t) => [t.id, t.name, t.updatedAt])));
  await render(null);

  // the real import in replace mode, from a fresh dialog
  localStorage.setItem('jacarium-custom-themes', JSON.stringify([B, C]));
  await render(React.createElement(ImportDBModal, { isOpen: true, onClose() {}, onImport: (data, merge) => runImport(data, merge, { dryRun: false }), onDryRun: (data, merge) => runImport(data, merge, { dryRun: true }) }));
  const input2 = $('input[type="file"][accept="application/json"]');
  Object.defineProperty(input2, 'files', { value: [f], configurable: true });
  await act(async () => { input2.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(80); });
  await clickText('Import Database');
  row = rowFor('Custom themes');
  check('Import Database (replace mode): the row in the result table, the themes merged by id the same way (a replace never deletes your themes)', !!row && /Import complete \(replace mode\)/.test(text('[data-testid="import-stats"]')) && row.New === '1' && row.Replaced === '1' && row.Unchanged === '1' && row.Invalid === '1' && stored().length === 3 && stored().some((t) => t.name === 'Charlie (newer)'), JSON.stringify(row) + ' ' + JSON.stringify(stored().map((t) => t.name)));
  await render(null);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
