/**
 * Where a popup anchored to something goes - a context menu at the pointer,
 * a dropdown under its button, the rail's ... menu beside its button, a
 * popup at the caret - so that it stays inside the window:
 *
 *  - below the anchor when it fits there, else above it (the flip), and
 *    when it fits on neither side, on the side with more room with its
 *    height capped (the menu scrolls inside); the caller re-measures after
 *    the menu renders and whenever it changes size, so the answer follows
 *    the real height (the suggestions count, the font, the text size);
 *  - horizontally from the anchor's left (align 'start') or ending at its
 *    right (align 'end'); near the right edge a start-aligned popup flips
 *    to end at the anchor (`flip`), or is clamped inside the margin;
 *  - side 'right' (a menu beside a vertical rail): to the right of the
 *    anchor, flipped to its left when there is no room, its top at the
 *    anchor's and moved up as far as the window needs, height capped.
 *
 * Pure; coordinates are viewport pixels (position: fixed). The hook
 * (src/hooks/usePopupPosition.js) measures and writes what this returns.
 * src/utils/caretPopup.js is the caret popups' wrapper over it.
 */

/** The popup's margin to the viewport's edges, and the gap between a pointer / a button and its menu. */
export const POPUP_MARGIN = 8;
export const POPUP_GAP = 2;

/**
 * @param {object} args
 * @param {{left:number, top:number, right?:number, bottom?:number}} args.anchor  the pointer (left/top alone: a point) or the element's rect
 * @param {{width:number, height:number}} args.popup  the popup's natural size
 * @param {{width:number, height:number}} args.viewport  the window's inner size
 * @param {'below'|'right'} [args.side='below']  where the popup opens first
 * @param {'start'|'end'} [args.align='start']  side 'below': the popup's left at the anchor's left, or its right at the anchor's right
 * @param {boolean} [args.flip=true]  side 'below': flip to the other alignment near the window's edge before clamping
 * @param {number} [args.gap]  between the anchor and the popup
 * @param {number} [args.margin]  to the window's edges
 * @returns {{left:number, top:number, maxHeight:number, placement:'below'|'above'|'right'|'left'}}
 */
export function placePopup({ anchor, popup, viewport, side = 'below', align = 'start', flip = true, gap = POPUP_GAP, margin = POPUP_MARGIN }) {
  const width = Math.max(0, popup.width || 0);
  const height = Math.max(0, popup.height || 0);
  const a = {
    left: anchor.left,
    right: anchor.right != null ? anchor.right : anchor.left,
    top: anchor.top,
    bottom: anchor.bottom != null ? anchor.bottom : anchor.top,
  };
  const clampX = (x) => Math.max(margin, Math.min(x, viewport.width - width - margin));
  if (side === 'right') {
    let placement = 'right';
    let left = a.right + gap;
    if (left + width > viewport.width - margin && a.left - gap - width >= margin) { placement = 'left'; left = a.left - gap - width; }
    left = clampX(left);
    const maxHeight = Math.max(0, Math.min(height, viewport.height - 2 * margin));
    const top = Math.max(margin, Math.min(a.top, viewport.height - margin - maxHeight));
    return { left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxHeight), placement };
  }
  // an anchor scrolled past the window's edge (a resize, a scroll with the popup open) anchors at that edge
  const clampY = (y) => Math.max(margin, Math.min(y, viewport.height - margin));
  const top0 = clampY(a.top);
  const bottom0 = clampY(a.bottom);
  const roomBelow = Math.max(0, viewport.height - bottom0 - gap - margin);
  const roomAbove = Math.max(0, top0 - gap - margin);
  let placement;
  if (height <= roomBelow) placement = 'below';
  else if (height <= roomAbove) placement = 'above';
  else placement = roomAbove > roomBelow ? 'above' : 'below';
  const room = placement === 'below' ? roomBelow : roomAbove;
  const maxHeight = Math.max(0, Math.min(height, room));
  const top = placement === 'below' ? bottom0 + gap : top0 - gap - maxHeight;
  let left = align === 'end' ? a.right - width : a.left;
  if (flip) {
    if (align === 'start' && left + width > viewport.width - margin && a.right - width >= margin) left = a.right - width;
    else if (align === 'end' && left < margin && a.left + width <= viewport.width - margin) left = a.left;
  }
  left = clampX(left);
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)), maxHeight: Math.round(maxHeight), placement };
}
