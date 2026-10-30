import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * App-wide z-index tiers (all values compete in the root stacking context,
 * because BaseModal portals to document.body and the floating widgets do too):
 *
 *   0-40            Page chrome: sidebars (10), debug status bar (40), and the
 *                   CompactSidebar nav rail (40 - a flex item whose z-index
 *                   creates a stacking context that traps its flyout tooltips
 *                   and menus; 40 keeps those flyouts above sticky page content
 *                   like z-10 search pills, but below every overlay tier).
 *   50              Standard page modals/overlays (BaseModal default, plus the
 *                   many inline `fixed inset-0 ... z-50` modals across pages).
 *   60-101          Overlays nested inside page modals (lightboxes, dropdowns).
 *   9999            Toasts / passive notification panels (visible above page
 *                   modals; deliberately NOT above dialogs at DIALOG_Z_INDEX).
 *   2147483646/47   "Always on top" floating widgets and their internal layers
 *                   (FloatingQuiz game window, FloatingDraft, AskAIPopup,
 *                   QuickWorkflow, ContextMenu, drag/resize scrims).
 *
 * DIALOG_Z_INDEX: confirmation/alert dialogs (ConfirmationModal) use the max
 * tier so they can never be buried by a floating widget. Two elements with
 * equal z-index in the same stacking context paint in DOM order, and a dialog
 * opened from inside a widget is always portaled to document.body AFTER the
 * widget's own portal mounted - so the dialog reliably paints on top. This is
 * the same mechanism ContextMenu (also 2147483647) already relies on.
 *
 * If you add a new full-screen overlay that can spawn a BaseModal-based
 * dialog, either keep the overlay at z-50 (it will sit below the dialog) or,
 * if it must be "always on top", make sure the dialog it opens uses
 * DIALOG_Z_INDEX - do NOT give the overlay a z-index above DIALOG_Z_INDEX
 * (nothing is above it; 2147483647 is the CSS maximum).
 */
export const DIALOG_Z_INDEX = 2147483647;

/**
 * BaseModal - Foundation modal component
 *
 * Features:
 * - Portal rendering (renders outside parent DOM hierarchy)
 * - Backdrop click handling
 * - Escape key support
 * - Focus trap
 * - Customizable z-index
 * - Smooth animations
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {function} onClose - Callback when modal should close
 * @param {ReactNode} children - Modal content
 * @param {boolean} closeOnBackdropClick - Close when clicking backdrop (default: true)
 * @param {boolean} closeOnEscape - Close on Escape key (default: true)
 * @param {function} onEscape - What Escape does instead of onClose, for a
 *   modal with layers of its own (a menu, a lightbox, an inner dialog,
 *   pending input) that an Escape should close first; the modal decides
 *   and calls onClose itself when nothing is left
 * @param {string} className - Additional CSS classes for modal container
 * @param {string} backdropClassName - Additional CSS classes for backdrop
 * @param {number} zIndex - Z-index for modal (default: 50; see tier table above.
 *   Pass DIALOG_Z_INDEX for dialogs that may open from inside an always-on-top
 *   floating widget)
 * @param {boolean} trapFocus - Keep keyboard focus inside the dialog while it
 *   is open (Tab and Shift+Tab wrap within it), focus the panel when it opens
 *   and give focus back when it closes: to `returnFocusTo`, else to the
 *   element that had focus when it opened. For a dialog stacked over another
 *   one (the Settings dialog's copy sheet); the dialog underneath should mark
 *   itself `inert` meanwhile.
 * @param {Element|function} returnFocusTo - Where focus goes when a trapFocus
 *   dialog closes (an element, or a function returning one): the control that
 *   opened it, as the opener recorded it in its click handler - a dialog that
 *   opens on its own (no click) names the dialog underneath. Read when the
 *   dialog closes, so the latest value counts.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function BaseModal({
  isOpen,
  onClose,
  children,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  onEscape = null,
  className = '',
  backdropClassName = '',
  zIndex = 50,
  trapFocus = false,
  returnFocusTo = null,
}) {
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);
  useEffect(() => { returnFocusRef.current = returnFocusTo; });

  // Focus: into the panel on open (a layout effect: before anything else
  // can move the focus, and while the element that had it is still
  // focused), back out on close - a tick later, when the dialog underneath
  // has dropped its `inert` (focus() on an inert element does nothing). A
  // timer, not an animation frame: frames do not run in a hidden page (a
  // background window, a headless browser), the focus must still return.
  // Nothing is given back while the panel is still in the page holding
  // the focus: development's double-run of the effects would otherwise
  // pull the focus out of the dialog it has just opened.
  useLayoutEffect(() => {
    if (!isOpen || !trapFocus) return undefined;
    const opener = document.activeElement;
    const panel = panelRef.current;
    panel?.focus();
    return () => {
      const named = returnFocusRef.current;
      const target = (typeof named === 'function' ? named() : named) || opener;
      setTimeout(() => {
        if (panel && document.contains(panel) && panel.contains(document.activeElement)) return;
        if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
      }, 0);
    };
  }, [isOpen, trapFocus]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    function handleEscape(e) {
      if (e.key === 'Escape') {
        if (onEscape) onEscape();
        else onClose();
      }
    }

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, onEscape, closeOnEscape]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) {
      onClose();
    }
  };

  // Tab wraps inside the panel while the focus is trapped
  const handleKeyDown = (e) => {
    if (!trapFocus || e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll(FOCUSABLE)).filter((el) => el.getAttribute('aria-hidden') !== 'true');
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const modalContent = (
    <div
      className={`sc-modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center p-4 ${backdropClassName}`}
      style={{ zIndex }}
      onMouseDown={handleBackdropClick}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        tabIndex={trapFocus ? -1 : undefined}
        className={`bg-os-modal shadow-lg border border-os-border ${trapFocus ? 'focus:outline-hidden' : ''} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
