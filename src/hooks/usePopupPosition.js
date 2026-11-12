/**
 * The shared placement of a popup anchored to something - every context
 * menu (ContextMenu), the dropdown menus (HamburgerMenu), the rail's ...
 * menu, the tab bar's overflow panel, the workflow canvas' menus, the
 * caret popups - so that it stays inside the window: below / beside the
 * anchor when it fits, flipped above / to the other side when it does
 * not, and when it fits nowhere, clamped inside the window with its height
 * capped so it scrolls inside. src/utils/popupPlacement.js decides where
 * it goes; this hook measures and writes it - on open, after the popup
 * rendered (a layout effect, before paint - no first paint off-screen),
 * whenever it changes size (a spelling suggestion list arriving, a query
 * filtering a list: ResizeObserver), on window resize / zoom and on any
 * scroll (the editor's scroller included).
 *
 * The popup element is position: fixed; the hook sets its left, top and
 * max-height directly, and overflow-y: auto while the height is capped, so
 * the element's own style prop must not set those (an initial left / top in
 * the style prop is fine: the hook overwrites it). A capped menu keeps its
 * keyboard navigation: focus() scrolls the focused item into view.
 *
 * On a phone (src/utils/mobile.js) the hook stands aside unless asked
 * (`mobile: true`): MobileMenuChrome places every context menu there as a
 * dropdown under its row, over a scrim.
 */
import { useLayoutEffect } from 'react';
import { placePopup } from '../utils/popupPlacement.js';
import { isMobileLayout } from '../utils/mobile.js';

/**
 * @param {import('react').RefObject<HTMLElement>} ref  the popup element
 * @param {object} options
 * @param {boolean} options.open  whether the popup is shown
 * @param {() => ({left:number, top:number, right?:number, bottom?:number} | null)} options.anchor  the anchor's viewport rect (a point: left/top alone), read at each placement
 * @param {any[]} [options.deps]  values whose change re-places the popup (the pointer position, the query, the results)
 * @param {'below'|'right'} [options.side]
 * @param {'start'|'end'} [options.align]
 * @param {boolean} [options.flip]
 * @param {number} [options.gap]
 * @param {number} [options.margin]
 * @param {boolean} [options.mobile=false]  place on a phone too (the caret popups; the menus leave it to MobileMenuChrome)
 * @param {number} [options.cap]  a height the popup never exceeds, room or not (a list that should stay compact)
 * @param {'fixed'|'absolute'} [options.mode='fixed']  'absolute': the element is position: absolute under its
 *   positioned parent (a dropdown written as top-full / bottom-full) - `anchor` is unused, the parent's rect is the
 *   anchor, and the hook flips it above by writing top / bottom instead of coordinates, keeps it off the window's
 *   right edge with left / right, and caps its height the same way
 * @param {boolean} [options.overflow=true]  scroll the element itself while its height is capped; false when a list
 *   inside it scrolls (a flex column with a min-h-0 list: the caret popups)
 */
export function usePopupPosition(ref, { open, anchor, deps = [], side, align, flip, gap, margin, mobile = false, cap, mode = 'fixed', overflow = true }) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    if (!mobile && isMobileLayout()) return undefined;
    let frame = 0;
    let last = '';
    const place = () => {
      frame = 0;
      const node = ref.current;
      if (!node) return;
      const parent = mode === 'absolute' ? node.offsetParent : null;
      const at = mode === 'absolute' ? (parent ? parent.getBoundingClientRect() : null) : anchor();
      if (!at) return;
      // the natural size: for a popup that scrolls itself, its content height (scrollHeight plus the borders) without
      // touching its styles - resetting the cap to measure would resize the box twice per pass, which under a
      // transition (Reduce motion's 0s one included) fed the ResizeObserver forever; a popup whose list scrolls inside
      // (overflow: false) is measured uncapped, since its box says nothing about the list
      // the natural width: a fixed popup first painted near the window's right edge (a submenu at its row's right)
      // is squeezed to its minimum by the room left of it, and a placement from that squeezed width would end up
      // short - a flipped submenu over its row; measured from the window's left edge instead, where nothing squeezes
      // it (a layout effect: nothing paints in between), then put where it belongs
      if (mode !== 'absolute') { node.style.left = '0px'; node.style.right = 'auto'; }
      let rect = node.getBoundingClientRect();
      let natural = rect.height;
      if (overflow) {
        natural = Math.max(rect.height, node.scrollHeight + (node.offsetHeight - node.clientHeight));
      } else {
        node.style.maxHeight = '';
        rect = node.getBoundingClientRect();
        natural = rect.height;
      }
      const height = cap != null ? Math.min(natural, cap) : natural;
      const placed = placePopup({
        anchor: at,
        popup: { width: rect.width, height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side, align, flip, gap, margin,
      });
      const capped = placed.maxHeight < Math.floor(natural);
      const key = `${placed.left}:${placed.top}:${placed.maxHeight}:${placed.placement}:${capped}`;
      if (mode === 'absolute') {
        // written as offsets from the parent: below it or above it, at its left or ending at the window's margin
        const g = gap != null ? gap : 4;
        const above = placed.placement === 'above';
        node.style.top = above ? 'auto' : '100%';
        node.style.bottom = above ? '100%' : 'auto';
        node.style.marginTop = above ? '0px' : `${g}px`;
        node.style.marginBottom = above ? `${g}px` : '0px';
        node.style.left = `${Math.round(placed.left - at.left)}px`;
        node.style.right = 'auto';
      } else {
        node.style.left = `${placed.left}px`;
        node.style.top = `${placed.top}px`;
        node.style.right = 'auto';
        node.style.bottom = 'auto';
      }
      // the cap only when it bites: a max-height equal to the natural height would pin the box, and content added
      // later (the spelling suggestions) would overflow it unseen instead of resizing it
      node.style.maxHeight = capped ? `${placed.maxHeight}px` : '';
      if (capped && overflow) node.style.overflowY = 'auto';
      if (key !== last) { last = key; node.dataset.placement = placed.placement; }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // the popup's size (the window's too, through resize) and its content: items joining or leaving re-place it
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (observer) observer.observe(el);
    const content = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    if (content) content.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (observer) observer.disconnect();
      if (content) content.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref, side, align, flip, gap, margin, mobile, cap, mode, overflow, ...deps]);
}
