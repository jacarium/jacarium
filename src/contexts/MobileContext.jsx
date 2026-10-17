/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * The phone layout's shared state (src/utils/mobile.js decides when it is
 * on): whether the page's sidebar drawer and the "More" sheet are open.
 * Outside the provider - the desktop app, the standalone windows, tests -
 * useMobile() answers "not mobile" and every action is a no-op, so the
 * components that consult it keep their desktop rendering untouched.
 */
const OFF = Object.freeze({
  isMobile: false,
  sidebarOpen: false,
  openSidebar: () => {},
  closeSidebar: () => {},
  toggleSidebar: () => {},
  moreOpen: false,
  openMore: () => {},
  closeMore: () => {},
  toggleMore: () => {},
});

const MobileContext = createContext(OFF);

/**
 * A sidebar rendered as a drawer takes its open state from the provider;
 * a panel that is its own destination (Team Chat, Notifications opened
 * from "More") is forced open while it is mounted - see ResizableSidebar.
 */
export const DrawerScopeContext = createContext(null);

export function MobileProvider({ children }) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const openSidebar = useCallback(() => { setMoreOpen(false); setSidebarOpen(true); }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => { setMoreOpen(false); setSidebarOpen((open) => !open); }, []);
  const openMore = useCallback(() => { setSidebarOpen(false); setMoreOpen(true); }, []);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const toggleMore = useCallback(() => { setSidebarOpen(false); setMoreOpen((open) => !open); }, []);
  const value = useMemo(() => (isMobile
    ? { isMobile, sidebarOpen, openSidebar, closeSidebar, toggleSidebar, moreOpen, openMore, closeMore, toggleMore }
    : OFF), [isMobile, sidebarOpen, openSidebar, closeSidebar, toggleSidebar, moreOpen, openMore, closeMore, toggleMore]);
  return <MobileContext.Provider value={value}>{children}</MobileContext.Provider>;
}

export function useMobile() {
  return useContext(MobileContext);
}
