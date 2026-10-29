/**
 * The seasonal decoration for the mark, by the user's local date: computed
 * when the component mounts and again when the window regains focus or
 * becomes visible and once an hour (an app left open across midnight
 * changes with the date; no busier timer than that). The override in
 * src/brand/seasonal/active.js (or the localStorage preview knob) wins
 * over the date.
 */
import { useEffect, useState } from 'react';
import { activeDecoration } from './seasonal';
import { ACTIVE_DECORATION, PREVIEW_STORAGE_KEY } from './seasonal/active';

const RECHECK_MS = 60 * 60 * 1000;

function currentOverride() {
  try {
    const preview = typeof localStorage !== 'undefined' ? localStorage.getItem(PREVIEW_STORAGE_KEY) : null;
    if (preview) return preview;
  } catch {
    // storage unavailable (private window, blocked): the constant decides
  }
  return ACTIVE_DECORATION;
}

/** `enabled` false (a mark that never wears a decoration): no listeners, no timer, null. */
export default function useSeasonalDecoration(enabled = true) {
  const [decoration, setDecoration] = useState(() => (enabled ? activeDecoration(new Date(), currentOverride()) : null));
  useEffect(() => {
    if (!enabled) return undefined;
    const recheck = () => setDecoration((prev) => {
      const next = activeDecoration(new Date(), currentOverride());
      return (next && next.id) === (prev && prev.id) ? prev : next;
    });
    recheck();
    const timer = setInterval(recheck, RECHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
  return enabled ? decoration : null;
}
