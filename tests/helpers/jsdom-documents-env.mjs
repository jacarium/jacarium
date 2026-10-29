/**
 * Shared jsdom + fake-indexeddb environment for the Documents import/export
 * tests (tests/documents-import-json.test.mjs,
 * tests/documents-export-category.test.mjs). Same recipe as
 * tests/document-category-duplicates.test.mjs, factored out:
 *
 *   - checks the deps and prints the install command when one is missing;
 *   - installs the browser globals React/Dexie/FileReader need;
 *   - bundles tests/helpers/documents-import-entry.mjs with esbuild (the
 *     extensionless ESM imports in src/ are Vite-style) into a temp CJS file
 *     and loads it in-process;
 *   - captures every "download" (src/utils/exportHelpers.js downloadBlob:
 *     URL.createObjectURL + <a download>.click()) into `downloads` as
 *     { name, blob, text() } instead of navigating, so export output can be
 *     read back and fed to the importer.
 *
 * Returns { mod, window, downloads, consoleErrors, sleep, check, summary }.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
export const FIXTURES = path.join(here, '..', 'fixtures', 'documents-import');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecker() {
  const results = [];
  function check(name, cond, detail) {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
  }
  function summary() {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log('Failed:');
      for (const f of failed) console.log(`  - ${f.name}`);
    }
    return failed.length ? 1 : 0;
  }
  return { check, summary, results };
}

/**
 * @param {string} name - temp-dir prefix for the bundle
 * @param {{ entry?: string, stubs?: Record<string, string> }} [options] - `entry`: an
 *   alternative jsdom entry module to bundle instead of documents-import-entry.mjs
 *   (e.g. tests/helpers/find-in-files-entry.mjs); `@worktree/` resolves to the
 *   repo. `stubs`: { '<import specifier ending>': '<absolute stub module>' } -
 *   every import whose specifier ends with the key (e.g. 'utils/cloudWebSocket')
 *   is bundled from the stub instead (a fake socket for the Yjs editor).
 */
export async function setupDocumentsEnv(name, { entry = path.join(here, 'documents-import-entry.mjs'), stubs = {} } = {}) {
  requireResolvable('react', 'Run: npm install');
  requireResolvable('esbuild', 'Run: npm install');
  requireResolvable('dexie', 'Run: npm install');
  requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
  requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

  const { JSDOM } = await import(req.resolve('jsdom'));
  await import(req.resolve('fake-indexeddb/auto'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const define = (key, value) => {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
      try { globalThis[key] = value; } catch { /* ignore */ }
    }
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage', 'FileReader', 'File']) {
    define(key, window[key]);
  }
  define('getComputedStyle', window.getComputedStyle.bind(window));
  define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  define('cancelAnimationFrame', (id) => clearTimeout(id));
  class FakeObserver { observe() {} unobserve() {} disconnect() {} }
  define('ResizeObserver', FakeObserver);
  define('IntersectionObserver', FakeObserver);
  window.ResizeObserver = FakeObserver;
  window.IntersectionObserver = FakeObserver;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }));
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
  // database.js runs its legacy-migration checks on import; mark them done.
  for (const flag of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) {
    window.localStorage.setItem(flag, 'true');
  }

  // ---- download capture (exportHelpers.downloadBlob) ----
  const downloads = [];
  const blobsByUrl = new Map();
  let urlCounter = 0;
  const realCreate = URL.createObjectURL ? URL.createObjectURL.bind(URL) : null;
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${++urlCounter}`;
    blobsByUrl.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    const blob = blobsByUrl.get(this.href) || null;
    downloads.push({ name: this.download, blob, text: () => (blob ? blob.text() : Promise.resolve(null)) });
  };
  void realCreate;

  // Quiet the app's own "[Documents] ..." logging; keep everything else.
  const consoleErrors = [];
  const realLog = console.log;
  console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('[')) return; realLog(...args); };
  const realError = console.error;
  console.error = (...args) => {
    const msg = args.map(String).join(' ');
    consoleErrors.push(msg);
    if (typeof args[0] === 'string' && args[0].startsWith('[')) return;
    realError(...args);
  };

  // ---- bundle the real modules + sidebar ----
  const { build } = await import(req.resolve('esbuild'));
  const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: BUNDLE,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
    nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{
      name: 'alias',
      setup(b) {
        for (const [ending, stub] of Object.entries(stubs)) {
          const re = new RegExp(`${ending.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?$`);
          b.onResolve({ filter: re }, () => ({ path: stub }));
        }
        b.onResolve({ filter: /^@worktree\// }, (args) => ({
          path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
        }));
        b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          try { return { path: req.resolve(args.path) }; } catch { return null; }
        });
      },
    }],
    logLevel: 'warning',
  });
  const mod = req(BUNDLE);
  return { mod, window, downloads, consoleErrors, sleep, WORKDIR };
}

/** Read a synthetic fixture from tests/fixtures/documents-import/. */
export function fixture(file) {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

// ---------- UI driving helpers (React-aware) ----------

/** Set a textarea/input value the way React sees it (native setter + input event). */
export function typeInto(window, el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Smallest visible-ish element of `tag` whose trimmed text matches. */
export function byText(document, re, tag = 'button') {
  return Array.from(document.querySelectorAll(tag))
    .filter((e) => re.test((e.textContent || '').trim()))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
}

export function click(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Poll until fn() is truthy (returns it) or the timeout passes (returns the last value). */
export async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

/** Choose a file through a hidden <input type="file"> the way the browser would. */
export function chooseFile(window, input, file) {
  const list = { 0: file, length: 1, item: (i) => (i === 0 ? file : null), [Symbol.iterator]: function* () { yield file; } };
  Object.defineProperty(input, 'files', { value: list, configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** Drop a file on an element (jsdom has no DragEvent; a plain event with dataTransfer is what React reads). */
export function dropFile(window, el, file) {
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], items: [], types: ['Files'] } });
  el.dispatchEvent(ev);
}
