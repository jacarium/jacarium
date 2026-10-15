import { useEffect } from 'react';
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
 * @param {string} className - Additional CSS classes for modal container
 * @param {string} backdropClassName - Additional CSS classes for backdrop
 * @param {number} zIndex - Z-index for modal (default: 50; see tier table above.
 *   Pass DIALOG_Z_INDEX for dialogs that may open from inside an always-on-top
 *   floating widget)
 */
export default function BaseModal({
  isOpen,
  onClose,
  children,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  className = '',
  backdropClassName = '',
  zIndex = 50,
}) {
  // Handle Escape key
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    function handleEscape(e) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, closeOnEscape]);

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

  const modalContent = (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 ${backdropClassName}`}
      style={{ zIndex }}
      onMouseDown={handleBackdropClick}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`bg-os-modal shadow-lg border border-os-border ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
