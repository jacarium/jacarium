/**
 * The shared placement of a popup opened at the caret (the "/" menu, the
 * "Link to document" picker, the "Convert to a permanent link" offer):
 * src/utils/caretPopup.js decides where it goes, this hook measures and
 * writes it - on open, whenever the list changes size (the query typed
 * filters it), on window resize and on any scroll (the editor's scroller
 * included), so the popup stays within the window and flips above the
 * caret near the bottom.
 *
 * The popup element is position: fixed; the hook sets its left, top and
 * max-height directly (a layout effect, before paint - no flash of the
 * unplaced popup), so the element's own style prop must not set those.
 * The element is a flex column whose list has min-height 0, so a capped
 * height makes the list scroll inside.
 */
import { useLayoutEffect } from 'react';
import { placeCaretPopup } from '../../../utils/caretPopup.js';

/**
 * @param {import('react').RefObject<HTMLElement>} ref  the popup element
 * @param {object} options
 * @param {boolean} options.open  whether the popup is shown
 * @param {() => ({left:number, top:number, bottom:number} | null)} options.caretRect  the caret's viewport rect
 * @param {any[]} [options.deps]  values whose change re-places the popup (the query, the results)
 */
export function useCaretPopupPosition(ref, { open, caretRect, deps = [] }) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    let frame = 0;
    let last = '';
    const place = () => {
      frame = 0;
      const node = ref.current;
      if (!node) return;
      const caret = caretRect();
      if (!caret) return;
      // the natural size first (the cap of the previous placement would hide it)
      node.style.maxHeight = '';
      const rect = node.getBoundingClientRect();
      const placed = placeCaretPopup({
        caret,
        popup: { width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      const key = `${placed.left}:${placed.top}:${placed.maxHeight}:${placed.placement}`;
      node.style.left = `${placed.left}px`;
      node.style.top = `${placed.top}px`;
      node.style.maxHeight = `${placed.maxHeight}px`;
      if (key !== last) { last = key; node.dataset.placement = placed.placement; }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (observer) observer.observe(el);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (observer) observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref, ...deps]);
}
