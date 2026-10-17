/**
 * Guards what the packaged desktop app ships: every file the Electron main
 * process require()s by a relative path must be covered by package.json's
 * build.files (3.0.0 shipped without protocol.json and failed every
 * home-server version check with "Cannot find module '../protocol.json'").
 *
 *   - static: each require('./x') / require('../x') in electron/*.cjs
 *     resolves to a file in the repo AND matches a build.files pattern;
 *     protocol.json is listed explicitly;
 *   - the home-server IPC handlers in main.cjs exist;
 *   - when a packaged app of THIS platform and THIS version exists
 *     (dist-electron/mac-<arch>/Jacarium.app or a Linux unpacked dir),
 *     `asar list` must contain every one of those files; another
 *     platform's or an older build is reported and skipped (it says nothing
 *     about this tree).
 * Run: node tests/electron-package-files.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { testablePackagedApp } from './helpers/packaged-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const patterns = pkg.build?.files || [];
check('package.json build.files lists protocol.json', patterns.includes('protocol.json'), JSON.stringify(patterns));

// a build.files pattern -> does it cover this repo-relative path?
const covers = (pattern, file) => {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/\*/g, '.*').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  return re.test(file);
};

// every relative require() in electron/*.cjs
const required = new Set();
for (const name of fs.readdirSync(path.join(REPO, 'electron'))) {
  if (!name.endsWith('.cjs')) continue;
  const src = fs.readFileSync(path.join(REPO, 'electron', name), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) required.add(path.posix.normalize(path.posix.join('electron', m[1])));
  for (const m of src.matchAll(/require\(\s*path\.join\(__dirname,\s*((?:'[^']+'\s*,?\s*)+)\)\s*\)/g)) {
    const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    required.add(path.posix.normalize(path.posix.join('electron', ...parts)));
  }
}
const problems = [];
for (let file of required) {
  const candidates = [file, `${file}.cjs`, `${file}.js`, `${file}.json`, `${file}/index.js`];
  const existing = candidates.find((c) => fs.existsSync(path.join(REPO, c)) && fs.statSync(path.join(REPO, c)).isFile());
  if (!existing) { problems.push(`${file}: no such file in the repo`); continue; }
  if (!patterns.some((p) => covers(p, existing))) problems.push(`${existing}: not covered by build.files`);
}
check(`every relative require() of electron/*.cjs (${required.size}) exists and is packaged`, problems.length === 0, problems.join('; '));
check('protocol.json itself is among them', [...required].some((f) => /protocol\.json$/.test(f)), [...required].join(', '));

const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
// each handler: from its ipcMain.handle('home-server:...' up to the next ipcMain.handle / app.whenReady
const handlers = main.split(/(?=ipcMain\.handle\()/).filter((chunk) => /^ipcMain\.handle\('home-server:/.test(chunk)).map((chunk) => chunk.split(/\napp\.whenReady/)[0]);
check('the home-server IPC handlers (link/version/fetch/status) exist', handlers.length >= 4, String(handlers.length));

// a packaged app of this platform and this version, when one is here
const { app: packaged, skip } = testablePackagedApp();
if (skip) {
  console.log(`SKIP (packaged app): ${skip}`);
} else {
  const { listPackage } = createRequire(path.join(REPO, 'package.json'))('@electron/asar');
  for (const asar of [packaged.asar]) {
    let entries;
    try { entries = new Set(listPackage(asar).map((l) => String(l).trim().replace(/^\//, ''))); } catch (error) { check(`asar listing works for ${path.relative(REPO, asar)}`, false, error.message); continue; }
    const missing = [...required].map((f) => [f, `${f}.cjs`, `${f}.js`, `${f}.json`].find((c) => entries.has(c)) ? null : f).filter(Boolean);
    check(`${path.relative(REPO, asar)} contains every required file (incl. protocol.json)`, missing.length === 0 && entries.has('protocol.json'), missing.join(', ') || `${entries.size} entries`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
