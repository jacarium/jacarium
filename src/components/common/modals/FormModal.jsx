import { useEffect } from 'react';
import { X } from 'lucide-react';
import BaseModal from './BaseModal';

/**
 * FormModal - Modal with structured form layout
 *
 * Features:
 * - Sticky header with title and close button
 * - Scrollable body area
 * - Sticky footer with actions
 * - Keyboard shortcuts (Ctrl+Enter to submit, Escape to cancel)
 * - Consistent styling with app theme
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {function} onClose - Callback when modal closes
 * @param {string} title - Modal title
 * @param {ReactNode} children - Modal body content
 * @param {ReactNode} footer - Footer content (buttons, etc.)
 * @param {function} onSubmit - Called on Ctrl+Enter (optional)
 * @param {string} size - Modal size: 'sm', 'md', 'lg', 'xl' (default: 'md')
 * @param {boolean} closeOnBackdropClick - Close on backdrop click (default: true)
 * @param {string} footerHint - Text hint in footer (e.g., "Press Ctrl+Enter to save")
 */
export default function FormModal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  onSubmit,
  size = 'md',
  closeOnBackdropClick = true,
  footerHint = null,
}) {
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  // Handle Ctrl+Enter for submit
  useEffect(() => {
    if (!isOpen || !onSubmit) return;

    function handleKeyPress(e) {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        onSubmit();
      }
    }

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [isOpen, onSubmit]);

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdropClick={closeOnBackdropClick}
      className={`${sizeClasses[size]} w-full max-h-[90vh] flex flex-col`}
    >
      {/* Sticky Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between shrink-0">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
          {title}
        </h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
          title="Close (Esc)"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="p-6 space-y-4 bg-os-modal overflow-y-auto flex-1">
        {children}
      </div>

      {/* Sticky Footer */}
      {footer && (
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between shrink-0">
          {footerHint ? (
            <div className="text-xs text-os-text-secondary">
              {footerHint}
            </div>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-3">
            {footer}
          </div>
        </div>
      )}
    </BaseModal>
  );
}
