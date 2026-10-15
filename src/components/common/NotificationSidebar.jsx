import { AlertCircle, CheckCircle, Info, Cloud, Trash2, Bell } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationContext';
import SidebarHeader from './sidebar/SidebarHeader';
import ResizableSidebar from '../ResizableSidebar';

/**
 * NotificationSidebar - Resizable sidebar showing notification history
 * Appears between CompactSidebar and main content sidebar when clicking the Bell icon
 */
export default function NotificationSidebar({ isOpen }) {
  const { history, clearHistory } = useNotifications();

  const getIcon = (type) => {
    switch (type) {
      case 'error':
        return <AlertCircle size={16} className="text-red-600 dark:text-red-200" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-600 dark:text-green-200" />;
      case 'confirm':
        return <Info size={16} className="text-purple-600 dark:text-purple-200" />;
      default:
        return <Cloud size={16} className="text-purple-600 dark:text-purple-200" />;
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

  if (!isOpen) return null;

  return (
    <ResizableSidebar
      defaultWidth={300}
      minWidth={250}
      maxWidth={500}
      storageKey="notification-sidebar-width"
    >
      <div className="flex flex-col h-full bg-os-card border-r border-os-border">
        {/* Header */}
        <SidebarHeader
          title="Notifications"
          icon={Bell}
          actions={
            history.length > 0 && (
              <button
                onClick={clearHistory}
                className="p-1.5 rounded-sm transition-colors hover:bg-os-card-secondary"
              >
                <Trash2 size={16} className="text-red-600" />
              </button>
            )
          }
        />

        {/* Notifications List */}
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="p-3 bg-os-card-secondary rounded-full mb-3">
                <Bell size={24} className="text-os-text-muted" />
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
                      <p className="text-xs text-os-text-secondary whitespace-pre-wrap">
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
    </ResizableSidebar>
  );
}
