import { useEffect, useRef } from 'react';
import ResizableSidebar from '../ResizableSidebar';

/**
 * The zen side overlay - the one way a sidebar shows in zen mode, on either
 * edge: the page's sidebar from the left tab (ResizableSidebar draws this
 * for every page sidebar) and the "Navigation" list of pages and panels from
 * the right tab (ZenGoTo). A dialog over the page: a backdrop a click on
 * closes it, Esc closes it (caught before the shell's Esc, which leaves
 * zen), the focus moves in when it opens,
 * the panel is a ResizableSidebar in `overlay` mode - resizable from its
 * inner edge, the width remembered under its own key (`<storageKey>.zen`,
 * never the normal column's), instant through the shared panel motion -
 * and a reading area for the reading aids. The overlay is a temporary
 * view: nothing done in it changes the layout after zen (the shell's
 * snapshot restores the panels, the page sidebar's state is never
 * touched).
 *
 * @param {'left'|'right'} side
 * @param {string} label  the dialog's name
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {string} storageKey  the overlay's own width key
 * @param {boolean} [focus=true]  move the focus in on open
 * @param {string} [testId]
 * @param {string} [className]  on the panel (the page sidebar's own classes)
 * @param {(width:number) => ReactNode | ReactNode} children
 */
export default function ZenSideOverlay({ side = 'left', label, open, onClose, storageKey, defaultWidth = 300, minWidth = 200, maxWidth = 640, focus = true, testId, className = '', children }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (onCloseRef.current) onCloseRef.current('escape'); } };
    window.addEventListener('keydown', onKey, true);
    if (focus) {
      const root = ref.current;
      const first = root && root.querySelector('[data-zen-autofocus], input, textarea, [contenteditable="true"], button:not([data-ra-control]), [tabindex="0"]');
      const target = first && typeof first.focus === 'function' ? first : root;   // no focusable child: the dialog itself
      if (target) target.focus();
    }
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, focus]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => onCloseRef.current && onCloseRef.current('outside')} data-testid={`${testId || 'zen-side-overlay'}-backdrop`} />
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        id={testId}
        tabIndex={-1}
        className={`sc-zen-side-overlay sc-slide-in-${side} fixed inset-y-0 ${side === 'right' ? 'right-0' : 'left-0'} z-50 flex shadow-lg bg-os-card`}
        data-testid={testId}
        data-zen-overlay={side}
        data-ra-area
      >
        <ResizableSidebar overlay side={side} storageKey={storageKey} defaultWidth={defaultWidth} minWidth={minWidth} maxWidth={maxWidth} className={`h-full ${className}`} testId={testId ? `${testId}-panel` : undefined}>
          {children}
        </ResizableSidebar>
      </div>
    </>
  );
}
