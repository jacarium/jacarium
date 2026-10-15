#!/usr/bin/env python3
"""
Guards the RAG "attached datasets return wrong/irrelevant sources" fixes.

Observed: with datasets attached, the AI's cited "Sources" sometimes
had nothing to do with the answer. Investigation found two real bugs plus one
mistuned constant in backend/rag_chat.py and backend/vector_db.py:

1. Citation IndexError (regression guard): the RAG prompt used to hardcode
   `retrieved_chunks[0]` through `retrieved_chunks[4]` when building the
   citation legend, so any dataset that chunked into fewer than 5 pieces
   crashed the whole request with an IndexError. Fixed by building the legend
   from a loop in rag_chat._build_rag_context(). This test calls it with 0-4
   chunks and asserts it never raises and never references a chunk index
   beyond what was actually retrieved.

2. Stale doc_title/doc_category (Lead A): vector_db.VectorDBManager.
   index_document() has a fast path that skips re-indexing when the content
   checksum is unchanged. That path used to return without ever touching the
   stored doc_title/doc_category - so renaming a document (with no content
   change) left every future search() result citing the OLD title forever.
   A chunk whose TEXT is genuinely relevant would then look "wrong" in the UI
   because the displayed title didn't match. Fixed by updating just the
   metadata columns in place on the checksum-match path. This test indexes a
   doc, re-indexes it under a new title/category with identical content, and
   asserts search() immediately reflects the new metadata with no duplicate
   rows for that doc_id.

3. RELEVANCE_THRESHOLD mistuned (Lead B data point): the original 0.6 cosine-
   distance cutoff was measured (against a test corpus, bge-small-
   en-v1.5) to filter almost nothing - obvious off-topic chunks still scored
   0.42-0.51. It was retuned to 0.40, with an additional STRONG_MATCH_THRESHOLD
   (0.30) band that requires lexical corroboration (shared non-stopword
   tokens) for the ambiguous 0.30-0.40 range, since bi-encoder embeddings on
   short technical text can rank topically-similar-but-unrelated chunks in
   that band. This test locks in rag_chat._filter_relevant_chunks()'s
   two-tier behavior directly (no embeddings needed - it operates on
   pre-scored chunk dicts), so a future change to the thresholds or the gate
   logic has to be a deliberate, visible edit here too.

4. Prompt honesty: the augmented prompt used to say "Always cite your
   sources" unconditionally, which measurably encourages a local instruct
   model to force-cite retrieved chunks it did not actually use just to
   comply with the instruction (compounding bug #2/#3 - a stale or barely-
   relevant chunk gets cited "because the prompt said always cite"). The
   wording was changed to explicitly forbid citing irrelevant excerpts. This
   test asserts the augmented prompt text carries that instruction.

5. Chunk-size bound (existing regression, re-verified here): vector_db.
   chunk_markdown() must never emit a chunk larger than target_chars, since
   fastembed's bge-small-en-v1.5 truncates at 512 tokens and an oversized
   chunk silently loses everything past that point - which also means its
   embedding (and therefore its relevance score) doesn't represent its full
   text. chunk_markdown() doesn't use `self`, so it's called unbound to avoid
   constructing a real VectorDBManager (which needs lancedb + a loaded
   fastembed model) for this part of the test.

Checks 2 (stale metadata) additionally exercises a REAL lancedb table + the
actual fastembed model, in an isolated temp directory (never touches
~/.jacarium/vector_db). If lancedb/fastembed aren't importable, or the
embedding model can't be loaded (e.g. no network for a first-time download),
that section is SKIPPED with a clear message rather than failing the whole
suite - checks 1, 3, 4, 5 need neither and always run.

This test is self-contained with NO test framework, following this repo's
convention (see ai_chat_timeout.test.py).

Run:  backend/venv/bin/python tests/rag_relevance_filtering.test.py
Exit code 0 = all non-skipped checks passed, 1 = failure (details on stdout).
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

results = []
skipped = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


def skip(name, reason):
    skipped.append(name)
    print('SKIP: %s | %s' % (name, reason))


exit_code = 1
try:
    import rag_chat
    from vector_db import VectorDBManager

    # ---------- 1. citation IndexError regression ----------
    def fake_chunk(n, score=0.1):
        return {
            'doc_id': n,
            'doc_title': f'Doc {n}',
            'doc_category': 'Cat',
            'chunk_text': f'content of chunk {n}',
            'score': score,
        }

    for count in (0, 1, 2, 3, 4, 5):
        chunks = [fake_chunk(i) for i in range(count)]
        try:
            augmented, citations = rag_chat._build_rag_context(chunks, 'What is going on?')
            raised = None
        except Exception as e:  # noqa: BLE001 - the type is the assertion
            augmented, citations = None, None
            raised = e
        check(f'_build_rag_context does not raise with {count} chunk(s)', raised is None,
              repr(raised) if raised else '')
        if raised is None:
            if count == 0:
                check('0 chunks -> augmented_content is None (fall back to plain chat)',
                      augmented is None)
            else:
                check(f'{count} chunk(s) -> exactly {count} citation(s) returned',
                      len(citations) == count, len(citations))
                # None of the legend/citation text should reference a chunk
                # index that was never actually retrieved (the original bug:
                # hardcoded [1]-[5] referenced doc titles that didn't exist).
                for missing_idx in range(count + 1, 6):
                    check(f'{count} chunk(s) -> no reference to non-existent chunk [{missing_idx}]',
                          f'[{missing_idx}] refers to' not in augmented)

    # ---------- 3. RELEVANCE_THRESHOLD / STRONG_MATCH_THRESHOLD two-tier gate ----------
    check('RELEVANCE_THRESHOLD is 0.40 (retuned from the original 0.6 - see docstring)',
          abs(rag_chat.RELEVANCE_THRESHOLD - 0.40) < 1e-9, rag_chat.RELEVANCE_THRESHOLD)
    check('STRONG_MATCH_THRESHOLD (0.30) is below RELEVANCE_THRESHOLD',
          rag_chat.STRONG_MATCH_THRESHOLD < rag_chat.RELEVANCE_THRESHOLD)

    query = 'How do I configure the kubelet MetalLB deployment?'

    strong_match_no_overlap = {
        'doc_id': 1, 'doc_title': 'Kubernetes Networking', 'doc_category': 'Tech',
        'chunk_text': 'This chunk happens to share no words with the query.',
        'score': 0.20,  # well below STRONG_MATCH_THRESHOLD
    }
    obvious_junk = {
        'doc_id': 2, 'doc_title': 'Sourdough Recipe', 'doc_category': 'Cooking',
        'chunk_text': 'Feed the starter and let it rise for kubelet MetalLB hours.',
        'score': 0.55,  # above RELEVANCE_THRESHOLD, even with contrived overlap
    }
    ambiguous_with_overlap = {
        'doc_id': 3, 'doc_title': 'Deployment Notes', 'doc_category': 'Tech',
        'chunk_text': 'The kubelet configuration steps are documented here.',
        'score': 0.35,  # between the two thresholds, shares "kubelet"
    }
    ambiguous_no_overlap = {
        'doc_id': 4, 'doc_title': 'Unrelated Notes', 'doc_category': 'Tech',
        'chunk_text': 'This paragraph is about something else entirely.',
        'score': 0.35,  # same band, no shared tokens
    }

    kept = rag_chat._filter_relevant_chunks(query, [
        strong_match_no_overlap, obvious_junk, ambiguous_with_overlap, ambiguous_no_overlap,
    ])
    kept_ids = {c['doc_id'] for c in kept}

    check('strong match (score <= 0.30) kept even without lexical overlap',
          1 in kept_ids, kept_ids)
    check('obvious junk (score > 0.40) dropped',
          2 not in kept_ids, kept_ids)
    check('ambiguous band + lexical overlap -> kept',
          3 in kept_ids, kept_ids)
    check('ambiguous band + no lexical overlap -> dropped',
          4 not in kept_ids, kept_ids)

    # ---------- 4. prompt honesty wording ----------
    augmented, _ = rag_chat._build_rag_context([fake_chunk(1, 0.1)], 'test question')
    check('prompt tells the model not to force-cite irrelevant excerpts',
          'do not cite those' in augmented.lower() or 'do not add citations' in augmented.lower())
    check('prompt still allows "not enough information" honesty',
          'does not contain enough information' in augmented.lower())

    # ---------- 5. chunk_markdown size bound ----------
    target_chars = 500 * 4  # chunk_size=500 default * 4 chars/token estimate
    no_punctuation_blob = ' '.join(f'token{i}' for i in range(2000))  # ~14000 chars, no sentence breaks
    markdown_with_headers = '\n\n'.join(
        f'## Section {i}\n' + ('word ' * 300) for i in range(5)
    )

    for label, content in (
        ('punctuation-free blob', no_punctuation_blob),
        ('markdown with headers', markdown_with_headers),
    ):
        chunks = VectorDBManager.chunk_markdown(None, content)
        oversized = [c for c in chunks if len(c) > target_chars]
        check(f'chunk_markdown keeps every chunk <= {target_chars} chars ({label})',
              not oversized, f'{len(oversized)} oversized of {len(chunks)} total')

    # ---------- 2. stale metadata refresh on checksum-match path ----------
    tmp_dir = tempfile.mkdtemp(prefix='rag_test_vector_db_')
    try:
        try:
            vdb = VectorDBManager(db_path=tmp_dir)
            vdb_available = True
        except Exception as e:  # noqa: BLE001 - lancedb/fastembed unavailable or no model cached
            vdb_available = False
            skip('stale metadata refresh checks', f'could not init VectorDBManager: {e}')

        if vdb_available:
            content = 'Fixed content about widgets that never changes across renames.'

            first = vdb.index_document(101, 'Original Title', content, 'Cat A')
            check('first index_document() call actually indexes', first.get('indexed') is True, first)

            before_count = len(vdb.table.search().where('doc_id = 101').to_list())

            renamed = vdb.index_document(101, 'Renamed Title', content, 'Cat B')
            check('same content + new title -> NOT re-indexed (no re-embedding needed)',
                  renamed.get('indexed') is False, renamed)
            check('same content + new title -> reason mentions the metadata refresh',
                  'refreshed' in renamed.get('reason', '').lower(), renamed.get('reason'))

            after_count = len(vdb.table.search().where('doc_id = 101').to_list())
            check('metadata refresh does not duplicate or drop rows',
                  after_count == before_count, (before_count, after_count))

            hits = vdb.search('widgets', top_k=5, dataset_ids=[101])
            check('search() found the renamed document', len(hits) > 0, len(hits))
            if hits:
                check('search() reflects the NEW title (not stale)',
                      hits[0]['doc_title'] == 'Renamed Title', hits[0]['doc_title'])
                check('search() reflects the NEW category (not stale)',
                      hits[0]['doc_category'] == 'Cat B', hits[0]['doc_category'])
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed, %d skipped' % (passed, len(results), len(skipped)))
    exit_code = 0 if passed == len(results) else 1
except Exception:
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    sys.exit(exit_code)
