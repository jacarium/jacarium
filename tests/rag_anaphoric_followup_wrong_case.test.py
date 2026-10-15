#!/usr/bin/env python3
"""
Guards the fix for "follow-up question retrieved a completely unrelated
document" in dataset (RAG) chats - backend/rag_chat.py.

THE BUG: the user asked a content-bearing question and got a correct answer
naming the document it came from. They then asked a short "Which <field>
was it?" follow-up - a genuine follow-up whose "it" refers to the document
just discussed - and the app retrieved a completely unrelated document's
chunks and answered about THAT document.

MECHANISM (score shapes measured while reproducing the bug on a test
corpus, bge-small-en-v1.5, a few hundred chunks across ~85 documents, most of them
documents in a single category that all open with an identical structured
metadata header, so the header's field-label tokens repeat corpus-wide.
EVERYTHING below - the document schema, field labels, category name,
titles, people and numbers - is an invented synthetic stand-in for that
*shape*, not data or formatting from any real corpus. The fixtures use a
made-up amateur-astronomy club corpus of "Observation Logs" that all open
with the same '## Session Overview - **Telescope:** ... - **Observer:**
...' header):

- A bare short follow-up of the shape "Which <field> was it?" scored 0.2738
  against an ARBITRARY unrelated document's boilerplate chunk - below
  STRONG_MATCH_THRESHOLD (0.30), so it was kept unconditionally, and the
  whole 0.30-0.40 ambiguous band passed the lexical-corroboration check via
  the field-label tokens every document's header repeats (here: every log
  repeats "telescope"). The bare pass kept 8 chunks, every one of them a
  WRONG document.
- The previous revision of _retrieve_relevant_chunks only widened the query
  with the previous answer when the bare pass kept NOTHING, so a non-empty
  (but coincidental and wrong) bare result short-circuited the follow-up
  path exactly when it was most needed.
- Widening alone is ALSO insufficient on such a corpus: for the widened
  query the true referent chunk ranked 9th at 0.2986 while eight other
  documents' boilerplate chunks scored 0.2743-0.2986 - distance cannot
  identify the referent of a follow-up when every document shares
  boilerplate.

THE FIX (rag_chat._is_anaphoric_followup + _retrieve_followup_chunks):
- A question that is content-light (<= MAX_ANAPHORIC_CONTENT_TOKENS
  non-stopword tokens) AND contains a referential marker ("it", "its",
  "that", "the second one", ...) is classified anaphoric and its retrieval
  is keyed to the PREVIOUS ASSISTANT ANSWER instead of the bare question:
  1. deep search (ANAPHORA_CANDIDATE_POOL) with the answer-widened query,
     gated at RELEVANCE_THRESHOLD;
  2. rank candidates by rarity-weighted token overlap with the previous
     answer (each shared token counts 1/df across the candidate pool, so
     corpus-wide boilerplate tokens are discounted); keep only candidates
     clearing ANAPHORA_REFERENT_FLOOR and ANAPHORA_REFERENT_RELATIVE of the
     best score. Measured separation: true referent 10.71 vs best noise
     1.88 (near-verbatim answer), 2.31 vs 1.36 (paraphrased answer),
     everything <= 1.44 when the previous answer was not dataset-grounded;
  3. re-search restricted to the identified referent document(s) so sibling
     chunks surface (the chunk holding the literal answer - here the
     '**Telescope:** ...' header line - was not in the stage-1 pool at all;
     the restricted search returned it at 0.3364 and the filter kept it).
- If no candidate is tied to the previous answer, return [] - the plain-chat
  fallback sees the full history and resolves the anaphor from the previous
  answer's own text - rather than handing the model a confident WRONG chunk.
- Short questions WITHOUT a referential marker ("What about billing?") are
  NEW topics: they take the bare-question path and are never widened
  (measured: widening them dragged the previous topic's chunks back in at
  0.27 distance - the original followup-query-pollution bug).

This test drives _retrieve_relevant_chunks with a fake vector DB (no
embeddings/lancedb needed) that returns the exact score shapes measured
while reproducing the bug, and asserts both directions:
  (a) the anaphoric follow-up retrieves ONLY the prior turn's document -
      including the boilerplate chunk holding the literal answer to the
      follow-up - and never the coincidentally-matching wrong document;
  (b) a short but non-referential new question does not inherit the
      previous topic, and a previous answer that was not grounded in the
      dataset yields [] (plain-chat fallback), not coincidental chunks.

This test is self-contained with NO test framework, following this repo's
convention (see rag_followup_query_pollution.test.py).

Run:  backend/venv/bin/python tests/rag_anaphoric_followup_wrong_case.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
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


def chunk(doc_id, title, text):
    return {
        'doc_id': doc_id,
        'doc_title': title,
        'doc_category': 'Observation Logs',
        'chunk_text': text,
    }


# The observation log the conversation is actually about (doc 100 =
# fictional session "OBS-1001" observed with the fictional "Meridian
# 24-inch reflector" - the whole schema is an invented stand-in, see the
# module docstring).
JUPITER_BOILER = chunk(100, 'OBS-1001',
                       '## Session Overview\n- **Telescope:** Meridian 24-inch reflector\n'
                       '- **Observer:** Priya Raman\n'
                       '- **Sky Rating:** 8/10')
JUPITER_TECH = chunk(100, 'OBS-1001',
                     'A double shadow transit of Io and Europa was recorded crossing '
                     'the disk of Jupiter. Both umbrae stayed cleanly resolved for '
                     'the full ninety minutes of the event.')
# Unrelated (fictional) logs whose boilerplate coincidentally matches "telescope".
LUNAR_BOILER = chunk(200, 'OBS-1002',
                     '## Session Overview\n- **Telescope:** Foothill 10-inch Dobsonian\n'
                     '- **Observer:** Marcus Bell\n'
                     '- **Sky Rating:** 6/10')
COMET_BOILER = chunk(300, 'OBS-1003',
                     '## Session Overview\n- **Telescope:** Ridgeline 80mm refractor\n'
                     '- **Observer:** Elena Voss\n- **Sky Rating:** 7/10')


class FakeVectorDB:
    """Returns the score shapes measured while reproducing the bug.

    Bare short-question searches ('\\n' not in query) coincidentally rank an
    UNRELATED log's boilerplate at 0.2738 (below STRONG_MATCH_THRESHOLD);
    answer-widened searches ('\\n' in query) rank other logs' boilerplate
    (0.2743-0.2947) ABOVE the true referent chunk (0.2986) - distance alone
    cannot pick the referent. dataset_ids restriction is honored, mirroring
    vector_db.VectorDBManager.search().
    """

    BARE = [(LUNAR_BOILER, 0.2738), (JUPITER_BOILER, 0.3105), (COMET_BOILER, 0.3117), (JUPITER_TECH, 0.45)]
    WIDENED = [(LUNAR_BOILER, 0.2743), (COMET_BOILER, 0.2947), (JUPITER_TECH, 0.2986), (JUPITER_BOILER, 0.3364)]
    # "What about billing?" measured 0.3895-0.40: inside the ambiguous band,
    # dropped by the lexical check ("billing" appears in no chunk).
    BILLING = [(JUPITER_BOILER, 0.3895), (LUNAR_BOILER, 0.3901), (COMET_BOILER, 0.3980), (JUPITER_TECH, 0.3985)]

    def __init__(self):
        self.calls = []  # list of (query, dataset_ids)

    def search(self, query, top_k=5, dataset_ids=None):
        self.calls.append((query, dataset_ids))
        if '\n' in query:
            scored = self.WIDENED
        elif 'billing' in query.lower():
            scored = self.BILLING
        else:
            scored = self.BARE
        out = []
        for c, score in sorted(scored, key=lambda cs: cs[1]):
            if dataset_ids is not None and c['doc_id'] not in dataset_ids:
                continue
            out.append(dict(c, score=score))
        return out[:top_k]


exit_code = 1
try:
    import rag_chat

    Q1 = 'Which session recorded the double shadow transit?'
    A1 = ('The double shadow transit of Io and Europa was recorded in session '
          'OBS-1001 by Priya Raman, using the Meridian 24-inch reflector [1]. '
          'Both umbrae stayed cleanly resolved for the full ninety minutes of '
          'the event.')
    FOLLOWUP = 'Which telescope was it?'

    # ---------- classification: referential marker + content-lightness ----------
    for q, expected in (
        (FOLLOWUP, True),                    # "it" + {telescope}
        ('what about the second one?', True),  # "one"
        ('What about its population?', True),  # "its"
        ('What was the sky rating for that?', True),  # "that"
        ('What about billing?', False),      # short but NO referent: new topic
        ('How many moons does Mars have?', False),   # contentful
        ('Which telescope was the Io Europa double transit session?', False),  # carries its own content
    ):
        check('classification: %r -> %s' % (q, 'anaphoric' if expected else 'not anaphoric'),
              rag_chat._is_anaphoric_followup(q) is expected,
              rag_chat._content_tokens(q))

    # ---------- the bug's mechanism, pinned down ----------
    # The bare phrase coincidentally scores 0.2738 against the WRONG log's
    # boilerplate: below STRONG_MATCH_THRESHOLD, so the relevance filter
    # keeps it unconditionally - which is why "widen only when the bare pass
    # kept nothing" could never fire for this class of question.
    coincidental = dict(LUNAR_BOILER, score=0.2738)
    check('sanity: bare-question filter keeps the coincidental WRONG-document match (the trap)',
          rag_chat._filter_relevant_chunks(FOLLOWUP, [coincidental]) != [])

    # ---------- (a) anaphoric follow-up -> the prior turn's document, not the trap ----------
    messages = [
        {'role': 'user', 'content': Q1},
        {'role': 'assistant', 'content': A1},
        {'role': 'user', 'content': FOLLOWUP},
    ]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages, FOLLOWUP, None, 5)
    kept_ids = {c['doc_id'] for c in kept}
    check('follow-up keeps only the prior turn\'s document (doc 100)',
          kept and kept_ids == {100}, kept_ids)
    check('follow-up result includes the chunk holding the literal telescope name',
          any('Meridian' in c['chunk_text'] for c in kept),
          [c['chunk_text'][:40] for c in kept])
    check('the coincidentally-matching wrong documents are never returned',
          200 not in kept_ids and 300 not in kept_ids, kept_ids)
    check('the bare question is never searched for an anaphoric follow-up',
          all('\n' in q for q, _ in fake.calls),
          [q[:40] for q, _ in fake.calls])
    check('final search is restricted to the identified referent document',
          fake.calls and fake.calls[-1][1] == [100], fake.calls[-1][1])

    # ---------- (b1) short NON-referential question -> new topic, no inheritance ----------
    new_topic = 'What about billing?'
    messages_b = messages[:2] + [{'role': 'user', 'content': new_topic}]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages_b, new_topic, None, 5)
    check('short non-referential question -> no chunks (plain-chat fallback)',
          kept == [], kept)
    check('short non-referential question -> single bare search, never widened',
          len(fake.calls) == 1 and '\n' not in fake.calls[0][0], fake.calls)

    # ---------- (b2) anaphoric follow-up to a NON-dataset-grounded answer ----------
    # The previous answer shares no content with any candidate chunk, so no
    # referent clears ANAPHORA_REFERENT_FLOOR: return [] (plain chat resolves
    # "which one" from the history) instead of the coincidental wrong chunks.
    messages_c = [
        {'role': 'user', 'content': 'Does Mars have moons?'},
        {'role': 'assistant', 'content': 'Mars has two moons, Phobos and Deimos. '
                                         'Phobos is larger and orbits closest.'},
        {'role': 'user', 'content': 'Which one is bigger?'},
    ]
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(messages_c, 'Which one is bigger?', None, 5)
    check('follow-up to an ungrounded answer -> no chunks (plain-chat fallback)',
          kept == [], kept)
    check('follow-up to an ungrounded answer -> bare question still never searched',
          all('\n' in q for q, _ in fake.calls), [q[:40] for q, _ in fake.calls])

    # ---------- first turn: anaphoric wording but nothing to refer to ----------
    fake = FakeVectorDB()
    rag_chat.get_vector_db = lambda: fake
    kept = rag_chat._retrieve_relevant_chunks(
        [{'role': 'user', 'content': FOLLOWUP}], FOLLOWUP, None, 5)
    check('anaphoric wording on the FIRST turn -> falls through to the bare pass',
          len(fake.calls) == 1 and '\n' not in fake.calls[0][0], fake.calls)

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception:
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    sys.exit(exit_code)
