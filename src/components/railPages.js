import { Activity, Bot, Calendar, CheckSquare, FileText, Search, Trello, Workflow, Wrench } from 'lucide-react';

/**
 * The app's pages in the rail's order - the one source for the rail
 * (CompactSidebar), its "More" menu when the window is short, and zen
 * mode's "Navigation" overlay (ZenGoTo). A new page added here appears in all
 * of them. `page` is the id JQLBuilder's currentPage / onPageChange use.
 */
export const RAIL_PAGES = Object.freeze([
  { icon: FileText, label: 'Documents', page: 'documents' },
  { icon: Calendar, label: 'Calendars', page: 'calendars' },
  { icon: Bot, label: 'Robin', page: 'ai-chat' },
  { icon: Trello, label: 'Kanban', page: 'kanban' },
  { icon: CheckSquare, label: 'Tasks', page: 'tasks' },
  { icon: Workflow, label: 'Workflow Builder', page: 'workflow' },
  { icon: Activity, label: 'Diagnostics', page: 'diagnostics' },
  { icon: Search, label: 'JQL Search', page: 'search' },
  { icon: Wrench, label: 'Tools', page: 'tools' },
]);
