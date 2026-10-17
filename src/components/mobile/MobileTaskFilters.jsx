import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';

/**
 * The Tasks filters on a phone: a dropdown under the toolbar's filter icon
 * (the desktop has an inline panel of chips there) with a section per
 * filter - STATUS, PROJECT, TAG - of 44px rows that show a check mark when
 * set, and a "Clear filters" row when anything is. The same state as the
 * desktop's panel: status is multi-select, project and tag single-select
 * (tapping the one set clears it). Tagged .sc-context-menu, so
 * MobileMenuChrome places it under the icon (announced by the icon's
 * click), flips it up when there is no room, pins it with its own
 * scrolling for a long project or tag list, and puts the scrim behind it;
 * it closes on the scrim (the outside mousedown), Escape, or the icon.
 */
const STATUSES = ['pending', 'active', 'completed', 'deleted', 'waiting'];

function Row({ label, checked, onClick, testId }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} data-testid={testId} onClick={onClick} className="w-full px-4 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2">
      <span className="flex-1 truncate">{label}</span>
      {checked && <Check size={16} className="text-os-blue shrink-0" />}
    </button>
  );
}
function Head({ children }) {
  return <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] uppercase text-os-text-secondary">{children}</div>;
}

export default function MobileTaskFilters({ statusFilter, setStatusFilter, projectFilter, setProjectFilter, tagFilter, setTagFilter, projects = [], tags = [], onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (e.target?.closest?.('[data-testid="tasks-filter-button"]')) return;   // the icon toggles
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const any = statusFilter.length > 0 || !!projectFilter || !!tagFilter;
  return (
    <div ref={menuRef} role="menu" aria-label="Filters" data-testid="mobile-task-filters" className="sc-context-menu sc-filter-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1 min-w-[180px]" style={{ top: 0, left: 0 }}>
      <Head>Status</Head>
      {STATUSES.map((status) => (
        <Row key={status} label={status} testId={`task-filter-status-${status}`} checked={statusFilter.includes(status)}
          onClick={() => setStatusFilter(statusFilter.includes(status) ? statusFilter.filter((s) => s !== status) : [...statusFilter, status])} />
      ))}
      {projects.length > 0 && (
        <>
          <div className="border-t border-os-border my-1" />
          <Head>Project</Head>
          {projects.map((project) => (
            <Row key={project} label={project} checked={projectFilter === project} onClick={() => setProjectFilter(projectFilter === project ? '' : project)} />
          ))}
        </>
      )}
      {tags.length > 0 && (
        <>
          <div className="border-t border-os-border my-1" />
          <Head>Tag</Head>
          {tags.map((tag) => (
            <Row key={tag} label={tag} checked={tagFilter === tag} onClick={() => setTagFilter(tagFilter === tag ? '' : tag)} />
          ))}
        </>
      )}
      {any && (
        <>
          <div className="border-t border-os-border my-1" />
          <button type="button" role="menuitem" data-testid="task-filter-clear" onClick={() => { setStatusFilter([]); setProjectFilter(''); setTagFilter(''); }} className="w-full px-4 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2">
            <X size={16} className="text-os-text-secondary shrink-0" />Clear filters
          </button>
        </>
      )}
    </div>
  );
}
