/**
 * Guards the Documents "Find in Files" matching logic
 * (src/utils/findInFiles.js, used by
 * src/components/features/documents/FindInFilesWindow.jsx).
 *
 * THE FEATURE: a JetBrains-style content search over every document's raw
 * markdown, one result per matching LINE, with Match Case / Words / Regex
 * toggles, an optional category scope, a rendered-row cap ("1000+ matches")
 * and the line -> character offset mapping the editor uses to jump to a
 * result. The editor is a plain textarea over the markdown source, so line
 * numbers here must be exactly what its gutter shows (content split on \n).
 *
 * Pure logic only, plain node, synthetic fixture
 * (tests/fixtures/find-in-files/documents.json). The window itself is
 * exercised in tests/documents-find-in-files.test.mjs.
 *
 * Run:  node tests/find-in-files-search.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const {
  buildMatcher, escapeRegex, matchRangesInLine, splitLines, searchDocuments, searchDocumentsAsync,
  lineStartOffset, formatSummary, MAX_RESULTS, documentCategory,
} = await import(path.join(REPO, 'src', 'utils', 'findInFiles.js'));

const DOCS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'find-in-files', 'documents.json'), 'utf8'))
  .map((d, i) => ({ id: i + 1, ...d }));

// ---------- 1. matcher construction ----------
console.log('\n--- 1. buildMatcher ---');
{
  check('empty query -> no matcher', buildMatcher({ query: '' }) === null);
  const plain = buildMatcher({ query: 'a.b*c' });
  check('plain queries are escaped (regex specials are literal)', plain.test('xa.b*cx') && !plain.test('aXbbbc'), plain.source);
  check('escapeRegex escapes every special', escapeRegex('.*+?^${}()|[]\\') === '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  check('default is case-insensitive, global', buildMatcher({ query: 'Widget' }).flags === 'gi');
  check('Match Case drops the i flag', buildMatcher({ query: 'Widget', matchCase: true }).flags === 'g');
  const word = buildMatcher({ query: 'widget', wholeWord: true });
  check('Words: "widget.service" and "widget," match, "widgets" and "WIDGET_OK" do not',
    word.test('widget.service') && (word.lastIndex = 0, word.test('a widget, b')) && (word.lastIndex = 0, !word.test('widgets')) && (word.lastIndex = 0, !word.test('WIDGET_OK')));
  const re = buildMatcher({ query: 'gadget[-_]cache', regex: true });
  check('Regex: the pattern is used as-is', re.test('gadget-cache-a') && (re.lastIndex = 0, re.test('gadget_cache_b')));
  let err = null;
  try { buildMatcher({ query: '(', regex: true }); } catch (e) { err = e; }
  check('an invalid regex throws a typed INVALID_REGEX error with a readable message', err && err.code === 'INVALID_REGEX' && /Invalid regular expression/.test(err.message), err && err.message);
  const wordRe = buildMatcher({ query: 'cache|widget', wholeWord: true, regex: true });
  check('Words + Regex wraps the alternation as a group', wordRe.test('gadget-cache-a') && (wordRe.lastIndex = 0, !wordRe.test('widgets')));
}

// ---------- 2. per-line ranges ----------
console.log('\n--- 2. matchRangesInLine / splitLines ---');
{
  const m = buildMatcher({ query: 'widget' });
  check('every occurrence on a line is a [start, end) range', eq(matchRangesInLine('widget widget widget', m), [[0, 6], [7, 13], [14, 20]]));
  check('case-insensitive ranges keep the original columns', eq(matchRangesInLine('The Widget dashboard shows WIDGET_OK', m), [[4, 10], [27, 33]]));
  check('no match -> empty', eq(matchRangesInLine('nothing here', m), []));
  const star = buildMatcher({ query: 'x*', regex: true });
  check('zero-length regex matches are skipped and the scan terminates', eq(matchRangesInLine('axxb', star), [[1, 3]]));
  check('splitLines: \\n separated, trailing \\r stripped, empty content is one line',
    eq(splitLines('a\r\nb\nc'), ['a', 'b', 'c']) && eq(splitLines(''), ['']) && eq(splitLines(null), ['']));
  check('documentCategory: missing/empty category is General', documentCategory({}) === 'General' && documentCategory({ category: '' }) === 'General' && documentCategory({ category: 'Ops' }) === 'Ops');
}

// ---------- 3. searchDocuments over the fixture ----------
console.log('\n--- 3. searchDocuments ---');
{
  const r = searchDocuments(DOCS, buildMatcher({ query: 'widget' }));
  check('counts: 15 matches in 4 files on 12 lines (case-insensitive)', r.matchCount === 15 && r.fileCount === 4 && r.results.length === 12 && r.truncated === false, JSON.stringify({ m: r.matchCount, f: r.fileCount, rows: r.results.length }));
  const first = r.results[0];
  check('a result carries docId, title, category, 1-based line, the raw line and its ranges',
    first.docId === 1 && first.title === 'Runbook: Widget Restart' && first.category === 'Runbooks' && first.line === 1 && first.text === '# Widget restart' && eq(first.ranges, [[2, 8]]), JSON.stringify(first));
  const triple = r.results.find((x) => x.docId === 1 && x.line === 12);
  check('a line with three hits is ONE row with three ranges', triple && eq(triple.ranges, [[0, 6], [7, 13], [14, 20]]));
  const indented = r.results.find((x) => x.docId === 1 && x.line === 11);
  check('leading whitespace is kept in the row text (the UI trims it for display)', indented && indented.text.startsWith('   indented'));
  const crlf = r.results.find((x) => x.docId === 3 && x.line === 4);
  check('a CRLF line matches and its \\r is not part of the row text', crlf && crlf.text === 'CRLF line with widget');
  const general = r.results.find((x) => x.docId === 4);
  check('an uncategorized document reports category General', general && general.category === 'General');
  check('results come in document order, then line order',
    eq(r.results.map((x) => `${x.docId}:${x.line}`), ['1:1', '1:3', '1:6', '1:7', '1:10', '1:11', '1:12', '2:7', '3:2', '3:3', '3:4', '4:1']));

  const mc = searchDocuments(DOCS, buildMatcher({ query: 'widget', matchCase: true }));
  check('Match Case: 11 matches in 4 files', mc.matchCount === 11 && mc.fileCount === 4, JSON.stringify({ m: mc.matchCount, f: mc.fileCount }));
  const ww = searchDocuments(DOCS, buildMatcher({ query: 'widget', wholeWord: true }));
  check('Words: 13 matches in 3 files ("widgets" and "WIDGET_OK" excluded)', ww.matchCount === 13 && ww.fileCount === 3, JSON.stringify({ m: ww.matchCount, f: ww.fileCount }));
  const rx = searchDocuments(DOCS, buildMatcher({ query: 'widget\\.service', regex: true }));
  check('Regex: widget\\.service -> 2 matches in 1 file', rx.matchCount === 2 && rx.fileCount === 1);

  const scoped = searchDocuments(DOCS, buildMatcher({ query: 'widget' }), { scopeCategory: 'Runbooks' });
  check('scope Runbooks: 11 matches in 2 files, nothing from other categories', scoped.matchCount === 11 && scoped.fileCount === 2 && scoped.results.every((x) => x.category === 'Runbooks'));
  const notes = searchDocuments(DOCS, buildMatcher({ query: 'widget' }), { scopeCategory: 'Notes' });
  check('scope Notes: 3 matches in 1 file', notes.matchCount === 3 && notes.fileCount === 1);
  const none = searchDocuments(DOCS, buildMatcher({ query: 'no-such-token' }));
  check('no hits -> empty result, zero counts', none.results.length === 0 && none.matchCount === 0 && none.fileCount === 0);
  check('a null matcher searches nothing', searchDocuments(DOCS, null).results.length === 0);
  const empty = searchDocuments([{ id: 9, title: 'Title-only', category: 'X' }], buildMatcher({ query: 'x' }));
  check('a document without content is searched as one empty line (no crash, no hit)', empty.matchCount === 0);
}

// ---------- 4. cap ----------
console.log('\n--- 4. result cap ---');
{
  const big = { id: 50, title: 'Big', category: 'Logs', content: Array.from({ length: 1200 }, (_, i) => `row ${i} zzz`).join('\n') };
  const r = searchDocuments([big, DOCS[0]], buildMatcher({ query: 'zzz' }));
  check(`rows are capped at MAX_RESULTS (${MAX_RESULTS}) while counts keep counting`, r.results.length === MAX_RESULTS && r.matchCount === 1200 && r.fileCount === 1 && r.truncated === true);
  check('summary past the cap reads "1000+ matches in 1 file"', formatSummary(r) === '1000+ matches in 1 file', formatSummary(r));
  const small = searchDocuments([big], buildMatcher({ query: 'zzz' }), { maxResults: 10 });
  check('maxResults is honoured', small.results.length === 10 && small.truncated);
  check('summary wording: singular/plural', formatSummary({ matchCount: 1, fileCount: 1 }) === '1 match in 1 file' && formatSummary({ matchCount: 15, fileCount: 4 }) === '15 matches in 4 files' && formatSummary({ matchCount: 0, fileCount: 0 }) === 'No matches');
}

// ---------- 5. async variant ----------
console.log('\n--- 5. searchDocumentsAsync ---');
{
  const sync = searchDocuments(DOCS, buildMatcher({ query: 'widget' }));
  const async = await searchDocumentsAsync(DOCS, buildMatcher({ query: 'widget' }));
  check('async search returns the same result as the sync one', eq(sync, async));
  const cancelled = await searchDocumentsAsync(DOCS, buildMatcher({ query: 'widget' }), { isCancelled: () => true });
  check('a cancelled search resolves to null', cancelled === null);
  const scoped = await searchDocumentsAsync(DOCS, buildMatcher({ query: 'widget' }), { scopeCategory: 'Notes' });
  check('async scope works', scoped.matchCount === 3 && scoped.fileCount === 1);
}

// ---------- 6. line offsets and preview ----------
console.log('\n--- 6. lineStartOffset ---');
{
  const content = 'ab\ncd\r\nef\n\ngh';
  check('line 1 starts at 0', lineStartOffset(content, 1) === 0);
  check('line 2 starts after the first \\n', lineStartOffset(content, 2) === 3);
  check('a CRLF line keeps its \\r in the textarea offsets', lineStartOffset(content, 3) === 7);
  check('an empty line has its own offset', lineStartOffset(content, 4) === 10 && lineStartOffset(content, 5) === 11);
  check('a line past the end clamps to the content length', lineStartOffset(content, 99) === content.length);
  check('line <= 1 / empty content -> 0', lineStartOffset('', 5) === 0 && lineStartOffset(content, 0) === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
