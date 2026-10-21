/**
 * What "Add as AI Context" loads, and the one way every menu hands it to
 * the AI chat sidebar.
 *
 * The lists and menus hold lightweight records - the Documents sidebar
 * lists documents WITHOUT their `content` (getDocumentsMetadata), a tab
 * menu holds an id - so the content is loaded here, from where it really
 * lives, right before the context is created:
 *
 *   document  the text an open editor holds right now when the document is
 *             open (unsaved edits; a cloud document's live Yjs text, which
 *             reaches IndexedDB only through a debounced mirror) - asked
 *             through the LIVE_CONTENT_EVENT the editor answers - else the
 *             document's `content` in IndexedDB (getDocument);
 *   board     the board row plus its cards (separate records, getCards);
 *   workflow  the workflow row (nodes and edges live on it), as readable
 *             Markdown (workflowMarkdown).
 *
 * A payload whose content could not be loaded, or is empty, carries
 * `error`; the sidebar shows it on the chip and never sends such a block.
 */
import { getDocument } from './documents';
import { getBoard, getCards } from './kanban';
import { getWorkflow } from './workflows';
import { documentContextPayload, kanbanContextPayload } from './aiContext';
import { workflowContextPayload } from './workflowMarkdown';

/** The event an open DocumentEditor answers with the document's live text (detail: { documentId, content }). */
export const LIVE_CONTENT_EVENT = 'aiContextDocumentContent';

const idOf = (v) => (v && typeof v === 'object' ? v.id : v);

/** The live text of an open editor for the document, or undefined when it is not open. */
export function liveDocumentContent(documentId) {
  if (typeof window === 'undefined' || documentId == null) return undefined;
  const detail = { documentId, content: undefined };
  window.dispatchEvent(new CustomEvent(LIVE_CONTENT_EVENT, { detail }));
  return typeof detail.content === 'string' ? detail.content : undefined;
}

export async function loadDocumentContext(docOrId) {
  const id = idOf(docOrId);
  let stored = null;
  try { stored = id != null ? await getDocument(id) : null; } catch (err) { console.error('[AI context] could not read the document:', err); }
  const meta = stored || (docOrId && typeof docOrId === 'object' ? docOrId : null);
  if (!meta) return { ...documentContextPayload({ id, title: 'Untitled', content: '' }), error: 'The document could not be found.' };
  const live = liveDocumentContent(meta.id ?? id);
  const content = live !== undefined ? live
    : stored && typeof stored.content === 'string' ? stored.content
      : docOrId && typeof docOrId === 'object' && typeof docOrId.content === 'string' ? docOrId.content
        : undefined;
  const payload = documentContextPayload({ ...meta, content: content ?? '' });
  if (content === undefined) payload.error = 'The document\'s content could not be loaded.';
  else if (!content.trim()) payload.error = 'The document is empty.';
  return payload;
}

export async function loadKanbanContext(boardOrId) {
  const id = idOf(boardOrId);
  let board = null; let cards = [];
  try {
    board = (id != null ? await getBoard(id) : null) || (boardOrId && typeof boardOrId === 'object' ? boardOrId : null);
    if (board?.id != null) cards = await getCards(board.id);
  } catch (err) { console.error('[AI context] could not read the board:', err); }
  if (!board) return { ...kanbanContextPayload({ id, title: 'Untitled board' }, []), error: 'The board could not be found.' };
  return kanbanContextPayload(board, cards);
}

export async function loadWorkflowContext(workflowOrId) {
  const id = idOf(workflowOrId);
  let workflow = null;
  try { workflow = (id != null ? await getWorkflow(id) : null) || (workflowOrId && typeof workflowOrId === 'object' ? workflowOrId : null); } catch (err) { console.error('[AI context] could not read the workflow:', err); }
  if (!workflow) return { ...workflowContextPayload({ id, title: 'Untitled workflow', nodes: [] }), error: 'The workflow could not be found.' };
  const payload = workflowContextPayload(workflow);
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) payload.error = 'The workflow has no nodes.';
  return payload;
}

/**
 * Open the AI chat sidebar, load the context (once the sidebar has had a
 * moment to mount) and hand it over. Resolves to the payload sent.
 */
export function addAsAIContext(load) {
  window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } }));
  return new Promise((resolve) => {
    setTimeout(async () => {
      let payload;
      try {
        payload = await load();
      } catch (err) {
        console.error('[AI context] could not load the context:', err);
        payload = { kind: 'document', title: 'Context', category: '', content: '', source: {}, error: `The context could not be loaded: ${err?.message || err}` };
      }
      window.dispatchEvent(new CustomEvent('addAIContext', { detail: { contextData: payload } }));
      resolve(payload);
    }, 100);
  });
}

export const addDocumentAsAIContext = (docOrId) => addAsAIContext(() => loadDocumentContext(docOrId));
export const addKanbanAsAIContext = (boardOrId) => addAsAIContext(() => loadKanbanContext(boardOrId));
export const addWorkflowAsAIContext = (workflowOrId) => addAsAIContext(() => loadWorkflowContext(workflowOrId));
