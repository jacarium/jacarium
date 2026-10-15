import { createContext, useContext, useState, useCallback } from 'react';

const NotificationContext = createContext(null);

export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const [history, setHistory] = useState([]);

  const addNotification = useCallback((notification, legacyType) => {
    // Backward compatibility: several call sites use the positional form
    // addNotification('message', 'type'). Spreading a string into the
    // notification object produced empty entries (no type/title/message),
    // so normalize it into the object shape here.
    if (typeof notification === 'string') {
      const type = legacyType || 'info';
      const defaultTitles = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        alert: 'Notice',
        info: 'Info',
      };
      notification = {
        type,
        title: defaultTitles[type] || 'Notification',
        message: notification,
      };
    }

    const id = Date.now() + Math.random();
    const newNotification = {
      id,
      timestamp: Date.now(),
      ...notification,
    };

    // Add to active notifications
    setNotifications(prev => [...prev, newNotification]);

    // Add to history only for non-confirm types
    // Confirm-type notifications are interactive dialogs that shouldn't clutter the history
    if (notification.type !== 'confirm') {
      setHistory(prev => [newNotification, ...prev].slice(0, 50)); // Keep last 50
    }

    // Auto-dismiss after 4 seconds for non-confirm types
    if (notification.type !== 'confirm') {
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== id));
      }, 4000);
    }

    return id;
  }, []);

  const removeNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const value = {
    notifications,
    history,
    addNotification,
    removeNotification,
    clearHistory,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

// Provider + companion export intentionally share this module (splitting
// would churn every consumer import for a hot-reload-only benefit).
// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return context;
}
