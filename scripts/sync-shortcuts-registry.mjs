#!/usr/bin/env node
/**
 * electron/shortcuts-registry.cjs is src/shortcuts/registry.js (ESM, the
 * one definition of the keyboard shortcuts) rewritten as CommonJS for the
 * main process, which cannot import ESM from the packaged app. Run this
 * after editing the registry:
 *
 *   node scripts/sync-shortcuts-registry.mjs           rewrite the .cjs
 *   node scripts/sync-shortcuts-registry.mjs --check   exit 1 when it is stale
 *
 * tests/shortcuts-registry.test.mjs runs the check. The registry is written
 * so this transform is a plain text rewrite: no imports, top-level
 * `export const` / `export function` only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(REPO, 'src', 'shortcuts', 'registry.js');
export const TARGET = path.join(REPO, 'electron', 'shortcuts-registry.cjs');

export function generate(source = fs.readFileSync(SOURCE, 'utf8')) {
  if (/^import\s/m.test(source)) throw new Error('registry.js must not import anything (it is mirrored as CommonJS)');
  const names = [...source.matchAll(/^export (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const body = source.replace(/^export (const|function) /gm, '$1 ');
  return `// GENERATED from src/shortcuts/registry.js by scripts/sync-shortcuts-registry.mjs - do not edit.\n// The main process's copy of the keyboard shortcut registry (electron/shortcuts.cjs).\n${body}\nmodule.exports = { ${names.join(', ')} };\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = generate();
  const check = process.argv.includes('--check');
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (check) {
    if (current !== expected) { console.error('electron/shortcuts-registry.cjs is stale: run node scripts/sync-shortcuts-registry.mjs'); process.exit(1); }
    console.log('electron/shortcuts-registry.cjs is in sync');
  } else {
    fs.writeFileSync(TARGET, expected);
    console.log(`wrote ${path.relative(REPO, TARGET)}`);
  }
}
