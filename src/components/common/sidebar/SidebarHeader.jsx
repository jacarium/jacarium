import { Menu, Plus, Loader } from 'lucide-react';

/**
 * SidebarHeader - Header for sidebar sections
 *
 * Features:
 * - Title with optional icon
 * - Action buttons (hamburger menu, add button)
 * - Customizable actions
 * - Status indicator (online/offline/checking)
 * - Consistent styling
 *
 * @param {string} title - Section title
 * @param {ReactNode} icon - Optional icon before title
 * @param {function} onMenuClick - Hamburger menu click handler (optional)
 * @param {function} onAddClick - Add button click handler (optional)
 * @param {ReactNode} actions - Custom action buttons (optional)
 * @param {string} status - Optional status indicator ('checking', 'online', 'offline')
 * @param {string} statusTitle - Optional tooltip for status indicator
 * @param {string} className - Additional CSS classes
 */
export default function SidebarHeader({
  title,
  icon: Icon,
  onMenuClick,
  onAddClick,
  actions,
  status,
  statusTitle,
  className = '',
}) {
  return (
    <div className={`flex items-center justify-between p-4 border-b border-os-border bg-os-card ${className}`}>
      {/* Title */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {Icon && <Icon size={16} className="text-os-text-secondary shrink-0" />}
        <h2 className="text-xs font-text font-semibold text-os-text-primary uppercase tracking-wide truncate">
          {title}
        </h2>
        {status === 'checking' && (
          <Loader size={12} className="animate-spin text-os-text-muted shrink-0" title={statusTitle || 'Checking...'} />
        )}
        {status === 'online' && (
          <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" title={statusTitle || 'Online'} />
        )}
        {status === 'offline' && (
          <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" title={statusTitle || 'Offline'} />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {actions}

        {onAddClick && (
          <button
            onClick={onAddClick}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Add new"
          >
            <Plus size={16} className="text-os-text-secondary" />
          </button>
        )}

        {onMenuClick && (
          <button
            onClick={onMenuClick}
            aria-label="Menu"
            title="Menu"
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <Menu size={16} className="text-os-text-secondary" />
          </button>
        )}
      </div>
    </div>
  );
}
