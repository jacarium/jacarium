/**
 * Guards the document editor's line-number gutter layout logic
 * (src/components/features/documents/gutterLineLayout.js, used by
 * src/components/features/documents/DocumentEditor.jsx).
 *
 * THE BUGS: "it ignores the lines that span across multiple lines, it just
 * shows one number per line" and "when I press Enter the numbers jump around
 * / lag / flip back and forth". The gutter's per-line heights used to come
 * from three different code paths: a flat one-row-per-line fallback before
 * calibration, a character-count ESTIMATE (ceil(len / charsPerRow)) for
 * ~200ms after every keystroke, and a real DOM measurement only once idle.
 * The estimate does not know about word boundaries or tabs, so for many
 * lines the gutter showed the wrong row count right after a keystroke and
 * then visibly "fixed" itself 200ms later; and nothing re-measured when the
 * Red Hat Mono web font swapped in after the first measurement.
 *
 * THE FIX: heights are always measured (hidden mirror of the textarea) and
 * cached per distinct line text, so a keystroke only measures the line it
 * changed and the gutter is exact on the same render; the cache is dropped on
 * width/font/tab-size/web-font changes; the gutter hides its numbers until the
 * textarea is calibrated instead of rendering a wrong flat gutter; and the
 * width calibration / ResizeObserver re-attach when preview mode swaps the
 * textarea element.
 *
 * Real browser wrapping cannot be exercised here (jsdom has no layout) - that
 * lives in tests/documents-gutter-smoke.mjs (headless Chrome, trusted input).
 * This file covers the pure layout/caching logic with a fake measurer, the
 * mirror measurer's DOM contract in jsdom, and source-level guards on the
 * editor wiring. Self-contained, no test framework.
 *
 * Run:  node tests/documents-gutter-interactions.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const arr = (typed) => Array.from(typed);

const { computeLineLayout, flatLineLayout, measureLinesWithMirror, measureTextareaRowPitch, snapToLayoutUnit, BASE_LINE_HEIGHT } =
  await import(path.join(REPO, 'src', 'components', 'features', 'documents', 'gutterLineLayout.js'));

// =====================================================================
// Section 1: computeLineLayout with a fake measurer
// =====================================================================
{
  const B = BASE_LINE_HEIGHT;
  // Fake "browser": a line wraps into 1 + (number of '|' markers) rows
  const calls = [];
  const measure = (lines) => { calls.push(lines.slice()); return lines.map((l) => 1 + (l.match(/\|/g) || []).length); };
  const cache = { key: '', map: new Map() };

  const doc1 = ['short', 'a long|wrapped|line', '', 'short', 'another|one'];
  const r1 = computeLineLayout(doc1, cache, 'w=800|font=A', measure);
  check('section 1: heights come from the measurer per logical line; empty lines are one row',
    eq(arr(r1.heights), [B, 3 * B, B, B, 2 * B]) && r1.lineCount === 5 && r1.calibrated === true, JSON.stringify(arr(r1.heights)));
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  check('section 1: cumulative offsets and total are the running sums (what the gutter and cursor overlays use)',
    near(arr(r1.cumulative), [B, 4 * B, 5 * B, 6 * B, 8 * B]) && Math.abs(r1.totalHeight - 8 * B) < 1e-6);
  check('section 1: first pass measures each DISTINCT non-empty line exactly once (duplicates and blanks skipped)',
    calls.length === 1 && eq(calls[0], ['short', 'a long|wrapped|line', 'another|one']) && r1.measuredCount === 3, JSON.stringify(calls));

  // A keystroke: only the edited line is new
  const doc2 = ['short', 'a long|wrapped|line!', '', 'short', 'another|one'];
  const r2 = computeLineLayout(doc2, cache, 'w=800|font=A', measure);
  check('section 1: a keystroke measures only the changed line (cache hit for everything else)',
    calls.length === 2 && eq(calls[1], ['a long|wrapped|line!']) && r2.measuredCount === 1 && eq(arr(r2.heights), [B, 3 * B, B, B, 2 * B]));

  // Enter inside a wrapped line: two new shorter lines, nothing else re-measured
  const doc3 = ['short', 'a long|wrapped', 'line!', '', 'short', 'another|one'];
  const r3 = computeLineLayout(doc3, cache, 'w=800|font=A', measure);
  check('section 1: Enter inside a wrapped line measures just the two new halves and the row counts follow immediately',
    calls.length === 3 && eq(calls[2], ['a long|wrapped', 'line!']) && eq(arr(r3.heights), [B, 2 * B, B, B, B, 2 * B]) && r3.lineCount === 6);

  // Nothing new -> no measurement at all
  const before = calls.length;
  computeLineLayout(doc3, cache, 'w=800|font=A', measure);
  check('section 1: an unchanged document is served entirely from the cache (no measurement)', calls.length === before);

  // Width / font / web-font change -> cache dropped, everything re-measured
  const r4 = computeLineLayout(doc3, cache, 'w=600|font=A', measure);
  // doc3 has 4 distinct non-empty lines ('short' appears twice, one blank)
  check('section 1: a different cache key (width, font, tab size, web fonts...) drops the cache and re-measures every distinct line',
    calls.length === before + 1 && eq(calls[before], ['short', 'a long|wrapped', 'line!', 'another|one']) && r4.measuredCount === 4);

  // Measurer returning garbage never yields sub-row or NaN heights
  const bad = computeLineLayout(['x', 'y', 'z'], { key: '', map: new Map() }, 'k', () => [0, NaN, 2.4]);
  check('section 1: non-finite / zero row counts are clamped to one row and fractional counts rounded (never a NaN or collapsed gutter row)',
    eq(arr(bad.heights), [B, B, 2 * B]) && Number.isFinite(bad.totalHeight));

  // Heights are rows * the TEXTAREA's calibrated pitch, not whatever px the mirror reports
  const pitched = computeLineLayout(['a', 'b|c', ''], { key: '', map: new Map() }, 'k', (ls) => ls.map((l) => 1 + (l.match(/\|/g) || []).length), 22.390625);
  check('section 1: gutter heights are whole rows times the calibrated row pitch (exact 1/64px multiples, so gutter rows stack like textarea rows)',
    eq(arr(pitched.heights), [22.390625, 44.78125, 22.390625]) && pitched.rowHeight === 22.390625 && pitched.totalHeight === 89.5625);
  check('section 1: snapToLayoutUnit rounds to Chrome\'s 1/64px grid (22.4 -> 22.40625, 22.3925 -> 22.390625)',
    snapToLayoutUnit(22.4) === 22.40625 && snapToLayoutUnit(22.3925) === 22.390625 && snapToLayoutUnit(22.390625) === 22.390625);

  // Cache pruning after long editing sessions
  const churn = { key: '', map: new Map() };
  let maxSize = 0;
  for (let i = 0; i < 2600; i++) {
    computeLineLayout([`line ${i}`, 'stable'], churn, 'k', (ls) => ls.map(() => 1));
    maxSize = Math.max(maxSize, churn.map.size);
  }
  // 2-line doc: pruned back to its own lines once the cache passes 2*2 + 2000 entries
  check('section 1: the cache is pruned back to the current document once it grows well past it',
    maxSize <= 2 * 2 + 2000 + 1 && churn.map.size < 2600 && churn.map.has('stable') && churn.map.has('line 2599'),
    `maxSize=${maxSize} final=${churn.map.size}`);

  const flat = flatLineLayout(3);
  check('section 1: the uncalibrated flat layout is one row per line and flagged calibrated: false (gutter hides numbers)',
    eq(arr(flat.heights), [B, B, B]) && flat.calibrated === false && flat.totalHeight === 3 * B);
}

// =====================================================================
// Section 2: mirror measurer DOM contract (jsdom: no layout, all rects 0)
// =====================================================================
{
  const { JSDOM } = await import(req.resolve('jsdom'));
  const dom = new JSDOM('<!doctype html><html><body><textarea style="width:400px;padding:16px 24px;font:14px monospace;line-height:1.6"></textarea></body></html>', { pretendToBeVisual: true });
  const { document: doc } = dom.window;
  const ta = doc.querySelector('textarea');
  const rows = measureLinesWithMirror(['one', 'two\tthree', 'x'.repeat(300)], ta);
  check('section 2: mirror row counter returns one count per requested line, at least 1 row each (jsdom has no layout), and removes its mirror from the DOM',
    rows.length === 3 && rows.every((r) => r === 1) && doc.body.querySelectorAll('div').length === 0);
  check('section 2: the mirror terminates each batch with a marker followed by a non-empty probe row (not a bare empty span)',
    /fragment\.appendChild\(end\);\s*fragment\.appendChild\(doc\.createTextNode\('M'\)\)/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'gutterLineLayout.js'), 'utf8')));
  const pitch = measureTextareaRowPitch(ta);
  check('section 2: row-pitch calibration falls back to the CSS line-height when there is no layout engine, and leaves no clone behind',
    pitch === 22.4 && doc.body.querySelectorAll('textarea').length === 1, `pitch=${pitch}`);
  const layout = computeLineLayout(['one', 'two'], { key: '', map: new Map() }, 'k', (ls) => measureLinesWithMirror(ls, ta), pitch);
  check('section 2: end to end in jsdom every line is one base row', eq(arr(layout.heights), [BASE_LINE_HEIGHT, BASE_LINE_HEIGHT]));
}

// =====================================================================
// Section 3: editor wiring (source-level guards)
// =====================================================================
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
  check('section 3: the 200ms measuredContent debounce and the character-count estimation branch are gone',
    !src.includes('measuredContent') && !/Math\.ceil\(lines\[i\]\.length \/ charsPerRow\)/.test(src));
  check('section 3: lineLayoutData uses the cached measured layout (computeLineLayout + measureLinesWithMirror) with the calibrated textarea row pitch',
    /computeLineLayout\(\s*lines,\s*lineHeightCacheRef\.current,\s*cacheKey,\s*\(missing\) => measureLinesWithMirror\(missing, textarea, cs\),\s*rowPitchRef\.current\.value\s*\)/.test(src) &&
    src.includes('measureTextareaRowPitch(textarea, cs)'));
  check('section 3: gutter rows and cursor/overlay math use the calibrated pitch, not a hard-coded 22.4',
    src.includes('lineHeight: rowLineHeight') && src.includes('const baseLineHeight = lineLayoutData.rowHeight || 22.4;'));
  check('section 3: lineLayoutData no longer degrades to an estimate in performance mode / large docs',
    !/lineCount > 3000/.test(src) && !/performanceMode \|\| lineCount/.test(src));
  check('section 3: the gutter hides its numbers until the textarea is calibrated instead of rendering a flat gutter',
    src.includes("visibility: lineLayoutData.calibrated ? 'visible' : 'hidden'") && src.includes('return flatLineLayout(lines.length);'));
  check('section 3: web-font loading invalidates the layout (document.fonts loadingdone/ready -> fontsVersion in cache key + memo deps)',
    src.includes("fonts.addEventListener('loadingdone', bump)") && src.includes('fonts.ready.then(bump)') &&
    /cs\.tabSize, cs\.wordBreak, cs\.textTransform, fontsVersion\s*\]\.join\('\|'\)/.test(src) &&
    /textareaContentWidth, yjsContentVersion, fontsVersion\]\);/.test(src));
  check('section 3: width calibration and the ResizeObserver re-attach when preview mode swaps the textarea element',
    src.includes('}, [documentId, isPreviewActive]);') && src.includes('}, [isPreviewActive, documentId]);'));
  check('section 3: cloud (Yjs) docs still drive the gutter from the live CRDT via yjsContentVersion',
    src.includes('yjs.ytext.toString() : content;') && src.includes('ytext.observe(bumpVersion)'));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
