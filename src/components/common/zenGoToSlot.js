import { useSyncExternalStore } from 'react';

/**
 * Where a panel shows inside zen's "Navigation" overlay: ZenGoTo mounts a slot
 * element in its body when a panel is chosen and announces it here with
 * the overlay's width; the panel's ResizableSidebar (zenPanelId) portals
 * its content into that slot, at that width, instead of drawing a column.
 * One place for the hand-off, so the panels know nothing of the overlay.
 */
let slot = { el: null, width: 0 };
const listeners = new Set();

export function setZenGoToSlot(el, width) {
  if (slot.el === el && slot.width === width) return;
  slot = { el, width };
  for (const fn of listeners) fn();
}

export function getZenGoToSlot() { return slot; }

const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The slot, live. */
export function useZenGoToSlot() {
  return useSyncExternalStore(subscribe, getZenGoToSlot, getZenGoToSlot);
}
