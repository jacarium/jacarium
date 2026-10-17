import { MoreHorizontal } from 'lucide-react';
import { useMobile } from '../../contexts/MobileContext';
import { MORE_PAGES, PRIMARY_PAGES } from './mobilePages';

/**
 * The bottom navigation of the phone layout: Documents, Workflows, Kanban
 * and Tasks, then "More" for everything else. The active slot is filled
 * with the brand violet; a page reached through "More" (Robin, Tools...)
 * shows its name in the fifth slot, which still opens the sheet - as does
 * a full-screen panel opened from it (`panel`: Team Chat, Notifications)
 * while it is open.
 * Sizes from the mockups: 22px icons, 10px labels, 12px corners, 8px top
 * padding, the home-indicator inset below.
 */
export default function MobileBottomNav({ currentPage, onPageChange, panel = null }) {
  const { toggleMore, moreOpen, closeSidebar, closeMore } = useMobile();
  const morePage = MORE_PAGES.find((p) => p.page === currentPage);
  const moreActive = moreOpen || !!morePage || !!panel;
  const slot = 'flex flex-col items-center justify-center gap-0.5 rounded-sm text-[10px] min-h-[52px]';
  // the five slots are one list: the four pages and "More" (its icon and
  // label are data like the pages', its tap opens the sheet)
  const slots = [...PRIMARY_PAGES.map((p) => ({ ...p, active: currentPage === p.page && !moreOpen && !panel, onClick: () => { closeSidebar(); closeMore(); onPageChange(p.page); }, more: false })),
    { page: 'more', label: panel || (morePage ? morePage.label : 'More'), icon: MoreHorizontal, active: moreActive, onClick: toggleMore, more: true }];
  // (z-50: the bar stays tappable above the More sheet's scrim, so a tap on
  // another tab goes straight there and closes the sheet)
  return (
    <nav
      aria-label="Main"
      data-testid="mobile-bottom-nav"
      className="sc-mobile-nav relative z-50 shrink-0 grid grid-cols-5 gap-1 px-2 pt-2 bg-os-rail border-t border-os-rail-border"
    >
      {slots.map(({ page, label, icon: Icon, active, onClick, more }) => (
        <button
          key={page}
          type="button"
          data-testid={`mobile-nav-${page}`}
          aria-current={!more && active ? 'page' : undefined}
          aria-haspopup={more ? 'menu' : undefined}
          aria-expanded={more ? moreOpen : undefined}
          onClick={onClick}
          className={`${slot} ${active ? 'bg-os-rail-active text-white' : 'text-os-rail-text'}`}
        >
          <Icon size={22} />
          {label}
        </button>
      ))}
    </nav>
  );
}
