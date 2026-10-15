/* eslint-disable react-refresh/only-export-components */
/**
 * The sidebar list row every page uses (Documents and Kanban through
 * ItemList, the Workflows list and the template sidebars directly): a
 * full-width square row - hover background, the selected row marked by the
 * left accent bar, never a radius or a per-row border. It is a <div>, so the
 * base rule that rounds every <button> does not reach it; `as` renders
 * another element when needed and `rounded-none` keeps it square anyway.
 */
export function ListRow({ as: Tag = 'div', className = '', children, ...props }) {
  return <Tag className={`sc-row rounded-none ${className}`} {...props}>{children}</Tag>;
}

/** ItemList's default row classes for a row drawn outside ItemList, by state. */
export function listRowClass({ active = false, selected = false, focused = false } = {}) {
  const on = active || selected;
  return `group relative px-4 py-3 cursor-pointer transition-colors border-l-4 ${on ? 'bg-os-blue/10 border-os-blue' : 'border-transparent hover:bg-os-card-secondary'} ${focused ? 'ring-2 ring-os-blue ring-inset' : ''}`;
}
