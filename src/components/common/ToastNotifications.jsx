import { AlertCircle, CheckCircle, Info, Cloud, X } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationContext';

/**
 * ToastNotifications - Toast notifications in upper right corner
 *
 * Types:
 * - confirm: Confirmation with Yes/No buttons
 * - alert: Information with auto-dismiss
 * - error: Error message with auto-dismiss
 * - success: Success message with auto-dismiss
 */
export default function ToastNotifications() {
  const { notifications, removeNotification } = useNotifications();

  const getIcon = (type) => {
    switch (type) {
      case 'error':
        return <AlertCircle size={16} className="text-red-600" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-600" />;
      case 'confirm':
        return <Info size={16} className="text-purple-600" />;
      default:
        return <Cloud size={16} className="text-purple-600" />;
    }
  };

  const getIconBgColor = (type) => {
    switch (type) {
      case 'error':
        return 'bg-red-100';
      case 'success':
        return 'bg-green-100';
      default:
        return 'bg-purple-100';
    }
  };

  const handleConfirm = (notification) => {
    if (notification.onConfirm) {
      notification.onConfirm();
    }
    removeNotification(notification.id);
  };

  // Only show confirm-type notifications as popups (they need user interaction)
  // Confirm notifications don't go to history - they're interactive dialogs
  // Other types (success, error, alert) auto-dismiss and are saved to history
  const confirmNotifications = notifications.filter(n => n.type === 'confirm');

  if (confirmNotifications.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-9999 space-y-2 max-w-md">
      {confirmNotifications.map(notification => (
        <div
          key={notification.id}
          className="bg-os-card rounded-lg shadow-lg overflow-hidden animate-slide-in-right border border-os-border"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-os-border bg-os-card-secondary">
            <h4 className="text-sm font-semibold text-os-text-primary">
              {notification.title}
            </h4>
            <button
              onClick={() => removeNotification(notification.id)}
              className="p-1 hover:bg-os-card rounded-sm transition-colors"
            >
              <X size={14} className="text-os-text-secondary" />
            </button>
          </div>

          {/* Content */}
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className={`p-1.5 rounded-full ${getIconBgColor(notification.type)} shrink-0`}>
                {getIcon(notification.type)}
              </div>
              <div className="flex-1 pt-0.5">
                <p className="text-xs text-os-text-secondary whitespace-pre-line">
                  {notification.message}
                </p>
              </div>
            </div>
          </div>

          {/* Footer - confirm buttons */}
          <div className="flex items-center justify-end gap-2 px-4 py-2.5 bg-os-card-secondary border-t border-os-border">
            <button
              onClick={() => removeNotification(notification.id)}
              className="px-3 py-1.5 text-xs text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-hover transition-colors"
            >
              {notification.cancelLabel || 'Cancel'}
            </button>
            <button
              onClick={() => handleConfirm(notification)}
              className="px-3 py-1.5 text-xs text-white bg-purple-600 rounded-sm hover:bg-purple-700 transition-colors"
            >
              {notification.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
