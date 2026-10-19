#!/usr/bin/env python3
"""
Robin's index (LanceDB + the fastembed embedder, backend/vector_db.py) stays
consistent with the embedder that queries it, and never takes a chat down.

Found while investigating "Robin answered my first question again":
  - the embedding model is a setting (HF_EMBEDDING_MODEL) and a dependency;
    an index built by one model was opened by any other. A different
    dimension made LanceDB raise while BUILDING the search (outside the
    try/except), so a dataset turn returned HTTP 500 instead of falling back
    to plain chat, and every re-index failed on insert; the same dimension
    from a different model would have searched quietly and returned nonsense.
  - THE FIX: the index directory carries embedder.json ({model, dim}); a
    table whose fingerprint does not match the current embedder is dropped
    on open and rebuilt by the next indexing run (no checksum survives, so
    every selected document is embedded again); a table from before the
    fingerprint is kept when its vector width matches, and stamped. search()
    returns [] on any LanceDB error.

Also guarded here, with the same temp index and a fake embedder (no model
download, no network):
  - the dataset filter limits results to the selected ids;
  - re-indexing an edited document replaces its chunks (no stale ones);
    delete_document removes them; an unchanged document is skipped by
    checksum and a renamed one has its title refreshed in place;
  - chunking keeps a heading with the text under it (no heading-only chunk);
  - the per-account index path: ~/.jacarium/vector_db resolves under the
    request's home, so accounts never share an index.

Run:  backend/venv/bin/python tests/rag_index_consistency.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')

try:
    import lancedb  # noqa: F401
    import numpy as np
except ImportError:
    print('Missing dependency. Run with the backend venv: backend/venv/bin/python tests/rag_index_consistency.test.py')
    sys.exit(1)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)[:300]) if detail and not cond else ''))


class FakeEmbedder:
    """Deterministic bag-of-words-ish vectors of a chosen width; `model_name`
    like fastembed's TextEmbedding so the manager can fingerprint it."""

    def __init__(self, dim, model_name):
        self.dim = dim
        self.model_name = model_name

    def _vec(self, text):
        v = np.zeros(self.dim, dtype='float32')
        for tok in text.lower().split():
            v[hash(tok) % self.dim] += 1.0
        n = np.linalg.norm(v)
        return v / n if n else v

    def embed(self, texts):
        for t in texts:
            yield self._vec(t)

    def query_embed(self, texts):
        return self.embed(texts)


from vector_db import VectorDBManager  # noqa: E402

LAB = tempfile.mkdtemp(prefix='rag-index-consistency-')
DB = os.path.join(LAB, 'vector_db')
exit_code = 1
try:
    small = FakeEmbedder(384, 'fake/small-384')
    db = VectorDBManager(db_path=DB, embedding_model=small)
    check('a fresh index has no table and records the embedder fingerprint on first insert', db.table is None and not os.path.exists(os.path.join(DB, 'embedder.json')))
    r1 = db.index_document(1, 'DAST', '# DAST\n\nDynamic testing probes the running application from outside.', 'AI Security')
    r2 = db.index_document(2, 'SAST', '# SAST\n\nStatic analysis reads the source code without running it.', 'AI Security')
    r3 = db.index_document(3, 'Postgres vacuum', '# Vacuum\n\nAutovacuum reclaims dead tuples in postgres tables.', 'Ops')
    fp = json.load(open(os.path.join(DB, 'embedder.json')))
    check('indexing creates the table and writes embedder.json {model, dim}', r1['indexed'] and r2['indexed'] and r3['indexed'] and fp == {'model': 'fake/small-384', 'dim': 384}, fp)

    # --- the dataset filter ---
    rows = db.search('running application dynamic testing', top_k=5, dataset_ids=[2, 3])
    check('the dataset filter limits results to the selected ids (the best match, excluded, is not returned)', rows and all(r['doc_id'] in (2, 3) for r in rows), [(r['doc_id'], round(r['score'], 3)) for r in rows])
    rows = db.search('running application dynamic testing', top_k=5, dataset_ids=[1, 2, 3])
    check('with all ids selected the DAST note ranks first', rows and rows[0]['doc_id'] == 1, [(r['doc_id'], round(r['score'], 3)) for r in rows])

    # --- update / rename / delete ---
    same = db.index_document(1, 'DAST', '# DAST\n\nDynamic testing probes the running application from outside.', 'AI Security')
    check('an unchanged document is skipped by checksum', same['indexed'] is False and 'unchanged' in same['reason'].lower() or 'Already indexed' in same['reason'])
    renamed = db.index_document(1, 'DAST (dynamic testing)', '# DAST\n\nDynamic testing probes the running application from outside.', 'AI Security')
    rows = db.search('running application dynamic testing', top_k=1, dataset_ids=[1])
    check('a renamed document keeps its vectors and shows the new title in results', renamed['indexed'] is False and rows and rows[0]['doc_title'] == 'DAST (dynamic testing)', rows and rows[0]['doc_title'])
    edited = db.index_document(1, 'DAST', '# DAST\n\nRewritten: fuzzing of HTTP endpoints only.', 'AI Security')
    chunks = db.table.search().where('doc_id = 1').to_list()
    check('an edited document replaces its chunks (no stale text left)', edited['indexed'] and len(chunks) == 1 and 'fuzzing' in chunks[0]['text'] and 'probes' not in chunks[0]['text'], [c['text'][:40] for c in chunks])
    db.delete_document(3)
    check('delete_document removes every chunk of the document', db.table.search().where('doc_id = 3').to_list() == [] and len(db.get_indexed_documents()) == 2)

    # --- chunking keeps headings with their text ---
    long_doc = '\n\n'.join('## Section %d\n\n' % k + ('Sentence about topic %d. ' % k) * 60 for k in range(6))
    pieces = db.chunk_markdown(long_doc)
    orphan = [c for c in pieces if c.strip().startswith('#') and len(c.strip().splitlines()) == 1]
    check('no chunk is a heading alone; each heading opens, or is carried into, the chunk of its text', pieces and not orphan and all(len(c) <= 2000 for c in pieces), (len(pieces), orphan[:1]))
    small_doc = db.chunk_markdown('# DAST\n\nDynamic testing.\n\n## Tools\n\nZAP, Burp.')
    check('a short document is one chunk with its headings and text together', len(small_doc) == 1 and '# DAST' in small_doc[0] and '## Tools' in small_doc[0] and 'Burp' in small_doc[0], small_doc)

    # --- the same embedder reopens the index intact ---
    again = VectorDBManager(db_path=DB, embedding_model=FakeEmbedder(384, 'fake/small-384'))
    check('reopening with the same embedder keeps the index (2 documents)', again.table is not None and len(again.get_indexed_documents()) == 2)

    # --- a different-dimension embedder: dropped on open, search safe, rebuild works ---
    big = FakeEmbedder(768, 'fake/big-768')
    other = VectorDBManager(db_path=DB, embedding_model=big)
    fp = json.load(open(os.path.join(DB, 'embedder.json')))
    check('an index built by a 384d model is dropped when opened by a 768d embedder, fingerprint rewritten', other.table is None and fp == {'model': 'fake/big-768', 'dim': 768}, fp)
    check('search on the dropped index returns [] (no exception, plain-chat fallback)', other.search('running application', top_k=5, dataset_ids=[1, 2]) == [])
    rebuilt = other.index_document(1, 'DAST', '# DAST\n\nRewritten: fuzzing of HTTP endpoints only.', 'AI Security')
    check('the next indexing run rebuilds the table with the new embedder (nothing skipped by a stale checksum)', rebuilt['indexed'] and other.search('fuzzing http endpoints', top_k=1, dataset_ids=[1]) != [])

    # --- same dimension, different model: dropped too ---
    sibling = VectorDBManager(db_path=DB, embedding_model=FakeEmbedder(768, 'fake/other-768'))
    check('the same dimension from a different model is dropped as well (no quiet nonsense)', sibling.table is None and json.load(open(os.path.join(DB, 'embedder.json')))['model'] == 'fake/other-768')

    # --- a legacy index without a fingerprint ---
    legacy = VectorDBManager(db_path=DB, embedding_model=FakeEmbedder(768, 'fake/other-768'))
    legacy.index_document(5, 'Note', '# Note\n\nSome text to embed.', 'Ops')
    os.remove(os.path.join(DB, 'embedder.json'))
    kept = VectorDBManager(db_path=DB, embedding_model=FakeEmbedder(768, 'fake/other-768'))
    check('a pre-fingerprint index whose vector width matches is kept and stamped', kept.table is not None and len(kept.get_indexed_documents()) == 1 and os.path.exists(os.path.join(DB, 'embedder.json')))
    os.remove(os.path.join(DB, 'embedder.json'))
    dropped = VectorDBManager(db_path=DB, embedding_model=FakeEmbedder(384, 'fake/small-384'))
    check('a pre-fingerprint index whose vector width differs is dropped', dropped.table is None)

    # --- a search error inside LanceDB never raises ---
    class Boom:
        def search(self, *a, **k):
            raise RuntimeError('lance exploded')
    dropped.table = Boom()
    check('any LanceDB error during a search yields [] rather than a 500', dropped.search('x', top_k=3, dataset_ids=[1]) == [])

    # --- per-account index path ---
    import extensions
    import user_context
    saved = user_context.user_home
    try:
        user_context.user_home = lambda: '/tmp/acct-alpha'
        a = extensions.vector_db_path()
        user_context.user_home = lambda: '/tmp/acct-beta'
        b = extensions.vector_db_path()
    finally:
        user_context.user_home = saved
    check('the index path resolves under the request\'s home: two accounts, two directories', a == '/tmp/acct-alpha/.jacarium/vector_db' and b == '/tmp/acct-beta/.jacarium/vector_db', (a, b))

    # --- the chat page refreshes the selection before a dataset turn ---
    page = open(os.path.join(REPO, 'src', 'components', 'AIChatPage.jsx')).read()
    helper = open(os.path.join(REPO, 'src', 'utils', 'ragIndex.js')).read()
    check('AIChatPage re-indexes the selected documents before the RAG request (edits since the dataset was saved become searchable)',
          "await indexDatasetDocuments(backendUrl, datasets.documentIds);" in page and page.index('indexDatasetDocuments(backendUrl') < page.index('await handleStreamingResponse(endpoint, requestBody, updatedMessages)')
          and '/api/embeddings/index' in helper)

    exit_code = 0 if all(ok for _, ok in results) else 1
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    results.append(('UNEXPECTED ERROR: %s' % e, False))
    exit_code = 1
finally:
    shutil.rmtree(LAB, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print('\n%d/%d checks passed' % (len(results) - len(failed), len(results)))
if failed:
    print('Failed:')
    for n in failed:
        print('  - ' + n)
sys.exit(exit_code)
