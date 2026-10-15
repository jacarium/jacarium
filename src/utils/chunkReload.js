/**
 * Recovering from a stale page after a redeploy.
 *
 * The built app loads its code in hashed chunks (/assets/<name>-<hash>.js).
 * After a redeploy the old chunks are gone; a browser that still holds the
 * previous index.html (or the previous main bundle) then fails with
 * "Importing a module script failed" (Safari) / "Failed to fetch dynamically
 * imported module" (Chrome, Firefox) - at startup or when a page is opened
 * for the first time. The cure is a reload, which fetches the current
 * index.html; it is done ONCE (a sessionStorage flag), so a genuinely
 * broken deployment shows the error screen instead of looping.
 */
const FLAG = 'jacarium:reloadedAfterChunkError';
const CHUNK_ERROR = /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk [\w-]+ failed|loading css chunk|unable to preload css|dynamically imported module/i;

export function isChunkLoadError(error) {
  const text = error == null ? '' : String(error?.message || error?.reason?.message || error?.payload?.message || error);
  return CHUNK_ERROR.test(text);
}

/**
 * 'reloaded' when the page was reloaded for this error (first time),
 * 'failed' when it already was once (show the error screen),
 * 'not-chunk' when the error is something else.
 */
export function recoverFromChunkLoadError(error, { storage = defaultStorage(), reload = () => window.location.reload() } = {}) {
  if (!isChunkLoadError(error)) return 'not-chunk';
  let already = false;
  try { already = storage?.getItem(FLAG) === '1'; } catch { already = false; }
  if (already) return 'failed';
  try { storage?.setItem(FLAG, '1'); } catch { /* no storage: reload anyway, once per page load is the best we can do */ }
  reload();
  return 'reloaded';
}

/** Once the app has started, the next stale-chunk failure may reload again. */
export function clearChunkReloadFlag(storage = defaultStorage()) {
  try { storage?.removeItem(FLAG); } catch { /* no storage */ }
}

function defaultStorage() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

export const CHUNK_RELOAD_FLAG = FLAG;
