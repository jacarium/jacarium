import { AlertTriangle, Info, CheckCircle } from 'lucide-react';

/**
 * ConfirmationModal - A reusable modal for confirmations and alerts
 *
 * @param {boolean} isOpen - Whether the modal is visible
 * @param {function} onClose - Callback when modal is closed
 * @param {function} onConfirm - Callback when confirmed (optional, for confirmations)
 * @param {string} title - Modal title
 * @param {string} message - Modal message
 * @param {string} type - Modal type: 'confirm', 'alert', 'warning', 'info' (default: 'confirm')
 * @param {string} confirmText - Text for confirm button (default: 'Confirm')
 * @param {string} cancelText - Text for cancel button (default: 'Cancel')
 * @param {boolean} dangerous - Whether this is a dangerous action (red button)
 */
export default function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  type = 'confirm',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  dangerous = false
}) {
  if (!isOpen) return null;

  const getIcon = () => {
    switch (type) {
      case 'warning':
        return <AlertTriangle size={48} className="text-orange-500 mx-auto mb-3" />;
      case 'alert':
      case 'info':
        return <Info size={48} className="text-blue-500 mx-auto mb-3" />;
      case 'success':
        return <CheckCircle size={48} className="text-green-500 mx-auto mb-3" />;
      default:
        return <AlertTriangle size={48} className="text-purple-600 mx-auto mb-3" />;
    }
  };

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm();
    }
    onClose();
  };

  const isAlertOnly = type === 'alert' || type === 'info' || type === 'success';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-os-modal rounded-lg shadow-xl w-96 max-w-[90vw]">
        <div className="p-6">
          <div className="text-center mb-6">
            {getIcon()}
            <h3 className="text-xl font-semibold mb-2 text-os-text-primary">{title}</h3>
            <p className="text-sm text-os-text-secondary whitespace-pre-wrap">{message}</p>
          </div>

          <div className={`flex gap-3 ${isAlertOnly ?'justify-center':''}`}>
            {!isAlertOnly && (
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 bg-os-divider hover:bg-os-border text-os-text-primary rounded-sm transition-colors"
              >
                {cancelText}
              </button>
            )}
            <button
              onClick={handleConfirm}
              className={`flex-1 px-4 py-2 transition-colors ${
 dangerous
 ?'bg-red-600 hover:bg-red-700 text-white'
 : isAlertOnly
 ?'bg-purple-600 hover:bg-purple-700 text-white'
 :'bg-purple-600 hover:bg-purple-700 text-white'
 }`}
            >
              {isAlertOnly ? 'OK' : confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
