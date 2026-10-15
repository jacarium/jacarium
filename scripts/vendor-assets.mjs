#!/usr/bin/env node
// Copy the third-party browser assets the Flask backend's own pages need from
// node_modules into backend/static/vendor/, so nothing is loaded from a CDN.
//
// Why: the app must work without internet access. Everything the Vite
// renderer needs is
// bundled by Vite (the Sora and Red Hat fonts via @fontsource in src/main.jsx, Chart.js
// inlined into the diagnostics frames by src/components/DiagnosticsPage.jsx).
// The pages Vite does not build - the legacy standalone dashboard templates
// in backend/templates (layout.html / index.html, served by log_viewer.py) -
// reference /static/vendor/... instead, and this script provides those files.
//
// Reproducible: the sources come from the npm packages pinned in
// package-lock.json (devDependencies), so no network is needed at build time
// (Flatpak builds run `npm ci --offline`). backend/static/vendor/ is
// git-ignored; this script is idempotent and runs from npm's postinstall
// hook, from the Vite build scripts and from backend/build_backend.sh, so a
// checkout that ran `npm install` (dev) or any build always has the files.
// PyInstaller packages the whole backend/static directory
// (flask-backend.spec datas), which carries them into the packaged app.
//
// Tailwind: the legacy pages were written against the Tailwind v3 Play CDN.
// The stylesheet is compiled here from scripts/tailwind.legacy.css with the
// repo's Tailwind v4 devDependencies - a static CSS file, no runtime
// compiler. That entry scans only backend/templates and restores the v3
// defaults (border colour, placeholder colour, button cursor, ring, hover)
// the templates rely on.
//
// Modes:
//   node scripts/vendor-assets.mjs            (postinstall) - if the source
//       packages are absent (e.g. `npm ci --omit=dev`), print a warning and
//       exit 0: a production-only install must not fail on build tooling.
//   node scripts/vendor-assets.mjs --strict   (build scripts) - a missing
//       source or a failed Tailwind compile is an error, so a build can never
//       silently ship a page that falls back to a CDN.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const VENDOR = path.join(REPO, 'backend', 'static', 'vendor');
const STRICT = process.argv.includes('--strict');
const require = createRequire(import.meta.url);

// [source under node_modules, destination under backend/static/vendor]
const FILES = [
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['chart.js/LICENSE.md', 'chart.umd.LICENSE.md'],
  ['tailwindcss/LICENSE', 'tailwind.LICENSE'],
  ['@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css'],
  ['@fortawesome/fontawesome-free/LICENSE.txt', 'fontawesome/LICENSE.txt'],
  // the wordmark on the downloads page (backend/downloads.py)
  ['@fontsource/sora/files/sora-latin-600-normal.woff2', 'sora/sora-latin-600-normal.woff2'],
  ['@fontsource/sora/LICENSE', 'sora/LICENSE']
];
// all.min.css references ../webfonts/<file> relative to css/, so the whole
// webfonts directory is copied next to it.
const DIRS = [
  ['@fortawesome/fontawesome-free/webfonts', 'fontawesome/webfonts']
];

function copyFile(from, to) {
  if (!fs.existsSync(from)) {
    throw new Error(`Missing ${path.relative(REPO, from)} - run "npm install" (devDependencies) first`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

// Compile scripts/tailwind.legacy.css with the Tailwind v4 engine through the
// same packages @tailwindcss/vite uses (@tailwindcss/node resolves the
// @import/@source directives, @tailwindcss/oxide scans the templates for class
// candidates). Not @tailwindcss/cli: that pulls in a file watcher with its own
// dependency chain (micromatch/braces) that npm audit flags, and we only ever
// need a one-shot build.
async function compileTailwind() {
  let compile, optimize, Scanner;
  try {
    ({ compile, optimize } = await import('@tailwindcss/node'));
    ({ Scanner } = await import('@tailwindcss/oxide'));
  } catch {
    throw new Error('Missing @tailwindcss/node / @tailwindcss/oxide - run "npm install" (devDependencies) first');
  }
  const entry = path.join(here, 'tailwind.legacy.css');
  const compiler = await compile(fs.readFileSync(entry, 'utf8'), { base: here, from: entry, onDependency: () => {} });
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  const css = optimize(compiler.build(candidates), { minify: true }).code;
  const out = path.join(VENDOR, 'tailwind.css');
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.writeFileSync(out, css);
  return fs.statSync(out).size;
}

async function run() {
  let count = 0;
  let bytes = 0;
  for (const [src, dest] of FILES) {
    bytes += copyFile(path.join(NODE_MODULES, src), path.join(VENDOR, dest));
    count += 1;
  }
  for (const [src, dest] of DIRS) {
    const fromDir = path.join(NODE_MODULES, src);
    if (!fs.existsSync(fromDir)) {
      throw new Error(`Missing ${path.relative(REPO, fromDir)} - run "npm install" (devDependencies) first`);
    }
    for (const name of fs.readdirSync(fromDir)) {
      const from = path.join(fromDir, name);
      if (!fs.statSync(from).isFile()) continue;
      bytes += copyFile(from, path.join(VENDOR, dest, name));
      count += 1;
    }
  }
  bytes += await compileTailwind();
  count += 1;
  console.log(`[vendor-assets] ${count} files (${Math.round(bytes / 1024)} KB) -> ${path.relative(REPO, VENDOR)}/`);
}

try {
  await run();
} catch (error) {
  if (STRICT) {
    console.error(`[vendor-assets] ERROR: ${error.message}`);
    process.exit(1);
  }
  console.warn(`[vendor-assets] WARNING: ${error.message}`);
  console.warn('[vendor-assets] Skipping (postinstall without devDependencies). Builds run this with --strict.');
  process.exit(0);
}
