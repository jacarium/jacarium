import { MENU_ICONS } from './menuIcons';

/**
 * The icon in front of a menu item's label: 14px, muted, with the menu's
 * gap-2 providing the spacing. A destructive (red) item passes `danger` so
 * the icon inherits the row's red instead of the muted grey; `className`
 * replaces the colour outright (the highlighted sort option, white on blue).
 *
 * Takes either an `action` key of MENU_ICONS (menuIcons.js, the app-wide
 * action -> icon map) or an explicit `icon` component for the few
 * canvas-specific icons that are not shared actions. Decorative: the label
 * carries the meaning.
 */
export function MenuItemIcon({ action, icon, danger = false, className }) {
  const Icon = icon || MENU_ICONS[action];
  if (!Icon) return null;
  const color = className ?? (danger ? '' : 'text-os-text-secondary');
  return <Icon size={14} className={`shrink-0 ${color}`.trim()} aria-hidden="true" />;
}

export default MenuItemIcon;
