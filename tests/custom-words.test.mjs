/**
 * The custom spelling words as data (src/utils/customWords.js) and their
 * place in the database export and import (src/utils/exportDatabase.js,
 * src/utils/importDatabase.js), against the REAL modules.
 *
 *   1. validation and merge, unit: a word is a trimmed string of 1-64
 *      characters without whitespace or control characters; duplicates are
 *      skipped silently, invalid entries are counted, the 10,000-word limit
 *      holds, the text file is one sorted word per line, a `[`-led file is
 *      read as a JSON array, the result sentence reads right;
 *   2. the export/import round trip on real Dexie over fake-indexeddb with a
 *      fake electronAPI.spellcheck: collectExportData() carries
 *      { formatVersion: 1, words } sorted; runImport() in merge and replace
 *      mode adds the words that are missing, keeps the ones there, counts
 *      the invalid ones, in a dry run adds nothing; an old export without
 *      the field and a browser export leave the dictionary alone and add no
 *      summary; without a spell-checker bridge (a browser importing) nothing
 *      happens; an export in a browser has no customWords field.
 *
 * Needs esbuild and dexie (npm install) and the test-only jsdom /
 * fake-indexeddb (SKIP without them). Run: node tests/custom-words.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

// ---------------------------------------------------------------------------
// 1. the module itself (no dependencies: imported directly)
// ---------------------------------------------------------------------------
const cw = await import(path.join(REPO, 'src/utils/customWords.js'));
{
  check('isCustomWord: plain words pass, including non-ASCII letters, hyphens and apostrophes', ['jacarium', 'Kubernetes', 'příliš', "O'Neil", 'e-mail', 'x'].every(cw.isCustomWord));
  check('isCustomWord: not a string, empty, untrimmed, inner whitespace, control characters, too long -> no', [42, null, '', ' word', 'word ', 'two words', 'tab\tin', 'nl\nin', 'bell\u0007', 'del\u007f', 'a'.repeat(65)].every((v) => !cw.isCustomWord(v)) && cw.isCustomWord('a'.repeat(64)));
  const n = cw.normalizeCustomWords(['beta', ' alpha ', 'beta', 'two words', 7, '', 'gamma\u0000', 'Alpha']);
  check('normalizeCustomWords: trims, keeps order, drops duplicates silently, counts the invalid entries', n.words.join() === 'beta,alpha,Alpha' && n.skipped === 4, JSON.stringify(n));
  check('normalizeCustomWords: not a list -> no words (an object counts as one skipped entry, nothing/null as none)', cw.normalizeCustomWords('alpha').skipped === 1 && cw.normalizeCustomWords(undefined).skipped === 0 && cw.normalizeCustomWords(null).words.length === 0);
  const many = cw.normalizeCustomWords(Array.from({ length: cw.MAX_CUSTOM_WORDS + 5 }, (_, i) => `w${i}`));
  check(`normalizeCustomWords: at most ${cw.MAX_CUSTOM_WORDS} words, the rest skipped and counted`, many.words.length === cw.MAX_CUSTOM_WORDS && many.skipped === 5);
  check('customWordsText: one word per line, sorted, final newline; empty list -> empty text', cw.customWordsText(['zeta', 'alpha', 'alpha', 'bad word']) === 'alpha\nzeta\n' && cw.customWordsText([]) === '');
  check('parseCustomWordsText: lines, CRLF, a BOM, blank and # lines ignored', cw.parseCustomWordsText('﻿alpha\r\n\r\n# comment\nbeta  \n').join() === 'alpha,beta');
  check('parseCustomWordsText: a JSON array is read as one; broken JSON falls back to lines', cw.parseCustomWordsText('["alpha", "beta", 3]').length === 3 && cw.parseCustomWordsText('[not json').join() === '[not json');
  check('customWordsExportSection: { formatVersion: 1, words } sorted and valid only', JSON.stringify(cw.customWordsExportSection(['zeta', 'alpha', 'two words'])) === '{"formatVersion":1,"words":["alpha","zeta"]}');
  check('readCustomWordsSection: the versioned object, a bare array, and null for a file without the field', cw.readCustomWordsSection({ customWords: { formatVersion: 1, words: ['a'] } }).join() === 'a' && cw.readCustomWordsSection({ customWords: ['b'] }).join() === 'b' && cw.readCustomWordsSection({ documents: [] }) === null && cw.readCustomWordsSection({ customWords: 'junk' }).length === 0);
  // the merge against a fake dictionary
  const dict = new Set(['alpha']);
  const api = { listWords: async () => [...dict], addWord: async (w) => { if (w === 'refused') return { ok: false }; dict.add(w); return { ok: true }; } };
  const m = await cw.mergeCustomWords(['alpha', 'beta', 'beta', ' gamma', 'two words', 'refused', 99], api);
  check('mergeCustomWords: adds the new words, keeps the existing, counts duplicates once, counts invalid and refused entries as skipped', m.added === 2 && m.existing === 1 && m.skipped === 3 && m.words.join() === 'beta,gamma' && [...dict].sort().join() === 'alpha,beta,gamma', JSON.stringify(m));
  const dry = await cw.mergeCustomWords(['delta'], api, { dryRun: true });
  check('mergeCustomWords dryRun: counts what would be added, adds nothing', dry.added === 1 && dry.words.join() === 'delta' && !dict.has('delta'));
  // the desktop bridge's importWords: one call with the new, validated words; the main process's counts are taken over
  const bridgeCalls = [];
  const bridge = { listWords: async () => ['alpha'], importWords: async (list) => { bridgeCalls.push(list); return { ok: true, added: list.length - 1, existing: 0, skipped: 1, words: list.slice(1) }; } };
  const viaBridge = await cw.mergeCustomWords(['alpha', 'beta', 'gamma', 'two words'], bridge);
  check('mergeCustomWords with importWords: the already-present word is left out of the one bridge call, the renderer-skipped and the main-skipped entries are both counted, the bridge\'s word list is the result', bridgeCalls.length === 1 && bridgeCalls[0].join() === 'beta,gamma' && viaBridge.added === 1 && viaBridge.existing === 1 && viaBridge.skipped === 2 && viaBridge.words.join() === 'gamma', JSON.stringify(viaBridge));
  const refusing = { listWords: async () => [], importWords: async () => ({ ok: false, reason: 'not a list of words' }) };
  const refusedAll = await cw.mergeCustomWords(['beta'], refusing);
  check('mergeCustomWords with a refusing bridge: nothing added, the words counted as skipped', refusedAll.added === 0 && refusedAll.skipped === 1, JSON.stringify(refusedAll));
  check('formatCustomWordsResult: "12 words added, 3 already there, 1 skipped"; singular; the zero parts left out', cw.formatCustomWordsResult({ added: 12, existing: 3, skipped: 1 }) === '12 words added, 3 already there, 1 skipped' && cw.formatCustomWordsResult({ added: 1 }) === '1 word added' && cw.formatCustomWordsResult({ added: 0, existing: 2 }) === '0 words added, 2 already there');
  check('spellcheckApi: null without a bridge', cw.spellcheckApi() === null);
}

// ---------------------------------------------------------------------------
// 2. the round trip through the real export and import modules
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
for (const dep of ['fake-indexeddb', 'jsdom']) { try { req.resolve(dep); } catch { console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`); process.exit(failed ? 1 : 0); } }

const lsStore = new Map([['db_migration_complete', 'true'], ['workflows_migration_complete', 'true'], ['env_vars_migration_complete', 'true']]);
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  key: (i) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size; },
};
await import(req.resolve('fake-indexeddb/auto'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-words-'));
const { build } = await import(req.resolve('esbuild'));
const ENTRY = path.join(WORK, 'entry.mjs');
const BUNDLE = path.join(WORK, 'bundle.cjs');
fs.writeFileSync(ENTRY, [
  `export { runImport } from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { collectExportData } from ${JSON.stringify(path.join(REPO, 'src/utils/exportDatabase.js'))};`,
].join('\n'));
await build({ entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { runImport, collectExportData } = req(BUNDLE);
const realLog = console.log;
console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('[')) return; realLog(...args); };

// the fake desktop bridge: the dictionary is a Set
const dictionary = new Set(['zeta', 'alpha']);
const calls = { add: [] };
const fakeSpellcheck = {
  listWords: async () => [...dictionary].sort(),
  addWord: async (w) => { calls.add.push(w); dictionary.add(w); return { ok: true }; },
  removeWord: async (w) => { dictionary.delete(w); return { ok: true }; },
};
globalThis.window = { electronAPI: { isElectron: true, spellcheck: fakeSpellcheck } };

const quiet = () => {};
const exported = await collectExportData(quiet);
check('export (desktop): the file carries customWords { formatVersion: 1, words } sorted, after localStorage', JSON.stringify(exported.customWords) === '{"formatVersion":1,"words":["alpha","zeta"]}' && Object.keys(exported).indexOf('customWords') > Object.keys(exported).indexOf('localStorage'), JSON.stringify(exported.customWords));
const exportedJson = JSON.parse(JSON.stringify(exported));   // what a file holds

// merge mode: a dictionary with other words
dictionary.clear(); dictionary.add('alpha'); dictionary.add('omega'); calls.add.length = 0;
const merged = await runImport(exportedJson, true);
check('import (merge): the missing word is added, the present one kept, nothing removed; the summary says so', calls.add.join() === 'zeta' && [...dictionary].sort().join() === 'alpha,omega,zeta' && merged.summary.customWords.created === 1 && merged.summary.customWords.skipped === 1 && merged.summary.customWords.invalid === 0, JSON.stringify(merged.summary.customWords));
check('import (merge): the totals count the added word', merged.totals.created >= 1);

// replace mode merges the words as well (the dictionary is not the database's)
dictionary.clear(); dictionary.add('omega'); calls.add.length = 0;
const replaced = await runImport(exportedJson, false);
check('import (replace): the words are merged too - added, nothing removed', calls.add.sort().join() === 'alpha,zeta' && dictionary.has('omega') && replaced.summary.customWords.created === 2, JSON.stringify(replaced.summary.customWords));

// a dry run (both modes) adds nothing and reports what would happen
dictionary.clear(); calls.add.length = 0;
const dryMerge = await runImport(exportedJson, true, { dryRun: true });
const dryReplace = await runImport(exportedJson, false, { dryRun: true });
check('dry run (merge and replace): would add 2, adds nothing', calls.add.length === 0 && dictionary.size === 0 && dryMerge.summary.customWords.created === 2 && dryReplace.summary.customWords.created === 2, JSON.stringify([dryMerge.summary.customWords, dryReplace.summary.customWords]));

// untrusted content: invalid entries are skipped and counted, never fail the import
dictionary.clear(); calls.add.length = 0;
const hostile = { ...exportedJson, customWords: { formatVersion: 1, words: ['good', 'two words', 'x'.repeat(65), 7, null, 'ctrl\u0001', 'good', ' spaced '] } };
const h = await runImport(hostile, true);
check('import: invalid entries are skipped and counted (with a reason), the valid ones added, duplicates merged, the import completes', calls.add.sort().join() === 'good,spaced' && h.summary.customWords.created === 2 && h.summary.customWords.invalid === 5 && /not a single word/.test(h.summary.customWords.errors[0].reason), JSON.stringify(h.summary.customWords));
const junk = await runImport({ ...exportedJson, customWords: 'nonsense' }, true);
check('import: a customWords field that is not a list or the versioned object is ignored (nothing added, no error)', junk.summary.customWords.created === 0 && junk.summary.customWords.invalid === 0);

// an old export (no field) and a browser export (no field) leave the dictionary alone
dictionary.clear(); dictionary.add('kept'); calls.add.length = 0;
const old = { ...exportedJson }; delete old.customWords;
const o = await runImport(old, true);
check('import: an export without the field (older, or from a browser) touches nothing and adds no customWords summary', calls.add.length === 0 && dictionary.has('kept') && !('customWords' in o.summary));

// a browser importing: no bridge -> nothing happens, no summary
globalThis.window = { electronAPI: undefined };
calls.add.length = 0;
const b = await runImport(exportedJson, true);
check('import in a browser (no spell-checker bridge): the field is ignored, no summary', calls.add.length === 0 && !('customWords' in b.summary));
const browserExport = await collectExportData(quiet);
check('export in a browser: no customWords field at all', !('customWords' in browserExport));
check('export with no saved custom themes: the customThemes section is still written, empty (the import preview says "0 custom themes")', JSON.stringify(browserExport.customThemes) === '{"formatVersion":1,"themes":[]}', JSON.stringify(browserExport.customThemes));

fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
