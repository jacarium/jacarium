/**
 * The keyboard layout, for labels: bindings match the physical key
 * (KeyboardEvent.code), so the label shows the character that key types
 * on the user's layout - navigator.keyboard.getLayoutMap() in Chromium and
 * Electron (null elsewhere: the US character is shown).
 */
import { useEffect, useState } from 'react';

let cached = null;
let pending = null;

export function getKeyboardLayout() {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const keyboard = typeof navigator !== 'undefined' ? navigator.keyboard : null;
  if (!keyboard || typeof keyboard.getLayoutMap !== 'function') return Promise.resolve(null);
  pending = keyboard.getLayoutMap().then((map) => { cached = map; return map; }).catch(() => null);
  return pending;
}

/** The layout map once it is known (null first, and where the API is missing). */
export function useKeyboardLayout() {
  const [layout, setLayout] = useState(cached);
  useEffect(() => {
    let cancelled = false;
    getKeyboardLayout().then((map) => { if (!cancelled && map) setLayout(map); });
    const onChange = () => { cached = null; pending = null; getKeyboardLayout().then((map) => { if (!cancelled && map) setLayout(map); }); };
    const keyboard = typeof navigator !== 'undefined' ? navigator.keyboard : null;
    keyboard?.addEventListener?.('layoutchange', onChange);
    return () => { cancelled = true; keyboard?.removeEventListener?.('layoutchange', onChange); };
  }, []);
  return layout;
}
