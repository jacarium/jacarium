#!/usr/bin/env node
/**
 * Guards src/hooks/useDisplayName.js, the name a game mode / the Kanban
 * presence shows for THIS user:
 *   - desktop (Electron bridge): the OS username, i.e. the user part of
 *     `username@hostname`, whatever name is stored - unchanged behaviour;
 *   - browser: the id's user part until the name is known, then the name
 *     chosen in Settings, and it follows setDisplayName() live through the
 *     DISPLAY_NAME_EVENT without a remount;
 *   - no id yet: ''.
 *
 * The REAL hook + cloudCentralSync are bundled with esbuild (IndexedDB
 * siblings stubbed) and rendered with react-dom in jsdom.
 *
 * Run:  node tests/display-name-hook.test.mjs
 * SKIPs (exit 0) when esbuild, react or jsdom are missing
 * (npm install; npm install --no-save jsdom). Synthetic names only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['esbuild', 'react', 'react-dom', 'jsdom']) {
  try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install${dep === 'jsdom' ? ' --no-save jsdom' : ''})`); process.exit(0); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------- jsdom globals (one window for all contexts; storage per context) ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};
Object.defineProperty(dom.window, 'localStorage', { value: globalThis.localStorage, configurable: true });

// ---------- bundle the hook with the real cloudCentralSync ----------
const { build } = await import(req.resolve('esbuild'));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-name-hook-'));
const entry = path.join(workdir, 'entry.jsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useDisplayName } from '${path.join(REPO, 'src', 'hooks', 'useDisplayName.js').replace(/\\\\/g, '/')}';
export * as identity from '${path.join(REPO, 'src', 'utils', 'cloudCentralSync.js').replace(/\\\\/g, '/')}';
export { act };
export function Name({ machineId }) {
  const name = useDisplayName(machineId);
  return React.createElement('span', { 'data-testid': 'name' }, name);
}
export function mount(machineId) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => { root.render(React.createElement(Name, { machineId })); });
  return { el, root, rerender: (id) => act(() => { root.render(React.createElement(Name, { machineId: id })); }), text: () => el.textContent };
}
`);
const outfile = path.join(workdir, 'bundle.mjs');
const STUBS = new Set(['./documents', './workflows', './taskwarriorInstances', './cloudWebSocket', './uuid', './backendUrl']);
await build({
  entryPoints: [entry], bundle: true, outfile, format: 'esm', platform: 'node', logLevel: 'silent', jsx: 'automatic',
  absWorkingDir: REPO, nodePaths: [path.join(REPO, 'node_modules')], // the entry lives in a temp dir outside the repo
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'stub-siblings',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => (args.importer.includes(path.join('src', 'utils') + path.sep) && STUBS.has(args.path) ? { path: args.path, namespace: 'stub' } : null));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path === './uuid' ? 'export function generateUUID() { return "00000000-0000-4000-8000-000000000000"; }'
          : args.path === './backendUrl' ? 'export async function getBackendUrl() { return ""; } export async function apiFetch() { throw new Error("no backend"); }'
            : 'export const updateDocument = async () => {}; export const updateWorkflow = async () => {}; export const updateInstance = async () => {}; export const isWebSocketConnected = () => false;',
        loader: 'js'
      }));
    }
  }]
});

const settle = async () => { for (let i = 0; i < 5; i++) await sleep(10); };

// ---------- browser identity ----------
console.log('--- browser');
window.electronAPI = undefined;
let { mount, identity, act } = await import(pathToFileURL(outfile).href + '?ctx=browser');
const idA = await identity.getMachineId();
check('browser: a generated id', /^browser-[0-9a-f]{8}@/.test(idA), idA);
let view = mount(idA);
await act(async () => { await settle(); });
check('browser: default name is the generated name part', view.text() === idA.split('@')[0], view.text());
await act(async () => { identity.setDisplayName('Robin C.'); await settle(); });
check('browser: follows setDisplayName live (DISPLAY_NAME_EVENT, no remount)', view.text() === 'Robin C.', view.text());
await act(async () => { identity.setDisplayName(''); await settle(); });
check('browser: clearing the name goes back to the generated name', view.text() === idA.split('@')[0], view.text());
view.rerender(null);
await act(async () => { await settle(); });
check("browser: no id -> ''", view.text() === '', view.text());
identity.setDisplayName('Robin C.');
const fresh = mount(idA);
check('browser: before the name is known, the id user part (synchronous fallback)', fresh.text() === idA.split('@')[0] || fresh.text() === 'Robin C.', fresh.text());
await act(async () => { await settle(); });
check('browser: then the stored name', fresh.text() === 'Robin C.', fresh.text());

// ---------- desktop identity ----------
console.log('--- desktop');
window.electronAPI = { isElectron: true, getUsername: async () => 'alice', getHostname: async () => 'laptop.example.test', getMachineIdOverride: async () => null };
({ mount, identity, act } = await import(pathToFileURL(outfile).href + '?ctx=desktop'));
const idD = await identity.getMachineId();
check('desktop: id is username@hostname', idD === 'alice@laptop.example.test', idD);
view = mount(idD);
await act(async () => { await settle(); });
check('desktop: the name is the OS username although a Settings name is stored', view.text() === 'alice' && store.get('cloudDisplayName') === 'Robin C.', view.text());
await act(async () => { identity.setDisplayName('Someone Else'); await settle(); });
check('desktop: a rename does not change it', view.text() === 'alice', view.text());

fs.rmSync(workdir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
