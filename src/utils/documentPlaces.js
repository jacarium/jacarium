/**
 * The reader's place per document, for the session: the source line at the
 * top of the view (the editor's and the preview's common currency,
 * src/utils/previewPlace.js), the two scroll offsets and the editor's
 * selection, keyed by the document's stable id. The Documents editor
 * records it as the user scrolls and leaves a document, and puts a document
 * opened again back there, in whichever view it opens (DocumentEditor.jsx).
 * A document never opened has no entry and starts at the top.
 *
 * Kept in memory and mirrored to sessionStorage (a reload within the
 * session keeps the places; a new session starts clean - not localStorage,
 * so an old place never outlives the content it pointed into). At most
 * PLACES_MAX documents, the oldest forgotten first.
 */
export const PLACES_KEY = 'documentPlaces';
export const PLACES_MAX = 200;

const storage = () => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; } };
const places = new Map();
try {
  const raw = storage()?.getItem(PLACES_KEY);
  const obj = raw ? JSON.parse(raw) : null;
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') places.set(k, v);
} catch { /* a fresh session */ }

let persistTimer = null;
function persist() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { storage()?.setItem(PLACES_KEY, JSON.stringify(Object.fromEntries(places))); } catch { /* full or absent */ }
  }, 250);
}

/** The key of a document: its stable id, else its local id. */
export function placeKeyFor(doc, documentId) {
  if (doc && doc.stableId) return `stable:${doc.stableId}`;
  return documentId != null ? `id:${documentId}` : null;
}

/** The remembered place of a document ({ line, editorScrollTop, previewScrollTop, selection }), or null. */
export function rememberedPlace(key) {
  return (key && places.get(key)) || null;
}

/** Merge `patch` into the document's place (line, scroll offsets, selection) and keep it most recent. */
export function rememberPlace(key, patch) {
  if (!key || !patch) return;
  const next = { ...(places.get(key) || {}), ...patch, at: Date.now() };
  places.delete(key);
  places.set(key, next);
  while (places.size > PLACES_MAX) places.delete(places.keys().next().value);
  persist();
}

/** Forget one document's place (a deleted document), or all of them. */
export function forgetPlace(key) {
  if (key == null) places.clear(); else places.delete(key);
  persist();
}
