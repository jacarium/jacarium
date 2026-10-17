/**
 * Mobile detection for the browser build.
 *
 * The phone layout (src/components/mobile/) switches on by itself when the
 * app is opened in a browser on a phone: a bottom navigation bar instead
 * of the icon rail, the page's sidebar as a drawer, the open tabs as a
 * header. It never touches the desktop app or a laptop browser:
 *   - never inside Electron (window.electronAPI.isElectron);
 *   - only when the viewport is at most 767px wide - Tailwind's md
 *     breakpoint, the same line the Documents tabs already use
 *     (src/index.css);
 *   - and only when the primary pointer is coarse (a finger): a laptop
 *     browser window narrowed to a phone's width keeps the desktop layout.
 * Both media queries are watched, so a rotation or a resize re-evaluates
 * the decision (useIsMobile in src/hooks/useIsMobile.js); the result is
 * mirrored on <html data-mobile="true"> for the stylesheet (src/mobile.css),
 * whose every rule is scoped to that attribute.
 */
export const PHONE_WIDTH_QUERY = '(max-width: 767px)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** The decision from its three inputs (pure, for tests). */
export function decideMobile({ narrow, coarse, electron }) {
  return !electron && !!narrow && !!coarse;
}

function query(win, q) {
  try {
    const list = win.matchMedia(q);
    return list && list.matches === true;
  } catch {
    return false;
  }
}

/** Is `win` (default: the window) a phone right now? false without matchMedia (tests, SSR). */
export function detectMobile(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  return decideMobile({
    narrow: query(win, PHONE_WIDTH_QUERY),
    coarse: query(win, COARSE_POINTER_QUERY),
    electron: !!(win.electronAPI && win.electronAPI.isElectron),
  });
}

/**
 * Call `onChange()` whenever either media query flips (resize, rotation,
 * a device-mode toggle). Returns the unsubscribe function.
 */
export function subscribeMobile(win, onChange) {
  if (!win || typeof win.matchMedia !== 'function') return () => {};
  const lists = [PHONE_WIDTH_QUERY, COARSE_POINTER_QUERY].map((q) => {
    try { return win.matchMedia(q); } catch { return null; }
  }).filter(Boolean);
  for (const list of lists) {
    if (typeof list.addEventListener === 'function') list.addEventListener('change', onChange);
    else if (typeof list.addListener === 'function') list.addListener(onChange);
  }
  return () => {
    for (const list of lists) {
      if (typeof list.removeEventListener === 'function') list.removeEventListener('change', onChange);
      else if (typeof list.removeListener === 'function') list.removeListener(onChange);
    }
  };
}

/**
 * Is the phone layout on right now, read back from the document (for code
 * outside React's tree, such as the menu-positioning effects: a context
 * menu is a bottom sheet then, placed by src/mobile.css, and the clamping
 * that keeps a desktop menu under the pointer must leave it alone).
 */
export function isMobileLayout(doc = typeof document !== 'undefined' ? document : undefined) {
  return !!doc && !!doc.documentElement && doc.documentElement.getAttribute('data-mobile') === 'true';
}

/** Mirror the decision on the document: <html data-mobile="true"> or no attribute at all. */
export function applyMobileAttribute(doc, mobile) {
  const root = doc && doc.documentElement;
  if (!root) return;
  if (mobile) root.setAttribute('data-mobile', 'true');
  else root.removeAttribute('data-mobile');
}
