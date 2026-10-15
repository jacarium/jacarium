"""Document-id validation shared by the RAG routes and the vector store.

Every LanceDB filter in vector_db.py (`.where()`, `.delete()`, `.update()`)
is a plain string, so a raw request value would be interpolated straight
into the query language. Only integers (or integer-looking strings) are ever
legitimate document ids; anything else is rejected before a filter is built.

Kept free of heavy imports (lancedb / fastembed are deferred to first use by
extensions.get_vector_db) so the HTTP routes can validate ids cheaply.
"""
import re

_INT_RE = re.compile(r'-?\d{1,18}')


def validate_doc_id(doc_id):
    """Return doc_id as int, or raise ValueError. Bools are refused."""
    if isinstance(doc_id, bool):
        raise ValueError(f"Invalid document id: {doc_id!r}")
    if isinstance(doc_id, int):
        return doc_id
    if isinstance(doc_id, str) and _INT_RE.fullmatch(doc_id.strip()):
        return int(doc_id.strip())
    raise ValueError(f"Invalid document id: {doc_id!r}")


def validate_doc_ids(doc_ids):
    """Validate a list of document ids (None/empty -> []). Raises ValueError."""
    if not doc_ids:
        return []
    if isinstance(doc_ids, (str, bytes, dict)) or not hasattr(doc_ids, '__iter__'):
        raise ValueError("dataset_ids must be a list of document ids")
    return [validate_doc_id(d) for d in doc_ids]
