#!/usr/bin/env node
/**
 * Guards the cloud-sync identity in src/utils/cloudCentralSync.js
 * (getMachineId / getDisplayName) in both hosts.
 *
 * THE BUG: in a browser (the container deployment) there is no
 * window.electronAPI, and getMachineId() fell back to "unknown@unknown"
 * for every browser on every container. The central server pairs a
 * machine_id with exactly one client secret, so the first browser to
 * register took the identity and every other one got
 * 403 MACHINE_ID_ALREADY_REGISTERED; ownership checks lumped them together.
 *
 * What this test proves:
 *  Desktop (window.electronAPI present) - unchanged behaviour:
 *   - `${username}@${hostname}` from the preload bridge;
 *   - the MACHINE_ID override (dev / testing builds) wins and is not cached;
 *   - the display name is the OS username, the Settings name is ignored.
 *  Browser (no electronAPI):
 *   - the id is browser-<8 hex>@<host>, generated once and persisted in
 *     localStorage, never "unknown@unknown";
 *   - the host part is the hostname the backend reports (/api/capabilities),
 *     a bare container id (12 hex) is skipped for the address-bar host, and
 *     with neither it is "browser"; labels are sanitised;
 *   - two browser contexts get DIFFERENT ids; the same context gets the SAME
 *     id again after a reload; a corrupt stored value is replaced;
 *   - when localStorage throws, the id is still unique (per page load);
 *   - the display name: '' -> the generated name part; set/validate/clear;
 *     '@', control characters and >32 chars are refused;
 *  - without an account there is no central server: no URL, the auth
 *    headers throw NO_CENTRAL_SERVER, no pairing API exists (the signed-in
 *    path is tests/account-central-identity.test.mjs).
 *
 * The REAL module is bundled with esbuild (IndexedDB-backed siblings
 * stubbed) and imported once per browser context, each with its own
 * in-memory localStorage.
 *
 * Run:  node tests/browser-machine-id.test.mjs
 * SKIPs (exit 0) when esbuild is missing. Synthetic names and hosts only;
 * no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
try { req.resolve('esbuild'); } catch { console.log('SKIP: esbuild missing (npm install)'); process.exit(0); }

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------- bundle the real module once ----------
const { build } = await import(req.resolve('esbuild'));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-machine-id-'));
const outfile = path.join(workdir, 'cloudCentralSync.bundle.mjs');
const STUBS = new Set(['./documents', './workflows', './taskwarriorInstances', './cloudWebSocket', './uuid', './backendUrl']);
await build({
  entryPoints: [path.join(REPO, 'src', 'utils', 'cloudCentralSync.js')],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  plugins: [{
    name: 'stub-siblings',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const fromUtils = args.importer.includes(path.join('src', 'utils') + path.sep);
        if (fromUtils && STUBS.has(args.path)) return { path: args.path, namespace: 'stub' };
        return null;
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path === './uuid'
          ? 'export function generateUUID() { return "00000000-0000-4000-8000-000000000000"; }'
          : args.path === './backendUrl'
            ? 'export async function getBackendUrl() { return ""; } export async function apiFetch() { throw new Error("no backend in this test"); }'
            : 'export const updateDocument = async () => {}; export const updateWorkflow = async () => {}; export const updateInstance = async () => {}; export const isWebSocketConnected = () => false;',
        loader: 'js'
      }));
    }
  }]
});

// A "browser context": its own localStorage + window, and a fresh copy of the
// module (import with a unique query so the module-level cache is new).
let contextCount = 0;
function makeStorage(initial = new Map()) {
  const store = initial;
  return {
    store,
    api: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    }
  };
}
async function openContext({ electronAPI = undefined, storage = makeStorage(), locationHostname = 'console.example.test', throwingStorage = false } = {}) {
  // throwingStorage: the identity keys cannot be read or written (quota /
  // blocked site data); the rest of the module's keys keep working.
  const IDENTITY_KEYS = new Set(['cloudBrowserMachineId', 'cloudDisplayName']);
  const refuse = (k) => { if (IDENTITY_KEYS.has(k)) throw new Error('storage disabled'); };
  globalThis.localStorage = throwingStorage
    ? {
        getItem: (k) => { refuse(k); return storage.api.getItem(k); },
        setItem: (k, v) => { refuse(k); storage.api.setItem(k, v); },
        removeItem: (k) => { refuse(k); storage.api.removeItem(k); }
      }
    : storage.api;
  globalThis.window = { electronAPI, localStorage: globalThis.localStorage };
  globalThis.location = { hostname: locationHostname };
  const mod = await import(`${pathToFileURL(outfile).href}?ctx=${++contextCount}`);
  return { mod, storage };
}

// ---------- desktop: unchanged ----------
console.log('--- desktop (Electron bridge)');
{
  const electronAPI = { isElectron: true, getUsername: async () => 'alice', getHostname: async () => 'laptop.example.test', getMachineIdOverride: async () => null };
  const { mod } = await openContext({ electronAPI });
  check('desktop: machine id is username@hostname', (await mod.getMachineId()) === 'alice@laptop.example.test', await mod.getMachineId());
  check('desktop: not a browser identity', mod.isBrowserIdentity(await mod.getMachineId()) === false);
  mod.setDisplayName('Someone Else');
  check('desktop: display name is the OS username, the Settings name is ignored', (await mod.getDisplayName()) === 'alice');
  check('desktop: nothing generated into storage', !globalThis.localStorage.getItem('cloudBrowserMachineId'));
}
{
  let overrideCalls = 0;
  const electronAPI = { isElectron: true, getUsername: async () => 'alice', getHostname: async () => 'laptop.example.test', getMachineIdOverride: async () => { overrideCalls++; return 'tester-2@testing'; } };
  const { mod } = await openContext({ electronAPI });
  check('desktop: MACHINE_ID override wins', (await mod.getMachineId()) === 'tester-2@testing');
  await mod.getMachineId();
  check('desktop: the override is consulted on every call (never cached)', overrideCalls === 2, String(overrideCalls));
}

// ---------- browser ----------
console.log('--- browser (no Electron bridge)');
const ID_RE = /^browser-[0-9a-f]{8}@[a-z0-9][a-z0-9.-]*$/;
const a = await openContext();
const idA = await a.mod.getMachineId();
check('browser A: id has the browser-<8 hex>@<host> shape', ID_RE.test(idA), idA);
check('browser A: never unknown@unknown', idA !== 'unknown@unknown' && !idA.includes('unknown'));
check('browser A: host part is the address-bar host when the backend reported none', idA.endsWith('@console.example.test'), idA);
check('browser A: persisted in localStorage', a.storage.store.get('cloudBrowserMachineId') === idA);
check('browser A: stable within the context', (await a.mod.getMachineId()) === idA);
check('browser A: recognised as a browser identity', a.mod.isBrowserIdentity(idA) === true);

const b = await openContext();
const idB = await b.mod.getMachineId();
check('browser B: also well-formed', ID_RE.test(idB), idB);
check('browser A and B: DIFFERENT ids', idA !== idB, `${idA} vs ${idB}`);

const aReload = await openContext({ storage: a.storage });
check('browser A after reload: the SAME id again', (await aReload.mod.getMachineId()) === idA);

{
  const corrupt = makeStorage(new Map([['cloudBrowserMachineId', 'unknown@unknown']]));
  const ctx = await openContext({ storage: corrupt });
  const id = await ctx.mod.getMachineId();
  check('browser: a corrupt stored id is replaced', ID_RE.test(id) && id !== 'unknown@unknown', id);
}
{
  const ctx1 = await openContext({ throwingStorage: true });
  const ctx2 = await openContext({ throwingStorage: true });
  const id1 = await ctx1.mod.getMachineId();
  const id2 = await ctx2.mod.getMachineId();
  check('browser: with localStorage throwing, the id is still well-formed and unique', ID_RE.test(id1) && ID_RE.test(id2) && id1 !== id2, `${id1} vs ${id2}`);
  check('browser: ...and stable for the page load', (await ctx1.mod.getMachineId()) === id1);
}
{
  const ctx = await openContext({ locationHostname: '' });
  check('browser: no host at all -> "browser"', (await ctx.mod.getMachineId()).endsWith('@browser'));
}
check('host label: backend hostname wins over the address bar', a.mod.browserHostLabel('jacarium', 'console.example.test') === 'jacarium');
check('host label: a bare container id (12 hex) is skipped', a.mod.browserHostLabel('a1b2c3d4e5f6', 'console.example.test') === 'console.example.test');
check('host label: sanitised to [a-z0-9.-]', a.mod.browserHostLabel(' My Host_Name! ', '') === 'my-host-name');
check('host label: IPv6 brackets dropped', a.mod.browserHostLabel(undefined, '[::1]') === '1' || a.mod.browserHostLabel(undefined, '[::1]') === 'browser');

// The module reads the GLOBAL localStorage, so a context's globals must be
// active while its module runs (openContext() leaves the last one active).
const useContext = (ctx) => { globalThis.localStorage = ctx.storage.api; globalThis.window = { electronAPI: undefined, localStorage: ctx.storage.api }; };

// ---------- display name (browser) ----------
console.log('--- display name');
useContext(a);
const nameA = idA.split('@')[0];
check('display name: default is the generated name part', (await a.mod.getDisplayName()) === nameA, await a.mod.getDisplayName());
check('display name: set and read back', a.mod.setDisplayName('  Robin   C. ') === 'Robin C.' && (await a.mod.getDisplayName()) === 'Robin C.');
check('display name: stored in localStorage', a.storage.store.get('cloudDisplayName') === 'Robin C.');
check('display name: machine id unchanged by renaming', (await a.mod.getMachineId()) === idA);
check('display name: survives a reload', (await (await openContext({ storage: a.storage })).mod.getDisplayName()) === 'Robin C.');
useContext(a);
for (const [bad, why] of [['robin@host', '@'], ['a\u0000b', 'control char'], ['x'.repeat(33), 'too long'], ['<script>', 'markup chars']]) {
  const v = a.mod.validateDisplayName(bad);
  check(`display name: "${why}" refused`, v.ok === false && typeof v.error === 'string');
  let threw = false;
  try { a.mod.setDisplayName(bad); } catch { threw = true; }
  check(`display name: setDisplayName("${why}") throws`, threw);
}
check('display name: still the previous valid name after refusals', (await a.mod.getDisplayName()) === 'Robin C.');
check('display name: unicode letters allowed', a.mod.validateDisplayName('Zoë Müller').ok === true);
// the name shown for OTHER users: the server's names map, else the id's user part
check('displayNameFor: the server-reported name wins', a.mod.displayNameFor('browser-11112222@host', { 'browser-11112222@host': 'Sam' }) === 'Sam');
check('displayNameFor: without one, the user part of the id', a.mod.displayNameFor('alice@laptop', {}) === 'alice' && a.mod.displayNameFor('alice@laptop') === 'alice');
check('displayNameFor: an empty reported name falls back', a.mod.displayNameFor('alice@laptop', { 'alice@laptop': '' }) === 'alice');
check('displayNameFor: tolerates a non-object names map and an odd id', a.mod.displayNameFor('plain', null) === 'plain' && a.mod.displayNameFor(undefined, 'x') === '');
// renaming notifies the page (useDisplayName re-reads on this event)
{
  const fired = [];
  globalThis.window.addEventListener = (type) => fired.push(`add:${type}`);
  globalThis.window.dispatchEvent = (ev) => { fired.push(`event:${ev.type}`); return true; };
  a.mod.setDisplayName('Robin C.');
  check('display name: setDisplayName dispatches the change event on window', fired.includes(`event:${a.mod.DISPLAY_NAME_EVENT}`), fired.join(','));
  delete globalThis.window.dispatchEvent;
  delete globalThis.window.addEventListener;
}
check('display name: empty clears it (back to the default)', a.mod.setDisplayName('') === '' && (await a.mod.getDisplayName()) === nameA && !a.storage.store.has('cloudDisplayName'));

// ---------- without an account there is no central server ----------
// (sharing needs the account identity: the home server vouches for it with a
// ticket; a generated browser identity pairs nowhere - see
// tests/account-central-identity.test.mjs for the signed-in path)
console.log('--- no account: no central server');
{
  useContext(a);
  check('no account: getCentralServerUrl() is empty', a.mod.getCentralServerUrl() === '');
  let thrown = null;
  try { await a.mod.getCentralAuthHeaders('https://sync.example.test'); } catch (e) { thrown = e; }
  check('no account: the auth headers throw NO_CENTRAL_SERVER (nothing pairs, nothing registers)', thrown?.code === 'NO_CENTRAL_SERVER', thrown?.message);
  check('no account: the module has no pairing API any more', typeof a.mod.ensureRegisteredWithCentral !== 'function' && typeof a.mod.setCentralServerUrl !== 'function');
}
fs.rmSync(workdir, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

process.exit(failed.length ? 1 : 0);
