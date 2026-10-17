import { useEffect } from 'react';
import { useMobile } from '../contexts/MobileContext';

/**
 * Closes the phone layout's sidebar drawer whenever `key` changes: a page
 * that switched what it shows (another document, board, workflow opened
 * from the drawer) is what the user wants to see. No-op on the desktop.
 */
export function useCloseDrawerOn(key) {
  const { isMobile, closeSidebar } = useMobile();
  useEffect(() => {
    if (isMobile) closeSidebar();
    // the drawer closes on the change itself, not when the layout flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
