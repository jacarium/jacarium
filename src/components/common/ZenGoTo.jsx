/* eslint-disable react-refresh/only-export-components -- the overlay's event name belongs with it */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, Bot, MessageSquare, StickyNote } from 'lucide-react';
import ZenEdgeTab from './ZenEdgeTab';
import ZenSideOverlay from './ZenSideOverlay';
import { RAIL_PAGES } from '../railPages';
import { useZenPanel } from './ReadingAidsSurface';
import { zenPanel } from '../../utils/readingAids';
import { useShortcutLabel } from '../../shortcuts/useShortcut';
import { useChat } from '../../contexts/ChatContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { setZenGoToSlot } from './zenGoToSlot';

/**
 * Zen mode's "Navigation" overlay: the right-edge tab (and the "Show navigation"
 * shortcut, reading.showPanels) opens a right-hand zen side overlay - the
 * same ZenSideOverlay as the page sidebar on the left - listing, in two
 * groups, the pages (in the rail's order, from src/components/railPages.js;
 * the current one marked with aria-current) and the panels (AI Chat,
 * Quick Notes, Team Chat, Notifications, with the rail's unread dot).
 * Choosing a page switches to it, zen stays, the overlay closes - a real
 * navigation. Choosing a panel shows it inside the overlay: the header
 * becomes the panel's name with a back control to the list; the panel is
 * opened in the shell for the time being (the shell's zen snapshot puts
 * it back when zen ends - the overlay is a temporary view), and
 * ResizableSidebar portals its content into the overlay's slot
 * (zenGoToSlot.js). Esc always gets out (closes the overlay, zen stays);
 * the back control returns to the list. Reopening shows the list, or the
 * panel that was showing when the overlay closed, within the zen session.
 * Keyboard: one list across both groups - arrows (wrapping), Home / End,
 * type-ahead on the names, Enter / Space chooses; the shortcut opens the
 * overlay with the focus on the current page. The overlay's width is its
 * own (zen-go-to.zen), never a panel column's.
 */
export const ZEN_SHOW_PANELS_EVENT = 'zenShowPanels';
export const PANELS = Object.freeze([
  { id: 'aiChat', label: 'AI Chat', event: 'toggleAIChatSidebar', Icon: Bot },
  { id: 'draft', label: 'Quick Notes', event: 'toggleDraftSidebar', Icon: StickyNote },
  { id: 'chat', label: 'Team Chat', event: 'toggleChatSidebar', Icon: MessageSquare },
  { id: 'notification', label: 'Notifications', event: 'toggleNotificationSidebar', Icon: Bell },
]);
const TITLE = 'Navigation';

export default function ZenGoTo({ currentPage, onPageChange }) {
  const [open, setOpen] = useState(false);
  const shown = useZenPanel();   // the panel showing inside the overlay, or null for the list
  const shownPanel = shown ? PANELS.find((p) => p.id === shown) : null;
  const tabRef = useRef(null);
  const listRef = useRef(null);
  const slotRef = useRef(null);
  const widthRef = useRef(0);
  const hint = useShortcutLabel('reading.showPanels');
  const { unreadMentions } = useChat();
  const { history } = useNotifications();
  const badges = { chat: unreadMentions > 0, notification: history.length > 0 };
  const typed = useRef({ text: '', at: 0 });

  // the shortcut toggles the overlay
  useEffect(() => {
    const onShortcut = () => setOpen((o) => !o);
    window.addEventListener(ZEN_SHOW_PANELS_EVENT, onShortcut);
    return () => window.removeEventListener(ZEN_SHOW_PANELS_EVENT, onShortcut);
  }, []);
  // the slot a chosen panel portals into (and its width); gone when the list shows or the overlay closes
  useLayoutEffect(() => {
    setZenGoToSlot(open && shownPanel ? slotRef.current : null, widthRef.current);
    return () => setZenGoToSlot(null, 0);
  });
  // the list opens with the focus on the current page
  useEffect(() => {
    if (!open || shownPanel) return;
    const current = listRef.current && listRef.current.querySelector('[aria-current="page"]');
    if (current) current.focus();
  }, [open, shownPanel]);

  const items = () => (listRef.current ? Array.from(listRef.current.querySelectorAll('[role="menuitem"]')) : []);
  const onListKey = (e) => {
    const all = items();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) typed.current = { text: '', at: 0 };   // a move ends the typed prefix
    if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1].focus(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // type-ahead: the letters typed within a second pick the first name starting with them (after the focused one)
      const now = Date.now();
      const text = (now - typed.current.at < 1000 ? typed.current.text : '') + e.key.toLowerCase();
      typed.current = { text, at: now };
      const from = i < 0 ? 0 : (text.length === 1 ? i + 1 : i);
      const order = all.slice(from).concat(all.slice(0, from));
      const hit = order.find((el) => (el.dataset.name || '').toLowerCase().startsWith(text));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  };
  const choosePage = (page) => {
    setOpen(false);
    if (page !== currentPage && typeof onPageChange === 'function') onPageChange(page);
    if (tabRef.current) tabRef.current.focus();
  };
  const choosePanel = (panel) => {
    // the panel opens in the shell (not toggles) so its content exists, then shows inside the overlay; the shell's
    // zen snapshot undoes the opening when zen ends
    window.dispatchEvent(new CustomEvent(panel.event, { detail: { open: true } }));
    zenPanel.set(panel.id);
  };
  const back = () => zenPanel.set(null);
  const close = (how) => { setOpen(false); if (how === 'escape' && tabRef.current) tabRef.current.focus(); };

  return (
    <div data-testid="zen-panels">
      <ZenEdgeTab side="right" label="Show navigation" chip={TITLE} hint={hint} expanded={open} haspopup="dialog" controls="zen-go-to-overlay" onOpen={() => setOpen((o) => !o)} testId="zen-panels-button" buttonRef={tabRef} />
      <ZenSideOverlay side="right" label={shownPanel ? shownPanel.label : TITLE} open={open} onClose={close} storageKey="zen-go-to.zen" defaultWidth={360} minWidth={280} maxWidth={640} testId="zen-go-to-overlay" focus={!shownPanel}>
        {(width) => {
          widthRef.current = width;
          return (
            <div className="flex flex-col h-full border-l border-os-border" data-testid="zen-go-to">
              <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-os-border">
                {shownPanel && (
                  <button type="button" className="sc-zen-goto-back inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-os-text-secondary hover:bg-os-card-secondary hover:text-os-text-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" onClick={back} data-testid="zen-go-to-back" data-zen-autofocus aria-label={`Back to ${TITLE}`}>
                    <ArrowLeft size={14} aria-hidden="true" />
                    <span>{TITLE}</span>
                  </button>
                )}
                <h2 className="flex-1 min-w-0 truncate text-xs font-text font-semibold text-os-text-primary uppercase tracking-wide" data-testid="zen-go-to-title">{shownPanel ? shownPanel.label : TITLE}</h2>
              </div>
              {shownPanel ? (
                <div ref={slotRef} className="flex-1 min-h-0 flex flex-col" data-testid="zen-go-to-slot" data-zen-panel={shownPanel.id} />
              ) : (
                <div ref={listRef} role="menu" aria-label={TITLE} className="flex-1 min-h-0 overflow-y-auto py-2 ra-reading" onKeyDown={onListKey} data-testid="zen-panels-menu">
                  <div className="sc-zen-goto-heading" role="presentation" id="zen-go-to-pages">Pages</div>
                  {RAIL_PAGES.map((p) => (
                    <button key={p.page} type="button" role="menuitem" tabIndex={-1} className="sc-zen-goto-item" aria-current={p.page === currentPage ? 'page' : undefined} data-name={p.label} onClick={() => choosePage(p.page)} data-testid={`zen-page-${p.page}`}>
                      <p.icon size={16} aria-hidden="true" />
                      <span className="flex-1 min-w-0 truncate">{p.label}</span>
                      {p.page === currentPage && <span className="text-2xs text-os-text-muted" data-testid="zen-go-to-current">current</span>}
                    </button>
                  ))}
                  <div className="sc-zen-goto-heading" role="presentation" id="zen-go-to-panels">Panels</div>
                  {PANELS.map((panel) => (
                    <button key={panel.id} type="button" role="menuitem" tabIndex={-1} className="sc-zen-goto-item" data-name={panel.label} onClick={() => choosePanel(panel)} data-testid={`zen-panel-${panel.id}`}>
                      <panel.Icon size={16} aria-hidden="true" />
                      <span className="flex-1 min-w-0 truncate">{panel.label}</span>
                      {badges[panel.id] && <span className="w-2 h-2 rounded-full bg-(--rail-badge)" aria-label="unread" data-testid="zen-go-to-badge" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </ZenSideOverlay>
    </div>
  );
}
