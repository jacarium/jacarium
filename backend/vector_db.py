import os
import json
import hashlib
import lancedb
from fastembed import TextEmbedding
from pathlib import Path
import re

# Every filter below is a plain string handed to LanceDB, so document ids are
# coerced to int first (see doc_ids.py) - never interpolate raw input.
from doc_ids import validate_doc_id, validate_doc_ids
from settings_store import setting


class VectorDBManager:
    def __init__(self, db_path=None, embedding_model=None):
        """Initialize LanceDB and FastEmbed (or reuse a loaded model: with
        sign-in every account has its own index directory but they all share
        one embedding model, see extensions.get_vector_db)."""
        if db_path is None:
            # Store in user home directory
            db_path = os.path.expanduser("~/.jacarium/vector_db")

        os.makedirs(db_path, exist_ok=True)
        self.db = lancedb.connect(db_path)

        model_name = None
        if embedding_model is not None:
            self.embedding_model = embedding_model
        else:
            # Set HuggingFace token if available (from settings)
            # This enables faster downloads and higher rate limits
            hf_token = setting('HF_TOKEN')
            if hf_token:
                os.environ['HF_TOKEN'] = hf_token

            # Get embedding model from settings or use default
            model_name = setting('HF_EMBEDDING_MODEL', 'BAAI/bge-small-en-v1.5')

            # Initialize FastEmbed with configured model
            # Default: BAAI/bge-small-en-v1.5 (384 dimensions, ~150MB)
            self.embedding_model = TextEmbedding(model_name=model_name)

        # What produced the vectors: the model's name and its dimension, so an
        # index built by another model is recognised (see _ensure_table). The
        # name comes from the fastembed object when the model was handed in
        # (the per-account managers share one loaded model); the dimension
        # from embedding one probe string - cheaper than trusting a table.
        self.embedding_model_name = (
            getattr(self.embedding_model, 'model_name', None) or model_name or type(self.embedding_model).__name__
        )
        self.embedding_dim = len(list(self.embedding_model.embed(['dimension probe']))[0])
        self._fingerprint_path = os.path.join(db_path, 'embedder.json')

        # Create or open table
        self._ensure_table()

    def _ensure_table(self):
        """Open document_chunks if it exists - and only if the current
        embedder built it.

        The embedding model is a setting (HF_EMBEDDING_MODEL) and a
        dependency: change either and the stored vectors no longer live in
        the query's space. A different dimension made every search raise
        inside LanceDB (and every index call fail on insert); the same
        dimension from a different model would have searched quietly and
        returned nonsense. So the index directory carries embedder.json
        ({model, dim}) written when the table is created, and a table whose
        fingerprint does not match the current embedder is dropped here -
        the next dataset save (or the pre-turn re-index) rebuilds it, since
        no checksum survives. A table without a fingerprint (built before
        this check) is kept when its vector width matches and stamped.
        """
        try:
            self.table = self.db.open_table("document_chunks")
        except Exception:
            # Table doesn't exist, create it with schema
            # Create with empty data and schema will be inferred on first insert
            self.table = None
            return

        fingerprint = self._read_fingerprint()
        current = {"model": self.embedding_model_name, "dim": self.embedding_dim}
        if fingerprint is None:
            table_dim = self._table_vector_dim()
            if table_dim in (None, self.embedding_dim):
                self._write_fingerprint(current)
                return
            reason = f"vector width {table_dim} != {self.embedding_dim}"
        elif fingerprint == current:
            return
        else:
            reason = f"built by {fingerprint.get('model')} ({fingerprint.get('dim')}d)"

        print(f"[VectorDB] Index at {self.db.uri} was {reason}; current embedder is "
              f"{self.embedding_model_name} ({self.embedding_dim}d). Dropping it - it is rebuilt on the next indexing run.")
        try:
            self.db.drop_table("document_chunks")
        except Exception as e:
            print(f"[VectorDB] Failed to drop the stale index: {e}")
            raise
        self.table = None
        self._write_fingerprint(current)

    def _read_fingerprint(self):
        try:
            with open(self._fingerprint_path, encoding='utf-8') as fh:
                data = json.load(fh)
            return {"model": data.get("model"), "dim": data.get("dim")}
        except (OSError, ValueError):
            return None

    def _write_fingerprint(self, fingerprint):
        try:
            with open(self._fingerprint_path, 'w', encoding='utf-8') as fh:
                json.dump(fingerprint, fh)
        except OSError as e:
            print(f"[VectorDB] Could not write {self._fingerprint_path}: {e}")

    def _table_vector_dim(self):
        """The stored vectors' width, from the schema (a fixed-size list) or a row."""
        try:
            field = self.table.schema.field("vector")
            size = getattr(field.type, "list_size", None)
            if size and size > 0:
                return int(size)
        except Exception:
            pass
        try:
            rows = self.table.search().limit(1).to_list()
            return len(rows[0]["vector"]) if rows else None
        except Exception:
            return None

    def calculate_checksum(self, content):
        """Calculate MD5 hash of document content"""
        return hashlib.md5(content.encode('utf-8')).hexdigest()

    def chunk_markdown(self, content, chunk_size=500, overlap=50):
        """
        Split markdown content into chunks respecting structure.

        Strategy:
        1. Split on headers (##, ###, etc.)
        2. If section too large, split on paragraphs
        3. If paragraph too large, split on sentences
        4. Add overlap between chunks for context

        Args:
            content: Markdown text
            chunk_size: Target tokens per chunk (~4 chars per token)
            overlap: Tokens of overlap between chunks

        Returns:
            List of text chunks
        """
        chunks = []

        # Rough token estimate: 4 characters ≈ 1 token
        target_chars = chunk_size * 4
        overlap_chars = overlap * 4

        # Split on markdown headers
        sections = re.split(r'(^#{1,6}\s+.+$)', content, flags=re.MULTILINE)

        current_chunk = ""

        for section in sections:
            if not section.strip():
                continue

            # If adding this section exceeds target, save current chunk
            if len(current_chunk) + len(section) > target_chars and current_chunk:
                chunks.append(current_chunk.strip())

                # Add overlap from end of previous chunk
                if len(current_chunk) > overlap_chars:
                    current_chunk = current_chunk[-overlap_chars:] + "\n" + section
                else:
                    current_chunk = section
            else:
                current_chunk += "\n" + section

        # Add final chunk
        if current_chunk.strip():
            chunks.append(current_chunk.strip())

        # If still too large, split long chunks on paragraphs
        final_chunks = []
        for chunk in chunks:
            if len(chunk) > target_chars:
                # Split on double newlines (paragraphs)
                paragraphs = chunk.split('\n\n')
                sub_chunk = ""

                for para in paragraphs:
                    if len(sub_chunk) + len(para) > target_chars and sub_chunk:
                        final_chunks.append(sub_chunk.strip())
                        sub_chunk = para
                    else:
                        sub_chunk += "\n\n" + para

                if sub_chunk.strip():
                    final_chunks.append(sub_chunk.strip())
            else:
                final_chunks.append(chunk)

        # Final unconditional pass: hard-split anything still oversized
        # (e.g. a single huge paragraph) so no chunk exceeds target_chars.
        # The embedder (bge-small-en-v1.5 via fastembed) truncates at 512
        # tokens, so oversized chunks silently lose content otherwise.
        sized_chunks = []
        for chunk in final_chunks:
            if len(chunk) <= target_chars:
                sized_chunks.append(chunk)
                continue

            # Split on sentence boundaries and accumulate up to target_chars
            sentences = re.split(r'(?<=[.!?])\s+', chunk)
            sub_chunk = ""
            for sentence in sentences:
                if len(sentence) > target_chars:
                    # No usable punctuation (logs/CSV/JSON) - flush what we
                    # have, then hard-split on fixed character windows with
                    # overlap.
                    if sub_chunk.strip():
                        sized_chunks.append(sub_chunk.strip())
                        sub_chunk = ""
                    step = max(target_chars - overlap_chars, 1)
                    for start in range(0, len(sentence), step):
                        piece = sentence[start:start + target_chars]
                        if piece.strip():
                            sized_chunks.append(piece.strip())
                elif len(sub_chunk) + len(sentence) + 1 > target_chars and sub_chunk:
                    sized_chunks.append(sub_chunk.strip())
                    sub_chunk = sentence
                else:
                    sub_chunk = (sub_chunk + " " + sentence) if sub_chunk else sentence

            if sub_chunk.strip():
                sized_chunks.append(sub_chunk.strip())

        return [c for c in sized_chunks if c.strip()]

    def index_document(self, doc_id, title, content, category="Uncategorized"):
        """
        Index a single document into the vector database.

        Returns:
            dict: {
                "indexed": bool,
                "checksum": str,
                "chunks": int,
                "reason": str  # If not indexed
            }
        """
        doc_id = validate_doc_id(doc_id)
        checksum = self.calculate_checksum(content)

        # Check if document already indexed with same checksum
        if self.table is not None:
            try:
                existing = self.table.search().where(f"doc_id = {doc_id}").limit(1).to_list()
                if existing and existing[0].get('doc_checksum') == checksum:
                    # Content unchanged, but the title/category may have been
                    # edited (rename, recategorize). If we skip without
                    # refreshing them, search results keep citing the OLD
                    # title forever, making correct matches look wrong in the
                    # UI. Update just the metadata columns in place - the
                    # embeddings/vectors are untouched on this path.
                    if (existing[0].get('doc_title') != title
                            or existing[0].get('doc_category') != category):
                        self.table.update(
                            where=f"doc_id = {doc_id}",
                            values={"doc_title": title, "doc_category": category}
                        )
                        return {
                            "indexed": False,
                            "checksum": checksum,
                            "chunks": 0,
                            "reason": "Content unchanged; refreshed title/category metadata"
                        }
                    return {
                        "indexed": False,
                        "checksum": checksum,
                        "chunks": 0,
                        "reason": "Already indexed with same content"
                    }

                # Delete existing chunks for this document (if updating)
                self.table.delete(f"doc_id = {doc_id}")
            except Exception as e:
                # Do NOT swallow and continue - inserting on top of a failed
                # delete would leave duplicate old+new chunks for this doc_id.
                print(f"[VectorDB] Failed to delete existing chunks for doc_id={doc_id}: {e}")
                raise

        # Chunk the document
        chunks = self.chunk_markdown(content)

        if not chunks:
            return {
                "indexed": False,
                "checksum": checksum,
                "chunks": 0,
                "reason": "No content to index"
            }

        # Generate embeddings for all chunks
        embeddings = list(self.embedding_model.embed(chunks))

        # Prepare data for insertion
        data = []
        for idx, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            data.append({
                "vector": embedding.tolist(),
                "text": chunk,
                "doc_id": doc_id,
                "chunk_index": idx,
                "doc_title": title,
                "doc_category": category,
                "doc_checksum": checksum
            })

        # Insert into LanceDB
        if self.table is None:
            self.table = self.db.create_table("document_chunks", data=data)
            self._write_fingerprint({"model": self.embedding_model_name, "dim": self.embedding_dim})
        else:
            self.table.add(data)

        return {
            "indexed": True,
            "checksum": checksum,
            "chunks": len(chunks)
        }

    def search(self, query, top_k=5, dataset_ids=None):
        """
        Search for relevant chunks using semantic similarity.

        Args:
            query: User's question/query text
            top_k: Number of chunks to retrieve
            dataset_ids: List of document IDs to filter by (optional)

        Returns:
            List of dicts with: {doc_id, doc_title, doc_category, text, score}
        """
        # Validate BEFORE touching the table so a bad id is rejected even
        # when nothing is indexed yet (ids end up in a filter string).
        dataset_ids = validate_doc_ids(dataset_ids)

        if self.table is None:
            return []

        # Generate embedding for query. query_embed() applies the BGE
        # query-instruction prefix, which improves retrieval for short
        # queries against passage embeddings (passages keep using embed()).
        query_embedding = list(self.embedding_model.query_embed([query]))[0]

        # Build and run the search with an explicit cosine metric (don't rely
        # on defaults). Everything LanceDB-side sits in the try: a query
        # vector the table cannot take raised while BUILDING the query, not
        # while running it, and turned a chat turn into a 500 instead of the
        # plain-chat fallback.
        try:
            search_query = self.table.search(query_embedding.tolist()).metric("cosine")

            # Filter by dataset IDs if provided
            if dataset_ids:
                # dataset_ids are validated ints (see validate_doc_ids above)
                id_filter = " OR ".join([f"doc_id = {int(id)}" for id in dataset_ids])
                search_query = search_query.where(f"({id_filter})")

            results = search_query.limit(top_k).to_list()
        except Exception as e:
            print(f"[VectorDB] Search error: {e}")
            return []

        # Format results
        formatted = []
        for result in results:
            formatted.append({
                "doc_id": result["doc_id"],
                "doc_title": result["doc_title"],
                "doc_category": result["doc_category"],
                "chunk_text": result["text"],
                "score": result.get("_distance", 0)  # Cosine distance (lower = more similar)
            })

        return formatted

    def get_indexed_documents(self):
        """Get list of all indexed documents with their checksums"""
        if self.table is None:
            return []

        try:
            # One entry per doc_id, from the metadata columns only (pyarrow
            # ships with lancedb; pandas, which an earlier revision used
            # here, is not a dependency, so this always returned []).
            rows = self.table.to_arrow().select(
                ["doc_id", "doc_title", "doc_category", "doc_checksum"]
            ).to_pylist()
            docs = {}
            for row in rows:
                docs.setdefault(int(row["doc_id"]), {
                    "doc_id": int(row["doc_id"]),
                    "doc_title": row["doc_title"],
                    "doc_category": row["doc_category"],
                    "checksum": row["doc_checksum"]
                })
            return [docs[k] for k in sorted(docs)]
        except Exception as e:
            print(f"[VectorDB] Failed to list indexed documents: {e}")
            return []

    def delete_document(self, doc_id):
        """Remove all chunks for a document.

        NOTE: should be called when a document is deleted from the document
        store (wiring into that flow is pending).
        """
        doc_id = validate_doc_id(doc_id)
        if self.table is not None:
            try:
                self.table.delete(f"doc_id = {doc_id}")
            except Exception as e:
                print(f"[VectorDB] Failed to delete chunks for doc_id={doc_id}: {e}")
