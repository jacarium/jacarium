import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The hooks of the editor toolbar (src/components/features/documents/
 * ToolbarMenu.jsx renders the menus):
 *   - useToolbarMenu: the open state and the anchor (the button's ref object,
 *     named `anchor`: a property called ref / *Ref makes the React Compiler
 *     treat every read of the object as a ref read) a ToolbarMenu needs;
 *   - useRovingToolbar: the WAI-ARIA toolbar pattern for the strip - one tab
 *     stop (the current button has tabindex 0, the others -1), ArrowLeft /
 *     ArrowRight move between the enabled buttons (wrapping), Home / End
 *     jump to the ends.
 */

export function useToolbarMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, setOpen, toggle, close, anchor };
}

/**
 * The toolbar's roving tabindex: returns the props to spread on the toolbar
 * element (`attach` goes on the element's ref: a state setter, so the React
 * Compiler sees no ref read during render; the handlers find the strip
 * through e.currentTarget).
 * `deps` re-syncs the tab stops when the strip's buttons change.
 */
export function useRovingToolbar(deps = []) {
  const [node, setNode] = useState(null);
  useEffect(() => {
    if (!node) return;
    const buttons = buttonsOf(node);
    if (!buttons.length) return;
    const current = buttons.find((b) => b.tabIndex === 0) || buttons[0];
    buttons.forEach((b) => { b.tabIndex = b === current ? 0 : -1; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, ...deps]);
  const onKeyDown = (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const buttons = buttonsOf(e.currentTarget);
    const index = buttons.indexOf(window.document.activeElement);
    if (index < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
    buttons[next].focus();
  };
  const onFocus = (e) => {
    const buttons = buttonsOf(e.currentTarget);
    if (!buttons.includes(e.target)) return;
    buttons.forEach((b) => { b.tabIndex = b === e.target ? 0 : -1; });
  };
  return { attach: setNode, onKeyDown, onFocus };
}

/** The strip's own enabled buttons (a portalled menu's are not descendants). */
function buttonsOf(toolbar) {
  return Array.from(toolbar?.querySelectorAll('button:not([disabled])') || []);
}
