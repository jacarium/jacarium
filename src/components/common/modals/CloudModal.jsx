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
        return <AlertCircle size={24} className="text-(--chart-bad)" />;
      case 'success':
        return <CheckCircle size={24} className="text-(--chart-good)" />;
      case 'confirm':
        return <Info size={24} className="text-(--brand-accent)" />;
      default:
        return <Cloud size={24} className="text-(--brand-accent)" />;
    }
  };

  const getIconBgColor = () => {
    switch (type) {
      case 'error':
        return 'bg-(--status-danger-bg)';
      case 'success':
        return 'bg-(--status-success-bg)';
      default:
        return 'bg-(--status-brand-bg)';
    }
  };

  return (
    <div className="sc-modal-backdrop fixed inset-0 bg-black/50 z-9999 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Modal: a dialog like every modal (the backdrop above closes on a click beside the panel) */}
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Cloud'} className="sc-modal-panel relative bg-os-modal rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
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
                className="btn btn-brand px-4 py-2 text-sm"
              >
                {confirmLabel}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="btn btn-brand px-4 py-2 text-sm"
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
