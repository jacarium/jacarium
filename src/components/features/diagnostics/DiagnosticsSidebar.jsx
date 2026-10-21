import { Activity, Loader, ChevronRight, ChevronDown } from 'lucide-react';
import { EmptyState } from '../../ui';

/**
 * DiagnosticsSidebar - Diagnostics parser tabs sidebar
 *
 * Features:
 * - Backend status indicators (online/offline/checking)
 * - Parser tabs with expand/collapse
 * - Active tab highlighting
 * - Report directory display
 *
 * @param {array} tabs - List of parser tabs
 * @param {array} expandedTabs - List of expanded tab names
 * @param {string} activeTab - Currently active tab name
 * @param {string} activeSubTab - Currently active sub-tab name
 * @param {boolean} loadingTabs - Whether tabs are loading
 * @param {string} backendStatus - Backend status (checking/online/offline)
 * @param {string} directory - Current report directory
 * @param {function} onToggleTab - Callback when toggling tab expansion
 * @param {function} onTabClick - Callback when clicking a tab
 * @param {function} onSubTabClick - Callback when clicking a sub-tab
 * @param {function} onReset - Callback to reset and load different report
 * @param {function} getIconComponent - Function to get icon component from name
 * @param {number} width - Sidebar width (from ResizableSidebar)
 */
export default function DiagnosticsSidebar({
  tabs = [],
  expandedTabs = [],
  activeTab,
  activeSubTab,
  loadingTabs = false,
  backendStatus = 'checking',
  directory = '',
  onToggleTab,
  onTabClick,
  onSubTabClick,
  onReset,
  getIconComponent,
  width = 288,
}) {
  function handleChevronClick(e, tabName) {
    e.stopPropagation();
    onToggleTab?.(tabName);
  }

  return (
    <div className="flex flex-col h-full bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-os-text-secondary shrink-0" />
          {width > 280 ? (
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Diagnostics
            </span>
          ) : width > 220 ? (
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Diags
            </span>
          ) : null}
          {backendStatus === 'checking' && (
            <Loader size={12} className="animate-spin text-os-text-muted shrink-0" />
          )}
          {backendStatus === 'online' && (
            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Backend online" />
          )}
          {backendStatus === 'offline' && (
            <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Backend offline" />
          )}
        </div>
        {tabs.length > 0 && directory && (
          <div className="mt-2">
            <div className="text-xs text-os-text-muted truncate" title={directory}>
              {directory.split('/').pop()}
            </div>
            <button
              onClick={onReset}
              className="mt-1 text-xs text-os-blue hover:underline"
            >
              Load different report
            </button>
          </div>
        )}
      </div>

      {/* Parser Tabs List */}
      <div className="flex-1 overflow-y-auto">
        {tabs.length === 0 ? (
          <EmptyState compact icon={Activity} title="No report loaded" description="Load a report to see parsers" />
        ) : loadingTabs ? (
          <div className="p-8 text-center">
            <Loader size={24} className="text-os-blue mx-auto mb-3 animate-spin" />
            <p className="text-sm text-os-text-secondary">Loading parsers...</p>
          </div>
        ) : (
          <div className="py-2">
            {tabs.map(tab => {
              const isExpanded = expandedTabs.includes(tab.tab_name);
              const isActive = activeTab === tab.tab_name && !activeSubTab;

              return (
                <div key={tab.tab_name}>
                  <div
                    className={`px-4 py-3 transition-colors flex items-center justify-between ${
 isActive ?'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-os-blue':'border-l-4 border-transparent hover:bg-os-card-secondary'
 }`}
                  >
                    <div
                      onClick={() => onTabClick?.(tab)}
                      className="flex items-center gap-2 flex-1 cursor-pointer"
                    >
                      {(() => {
                        const IconComponent = getIconComponent(tab.icon);
                        return <IconComponent size={16} className={isActive ?'text-os-blue':'text-os-text-secondary'} />;
                      })()}
                      <span className={`text-sm ${isActive ?'text-os-blue':'text-os-text-primary'}`}>
                        {tab.label}
                      </span>
                    </div>
                    {tab.has_sub_tabs && (
                      <button
                        onClick={(e) => handleChevronClick(e, tab.tab_name)}
                        className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
                        title={isExpanded ? "Collapse" : "Expand"}
                      >
                        {isExpanded ?
                          <ChevronDown size={14} className="text-os-text-secondary" /> :
                          <ChevronRight size={14} className="text-os-text-secondary" />
                        }
                      </button>
                    )}
                  </div>

                  {tab.has_sub_tabs && isExpanded && (
                    <div>
                      {tab.sub_tabs.map(subTab => {
                        const isSubActive = activeTab === tab.tab_name && activeSubTab === subTab.tab_name;
                        return (
                          <div
                            key={subTab.tab_name}
                            onClick={() => onSubTabClick?.(tab.tab_name, subTab.tab_name)}
                            className={`pl-10 pr-4 py-2.5 cursor-pointer transition-colors flex items-center gap-2 ${
 isSubActive ?'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-os-blue text-os-blue':'border-l-4 border-transparent hover:bg-os-card-secondary text-os-text-primary'
 }`}
                          >
                            {(() => {
                              const IconComponent = getIconComponent(subTab.icon);
                              return <IconComponent size={14} className={isSubActive ?'text-os-blue':'text-os-text-secondary'} />;
                            })()}
                            <span className={`text-sm ${isSubActive ?'text-os-blue':''}`}>{subTab.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
