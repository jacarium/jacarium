/**
 * Guards the ui-settings.json clobber bug (fixed in electron/ui-settings.cjs).
 *
 * BUG: the original persistZoomFactor() in electron/main.cjs wrote
 * `{ zoomFactor }` to ui-settings.json WHOLESALE. With only one setting in
 * the file that was harmless, but the moment a second setting lives there
 * (debugBarEnabled, added for the debug status bar), changing zoom would
 * silently delete it - the debug bar toggle would reset to off on the next
 * launch after any zoom change, with no error anywhere.
 *
 * FIX: all writes go through persistUiSettings() in electron/ui-settings.cjs,
 * which does read-merge-write: read the existing file (missing/corrupt ->
 * {}), merge in the new key(s), write the merged object. That module is
 * deliberately Electron-free (callers pass the path) so this test exercises
 * the REAL production code with plain Node.
 *
 * What this test proves:
 *   - reading a missing/corrupt/non-object file yields {} (never throws)
 *   - writing one key then another preserves BOTH (the clobber regression)
 *   - updating an existing key preserves unrelated keys
 *   - persisting over a corrupt file recovers instead of throwing
 *   - unknown keys written by other versions survive a settings write
 *
 * Run:  node tests/ui-settings-merge.test.mjs
 * Preconditions: none (plain Node, no npm packages).
 * Exit code 0 = all checks passed, 1 = failure.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { readUiSettings, persistUiSettings } = require(
  path.resolve(here, '..', 'electron', 'ui-settings.cjs')
);

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-settings-test-'));
const SETTINGS = path.join(WORKDIR, 'nested', 'ui-settings.json');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${pass || !detail ? '' : ` - ${detail}`}`);
}

function readRaw() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

let exitCode = 1;
try {
  // --- read of a missing file -----------------------------------------------
  const missing = readUiSettings(SETTINGS);
  check(
    'missing file reads as {}',
    typeof missing === 'object' && missing !== null && Object.keys(missing).length === 0
  );

  // --- first write creates the file (and parent dir) ------------------------
  persistUiSettings(SETTINGS, { zoomFactor: 0.9 });
  check('first write lands on disk', readRaw().zoomFactor === 0.9);

  // --- THE CLOBBER REGRESSION: second key must not erase the first ----------
  persistUiSettings(SETTINGS, { debugBarEnabled: true });
  let data = readRaw();
  check(
    'adding debugBarEnabled preserves zoomFactor (clobber regression)',
    data.zoomFactor === 0.9 && data.debugBarEnabled === true,
    JSON.stringify(data)
  );

  // --- ...and vice versa: a zoom change must not erase the debug toggle -----
  persistUiSettings(SETTINGS, { zoomFactor: 1.25 });
  data = readRaw();
  check(
    'zoom change preserves debugBarEnabled',
    data.zoomFactor === 1.25 && data.debugBarEnabled === true,
    JSON.stringify(data)
  );

  // --- unknown keys (written by a newer/older app version) survive ----------
  fs.writeFileSync(
    SETTINGS,
    JSON.stringify({ zoomFactor: 1, debugBarEnabled: false, futureSetting: 'keep-me' })
  );
  persistUiSettings(SETTINGS, { debugBarEnabled: true });
  data = readRaw();
  check(
    'unknown keys from other versions survive a write',
    data.futureSetting === 'keep-me' && data.debugBarEnabled === true && data.zoomFactor === 1
  );

  // --- corrupt file: read yields {}, write recovers --------------------------
  fs.writeFileSync(SETTINGS, '{not json');
  const corrupt = readUiSettings(SETTINGS);
  check('corrupt file reads as {}', Object.keys(corrupt).length === 0);
  persistUiSettings(SETTINGS, { zoomFactor: 0.8 });
  check('write over corrupt file recovers', readRaw().zoomFactor === 0.8);

  // --- non-object JSON (array / scalar) also reads as {} ---------------------
  fs.writeFileSync(SETTINGS, '[1,2,3]');
  check('array JSON reads as {}', Object.keys(readUiSettings(SETTINGS)).length === 0);
  fs.writeFileSync(SETTINGS, '42');
  check('scalar JSON reads as {}', Object.keys(readUiSettings(SETTINGS)).length === 0);

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
