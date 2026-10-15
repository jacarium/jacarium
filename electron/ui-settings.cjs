// Read-merge-write persistence for ui-settings.json (the per-user file under
// Electron's userData dir that holds live-applied UI preferences: zoomFactor,
// debugBarEnabled, ...).
//
// persistUiSettings() MERGES the given keys into whatever the file already
// holds instead of overwriting the whole file. The original implementation
// (persistZoomFactor in main.cjs) wrote `{ zoomFactor }` wholesale, so the
// moment a second setting lived in this file, changing zoom would silently
// delete it. Every setting stored in ui-settings.json must go through this
// helper for that reason.
//
// Kept free of any Electron imports (callers pass the file path in) so the
// merge behavior is unit-testable with plain Node - see
// tests/ui-settings-merge.test.mjs.

const fs = require('fs');
const path = require('path');

// Returns the parsed settings object, or {} if the file is missing, corrupt,
// or not a plain object. Never throws.
function readUiSettings(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data;
    }
  } catch {
    // Missing or corrupt file: treat as empty settings.
  }
  return {};
}

// Merges `partial` into the existing file contents and writes the result.
// Returns the merged object. Throws on write failure (callers decide how to
// report it - the setting still applies for the session either way).
function persistUiSettings(filePath, partial) {
  const merged = { ...readUiSettings(filePath), ...partial };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

module.exports = { readUiSettings, persistUiSettings };
