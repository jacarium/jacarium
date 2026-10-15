import { useEffect, useRef } from 'react';
import { AlertCircle, CheckCircle, Info, Cloud } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationContext';

/**
 * NotificationHistoryPanel - Dropdown panel showing notification history
 * Appears when clicking the Bell icon in the masthead
 */
export default function NotificationHistoryPanel({ isOpen, onClose, anchorEl }) {
  const { history, clearHistory } = useNotifications();
  const panelRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target) && !anchorEl?.contains(e.target)) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorEl]);

  if (!isOpen) return null;

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

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div
      ref={panelRef}
      className="fixed top-14 right-4 w-96 max-h-[500px] bg-os-card rounded-2xl shadow-xl z-9999 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-os-border rounded-t-2xl" style={{ backgroundColor: '#151515' }}>
        <h3 className="text-sm font-semibold text-white">Notifications</h3>
        {history.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-muted hover:text-red-400 hover:bg-red-900/30 rounded-sm transition-colors"
            title="Clear all notifications"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Notifications List */}
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="p-3 bg-os-card-secondary rounded-full mb-3">
              <Cloud size={24} className="text-os-text-muted" />
            </div>
            <p className="text-sm text-os-text-secondary">No notifications yet</p>
          </div>
        ) : (
          <div className="divide-y divide-os-border">
            {history.map(notification => (
              <div key={notification.id} className="px-4 py-3 hover:bg-os-card-secondary transition-colors">
                <div className="flex items-start gap-3">
                  <div className={`p-1.5 rounded-full ${getIconBgColor(notification.type)} shrink-0`}>
                    {getIcon(notification.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h4 className="text-xs font-semibold text-os-text-primary">
                        {notification.title}
                      </h4>
                      <span className="text-xs text-os-text-muted whitespace-nowrap">
                        {formatTime(notification.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-os-text-secondary line-clamp-2">
                      {notification.message}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
