/**
 * Find in Files - content search across documents, one result per matching
 * LINE of raw markdown (the editor is a plain textarea over the markdown
 * source, so "line N" here is exactly what the editor's gutter shows).
 *
 * Pure functions, no DOM: the window (FindInFilesWindow.jsx) owns loading,
 * debouncing and rendering; this module owns matching semantics so they can
 * be tested in plain node.
 */

// Explicit extension so plain `node` can import this module in tests
// (tests/find-in-files-search.test.mjs) without a bundler; Vite accepts it too.
import { createYielder } from './yieldToUI.js';

/** Rows rendered at most; the summary reads "1000+ matches" past it. */
export const MAX_RESULTS = 1000;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegex(text) {
  return text.replace(REGEX_SPECIALS, '\\$&');
}

/**
 * Build the matcher for a query. Returns null for an empty query. Throws an
 * Error with `code === 'INVALID_REGEX'` for an unparsable pattern.
 *
 * @param {{ query: string, matchCase?: boolean, wholeWord?: boolean, regex?: boolean }} options
 * @returns {RegExp|null} a global regex (sticky `lastIndex` semantics)
 */
export function buildMatcher({ query, matchCase = false, wholeWord = false, regex = false }) {
  if (!query) return null;
  let source = regex ? query : escapeRegex(query);
  if (wholeWord) {
    // Word boundaries that also hold at the start/end of the line and treat
    // `_` and digits as word characters, like \b does.
    source = `(?<!\\w)(?:${source})(?!\\w)`;
  }
  try {
    return new RegExp(source, matchCase ? 'g' : 'gi');
  } catch (error) {
    const err = new Error(`Invalid regular expression: ${error.message}`);
    err.code = 'INVALID_REGEX';
    throw err;
  }
}

/**
 * Every [start, end) range the matcher hits on ONE line. Zero-length matches
 * (regex like `a*`) are skipped and the scan advanced so it can never loop.
 */
export function matchRangesInLine(line, matcher) {
  const ranges = [];
  matcher.lastIndex = 0;
  let m;
  while ((m = matcher.exec(line)) !== null) {
    if (m[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Split content into lines the way the editor's gutter counts them. */
export function splitLines(content) {
  return String(content || '').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The document's effective category (uncategorized documents live in General). */
export function documentCategory(doc) {
  return doc?.category || 'General';
}

/**
 * Search one document. Appends results to `out` and returns the number of
 * matches found. `out.length` is capped at `maxResults`; the caller reads
 * `truncated` from searchDocuments.
 */
function searchOneDocument(doc, matcher, out, maxResults) {
  const lines = splitLines(doc.content);
  let matches = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const ranges = matchRangesInLine(lines[i], matcher);
    if (ranges.length === 0) continue;
    matches += ranges.length;
    if (out.length >= maxResults) {
      truncated = true;
      continue;
    }
    out.push({
      docId: doc.id,
      title: doc.title || 'Untitled',
      category: documentCategory(doc),
      line: i + 1,
      text: lines[i],
      ranges,
    });
  }
  return { matches, truncated };
}

/**
 * Search `docs` (documents WITH content) line by line.
 *
 * @param {Array} docs
 * @param {RegExp|null} matcher - from buildMatcher()
 * @param {{ scopeCategory?: string|null, maxResults?: number }} [options]
 * @returns {{ results: Array, matchCount: number, fileCount: number, truncated: boolean }}
 *   `matchCount`/`fileCount` keep counting past the cap (the summary reads
 *   "1000+ matches in N files"); `results` holds at most maxResults rows.
 */
export function searchDocuments(docs, matcher, { scopeCategory = null, maxResults = MAX_RESULTS } = {}) {
  const results = [];
  let matchCount = 0;
  let fileCount = 0;
  let truncated = false;
  if (!matcher) return { results, matchCount, fileCount, truncated };
  for (const doc of docs || []) {
    if (scopeCategory && documentCategory(doc) !== scopeCategory) continue;
    const r = searchOneDocument(doc, matcher, results, maxResults);
    if (r.matches > 0) {
      matchCount += r.matches;
      fileCount += 1;
    }
    if (r.truncated) truncated = true;
  }
  return { results, matchCount, fileCount, truncated };
}

/**
 * Same as searchDocuments but yields to the UI between documents so typing
 * stays responsive on large libraries. `isCancelled()` lets the caller drop
 * a search superseded by a newer query; a cancelled run resolves to null.
 */
export async function searchDocumentsAsync(docs, matcher, { scopeCategory = null, maxResults = MAX_RESULTS, isCancelled = () => false } = {}) {
  const results = [];
  let matchCount = 0;
  let fileCount = 0;
  let truncated = false;
  if (!matcher) return { results, matchCount, fileCount, truncated };
  const maybeYield = createYielder(30);
  for (const doc of docs || []) {
    if (isCancelled()) return null;
    if (scopeCategory && documentCategory(doc) !== scopeCategory) continue;
    const r = searchOneDocument(doc, matcher, results, maxResults);
    if (r.matches > 0) {
      matchCount += r.matches;
      fileCount += 1;
    }
    if (r.truncated) truncated = true;
    await maybeYield();
  }
  if (isCancelled()) return null;
  return { results, matchCount, fileCount, truncated };
}

/**
 * Character offset of the start of `line` (1-based) in `content`, in the
 * editor's textarea coordinates (which keeps `\r` if the content has it).
 */
export function lineStartOffset(content, line) {
  const text = String(content || '');
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
    current += 1;
  }
  return offset;
}

/** "112 matches in 24 files" / "1 match in 1 file" / "1000+ matches in 30 files". */
export function formatSummary({ matchCount, fileCount, truncated }, maxResults = MAX_RESULTS) {
  if (!matchCount) return 'No matches';
  const matches = truncated ? `${maxResults}+ matches` : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`;
  return `${matches} in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
}
