import { ChevronRight, MessageSquare, Bell, Settings, LogOut } from 'lucide-react';
import { useMobile } from '../../contexts/MobileContext';
import { MORE_PAGES } from './mobilePages';
import { openAppSettings } from '../../utils/openSettings';
import { accountsEnabled, signOutAndReload } from '../../utils/auth';
import { stopCloudSync } from '../../utils/cloudSync';

/**
 * The "More" bottom sheet of the phone layout: the remaining pages, then
 * Team Chat, Notifications, Settings and - with a signed-in account - Sign
 * out. It sits above the bottom bar over a dimmed page; the rows are 56px
 * with 22px icons, as in the mockup, every row drawn from the same data
 * (icon, label, what it does). Team Chat and Notifications toggle the same
 * panels the icon rail does (the window events JQLBuilder listens to).
 */
const ROW = 'rounded-none flex items-center gap-[14px] min-h-14 px-4 text-left text-os-text-primary w-full';

function Row({ icon: Icon, label, testId, onClick, divider = false, current = false, chevron = true }) {
  return (
    <button type="button" role="menuitem" data-testid={testId} aria-current={current ? 'page' : undefined} onClick={onClick} className={`${ROW} ${divider ? 'border-t border-os-border' : ''}`}>
      <Icon size={22} className="text-os-text-secondary shrink-0" />
      <div className="flex-1 text-[15px] font-medium">{label}</div>
      {chevron && <ChevronRight size={16} className="text-os-text-muted shrink-0" />}
    </button>
  );
}

function Heading({ children, first = false }) {
  return <div className={`px-4 pb-1.5 text-[12px] font-semibold tracking-[0.06em] text-os-text-secondary ${first ? '' : 'pt-3 border-t border-os-border mt-1'}`}>{children}</div>;
}

export default function MoreSheet({ currentPage, onPageChange, onSignOut = null }) {
  const { moreOpen, closeMore } = useMobile();
  if (!moreOpen) return null;
  const go = (page) => { closeMore(); onPageChange(page); };
  const emit = (name) => { closeMore(); window.dispatchEvent(new CustomEvent(name)); };
  // (as Settings > General does: the central-server socket closes first)
  const signOut = onSignOut || (() => signOutAndReload({ before: stopCloudSync }));
  const team = [
    { testId: 'mobile-more-chat', label: 'Team Chat', icon: MessageSquare, onClick: () => emit('toggleChatSidebar') },
    { testId: 'mobile-more-notifications', label: 'Notifications', icon: Bell, onClick: () => emit('toggleNotificationSidebar') },
  ];
  const app = [
    { testId: 'mobile-more-settings', label: 'Settings', icon: Settings, onClick: () => { closeMore(); openAppSettings(); } },
    ...(accountsEnabled() ? [{ testId: 'mobile-more-signout', label: 'Sign out', icon: LogOut, onClick: () => { closeMore(); signOut(); }, chevron: false }] : []),
  ];
  return (
    <>
      <button type="button" aria-label="Close menu" data-testid="mobile-more-backdrop" onClick={closeMore} className="sc-mobile-scrim fixed inset-0 z-40 rounded-none" />
      <div role="menu" aria-label="More" data-testid="mobile-more-sheet" className="sc-mobile-sheet fixed left-0 right-0 z-50 bg-os-card border-t border-os-border rounded-t-lg pt-[10px] pb-2 flex flex-col max-h-[70vh] overflow-y-auto">
        <div className="sc-sheet-handle w-9 h-1 rounded-sm bg-os-input-border self-center mb-[10px]" />
        <Heading first>MORE</Heading>
        {MORE_PAGES.map(({ page, label, icon }, i) => (
          <Row key={page} icon={icon} label={label} testId={`mobile-more-${page}`} current={currentPage === page} divider={i > 0} onClick={() => go(page)} />
        ))}
        <Heading>TEAM</Heading>
        {team.map((r, i) => <Row key={r.testId} {...r} divider={i > 0} />)}
        <Heading>APP</Heading>
        {app.map((r, i) => <Row key={r.testId} {...r} divider={i > 0} />)}
      </div>
    </>
  );
}
