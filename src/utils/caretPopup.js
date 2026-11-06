/**
 * Where a popup opened at the caret goes (the Documents editor's "/" menu,
 * the "Link to document" picker and its "Convert to a permanent link"
 * offer): below the caret's line when it fits there, above it when it
 * does not, and when it fits on neither side, on the side with more room
 * with its height capped so its list scrolls inside. Horizontally it is
 * clamped to the viewport, so it never runs off the right edge. Pure: the
 * hook (src/components/features/documents/useCaretPopup.js) measures the
 * caret, the popup and the window, and writes what this returns.
 *
 * Coordinates are viewport pixels (position: fixed).
 */

/** The gap between the caret's line and the popup, and the popup's margin to the viewport's edges. */
export const CARET_POPUP_GAP = 10;
export const CARET_POPUP_MARGIN = 8;

/**
 * @param {object} args
 * @param {{left:number, top:number, bottom:number}} args.caret  the caret's rect (coordsAtPos)
 * @param {{width:number, height:number}} args.popup  the popup's natural size
 * @param {{width:number, height:number}} args.viewport  the window's inner size
 * @param {number} [args.gap]
 * @param {number} [args.margin]
 * @returns {{left:number, top:number, maxHeight:number, placement:'below'|'above'}}
 */
export function placeCaretPopup({ caret, popup, viewport, gap = CARET_POPUP_GAP, margin = CARET_POPUP_MARGIN }) {
  const width = Math.max(0, popup.width || 0);
  const height = Math.max(0, popup.height || 0);
  // a caret scrolled past the window's edge (a resize, a scroll with the popup open) anchors at that edge
  const clampY = (y) => Math.max(margin, Math.min(y, viewport.height - margin));
  caret = { left: caret.left, top: clampY(caret.top), bottom: clampY(caret.bottom) };
  const roomBelow = Math.max(0, viewport.height - caret.bottom - gap - margin);
  const roomAbove = Math.max(0, caret.top - gap - margin);
  let placement;
  if (height <= roomBelow) placement = 'below';
  else if (height <= roomAbove) placement = 'above';
  else placement = roomAbove > roomBelow ? 'above' : 'below';
  const room = placement === 'below' ? roomBelow : roomAbove;
  const maxHeight = Math.max(0, Math.min(height, room));
  const top = placement === 'below' ? caret.bottom + gap : caret.top - gap - maxHeight;
  // never off the right edge; when the viewport is narrower than the popup, the margin on the left wins
  const left = Math.max(margin, Math.min(caret.left, viewport.width - width - margin));
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)), maxHeight: Math.round(maxHeight), placement };
}
