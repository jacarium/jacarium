/**
 * Settings > Editor's "Export custom words" / "Import custom words"
 * (src/components/common/modals/settings/EditorSettings.jsx), the REAL
 * component under jsdom with a fake desktop bridge (window.electronAPI
 * .spellcheck) - no Electron, no network:
 *
 *   1. desktop: the list, the two buttons; Export saves
 *      jacarium-custom-words.txt through the app's download path (an
 *      anchor click on a Blob URL) with one sorted word per line and
 *      reports it;
 *   2. Import from a picked File (read in the renderer: only words reach
 *      the bridge): new words added through addWord, the ones already
 *      there and the invalid entries counted, the result sentence shown,
 *      the list refreshed from listWords; a JSON array file works too;
 *   3. an empty dictionary: Export is disabled, Import still offered;
 *   4. the browser deployment: no custom words, no buttons;
 *   5. Import Database's preview (ImportDBModal.jsx) lists the export's
 *      custom spelling words; an older export without them shows no line.
 *
 * Needs esbuild and jsdom. Run: node tests/editor-settings-custom-words.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom`); process.exit(1); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-settings-words-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export { default as EditorSettings } from '@worktree/src/components/common/modals/settings/EditorSettings.jsx';
  export { default as ImportDBModal } from '@worktree/src/components/common/modals/ImportDBModal.jsx';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' }, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'File', 'Blob', 'FileReader']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// the download path: downloadBlob() makes a Blob URL and clicks an anchor; both are captured here
const blobs = new Map();
let saved = null;
// (the bundle sees Node's global URL, whose createObjectURL refuses a jsdom Blob: stubbed on both)
for (const U of [globalThis.URL, dom.window.URL]) {
  U.createObjectURL = (blob) => { const u = `blob:test/${blobs.size + 1}`; blobs.set(u, blob); return u; };
  U.revokeObjectURL = () => {};
}
dom.window.HTMLAnchorElement.prototype.click = function click() { saved = { filename: this.download, blob: blobs.get(this.getAttribute('href')) }; };
const { EditorSettings, ImportDBModal, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);

// the fake desktop bridge: a Set is the dictionary
const dictionary = new Set(['zeta', 'alpha']);
const added = [];
const desktop = () => ({
  isElectron: true,
  spellcheck: {
    listWords: async () => [...dictionary].sort(),
    addWord: async (w) => { added.push(w); dictionary.add(w); return { ok: true }; },
    removeWord: async (w) => { dictionary.delete(w); return { ok: true }; },
    getLanguages: async () => ({ native: true, available: [], selected: [] }),
    setLanguages: async (codes) => ({ ok: true, selected: codes }),
  },
});
const root = createRoot(document.getElementById('root'));
const q = (sel) => document.querySelector(sel);
const text = (sel) => q(sel)?.textContent || '';
const listed = () => [...document.querySelectorAll('[data-testid="spellcheck-words"] span')].map((s) => s.textContent);
async function render() { await act(async () => { root.render(React.createElement(EditorSettings)); }); await act(async () => { await sleep(50); }); }
async function unmount() { await act(async () => { root.render(null); }); }
async function pickFile(name, content, type = 'text/plain') {
  const input = q('[data-testid="spellcheck-words-file"]');
  const file = new dom.window.File([content], name, { type });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await sleep(80); });
}

try {
  // ---- 1. desktop: the list and the export ----
  window.electronAPI = desktop();
  await render();
  check('1. desktop: the custom words are listed, Export and Import are offered next to them', listed().join() === 'alpha,zeta' && q('[data-testid="spellcheck-words-export"]') && q('[data-testid="spellcheck-words-import"]') && q('[data-testid="spellcheck-words-file"]')?.getAttribute('accept').includes('.txt'));
  check('1. the buttons are the shared Button in a ButtonRow (no one-off styling)', q('[data-testid="spellcheck-words-export"]').className.includes('btn') && q('[data-testid="spellcheck-words-export"]').closest('.sc-button-row') !== null);
  await act(async () => { q('[data-testid="spellcheck-words-export"]').click(); await sleep(20); });
  check('1. Export saves jacarium-custom-words.txt through the download path', saved?.filename === 'jacarium-custom-words.txt' && saved.blob?.type.startsWith('text/plain'), JSON.stringify(saved && { filename: saved.filename, type: saved.blob?.type }));
  const content = saved?.blob ? await saved.blob.text() : '';
  check('1. ...one sorted word per line, UTF-8, a final newline', content === 'alpha\nzeta\n', JSON.stringify(content));
  check('1. ...and says so', /Saved jacarium-custom-words\.txt \(2 words\)/.test(text('[data-testid="spellcheck-words-result"]')), text('[data-testid="spellcheck-words-result"]'));

  // ---- 2. import from a picked file ----
  await pickFile('words.txt', '﻿beta\r\nalpha\r\ntwo words\r\n\r\ngamma\n# a comment\nbeta\n');
  check('2. Import: the new words are added through the bridge (only words cross it), the present and the invalid ones counted', added.join() === 'beta,gamma', added.join());
  check('2. ...the result sentence: "2 words added, 1 already there, 1 skipped"', text('[data-testid="spellcheck-words-result"]') === '2 words added, 1 already there, 1 skipped', text('[data-testid="spellcheck-words-result"]'));
  check('2. ...the list is refreshed from listWords', listed().join() === 'alpha,beta,gamma,zeta', listed().join());
  await pickFile('words.json', '["delta", "beta", 5]', 'application/json');
  check('2. a JSON array file: "1 word added, 1 already there, 1 skipped", list refreshed', text('[data-testid="spellcheck-words-result"]') === '1 word added, 1 already there, 1 skipped' && listed().includes('delta'), text('[data-testid="spellcheck-words-result"]'));
  await pickFile('nothing.txt', 'two words\n');
  check('2. a file with nothing usable: a warning, "0 words added, 1 skipped", nothing added', text('[data-testid="spellcheck-words-result"]') === '0 words added, 1 skipped' && q('[data-testid="spellcheck-words-result"]').className.includes('amber'), text('[data-testid="spellcheck-words-result"]'));
  await unmount();

  // ---- 3. an empty dictionary ----
  dictionary.clear();
  window.electronAPI = desktop();
  await render();
  check('3. an empty dictionary: the empty note, Export disabled, Import offered', q('[data-testid="spellcheck-words-empty"]') && q('[data-testid="spellcheck-words-export"]').disabled && !q('[data-testid="spellcheck-words-import"]').disabled);
  await unmount();

  // ---- 4. the browser deployment ----
  window.electronAPI = undefined;
  await render();
  check('4. browser: no custom words section, no export / import buttons (the browser owns its dictionary)', !q('[data-testid="spellcheck-words"]') && !q('[data-testid="spellcheck-words-export"]') && !q('[data-testid="spellcheck-words-import"]') && q('[data-testid="editor-spellcheck-toggle"]'));
  await unmount();

  // ---- 5. Import Database's preview ----
  const exportFile = (extra) => JSON.stringify({ version: '1.0', documents: [], documentTemplates: [], jqlTemplates: [], engineTemplates: [], ...extra });
  async function preview(content) {
    await act(async () => { root.render(React.createElement(ImportDBModal, { isOpen: true, onClose() {}, onImport: async () => null, onDryRun: async () => null })); });
    const input = q('input[type="file"][accept="application/json"]');
    const file = new dom.window.File([content], 'jacarium-db.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await sleep(80); });
    const line = text('[data-testid="import-preview-custom-words"]');
    const themes = text('[data-testid="import-preview-custom-themes"]');
    await unmount();
    return themes === '' ? line : themes;
  }
  let line = await preview(exportFile({ customWords: { formatVersion: 1, words: ['alpha', 'beta', 'gamma'] } }));
  check('5. Import Database preview: "3 custom spelling words" from the export', line === '3 custom spelling words', line);
  line = await preview(exportFile({ customWords: { formatVersion: 1, words: ['alpha'] } }));
  check('5. ...one word: "1 custom spelling word"', line === '1 custom spelling word', line);
  line = await preview(exportFile({}));
  check('5. ...an older export without customWords: no line', line === '', line);
  const themeOf = (name) => ({ id: `ct-${name}00000000`, name, base: 'dark', colors: { canvas: '#0f0d16', card: '#17141f', cardSecondary: '#211c30', codeBg: '#141120', textPrimary: '#ede6ff', textSecondary: '#b9afd6', textMuted: '#8f84ad', accent: '#4a9eff', border: '#2a2438', success: '#3fa37a', warning: '#facc15', danger: '#f87171', railText: '#b9afd6', sidebar: '#15121f', markArch: '#7b5ce0', markBlossom: '#ede6ff' }, fills: { rail: { type: 'solid', color: '#1b1530' } }, logoTone: 'dark' });
  line = await preview(exportFile({ customThemes: { formatVersion: 1, themes: [themeOf('a'), themeOf('b'), themeOf('c')] } }));
  check('5. Import Database preview: "3 custom themes" from the export (the Palette line, shown only with the field)', line === '3 custom themes', line);
  line = await preview(exportFile({ customThemes: { formatVersion: 1, themes: [themeOf('a')] } }));
  check('5. ...one theme: "1 custom theme"', line === '1 custom theme', line);
  line = await preview(exportFile({ customThemes: { formatVersion: 1, themes: [] } }));
  check('5. ...an export with no saved themes (the section is always written): "0 custom themes"', line === '0 custom themes', line);
  line = await preview(exportFile({ customWords: { formatVersion: 1, words: ['alpha'] } }));
  check('5. ...an export without customThemes: the words line only, no themes line', line === '1 custom spelling word', line);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
