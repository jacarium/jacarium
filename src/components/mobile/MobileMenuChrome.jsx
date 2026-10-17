import { useEffect } from 'react';
import { useMobile } from '../../contexts/MobileContext';
import { takeRowMenuAnchor, placeDropdown } from './rowMenuAnchor';

/**
 * On a phone every context menu (the elements the pages' menus tag with
 * .sc-context-menu) becomes a dropdown anchored to the row it was opened
 * from, over a dimmed scrim: 12px from each screen edge, under the row when
 * it fits, above it when it does not, else pinned between the page header
 * and the bottom bar with a max-height and its own scrolling. The row's
 * rectangle comes from the chevron that opened it (RowMenuButton announces
 * it, src/components/mobile/rowMenuAnchor.js); a menu opened another way is
 * placed from its own pointer position. The menus are a dozen components
 * with their own markup and close handlers, so this is done from outside:
 * a MutationObserver sees a menu appear, sets its place as !important
 * inline styles (the menu's own x/y are what React set once; its
 * desktop clamping effects stand aside on a phone), and puts the scrim
 * beside it - in the same stacking context, one z-index below - turning a
 * tap on the scrim into the outside mousedown every menu already closes
 * on. Mounted by the shell on a phone only; renders nothing.
 */
const EDGE = 12;
const GAP = 4;

export default function MobileMenuChrome() {
  const { isMobile } = useMobile();
  useEffect(() => {
    if (!isMobile || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const dressed = new Map();   // menu -> { scrim, anchor, observer, onResize }

    const band = () => {
      const header = document.querySelector('[data-testid="mobile-page-header"]');
      const bar = document.querySelector('[data-testid="mobile-bottom-nav"]');
      return {
        top: header ? header.getBoundingClientRect().bottom : 0,
        bottom: bar ? bar.getBoundingClientRect().top : window.innerHeight,
      };
    };
    const place = (menu, anchor) => {
      const set = (prop, value) => menu.style.setProperty(prop, value, 'important');
      set('left', `${EDGE}px`);
      set('right', 'auto');
      set('width', `${Math.max(0, window.innerWidth - 2 * EDGE)}px`);
      set('max-height', 'none');
      set('overflow-y', 'visible');
      const { top, bottom } = band();
      const spot = placeDropdown({ anchor, height: menu.offsetHeight, top, bottom, gap: GAP });
      set('top', `${Math.round(spot.top)}px`);
      set('bottom', 'auto');
      if (spot.maxHeight != null) { set('max-height', `${Math.floor(spot.maxHeight)}px`); set('overflow-y', 'auto'); }
      menu.setAttribute('data-placement', spot.placement);
    };

    const dress = (menu) => {
      if (dressed.has(menu) || !menu.parentNode) return;
      // the anchor: the row that was tapped, else the pointer the menu was opened at
      const announced = takeRowMenuAnchor();
      const x = parseFloat(menu.style.left) || 0;
      const y = parseFloat(menu.style.top) || 0;
      const anchor = announced || { top: y, bottom: y, left: x, right: x };
      const z = parseInt(getComputedStyle(menu).zIndex, 10);
      const scrim = document.createElement('div');
      scrim.className = 'sc-menu-scrim';
      scrim.setAttribute('data-testid', 'row-menu-scrim');
      if (Number.isFinite(z)) scrim.style.zIndex = String(z - 1);
      // a tap on the scrim is an outside press: the menu closes itself
      scrim.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      });
      scrim.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      menu.parentNode.insertBefore(scrim, menu);
      menu.setAttribute('data-menu-chrome', 'true');
      place(menu, anchor);
      let observer = null;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => place(menu, anchor));
        observer.observe(menu);
      }
      const onResize = () => place(menu, anchor);
      window.addEventListener('resize', onResize);
      dressed.set(menu, { scrim, anchor, observer, onResize });
    };
    const undress = (menu) => {
      const entry = dressed.get(menu);
      if (!entry) return;
      entry.scrim.remove();
      entry.observer?.disconnect();
      window.removeEventListener('resize', entry.onResize);
      dressed.delete(menu);
    };
    const sweep = () => {
      for (const menu of document.querySelectorAll('.sc-context-menu')) dress(menu);
      for (const menu of [...dressed.keys()]) if (!menu.isConnected) undress(menu);
    };
    const mo = new MutationObserver(sweep);
    mo.observe(document.body, { childList: true, subtree: true });
    sweep();
    return () => {
      mo.disconnect();
      for (const menu of [...dressed.keys()]) undress(menu);
    };
  }, [isMobile]);
  return null;
}
