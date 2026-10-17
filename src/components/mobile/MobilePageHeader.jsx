import { PanelLeft } from 'lucide-react';
import { useMobile } from '../../contexts/MobileContext';

/**
 * The phone header every page shows (the mockups' 100px bar minus the
 * status bar the browser owns): a 48px sidebar button on the left, the
 * current item's title and subtitle on a sidebar-coloured block with the
 * blue underline, and a 88px slot on the right (the tab bar puts its
 * "N open" menu there). In the dark themes these are the masthead and
 * sidebar surfaces, as in the mockups; in the light theme the bar takes
 * the dark chrome of the bottom bar instead (src/mobile.css, the --mob-
 * chrome-* tokens), so the top and bottom chrome match and the title is
 * never dark on dark - everything that opens from it (the "N open" menu,
 * the drawer, the dropdowns) stays in the page's theme. TabBar renders this
 * on a phone in place of the tab strip; pages without tabs render it
 * themselves.
 */
export default function MobilePageHeader({ title, subtitle, right = null, sidebar = true, testId = 'mobile-page-header' }) {
  const { toggleSidebar } = useMobile();
  return (
    <div data-testid={testId} className="sc-mobile-header h-14 shrink-0 bg-os-masthead border-b border-os-border flex items-stretch">
      {sidebar ? (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Open sidebar"
          data-testid="mobile-open-sidebar"
          className="sc-mobile-header-muted w-12 shrink-0 flex items-center justify-center text-os-text-secondary"
        >
          <PanelLeft size={20} />
        </button>
      ) : (
        <div className="w-3 shrink-0" />
      )}
      <div className="sc-mobile-header-item flex-1 min-w-0 flex flex-col justify-center px-[14px] bg-os-sidebar border-b-2 border-os-blue">
        <div className="sc-mobile-header-title text-[14px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis text-os-text-primary">{title || 'Untitled'}</div>
        {subtitle && subtitle !== title ? <div className="sc-mobile-header-muted text-[12px] text-os-text-secondary whitespace-nowrap overflow-hidden text-ellipsis">{subtitle}</div> : null}
      </div>
      <div className={`${right ? 'w-[88px]' : 'w-3'} shrink-0 flex items-center justify-center`}>
        {right}
      </div>
    </div>
  );
}
