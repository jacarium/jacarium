import { useState, useEffect, useLayoutEffect, useRef, Suspense } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import useSyncedOpenTabs from '../hooks/useSyncedOpenTabs';
import ResizableSidebar from './ResizableSidebar';
import { useMobile } from '../contexts/MobileContext';
import TabBar from './features/documents/TabBar';
import { useCloseDrawerOn } from '../hooks/useCloseDrawerOn';
import ToolsSidebar from './features/tools/ToolsSidebar';
import ToolsTabBar from './features/tools/ToolsTabBar';
import { Wrench, Copy, Loader2 } from 'lucide-react';
import { getTools, getToolCategories } from '../utils/tools';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

/**
 * ToolsPage - Main tools page component
 *
 * Layout:
 * - Header at top
 * - Resizable sidebar with categorized tools list
 * - Tab system for open tools
 * - Tool content area
 */
export default function ToolsPage() {
  const [tools, setTools] = useState([]);
  const [categories, setCategories] = useState([]);
  const [openToolTabs, setOpenToolTabs] = useLocalStorage('toolsOpenTabs', []);
  const [activeToolTab, setActiveToolTab] = useLocalStorage('activeToolTab', null);
  // the tool tabs follow the account's devices (once the tool list is loaded)
  useSyncedOpenTabs({
    page: 'tools', tabs: openToolTabs, setTabs: setOpenToolTabs, enabled: tools.length > 0,
    itemOf: (id) => id,
    titleOf: (id) => tools.find((t) => t.id === id)?.name || id,
    resolve: async (item) => (tools.some((t) => t.id === item) ? item : null),
    onClose: (id) => handleCloseTool(id),
    onOpen: (id) => handleSwitchTab(id),
    active: activeToolTab ?? null,
  });
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedToolCategories', []);
  const [loading, setLoading] = useState(false);
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);
  // The phone layout: the tool list is a drawer that closes once a tool is picked
  const { isMobile } = useMobile();
  useCloseDrawerOn(activeToolTab);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, [setInnerSidebarVisible]);

  // Tab context menu state
  const [showTabContextMenu, setShowTabContextMenu] = useState(false);
  const [tabContextMenuPosition, setTabContextMenuPosition] = useState({ x: 0, y: 0 });
  const [tabContextMenuTarget, setTabContextMenuTarget] = useState(null);
  const tabContextMenuRef = useRef(null);

  // Load tools on mount
  useEffect(() => {
    async function loadTools() {
      setLoading(true);
      try {
        const allTools = await getTools();
        const allCategories = await getToolCategories();
        setTools(allTools);
        setCategories(allCategories);

        // If no active tab but we have open tabs, activate the first one
        if (!activeToolTab && openToolTabs.length > 0) {
          setActiveToolTab(openToolTabs[0]);
        }
      } catch (error) {
        console.error('[ToolsPage] Error loading tools:', error);
      } finally {
        setLoading(false);
      }
    }

    loadTools();
    // Intentional mount-only load; activeToolTab/openToolTabs are read as
    // startup snapshots to adopt the first persisted tab once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open a tool in a new tab
  const handleSelectTool = (toolId) => {
    // If already open, just switch to it
    if (openToolTabs.includes(toolId)) {
      setActiveToolTab(toolId);
      return;
    }

    // Add to open tabs and make it active
    setOpenToolTabs(prev => [...prev, toolId]);
    setActiveToolTab(toolId);
  };

  // Close a tool tab
  const handleCloseTool = (toolId) => {
    const newTabs = openToolTabs.filter(id => id !== toolId);
    setOpenToolTabs(newTabs);

    // If closing active tab, switch to another tab
    if (activeToolTab === toolId) {
      if (newTabs.length > 0) {
        const closedIndex = openToolTabs.indexOf(toolId);
        const newActiveIndex = closedIndex > 0 ? closedIndex - 1 : 0;
        setActiveToolTab(newTabs[newActiveIndex]);
      } else {
        setActiveToolTab(null);
      }
    }
  };

  // Switch active tab
  const handleSwitchTab = (toolId) => {
    setActiveToolTab(toolId);
  };

  // Toggle category expansion
  const handleToggleCategory = (categoryName) => {
    setExpandedCategories(prev => {
      if (prev.includes(categoryName)) {
        return prev.filter(name => name !== categoryName);
      } else {
        return [...prev, categoryName];
      }
    });
  };

  // Handle tab context menu
  const handleTabContextMenu = (e, toolId) => {
    e.preventDefault();
    e.stopPropagation();

    setTabContextMenuTarget(toolId);
    setTabContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowTabContextMenu(true);
  };

  // Reposition the tab context menu after render using its real measured size
  useLayoutEffect(() => {
    if (!showTabContextMenu || !tabContextMenuRef.current) return;
    const menuRect = tabContextMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let { x, y } = tabContextMenuPosition;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== tabContextMenuPosition.x || y !== tabContextMenuPosition.y) {
      setTabContextMenuPosition({ x, y });
    }
  }, [showTabContextMenu, tabContextMenuPosition]);

  // Close tabs to the left
  const handleCloseTabsToLeft = (toolId) => {
    const tabIndex = openToolTabs.findIndex(id => id === toolId);
    if (tabIndex > 0) {
      const newTabs = openToolTabs.slice(tabIndex);
      setOpenToolTabs(newTabs);
    }
    setShowTabContextMenu(false);
  };

  // Close tabs to the right
  const handleCloseTabsToRight = (toolId) => {
    const tabIndex = openToolTabs.findIndex(id => id === toolId);
    if (tabIndex < openToolTabs.length - 1) {
      const newTabs = openToolTabs.slice(0, tabIndex + 1);
      setOpenToolTabs(newTabs);
    }
    setShowTabContextMenu(false);
  };

  // Close other tabs
  const handleCloseOtherTabs = (toolId) => {
    setOpenToolTabs([toolId]);
    setShowTabContextMenu(false);
  };

  // Close all tabs
  const handleCloseAllTabs = () => {
    setOpenToolTabs([]);
    setActiveToolTab(null);
    setShowTabContextMenu(false);
  };

  // Copy tool name
  const handleCopyToolName = () => {
    const tool = tools.find(t => t.id === tabContextMenuTarget);
    if (tool) {
      navigator.clipboard.writeText(tool.name);
    }
    setShowTabContextMenu(false);
  };

  // Close tab context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(event.target)) {
        setShowTabContextMenu(false);
        setTabContextMenuTarget(null);
      }
    }

    if (showTabContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTabContextMenu]);

  // Get tool component dynamically
  const getToolComponent = (toolId) => {
    const tool = tools.find(t => t.id === toolId);
    if (!tool) return null;

    // Dynamically import the tool component
    const ToolComponent = tool.component;
    return <ToolComponent key={toolId} />;
  };

  return (
    <div className="flex h-full bg-os-background">
      {/* Resizable Sidebar */}
      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={280}
          minWidth={200}
          maxWidth={500}
          storageKey="tools-sidebar-width"
          position="right"
        >
          <ToolsSidebar
            tools={tools}
            categories={categories}
            activeTool={activeToolTab}
            openTabs={openToolTabs}
            expandedCategories={expandedCategories}
            onSelectTool={handleSelectTool}
            onToggleCategory={handleToggleCategory}
            loading={loading}
          />
        </ResizableSidebar>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab Bar (on a phone: the shared TabBar, which there is the page
            header naming the open tool with the "N open" menu - the open
            tools listed, the active one marked, each closable - as on the
            Documents page; the desktop keeps its own ToolsTabBar) */}
        {isMobile && (
          <TabBar
            tabs={openToolTabs.map((id) => { const tool = tools.find((t) => t.id === id); return { id, title: tool?.name || id, category: tool?.category || '' }; })}
            activeTabId={activeToolTab}
            onTabClick={(tab) => handleSwitchTab(tab.id)}
            onTabClose={handleCloseTool}
            pageTitle="Tools"
          />
        )}
        {openToolTabs.length > 0 && !isMobile && (
          <ToolsTabBar
            tools={tools}
            openTabs={openToolTabs}
            activeTab={activeToolTab}
            onTabClick={handleSwitchTab}
            onTabClose={handleCloseTool}
            onTabContextMenu={handleTabContextMenu}
            onCloseAll={handleCloseAllTabs}
          />
        )}

        {/* Tool Content */}
        {activeToolTab ? (
          <div className="flex-1 overflow-auto">
            {/* Tool components are React.lazy (see utils/tools.js), so their
                chunks load on first open; reuse the app's Loader2 spinner
                convention while a tool's chunk is being fetched/parsed. */}
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="animate-spin text-os-text-secondary" size={24} />
                </div>
              }
            >
              {getToolComponent(activeToolTab)}
            </Suspense>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-os-background">
            <div className="text-center">
              <Wrench size={64} className="text-os-text-muted mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-os-text-primary mb-2">
                No Tool Selected
              </h2>
              <p className="text-sm text-os-text-secondary">
                Select a tool from the sidebar to get started
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Tab Context Menu */}
      {showTabContextMenu && (
        <div
          ref={tabContextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5"
          style={{ left: `${tabContextMenuPosition.x}px`, top: `${tabContextMenuPosition.y}px` }}
        >
          {/* Copy Name */}
          <button
            onClick={handleCopyToolName}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="copyText" />
            Copy Name
          </button>

          <div className="border-t border-os-border my-1"></div>

          {/* Close This Tab */}
          <button
            onClick={() => {
              handleCloseTool(tabContextMenuTarget);
              setShowTabContextMenu(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="closeTab" />
            Close This Tab
          </button>

          {/* Close Tabs to Left */}
          <button
            onClick={() => handleCloseTabsToLeft(tabContextMenuTarget)}
            disabled={openToolTabs.findIndex(id => id === tabContextMenuTarget) === 0}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Tabs to Left
          </button>

          {/* Close Tabs to Right */}
          <button
            onClick={() => handleCloseTabsToRight(tabContextMenuTarget)}
            disabled={openToolTabs.findIndex(id => id === tabContextMenuTarget) === openToolTabs.length - 1}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Tabs to Right
          </button>

          {/* Close Other Tabs */}
          <button
            onClick={() => handleCloseOtherTabs(tabContextMenuTarget)}
            disabled={openToolTabs.length === 1}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Other Tabs
          </button>

          {/* Close All Tabs */}
          <button
            onClick={handleCloseAllTabs}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="closeTab" />
            Close All Tabs
          </button>
        </div>
      )}
    </div>
  );
}
