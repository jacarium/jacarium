import { useEffect, useRef } from 'react';
import { RULER_LINES, rulerBand } from '../../utils/readingAids';

/**
 * The reading ruler (Settings > Accessibility): one soft, full-width band,
 * a text line tall (or 3 or 5), over a reading area - the Documents editor
 * and Preview, chat messages, report text, anything carrying
 * `.markdown-preview`, `.sc-editor-cm` or `.ra-reading` - snapping to the
 * line under the pointer. Highlight tints the band; Mask dims everything
 * above and below it inside the area.
 *
 * The band is always there while the ruler is on. It follows the pointer
 * over a reading area; when the pointer leaves, it stays where it was.
 * With no pointer yet (the page just opened, the setting just turned on)
 * it sits on the editor's caret line, or on the first visible line of the
 * largest reading area in view. Typing or moving with the keyboard puts it
 * on the caret; in a Preview with keyboard focus, ArrowUp / ArrowDown move
 * it line by line. Scrolling with the pointer away keeps the band at the
 * same screen position (the steadier choice: nothing is re-resolved per
 * scroll frame, so no flicker); with the pointer over the text it stays on
 * the line under the pointer. Focus moving to a dialog or a menu changes
 * nothing; when the area itself goes (another page, zen leaving) the
 * overlay goes with it and comes back on the next reading area shown.
 *
 * One overlay element, positioned from requestAnimationFrame, clipped to
 * the area's visible box (so it stays off the rail, the toolbar and the
 * scrollbars) - no per-line DOM changes, so long documents stay smooth. A
 * childList observer (rAF-throttled) notices a reading area appearing or
 * leaving. The line under the pointer comes from caretRangeFromPoint: the
 * client rect of the text at that point gives the line box; the band is
 * centred on it. Nothing is ever drawn over the first glyph: the band has
 * no edge. The overlay sits below dialogs and menus (z-index 40); inside an
 * open dialog - or any menu, popover or fixed layer above the overlay, found
 * by role or by stacking (stackLayer), whatever its DOM parent - it moves
 * into that layer (just above it; the clip is the layer's own box) and works on
 * the dialog's text and controls alike - the mask dims everything but the
 * band there too, the dialog and the page behind, and the controls under
 * the shade stay usable (it takes no pointer events) - while the page behind
 * stays as it was; when the dialog closes the ruler returns to the page.
 */
export const RULER_AREA_SELECTOR = '.markdown-preview, .sc-editor-cm, .ra-reading, [data-ra-area], iframe[data-ra-frame]';   // a report frame measures its own lines and posts them (DiagnosticsPage)
/** An open modal dialog: the ruler works inside it (its overlay in the dialog's layer) and leaves the page behind as it was. */
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], .sc-modal-backdrop, [data-testid="settings-modal"]';
/** Controls: over one of these inside a page pane the band keeps its last line (a toolbar button, a tab, a field, a menu). */
/** An open menu, listbox or dropdown: above the z-40 overlay like a dialog, so the ruler moves into its layer while the pointer is over it. */
const MENU_SELECTOR = '[role="menu"], [role="listbox"], .sc-menu, .sc-context-menu, .sc-dropdown-panel, .sc-submenu, .sc-toolbar-menu';
/** The layers the band follows into: an open menu, a dialog. */
const LAYER_SELECTOR = `${MENU_SELECTOR}, ${DIALOG_SELECTOR}`;
/** The page chrome outside any reading area: the rail, a toolbar, a tab strip, a header - the band's width there. */
const CHROME_SELECTOR = '.sc-rail, nav, [role="toolbar"], [role="tablist"], header, aside, .sc-status-corner';
/**
 * Rows the band snaps to as a whole: list items, nav and menu items, rail and toolbar buttons, tabs, table rows (a
 * paragraph or a list item of text snaps to its text line instead). Only a row-like item snaps (rowBox): one about
 * one or two text lines tall; a tall item - a profile card, a panel, a tile - gives its text line under the pointer.
 */
const ROW_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], tr, .sc-row, .sc-rail-tab, [role="toolbar"], button, [role="button"], select, input[type="checkbox"], input[type="radio"], input[type="range"]';
/** A container of several items is never one row, whatever else it matches. */
const GROUP_SELECTOR = '[role="radiogroup"], [role="group"], [role="grid"], [role="list"], [role="listbox"], [role="menu"], [role="tablist"]';
/** How tall a row may be to snap to as a whole: 2.5 times its computed line height (a line of text plus padding). */
const ROW_LINES = 2.5;
/** The box of a row-like item (its height within ROW_LINES of its line height), else null: the text line is used. */
function rowBox(row) {
  if (!row || row.matches(GROUP_SELECTOR)) return null;
  const rr = row.getBoundingClientRect();
  const cs = getComputedStyle(row);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 16) * 1.2;
  return rr.height > 0 && rr.height <= lh * ROW_LINES ? { top: rr.top, height: rr.height } : null;
}
/**
 * Editable text is reading text: over a textarea (a tool's input, a node's field, a description, the chat composer)
 * the band follows the visual line under the pointer and the caret's line while typing; over a single-line text
 * input it sits on the input's line box. caretRangeFromPoint does not reach a field's text, so a textarea's line
 * comes from its metrics - the line height, the top padding and border, scrollTop - which also count soft-wrapped
 * lines (each is a visual line); the caret's visual line comes from a mirror of the text up to the caret.
 */
const TEXT_FIELD_SELECTOR = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="password"], input[type="number"]';
function fieldMetrics(ta) {
  const cs = getComputedStyle(ta);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 16) * 1.2;   // 'normal'
  const rect = ta.getBoundingClientRect();
  const contentTop = rect.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
  return { cs, lh, rect, contentTop };
}
/** The band for the visual line of a textarea under viewport y (its own line height, scrolled), or the input's line box. */
function fieldLineAt(field, y) {
  const { lh, rect, contentTop } = fieldMetrics(field);
  if (field.tagName !== 'TEXTAREA') return { top: rect.top, height: rect.height };
  const index = Math.max(0, Math.floor((y - contentTop + field.scrollTop) / lh));
  return { top: contentTop - field.scrollTop + index * lh, height: lh };
}
let mirror = null;
/** The visual line index of a textarea's caret: a hidden mirror of its text up to the caret, wrapped as the textarea wraps. */
function textareaCaretIndex(ta) {
  const { cs, lh } = fieldMetrics(ta);
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none;';
    document.body.appendChild(mirror);
  }
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'lineHeight', 'boxSizing', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']) mirror.style[p] = cs[p];
  mirror.style.width = `${ta.clientWidth + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)}px`;
  mirror.style.paddingTop = '0px'; mirror.style.paddingBottom = '0px';
  if (cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap') mirror.style.whiteSpace = cs.whiteSpace;
  const before = ta.value.slice(0, ta.selectionStart || 0);
  mirror.textContent = before;
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  return Math.max(0, Math.round(marker.offsetTop / lh));
}
/** The band for a text field's caret: its visual line (a textarea), or the input's line box; null when the caret is scrolled out of the field. */
function fieldCaretLine(field) {
  const { lh, rect, contentTop } = fieldMetrics(field);
  if (field.tagName !== 'TEXTAREA') return { top: rect.top, height: rect.height };
  const top = contentTop - field.scrollTop + textareaCaretIndex(field) * lh;
  return { top, height: lh };
}
const openDialog = () => { const all = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).filter((d) => d.getClientRects().length); return all.length ? all[all.length - 1] : null; };
/**
 * The layer under the pointer when no menu or dialog role names one: the nearest fixed ancestor that paints above the
 * ruler's own overlay (z-index over 40) - a modal built without the dialog role, a floating window, a popover - so the
 * band works inside it (the clip its box, the overlay just above it) instead of landing on the page behind.
 */
function stackLayer(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.position !== 'fixed') continue;
    const z = parseInt(cs.zIndex, 10);
    if (Number.isFinite(z) && z > 40 && !n.closest('[data-testid="reading-ruler"], [data-testid="reading-ruler-shade"]')) return n;
  }
  return null;
}
/** The z-index just above a dialog's layer: its nearest positioned ancestor's (the backdrop's) plus one. */
function layerAbove(el) {
  for (let n = el; n; n = n.parentElement) { const z = parseInt(getComputedStyle(n).zIndex, 10); if (Number.isFinite(z)) return z + 1; }
  return 70;
}   // a page pane (JQLBuilder's main canvas, data-ra-area) is an area too: the ruler works on every page

/** An editor line (.cm-line) that is a single visual line: its own box is the line box, exact at any text size. */
function singleLineBox(el, lh) {
  const line = el && el.closest ? el.closest('.cm-line') : null;
  if (!line) return null;
  const r = line.getBoundingClientRect();
  return Number.isFinite(lh) && r.height > 0 && r.height <= lh * 1.5 ? { top: r.top, height: r.height } : null;
}

function lineAt(x, y, area) {
  const doc = area.ownerDocument;
  let node = null; let offset = 0;
  if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
  else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; offset = p.offset; } }
  if (node && node.nodeType === 3 && area.contains(node)) {
    const range = doc.createRange();
    range.setStart(node, Math.min(offset, node.length));
    range.setEnd(node, Math.min(offset, node.length));
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(node.parentElement).lineHeight);
    const single = singleLineBox(node.parentElement, lh);
    if (single && y >= single.top - 2 && y <= single.top + single.height + 2) return single;
    if (rect && rect.height > 0) {
      const height = Number.isFinite(lh) && lh > rect.height ? lh : rect.height;
      const top = rect.top + rect.height / 2 - height / 2;
      // the caret's text must be the line under the pointer: over a blank part of an area (a sidebar below its list)
      // caretRangeFromPoint answers with the nearest text far away, which is not where the reader is looking
      if (y >= top - 2 && y <= top + height + 2) return { top, height };
    }
  }
  // no text at that point (a gap between blocks): a line box of the area's own line height around the pointer
  const lh = parseFloat(getComputedStyle(area).lineHeight);
  const height = Number.isFinite(lh) && lh > 0 ? lh : 24;
  return { top: y - height / 2, height };
}

/**
 * The visible box of a reading area: its own box minus scrollbars, intersected with every scrolling ancestor's - unless
 * the area is fixed (a context menu or popover rendered inside a sidebar's DOM subtree, a dialog): a fixed element
 * escapes its ancestors' overflow, so its box is its own and the band spans the menu, not the sidebar it came from.
 */
function visibleBox(area) {
  let r = area.getBoundingClientRect();
  let box = { left: r.left, top: r.top, right: r.left + area.clientWidth, bottom: r.top + area.clientHeight };
  if (!area.clientWidth || !area.clientHeight) box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  if (getComputedStyle(area).position === 'fixed') return box;
  for (let el = area.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) {
      r = el.getBoundingClientRect();
      box = { left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.left + (el.clientWidth || r.width)), bottom: Math.min(box.bottom, r.top + (el.clientHeight || r.height)) };
    }
    // a fixed element (a dialog rendered inside a sidebar's subtree) escapes the overflow of the ancestors above it
    if (cs.position === 'fixed') break;
  }
  return box;
}

const boxShown = (box) => box.right > box.left && box.bottom > box.top;
/** Whether a reading area is on screen: connected, laid out (not display: none) and with a visible box. */
function areaShown(area) {
  if (!area || !area.isConnected || !area.getClientRects().length) return false;
  return boxShown(visibleBox(area));
}

/**
 * The reading area to start on when none is under the pointer: the largest text area in view (the editor or a
 * Preview over a snippet) when it is a real reading surface - a fifth of the page pane at least; else the page pane
 * (data-ra-area) itself, so a page whose only text areas are snippets (a task title, an empty-state line) starts on
 * its content, not on the snippet.
 */
function largestArea(root = document) {
  let best = null; let bestSize = 0; let pane = null; let paneSize = 0;
  for (const area of root.querySelectorAll(RULER_AREA_SELECTOR)) {
    if (area.closest('[data-testid="reading-ruler"]') || !area.getClientRects().length) continue;
    const box = visibleBox(area);
    if (!boxShown(box)) continue;
    const size = (box.right - box.left) * (box.bottom - box.top);
    if (area.hasAttribute('data-ra-area')) { if (size > paneSize) { pane = area; paneSize = size; } }
    else if (size > bestSize) { best = area; bestSize = size; }
  }
  // a dialog's panel is the fallback alone: a message block inside it always wins
  return best && (!pane || pane.closest(DIALOG_SELECTOR) || bestSize >= paneSize / 5) ? best : pane;
}

export default function ReadingRuler({ lines = 1, mode = 'highlight' }) {
  const clipRef = useRef(null);
  const bandRef = useRef(null);
  const shadeRef = useRef(null);
  const state = useRef({ area: null, line: null, x: 0, y: 0, raf: 0, ensureRaf: 0, frameLine: null });

  useEffect(() => {
    const st = state.current;
    const n = RULER_LINES.includes(lines) ? lines : 1;
    const hide = () => { st.area = null; st.layer = null; st.line = null; st.x = 0; st.y = 0; if (clipRef.current) clipRef.current.hidden = true; if (shadeRef.current) shadeRef.current.hidden = true; };
    const paint = () => {
      st.raf = 0;
      const clip = clipRef.current; const band = bandRef.current;
      if (!clip || !band || !st.area || !st.line || !areaShown(st.area)) { hide(); return; }
      const box = visibleBox(st.area);
      // a report frame's line is in the frame's own coordinates: placed through the frame's box as it is now, so the
      // band stays on the same report line while the page scrolls
      if (st.frameLine && st.area.tagName === 'IFRAME') { const fr = st.area.getBoundingClientRect(); st.line = { top: fr.top + st.area.clientTop + st.frameLine.top, height: st.frameLine.height }; }
      // the band may have scrolled out of the box: it stays (unclamped) so the mask keeps dimming the area; the
      // clip hides a band outside it, the mask's shadow still covers the box
      const b = rulerBand({ lineTop: st.line.top, lineHeight: st.line.height, lines: n });
      if (!b) { hide(); return; }
      clip.hidden = false;
      // inside a dialog the overlay paints in the dialog's layer (just above it)
      const layer = (st.layer && st.layer.isConnected && st.layer.contains(st.area)) ? st.layer : st.area.closest(DIALOG_SELECTOR);
      clip.style.zIndex = layer ? String(layerAbove(layer)) : '';
      clip.style.left = `${box.left}px`; clip.style.top = `${box.top}px`;
      clip.style.width = `${box.right - box.left}px`; clip.style.height = `${box.bottom - box.top}px`;
      band.style.top = `${b.top - box.top}px`; band.style.height = `${b.height}px`;
      // Mask mode: everything is dimmed by default - every reading area, the sidebars, the panels, the chrome, the
      // rail - and only the band is bright: the shade covers the window with a hole the band's size, clipped to the
      // area's visible box (a band scrolled out of it leaves the shade whole) - in a dialog as on the page: the
      // dialog's text and controls and the page behind are dimmed alike, and the controls stay usable under the shade
      const shade = shadeRef.current;
      if (shade) {
        if (mode === 'mask') {
          const hole = { left: box.left, right: box.right, top: Math.max(box.top, b.top), bottom: Math.min(box.bottom, b.top + b.height) };
          const has = hole.right > hole.left && hole.bottom > hole.top;
          const W = window.innerWidth; const H = window.innerHeight;
          shade.style.clipPath = has
            ? `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${hole.left}px ${hole.top}px, ${hole.right}px ${hole.top}px, ${hole.right}px ${hole.bottom}px, ${hole.left}px ${hole.bottom}px, ${hole.left}px ${hole.top}px)`
            : 'none';
          shade.dataset.hole = has ? [hole.left, hole.top, hole.right, hole.bottom].map((v) => Math.round(v)).join(',') : '';
          shade.style.zIndex = clip.style.zIndex;
          shade.hidden = false;
        } else {
          shade.hidden = true;
        }
      }
    };
    const schedule = () => { if (!st.raf) st.raf = requestAnimationFrame(paint); };
    // the editor's caret (typing, the keyboard): the DOM selection inside a focused .sc-editor-cm; true when it placed the band
    const caretBand = () => {
      const active = document.activeElement;
      // a text field with the focus (a textarea, a text input) inside a reading area: the caret's visual line
      if (active && active.matches && active.matches(TEXT_FIELD_SELECTOR)) {
        const fieldArea = active.closest(RULER_AREA_SELECTOR);
        if (!fieldArea || fieldArea.tagName === 'IFRAME') return false;
        const dialog = openDialog();
        if (dialog && !dialog.contains(active)) return false;
        st.area = fieldArea; st.x = 0; st.y = 0; st.frameLine = null; st.line = fieldCaretLine(active);
        schedule();
        return true;
      }
      const area = active && active.closest ? active.closest('.sc-editor-cm') : null;
      if (!area) return false;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      let rect = range.getClientRects()[0] || range.getBoundingClientRect();
      if (!rect || !rect.height) { const line = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement; const lr = line && line.closest('.cm-line'); if (lr) rect = lr.getBoundingClientRect(); }
      if (!rect || !rect.height) return false;
      const lineEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
      const lh = lineEl ? parseFloat(getComputedStyle(lineEl).lineHeight) : NaN;
      const single = singleLineBox(lineEl, lh);
      const height = Number.isFinite(lh) && lh > rect.height ? lh : rect.height;
      st.area = area; st.x = 0; st.y = 0; st.frameLine = null; st.line = single || { top: rect.top + rect.height / 2 - height / 2, height };
      schedule();
      return true;
    };
    // a report frame's line (DiagnosticsPage validates the message and raises this event): the frame is the area
    const onFrameLine = (e) => {
      const d = e.detail; if (!d || !d.frame || !d.frame.isConnected) return;
      st.area = d.frame; st.x = 0; st.y = 0; st.frameLine = { top: d.top, height: d.height }; st.line = { top: 0, height: d.height };
      schedule();
    };
    // no band yet, or its area gone: the caret's line, else the first visible line of the largest reading area in view
    const ensure = () => {
      st.ensureRaf = 0;
      // an open dialog takes the band (its largest reading area, first line); the page's area returns when it closes
      const dialog = openDialog();
      if (dialog && !(st.area && dialog.contains(st.area))) {
        const area = largestArea(dialog);
        if (area) { const box = visibleBox(area); st.area = area; st.x = 0; st.y = 0; st.line = lineAt((box.left + box.right) / 2, box.top + 8, area); schedule(); return; }
      }
      if (st.area && areaShown(st.area)) { schedule(); return; }
      if (caretBand()) return;
      const area = largestArea();
      if (!area) { hide(); return; }
      const box = visibleBox(area);
      st.area = area; st.x = 0; st.y = 0; st.frameLine = null; st.line = lineAt((box.left + box.right) / 2, box.top + 8, area);   // a frame: its top until the frame posts its first line
      schedule();
    };
    const scheduleEnsure = () => { if (!st.ensureRaf) st.ensureRaf = requestAnimationFrame(ensure); };
    // The band follows the pointer everywhere in the window: the content, the sidebars, the panels, the rail, the
    // toolbars, the tabs, open menus, a dialog's nav and body, fields and buttons. The area under the pointer (the
    // band's width and the clip): an open menu or dialog layer when the pointer is over one (the overlay paints in
    // that layer), else the nearest reading area, else the rail / a toolbar / the page, else the window itself.
    // Snapping: a row-like item - a list item, nav item, menu item, rail button, toolbar row or table row, about one
    // or two text lines tall - takes its row box; a taller item (a profile card, a panel, a tile) and plain text take
    // the text line under the pointer (a textarea its visual line, a text input its box); non-text content (a chart,
    // an image, empty space) gets a line-height band centred on the pointer. Off the window the band stays put.
    const follow = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el || !el.closest || el.closest('[data-testid="reading-ruler"], [data-testid="reading-ruler-shade"]')) { st.x = 0; st.y = 0; return; }
      const layer = el.closest(LAYER_SELECTOR) || stackLayer(el);   // a menu or dialog by role, else by stacking
      // with a dialog open the page behind stays as it was: only the dialog (and a menu or another layer above it, one
      // neither inside the dialog nor holding it) is followed
      const dialog = openDialog();
      if (dialog && !dialog.contains(el) && !(layer && layer !== dialog && !dialog.contains(layer) && !layer.contains(dialog))) { st.x = 0; st.y = 0; return; }
      let area = el.closest(RULER_AREA_SELECTOR);
      if (layer && (!area || !layer.contains(area))) area = layer;   // a menu or dialog: its own box, unless the pointer is in a reading area inside it
      if (!area) area = el.closest(CHROME_SELECTOR) || document.body;
      if (area.tagName === 'IFRAME') { st.x = 0; st.y = 0; return; }   // a report frame measures its own lines (the pointer over it never reaches us anyway)
      const row = el.closest('[role="toolbar"], .sc-editor-toolbar') || el.closest(ROW_SELECTOR);   // a toolbar snaps as one row
      const field = el.closest(TEXT_FIELD_SELECTOR);
      let line;
      if (field && area.contains(field)) line = fieldLineAt(field, y);
      else if (row && area.contains(row) && row !== area) line = rowBox(row) || lineAt(x, y, area);
      else line = lineAt(x, y, area);
      st.area = area; st.layer = layer; st.x = x; st.y = y; st.frameLine = null; st.line = line;
      schedule();
    };
    const onMove = (e) => { if (e.pointerType === 'touch') return; follow(e.clientX, e.clientY); };
    const onSelection = () => { caretBand(); };
    // ArrowUp / ArrowDown move the band a line at a time when a reading area (not an editor or a field) has the focus
    const onKey = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const active = document.activeElement;
      if (!active || !active.closest || active.closest('input, textarea, select, [contenteditable="true"], .sc-editor-cm')) return;
      const area = active.closest(RULER_AREA_SELECTOR);
      if (!area) return;
      const box = visibleBox(area);
      if (!st.line || st.area !== area) { st.area = area; st.line = lineAt((box.left + box.right) / 2, box.top + 8, area); }
      const next = st.line.top + (e.key === 'ArrowDown' ? st.line.height : -st.line.height) + st.line.height / 2;
      const probe = lineAt((box.left + box.right) / 2, Math.min(box.bottom - 1, Math.max(box.top + 1, next)), area);
      st.line = probe;
      // keep the band in view: scroll the area when the band would leave its box
      if (probe.top < box.top + probe.height) area.scrollTop -= probe.height * 2;
      else if (probe.top + probe.height > box.bottom - probe.height) area.scrollTop += probe.height * 2;
      e.preventDefault();
      requestAnimationFrame(() => { st.line = lineAt((box.left + box.right) / 2, Math.min(box.bottom - 1, Math.max(box.top + 1, probe.top + probe.height / 2)), area); schedule(); });
    };
    // scrolling: under the pointer the band stays on the line under it; with the pointer away it keeps its screen position
    const onScroll = () => {
      if (!st.area) return;
      if (st.x || st.y) { follow(st.x, st.y); return; }
      // a scrolled text field with the focus: the caret's line moved with its text
      const active = document.activeElement;
      if (active && active.matches && active.matches(TEXT_FIELD_SELECTOR) && caretBand()) return;
      schedule();
    };
    const onInput = (e) => { if (e.target && e.target.matches && e.target.matches(TEXT_FIELD_SELECTOR)) caretBand(); };
    const observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('diagnosticsFrameRuler', onFrameLine);
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('input', onInput);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', scheduleEnsure);
    scheduleEnsure();
    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('diagnosticsFrameRuler', onFrameLine);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('input', onInput);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', scheduleEnsure);
      // the pending frames go, and their ids with them: the next effect run (a mode change, React's development
      // double mount) schedules afresh
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.ensureRaf) cancelAnimationFrame(st.ensureRaf);
      st.raf = 0; st.ensureRaf = 0;
    };
  }, [lines, mode]);

  return (
    <>
      <div ref={clipRef} hidden className="ra-ruler-clip" data-testid="reading-ruler" data-mode={mode} data-lines={lines} aria-hidden="true">
        <div ref={bandRef} className="ra-ruler-band" data-testid="reading-ruler-band" />
      </div>
      {/* Mask mode: the whole window dimmed (pointer-transparent), with a hole the size of the band - the one bright line */}
      <div ref={shadeRef} hidden className="ra-ruler-shade" data-testid="reading-ruler-shade" aria-hidden="true" />
    </>
  );
}
