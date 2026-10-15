import { useState } from 'react';
import { AlertCircle, AlertTriangle, Trash2, CheckCircle } from 'lucide-react';
import { Button, FIELD_CLASS } from '../../ui/primitives';
import BaseModal, { DIALOG_Z_INDEX } from './BaseModal';

/**
 * ConfirmationModal - Simple confirmation dialog
 *
 * Features:
 * - Pre-styled for different types (danger, warning, info, success)
 * - Icon support
 * - Customizable button labels
 * - Enter to confirm, Escape to cancel
 * - Optional typed confirmation: require the user to type an exact phrase
 *   before the confirm button is enabled (for highly destructive actions)
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {function} onConfirm - Callback when user confirms
 * @param {function} onCancel - Callback when user cancels
 * @param {string} title - Dialog title
 * @param {string|ReactNode} message - Dialog message (can be string or JSX)
 * @param {string} type - Type: 'danger', 'warning', 'info', 'success' (default: 'info')
 * @param {string} confirmLabel - Confirm button text (default: "Confirm")
 * @param {string} cancelLabel - Cancel button text (default: "Cancel")
 * @param {boolean} showIcon - Show icon based on type (default: true)
 * @param {string} confirmPhrase - If set, user must type this exact phrase to
 *   enable the confirm button (case-sensitive). Enter only confirms once the
 *   phrase matches. (optional)
 */
export default function ConfirmationModal({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  type = 'info',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  showIcon = true,
  confirmPhrase = null,
}) {
  const [typedPhrase, setTypedPhrase] = useState('');

  const phraseMatches = !confirmPhrase || typedPhrase === confirmPhrase;
  // Type-specific styling
  const typeConfig = {
    danger: {
      icon: Trash2,
      iconColor: 'text-red-600',
      iconBg: 'bg-red-100',
      variant: 'dangerSolid',
    },
    warning: {
      icon: AlertTriangle,
      iconColor: 'text-orange-600',
      iconBg: 'bg-orange-100',
      variant: 'warning',
    },
    info: {
      icon: AlertCircle,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      variant: 'primary',
    },
    success: {
      icon: CheckCircle,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      variant: 'success',
    },
  };

  const config = typeConfig[type] || typeConfig.info;
  const Icon = config.icon;

  // Reset the typed phrase on confirm/cancel so a re-open starts clean
  const handleConfirm = () => {
    if (!phraseMatches) return;
    setTypedPhrase('');
    onConfirm();
  };

  const handleCancel = () => {
    setTypedPhrase('');
    onCancel();
  };

  // Handle Enter key for confirm
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleCancel}
      className="max-w-md w-full rounded-lg"
      // Confirmations can be opened from inside always-on-top floating widgets
      // (e.g. the FloatingQuiz game window at z-index 2147483647). BaseModal
      // portals to document.body, escaping the widget's stacking context, so a
      // default z-50 backdrop would paint BEHIND the widget. DIALOG_Z_INDEX
      // ties the widget tier, and the dialog's later portal mount wins the tie
      // (equal z-index paints in DOM order). See tier table in BaseModal.jsx.
      zIndex={DIALOG_Z_INDEX}
    >
      <div className="p-6" onKeyDown={handleKeyPress}>
        {/* Icon and Title */}
        <div className="flex items-start gap-4 mb-4">
          {showIcon && (
            <div className={`p-3 rounded-full ${config.iconBg} shrink-0`}>
              <Icon size={24} className={config.iconColor} />
            </div>
          )}
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-os-text-primary mb-2">
              {title}
            </h3>
            <div className="text-sm text-os-text-secondary">
              {message}
            </div>

            {/* Typed confirmation input */}
            {confirmPhrase && (
              <div className="mt-3">
                <p className="text-sm text-os-text-primary mb-2">
                  To confirm, type{' '}
                  <code className="bg-red-100 dark:bg-red-900/30 px-2 py-1 rounded-xs text-red-700 dark:text-red-300 font-semibold">
                    {confirmPhrase}
                  </code>{' '}
                  below:
                </p>
                <input
                  type="text"
                  value={typedPhrase}
                  onChange={(e) => setTypedPhrase(e.target.value)}
                  placeholder={`Type: ${confirmPhrase}`}
                  className={`${FIELD_CLASS} focus:border-red-500 focus-visible:ring-red-500/40`}
                  autoFocus
                />
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 mt-6">
          <Button variant="secondary" size="lg" onClick={handleCancel} autoFocus={!confirmPhrase} data-testid="confirm-cancel">{cancelLabel}</Button>
          <Button variant={config.variant} size="lg" onClick={handleConfirm} disabled={!phraseMatches} data-testid="confirm-ok">{confirmLabel}</Button>
        </div>
      </div>
    </BaseModal>
  );
}
