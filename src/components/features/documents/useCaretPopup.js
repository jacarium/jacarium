/**
 * The shared placement of a popup opened at the caret (the "/" menu, the
 * "Link to document" picker, the "Convert to a permanent link" offer):
 * src/utils/caretPopup.js decides where it goes, and the shared popup hook
 * (src/hooks/usePopupPosition.js - the one every menu and dropdown uses)
 * measures and writes it - on open, whenever the list changes size (the
 * query typed filters it), on window resize and on any scroll (the
 * editor's scroller included), so the popup stays within the window and
 * flips above the caret near the bottom.
 *
 * The popup element is position: fixed; the hook sets its left, top and
 * max-height directly (a layout effect, before paint - no flash of the
 * unplaced popup), so the element's own style prop must not set those.
 * The element is a flex column whose list has min-height 0, so a capped
 * height makes the list scroll inside.
 */
import { usePopupPosition } from '../../../hooks/usePopupPosition.js';
import { CARET_POPUP_GAP, CARET_POPUP_MARGIN } from '../../../utils/caretPopup.js';

/**
 * @param {import('react').RefObject<HTMLElement>} ref  the popup element
 * @param {object} options
 * @param {boolean} options.open  whether the popup is shown
 * @param {() => ({left:number, top:number, bottom:number} | null)} options.caretRect  the caret's viewport rect
 * @param {any[]} [options.deps]  values whose change re-places the popup (the query, the results)
 */
export function useCaretPopupPosition(ref, { open, caretRect, deps = [] }) {
  usePopupPosition(ref, { open, anchor: caretRect, deps, side: 'below', align: 'start', flip: false, gap: CARET_POPUP_GAP, margin: CARET_POPUP_MARGIN, mobile: true, overflow: false });
}
