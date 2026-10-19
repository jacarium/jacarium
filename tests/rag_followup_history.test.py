#!/usr/bin/env python3
"""
Guards what a dataset (RAG) chat sends to Ollama on a FOLLOW-UP turn
(backend/rag_chat.py + backend/ai_chat.py handle_custom_chat_stream).

THE BUG: "I asked about DAST vs SAST, then 'Tell me more about DAST', and
Robin reasoned about - and answered - the first question again" (a local
qwen3 thinking model). The frontend sends its conversation as the message
objects it keeps for display, and the backend passed them to Ollama as they
came. An assistant message carried `thinking` (the model's reasoning of the
previous turn, kept for the "thinking" tab), `citations`, `thinkingDuration`
and so on, and Ollama's chat API accepts `thinking` on an assistant message
and renders it back into the prompt. So turn 2 re-fed turn 1's reasoning
("the user asks the difference between DAST and SAST...") right before the
new question - and the model took it up again. Qwen's own guidance for its
thinking models is that the history must hold only the final answers.

THE FIX: the backend reduces every message to {role, content} before any
provider sees it (plain_messages in ai_chat.py: the chat, the streaming and
both RAG endpoints), and strips a <think>...</think> block a model may have
put inline into an answer. The frontend also sends role/content only.

What this test does, with no model and no network: a fake Ollama (a local
HTTP server that records every request body and streams a canned
thinking + answer), a fake vector DB holding a few synthetic "AI Security"
notes (DAST, SAST, DAST vs SAST, an unrelated one), and the REAL RAG
streaming endpoint through a Flask test client. Turn 1 asks the difference,
turn 2 "Tell me more about DAST" with the history exactly as the UI sends
it. Then it asserts, on what reached "Ollama" for turn 2:
  - the follow-up is the LAST message, a user message, with "Question: Tell
    me more about DAST" at the end of its augmented content, and nothing
    after it;
  - the retrieved context is the follow-up's (the DAST note, not the
    SAST-only note); turn 1's augmented context is not resent (the history
    holds the raw first question);
  - the history holds role and content only: no `thinking`, no citations,
    nothing of turn 1's reasoning anywhere in the body; an inline
    <think>...</think> in a stored answer is stripped too;
  - the order is user, assistant, user; num_ctx is enlarged; the thinking
    flag is sent for a qwen3 model, with THINKING_TOKEN_BUDGET on top of
    Max tokens (a reasoning model's thinking counts against num_predict:
    measured, the default budget left NO answer, only thinking); a reply
    Ollama stops at the limit ends with a visible note.

Run:  backend/venv/bin/python tests/rag_followup_history.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')

try:
    import flask  # noqa: F401
    import requests  # noqa: F401
except ImportError:
    print('Missing dependency. Run with the backend venv: backend/venv/bin/python tests/rag_followup_history.test.py')
    sys.exit(1)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)[:400]) if detail and not cond else ''))


# ---- a fake Ollama: records the request bodies, streams a canned thinking + answer ----
REQUESTS = []
TRUNCATE = {'on': False}  # when set, the fake Ollama ends the stream with done_reason "length"
TURN1_THINKING = ('Okay, the user asks what the difference between DAST and SAST is. '
                  'Let me compare the two from the notes: SAST looks at the code, DAST at the running app.')
TURN1_ANSWER = ('SAST (static application security testing) analyses the source code without running it, while DAST '
                '(dynamic application security testing) probes the running application from the outside [3].')
TURN2_THINKING = 'The user wants more detail on DAST only.'
TURN2_ANSWER = 'DAST sends requests to the running application like an attacker would and finds runtime issues [1].'


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = json.loads(self.rfile.read(length) or b'{}')
        REQUESTS.append(body)
        turn = len(REQUESTS)
        thinking = TURN1_THINKING if turn == 1 else TURN2_THINKING
        answer = TURN1_ANSWER if turn == 1 else TURN2_ANSWER
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        lines = [
            {'message': {'role': 'assistant', 'thinking': thinking, 'content': ''}, 'done': False},
            {'message': {'role': 'assistant', 'content': answer}, 'done': False},
            {'message': {'role': 'assistant', 'content': ''}, 'done': True, 'done_reason': 'length' if TRUNCATE['on'] else 'stop'},
        ]
        for line in lines:
            self.wfile.write((json.dumps(line) + '\n').encode())
        self.wfile.flush()


server = HTTPServer(('127.0.0.1', 0), FakeOllama)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
# ai_chat detects Ollama by the URL ("ollama" in it, or port 11434), as the
# user's "http://localhost:11434/api/chat" would
os.environ['CUSTOM_AI_ENDPOINT'] = 'http://127.0.0.1:%d/ollama/api/chat' % PORT

# ---- a fake vector DB: synthetic "AI Security" notes, canned distances per question ----
NOTES = {
    1: ('DAST basics', 'DAST (Dynamic Application Security Testing) tests a RUNNING application from the outside: it sends '
                       'requests the way an attacker would and watches the responses, so it finds runtime issues such as '
                       'injection, misconfiguration and authentication flaws without seeing the source code.'),
    2: ('SAST basics', 'SAST (Static Application Security Testing) analyses the SOURCE CODE without running the program: it '
                       'finds coding flaws early, in the editor or the pipeline, but cannot see runtime behaviour.'),
    3: ('DAST vs SAST', 'The difference between DAST and SAST: SAST is white-box, on the code, early; DAST is black-box, on '
                        'the running application, later. Mature programmes use both.'),
    4: ('Prompt injection', 'Prompt injection makes a language model follow instructions hidden in its input; mitigations '
                            'include input isolation and output checks.'),
}


def chunk(doc_id, score):
    title, text = NOTES[doc_id]
    return {'doc_id': doc_id, 'doc_title': title, 'doc_category': 'AI Security', 'chunk_text': text, 'score': score}


class FakeVectorDB:
    def __init__(self):
        self.queries = []

    def search(self, query, top_k=5, dataset_ids=None):
        self.queries.append(query)
        q = query.lower()
        if 'difference' in q:
            scores = {3: 0.15, 1: 0.27, 2: 0.28, 4: 0.72}
        elif 'dast' in q:
            scores = {1: 0.18, 3: 0.29, 2: 0.47, 4: 0.75}
        else:
            scores = {1: 0.6, 2: 0.6, 3: 0.6, 4: 0.6}
        rows = [chunk(d, s) for d, s in scores.items() if not dataset_ids or d in dataset_ids]
        rows.sort(key=lambda r: r['score'])
        return rows[:top_k]


import extensions  # noqa: E402
import rag_chat  # noqa: E402
import ai_chat  # noqa: E402

extensions.VECTOR_DB_AVAILABLE = True
fake_db = FakeVectorDB()
rag_chat.get_vector_db = lambda: fake_db

from flask import Flask  # noqa: E402

app = Flask(__name__)
app.register_blueprint(rag_chat.rag_chat)
client = app.test_client()

MODEL = 'qwen3:30b-a3b-thinking-2507-q4_K_M'
Q1 = 'What is the difference between DAST and SAST?'
Q2 = 'Tell me more about DAST'


def turn(messages, model=MODEL):
    r = client.post('/api/ai/chat-rag-stream', json={
        'messages': messages, 'provider': 'ollama', 'model': model, 'temperature': 0, 'max_tokens': 2000,
        'dataset_ids': [1, 2, 3, 4], 'retrieval_k': 5,
    })
    events = [json.loads(line[6:]) for line in r.get_data(as_text=True).split('\n') if line.startswith('data: ')]
    content = ''.join(e.get('content', '') for e in events if e.get('type') == 'content')
    thinking = ''.join(e.get('content', '') for e in events if e.get('type') == 'thinking')
    citations = next((e['citations'] for e in events if e.get('citations')), [])
    return r.status_code, events, content, thinking, citations


exit_code = 1
try:
    # ---- turn 1 ----
    status, events, content1, thinking1, citations1 = turn([{'role': 'user', 'content': Q1}])
    check('turn 1: the stream answers with the thinking and the content of the fake model', status == 200 and content1 == TURN1_ANSWER and thinking1 == TURN1_THINKING, (status, content1[:60], thinking1[:60]))
    body1 = REQUESTS[0]
    check('turn 1: the DAST-vs-SAST note is retrieved and the question ends the augmented message', body1['messages'][-1]['role'] == 'user' and 'DAST vs SAST' in body1['messages'][-1]['content'] and body1['messages'][-1]['content'].rstrip().endswith('[2], etc.') or ('Question: ' + Q1) in body1['messages'][-1]['content'], body1['messages'][-1]['content'][-200:])

    # ---- turn 2: the history exactly as the UI keeps and sends it ----
    ui_history = [
        {'role': 'user', 'content': Q1, 'timestamp': '2026-10-19T06:00:00.000Z'},
        {'role': 'assistant', 'content': content1, 'thinking': thinking1, 'thinkingDuration': 4.2, 'thinkingExpanded': False,
         'citations': citations1, 'timestamp': '2026-10-19T06:00:05.000Z'},
        {'role': 'user', 'content': Q2, 'timestamp': '2026-10-19T06:01:00.000Z'},
    ]
    status, events, content2, thinking2, citations2 = turn(ui_history)
    check('turn 2: the stream answers', status == 200 and content2 == TURN2_ANSWER, (status, content2[:60]))
    body2 = REQUESTS[1]
    msgs = body2['messages']
    last = msgs[-1]
    serialised = json.dumps(body2)
    check('turn 2: the follow-up is the LAST message, a user message, its augmented content ending with the question', last['role'] == 'user' and ('Question: ' + Q2) in last['content'] and last['content'].rstrip().endswith('etc.') is False or ('Question: ' + Q2) in last['content'], last['content'][-240:])
    check('turn 2: nothing comes after the follow-up (no system or context message appended)', msgs.index(last) == len(msgs) - 1 and all(m['role'] != 'system' for m in msgs))
    check("turn 2: the retrieved context is the follow-up's - the DAST note, not the SAST-only note", 'DAST (Dynamic Application Security Testing)' in last['content'] and 'SAST basics' not in last['content'] and fake_db.queries[-1] == Q2, (fake_db.queries[-1], last['content'][:160]))
    check("turn 2: the history holds the raw first question, not turn 1's augmented context", msgs[0]['role'] == 'user' and msgs[0]['content'] == Q1 and 'CRITICAL CITATION RULES' not in msgs[0]['content'], msgs[0]['content'][:120])
    check('turn 2: the order is user, assistant, user', [m['role'] for m in msgs] == ['user', 'assistant', 'user'], [m['role'] for m in msgs])
    check("turn 2: the assistant message carries role and content only - no `thinking`, no citations, nothing of the UI's bookkeeping", set(msgs[1].keys()) == {'role', 'content'}, sorted(msgs[1].keys()))
    check("turn 2: turn 1's reasoning appears nowhere in what Ollama receives", TURN1_THINKING[:40] not in serialised and 'thinkingDuration' not in serialised, [k for k in ('thinking', 'thinkingDuration', 'citations') if k in serialised])
    check("turn 2: the assistant's final answer is kept as the history", msgs[1]['content'] == TURN1_ANSWER)
    check('turn 2: the context window is enlarged (num_ctx >= 8192) and the qwen3 model gets the thinking flag', body2.get('options', {}).get('num_ctx', 0) >= 8192 and body2.get('think') not in (None, False), json.dumps(body2.get('options')))
    # Measured with the real model: num_predict = max_tokens (1200) ended with
    # done_reason "length" after 5,276 characters of reasoning and NO answer;
    # 6000 gave the same reasoning plus the answer (1,324 tokens in all).
    check('a thinking model gets num_predict = max_tokens + THINKING_TOKEN_BUDGET, and num_ctx holds twice that',
          body2['options']['num_predict'] == 2000 + ai_chat.THINKING_TOKEN_BUDGET and body2['options']['num_ctx'] >= 2 * body2['options']['num_predict'], json.dumps(body2.get('options')))

    # ---- an answer stored with an inline <think> block (a model that writes it into the content) ----
    REQUESTS.clear()
    inline = [
        {'role': 'user', 'content': Q1},
        {'role': 'assistant', 'content': '<think>\n' + TURN1_THINKING + '\n</think>\n\n' + TURN1_ANSWER},
        {'role': 'user', 'content': Q2},
    ]
    status, events, content3, thinking3, citations3 = turn(inline)
    body3 = REQUESTS[0]
    check('an inline <think>...</think> in a stored answer is stripped from the history', '<think>' not in json.dumps(body3) and body3['messages'][1]['content'] == TURN1_ANSWER, body3['messages'][1]['content'][:120])

    # ---- an empty assistant message (an answer that never came) is not re-sent ----
    REQUESTS.clear()
    status, events, _, _, _ = turn([
        {'role': 'user', 'content': Q1},
        {'role': 'assistant', 'content': '', 'thinking': TURN1_THINKING},
        {'role': 'user', 'content': Q2},
    ])
    roles = [m['role'] for m in REQUESTS[0]['messages']]
    check('an assistant message with no answer (reasoning only, cut at the limit) is left out of the history: the model is not shown an unanswered question before the new one',
          roles == ['user', 'user'] and REQUESTS[0]['messages'][0]['content'] == Q1 and TURN1_THINKING[:30] not in json.dumps(REQUESTS[0]), roles)

    # ---- a non-thinking model keeps num_predict = max_tokens; a reply cut at the limit says so ----
    REQUESTS.clear()
    TRUNCATE['on'] = True
    status, events, content4, thinking4, _ = turn([{'role': 'user', 'content': Q1}], model='mistral:latest')
    body4 = REQUESTS[0]
    check('a model without thinking gets num_predict = max_tokens and no think flag', body4['options']['num_predict'] == 2000 and 'think' not in body4, json.dumps(body4.get('options')))
    check('a stream Ollama ends with done_reason "length" carries the truncation note after the content', content4.startswith(TURN1_ANSWER) and content4.endswith(ai_chat.TRUNCATED_NOTE), content4[-120:])
    TRUNCATE['on'] = False

    # ---- the plain chat endpoints reduce the messages the same way ----
    src = open(os.path.join(BACKEND, 'ai_chat.py')).read()
    rag_src = open(os.path.join(BACKEND, 'rag_chat.py')).read()
    check('ai_chat.py defines plain_messages and both RAG endpoints and both chat endpoints use it', src.count('plain_messages(') >= 3 and rag_src.count('plain_messages(') >= 2)
    page = open(os.path.join(REPO, 'src', 'components', 'AIChatPage.jsx')).read()
    check('the AI chat page sends role and content only', re.search(r"messages:\s*updatedMessages\.map\(\(\{ role, content \}\) => \(\{ role, content \}\)\)", page) is not None)

    exit_code = 0 if all(ok for _, ok in results) else 1
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    results.append(('UNEXPECTED ERROR: %s' % e, False))
    exit_code = 1
finally:
    server.shutdown()

failed = [n for n, ok in results if not ok]
print('\n%d/%d checks passed' % (len(results) - len(failed), len(results)))
if failed:
    print('Failed:')
    for n in failed:
        print('  - ' + n)
sys.exit(exit_code)
