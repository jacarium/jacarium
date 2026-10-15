"""RAG (Retrieval-Augmented Generation) routes: /api/embeddings/* and /api/ai/chat-rag*."""
import re

from flask import Blueprint, request, jsonify

# VECTOR_DB_AVAILABLE is mutated by extensions.get_vector_db() on first
# failure, so read it via the module attribute (a from-import would snapshot
# the initial value and never see the flip to False).
import extensions
from extensions import debug_print, get_vector_db
from doc_ids import validate_doc_id, validate_doc_ids
from ai_chat import handle_custom_chat, handle_custom_chat_stream

rag_chat = Blueprint('rag_chat', __name__)

# Chunks whose cosine distance exceeds this are considered irrelevant and
# dropped before building the augmented prompt (lower distance = more similar).
#
# Thresholds measured empirically against a test corpus of a few hundred
# chunks (bge-small-en-v1.5): genuinely relevant chunks scored
# 0.17-0.30; completely off-topic queries (e.g. cooking recipes) still
# scored 0.42-0.51, so the previous 0.6 cutoff filtered essentially nothing.
# 0.40 drops the obvious junk while keeping ~0.10 margin above the worst
# observed genuine match (0.296).
RELEVANCE_THRESHOLD = 0.40

# Below this distance the semantic match is strong enough to trust on its
# own. Between STRONG_MATCH_THRESHOLD and RELEVANCE_THRESHOLD lies an
# ambiguous band where, on the same measurements, topically-similar but
# actually-unrelated chunks (a known bi-encoder failure mode on short
# technical text) scored 0.30-0.40 - indistinguishable from weak true
# matches by distance alone. In that band we additionally require lexical
# corroboration: at least one non-stopword query token appearing in the
# chunk text. Measured on the same corpus, such false positives shared 0
# content tokens with the query while true matches shared 1-5.
#
# LIMIT of these thresholds: they assume the query's own words describe what
# the user wants. A short GENERIC question whose words are corpus boilerplate
# breaks that assumption - a follow-up of the shape "Which <field> was it?"
# scored 0.2738 (below STRONG_MATCH_THRESHOLD, kept with no lexical check)
# against an arbitrary unrelated document's boilerplate header, and the
# question's literal tokens satisfy the lexical check throughout the
# ambiguous band because a large share of the indexed chunks repeat the
# same header field labels verbatim. No threshold
# can distinguish those coincidences from real matches; such questions are
# instead routed away from the bare-question search entirely (see
# _is_anaphoric_followup / _retrieve_followup_chunks).
STRONG_MATCH_THRESHOLD = 0.30

# Minimal English stopword list for the lexical-corroboration check
# (stdlib-only on purpose; this is a coarse second signal, not real IR).
_STOPWORDS = frozenset({
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
    'while', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'once',
    'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
    'had', 'having', 'do', 'does', 'did', 'doing', 'would', 'could',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'how', 'why', 'where', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'me', 'him', 'her', 'them', 'us', 'my', 'your', 'his', 'its', 'our',
    'their', 'am', 'get', 'got', 'please', 'tell', 'show', 'give',
    'know', 'need', 'want', 'like', 'make', 'use', 'using',
})


def _content_tokens(text):
    """Lowercased non-stopword tokens (len > 2) for lexical overlap checks."""
    return {
        t for t in re.findall(r"[a-z0-9][a-z0-9._-]*", text.lower())
        if len(t) > 2 and t not in _STOPWORDS
    }


def _filter_relevant_chunks(query, chunks):
    """Drop retrieved chunks that are unlikely to actually be relevant.

    Two-tier gate (see threshold comments above for the measurements):
    - distance > RELEVANCE_THRESHOLD: always dropped
    - distance <= STRONG_MATCH_THRESHOLD: always kept
    - in between: kept only if at least one content token from the query
      appears in the chunk text
    """
    query_tokens = _content_tokens(query)
    kept = []
    for chunk in chunks:
        if chunk['score'] > RELEVANCE_THRESHOLD:
            continue
        if chunk['score'] > STRONG_MATCH_THRESHOLD:
            if query_tokens and not (query_tokens & _content_tokens(chunk['chunk_text'])):
                continue
        kept.append(chunk)
    return kept


# A follow-up like "what about the second one?" carries at most a couple of
# content-bearing tokens; anything above this is a self-contained question
# that must retrieve (and be relevance-filtered) on its own terms.
#
# NOTE: content-lightness alone does NOT mean a question is anaphoric - it
# must ALSO contain a referential marker (see _is_anaphoric_followup).
# "What was its launch date?" has 2 content tokens AND "its" -> anaphoric.
# "What about billing?" has 1 content token but no referent -> a NEW topic
# that must retrieve on its own terms (or fall back to plain chat), never
# inherit the previous turn's context.
MAX_ANAPHORIC_CONTENT_TOKENS = 2

# Words that refer back to something in the prior discourse. A short question
# containing one of these ("Which telescope was IT?", "what about ITS
# population?", "the second ONE?") cannot be answered - or searched - without
# the previous turn. Checked against ALL tokens of the question (these are
# stopwords, so _content_tokens never sees them).
_REFERENTIAL_MARKERS = frozenset({
    'it', 'its', 'itself', 'that', 'this', 'these', 'those',
    'they', 'them', 'their', 'theirs', 'he', 'she', 'him', 'her',
    'his', 'hers', 'one', 'ones', 'same', 'former', 'latter',
})


def _is_anaphoric_followup(question):
    """True when the question refers back to the previous turn.

    Two conditions, both required:
    - content-light: <= MAX_ANAPHORIC_CONTENT_TOKENS non-stopword tokens,
      i.e. the question's own words cannot reliably carry a vector search;
    - contains a referential marker ("it", "that", "the second one", ...),
      i.e. the question explicitly points at something already discussed.

    The marker requirement is what separates "Which telescope was it?"
    (anaphoric - must be resolved against the previous answer) from
    "What about billing?" (short but a NEW topic - measured on the test
    corpus, widening THAT question with the previous answer dragged in the
    previous topic's chunks at 0.27 distance, re-answering the old topic).
    """
    if len(_content_tokens(question)) > MAX_ANAPHORIC_CONTENT_TOKENS:
        return False
    tokens = re.findall(r"[a-z0-9][a-z0-9._-]*", question.lower())
    return any(t in _REFERENTIAL_MARKERS for t in tokens)


def _previous_assistant_content(messages):
    """The assistant message immediately preceding the last user message, or None."""
    prev_assistant_content = None
    seen_last_user = False
    for msg in reversed(messages):
        if not seen_last_user:
            if msg.get('role') == 'user':
                seen_last_user = True
            continue
        if msg.get('role') == 'assistant':
            prev_assistant_content = msg.get('content') or ''
            break
    return prev_assistant_content or None


def _build_retrieval_query(messages, last_user_message):
    """Build the widened vector-search query for anaphoric follow-ups.

    Concatenates the immediately preceding assistant message (if any) with the
    last user message so follow-up questions like "what about the second one?"
    carry enough semantic content for retrieval. Only the search query changes;
    the message sent to the LLM is untouched.

    IMPORTANT: only use this query for questions _is_anaphoric_followup()
    classifies as follow-ups (see _retrieve_followup_chunks). A RAG answer is
    near-verbatim dataset text, so a query widened with it matches the
    PREVIOUS question's chunks almost perfectly (measured on the test corpus:
    0.13 distance vs 0.58 for the same question without pollution), which
    defeats the relevance filter and pins every later answer to the first
    question's context - the "AI answered my first question again" bug.
    """
    prev_assistant_content = _previous_assistant_content(messages)
    if not prev_assistant_content:
        return last_user_message

    # Keep the query a reasonable length: take the tail of a long assistant reply
    if len(prev_assistant_content) > 500:
        prev_assistant_content = prev_assistant_content[-500:]

    return f"{prev_assistant_content}\n{last_user_message}"


# Tuning for _retrieve_followup_chunks, measured on a test corpus
# (bge-small-en-v1.5, a few hundred chunks across ~85 documents, most of
# them sharing one structured metadata header, so the header's field-label
# tokens repeat corpus-wide):
#
# - Distance CANNOT identify the referent of a follow-up. For the widened
#   query "<answer about the doc just discussed>\nWhich <field> was it?"
#   the true referent chunk ranked 9th at 0.2986 while eight OTHER docs'
#   boilerplate chunks scored 0.2743-0.2986 - indistinguishable. With
#   top_k=5 the right chunk would not even be in the pool, hence the deep
#   candidate pool.
ANAPHORA_CANDIDATE_POOL = 25
# - Lexical overlap with the PREVIOUS ANSWER identifies it decisively, once
#   each shared token is weighted by 1/(number of candidate chunks containing
#   it) so corpus-wide boilerplate tokens (the shared header's field labels
#   and similar terms - present in ~20 of 25 candidates) contribute almost
#   nothing:
#     near-verbatim RAG answer:  true referent 10.71 vs best noise 1.88
#     paraphrased answer:        true referent  2.31 vs best noise 1.36
#     terse / plain-chat answer: everything <= 1.44 (no referent to find;
#       plain chat sees the full history and resolves the anaphor itself)
#   The floor sits between those populations; the relative cut keeps only
#   the winning document(s) when the floor is passed (10.71 vs 1.88 and
#   2.31 vs 1.36 both separate cleanly at half the best score).
ANAPHORA_REFERENT_FLOOR = 2.0
ANAPHORA_REFERENT_RELATIVE = 0.5


def _retrieve_followup_chunks(messages, last_user_message, dataset_ids, retrieval_k, log_prefix='[RAG]'):
    """Retrieve chunks for an anaphoric follow-up, keyed to the PREVIOUS answer.

    Returns None when there is no previous assistant answer to resolve the
    anaphor against (the caller falls back to the bare-question pass), else
    the chunks to use ([] meaning: nothing conversation-tied found, fall back
    to plain chat - which sees the full history and can resolve the referent
    from the previous answer's own text).

    Three stages (see the ANAPHORA_* comments above for the measurements):
    1. Deep search with the answer-widened query (pool >> retrieval_k,
       because distance alone ranks the true referent BELOW other documents'
       boilerplate), gated at RELEVANCE_THRESHOLD.
    2. Identify the referent document(s): rank candidates by rarity-weighted
       token overlap with the previous answer and keep those clearing both
       the absolute floor and the relative cut. No candidate clears them
       when the previous answer was not grounded in the dataset.
    3. Re-search the widened query restricted to the referent document(s)
       so sibling chunks surface - the chunk holding the literal answer
       (the metadata-header line naming the asked-for field) was NOT in the
       stage-1 pool at all; the restricted search returned it at 0.3364
       (kept by the filter).
    """
    prev_answer = _previous_assistant_content(messages)
    if not prev_answer:
        return None

    widened = _build_retrieval_query(messages, last_user_message)
    pool = max(retrieval_k * 5, ANAPHORA_CANDIDATE_POOL)
    candidates = get_vector_db().search(widened, top_k=pool, dataset_ids=dataset_ids)
    candidates = [c for c in candidates if c['score'] <= RELEVANCE_THRESHOLD]
    debug_print(f"{log_prefix} Anaphoric follow-up: {len(candidates)} widened-query candidates in distance gate")
    if not candidates:
        return []

    # Rarity-weighted overlap with the previous answer: each shared content
    # token counts 1/df, df = how many candidate chunks contain it. Tokens
    # every document in the corpus repeats are discounted to noise level.
    answer_tokens = _content_tokens(prev_answer)
    token_sets = [_content_tokens(c['chunk_text']) for c in candidates]
    df = {}
    for tokens in token_sets:
        for t in answer_tokens & tokens:
            df[t] = df.get(t, 0) + 1
    scored = [
        (sum(1.0 / df[t] for t in answer_tokens & tokens), chunk)
        for tokens, chunk in zip(token_sets, candidates)
    ]
    best = max(score for score, _ in scored)
    cutoff = max(ANAPHORA_REFERENT_FLOOR, best * ANAPHORA_REFERENT_RELATIVE)
    referents = [chunk for score, chunk in scored if score >= cutoff]
    if not referents:
        debug_print(f"{log_prefix} No candidate tied to the previous answer (best overlap {best:.2f}); plain-chat fallback")
        return []

    referent_ids = list(dict.fromkeys(c['doc_id'] for c in referents))
    debug_print(f"{log_prefix} Follow-up referent doc(s): {referent_ids} (best overlap {best:.2f})")
    refined = get_vector_db().search(widened, top_k=retrieval_k, dataset_ids=referent_ids)
    kept = _filter_relevant_chunks(widened, refined)
    if kept:
        return kept
    # Defensive: the restricted search should re-find the referent chunks,
    # but if it somehow keeps nothing, the identified chunks themselves
    # already passed the distance gate and the overlap cutoff.
    return referents[:retrieval_k]


def _retrieve_relevant_chunks(messages, last_user_message, dataset_ids, retrieval_k, log_prefix='[RAG]'):
    """Search the vector DB and keep only chunks relevant to the ACTUAL question.

    Decision rule:
    - Anaphoric follow-up ("Which telescope was it?" - content-light AND
      carrying a referential marker, see _is_anaphoric_followup) with a
      previous assistant answer: retrieval is keyed to that answer via
      _retrieve_followup_chunks. The bare question is NOT searched, and its
      result would never be trusted: measured on the test corpus, a bare
      follow-up of the shape "Which <field> was it?" scored 0.2738 - below
      STRONG_MATCH_THRESHOLD, kept unconditionally - against an arbitrary
      UNRELATED document's shared-header boilerplate (a large share of
      chunks repeat the header's field labels verbatim, which also defeats
      the lexical check in the 0.30-0.40 band). An earlier revision
      searched the bare question first and only widened when it kept
      nothing, so that coincidental match short-circuited the follow-up
      path exactly when it was needed and the model answered about a
      random other document.
    - Everything else: search with the bare question and relevance-filter
      against it (RELEVANCE_THRESHOLD / STRONG_MATCH_THRESHOLD were measured
      for exactly this query shape). No relevant chunks -> [] so the caller
      falls back to plain chat. Short but non-referential questions ("What
      about billing?") take this path too: they are new topics, and widening
      them with the previous answer measurably re-retrieved the previous
      topic's chunks (0.27 distance) - the original "AI answered my first
      question again" bug this function exists to prevent.
    """
    if _is_anaphoric_followup(last_user_message):
        followup_chunks = _retrieve_followup_chunks(
            messages, last_user_message, dataset_ids, retrieval_k, log_prefix=log_prefix
        )
        if followup_chunks is not None:
            return followup_chunks
        # No previous assistant answer (first turn): fall through to the
        # bare-question search below.

    chunks = get_vector_db().search(last_user_message, top_k=retrieval_k, dataset_ids=dataset_ids)
    debug_print(f"{log_prefix} Retrieved {len(chunks)} chunks for bare question")
    return _filter_relevant_chunks(last_user_message, chunks)


def _build_rag_context(retrieved_chunks, last_user_message):
    """Build the augmented prompt and citation metadata from retrieved chunks.

    Returns (augmented_content_or_None, citations). augmented_content is None
    when there are no chunks, in which case the caller should fall back to a
    plain (non-RAG) message list.
    """
    if not retrieved_chunks:
        return None, []

    context_blocks = []
    citations = []
    for idx, chunk in enumerate(retrieved_chunks, 1):
        context_blocks.append(
            f"[{idx}] FROM: \"{chunk['doc_title']}\" ({chunk['doc_category']})\n{chunk['chunk_text']}"
        )
        citations.append({
            "number": idx,
            "doc_id": chunk['doc_id'],
            "doc_title": chunk['doc_title'],
            "doc_category": chunk['doc_category']
        })

    context_text = "\n\n".join(context_blocks)
    citation_lines = "\n".join(
        f'- [{i}] refers to "{c["doc_title"]}"' for i, c in enumerate(retrieved_chunks, 1)
    )

    augmented_content = f"""I'm providing relevant context from the selected documents to help answer your question.

CRITICAL CITATION RULES:
- When referencing information, use the EXACT citation number [1], [2], etc. that matches the source.
{citation_lines}
- DO NOT mix up citation numbers - each number corresponds to ONE specific document.

---
{context_text}
---

Question: {last_user_message}

Answer the question using the context above. If the context does not contain enough information to answer, say so explicitly rather than guessing. Cite a source with [1], [2], etc. ONLY when you actually used information from that numbered excerpt in your answer. Some retrieved excerpts may turn out to be irrelevant to the question - do NOT cite those, and do not add citations just for completeness. An answer that cites only the excerpts it truly relied on (or none, if none were useful) is correct."""

    return augmented_content, citations

# RAG (Retrieval-Augmented Generation) Endpoints for Document Datasets

@rag_chat.route("/api/embeddings/index", methods=["POST"])
def index_documents():
    """
    Index documents into vector database for RAG.

    Request body:
    {
      "documents": [
        {"id": 1, "title": "Doc 1", "content": "...", "category": "Tech"},
        ...
      ]
    }

    Response:
    {
      "success": true,
      "indexed": 3,
      "skipped": 2,
      "chunks_created": 15,
      "documents": [
        {"id": 1, "indexed": true, "checksum": "abc123", "chunks": 5},
        ...
      ]
    }
    """
    if not extensions.VECTOR_DB_AVAILABLE:
        return jsonify({"success": False, "error": "RAG features not available - missing dependencies"}), 503

    try:
        data = request.json
        documents = data.get('documents', [])

        results = []
        total_indexed = 0
        total_skipped = 0
        total_chunks = 0

        for doc in documents:
            doc_id = doc.get('id')
            title = doc.get('title', 'Untitled')
            content = doc.get('content', '')
            category = doc.get('category', 'Uncategorized')

            # Ids end up inside LanceDB filter strings - only integers pass
            try:
                doc_id = validate_doc_id(doc_id)
            except ValueError as e:
                return jsonify({"success": False, "error": str(e)}), 400

            result = get_vector_db().index_document(doc_id, title, content, category)
            results.append({
                "id": doc_id,
                **result
            })

            if result['indexed']:
                total_indexed += 1
                total_chunks += result['chunks']
            else:
                total_skipped += 1

        return jsonify({
            "success": True,
            "indexed": total_indexed,
            "skipped": total_skipped,
            "chunks_created": total_chunks,
            "documents": results
        })

    except Exception as e:
        import traceback
        print(f'[RAG] Index error: {traceback.format_exc()}')
        return jsonify({"success": False, "error": str(e)}), 500


@rag_chat.route("/api/embeddings/search", methods=["POST"])
def search_embeddings():
    """
    Test endpoint for semantic search (debugging).

    Request:
    {
      "query": "How do I configure OAuth?",
      "top_k": 5,
      "dataset_ids": [1, 2, 3]  # Optional
    }

    Response:
    {
      "success": true,
      "query": "...",
      "results": [
        {
          "doc_id": 1,
          "doc_title": "Auth Guide",
          "doc_category": "Technical",
          "chunk_text": "...",
          "score": 0.89
        },
        ...
      ]
    }
    """
    if not extensions.VECTOR_DB_AVAILABLE:
        return jsonify({"success": False, "error": "RAG features not available - missing dependencies"}), 503

    try:
        data = request.json
        query = data.get('query', '')
        top_k = data.get('top_k', 5)
        try:
            dataset_ids = validate_doc_ids(data.get('dataset_ids'))
        except ValueError as e:
            return jsonify({"success": False, "error": str(e)}), 400

        results = get_vector_db().search(query, top_k=top_k, dataset_ids=dataset_ids)

        return jsonify({
            "success": True,
            "query": query,
            "results": results
        })

    except Exception as e:
        import traceback
        print(f'[RAG] Search error: {traceback.format_exc()}')
        return jsonify({"success": False, "error": str(e)}), 500


@rag_chat.route("/api/ai/chat-rag", methods=["POST"])
def ai_chat_rag():
    """
    Chat endpoint with RAG (Retrieval-Augmented Generation).

    Request:
    {
      "messages": [{role: "user", content: "..."}, ...],
      "provider": "anthropic",
      "model": "claude-sonnet-4-5@20250929",
      "temperature": 0,
      "max_tokens": 2000,
      "dataset_ids": [1, 2, 3],  # Documents to search
      "retrieval_k": 5,           # Number of chunks to retrieve
      "sshConfig": {...}          # Optional, for SSH provider
    }

    Response:
    {
      "message": "AI response",
      "retrieved_chunks": [...]  # For debugging
    }
    """
    if not extensions.VECTOR_DB_AVAILABLE:
        return jsonify({"success": False, "error": "RAG features not available - missing dependencies"}), 503

    try:
        data = request.json
        provider = data.get('provider')
        model = data.get('model')
        temperature = data.get('temperature', 0)
        max_tokens = data.get('max_tokens', 2000)

        # Only allow RAG for Ollama/Custom providers (fully local - privacy protection)
        if provider not in ['ollama', 'custom']:
            return jsonify({"error": "RAG is only available for Ollama (local) providers due to privacy concerns"}), 400

        messages = data.get('messages', [])
        try:
            dataset_ids = validate_doc_ids(data.get('dataset_ids', []))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        retrieval_k = data.get('retrieval_k', 5)

        # Get last user message for retrieval
        last_user_message = None
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                last_user_message = msg.get('content')
                break

        if not last_user_message:
            return jsonify({"error": "No user message found"}), 400

        # Retrieve chunks relevant to the user's actual question (anaphoric
        # follow-ups are keyed to the previous assistant answer; everything
        # else searches with the bare question - see _retrieve_relevant_chunks)
        retrieved_chunks = []
        if dataset_ids:
            debug_print(f"[RAG] Searching for question: {last_user_message[:100]}...")
            debug_print(f"[RAG] Filtering by dataset_ids: {dataset_ids}")
            retrieved_chunks = _retrieve_relevant_chunks(
                messages, last_user_message, dataset_ids, retrieval_k, log_prefix='[RAG]'
            )
            for idx, chunk in enumerate(retrieved_chunks, 1):
                debug_print(f"  [{idx}] doc_id={chunk['doc_id']}, title={chunk['doc_title']}, score={chunk['score']:.4f}")
            if not retrieved_chunks:
                debug_print(f"[RAG] No relevant context found above threshold {RELEVANCE_THRESHOLD}; falling back to plain chat")

        # Build context from retrieved chunks with numbered citations
        augmented_content, citations = _build_rag_context(retrieved_chunks, last_user_message)
        if augmented_content is not None:
            # Replace last user message with augmented version
            messages = messages[:-1] + [{"role": "user", "content": augmented_content}]

        # Now call AI provider with augmented messages
        # Only Ollama/Custom providers are allowed for RAG (validated above)
        # (model, temperature, max_tokens already extracted at top of function)

        # Call Ollama/Custom provider
        if provider == 'ollama' or provider == 'custom':
            response_message = handle_custom_chat(messages, model, temperature, max_tokens)
        else:
            # This should never happen due to validation above, but just in case
            return jsonify({"error": f"Provider {provider} not allowed for RAG"}), 400

        # (citations metadata for the frontend was built by _build_rag_context)
        return jsonify({
            "message": response_message,
            "citations": citations,  # Citation metadata for rendering clickable links
            "retrieved_chunks": retrieved_chunks  # Include for debugging
        })

    except Exception as e:
        import traceback
        print(f'[RAG] Chat error: {traceback.format_exc()}')
        return jsonify({"error": str(e)}), 500


@rag_chat.route("/api/ai/chat-rag-stream", methods=["POST"])
def ai_chat_rag_stream():
    """
    Chat endpoint with RAG and streaming support.
    Same as chat-rag but returns SSE stream.
    """
    from flask import Response, stream_with_context
    import json

    if not extensions.VECTOR_DB_AVAILABLE:
        return jsonify({"success": False, "error": "RAG features not available - missing dependencies"}), 503

    def generate():
        try:
            data = request.json
            provider = data.get('provider')
            model = data.get('model')
            temperature = data.get('temperature', 0)
            max_tokens = data.get('max_tokens', 2000)

            # Only allow RAG for Ollama/Custom providers (fully local - privacy protection)
            if provider not in ['ollama', 'custom']:
                yield f"data: {json.dumps({'error': 'RAG is only available for Ollama (local) providers due to privacy concerns'})}\n\n"
                return

            messages = data.get('messages', [])
            try:
                dataset_ids = validate_doc_ids(data.get('dataset_ids', []))
            except ValueError as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                return
            retrieval_k = data.get('retrieval_k', 5)

            # Get last user message for retrieval
            last_user_message = None
            for msg in reversed(messages):
                if msg.get('role') == 'user':
                    last_user_message = msg.get('content')
                    break

            if not last_user_message:
                yield f"data: {json.dumps({'error': 'No user message found'})}\n\n"
                return

            # Retrieve chunks relevant to the user's actual question (anaphoric
            # follow-ups are keyed to the previous assistant answer; everything
            # else searches with the bare question)
            retrieved_chunks = []
            if dataset_ids:
                debug_print(f"[RAG Stream] Searching for question: {last_user_message[:100]}...")
                debug_print(f"[RAG Stream] Filtering by dataset_ids: {dataset_ids}")
                retrieved_chunks = _retrieve_relevant_chunks(
                    messages, last_user_message, dataset_ids, retrieval_k, log_prefix='[RAG Stream]'
                )
                if not retrieved_chunks:
                    debug_print(f"[RAG Stream] No relevant context found above threshold {RELEVANCE_THRESHOLD}; falling back to plain chat")

            # Build context from retrieved chunks with numbered citations
            augmented_content, citations = _build_rag_context(retrieved_chunks, last_user_message)
            if augmented_content is not None:
                # Replace last user message with augmented version
                messages = messages[:-1] + [{"role": "user", "content": augmented_content}]

            # Stream response from Ollama/Custom provider
            for chunk in handle_custom_chat_stream(messages, model, temperature, max_tokens):
                # Add citations to the first content chunk
                if chunk.get('type') == 'content' and citations:
                    chunk['citations'] = citations
                    citations = []  # Only send once

                yield f"data: {json.dumps(chunk)}\n\n"

            # Send done signal
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f"[RAG Stream] Error: {error_trace}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream')
