import { Briefcase, Sparkles, Archive, FileText, Bot, FlaskConical, Users, Boxes, FileCode, MessageSquare, FileStack, Terminal } from 'lucide-react';

/**
 * Available category icons
 * Maps icon names to lucide-react components
 */
export const CATEGORY_ICONS = {
  'cases': { Icon: Briefcase, label: 'Cases' },
  'ai': { Icon: Sparkles, label: 'AI' },
  'archive': { Icon: Archive, label: 'Archive' },
  'general': { Icon: FileText, label: 'General' },
  'robot': { Icon: Bot, label: 'Robot' },
  'lab': { Icon: FlaskConical, label: 'Lab' },
  'meetings': { Icon: Users, label: 'Meetings' },
  'openshift': { Icon: Boxes, label: 'OpenShift' },
  'procedures': { Icon: FileCode, label: 'Procedures' },
  'slack': { Icon: MessageSquare, label: 'Slack' },
  'templates': { Icon: FileStack, label: 'Templates' },
  'console': { Icon: Terminal, label: 'Console' },
};

/**
 * Get icon component by name
 */
export function getCategoryIcon(iconName) {
  if (!iconName) return null;
  return CATEGORY_ICONS[iconName]?.Icon || null;
}

/**
 * Get all available icons as array
 */
export function getAllCategoryIcons() {
  return Object.entries(CATEGORY_ICONS).map(([name, { Icon, label }]) => ({
    name,
    Icon,
    label
  }));
}
