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
 * The caret popups' wrapper over the shared placement
 * (src/utils/popupPlacement.js), which every menu and dropdown uses too:
 * a wider gap (the caret's line stays readable), no horizontal flip.
 *
 * Coordinates are viewport pixels (position: fixed).
 */
import { placePopup } from './popupPlacement.js';

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
  return placePopup({ anchor: { left: caret.left, right: caret.left, top: caret.top, bottom: caret.bottom }, popup, viewport, side: 'below', align: 'start', flip: false, gap, margin });
}
