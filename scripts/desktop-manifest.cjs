#!/usr/bin/env node
/**
 * The downloads manifest for a directory of desktop installers
 * (deploy/deploy-to-host.sh publish-desktop; served by backend/downloads.py):
 *
 *   node scripts/desktop-manifest.cjs <dir> [--version X.Y.Z] [--note "text"]
 *
 * Prints JSON {version, generatedAt, files: [{name, size, sha256, platform,
 * arch, kind, version}]} for every installer in <dir> (.dmg, mac .zip,
 * .AppImage, .deb, .exe - never the .blockmap side files) and the source
 * archive (<name>-<version>-src.tar.gz, kind "source"), platform and arch
 * read from electron-builder's file names.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || !fs.existsSync(dir)) { console.error('usage: desktop-manifest.cjs <dir> [--version X.Y.Z] [--note text]'); process.exit(2); }
let version = null; let note = '';
for (let i = 1; i < args.length; i++) { if (args[i] === '--version') version = args[++i]; else if (args[i] === '--note') note = args[++i]; }

const KINDS = { '.dmg': ['macOS', 'dmg'], '.zip': ['macOS', 'zip'], '.AppImage': ['Linux', 'AppImage'], '.deb': ['Linux', 'deb'], '.exe': ['Windows', 'exe'] };
const files = [];
for (const name of fs.readdirSync(dir).sort()) {
  const source = /-src\.tar\.gz$/.test(name);   // the source archive (git archive of the release tag)
  const ext = path.extname(name);
  if (!source && (!KINDS[ext] || name.endsWith('.blockmap'))) continue;
  const full = path.join(dir, name);
  if (!fs.statSync(full).isFile()) continue;
  const [platform, kind] = source ? ['Source', 'source'] : KINDS[ext];
  const arch = /arm64|aarch64/i.test(name) ? 'arm64' : /x64|amd64|x86_64/i.test(name) ? 'x64' : /universal/i.test(name) ? 'universal' : '';
  const m = name.match(/(\d+\.\d+\.\d+)/);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  files.push({ name, size: fs.statSync(full).size, sha256, platform, arch, kind, version: version || (m ? m[1] : ''), ...(note && platform === 'Linux' ? { note } : {}) });
}
process.stdout.write(JSON.stringify({ version: version || (files[0] && files[0].version) || '', generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
