#!/usr/bin/env python3
"""
Guards the fix for "asked a second question, the AI answered the first one
again" in dataset (RAG) chats - backend/rag_chat.py.

THE BUG: every RAG turn built its vector-search query by concatenating the
previous assistant answer with the new question (_build_retrieval_query),
and _filter_relevant_chunks was applied against that SAME widened query.
A RAG answer is near-verbatim dataset text, so from turn 2 onward the query
matched the PREVIOUS question's chunks almost perfectly (measured on a
test corpus with bge-small-en-v1.5: cosine distance 0.13 for the polluted
query vs 0.58 for the bare question against the same unrelated chunk).
0.13 is far below STRONG_MATCH_THRESHOLD (0.30), so the old topic's chunks
were kept unconditionally no matter what the user asked next. The model was
then handed the FIRST question's context with instructions to answer from
it, so it either re-answered the old topic or refused ("the context does
not contain..."), while the plain-chat fallback that would have answered
correctly never triggered.

THE FIX: _retrieve_relevant_chunks() (used by both /api/ai/chat-rag and
/api/ai/chat-rag-stream) searches and relevance-filters with the BARE
question - the thresholds were calibrated for exactly that shape - for
every question EXCEPT anaphoric follow-ups. The widened previous-answer
query is only used for questions _is_anaphoric_followup() classifies as
follow-ups: content-light (<= MAX_ANAPHORIC_CONTENT_TOKENS non-stopword
tokens) AND carrying a referential marker ("it", "its", "the second one",
...), i.e. questions that cannot retrieve (or be answered) without the
previous turn. A contentful question whose own search finds nothing
relevant returns [] so the caller falls back to plain (non-RAG) chat.

(A later round found and fixed the complementary bug - a bare-question
search for a GENERIC follow-up of the shape "Which <field> was it?"
coincidentally matching unrelated corpus boilerplate and short-circuiting
the follow-up path. That decision rule, where anaphoric questions are keyed
to the previous answer INSTEAD of the bare question, is covered by
tests/rag_anaphoric_followup_wrong_case.test.py; this file guards the
original direction: self-contained questions must never inherit the
previous topic's context.)

This test drives _retrieve_relevant_chunks with a fake vector DB (no
embeddings/lancedb needed) that returns the exact score shapes measured
while reproducing the bug, and asserts:
  1. contentful question unrelated to the dataset -> no chunks, and the
     polluted query is never even searched (falls back to plain chat)
  2. anaphoric follow-up -> widened search rescues the previous topic's
     chunks (the feature _build_retrieval_query exists for), and the bare
     question - unreliable by construction for such questions - is never
     searched
  3. contentful dataset-related question -> kept from the bare-question
     search alone (single search call)
  4. no previous assistant message + content-light question -> no widened
     search possible (widened query would equal the bare one)
  5. both RAG endpoints actually route retrieval through the fixed helper

This test is self-contained with NO test framework, following this repo's
convention (see ai_chat_timeout.test.py).

Run:  backend/venv/bin/python tests/rag_followup_query_pollution.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import inspect
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


PARIS_CHUNK_TEXT = ('Paris is the capital of France. The Eiffel Tower is located in '
                    'Paris. Paris has a population of about 2.1 million people.')


def paris_chunk(score):
    return {
        'doc_id': 9001,
        'doc_title': 'Paris Facts',
        'doc_category': 'Geography',
        'chunk_text': PARIS_CHUNK_TEXT,
        'score': score,
    }


class FakeVectorDB:
    """Returns canned scores: bare-question searches look irrelevant to the
    Paris chunk, previous-answer-widened searches look near-identical to it
    (the exact shape measured while reproducing the bug)."""

    def __init__(self, bare_score=0.58, widened_score=0.13):
        self.calls = []
        self.bare_score = bare_score
        self.widened_score = widened_score

    def search(self, query, top_k=5, dataset_ids=None):
        self.calls.append(query)
        # The widened query is "<prev assistant answer>\n<question>"
        widened = '\n' in query
        return [paris_chunk(self.widened_score if widened else self.bare_score)]


exit_code = 1
try:
    import rag_chat

    Q1 = 'What is the capital of France?'
    A1 = ('The capital of France is Paris [1]. Paris is home to the Eiffel Tower, '
          'and the Seine river flows through Paris.')

    # ---------- 1. contentful unrelated question -> plain-chat fallback ----------
    unrelated = 'How many moons does Mars have?'
    messages = [
        {'role': 'user', 'content': Q1},
        {'role': 'assistant', 'content': A1},
        {'role': 'user', 'content': unrelated},
    ]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages, unrelated, [9001], 5)
    check('unrelated contentful question -> no chunks kept (plain-chat fallback)',
          kept == [], kept)
    check('unrelated contentful question -> the answer-widened query is never searched',
          len(fake.calls) == 1 and '\n' not in fake.calls[0], fake.calls)

    # The bug's mechanism, pinned down: had the widened query been used and
    # filtered against (the old behavior), the chunk would have been kept
    # unconditionally as a "strong match".
    polluted_query = rag_chat._build_retrieval_query(messages, unrelated)
    check('sanity: widened query would defeat the relevance filter (mechanism of the bug)',
          rag_chat._filter_relevant_chunks(polluted_query, [paris_chunk(0.13)]) != [] and
          rag_chat._filter_relevant_chunks(unrelated, [paris_chunk(0.58)]) == [])

    # ---------- 2. anaphoric follow-up rescued by the widened query ----------
    followup = 'What about its population?'
    check('sanity: follow-up is classified anaphoric (content-light + referential marker)',
          rag_chat._is_anaphoric_followup(followup),
          rag_chat._content_tokens(followup))
    messages_fu = [
        {'role': 'user', 'content': Q1},
        {'role': 'assistant', 'content': A1},
        {'role': 'user', 'content': followup},
    ]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages_fu, followup, [9001], 5)
    check('anaphoric follow-up -> previous topic chunks kept via the widened query',
          len(kept) == 1 and kept[0]['doc_id'] == 9001, kept)
    check('anaphoric follow-up -> only widened searches, bare question never searched',
          len(fake.calls) >= 1 and all('\n' in c for c in fake.calls),
          fake.calls)

    # ---------- 3. dataset-related question kept from bare search alone ----------
    related = 'Which river flows through Paris?'
    fake = FakeVectorDB(bare_score=0.20)
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages, related, [9001], 5)
    check('dataset-related question -> chunks kept from the bare-question search',
          len(kept) == 1 and kept[0]['doc_id'] == 9001, kept)
    check('dataset-related question -> single search call (no widened pass)',
          len(fake.calls) == 1, fake.calls)

    # ---------- 4. content-light question with no previous assistant turn ----------
    first_turn = [{'role': 'user', 'content': 'the second one?'}]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(first_turn, 'the second one?', [9001], 5)
    check('content-light first-turn question -> no widened pass possible, no chunks',
          kept == [] and len(fake.calls) == 1, (kept, fake.calls))

    # ---------- 5. both endpoints route retrieval through the fixed helper ----------
    module_src = inspect.getsource(rag_chat)
    check('chat-rag endpoint uses _retrieve_relevant_chunks',
          module_src.count('_retrieve_relevant_chunks(') >= 3)  # def + 2 call sites
    for fn_name in ('ai_chat_rag', 'ai_chat_rag_stream'):
        fn_src = inspect.getsource(getattr(rag_chat, fn_name))
        check(f'{fn_name} calls _retrieve_relevant_chunks',
              '_retrieve_relevant_chunks(' in fn_src)
        check(f'{fn_name} no longer searches with the widened query unconditionally',
              'search(\n                retrieval_query' not in fn_src and
              'retrieval_query,' not in fn_src)

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception:
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    sys.exit(exit_code)
