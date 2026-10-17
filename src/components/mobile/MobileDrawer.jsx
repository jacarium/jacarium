import { useEffect } from 'react';
import { DrawerScopeContext } from '../../contexts/MobileContext';

/**
 * A panel that is its own destination: on a phone its ResizableSidebar
 * fills the screen (above the bottom bar) while mounted. `onBack` is what
 * its header's back button does there (closing the panel); `label` names
 * it in the bar's fifth slot.
 */
export function ForcedDrawerScope({ children, onBack = null, label = '' }) {
  return <DrawerScopeContext.Provider value={{ forced: true, onBack, label }}>{children}</DrawerScopeContext.Provider>;
}

/**
 * The page's sidebar on a phone: a 324px drawer from the left over a dimmed
 * page (the mockups' sidebar artboards), opened by the header's sidebar
 * button and closed by the scrim, Escape, or a page change. `full` makes it
 * the whole screen (Team Chat, Notifications: panels that are destinations
 * rather than lists). ResizableSidebar renders this on a phone.
 */
export default function MobileDrawer({ children, open, onClose, full = false, label = 'Sidebar' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  // A tap on a list row (a document, a board, a workflow, a chat...) is a
  // pick: the row's own handler has run by the time the event reaches the
  // aside, and the drawer closes to show what was picked - also when it was
  // the item already open. Category headers, fields, the row chevron and
  // anything that opens a menu are not picks.
  const onAsideClick = (e) => {
    if (full || !e.target?.closest) return;
    if (e.target.closest('[data-testid="row-menu-button"], input, textarea, select, [aria-haspopup], [data-drawer-keep]')) return;
    if (e.target.closest('.sc-row, [data-drawer-pick]')) onClose();
  };
  return (
    <div className={`sc-mobile-drawer fixed inset-0 z-40 ${full ? 'sc-mobile-drawer-full' : ''}`} data-testid="mobile-drawer" data-full={full ? 'true' : undefined}>
      {!full && <button type="button" aria-label="Close sidebar" data-testid="mobile-drawer-scrim" onClick={onClose} className="sc-mobile-scrim absolute inset-0 rounded-none" />}
      <aside
        aria-label={label}
        onClick={onAsideClick}
        className={`absolute left-0 top-0 bottom-0 flex flex-col bg-os-sidebar ${full ? 'right-0' : 'w-[324px] max-w-[86vw] border-r border-os-border'}`}
      >
        {children}
      </aside>
    </div>
  );
}
