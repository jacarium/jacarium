#!/usr/bin/env node
// The spell-checking dictionaries the desktop app ships on Windows and Linux (electron/spellcheck.cjs), fetched
// from the Electron release the app is built on and verified before anything packages them. Electron would
// otherwise download them from Google's CDN on the user's machine; Jacarium ships them instead, pinned by sha256
// in electron/spellcheck-dictionaries.json the way .github/tools.env pins the workflow tools.
//
//   node scripts/fetch-spellcheck-dictionaries.mjs            put the pinned files into build/dictionaries (the
//                                                             zip is downloaded only when a file is missing or
//                                                             wrong; nothing is fetched when they all verify)
//   node scripts/fetch-spellcheck-dictionaries.mjs --check    verify build/dictionaries against the manifest, no
//                                                             network (exit 1 on a missing or changed file)
//   node scripts/fetch-spellcheck-dictionaries.mjs --repin    re-pin the manifest to the Electron release that
//                                                             is installed (package-lock.json): its age against
//                                                             the 7-day rule, the asset's digest as GitHub
//                                                             reports it, then every file's sha256 and size
//
// Options:
//   --dir DIR             the output directory (default build/dictionaries, git-ignored; electron-builder packages
//                         it as resources/dictionaries for the Linux and Windows targets - package.json build)
//   --min-age-days N      --repin: the release must be at least this old (default 7, the dependency policy)
//   --force               --repin: re-pin a younger release all the same (the maintainer's explicit decision)
//   --now ISO-8601        the clock (for the test)
//
// What is checked, and flagged in red (exit 1):
//   - the manifest pins the Electron version that is installed (a bump of electron in package-lock.json without
//     --repin would ship another release's files under the old hashes - refused);
//   - the downloaded zip's sha256 against the manifest (and, with --repin, against the digest GitHub reports
//     for the asset); it is fetched over https from github.com only;
//   - every dictionary and licence file taken out of the zip: its sha256 and size against the manifest, before
//     it is written; what is already in --dir is verified the same way, and a file that fails is replaced;
//   - with --repin, the release's age.
// Exit 0 with "no red flag", 1 when there is one (each printed as RED FLAG: ...), 2 on a usage or network error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const MANIFEST = path.join(REPO, 'electron', 'spellcheck-dictionaries.json');
const NOTICE = path.join(REPO, 'electron', 'spellcheck-dictionaries-NOTICE.txt');
const NOTICE_NAME = 'NOTICE.txt';
const RELEASES = 'https://github.com/electron/electron/releases';
const API = 'https://api.github.com/repos/electron/electron/releases/tags';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = { dir: path.join(REPO, 'build', 'dictionaries'), check: false, repin: false, minAgeDays: 7, force: false, now: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => { if (i + 1 >= args.length) { console.error(`error: ${a} needs a value`); process.exit(2); } return args[++i]; };
  if (a === '--check') opt.check = true;
  else if (a === '--repin') opt.repin = true;
  else if (a === '--force') opt.force = true;
  else if (a === '--dir') opt.dir = path.resolve(value());
  else if (a === '--min-age-days') opt.minAgeDays = Number(value());
  else if (a === '--now') opt.now = new Date(value());
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  else { console.error(`error: unknown option ${a} (see --help)`); process.exit(2); }
}
if (opt.check && opt.repin) { console.error('error: --check and --repin exclude each other'); process.exit(2); }

const flags = [];
const flag = (text) => flags.push(text);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));

function installedElectronVersion() {
  try { return require(path.join(REPO, 'node_modules', 'electron', 'package.json')).version; } catch { /* not installed */ }
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages['node_modules/electron'].version; } catch { return null; }
}

/** Every file the manifest lists (dictionaries, licences, the notice) with what it must be. */
function expectedFiles(manifest) {
  const files = [...manifest.dictionaries, ...manifest.licences].map((e) => ({ file: e.file, sha256: e.sha256, size: e.size, fromZip: true }));
  const notice = fs.readFileSync(NOTICE);
  files.push({ file: NOTICE_NAME, sha256: sha256(notice), size: notice.length, fromZip: false, content: notice });
  return files;
}

/** { ok: [names], bad: [{ file, reason }] } of dir against the manifest */
function verifyDir(dir, files) {
  const ok = []; const bad = [];
  for (const entry of files) {
    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) { bad.push({ file: entry.file, reason: 'missing' }); continue; }
    const size = fs.statSync(file).size;
    if (size !== entry.size) { bad.push({ file: entry.file, reason: `${size} bytes, expected ${entry.size}` }); continue; }
    const got = sha256File(file);
    if (got !== entry.sha256) { bad.push({ file: entry.file, reason: `sha256 ${got}, expected ${entry.sha256}` }); continue; }
    ok.push(entry.file);
  }
  return { ok, bad };
}

function writeAtomic(dir, name, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const partial = path.join(dir, `.${name}.${process.pid}.partial`);
  fs.writeFileSync(partial, buffer);
  fs.renameSync(partial, path.join(dir, name));
}

async function download(url, what) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error(`${what}: ${url} is not an https://github.com/ URL`);
  let response;
  try { response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'jacarium-fetch-spellcheck-dictionaries' } }); } catch (error) { throw new Error(`${what}: download failed (${error.message})`); }
  if (!response.ok) throw new Error(`${what}: download failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function openZip(buffer) {
  const JSZip = require('jszip');
  return JSZip.loadAsync(buffer);
}

function report(dir, files) {
  const { ok, bad } = verifyDir(dir, files);
  for (const name of ok) console.log(`   ${name}: sha256 ok`);
  return { ok, bad };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const installed = installedElectronVersion();
  console.log(`== electron ${manifest.electron} pinned, ${installed || 'none'} installed`);

  if (opt.repin) return repin(manifest, installed);

  if (installed && installed !== manifest.electron) {
    flag(`the manifest pins Electron ${manifest.electron} but ${installed} is installed: node scripts/fetch-spellcheck-dictionaries.mjs --repin re-pins it`);
    return finish();
  }
  const files = expectedFiles(manifest);
  console.log(`== ${path.relative(REPO, opt.dir) || opt.dir}: ${files.length} files to verify`);
  const first = report(opt.dir, files);
  if (!first.bad.length) { console.log('   every file verifies; nothing to fetch'); return finish(); }
  for (const { file, reason } of first.bad) console.log(`   ${file}: ${reason}`);
  if (opt.check) {
    flag(`${first.bad.length} file(s) missing or changed in ${opt.dir} (node scripts/fetch-spellcheck-dictionaries.mjs fetches them)`);
    return finish();
  }

  console.log(`== fetching ${manifest.asset.url}`);
  let zipBuffer;
  try { zipBuffer = await download(manifest.asset.url, manifest.asset.name); } catch (error) { console.error(`error: ${error.message}`); process.exit(2); }
  const zipHash = sha256(zipBuffer);
  if (zipHash !== manifest.asset.sha256) {
    flag(`${manifest.asset.name}: sha256 ${zipHash}, expected ${manifest.asset.sha256} - nothing written`);
    return finish();
  }
  console.log(`   ${manifest.asset.name}: ${zipBuffer.length} bytes, sha256 ok`);
  const zip = await openZip(zipBuffer);
  for (const entry of files) {
    if (first.ok.includes(entry.file)) continue;
    let content = entry.content;
    if (entry.fromZip) {
      const zipped = zip.file(entry.file);
      if (!zipped) { flag(`${entry.file} is not in ${manifest.asset.name}`); continue; }
      content = await zipped.async('nodebuffer');
      const got = sha256(content);
      if (got !== entry.sha256 || content.length !== entry.size) { flag(`${entry.file}: sha256 ${got} (${content.length} bytes) in the zip, expected ${entry.sha256} (${entry.size} bytes) - not written`); continue; }
    }
    writeAtomic(opt.dir, entry.file, content);
    console.log(`   ${entry.file}: written, sha256 ok`);
  }
  // a dictionary left from an earlier pin (a re-pin moved en-US-10-1 to 10-2) is not in the manifest and
  // must not ship: the directory is packaged whole (extraResources), so it holds the manifest's files alone
  const wanted = new Set(files.map((e) => e.file));
  for (const name of fs.readdirSync(opt.dir)) {
    if (/\.bdic$/.test(name) && !wanted.has(name)) { fs.rmSync(path.join(opt.dir, name)); console.log(`   ${name}: removed (not in the manifest)`); }
  }
  const again = verifyDir(opt.dir, files);
  if (again.bad.length) flag(`after fetching, ${again.bad.map((b) => `${b.file} (${b.reason})`).join(', ')} still do not verify`);
  return finish();
}

/** --repin: the manifest for the installed Electron release, after the age and digest checks. */
async function repin(manifest, installed) {
  if (!installed) { console.error('error: electron is not installed (npm ci) and package-lock.json names no version'); process.exit(2); }
  const now = opt.now || new Date();
  let release;
  try {
    const response = await fetch(`${API}/v${installed}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'jacarium-fetch-spellcheck-dictionaries' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    release = await response.json();
  } catch (error) { console.error(`error: could not read the release v${installed} from api.github.com (${error.message})`); process.exit(2); }
  const asset = (release.assets || []).find((a) => a.name === manifest.asset.name);
  if (!asset) { console.error(`error: release v${installed} has no ${manifest.asset.name}`); process.exit(2); }
  const created = new Date(asset.created_at);
  const ageDays = Math.round(((now - created) / 86400000) * 10) / 10;
  console.log(`== ${release.html_url}: ${asset.name} uploaded ${asset.created_at}, ${ageDays} days old, ${asset.size} bytes`);
  if (!(ageDays >= opt.minAgeDays)) {
    if (opt.force) console.log(`   younger than ${opt.minAgeDays} days - re-pinned on --force (say so in docs/security/spellcheck-dictionaries.md)`);
    else flag(`the release is ${ageDays} days old, younger than the ${opt.minAgeDays} days of the dependency policy (--force on the maintainer's explicit decision)`);
  }
  if (flags.length) return finish();
  const reported = String(asset.digest || '').replace(/^sha256:/, '');
  let zipBuffer;
  try { zipBuffer = await download(asset.browser_download_url, asset.name); } catch (error) { console.error(`error: ${error.message}`); process.exit(2); }
  const zipHash = sha256(zipBuffer);
  if (zipBuffer.length !== asset.size) flag(`${asset.name}: ${zipBuffer.length} bytes downloaded, GitHub reports ${asset.size}`);
  if (!reported) flag(`${asset.name}: GitHub reports no digest for the asset - its sha256 ${zipHash} rests on this download alone`);
  else if (reported !== zipHash) flag(`${asset.name}: sha256 ${zipHash} downloaded, GitHub reports ${reported}`);
  else console.log(`   ${asset.name}: sha256 ${zipHash} (as GitHub reports it)`);
  const zip = await openZip(zipBuffer);
  const next = { ...manifest, electron: installed, asset: { ...manifest.asset, url: asset.browser_download_url, release: release.html_url, sha256: zipHash, size: zipBuffer.length, createdAt: asset.created_at }, dictionaries: [], licences: [] };
  for (const entry of manifest.dictionaries) {
    const pattern = new RegExp(`^${entry.language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+-\\d+\\.bdic$`);
    const names = Object.keys(zip.files).filter((n) => pattern.test(n)).sort();
    if (!names.length) { flag(`${entry.language}: no dictionary in ${asset.name}`); continue; }
    const file = names[names.length - 1];
    const content = await zip.file(file).async('nodebuffer');
    next.dictionaries.push({ ...entry, file, sha256: sha256(content), size: content.length });
    console.log(`   ${file}: ${content.length} bytes, sha256 ${sha256(content)}${file !== entry.file ? ` (was ${entry.file})` : ''}`);
  }
  for (const entry of manifest.licences) {
    const zipped = zip.file(entry.file);
    if (!zipped) { flag(`${entry.file}: not in ${asset.name}`); continue; }
    const content = await zipped.async('nodebuffer');
    next.licences.push({ file: entry.file, sha256: sha256(content), size: content.length });
  }
  if (flags.length) return finish();
  fs.writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2).replace(/\{\n\s+"file": ("[^"]+"),\n\s+"sha256": ("[^"]+"),\n\s+"size": (\d+)\n\s+\}/g, '{ "file": $1, "sha256": $2, "size": $3 }')}\n`);
  console.log(`   ${path.relative(REPO, MANIFEST)} re-pinned to Electron ${installed}; run the script again to fetch the files, and record it in docs/security/spellcheck-dictionaries.md`);
  return finish();
}

function finish() {
  console.log('');
  if (flags.length) {
    for (const f of flags) console.log(`RED FLAG: ${f}`);
    console.log(`${flags.length} red flag(s)`);
    process.exit(1);
  }
  console.log('no red flag');
  process.exit(0);
}

main().catch((error) => { console.error(`error: ${error.message}`); process.exit(2); });
