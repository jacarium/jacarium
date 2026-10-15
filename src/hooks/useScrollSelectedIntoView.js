import { useEffect } from 'react';

/**
 * Keep the keyboard-selected row of a scrolling list visible: whenever
 * `selectedIndex` changes, the element matching `[data-index="<index>"]`
 * inside `containerRef` is scrolled into view with `block: 'nearest'`, so a
 * row that is already visible causes no jump (mouse hover that changes the
 * selection never fights the user's own scrolling). A row's `scroll-margin`
 * keeps it clear of sticky headers and footers.
 */
export default function useScrollSelectedIntoView(containerRef, selectedIndex) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const row = container.querySelector(`[data-index="${selectedIndex}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [containerRef, selectedIndex]);
}
