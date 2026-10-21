import { useEffect } from 'react';

/**
 * A plain mouse wheel scrolls a horizontal tab strip sideways, as browsers
 * and editors do: wheel down / back -> right, up / forward -> left. Attached
 * to the strip element as a non-passive listener so the page does not scroll
 * as well:
 *   - only while the strip overflows horizontally - otherwise nothing is
 *     intercepted;
 *   - only for a vertical wheel (|deltaY| > |deltaX|): a trackpad's
 *     horizontal swipe and Shift+wheel are the browser's own horizontal
 *     scroll and are left to it; Ctrl+wheel (zoom) too;
 *   - deltaMode lines / pages are scaled to pixels; the scroll is a plain
 *     scrollLeft change, no animation.
 * Returns the detach function.
 */
export function attachWheelScroll(el) {
  if (!el) return () => {};
  const onWheel = (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (el.scrollWidth <= el.clientWidth + 1) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY * scale));
    e.preventDefault();
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => el.removeEventListener('wheel', onWheel);
}

/**
 * Hook form for a strip rendered through `ref`; `deps` re-attaches when the
 * strip mounts later (the desktop strip appears only off the phone layout).
 */
export default function useWheelScrollsStrip(ref, deps = []) {
  useEffect(() => attachWheelScroll(ref.current), deps); // eslint-disable-line react-hooks/exhaustive-deps
}
