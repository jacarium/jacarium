import { getDocuments } from './documents';
import { apiFetch } from './backendUrl';

/**
 * Bring the backend's vector index up to date for the given documents.
 *
 * The index only knows a document as it was when the dataset selection was
 * saved (DatasetSelectionModal posts the selected documents then). A note
 * edited, or a document's title or category changed, after that was
 * searched as its OLD text until the selection was saved again - Robin
 * answered from stale chunks. The chat page calls this before every dataset
 * turn: the backend skips documents whose content checksum has not changed
 * (and refreshes title/category in place), so only edited documents are
 * embedded again. Documents deleted since are simply no longer posted; their
 * chunks stay out of the search because retrieval filters by the selected
 * ids.
 *
 * Returns the backend's summary ({ indexed, skipped, chunks_created }) or
 * null when there was nothing to index. Throws on a failed request: the
 * caller decides whether the chat goes ahead without the refresh.
 */
export async function indexDatasetDocuments(backendUrl, documentIds) {
  const wanted = new Set((documentIds || []).map((id) => Number(id)));
  if (!wanted.size) return null;
  const all = await getDocuments();
  const documents = all
    .filter((doc) => wanted.has(Number(doc.id)))
    .map((doc) => ({ id: doc.id, title: doc.title, content: doc.content || '', category: doc.category || 'Uncategorized' }));
  if (!documents.length) return null;
  const response = await apiFetch(`${backendUrl}/api/embeddings/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents }),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(result.error || `Indexing failed (${response.status})`);
  return result;
}
