import { X, AlertCircle, CheckCircle, Info, Cloud } from 'lucide-react';

/**
 * CloudModal - Reusable modal for cloud operations
 *
 * Types:
 * - confirm: Confirmation with Yes/No buttons
 * - alert: Information with OK button
 * - error: Error message with OK button
 * - success: Success message with OK button
 */
export default function CloudModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  type = 'alert', // 'confirm', 'alert', 'error', 'success'
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
}) {
  if (!isOpen) return null;

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm();
    }
    onClose();
  };

  const getIcon = () => {
    switch (type) {
      case 'error':
        return <AlertCircle size={24} className="text-red-600" />;
      case 'success':
        return <CheckCircle size={24} className="text-green-600" />;
      case 'confirm':
        return <Info size={24} className="text-purple-600" />;
      default:
        return <Cloud size={24} className="text-purple-600" />;
    }
  };

  const getIconBgColor = () => {
    switch (type) {
      case 'error':
        return 'bg-red-100';
      case 'success':
        return 'bg-green-100';
      default:
        return 'bg-purple-100';
    }
  };

  return (
    <div className="fixed inset-0 z-9999 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-os-modal rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-os-border">
          <h3 className="text-lg font-semibold text-os-text-primary">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={18} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-full ${getIconBgColor()} shrink-0`}>
              {getIcon()}
            </div>
            <div className="flex-1 pt-1">
              <p className="text-sm text-os-text-primary whitespace-pre-line">
                {message}
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-os-card-secondary border-t border-os-border">
          {type === 'confirm' ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-os-text-primary bg-os-modal border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
              >
                {cancelLabel}
              </button>
              <button
                onClick={handleConfirm}
                className="px-4 py-2 text-sm text-white bg-purple-600 rounded-sm hover:bg-purple-700 transition-colors"
              >
                {confirmLabel}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-white bg-purple-600 rounded-sm hover:bg-purple-700 transition-colors"
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
