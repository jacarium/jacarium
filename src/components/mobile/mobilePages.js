import { FileText, Workflow, Trello, CheckSquare, Bot, Calendar, Search, Activity, Wrench } from 'lucide-react';

/**
 * The phone layout's pages: the four in the bottom bar, and the ones behind
 * its "More" (the icon rail's remaining entries, in its order) - page id,
 * label and icon. The sheet lists the latter; the bar names the one that
 * is open.
 */
export const PRIMARY_PAGES = [
  { page: 'documents', label: 'Documents', icon: FileText },
  { page: 'workflow', label: 'Workflows', icon: Workflow },
  { page: 'kanban', label: 'Kanban', icon: Trello },
  { page: 'tasks', label: 'Tasks', icon: CheckSquare },
];

export const MORE_PAGES = [
  { page: 'ai-chat', label: 'Robin', icon: Bot },
  { page: 'calendars', label: 'Calendars', icon: Calendar },
  { page: 'search', label: 'JQL Search', icon: Search },
  { page: 'diagnostics', label: 'Diagnostics', icon: Activity },
  { page: 'tools', label: 'Tools', icon: Wrench },
];
