/**
 * Open a document on the Documents page from anywhere in the app
 * (Tasks page "Create Document In", chat citations, ...).
 *
 * Navigation goes through the app's existing 'openDocument' window event:
 * JQLBuilder listens for it, switches to the Documents page and hands the
 * id to DocumentsPage as `selectedDocumentId`. DocumentsPage is lazy-loaded,
 * so the document is opened by its own effect once the chunk mounts - the
 * id is React state in JQLBuilder, not something that can be lost while the
 * chunk loads.
 *
 * "Ready to type" is handled by a small pending-focus request: the editor
 * that ends up showing the document (DocumentEditor) calls
 * takePendingEditorFocus(documentId) when it mounts or switches to it and,
 * if the request is for that document, leaves preview mode and focuses the
 * body with the caret at the end. Keeping the request in module state (not
 * in the event) means it survives the lazy mount and is consumed exactly
 * once, by whichever editor instance shows the document first.
 */

let pendingEditorFocusId = null;

/**
 * Navigate to the Documents page and open `documentId` there.
 *
 * @param {number} documentId
 * @param {{ focusEditor?: boolean }} [options] - focusEditor (default true):
 *   also drop the document into edit mode with the editor body focused.
 * @returns {boolean} false when no page shell can handle the request (a
 *   standalone window without the main app shell) - the caller then tells the
 *   user where to find the document instead.
 */
export function openDocumentInEditor(documentId, { focusEditor = true } = {}) {
  if (documentId == null) return false;
  if (!canNavigateToDocuments()) return false;
  pendingEditorFocusId = focusEditor ? documentId : null;
  window.dispatchEvent(new CustomEvent('openDocument', {
    detail: { documentId, focusEditor: !!focusEditor },
  }));
  return true;
}

/**
 * Consume the pending "focus the editor" request for `documentId`.
 * Returns true exactly once per request, and only for the requested id.
 */
export function takePendingEditorFocus(documentId) {
  if (documentId == null || pendingEditorFocusId !== documentId) return false;
  pendingEditorFocusId = null;
  return true;
}

/** Test/debug helper: the id of the pending focus request, if any. */
export function peekPendingEditorFocus() {
  return pendingEditorFocusId;
}

/**
 * "Jump to line" requests (Find in Files "Open in New Tab"): the same
 * pending-request mechanism as the focus request above, carrying the target
 * line and the matched character range on that line. The editor that shows
 * the document consumes it once (takePendingEditorJump) when it mounts or
 * switches to the document; when the document is ALREADY the active one no
 * switch happens, so the request is also broadcast as a window event the
 * showing editor handles immediately.
 */
export const DOCUMENT_JUMP_EVENT = 'documentJumpToLine';

let pendingEditorJump = null;

/**
 * @param {number} documentId
 * @param {{ line: number, range?: [number, number], broadcast?: boolean }} target -
 *   1-based line; optional [start, end) column range of the match on that
 *   line; `broadcast` (default true) also fires the window event for an
 *   editor that already shows the document. Pass false when a switch to the
 *   document is in flight, so an editor still showing it in another pane
 *   does not take the request away from the pane it is moving to.
 */
export function requestEditorJumpToLine(documentId, { line, range = null, broadcast = true }) {
  if (documentId == null || !line) return;
  pendingEditorJump = { documentId, line, range };
  if (broadcast && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(DOCUMENT_JUMP_EVENT, { detail: { documentId, line, range } }));
  }
}

/**
 * Consume the pending jump request for `documentId`. Returns the target
 * ({ line, range }) exactly once per request and only for the requested id,
 * null otherwise.
 */
export function takePendingEditorJump(documentId) {
  if (documentId == null || !pendingEditorJump || pendingEditorJump.documentId !== documentId) return null;
  const { line, range } = pendingEditorJump;
  pendingEditorJump = null;
  return { line, range };
}

/** Test/debug helper: the pending jump request, if any. */
export function peekPendingEditorJump() {
  return pendingEditorJump;
}

/**
 * Whether this window hosts the main app shell (JQLBuilder) that can switch
 * to the Documents page. Standalone windows (?standalone=tasks, ...) render a
 * single page with no shell and no 'openDocument' listener.
 */
export function canNavigateToDocuments() {
  try {
    return !new URLSearchParams(window.location.search).get('standalone');
  } catch {
    return true;
  }
}

/**
 * The Documents sidebar's persisted expanded-categories list
 * (DocumentSidebar: useLocalStorage('expandedDocumentCategories', [])).
 */
export const EXPANDED_DOCUMENT_CATEGORIES_KEY = 'expandedDocumentCategories';

/**
 * Make sure `category` is expanded in the Documents sidebar the next time it
 * mounts, so a document opened from elsewhere is visible (and highlighted)
 * in the list rather than hidden under a collapsed header. The sidebar reads
 * this key on mount; a mounted sidebar keeps its own state, which is fine
 * because navigation from another page always mounts it fresh.
 *
 * @param {string} category
 * @param {Storage} [storage=window.localStorage]
 */
export function expandDocumentCategoryInSidebar(category, storage) {
  if (!category) return;
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return;
  let expanded = [];
  try {
    const raw = store.getItem(EXPANDED_DOCUMENT_CATEGORIES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) expanded = parsed.filter(c => typeof c === 'string');
  } catch {
    expanded = [];
  }
  if (expanded.includes(category)) return;
  try {
    store.setItem(EXPANDED_DOCUMENT_CATEGORIES_KEY, JSON.stringify([...expanded, category]));
  } catch {
    // Storage unavailable (private mode, quota) - the document still opens,
    // just under a collapsed header.
  }
}
