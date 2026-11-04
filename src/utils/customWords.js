/**
 * The desktop app's custom spelling words (the "Add to dictionary" words of
 * Electron's spell checker) as data that travels: the `customWords` section
 * of the database export, and the plain-text file Settings > Editor exports
 * and imports.
 *
 * Everything that comes in is untrusted: a word is a string, trimmed, 1 to
 * MAX_CUSTOM_WORD_LENGTH characters, with no whitespace or control
 * characters inside (one word, as Chromium's dictionary expects - the same
 * rule as electron/spellcheck.cjs's isWord, which checks again in the main
 * process). Anything else is skipped and counted, never fails an import;
 * at most MAX_CUSTOM_WORDS words are taken. Importing merges: the words
 * already in the dictionary stay, duplicates are reported, nothing is
 * removed.
 *
 * No dependency on the rest of the app: tests import this module directly.
 */

export const CUSTOM_WORDS_FORMAT_VERSION = 1;
/** electron/spellcheck.cjs's MAX_WORD_LENGTH: longer words are refused there too. */
export const MAX_CUSTOM_WORD_LENGTH = 64;
export const MAX_CUSTOM_WORDS = 10000;
export const CUSTOM_WORDS_FILENAME = 'jacarium-custom-words.txt';

/** One word: a trimmed string of 1..64 characters with no whitespace or control character. */
export function isCustomWord(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CUSTOM_WORD_LENGTH
    && value.trim() === value
    // eslint-disable-next-line no-control-regex
    && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * The valid, distinct words of an untrusted list, in the order given, and
 * how many entries were dropped (not a string, empty after trimming, too
 * long, inner whitespace or control characters, duplicates are not counted
 * as skipped, entries beyond MAX_CUSTOM_WORDS are).
 * @param {unknown} list
 * @returns {{ words: string[], skipped: number }}
 */
export function normalizeCustomWords(list) {
  if (!Array.isArray(list)) return { words: [], skipped: list === undefined || list === null ? 0 : 1 };
  const words = [];
  const seen = new Set();
  let skipped = 0;
  for (const entry of list) {
    const word = typeof entry === 'string' ? entry.trim() : entry;
    if (!isCustomWord(word)) { skipped += 1; continue; }
    if (seen.has(word)) continue;
    if (words.length >= MAX_CUSTOM_WORDS) { skipped += 1; continue; }
    seen.add(word);
    words.push(word);
  }
  return { words, skipped };
}

/** The sorted text of a word list: one word per line, UTF-8, a final newline. */
export function customWordsText(words) {
  const { words: valid } = normalizeCustomWords(words);
  return valid.length ? valid.slice().sort((a, b) => a.localeCompare(b)).join('\n') + '\n' : '';
}

/**
 * The candidate words of an imported file: a JSON array when the text is
 * one (a `[`-led document), else one word per line (a BOM, blank lines and
 * `#` comment lines ignored). Validation is normalizeCustomWords's.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseCustomWordsText(text) {
  const raw = String(text ?? '');
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;   // a byte-order mark
  if (/^\s*\[/.test(body)) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON after all: read it as lines */ }
  }
  return body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/** The `customWords` section of a database export. */
export function customWordsExportSection(words) {
  const { words: valid } = normalizeCustomWords(words);
  return { formatVersion: CUSTOM_WORDS_FORMAT_VERSION, words: valid.slice().sort((a, b) => a.localeCompare(b)) };
}

/**
 * The candidate words of a database export's `customWords` field, or null
 * when the file has none (an export from before the field, or from the
 * browser deployment). The field is the versioned object
 * ({ formatVersion, words }) or, leniently, a bare array.
 * @param {object} importData
 * @returns {unknown[] | null}
 */
export function readCustomWordsSection(importData) {
  const section = importData?.customWords;
  if (section === undefined || section === null) return null;
  if (Array.isArray(section)) return section;
  if (typeof section === 'object' && Array.isArray(section.words)) return section.words;
  return [];
}

/**
 * Merge candidate words into the dictionary behind `api`: the valid new
 * words are added, the ones already there are left alone, nothing is
 * removed. The desktop bridge's importWords(words) takes the whole
 * (validated, deduplicated) list in one call - the main process checks each
 * word again (electron/spellcheck.cjs) and answers with the counts; a
 * bridge without it gets one addWord(word) per new word.
 * @param {unknown[]} candidates
 * @param {{ listWords: Function, importWords?: Function, addWord?: Function }} api
 * @param {{ dryRun?: boolean }} [options] dryRun: count, add nothing
 * @returns {Promise<{ added: number, existing: number, skipped: number, words: string[] }>}
 *   words: the words added (or that would be)
 */
export async function mergeCustomWords(candidates, api, { dryRun = false } = {}) {
  const { words, skipped } = normalizeCustomWords(candidates);
  const result = { added: 0, existing: 0, skipped, words: [] };
  if (!words.length) return result;
  const current = await api.listWords().catch(() => []);
  const have = new Set(Array.isArray(current) ? current : []);
  const fresh = words.filter((word) => !have.has(word));
  result.existing = words.length - fresh.length;
  if (dryRun) { result.added = fresh.length; result.words = fresh; return result; }
  if (typeof api.importWords === 'function') {
    const r = await Promise.resolve(api.importWords(fresh)).catch(() => null);
    if (!r?.ok) { result.skipped += fresh.length; return result; }
    result.added = r.added || 0;
    result.existing += r.existing || 0;
    result.skipped += r.skipped || 0;
    result.words = Array.isArray(r.words) ? r.words.filter(isCustomWord) : fresh.slice(0, result.added);
    return result;
  }
  for (const word of fresh) {
    const r = await Promise.resolve(api.addWord(word)).catch(() => ({ ok: false }));
    if (r?.ok) { result.added += 1; result.words.push(word); } else result.skipped += 1;
  }
  return result;
}

/** "12 words added, 3 already there, 1 skipped" */
export function formatCustomWordsResult({ added = 0, existing = 0, skipped = 0 } = {}) {
  const parts = [`${added} ${added === 1 ? 'word' : 'words'} added`];
  if (existing) parts.push(`${existing} already there`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(', ');
}

/** The desktop app's spell-checker bridge (electron/preload.cjs), or null in a browser. */
export function spellcheckApi() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.spellcheck : null;
  return api && typeof api.listWords === 'function' && typeof api.addWord === 'function' ? api : null;
}
