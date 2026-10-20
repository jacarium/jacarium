import { useShortcut } from './useShortcut';

/**
 * The "Open <page>" shortcuts (page.* in src/shortcuts/registry.js), all
 * unassigned until the user binds one in Settings > Shortcuts. In the
 * desktop app the application menu owns them (its accelerators fire the
 * Pages items, which send navigate-to-page) and the dispatcher skips
 * them; in a browser these registrations switch the page. Mounted once by
 * the shell (JQLBuilder.jsx) with its page setter.
 */
export default function PageShortcuts({ onNavigate }) {
  useShortcut('page.documents', () => onNavigate('documents'));
  useShortcut('page.calendars', () => onNavigate('calendars'));
  useShortcut('page.kanban', () => onNavigate('kanban'));
  useShortcut('page.tasks', () => onNavigate('tasks'));
  useShortcut('page.workflow', () => onNavigate('workflow'));
  useShortcut('page.diagnostics', () => onNavigate('diagnostics'));
  useShortcut('page.search', () => onNavigate('search'));
  useShortcut('page.tools', () => onNavigate('tools'));
  return null;
}
