import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The editor toolbar's dropdown menus (Heading, List, Insert, the phone's
 * "More") and the toolbar's keyboard model.
 *
 * ToolbarMenu: a WAI-ARIA menu, portalled to the body so that no scroll
 * strip or overflow-hidden ancestor can clip it (the phone's toolbar is a
 * horizontal scroll strip; an in-place dropdown opened hidden under the
 * editor). It is fixed, placed from its button's rect (left-aligned, kept
 * inside the visual viewport, no taller than the space under the button -
 * it scrolls), re-placed when anything scrolls, the window resizes or the
 * visual viewport changes (the on-screen keyboard), and sits
 * at z-40: above the editor, below the app's z-50 modals. It closes on an
 * outside tap, Escape (focus back on the button) or a choice. Inside:
 * ArrowUp/Down move (wrapping), Home/End jump, Enter/Space choose, a letter
 * jumps to the next item starting with it. Items are role="menuitem", or
 * role="menuitemradio" with aria-checked when the menu reflects a state
 * (the heading level, the list kind) - for assistive technology only: no
 * visible tick, which read as a pending "selected" choice; the button's
 * own label ("H2", the pilcrow) and icon show the state, and the checked
 * row only takes the initial keyboard focus, with the ordinary focus
 * highlight. A `heading` item is a group label.
 *
 * The hooks that go with it (useToolbarMenu: the open state and the button
 * ref; useRovingToolbar: the strip's roving tabindex) live in
 * src/hooks/toolbarMenu.js.
 */

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

export default function ToolbarMenu({ open, onClose, anchorRef, items, label, testId }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: undefined });

  useEffect(() => {
    if (!open) return undefined;
    const doc = window.document;
    const place = () => {
      const button = anchorRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth || 200;
      const vv = window.visualViewport;
      const viewportWidth = vv ? vv.width + vv.offsetLeft : window.innerWidth;
      const viewportBottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
      // the phone's bottom bar (z-50) covers anything under it
      const bottomBar = doc.querySelector('.sc-mobile-nav');
      const limit = bottomBar ? Math.min(viewportBottom, bottomBar.getBoundingClientRect().top) : viewportBottom;
      const top = rect.bottom + 4;
      // never taller than the space under the button (the phone's "More"
      // menu has sixteen rows, the on-screen keyboard shrinks the viewport,
      // the bottom bar overlays it): the menu scrolls instead of running
      // off screen or under the bar
      setPos({ top, left: Math.max(8, Math.min(rect.left, viewportWidth - width - 8)), maxHeight: Math.max(120, limit - top - 8) });
    };
    place();
    // focus the checked item, else the first, once placed
    const focusTimer = setTimeout(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const checked = menu.querySelector('[aria-checked="true"]');
      (checked || menu.querySelector(ITEM_SELECTOR))?.focus({ preventScroll: true });
    }, 0);
    const onPointerDown = (e) => {
      const inside = anchorRef.current?.contains(e.target) || menuRef.current?.contains(e.target);
      if (!inside) onClose();
    };
    window.addEventListener('resize', place);
    doc.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    doc.addEventListener('mousedown', onPointerDown);
    doc.addEventListener('touchstart', onPointerDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('resize', place);
      doc.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      doc.removeEventListener('mousedown', onPointerDown);
      doc.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, anchorRef, onClose]);

  if (!open) return null;

  const itemsOf = () => Array.from(menuRef.current?.querySelectorAll(ITEM_SELECTOR) || []);
  const onKeyDown = (e) => {
    const list = itemsOf();
    const index = list.indexOf(window.document.activeElement);
    const focusAt = (i) => list[(i + list.length) % list.length]?.focus();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchorRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(index + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(index - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); focusAt(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusAt(list.length - 1); return; }
    if (e.key === 'Tab') { onClose(); return; }
    if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = e.key.toLowerCase();
      for (let step = 1; step <= list.length; step++) {
        const candidate = list[(index + step) % list.length];
        if (candidate.textContent.trim().toLowerCase().startsWith(letter)) { e.preventDefault(); candidate.focus(); return; }
      }
    }
  };

  const choose = (item) => {
    onClose();
    if (item.onSelect) item.onSelect();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      data-testid={testId}
      className="sc-toolbar-menu fixed z-40 min-w-48 overflow-y-auto bg-os-card border border-os-border rounded-sm shadow-lg py-1"
      style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        if (item.heading) {
          return <div key={`h-${i}`} role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-os-text-muted">{item.heading}</div>;
        }
        const { Icon } = item;
        const radio = item.kind === 'radio';
        return (
          <button
            key={item.id}
            type="button"
            role={radio ? 'menuitemradio' : 'menuitem'}
            aria-checked={radio ? !!item.checked : undefined}
            tabIndex={-1}
            data-menu-item={item.id}
            onClick={() => choose(item)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-os-text-primary transition-colors hover:bg-os-card-secondary focus:bg-os-card-secondary focus:outline-hidden"
          >
            {Icon ? <Icon size={16} className="shrink-0 text-os-text-secondary" /> : <span className="w-4 shrink-0" />}
            <span className="flex-1 min-w-0 truncate">{item.label}</span>
            {item.shortcut && <span className="text-xs text-os-text-muted shrink-0">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    window.document.body
  );
}
