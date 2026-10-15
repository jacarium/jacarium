/**
 * Guards the dark-theme label contrast pass for Mermaid diagrams
 * (src/utils/mermaidDiagrams.js: parseCssColor / relativeLuminance /
 * contrastRatio / pickLabelColor / ensureDarkLabelContrast, run by applySvg
 * for dark renders only).
 *
 * THE BUG: in the app's dark mode mermaid's dark theme paints node labels
 * light (#ccc). Author styling (`classDef x fill:#fef9c3,stroke:#ca8a04`,
 * `style N fill:...`, `classDef default fill:#f4f4f5`) replaces only the
 * FILL, so pastel boxes got light-grey text: measured 1.4:1, unreadable. The
 * same diagram is fine in light mode (dark default text).
 *
 * THE FIX: after every dark render, each label is checked against the shape
 * it sits on; unless the author chose a text colour (mermaid emits
 * `classDef ... color:` as `style="color:... !important"` on the label group
 * and `style="fill:... !important"` on its <text>), the label gets whichever
 * of dark/light text contrasts better, as an inline `fill !important` (the
 * only thing that beats the theme's `.label text { fill }` rule).
 *
 * What this proves (pure functions + a synthetic SVG in jsdom):
 *   - the colour parser, WCAG luminance and contrast math (white/black 21:1,
 *     #ccc on #fef9c3 < 2:1, mid greys) and pickLabelColor's rules: keep the
 *     theme colour when it already meets 4.5:1, otherwise the better of
 *     dark/light; unknown/none fills are left alone;
 *   - ensureDarkLabelContrast on a flowchart-shaped SVG: pastel nodes (class
 *     and `style` fills, multi-line tspans) get dark text, a dark node gets
 *     light text, a node with an explicit author colour is untouched (label
 *     group `color:` or text `fill:`), cluster titles and edge-label chips
 *     and sequence notes are handled, the label's own placeholder rects are
 *     never mistaken for the shape;
 *   - idempotent: a second pass yields the same DOM and does not treat its
 *     own markers as author colours; markers are cleared and re-derived;
 *   - DOMPurify's SVG profile keeps the inline fill and the marker attribute
 *     (the cache holds mermaid's own output, the pass re-runs on insert);
 *   - source guards: applySvg runs the pass for the dark theme only, so light
 *     mode and the PDF export (always 'default') are unchanged.
 *
 * The real rendering (getComputedStyle against mermaid's scoped stylesheet,
 * the theme toggle re-render) is covered by tests/documents-mermaid-live.test.mjs.
 *
 * Run:  node tests/mermaid-dark-label-contrast.test.mjs
 * Preconditions: npm install; test-only dep: npm install --no-save jsdom
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');
requireResolvable('dompurify', 'Run: npm install');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- jsdom globals (dompurify binds to window at import time) ----------
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { window } = dom;
for (const [k, v] of Object.entries({ window, document: window.document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, DOMParser: window.DOMParser, MutationObserver: window.MutationObserver })) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
const {
  parseCssColor, relativeLuminance, contrastRatio, pickLabelColor, ensureDarkLabelContrast,
  MIN_LABEL_CONTRAST, DARK_LABEL_TEXT, LIGHT_LABEL_TEXT,
} = await import(path.join(REPO, 'src', 'utils', 'mermaidDiagrams.js'));
const DOMPurify = req('dompurify');

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// =====================================================================
// Section 1: colour math
// =====================================================================
{
  check('section 1: parses rgb()/rgba()/hex/short hex/keywords, rejects none/transparent/currentColor/url()',
    JSON.stringify(parseCssColor('rgb(254, 249, 195)')) === '[254,249,195,1]'
    && JSON.stringify(parseCssColor('rgba(0,0,0,0.5)')) === '[0,0,0,0.5]'
    && JSON.stringify(parseCssColor('#fef9c3')) === '[254,249,195,1]'
    && JSON.stringify(parseCssColor('#FFF')) === '[255,255,255,1]'
    && JSON.stringify(parseCssColor('#00000080')) === `[0,0,0,${128 / 255}]`
    && JSON.stringify(parseCssColor('white')) === '[255,255,255,1]'
    && parseCssColor('none') === null && parseCssColor('transparent') === null && parseCssColor('currentColor') === null
    && parseCssColor('url(#grad)') === null && parseCssColor('') === null && parseCssColor(undefined) === null);
  check('section 1: relative luminance - white 1, black 0, #808080 ~0.2159',
    near(relativeLuminance([255, 255, 255]), 1) && near(relativeLuminance([0, 0, 0]), 0) && near(relativeLuminance([128, 128, 128]), 0.2159, 0.001));
  check('section 1: contrast ratio - white/black 21:1 either way, same colour 1:1',
    near(contrastRatio('#fff', '#000'), 21) && near(contrastRatio('black', 'white'), 21) && near(contrastRatio('#777', '#777'), 1));
  const bug = contrastRatio('#ccc', '#fef9c3');
  check(`section 1: the reported failure - theme #ccc text on a pastel #fef9c3 fill is far below ${MIN_LABEL_CONTRAST} (${bug.toFixed(2)}:1)`, bug < 2);
  check('section 1: unparseable colours give null, not NaN', contrastRatio('none', '#fff') === null && contrastRatio('#fff', 'url(#x)') === null);
}

// =====================================================================
// Section 2: pickLabelColor rules
// =====================================================================
{
  check('section 2: pastel fill + light theme text -> dark text', pickLabelColor('#fef9c3', '#ccc') === DARK_LABEL_TEXT);
  check('section 2: light fill (rgb form, as getComputedStyle reports) -> dark text', pickLabelColor('rgb(244, 244, 245)', 'rgb(204, 204, 204)') === DARK_LABEL_TEXT);
  check('section 2: dark navy fill + light theme text already >= 4.5 -> null (theme colour kept)', pickLabelColor('#1e3a8a', '#ccc') === null);
  check('section 2: dark navy fill + dark text -> light text', pickLabelColor('#1e3a8a', '#111827') === LIGHT_LABEL_TEXT);
  check('section 2: mid-tone fill picks whichever candidate contrasts more', pickLabelColor('#808080', '#808080') === DARK_LABEL_TEXT && pickLabelColor('#6b7280', '#6b7280') === LIGHT_LABEL_TEXT);
  check('section 2: unknown current text colour -> decided by the fill alone', pickLabelColor('#fef9c3', '') === DARK_LABEL_TEXT && pickLabelColor('#111', null) === LIGHT_LABEL_TEXT);
  check('section 2: none/transparent/unparseable fill -> null (nothing to contrast against)', pickLabelColor('none', '#ccc') === null && pickLabelColor('transparent', '#ccc') === null && pickLabelColor('url(#g)', '#ccc') === null);
  const chosen = ['#fef9c3', '#dcfce7', '#fee2e2', '#dbeafe', '#e0e7ff', '#f4f4f5', '#1e3a8a', '#1f2020', '#ca8a04', '#16a34a'];
  check('section 2: every choice meets the 4.5:1 minimum against its fill',
    chosen.every((f) => contrastRatio(pickLabelColor(f, '#808080') || '#808080', f) >= MIN_LABEL_CONTRAST || pickLabelColor(f, '#808080') === null && contrastRatio('#808080', f) >= MIN_LABEL_CONTRAST));
}

// =====================================================================
// Section 3: ensureDarkLabelContrast on a flowchart-shaped SVG
// =====================================================================
// Mirrors mermaid 12's SVG-label output (htmlLabels off): the node's shape is
// a direct child rect/polygon with the classDef fill inline, the label group
// carries the author `color:` when there is one, texts are nested tspans,
// and the label has its own zero-size placeholder rects.
// `themeFill` stands in for the theme's cascaded `.label text { fill }` rule
// as a presentation attribute: jsdom's getComputedStyle does not apply
// <style> rules to SVG, while mermaid never encodes AUTHOR colours that way
// (those arrive as `style="fill:... !important"`), so the pass reads it as
// the current colour, not as an author choice.
const node = (id, cls, shapeStyle, labelStyle, textStyle, lines, tag = 'rect', themeFill = '#ccc') => `
  <g class="node default ${cls}" id="${id}">
    <${tag} class="basic label-container" style="${shapeStyle}" ${tag === 'rect' ? 'x="-76" y="-21" width="152" height="43"' : 'points="0,-30 60,0 0,30 -60,0"'}></${tag}>
    <g class="label" style="${labelStyle}"><rect></rect><g><rect class="background" style="stroke: none"></rect>
      <text y="-10" fill="${themeFill}" style="${textStyle}">${lines.map((l, i) => `<tspan class="text-outer-tspan row" x="0" dy="${i ? '1.1em' : '0'}"><tspan class="text-inner-tspan">${l}</tspan></tspan>`).join('')}</text>
    </g></g>
  </g>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" id="d1" viewBox="0 0 400 400"><style>#d1 .label text{fill:#ccc;}</style>
  <g class="cluster" id="d1-lane"><rect style="fill:#fff7ed !important;stroke:#fb923c !important" x="0" y="0" width="300" height="200"></rect>
    <g class="cluster-label"><text fill="#F9FFFE"><tspan>Intake lane</tspan></text></g></g>
  ${node('n-default', '', 'fill:#f4f4f5 !important;stroke:#9ca3af !important', '', '', ['Ticket arrives', 'from portal'])}
  ${node('n-warn', 'warn', 'fill:#fef9c3 !important;stroke:#ca8a04 !important', '', '', ['Request details'], 'polygon')}
  ${node('n-navy', 'deep', 'fill:#1e3a8a !important;stroke:#93c5fd !important', '', '', ['Archive case'], 'rect', '#1f2020')}
  ${node('n-navy-ok', 'deep2', 'fill:#1e3a8a !important;stroke:#93c5fd !important', '', '', ['Already fine'], 'rect', '#ccc')}
  ${node('n-author', 'pinned', 'fill:#1e3a8a !important;stroke:#93c5fd !important', 'color:#fde68a !important', 'fill:#fde68a !important', ['Kept colour'])}
  ${node('n-author2', 'pinned2', 'fill:#fef9c3 !important', '', 'fill:#7c2d12 !important', ['Author fill'])}
  ${node('n-none', 'ghost', 'fill:none !important', '', '', ['No fill'])}
  <g class="edgeLabel"><g class="label"><rect style="fill:#fef3c7 !important" width="60" height="18"></rect><text fill="#ccc"><tspan>unknown, ask</tspan></text></g></g>
  <g><rect class="note" style="fill:#fff5ad !important" width="100" height="40"></rect><text class="noteText" fill="#ccc"><tspan>A pastel note</tspan></text></g>
  <g><rect class="actor" style="fill:#eaeaea !important" width="100" height="40"></rect><text class="actor" fill="#ccc"><tspan>Clientq</tspan></text></g>
</svg>`;

const parse = (markup) => { const div = window.document.createElement('div'); div.innerHTML = markup; window.document.body.appendChild(div); return div; };
const fillOf = (el) => ((el.getAttribute('style') || '').match(/fill\s*:\s*([^;!]+)/i) || [])[1]?.trim() || null;
const same = (a, b) => JSON.stringify(parseCssColor(a)) === JSON.stringify(parseCssColor(b));
const hasFill = (el, color) => same(fillOf(el), color);
const texts = (root, sel) => Array.from(root.querySelectorAll(`${sel} text, ${sel} tspan`));

{
  const root = parse(SVG);
  const fixed = ensureDarkLabelContrast(root);
  check('section 3: returns the number of labels recoloured (default, warn, navy, cluster, edge label, note, actor = 7)', fixed === 7, `fixed=${fixed}`);
  check('section 3: pastel default node (classDef default) -> every text/tspan gets dark text as inline !important fill + marker',
    texts(root, '#n-default .label').every((t) => hasFill(t, DARK_LABEL_TEXT) && /!important/.test(t.getAttribute('style')) && t.getAttribute('data-contrast-fill') === DARK_LABEL_TEXT));
  check('section 3: multi-line label: both rows recoloured', root.querySelectorAll('#n-default .label tspan.row[data-contrast-fill]').length === 2);
  check('section 3: pastel polygon node (classDef warn) -> dark text', texts(root, '#n-warn .label').every((t) => hasFill(t, DARK_LABEL_TEXT)));
  check('section 3: dark navy node whose theme text is dark -> light text', texts(root, '#n-navy .label').every((t) => hasFill(t, LIGHT_LABEL_TEXT)));
  check('section 3: dark navy node whose theme text (#ccc) already meets 4.5:1 is left to the theme (no marker)', !root.querySelector('#n-navy-ok [data-contrast-fill]'));
  check('section 3: explicit author colour (label group color: + text fill:) is NEVER overridden',
    texts(root, '#n-author .label').every((t) => !t.hasAttribute('data-contrast-fill')) && hasFill(root.querySelector('#n-author .label text'), '#fde68a'));
  check('section 3: explicit author text fill alone (no group color) is respected too',
    !root.querySelector('#n-author2 [data-contrast-fill]') && hasFill(root.querySelector('#n-author2 .label text'), '#7c2d12'));
  check('section 3: a shape with fill:none is left alone (nothing to contrast against)', !root.querySelector('#n-none [data-contrast-fill]'));
  check('section 3: the label\'s own placeholder <rect>s are never taken as the node shape (otherwise black -> light text)',
    hasFill(root.querySelector('#n-default .label text'), DARK_LABEL_TEXT));
  check('section 3: pastel cluster rect -> cluster title gets dark text', texts(root, '.cluster-label').every((t) => hasFill(t, DARK_LABEL_TEXT)));
  check('section 3: pastel edge-label chip -> dark text', texts(root, '.edgeLabel').every((t) => hasFill(t, DARK_LABEL_TEXT)));
  check('section 3: sequence note and actor boxes with light fills -> dark text',
    hasFill(root.querySelector('text.noteText'), DARK_LABEL_TEXT) && hasFill(root.querySelector('text.actor'), DARK_LABEL_TEXT));
  check('section 3: shapes themselves are untouched (fills unchanged)',
    hasFill(root.querySelector('#n-default rect.basic'), '#f4f4f5') && hasFill(root.querySelector('.cluster > rect'), '#fff7ed'));

  // Idempotency: a second pass must not read its own markers as author colour
  const before = root.innerHTML;
  const again = ensureDarkLabelContrast(root);
  check('section 3: second pass is idempotent (same count, byte-identical DOM, markers not mistaken for author colours)', again === 7 && root.innerHTML === before);

  // Marker cleanup when the shape changes: recolour a marked node dark and re-run
  root.querySelector('#n-default rect.basic').setAttribute('style', 'fill:#111827 !important');
  ensureDarkLabelContrast(root);
  check('section 3: a re-run re-derives from the current fill (pastel -> dark shape: the theme\'s #ccc is readable again, so the override and marker are removed)',
    texts(root, '#n-default .label').every((t) => !t.hasAttribute('data-contrast-fill') && fillOf(t) === null)
      && root.querySelector('#n-default .label text').getAttribute('fill') === '#ccc');
  root.querySelector('#n-default rect.basic').setAttribute('style', 'fill:#fef9c3 !important');
  ensureDarkLabelContrast(root);
  check('section 3: ...and back to a pastel shape re-applies dark text',
    texts(root, '#n-default .label').every((t) => hasFill(t, DARK_LABEL_TEXT) && t.getAttribute('data-contrast-fill') === DARK_LABEL_TEXT));

  // Sanitizer compatibility (the pass runs after insertion, but the markup must survive a sanitize round-trip anyway)
  const sanitized = DOMPurify.sanitize(root.innerHTML, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
  check('section 3: DOMPurify\'s SVG profile keeps the inline !important fill and the data-contrast-fill marker',
    /data-contrast-fill="#111827"/.test(sanitized) && /fill:\s*(#111827|rgb\(17, 24, 39\))\s*!important/.test(sanitized) && /<style>/.test(sanitized));
  check('section 3: no-op on a root without diagrams / on null', ensureDarkLabelContrast(parse('<p>none</p>')) === 0 && ensureDarkLabelContrast(null) === 0);
}

// =====================================================================
// Section 4: source guards
// =====================================================================
{
  const src = fs.readFileSync(path.join(REPO, 'src/utils/mermaidDiagrams.js'), 'utf8');
  check('section 4: applySvg runs the contrast pass for the dark theme only (light mode and the always-light PDF export unchanged)',
    /if \(theme === 'dark'\) ensureDarkLabelContrast\(out\);/.test(src));
  const cacheIdx = src.indexOf('cacheSet(cacheKey, svg)');
  const applyIdx = src.indexOf('applySvg(el, theme, svg)');
  check('section 4: the cache stores mermaid\'s sanitized output, the pass runs on the inserted DOM (never a post-processed SVG reused across themes)',
    cacheIdx > 0 && applyIdx > 0 && !/cacheSet\([^)]*innerHTML/.test(src));
  check('section 4: minimum contrast is WCAG AA 4.5:1', MIN_LABEL_CONTRAST === 4.5);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
