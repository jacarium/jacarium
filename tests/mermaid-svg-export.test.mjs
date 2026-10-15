/**
 * Guards the "Download SVG" export of rendered Mermaid diagrams
 * (src/utils/mermaidDiagrams.js serializeDiagramSvg / diagramExportFilename,
 * used by DocumentEditor's diagram context menu; the download itself goes
 * through exportHelpers.downloadBlob like every other export).
 *
 * THE FEATURE: right-click a rendered ```mermaid diagram in the Documents
 * preview -> "Download SVG" saves the diagram as currently displayed as a
 * standalone SVG file. The preview's element is not usable as a file on its
 * own: mermaid sizes it with width="100%", relies on the page background
 * (its dark theme paints light text and no background), and the markup came
 * out of an HTML document. The serializer must therefore produce a file
 * that renders the same in a browser or Inkscape, without the app.
 *
 * What this proves (jsdom, synthetic markup shaped like mermaid 12 output):
 *   - the file is a standalone XML/SVG document: XML declaration, the SVG
 *     xmlns on the root, explicit numeric width/height taken from the
 *     viewBox, the viewBox kept (or derived when a diagram has none), and it
 *     parses as image/svg+xml without a parsererror;
 *   - a background rect covering the viewBox is painted first: white for the
 *     light theme, the dark theme's dark colour, or an explicit opaque
 *     colour (the preview pane's computed background); transparent /
 *     unparseable explicit colours fall back to the theme;
 *   - mermaid's embedded <style> is kept verbatim (it is what themes the
 *     file) and so are the dark-mode label-contrast overrides on the live
 *     element (inline fill !important + marker), i.e. "as displayed";
 *   - nothing unsafe survives even if the input were not sanitized: script,
 *     foreignObject, event-handler attributes and javascript: URLs are
 *     dropped; no remote references are introduced (no http(s) URLs other
 *     than the W3C namespace names, no @import, no font embedding);
 *   - the source element is untouched (the preview keeps working);
 *   - the file is fully self-describing for importers with partial CSS
 *     support (Adobe Illustrator dropped every edge line and smeared the
 *     drop-shadow rule over decision diamonds): no <style>, no style
 *     attributes, no filters, no data-* attributes; every graphic/text leaf
 *     carries its COMPUTED paint and text properties as presentation
 *     attributes - hex colours (alpha folded into *-opacity), unit-less
 *     numbers, explicit fill/stroke on every leaf and stroke-width whenever
 *     there is a stroke; solid edges carry NO dash pattern (mermaid's
 *     draw-in animation "0 0 L 4" and "dash 0" are solid), dotted/dashed
 *     edges a plain repeating one; groups keep only opacity/visibility/
 *     display; the live/clone pairing is robust to the sanitising pass;
 *   - marker arrowheads are baked into plain shapes: Adobe Illustrator
 *     collapses any path with a marker-start/marker-end reference into a
 *     single-point unstroked path (verified with the plainest marker), so
 *     each referenced marker is drawn as a <g> with the exact SVG marker
 *     transform (vertex from the live geometry, tangent angle for
 *     orient="auto", viewBox/markerUnits scale, refX/refY) and the marker
 *     attributes and <marker> definitions are removed; without live
 *     geometry the reference is kept instead;
 *   - the file name is `<title>-diagram-<n>.svg` with the same character
 *     rules as the ZIP/PDF exports (reserved characters -> "-", whitespace
 *     -> "_"), "Untitled" for an empty title, length-capped;
 *   - source guards: the editor opens the shared ContextMenu only on a
 *     rendered diagram and downloads through the shared downloadBlob helper.
 *
 * The real flow (right-click in Chrome, the menu, the captured download,
 * light and dark exports) is covered by tests/documents-mermaid-live.test.mjs.
 *
 * Run:  node tests/mermaid-svg-export.test.mjs
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

const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { window } = dom;
for (const [k, v] of Object.entries({ window, document: window.document, Node: window.Node, Element: window.Element, XMLSerializer: window.XMLSerializer, DOMParser: window.DOMParser })) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
const { serializeDiagramSvg, diagramExportFilename, inlineComputedStyles, normalizeDashArray, colorToAttribute, bakeMarkers, markerTransform, MERMAID_EXPORT_BACKGROUNDS, parseCssColor } =
  await import(path.join(REPO, 'src', 'utils', 'mermaidDiagrams.js'));

// ---------- synthetic diagram, shaped like mermaid 12's flowchart output ----------
const DIAGRAM = `<svg id="mermaid-diagram-t1-1" width="100%" viewBox="0 0 320 180" style="max-width: 320px;" role="graphics-document document" aria-roledescription="flowchart-v2">
  <style>#mermaid-diagram-t1-1{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:16px;}#mermaid-diagram-t1-1 .label text{fill:#ccc;}#mermaid-diagram-t1-1 .node rect{fill:#1f2020;stroke:#ccc;}</style>
  <g class="root"><g class="nodes">
    <g class="node default warn" id="n-warn" transform="translate(80, 40)"><rect class="basic label-container" style="fill:#fef9c3 !important;stroke:#ca8a04 !important" x="-60" y="-20" width="120" height="40"></rect>
      <g class="label"><rect></rect><g><text y="-10" style="fill:#111827 !important" data-contrast-fill="#111827"><tspan class="row" x="0" style="fill:#111827 !important" data-contrast-fill="#111827"><tspan>Request details</tspan></tspan></text></g></g></g>
    <g class="node default" id="n-plain" transform="translate(240, 120)"><rect class="basic label-container" x="-60" y="-20" width="120" height="40"></rect>
      <g class="label"><text y="-10"><tspan>Archive case</tspan></text></g></g>
  </g></g>
</svg>`;
const mount = (markup) => { const div = window.document.createElement('div'); div.innerHTML = markup; window.document.body.appendChild(div); return div.querySelector('svg'); };
const parseSvg = (xml) => {
  const parsed = new window.DOMParser().parseFromString(xml, 'image/svg+xml');
  const error = parsed.querySelector('parsererror');
  return { root: error ? null : parsed.documentElement, error: error && error.textContent };
};
const same = (a, b) => JSON.stringify(parseCssColor(a)) === JSON.stringify(parseCssColor(b));

// =====================================================================
// Section 1: standalone light export
// =====================================================================
{
  const svg = mount(DIAGRAM);
  const before = svg.outerHTML;
  const xml = serializeDiagramSvg(svg, { theme: 'default' });
  const { root, error } = parseSvg(xml);
  check('section 1: starts with an XML declaration', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg'));
  check('section 1: parses as image/svg+xml with no parsererror', !!root && !error, error || '');
  check('section 1: root is <svg> in the SVG namespace with the xmlns declared exactly once',
    root && root.namespaceURI === 'http://www.w3.org/2000/svg' && (xml.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g) || []).length === 1);
  check('section 1: explicit numeric width/height taken from the viewBox (no more width="100%")',
    root && root.getAttribute('width') === '320' && root.getAttribute('height') === '180' && root.getAttribute('viewBox') === '0 0 320 180');
  const bg = root && root.querySelector('rect.mermaid-export-background');
  check('section 1: a background rect covering the whole viewBox is present and white for the light theme',
    bg && bg.getAttribute('x') === '0' && bg.getAttribute('y') === '0' && bg.getAttribute('width') === '320' && bg.getAttribute('height') === '180' && same(bg.getAttribute('fill'), MERMAID_EXPORT_BACKGROUNDS.default) && same(bg.getAttribute('fill'), '#ffffff'));
  const kids = root ? Array.from(root.children).map((c) => c.tagName.toLowerCase()) : [];
  check('section 1: the background rect is the FIRST child (painted under everything - mermaid\'s sequence renderer puts <style> after the actor groups, so "after the stylesheet" covered them)', kids[0] === 'rect' && kids[1] === 'g', kids.join(','));
  check('section 1: no <style> element and no style attributes remain (importers with partial CSS support misapplied them)', root && !root.querySelector('style') && !root.querySelector('[style]') && !/<style|\sstyle=/.test(xml));
  check('section 1: the dark-mode contrast override on the live element (inline fill !important) is exported as a plain fill attribute, marker attribute dropped',
    root && root.querySelector('#n-warn text').getAttribute('fill') === '#111827' && !root.querySelector('#n-warn text').hasAttribute('data-contrast-fill') && !root.querySelector('[data-contrast-fill]'));
  check('section 1: all labels and node fills survive, as hex presentation attributes', root && root.textContent.includes('Request details') && root.textContent.includes('Archive case') && root.querySelector('#n-warn rect').getAttribute('fill') === '#fef9c3');
  check('section 1: no remote references (no http(s) URLs beyond the W3C namespace names, no @import, no url())',
    !/https?:\/\/(?!www\.w3\.org\/)/.test(xml) && !/@import/.test(xml) && !/url\(/.test(xml));
  check('section 1: fonts are whatever the stylesheet already names - nothing embedded (no @font-face, no data: URIs)', !/@font-face|data:/.test(xml));
  check('section 1: the live preview element is untouched', svg.outerHTML === before && !svg.querySelector('.mermaid-export-background') && svg.getAttribute('width') === '100%');
  check('section 1: ends with a newline (POSIX-friendly text file)', xml.endsWith('</svg>\n'));
}

// =====================================================================
// Section 2: dark theme and explicit backgrounds
// =====================================================================
{
  const svg = mount(DIAGRAM);
  const dark = parseSvg(serializeDiagramSvg(svg, { theme: 'dark' })).root;
  check('section 2: dark theme -> dark background rect (the light labels do not become light-on-transparent)',
    dark && same(dark.querySelector('rect.mermaid-export-background').getAttribute('fill'), MERMAID_EXPORT_BACKGROUNDS.dark) && parseCssColor(MERMAID_EXPORT_BACKGROUNDS.dark)[0] < 60);
  const custom = parseSvg(serializeDiagramSvg(svg, { theme: 'dark', background: 'rgb(30, 30, 30)' })).root;
  check('section 2: an explicit opaque background (the preview pane\'s computed colour) wins over the theme default',
    custom && custom.querySelector('rect.mermaid-export-background').getAttribute('fill') === 'rgb(30, 30, 30)');
  const transparent = parseSvg(serializeDiagramSvg(svg, { theme: 'dark', background: 'rgba(0, 0, 0, 0)' })).root;
  const junk = parseSvg(serializeDiagramSvg(svg, { theme: 'default', background: 'not-a-colour' })).root;
  check('section 2: a transparent or unparseable explicit background falls back to the theme colour',
    transparent && same(transparent.querySelector('rect.mermaid-export-background').getAttribute('fill'), MERMAID_EXPORT_BACKGROUNDS.dark)
    && junk && same(junk.querySelector('rect.mermaid-export-background').getAttribute('fill'), MERMAID_EXPORT_BACKGROUNDS.default));
  check('section 2: unknown theme -> light background', same(parseSvg(serializeDiagramSvg(svg, { theme: 'neon' })).root.querySelector('rect.mermaid-export-background').getAttribute('fill'), '#ffffff'));
}

// =====================================================================
// Section 3: safety and robustness
// =====================================================================
{
  // Not what the preview ever holds (it is DOMPurify-sanitized first), but the
  // serializer must not be the weak link if it were handed raw markup.
  const hostile = mount(`<svg viewBox="0 0 10 10" onload="window.__pwned = 1"><style>.a{fill:red}</style><script>window.__pwned = 2;</script>
    <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onclick="window.__pwned = 3">html</div></foreignObject>
    <a href="javascript:window.__pwned = 4"><text onmouseover="window.__pwned = 5">Label</text></a></svg>`);
  const xml = serializeDiagramSvg(hostile, { theme: 'default' });
  const { root, error } = parseSvg(xml);
  check('section 3: script, foreignObject, on* handlers and javascript: URLs are stripped; the file still parses',
    !!root && !error && !/<script|foreignObject|onload|onclick|onmouseover|javascript:/i.test(xml) && root.textContent.includes('Label'));

  // A diagram without a viewBox: derive one from its box / attributes
  const noViewBox = mount(`<svg width="640" height="480"><g><text>No viewBox</text></g></svg>`);
  const derived = parseSvg(serializeDiagramSvg(noViewBox, { theme: 'default' })).root;
  check('section 3: a diagram without a viewBox gets one derived from its size, plus a matching background rect',
    derived && derived.getAttribute('viewBox') === '0 0 640 480' && derived.getAttribute('width') === '640' && derived.querySelector('rect.mermaid-export-background').getAttribute('width') === '640');
  const offset = mount(`<svg viewBox="-50 -25 200 100"><g><text>Offset</text></g></svg>`);
  const off = parseSvg(serializeDiagramSvg(offset, { theme: 'default' })).root;
  check('section 3: a viewBox with a non-zero origin gets the background at that origin', off && off.querySelector('rect.mermaid-export-background').getAttribute('x') === '-50' && off.querySelector('rect.mermaid-export-background').getAttribute('y') === '-25' && off.getAttribute('width') === '200');
  let threw = null;
  try { serializeDiagramSvg(window.document.createElement('div')); } catch (e) { threw = e; }
  check('section 3: refuses a non-<svg> element', !!threw);
}

// =====================================================================
// Section 3b: computed styles inlined as presentation attributes
// =====================================================================
// jsdom has no CSS cascade, so the computed styles are injected: the fake
// answers like Chrome's getComputedStyle (px units, comma lists, rgb()).
{
  const withEdges = `<svg id="d2" viewBox="0 0 100 100" style="max-width: 100px;"><style>#d2 .flowchart-link{stroke:#333;fill:none;} #d2 .edge-pattern-solid{stroke-dasharray:0;} #d2 [data-look="neo"].node polygon{filter:drop-shadow(1px 2px 2px rgba(185,185,185,1));}</style>
    <script>window.__x = 1;</script>
    <defs><filter id="d2-drop-shadow"><feDropShadow dx="4" dy="4"/></filter><marker id="d2-pointEnd" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path class="arrowMarkerPath" d="M 0 0 L 10 5 L 0 10 z" style="stroke-width: 1; stroke-dasharray: 1, 0;"></path></marker></defs>
    <g class="edgePaths">
      <path class="edge-thickness-normal edge-pattern-solid flowchart-link" d="M0,0L50,50" marker-end="url(#d2-pointEnd)" style="stroke-dasharray: 0 0 70.71 4; stroke-dashoffset: 0;" data-edge="true" data-points="abc"></path>
      <path class="edge-thickness-thick edge-pattern-dotted flowchart-link" d="M0,50L50,0" style="stroke-dasharray: 0 0 2 2 2 2 2 2 4; stroke-dashoffset: 0;"></path>
      <path class="edge-thickness-normal edge-pattern-dashed flowchart-link" d="M0,0L0,60"></path>
    </g>
    <g class="node default" data-look="neo"><polygon class="label-container" points="0,-30 60,0 0,30 -60,0" style="fill:#fef9c3 !important" filter="url(#d2-drop-shadow)"></polygon>
      <g class="label" style="color:#111827 !important"><text y="-10" style="fill:#111827 !important"><tspan>Label</tspan></text></g></g>
    <g class="cluster"><rect width="90" height="90"></rect></g>
    <g class="edgeLabel"><g class="label" style="opacity: 0.5"><rect width="20" height="10"></rect></g></g>
  </svg>`;
  const fakeComputed = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute('class') || '';
    const v = { fill: 'rgb(0, 0, 0)', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-width': '1px', 'stroke-opacity': '1', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0px', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', opacity: '1', visibility: 'visible', display: 'inline', 'font-family': '"trebuchet ms", verdana, arial, sans-serif', 'font-size': '16px', 'font-weight': '400', 'font-style': 'normal', 'text-anchor': 'start', 'dominant-baseline': 'auto', 'letter-spacing': 'normal', 'text-decoration': 'none' };
    if (/flowchart-link/.test(cls)) Object.assign(v, { stroke: 'rgb(51, 51, 51)', fill: 'none', 'stroke-width': /edge-thickness-thick/.test(cls) ? '3.5px' : '1px', 'stroke-dasharray': /dotted/.test(cls) ? '0px, 0px, 2px, 2px, 2px, 2px, 2px, 2px, 4px' : /dashed/.test(cls) ? '3px' : '0px, 0px, 70.71px, 4px', 'stroke-dashoffset': '0px' });
    if (/arrowMarkerPath/.test(cls)) Object.assign(v, { fill: 'rgb(51, 51, 51)', stroke: 'rgb(51, 51, 51)', 'stroke-dasharray': '1px, 0px' });
    if (/label-container/.test(cls)) Object.assign(v, { fill: 'rgb(254, 249, 195)', stroke: 'url("#d2-gradient")', 'stroke-linejoin': 'round' });
    if (tag === 'rect' && el.parentElement.getAttribute('class') === 'cluster') Object.assign(v, { fill: 'rgb(71, 73, 73)', stroke: 'rgba(255, 255, 255, 0.25)', 'stroke-opacity': '1' });
    if (tag === 'rect' && el.closest('.edgeLabel')) Object.assign(v, { fill: 'rgb(88, 88, 88)', opacity: '0.5' });
    if (tag === 'g' && el.closest('.edgeLabel') && cls === 'label') Object.assign(v, { opacity: '0.5' });
    if (tag === 'text' || tag === 'tspan') Object.assign(v, { fill: 'rgb(17, 24, 39)', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-weight': '600' });
    return { getPropertyValue: (n) => v[n] ?? '' };
  };
  // jsdom elements have no geometry: give the solid edge (M0,0 L50,50) the
  // browser's answers so the marker can be baked at its end.
  const svg = mount(withEdges);
  const solidEdge = svg.querySelector('path.edge-pattern-solid');
  solidEdge.getTotalLength = () => 70.71;
  solidEdge.getPointAtLength = (d) => ({ x: d / Math.SQRT2, y: d / Math.SQRT2 });
  const before = svg.outerHTML;
  const xml = serializeDiagramSvg(svg, { theme: 'default', computeStyle: fakeComputed });
  const { root, error } = parseSvg(xml);
  check('section 3b: still parses; <script>, <style> and <filter> gone; no style/filter/data-* attributes anywhere',
    !!root && !error && !/<script|<style|<filter/.test(xml) && !root.querySelector('[style], [filter]') && !/\sdata-[a-z-]+=/.test(xml), error || '');
  const links = root ? Array.from(root.querySelectorAll('path.flowchart-link')) : [];
  check('section 3b: every edge path carries explicit hex stroke, fill="none" and stroke-width presentation attributes',
    links.length === 3 && links.every((p) => p.getAttribute('stroke') === '#333333' && p.getAttribute('fill') === 'none') && links[0].getAttribute('stroke-width') === '1' && links[1].getAttribute('stroke-width') === '3.5' && links[2].getAttribute('stroke-width') === '1',
    links.map((p) => `${p.getAttribute('stroke')}/${p.getAttribute('fill')}/${p.getAttribute('stroke-width')}`).join(' | '));
  check('section 3b: the SOLID edge has NO dasharray/dashoffset (mermaid\'s draw-in "0 0 L 4" is solid); dotted -> "2 2"; dashed -> "3"',
    links[0] && !links[0].hasAttribute('stroke-dasharray') && !links[0].hasAttribute('stroke-dashoffset') && links[1].getAttribute('stroke-dasharray') === '2 2' && links[2].getAttribute('stroke-dasharray') === '3',
    links.map((p) => p.getAttribute('stroke-dasharray')).join(' | '));
  const baked = root && root.querySelector('g.mermaid-export-marker');
  check('section 3b: the marker-end reference is baked into a plain arrowhead group right after the edge, with hex fill/stroke and its "1 0" (solid) dash dropped; no marker attributes or <marker> definitions remain',
    links[0] && !links[0].hasAttribute('marker-end') && baked && baked.previousElementSibling === links[0] && baked.querySelector('path').getAttribute('fill') === '#333333' && baked.querySelector('path').getAttribute('stroke') === '#333333' && !baked.querySelector('path').hasAttribute('stroke-dasharray')
      && !root.querySelector('marker') && !root.querySelector('[marker-end], [marker-start], [marker-mid]'), baked ? baked.outerHTML.slice(0, 200) : 'no baked marker');
  check('section 3b: the baked arrowhead carries the exact marker transform (vertex (50,50), tangent 45deg, viewBox 10 -> 8 = scale 0.8, ref (5,5))',
    baked && baked.getAttribute('transform') === 'translate(50 50) rotate(45) scale(0.8) translate(-5 -5)', baked && baked.getAttribute('transform'));
  const poly = root && root.querySelector('polygon.label-container');
  check('section 3b: node shape: hex fill, gradient stroke reference unquoted, linejoin kept, filter attribute removed, initial values skipped',
    poly && poly.getAttribute('fill') === '#fef9c3' && poly.getAttribute('stroke') === 'url(#d2-gradient)' && poly.getAttribute('stroke-linejoin') === 'round' && !poly.hasAttribute('filter') && !poly.hasAttribute('opacity') && !poly.hasAttribute('stroke-linecap') && !poly.hasAttribute('visibility'));
  check('section 3b: rgba() strokes become hex + stroke-opacity', root && root.querySelector('.cluster rect').getAttribute('stroke') === '#ffffff' && root.querySelector('.cluster rect').getAttribute('stroke-opacity') === '0.25');
  check('section 3b: label text gets fill/font/anchor attributes (units stripped)', root && root.querySelector('text').getAttribute('fill') === '#111827' && root.querySelector('text').getAttribute('text-anchor') === 'middle' && root.querySelector('text').getAttribute('font-size') === '16' && root.querySelector('text').getAttribute('font-weight') === '600' && /trebuchet/.test(root.querySelector('text').getAttribute('font-family')));
  check('section 3b: groups keep only their effective opacity (edge-label chip group) and lose their style attribute', root && root.querySelector('.edgeLabel g.label').getAttribute('opacity') === '0.5' && root.querySelector('g.node').attributes.length === 1 && !root.querySelector('g.node .label').hasAttribute('style'));
  check('section 3b: the live element is untouched (attributes only on the export)', svg.outerHTML === before && !svg.querySelector('path[stroke]') && !!svg.querySelector('style'));
  check('section 3b: inlineComputedStyles pairs live/clone trees and reports the touched count; mismatched trees are a no-op',
    (() => { const c = svg.cloneNode(true); const n = inlineComputedStyles(svg, c, fakeComputed); const bad = svg.cloneNode(true); bad.removeChild(bad.querySelector('defs')); return n >= 8 && inlineComputedStyles(svg, bad, fakeComputed) === 0; })());
  check('section 3b: without computed paint (environment reports nothing) inline styles are kept rather than lost',
    (() => { const c = svg.cloneNode(true); inlineComputedStyles(svg, c, () => ({ getPropertyValue: () => '' })); return c.querySelector('polygon').getAttribute('style') === 'fill:#fef9c3 !important'; })());
}

// =====================================================================
// Section 3c: dash-array and colour normalisation
// =====================================================================
{
  check('section 3c: normalizeDashArray - none/empty/all-zero -> none', normalizeDashArray('none') === 'none' && normalizeDashArray('') === 'none' && normalizeDashArray('0px') === 'none' && normalizeDashArray('0, 0') === 'none');
  check('section 3c: mermaid draw-in "0 0 L 4" is solid whatever the path length (L is a few units short of it); a plain long dash on a much longer path stays a pattern; a dash covering >= 90% of the path is solid',
    normalizeDashArray('0px, 0px, 59.59px, 4px', 62.9) === 'none' && normalizeDashArray('0px, 0px, 59.59px, 4px', null) === 'none' && normalizeDashArray('0px, 0px, 59.59px, 4px', 200) === 'none'
    && normalizeDashArray('59.59px, 4px', 200) === '59.59 4' && normalizeDashArray('59.59px, 4px', 62) === 'none');
  check('section 3c: "1 0" (dash, zero gap) -> none; "3 3" kept; dotted repetition with tail -> "2 2"; "3" kept',
    normalizeDashArray('1px, 0px') === 'none' && normalizeDashArray('3px, 3px') === '3 3' && normalizeDashArray('0px, 0px, 2px, 2px, 2px, 2px, 4px') === '2 2' && normalizeDashArray('3px') === '3');
  check('section 3c: colorToAttribute - rgb -> hex, rgba -> hex + alpha, none, url("#x") -> url(#x), hex passthrough',
    colorToAttribute('rgb(51, 51, 51)').value === '#333333' && colorToAttribute('rgba(255, 255, 255, 0.25)').value === '#ffffff' && colorToAttribute('rgba(255, 255, 255, 0.25)').alpha === 0.25
    && colorToAttribute('none').value === 'none' && colorToAttribute('url("#g1")').value === 'url(#g1)' && colorToAttribute('#abc').value === '#aabbcc');
}

// =====================================================================
// Section 3d: marker transform and baking rules
// =====================================================================
{
  const mk = (attrs) => { const div = window.document.createElement('div'); div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker ${attrs}><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs></svg>`; return div.querySelector('marker'); };
  check('section 3d: userSpaceOnUse + viewBox: scale = min(mw/vbw, mh/vbh), stroke width ignored',
    markerTransform(mk('viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"'), { x: 10, y: 20 }, 90, 3.5) === 'translate(10 20) rotate(90) scale(0.8) translate(-5 -5)');
  check('section 3d: markerUnits strokeWidth (default) multiplies by the stroke width; numeric orient used as-is; refX/refY default 0',
    markerTransform(mk('markerWidth="4" markerHeight="4" viewBox="0 0 10 10" orient="30"'), { x: 0, y: 0 }, 45, 2) === 'translate(0 0) rotate(30) scale(0.8) translate(0 0)');
  check('section 3d: auto-start-reverse adds 180deg at the start only; no viewBox -> scale 1',
    markerTransform(mk('refX="4" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"'), { x: 1, y: 1 }, 10, 1, true) === 'translate(1 1) rotate(190) scale(1) translate(-4 -4)'
    && markerTransform(mk('refX="4" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"'), { x: 1, y: 1 }, 10, 1, false) === 'translate(1 1) rotate(10) scale(1) translate(-4 -4)');
  // bakeMarkers without live geometry keeps the reference and the definitions
  const div = window.document.createElement('div');
  div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="mm" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs><path d="M0,0L10,0" marker-end="url(#mm)"/><line x1="0" y1="0" x2="5" y2="5" marker-start="url(#mm)"/></svg>`;
  const live = div.querySelector('svg');
  const clone = live.cloneNode(true);
  check('section 3d: no geometry available -> nothing baked, marker references and definitions kept', bakeMarkers(live, clone) === 0 && clone.querySelector('marker') && clone.querySelector('[marker-end]') && clone.querySelector('[marker-start]'));
  live.querySelector('path[marker-end]').getTotalLength = () => 10; live.querySelector('path[marker-end]').getPointAtLength = (d) => ({ x: d, y: 0 });
  live.querySelector('line').getTotalLength = () => 7.071; live.querySelector('line').getPointAtLength = (d) => ({ x: d / Math.SQRT2, y: d / Math.SQRT2 });
  const clone2 = live.cloneNode(true);
  const n = bakeMarkers(live, clone2);
  const groups = Array.from(clone2.querySelectorAll('g.mermaid-export-marker'));
  check('section 3d: with geometry both end and start markers are baked (path end at (10,0) angle 0; line start at (0,0) angle 45) and definitions removed',
    n === 2 && groups.length === 2 && groups[0].getAttribute('transform') === 'translate(10 0) rotate(0) scale(1) translate(-4 -4)' && groups[1].getAttribute('transform') === 'translate(0 0) rotate(45) scale(1) translate(-4 -4)'
      && !clone2.querySelector('marker') && !clone2.querySelector('[marker-end], [marker-start]') && groups.every((g) => g.querySelector('path')), groups.map((g) => g.getAttribute('transform')).join(' | '));
}

// =====================================================================
// Section 4: file names
// =====================================================================
{
  check('section 4: <title>-diagram-<n>.svg', diagramExportFilename('Incident runbook', 2) === 'Incident_runbook-diagram-2.svg');
  check('section 4: reserved characters become "-", whitespace runs "_" (same rules as the ZIP/PDF exports)',
    diagramExportFilename('Weird: name/with\\chars?*<>|"', 1) === 'Weird-_name-with-chars-------diagram-1.svg', diagramExportFilename('Weird: name/with\\chars?*<>|"', 1));
  check('section 4: empty / missing title -> Untitled; bad index -> 1',
    diagramExportFilename('', 3) === 'Untitled-diagram-3.svg' && diagramExportFilename(undefined, 0) === 'Untitled-diagram-1.svg' && diagramExportFilename('   ', NaN) === 'Untitled-diagram-1.svg');
  check('section 4: leading/trailing dots and underscores trimmed (no hidden files, no "..")', diagramExportFilename('..secret..', 1) === 'secret-diagram-1.svg' && diagramExportFilename('_x_', 1) === 'x-diagram-1.svg');
  check('section 4: very long titles are capped', diagramExportFilename('a'.repeat(300), 1).length < 100);
  check('section 4: control characters are replaced', !/[\u0000-\u001f]/.test(diagramExportFilename('tab\there\nline', 1)));
}

// =====================================================================
// Section 5: editor wiring (source guards)
// =====================================================================
{
  const editor = fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentEditor.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(REPO, 'src/hooks/useImportExport.js'), 'utf8');
  check('section 5: DocumentEditor reuses the shared context-menu hook and component',
    /from '\.\.\/\.\.\/\.\.\/hooks\/useContextMenu'/.test(editor) && /from '\.\.\/\.\.\/common\/menus\/ContextMenu'/.test(editor) && /<ContextMenuItem[^>]*label="Download SVG"/.test(editor));
  check('section 5: the menu opens only on a RENDERED diagram (error boxes and text keep the default menu)',
    /closest\??\.?\('\.mermaid-diagram\[data-mermaid="rendered"\]'\)/.test(editor) && /onContextMenu=\{handlePreviewContextMenu\}/.test(editor));
  check('section 5: the download goes through the shared downloadBlob helper with an image/svg+xml Blob and the title-based file name',
    /from '\.\.\/\.\.\/\.\.\/utils\/exportHelpers'/.test(editor) && /downloadBlob\(new Blob\(\[markup\], \{ type: 'image\/svg\+xml' \}\), diagramExportFilename\(document\?\.title, index\)\)/.test(editor.replace(/\s+/g, ' ')));
  check('section 5: the export serializes the LIVE element with the current theme and the preview pane\'s background',
    /serializeDiagramSvg\(svg,\s*\{\s*theme,\s*background\s*\}\)/.test(editor) && /mermaidThemeForApp\(\)/.test(editor));
  check('section 5: useImportExport.downloadFile uses the same downloadBlob helper (one save mechanism)', /downloadBlob\(new Blob\(\[content\], \{ type \}\), filename\)/.test(hook));
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
