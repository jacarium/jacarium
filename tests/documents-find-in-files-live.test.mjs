#!/usr/bin/env node

/**
 * Real-browser check of the Documents page's "Find in Files" window
 * (src/components/features/documents/FindInFilesWindow.jsx on the shared
 * src/components/common/FloatingWindow.jsx, opened from the sidebar's
 * hamburger menu / context menus or Ctrl+Shift+F, wired in
 * src/components/DocumentsPage.jsx):
 *
 *   - two synthetic documents are typed into the real editor (autosaved to
 *     the throwaway profile's IndexedDB), the window is opened from the
 *     sidebar hamburger menu, a query typed, and the "N matches in M files"
 *     summary + one row per matching line appear;
 *   - "Open in New Tab" closes the window, switches the editor to that
 *     document and REALLY scrolls/selects the matched line (textarea
 *     selectionStart/End on the line, scrollTop > 0 for a line deep in an
 *     80-line document) - the part jsdom cannot prove;
 *   - Ctrl+Shift+F opens the window, Escape closes it;
 *   - the preview shows the WHOLE selected document and is really scrolled
 *     so the matched line sits in the middle of the pane (scrollTop and the
 *     highlight bar's on-screen position), the results/preview divider can
 *     be dragged and the split is persisted;
 *   - PERFORMANCE: a 4000-line synthetic document is typed in and the time
 *     from clicking a result to the preview showing that document, centered,
 *     is measured for small -> big, big -> small, big -> big (same document,
 *     other line); the numbers are printed as INFO and the swaps must stay
 *     under 250 ms;
 *   - in the light AND the dark theme the window's texts (title, summary,
 *     empty state, row text, the <mark> highlight, the muted "title line"
 *     suffix, preview line numbers and text) are >= 4.5:1 against what they
 *     sit on.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/documents-find-in-files-live.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5237)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { launchDocumentsApp, createNewDocument, createDocumentViaSidebar, setEditorContent, sleep } from './helpers/live-documents-app.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5237);
const MIN_RATIO = 4.5;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// Colour parsing + WCAG contrast against the composited background (same
// recipe as tests/documents-import-theme.test.mjs).
const PROBE = `(() => {
  if (window.__probe) return true;
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))).concat([1]); };
  const effectiveBg = (el) => { const layers = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) layers.push(c); } let bg = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg); return bg; };
  const measure = (el) => { const color = parse(getComputedStyle(el).color); const bg = effectiveBg(el); return { color: color.slice(0, 3), bg: bg.slice(0, 3), ratio: Number(contrast(over(color, bg), bg).toFixed(2)) }; };
  window.__probe = { measure };
  return true;
})()`;
const measure = (app, selector) => app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? window.__probe.measure(el) : null; })()`);
const measureLeaf = (app, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll('[data-floating-window="findInFilesWindow"] *')).filter((e) => e.children.length === 0 && ${re.toString()}.test(e.textContent || '')).sort((a, b) => a.textContent.length - b.textContent.length)[0]; return el ? window.__probe.measure(el) : null; })()`);
function checkRatio(theme, label, m, min = MIN_RATIO) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${min}:1`, m.ratio >= min, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
}

const WINDOW = '[data-floating-window="findInFilesWindow"]';
const windowOpen = (app) => app.evaluate(`!!document.querySelector('${WINDOW}')`);
const rowCount = (app) => app.evaluate(`document.querySelectorAll('[data-result-index]').length`);
const summaryText = (app) => app.evaluate(`(document.querySelector('[data-find-summary]') || {}).textContent || null`);

async function openFromHamburger(app) {
  const ok = await app.evaluate(`(() => {
    const add = Array.from(document.querySelectorAll('button[title="Add new"]')).find((b) => /Documents/.test(b.parentElement?.parentElement?.textContent || ''));
    const menu = add && add.nextElementSibling;
    if (!menu) return false;
    menu.click();
    return true;
  })()`);
  if (!ok) return false;
  await sleep(300);
  const clicked = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Find in Files'); if (!b) return false; b.click(); return true; })()`);
  await sleep(400);
  return clicked;
}

async function measureTheme(app, theme) {
  checkRatio(theme, 'window title', await measureLeaf(app, /^Find in Files$/));
  checkRatio(theme, 'summary', await measure(app, '[data-find-summary]'));
  checkRatio(theme, 'row text', await measure(app, '[data-result-index="0"] > span:first-child'));
  checkRatio(theme, 'highlighted match (<mark>)', await measure(app, '[data-result-index="0"] mark'));
  checkRatio(theme, 'muted "title line" suffix', await measure(app, '[data-result-index="0"] > span:last-child'));
  // Selected row: a visible, distinct background (the old `bg-os-blue/15`
  // generated no CSS at all - os-blue has no <alpha-value>, so Tailwind
  // cannot apply the /15 modifier - and the selection was invisible)
  const rowBgs = () => app.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-result-index]'));
    const selected = rows.find((r) => r.getAttribute('aria-selected') === 'true');
    const other = rows.find((r) => r.getAttribute('aria-selected') !== 'true');
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    return { selectedIndex: selected && selected.getAttribute('data-result-index'), selected: bg(selected), other: bg(other), list: bg(document.querySelector('[data-find-results]')) };
  })()`);
  const painted = (c) => !!c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
  let bgs = await rowBgs();
  check(`${theme}: the clicked/selected row has a painted background distinct from unselected rows and the list`, painted(bgs.selected) && bgs.selected !== bgs.other && bgs.selected !== bgs.list, JSON.stringify(bgs));
  checkRatio(theme, 'selected row text', await measure(app, '[aria-selected="true"] > span:first-child'));
  checkRatio(theme, 'selected row <mark>', await measure(app, '[aria-selected="true"] mark'));
  checkRatio(theme, 'selected row "title line" suffix', await measure(app, '[aria-selected="true"] > span:last-child'));
  // Hover must look different from selected
  const hoverBox = await app.evaluate(`(() => { const r = Array.from(document.querySelectorAll('[data-result-index]')).find((x) => x.getAttribute('aria-selected') !== 'true'); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, index: r.getAttribute('data-result-index') }; })()`);
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBox.x, y: hoverBox.y });
  await sleep(150);
  const hovered = await app.evaluate(`getComputedStyle(document.querySelector('[data-result-index="${hoverBox.index}"]')).backgroundColor`);
  check(`${theme}: a hovered unselected row is tinted differently from the selected row and from plain rows`, painted(hovered) && hovered !== bgs.selected && hovered !== bgs.other, JSON.stringify({ hovered, selected: bgs.selected, plain: bgs.other }));
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(100);
  // ...and after moving the selection with the keyboard: first with the list
  // itself focused (a real click on a row focuses the list), then from the input
  const firstRow = await app.evaluate(`(() => { const r = document.querySelector('[data-result-index="0"]'); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: firstRow.x, y: firstRow.y, button: 'left', clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: firstRow.x, y: firstRow.y, button: 'left', clickCount: 1 });
  await sleep(200);
  const key = async (k, code) => { await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); await sleep(200); };
  await key('ArrowDown', 40);
  bgs = await rowBgs();
  check(`${theme}: after a real click on row 0 and ArrowDown, row 1 carries the highlight (and only it)`, bgs.selectedIndex === '1' && painted(bgs.selected) && bgs.selected !== bgs.other && bgs.selected !== bgs.list, JSON.stringify(bgs));
  // No stray (orange) focus outline anywhere: the blue row is the only selection indicator
  const outlineState = () => app.evaluate(`(() => {
    const isOrange = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c || ''); if (!m) return false; const [r, g, b] = [+m[1], +m[2], +m[3]]; return r > 170 && g > 50 && g < 200 && b < 110; };
    // A visible outline needs a style, a width and a non-transparent colour (Tailwind's outline-none is "2px solid transparent")
    const transparent = (c) => /rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(c || '');
    const describe = (el) => { if (!el) return null; const cs = getComputedStyle(el); const visibleOutline = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' && !transparent(cs.outlineColor); return { tag: el.tagName + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, visibleOutline, boxShadow: cs.boxShadow, borderColor: cs.borderColor, orange: (visibleOutline && isOrange(cs.outlineColor)) || isOrange(cs.boxShadow) || isOrange(cs.borderColor) }; };
    return { focused: describe(document.activeElement), row: describe(document.querySelector('[aria-selected="true"]')) };
  })()`);
  let outlines = await outlineState();
  check(`${theme}: the focused element (${outlines.focused && outlines.focused.tag}) shows no visible outline after keyboard navigation in the list`, outlines.focused && !outlines.focused.orange && !outlines.focused.visibleOutline && outlines.focused.boxShadow === 'none', JSON.stringify(outlines.focused));
  check(`${theme}: the selected row itself has no visible outline, box-shadow or orange border`, outlines.row && !outlines.row.visibleOutline && outlines.row.boxShadow === 'none' && !outlines.row.orange, JSON.stringify(outlines.row));
  await app.evaluate(`document.querySelector('input[aria-label="Find in files"]').focus()`);
  await key('ArrowDown', 40);
  bgs = await rowBgs();
  outlines = await outlineState();
  check(`${theme}: ArrowDown from the input moves the highlight to row 2 and leaves no orange outline on the input or the row`, bgs.selectedIndex === '2' && painted(bgs.selected) && outlines.focused && /INPUT/.test(outlines.focused.tag) && !outlines.focused.orange && !outlines.row.orange && !outlines.row.visibleOutline, JSON.stringify({ index: bgs.selectedIndex, focused: outlines.focused, row: outlines.row }));
  check(`${theme}: the search input keeps a visible (blue, not orange) focus ring for keyboard users`, outlines.focused && outlines.focused.boxShadow !== 'none' && !outlines.focused.orange, outlines.focused && outlines.focused.boxShadow);
  await key('ArrowUp', 38);
  await key('ArrowUp', 38);
  // A pressed option toggle must be visibly pressed too (same broken-modifier family)
  const toggleBgs = await app.evaluate(`(async () => { const t = document.querySelector('[data-find-option="Cc"]'); const off = getComputedStyle(t).backgroundColor; t.click(); await new Promise((r) => setTimeout(r, 100)); const on = getComputedStyle(t).backgroundColor; t.click(); await new Promise((r) => setTimeout(r, 100)); return { off, on }; })()`);
  check(`${theme}: a pressed Match Case toggle has a painted background distinct from its idle state`, toggleBgs.on !== toggleBgs.off && painted(toggleBgs.on), JSON.stringify(toggleBgs));
  await app.waitFor(`document.querySelectorAll('[data-result-index]').length === 4`, 8000);
  // The preview's matched-line bar and a pressed toggle use the same kind of tint
  const bar = await app.evaluate(`(() => { const h = document.querySelector('[data-preview-highlight]'); return h ? getComputedStyle(h).backgroundColor : null; })()`);
  check(`${theme}: the preview's matched-line bar is painted`, painted(bar), bar);
  checkRatio(theme, 'preview line numbers', await measure(app, '[data-preview-gutter]'));
  checkRatio(theme, 'preview matched line text', await measure(app, '[data-preview-match-line]'));
  checkRatio(theme, 'preview matched line <mark>', await measure(app, '[data-preview-match-line] mark'));
  checkRatio(theme, 'preview text', await measure(app, '[data-preview-text]'));
  checkRatio(theme, 'search input text', await measure(app, 'input[aria-label="Find in files"]'));
  checkRatio(theme, 'category dropdown text', await measure(app, '[data-find-category]'));
  checkRatio(theme, 'band: preview title', await measure(app, '[data-find-band] [data-band-title]'));
  checkRatio(theme, 'band: line number', await measure(app, '[data-find-band] [data-band-meta]'));
  checkRatio(theme, 'band: category', await measure(app, '[data-find-band] [data-band-meta]:last-child'));
  const bands = await app.evaluate(`(() => {
    // Painted background: the first non-transparent one walking up from the element
    const bg = (sel) => { for (let n = document.querySelector(sel); n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; } return null; };
    const band = document.querySelector('[data-resize-handle="band"]');
    return { band: bg('[data-resize-handle="band"]'), header: bg('[data-floating-window-header]'), results: bg('[data-result-index="0"]'), preview: bg('[data-preview-text]'), bandHeight: band.getBoundingClientRect().height };
  })()`);
  check(`${theme}: the band shares the top bar's background and differs from the painted results/preview surfaces`, bands.band && bands.band === bands.header && bands.results && bands.band !== bands.results && bands.preview && bands.band !== bands.preview, JSON.stringify(bands));
  check(`${theme}: the band is at least 34px tall`, bands.bandHeight >= 34, `${bands.bandHeight}px`);
  const button = await measure(app, `${WINDOW} button[type="button"].bg-os-blue`);
  console.log(`INFO  ${theme}: "Open in New Tab" button  (${button ? `${button.ratio}:1` : 'not found'} - app-wide --os-blue token)`);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'find-in-files-live-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    await app.evaluate(PROBE);
    // Document 1: 80 lines, the needle deep inside so the jump must scroll
    const LONG = Array.from({ length: 80 }, (_, i) => (i === 59 ? 'line 60 carries the needle-alpha token' : `filler line ${i + 1} of the synthetic document`)).join('\n');
    const SHORT = 'first synthetic line\nsecond line has needle-alpha too\nthird line';
    // Document 3: 4000 lines for the preview performance measurement, with
    // the needle on lines 200 and 3500 (same document, far apart)
    const BIG_LINES = 4000;
    const BIG = Array.from({ length: BIG_LINES }, (_, i) => ((i === 199 || i === 3499) ? `perf line ${i + 1} also carries needle-alpha` : `perf filler line ${i + 1} of the big synthetic document`)).join('\n');
    check('a first document was created', await createNewDocument(app));
    check('document 1 holds the 80 synthetic lines', (await setEditorContent(app, LONG)) === LONG);
    check('a second document was created via the sidebar "+"', await createDocumentViaSidebar(app));
    check('document 2 holds the 3 synthetic lines', (await setEditorContent(app, SHORT)) === SHORT);
    check('a third document was created via the sidebar "+"', await createDocumentViaSidebar(app));
    const typedBig = await setEditorContent(app, BIG);
    check(`document 3 holds the ${BIG_LINES} synthetic lines`, typedBig === BIG, typedBig ? `${typedBig.split('\n').length} lines` : 'no textarea');
    await sleep(2500); // let autosave land in IndexedDB

    // ---- open from the hamburger menu, search ----
    check('the sidebar hamburger menu opens "Find in Files"', await openFromHamburger(app));
    check('the floating window is on screen', await windowOpen(app));
    const geometry = await app.evaluate(`(() => { const w = document.querySelector('${WINDOW}'); const r = w.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }; })()`);
    check('a fresh profile opens the window at the new default 920 x 650, inside the viewport', geometry.width === 920 && geometry.height === 650 && geometry.right <= geometry.vw && geometry.bottom <= geometry.vh, JSON.stringify(geometry));
    const focused = await app.evaluate(`document.activeElement === document.querySelector('input[aria-label="Find in files"]')`);
    check('the search input is focused', focused);
    const dropdown = () => app.evaluate(`(() => { const s = document.querySelector('[data-find-category]'); if (!s) return null; const input = document.querySelector('input[aria-label="Find in files"]'); const sr = s.getBoundingClientRect(); const ir = input.getBoundingClientRect(); return { value: s.value, options: Array.from(s.options).map((o) => o.textContent), belowInput: sr.top >= ir.bottom, leftAligned: Math.abs(sr.left - ir.left) <= 2, height: sr.height }; })()`);
    const sidebarCategories = () => app.evaluate(`Array.from(document.querySelectorAll('[data-document-list] button[title="Expand"], [data-document-list] button[title="Collapse"]')).map((b) => b.parentElement.textContent.trim().replace(/\\d+$/, '').trim())`);
    let dd = await dropdown();
    check('a category dropdown sits under the search input, left-aligned and compact', dd && dd.belowInput && dd.leftAligned && dd.height <= 28, JSON.stringify(dd));
    check('opened from the hamburger menu it is preset to "All categories"', dd && dd.value === '' && dd.options[0] === 'All categories');
    const sideCats = await sidebarCategories();
    check('its entries are "All categories" + the sidebar\'s categories (same names, same order)', dd && dd.options.slice(1).join('|') === sideCats.join('|') && sideCats.length >= 1, `${JSON.stringify(dd && dd.options)} vs sidebar ${JSON.stringify(sideCats)}`);
    checkRatio('light', 'empty state', await measure(app, '[data-find-empty]'));
    await app.send('Input.insertText', { text: 'needle-alpha' });
    const got = await app.waitFor(`document.querySelectorAll('[data-result-index]').length === 4`, 15000);
    check('four result rows (one per matching line)', got, `${await rowCount(app)} rows`);
    check('summary reads "4 matches in 3 files"', (await summaryText(app)) === '4 matches in 3 files', await summaryText(app));
    const lines = await app.evaluate(`Array.from(document.querySelectorAll('[data-result-index]')).map((r) => +r.getAttribute('data-result-line')).sort((a, b) => a - b).join(',')`);
    check('the rows point at lines 2, 60, 200 and 3500', lines === '2,60,200,3500', lines);

    // ---- whole-document preview, centered on the matched line ----
    const PITCH = 20;
    const previewState = () => app.evaluate(`(() => {
      const p = document.querySelector('[data-preview-doc]');
      if (!p) return null;
      const h = p.querySelector('[data-preview-highlight]');
      const pr = p.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      const line = +p.getAttribute('data-preview-line');
      const expected = Math.max(0, Math.round((line - 1) * ${PITCH} - p.clientHeight / 2 + ${PITCH} / 2));
      return { line, lines: +p.getAttribute('data-preview-lines'), scrollTop: p.scrollTop, expected, clientHeight: p.clientHeight, scrollHeight: p.scrollHeight,
        highlightCenterOffset: Math.round((hr.top + hr.height / 2) - (pr.top + pr.height / 2)), highlightVisible: hr.top >= pr.top - 1 && hr.bottom <= pr.bottom + 1,
        gutterRows: (p.querySelector('[data-preview-gutter]').textContent.match(/\\n/g) || []).length + 1, textNodes: p.querySelectorAll('*').length,
        matchText: p.querySelector('[data-preview-match-line]').textContent, markText: (p.querySelector('[data-preview-match-line] mark') || {}).textContent };
    })()`);
    const select = async (line) => { const ok = await app.evaluate(`(() => { const r = document.querySelector('[data-result-line="${line}"]'); if (!r) return false; r.click(); return true; })()`); await sleep(250); return ok; };
    check('the line-60 row can be selected', await select(60));
    let pv = await previewState();
    check('the preview shows the WHOLE 80-line document', pv && pv.lines === 80 && pv.gutterRows === 80 && pv.scrollHeight >= 80 * PITCH, JSON.stringify(pv));
    check('the preview is scrolled so line 60 is centered (scrollTop = (line-1)*pitch - height/2 + pitch/2)', pv && Math.abs(pv.scrollTop - pv.expected) <= 2, pv && `scrollTop ${pv.scrollTop}, expected ${pv.expected}, pane ${pv.clientHeight}px`);
    check('the highlight bar is on screen in the middle of the pane, over the matched line', pv && pv.highlightVisible && Math.abs(pv.highlightCenterOffset) <= PITCH && pv.matchText === 'line 60 carries the needle-alpha token' && pv.markText === 'needle-alpha', pv && `center offset ${pv.highlightCenterOffset}px`);
    check('the preview is cheap: a handful of elements, not one per line', pv && pv.textNodes <= 12, pv && `${pv.textNodes} elements`);

    // ---- divider drag + persistence ----
    // The 8px handle straddles the top section's bottom edge (bottom: -4px)
    // and that section clips overflow, so aim 2px above the edge
    // The drag handle is the whole band (preview title strip) at the top of the preview pane
    const handleBox = await app.evaluate(`(() => { const h = document.querySelector('[data-find-split] [title="Drag to resize"]'); if (!h) return null; const r = h.getBoundingClientRect(); const area = h.closest('[data-find-split]').firstElementChild; const top = area.firstElementChild; const x = r.left + r.width / 2; const y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hitIsHandle: h.contains(hit), bandHeight: r.height, topHeight: top.getBoundingClientRect().height, areaHeight: area.getBoundingClientRect().height, topPercent: top.style.height }; })()`);
    check('the band between results and preview exists (default results 45%) and its middle is under the cursor', !!handleBox && handleBox.topPercent === '45%' && handleBox.hitIsHandle && handleBox.bandHeight >= 34, JSON.stringify(handleBox));
    if (handleBox) {
      // Real mouse drag: press on the handle, then move (the divider attaches
      // its document listeners after React commits the press, hence the pauses)
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handleBox.x, y: handleBox.y });
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handleBox.x, y: handleBox.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(150);
      for (let dy = 10; dy <= 60; dy += 10) {
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handleBox.x, y: handleBox.y - dy, button: 'left', buttons: 1 });
        await sleep(30);
      }
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handleBox.x, y: handleBox.y - 60, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(500);
      const after = await app.evaluate(`(() => { const area = document.querySelector('[data-find-split]').firstElementChild; const top = area.firstElementChild; return { topHeight: top.getBoundingClientRect().height, topPercent: top.style.height, saved: localStorage.getItem('findInFilesSplit'), previewHeight: top.nextElementSibling.getBoundingClientRect().height }; })()`);
      check('dragging from the middle of the band really shrinks the results pane and grows the preview', after.topHeight < handleBox.topHeight - 40 && after.previewHeight > handleBox.areaHeight - handleBox.topHeight + 40, JSON.stringify({ before: handleBox.topHeight, after }));
      check('the new split is persisted (findInFilesSplit)', after.saved && Math.abs(parseFloat(after.saved) - parseFloat(after.topPercent)) < 0.01 && parseFloat(after.saved) < 45, after.saved);
      pv = await previewState();
      check('after the resize the matched line is still centered in the (taller) preview', pv && Math.abs(pv.scrollTop - pv.expected) <= 2 && pv.highlightVisible, pv && `scrollTop ${pv.scrollTop}, expected ${pv.expected}`);
    }

    // ---- performance: swapping a 4000-line document in and out ----
    const timedSelect = (line, expectLines) => app.evaluate(`(async () => {
      const r = document.querySelector('[data-result-line="${line}"]');
      if (!r) return null;
      const t0 = performance.now();
      r.click();
      await new Promise((resolve, reject) => {
        const deadline = t0 + 5000;
        const poll = () => {
          const p = document.querySelector('[data-preview-doc]');
          if (p && +p.getAttribute('data-preview-line') === ${line} && +p.getAttribute('data-preview-lines') === ${expectLines}) return requestAnimationFrame(resolve);
          if (performance.now() > deadline) return reject(new Error('preview did not update'));
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
      const t1 = performance.now();
      const p = document.querySelector('[data-preview-doc]');
      const expected = Math.max(0, Math.round((${line} - 1) * ${PITCH} - p.clientHeight / 2 + ${PITCH} / 2));
      return { ms: Math.round((t1 - t0) * 10) / 10, scrollTop: p.scrollTop, expected, elements: p.querySelectorAll('*').length, scrollHeight: p.scrollHeight };
    })()`);
    const MAX_SWAP_MS = 250;
    // Long tasks (> 50 ms on the main thread) during the swaps: the click ->
    // rendered time above includes the deliberate 60 ms preview debounce and
    // the polling's animation frames, so this is the better "is the render
    // itself expensive" signal
    await app.evaluate(`(() => { window.__longTasks = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch (e) { window.__longTasks = null; } })()`);
    const perf = {};
    perf.smallToBig = await timedSelect(3500, BIG_LINES);
    await sleep(150);
    perf.bigToSmall = await timedSelect(2, 3);
    await sleep(150);
    perf.smallToBigAgain = await timedSelect(200, BIG_LINES);
    await sleep(150);
    perf.bigSameDoc = await timedSelect(3500, BIG_LINES);
    for (const [label, m] of Object.entries(perf)) {
      console.log(`INFO  perf ${label}: ${m ? `${m.ms} ms click -> preview rendered + scrolled (${m.elements} elements, scrollHeight ${m.scrollHeight}px)` : 'no measurement'}`);
    }
    const longTasks = await app.evaluate(`window.__longTasks`);
    console.log(`INFO  perf long tasks (> 50 ms) on the main thread during the four swaps: ${longTasks === null ? 'PerformanceObserver(longtask) unavailable' : longTasks.length ? longTasks.join(', ') + ' ms' : 'none'} (click -> rendered includes the 60 ms preview debounce + up to 2 animation frames of polling)`);
    check(`swapping the ${BIG_LINES}-line document into the preview takes < ${MAX_SWAP_MS} ms`, perf.smallToBig && perf.smallToBig.ms < MAX_SWAP_MS, perf.smallToBig && `${perf.smallToBig.ms} ms`);
    // Long tasks of ~100 ms do show up when the machine is busy (the suite runs other jobs); only a clearly
    // expensive render (> 250 ms) fails here, the raw list is printed above for the record
    check('no long task over 250 ms was needed to render the 4000-line preview', longTasks === null || longTasks.every((ms) => ms <= 250), longTasks && longTasks.join(','));
    check('the big preview is centered on line 3500 (whole document rendered)', perf.smallToBig && Math.abs(perf.smallToBig.scrollTop - perf.smallToBig.expected) <= 2 && perf.smallToBig.scrollHeight >= BIG_LINES * PITCH, JSON.stringify(perf.smallToBig));
    check(`swapping back to a small document takes < ${MAX_SWAP_MS} ms`, perf.bigToSmall && perf.bigToSmall.ms < MAX_SWAP_MS, perf.bigToSmall && `${perf.bigToSmall.ms} ms`);
    check(`moving to another line of the ${BIG_LINES}-line document takes < ${MAX_SWAP_MS} ms and re-centers`, perf.bigSameDoc && perf.bigSameDoc.ms < MAX_SWAP_MS && Math.abs(perf.bigSameDoc.scrollTop - perf.bigSameDoc.expected) <= 2, JSON.stringify(perf.bigSameDoc));
    check('the big preview is still a handful of elements', perf.smallToBig && perf.smallToBig.elements <= 12, perf.smallToBig && `${perf.smallToBig.elements} elements`);
    await select(60); // back to the first document for the theme measurements

    // ---- contrast, light then dark ----
    await measureTheme(app, 'light');
    await app.evaluate(`document.documentElement.classList.add('dark')`);
    await sleep(300);
    await measureTheme(app, 'dark');
    await app.evaluate(`document.documentElement.classList.remove('dark')`);
    await sleep(200);

    // ---- Open in New Tab -> the editor jumps to the line ----
    const selected = await app.evaluate(`(() => { const r = document.querySelector('[data-result-line="60"]'); if (!r) return false; r.click(); return true; })()`);
    check('the line-60 row can be selected', selected);
    await sleep(200);
    const opened = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('${WINDOW} button')).find((b) => b.textContent.trim() === 'Open in New Tab'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    check('"Open in New Tab" is enabled and clicked', opened);
    await sleep(1200);
    check('the window closed after opening', !(await windowOpen(app)));
    const state = await app.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return null;
      const value = ta.value;
      const lineStart = value.split('\\n').slice(0, 59).join('\\n').length + 1;
      return { lines: value.split('\\n').length, selectionStart: ta.selectionStart, selectionEnd: ta.selectionEnd, selected: value.slice(ta.selectionStart, ta.selectionEnd), lineStart, scrollTop: ta.scrollTop, clientHeight: ta.clientHeight, scrollHeight: ta.scrollHeight, focused: document.activeElement === ta };
    })()`);
    check('the editor switched to the 80-line document', state && state.lines === 80, JSON.stringify(state));
    check('the matched token on line 60 is selected in the textarea', state && state.selected === 'needle-alpha' && state.selectionStart === state.lineStart + 'line 60 carries the '.length, state && `${state.selectionStart}-${state.selectionEnd} "${state.selected}"`);
    check('the textarea really scrolled to bring line 60 into view', state && state.scrollTop > 0 && state.scrollTop <= state.scrollHeight - state.clientHeight + 1, state && `scrollTop ${state.scrollTop}, clientHeight ${state.clientHeight}, scrollHeight ${state.scrollHeight}`);
    check('the editor body has focus', state && state.focused);

    // ---- dropdown: change re-runs the search; category context menu presets it ----
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 10 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 10 });
    await sleep(400);
    dd = await dropdown();
    check('Ctrl+Shift+F presets "All categories"', dd && dd.value === '');
    await app.send('Input.insertText', { text: 'needle-alpha' });
    await app.waitFor(`document.querySelectorAll('[data-result-index]').length === 4`, 15000);
    const firstCategory = sideCats[0];
    await app.evaluate(`(() => { const s = document.querySelector('[data-find-category]'); s.value = ${JSON.stringify(firstCategory)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(600);
    dd = await dropdown();
    check(`picking "${firstCategory}" in the dropdown re-runs the search on the current query (all three documents live there)`, dd && dd.value === firstCategory && (await summaryText(app)) === '4 matches in 3 files' && (await rowCount(app)) === 4, `${dd && dd.value}: ${await summaryText(app)}`);
    await app.evaluate(`(() => { const s = document.querySelector('[data-find-category]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(600);
    check('back to "All categories" keeps the 4 matches', (await summaryText(app)) === '4 matches in 3 files');
    // React flushes the key's state update after the event, so read the row on the next frame
    const inputStillWorks = await app.evaluate(`(async () => { const i = document.querySelector('input[aria-label="Find in files"]'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))); const row = document.querySelector('[data-result-index="1"]'); return row ? row.getAttribute('aria-selected') : 'no row'; })()`);
    check('keyboard navigation from the input still works with the dropdown present', inputStillWorks === 'true');
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    const viaCategory = await app.evaluate(`(() => {
      const header = Array.from(document.querySelectorAll('[data-document-list] button[title="Expand"], [data-document-list] button[title="Collapse"]')).map((b) => b.parentElement).find((el) => el.textContent.trim().startsWith(${JSON.stringify(firstCategory)}));
      if (!header) return 'no header';
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }));
      return 'ok';
    })()`);
    await sleep(300);
    const clickedItem = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Find in Files'); if (!b) return false; b.click(); return true; })()`);
    await sleep(500);
    dd = await dropdown();
    check(`"Find in Files" from the "${firstCategory}" category's context menu presets the dropdown to it`, viaCategory === 'ok' && clickedItem && dd && dd.value === firstCategory, `${viaCategory}, ${clickedItem}, ${dd && dd.value}`);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);

    // ---- Ctrl+Shift+F opens, Escape closes ----
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 10 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 10 });
    await sleep(400);
    check('Ctrl+Shift+F opens Find in Files', await windowOpen(app));
    const inDocSearch = await app.evaluate(`!!document.querySelector('input[placeholder="Search..."]') && !document.querySelector('${WINDOW}')`);
    check('...and not the editor\'s own Ctrl+F panel', !inDocSearch);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    check('Escape closes it', !(await windowOpen(app)));

    const pageErrors = app.errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await app.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  return failed.length ? 1 : 0;
}

process.exit(await main());
