/**
 * Settings > About's Version section, Copy version info, the security &
 * verification links and "Show data folder" (AboutSettings.jsx,
 * src/utils/aboutInfo.js, electron/preload.cjs, electron/main.cjs,
 * electron/home-server.cjs, backend/version_info.py):
 *
 *   static: the preload's runtimeVersions is a frozen object of exactly the
 *     three strings from process.versions and nothing else of the process;
 *     openDataFolder sends nothing; the main process handler takes no
 *     argument, opens app.getPath('userData') with shell.openPath and answers
 *     only ok; the home-server relay copies runtimes as checked version
 *     strings; the Containerfile records `node --version` for the backend;
 *   the backend: version_info() answers runtimes.python = the running
 *     Python, node only from a build-time file, and no other new key; the
 *     /api/version route adds authMode and capabilities and nothing else;
 *   unit: serverRuntimes / desktopRuntimes refuse what is not a version
 *     string; versionInfoText has the app, the protocol, the runtimes, the
 *     platform and the server's version - and no URL, hostname, username or
 *     path; the links are the expected URLs from brand.js's repository;
 *   jsdom, the REAL About: on the desktop (a fake bridge) the "Desktop
 *     runtime" row shows Electron · Chromium · Node and the linked server's
 *     row its Python and Node, Copy writes the text and says "Copied", Show
 *     data folder calls the bridge; in a browser no desktop row, the
 *     server's runtimes from /api/version, no data-folder button; an old
 *     server without the fields shows its version alone.
 *
 * Run: node tests/about-runtimes.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------
const preload = read('electron/preload.cjs');
const runtimeLine = (/runtimeVersions: (Object\.freeze\(\{[^\n]*\}\)),/.exec(preload) || [])[1] || '';
check('preload: runtimeVersions is Object.freeze of exactly electron, chrome and node as strings from process.versions', /^Object\.freeze\(\{ electron: String\(process\.versions\.electron \|\| ''\), chrome: String\(process\.versions\.chrome \|\| ''\), node: String\(process\.versions\.node \|\| ''\) \}\)$/.test(runtimeLine), runtimeLine);
const preloadCode = preload.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('preload: nothing else of process reaches the renderer (platform and the three versions only)', (preloadCode.match(/process\.[a-zA-Z.]+/g) || []).every((m) => ['process.platform', 'process.versions.electron', 'process.versions.chrome', 'process.versions.node'].includes(m)), (preloadCode.match(/process\.[a-zA-Z.]+/g) || []).join(', '));
check('preload: openDataFolder invokes app:open-data-folder with no argument', /openDataFolder: \(\) => ipcRenderer\.invoke\('app:open-data-folder'\),/.test(preload));
const main = read('electron/main.cjs');
check("main: the handler takes no argument, opens app.getPath('userData') with shell.openPath and answers { ok } only", /ipcMain\.handle\('app:open-data-folder', async \(\) => \{\s*const error = await shell\.openPath\(app\.getPath\('userData'\)\);\s*return \{ ok: !error \};\s*\}\);/.test(main));
check('home-server.cjs relays runtimes as checked version strings only (python, node)', /for \(const key of \['python', 'node'\]\) \{\s*const value = body\.runtimes && body\.runtimes\[key\];\s*if \(typeof value === 'string' && \/\^\\d\+\\\.\\d\+/.test(read('electron/home-server.cjs')) && /runtimes \};/.test(read('electron/home-server.cjs')));
check("the Containerfile records the central server's Node for the backend (node --version > /app/node-version) right after the binary is copied", /COPY --from=ui \/usr\/local\/bin\/node \/usr\/local\/bin\/node\n(?:#[^\n]*\n)*RUN mkdir -p \/app && \/usr\/local\/bin\/node --version > \/app\/node-version/.test(read('deploy/Containerfile')));
const about = read('src/components/common/modals/settings/AboutSettings.jsx');
check('About: the desktop runtime row, the home-server row with runtimes, Copy version info with "Copied", the four security rows, Show data folder desktop-only', /testId="about-desktop-runtime"/.test(about) && /serverRuntimeLine/.test(about) && /\{copied \? 'Copied' : 'Copy version info'\}/.test(about) && ['about-security-policy', 'about-security-report', 'about-security-bestpractices', 'about-security-verify'].every((t) => about.includes(`testId="${t}"`)) && /isDesktopApp\(\) && typeof window !== 'undefined' && typeof window\.electronAPI\?\.openDataFolder === 'function' && \(/.test(about) && !/userData|getPath/.test(about));

// ---------------------------------------------------------------------------
// the backend
// ---------------------------------------------------------------------------
const PY = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PY)) console.log('SKIP (backend): backend/venv missing');
else {
  const script = `
import json, platform, sys, os, tempfile
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'backend'))})
import version_info
v = version_info.version_info()
out = {'keys': sorted(v.keys()), 'runtimes': v['runtimes'], 'python': platform.python_version()}
# the node file: a build-time record, read from next to the backend's parent; a bad value is left out
d = tempfile.mkdtemp()
open(os.path.join(d, 'node-version'), 'w').write('v26.13.0\\n')
version_info._HERE = os.path.join(d, 'backend'); version_info._cache = None
out['withNode'] = version_info.version_info()['runtimes']
open(os.path.join(d, 'node-version'), 'w').write('not a version; rm -rf /\\n')
version_info._cache = None
out['badNode'] = version_info.version_info()['runtimes']
print(json.dumps(out))
`;
  const r = spawnSync(PY, ['-c', script], { encoding: 'utf8' });
  let v = null;
  try { v = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { v = null; }
  check('version_info(): the keys are app, protocol, name, tagline, homepage and runtimes - nothing else new', !!v && v.keys.join() === 'app,homepage,name,protocol,runtimes,tagline', r.stderr.slice(-200) || JSON.stringify(v && v.keys));
  check('...runtimes.python is the running Python, and node is absent outside the container', !!v && v.runtimes.python === v.python && !('node' in v.runtimes), JSON.stringify(v && v.runtimes));
  check('...node comes from the build-time node-version file (without the v), and a value that is not a version string is left out', !!v && v.withNode.node === '26.13.0' && !('node' in v.badNode), JSON.stringify(v && [v.withNode, v.badNode]));
  const route = read('backend/downloads.py');
  check('/api/version adds authMode and capabilities to version_info() and nothing else; it stays sign-in-free', /return jsonify\(\{\*\*version_info\(\), 'authMode': AUTH_MODE, 'capabilities': \{/.test(route) && /_AUTH_EXEMPT_PATHS = \{"\/health", "\/api\/version"/.test(read('backend/extensions.py')));
}

// ---------------------------------------------------------------------------
// unit: aboutInfo.js (bundled: it imports brand.js)
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'about-runtimes-'));
const { build } = await import(req.resolve('esbuild'));
const UNIT = path.join(WORK, 'unit.cjs');
await build({ entryPoints: [path.join(REPO, 'src/utils/aboutInfo.js')], bundle: true, outfile: UNIT, format: 'cjs', platform: 'node', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')], loader: { '.js': 'jsx' } });
const info = req(UNIT);
const pkg = JSON.parse(read('package.json'));
const repo = String(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '').replace(/^git\+/, '').replace(/\.git$/, '');
check('the security links come from brand.js\'s repository: SECURITY.md, the private advisory form, Best Practices 15975, the README\'s Security & supply chain section', info.SECURITY_LINKS.policy === `${repo}/blob/main/SECURITY.md` && info.SECURITY_LINKS.report === `${repo}/security/advisories/new` && info.SECURITY_LINKS.bestPractices === 'https://www.bestpractices.dev/projects/15975' && info.SECURITY_LINKS.verify === `${repo}#security--supply-chain` && /^https:\/\/github\.com\//.test(repo) && Object.isFrozen(info.SECURITY_LINKS), JSON.stringify(info.SECURITY_LINKS));
check('serverRuntimes / desktopRuntimes keep version strings only', JSON.stringify(info.serverRuntimes({ python: '3.14.7', node: '26.13.0', extra: 'x' })) === '{"python":"3.14.7","node":"26.13.0"}' && JSON.stringify(info.serverRuntimes({ python: 'rm -rf /', node: 42 })) === '{}' && info.desktopRuntimes({ runtimeVersions: { electron: '42.11.17', chrome: '148.0.7700.1', node: '22.21.1' } }).node === '22.21.1' && info.desktopRuntimes({ runtimeVersions: { electron: '<img>', chrome: '', node: '' } }) === null && info.desktopRuntimes({}) === null);
const copyText = info.versionInfoText({ app: '3.8.0', protocol: 2, desktop: { electron: '42.11.17', chrome: '148.0.7700.1', node: '22.21.1' }, server: { app: '3.8.0', protocol: 2, url: 'https://pi.example.test:8443', runtimes: { python: '3.14.7', node: '26.13.0' } }, platform: 'macOS' });
check('versionInfoText: the app, the protocol, the desktop runtimes, the platform, the home server\'s version and runtimes', copyText === 'Jacarium 3.8.0\nSync protocol 2\nDesktop runtime: Electron 42.11.17 · Chromium 148.0.7700.1 · Node 22.21.1\nPlatform: macOS\nHome server: Jacarium 3.8.0 (protocol 2) · Python 3.14.7 · Node 26.13.0', copyText);
check('...and no URL, hostname, address, username or path in it', !/https?:|pi\.example|\d+\.\d+\.\d+\.\d+:|\/Users\/|\/home\/|@/.test(copyText));
check('versionInfoText in a browser with an old server: "Runs in a browser", the server\'s version alone', info.versionInfoText({ app: '3.8.0', protocol: 2, desktop: null, server: { app: '3.7.0', protocol: 2, runtimes: {} }, platform: 'Linux' }) === 'Jacarium 3.8.0\nSync protocol 2\nRuns in a browser\nPlatform: Linux\nHome server: Jacarium 3.7.0 (protocol 2)');
check('platformLabel: the preload\'s platform as an OS name, else navigator.userAgentData.platform, else navigator.platform', info.platformLabel({ platform: 'darwin' }, null) === 'macOS' && info.platformLabel(null, { userAgentData: { platform: 'Windows' } }) === 'Windows' && info.platformLabel(null, { platform: 'Linux x86_64' }) === 'Linux x86_64');

// ---------------------------------------------------------------------------
// jsdom: the real About
// ---------------------------------------------------------------------------
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export { default as AboutSettings } from '@worktree/src/components/common/modals/settings/AboutSettings.jsx';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
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
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let serverBody = { app: '3.8.0', protocol: 2, runtimes: { python: '3.14.7', node: '26.13.0' } };
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url) => { const u = String(url); if (/\/api\/version/.test(u)) return json(serverBody); return json({ error: 'not mocked' }, 404); };
Object.defineProperty(globalThis, 'fetch', { value: stubFetch, configurable: true, writable: true }); dom.window.fetch = stubFetch;
const copies = [];
Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t) => { copies.push(t); } }, configurable: true });
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|not mocked/.test(String(a[0] ?? ''))) return; origErr(...a); };
const { AboutSettings, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = dom.window;
const $ = (s) => document.querySelector(s);
const root = createRoot(document.getElementById('root'));
const render = async () => { await act(async () => { root.render(React.createElement(AboutSettings, {})); }); await act(async () => { await sleep(60); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(40); }); };
const text = (s) => $(s)?.textContent || '';

// desktop, linked to a server that reports its runtimes
const opened = [];
dom.window.electronAPI = {
  isElectron: true, platform: 'darwin', runtimeVersions: Object.freeze({ electron: '42.11.17', chrome: '148.0.7700.1', node: '22.21.1' }),
  openDataFolder: async () => { opened.push(1); return { ok: true }; }, openExternal: async () => {},
  homeServerStatus: async () => ({ linked: true, url: 'https://pi.example.test:8443' }),
  homeServerVersion: async () => ({ desktop: { app: '3.8.0', protocol: 2 }, server: { reachable: true, linked: true, url: 'https://pi.example.test:8443', app: '3.8.0', protocol: 2, legacy: false, error: null, runtimes: { python: '3.14.7', node: '26.13.0' } } }),
};
await render();
check('desktop: "Desktop runtime: Electron 42.11.17 · Chromium 148.0.7700.1 · Node 22.21.1"', text('[data-testid="about-desktop-runtime"]') === 'Desktop runtimeElectron 42.11.17 · Chromium 148.0.7700.1 · Node 22.21.1', text('[data-testid="about-desktop-runtime"]'));
check('desktop: the linked server\'s row shows its version, protocol and runtimes', /Jacarium 3\.8\.0 \(protocol 2\) · Python 3\.14\.7 · Node 26\.13\.0/.test(text('[data-testid="about-home-server"]')), text('[data-testid="about-home-server"]'));
await click($('[data-testid="about-copy-version"]'));
check('desktop: Copy version info writes the text (no URL in it) and says "Copied"', copies.length === 1 && /Desktop runtime: Electron 42\.11\.17/.test(copies[0]) && /Home server: Jacarium 3\.8\.0 \(protocol 2\) · Python 3\.14\.7 · Node 26\.13\.0/.test(copies[0]) && !/pi\.example|https?:/.test(copies[0]) && /Platform: macOS/.test(copies[0]) && text('[data-testid="about-copy-version"]') === 'Copied', copies[0]);
check('desktop: the four security links point where they should', ['about-security-policy', 'about-security-report', 'about-security-bestpractices', 'about-security-verify'].every((t) => $(`[data-testid="${t}"] button`)));
await click($('[data-testid="about-open-data-folder"]'));
check('desktop: Show data folder is offered and calls the bridge (no argument, no path shown)', opened.length === 1 && !/\/Users\/|\/home\//.test(text('[data-testid="about-security"]')));
await act(async () => { root.render(null); });

// a browser, against a server that reports runtimes
dom.window.electronAPI = undefined;
await render();
check('browser: no desktop row, the server\'s runtimes from /api/version, no data-folder button', !$('[data-testid="about-desktop-runtime"]') && /Jacarium 3\.8\.0 \(protocol 2\) · Python 3\.14\.7 · Node 26\.13\.0/.test(text('[data-testid="about-home-server"]')) && !$('[data-testid="about-open-data-folder"]'), text('[data-testid="about-home-server"]'));
await click($('[data-testid="about-copy-version"]'));
check('browser: the copied text says "Runs in a browser"', copies.length === 2 && /Runs in a browser/.test(copies[1]) && !/Desktop runtime/.test(copies[1]), copies[1]);
await act(async () => { root.render(null); });

// an old server without the fields
serverBody = { app: '3.7.0', protocol: 2 };
await render();
check('an old server without the fields: its version and protocol alone, nothing broken', text('[data-testid="about-home-server"]') === 'Home serverJacarium 3.7.0 (protocol 2)', text('[data-testid="about-home-server"]'));
await act(async () => { root.render(null); });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
