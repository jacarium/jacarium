#!/usr/bin/env python3
"""The reply length and how a reply stopped, in backend/ai_chat.py, against a stub Ollama (no network):

  - request_max_tokens: maxTokens or max_tokens from the request (the chat UIs sent max_tokens while the routes
    read maxTokens, so Settings' Default Max Tokens never arrived and 2000 always applied), else the
    DEFAULT_AI_MAX_TOKENS setting, else 4096; clamped to 256..200000; junk falls back;
  - the Ollama request carries num_predict from it (plus the thinking budget for a reasoning model);
  - /api/ai/ask and /api/ai/chat answer finishReason and truncated when Ollama stopped at the limit
    (done_reason "length"), and false when it finished;
  - /api/ai/ask with stream: true and /api/ai/chat-stream end with a done event carrying truncated;
  - /api/ai/models' defaults carry maxTokens;
  - the custom-endpoint timeout is a (connect, read) pair with a long read.

Run:  backend/venv/bin/python tests/ai_chat_tokens.test.py
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(REPO, 'backend'))
failed = 0


def check(name, cond, detail=''):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}: {name}{(' | ' + str(detail)[:400]) if (detail and not cond) else ''}")
    if not cond:
        failed += 1


# ---------------------------------------------------------------- a stub Ollama: /api/chat, records the payload
requests_seen = []
MODE = {'done_reason': 'length'}


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        payload = json.loads(self.rfile.read(n) or b'{}')
        requests_seen.append(payload)
        self.send_response(200)
        if payload.get('stream'):
            self.send_header('Content-Type', 'application/x-ndjson')
            self.end_headers()
            lines = [
                {'message': {'thinking': 'let me think', 'content': ''}, 'done': False},
                {'message': {'content': 'The answer'}, 'done': False},
                {'message': {'content': ' so far'}, 'done': True, 'done_reason': MODE['done_reason']},
            ]
            for line in lines:
                self.wfile.write((json.dumps(line) + '\n').encode())
            return
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'message': {'role': 'assistant', 'content': 'The answer so far'}, 'done': True, 'done_reason': MODE['done_reason']}).encode())


srv = HTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ['CUSTOM_AI_ENDPOINT'] = f'http://127.0.0.1:{srv.server_port}/ollama/api/chat'   # 'ollama' in the URL: the Ollama request shape
os.environ.pop('CUSTOM_API_KEY', None)
os.environ.pop('DEFAULT_AI_MAX_TOKENS', None)

try:
    import ai_chat
    from flask import Flask

    app = Flask(__name__)
    app.register_blueprint(ai_chat.ai_chat_bp)
    client = app.test_client()

    # ---- the constants
    check('CUSTOM_AI_TIMEOUT is a (connect, read) pair: a short connect, a long gap between bytes', ai_chat.CUSTOM_AI_TIMEOUT == (ai_chat.CUSTOM_AI_CONNECT_TIMEOUT, ai_chat.CUSTOM_AI_READ_TIMEOUT) and ai_chat.CUSTOM_AI_CONNECT_TIMEOUT <= 30 and ai_chat.CUSTOM_AI_READ_TIMEOUT >= 300, repr(ai_chat.CUSTOM_AI_TIMEOUT))
    check('the default reply length is 4096, bounded 256..200000', ai_chat.DEFAULT_MAX_TOKENS == 4096 and ai_chat.MIN_MAX_TOKENS == 256 and ai_chat.MAX_MAX_TOKENS == 200000)

    # ---- request_max_tokens
    check('request_max_tokens: maxTokens, then max_tokens (the chat UIs\' key), as ints', ai_chat.request_max_tokens({'maxTokens': 777}) == 777 and ai_chat.request_max_tokens({'max_tokens': '888'}) == 888 and ai_chat.request_max_tokens({'maxTokens': 500, 'max_tokens': 900}) == 500)
    check('...clamped to the bounds; junk, 0 and a missing value fall back to the default', ai_chat.request_max_tokens({'maxTokens': 99999999}) == 200000 and ai_chat.request_max_tokens({'maxTokens': 5}) == 256 and ai_chat.request_max_tokens({'max_tokens': 'abc'}) == 4096 and ai_chat.request_max_tokens({'maxTokens': 0}) == 4096 and ai_chat.request_max_tokens({}) == 4096)
    original_setting = ai_chat.setting
    ai_chat.setting = lambda key, default='': '12000' if key == 'DEFAULT_AI_MAX_TOKENS' else original_setting(key, default)
    check('...the DEFAULT_AI_MAX_TOKENS setting (Settings > AI Providers) is the default when the request names none', ai_chat.request_max_tokens({}) == 12000 and ai_chat.default_max_tokens() == 12000)
    ai_chat.setting = lambda key, default='': '  ' if key == 'DEFAULT_AI_MAX_TOKENS' else original_setting(key, default)
    check('...a blank setting means the built-in default', ai_chat.default_max_tokens() == 4096)
    ai_chat.setting = original_setting

    # ---- the Ollama request carries num_predict
    r = client.post('/api/ai/ask', json={'message': 'hello', 'provider': 'ollama', 'model': 'llama3', 'maxTokens': 3000})
    data = r.get_json()
    check('/api/ai/ask (Ollama) sends num_predict = maxTokens for a plain model', r.status_code == 200 and requests_seen[-1]['options']['num_predict'] == 3000, (r.status_code, requests_seen[-1:] and requests_seen[-1].get('options')))
    check('...and answers finishReason "length" and truncated true when Ollama stopped at the limit (the text with the note)', data.get('truncated') is True and data.get('finishReason') == 'length' and data.get('response', '').startswith('The answer so far'), data)
    client.post('/api/ai/chat', json={'messages': [{'role': 'user', 'content': 'hi'}], 'provider': 'ollama', 'model': 'qwen3:30b', 'max_tokens': 2500})
    check('/api/ai/chat with the chat UIs\' max_tokens key: num_predict = max_tokens + the thinking budget for a reasoning model', requests_seen[-1]['options']['num_predict'] == 2500 + ai_chat.THINKING_TOKEN_BUDGET, requests_seen[-1].get('options'))
    MODE['done_reason'] = 'stop'
    r = client.post('/api/ai/chat', json={'messages': [{'role': 'user', 'content': 'hi'}], 'provider': 'ollama', 'model': 'llama3'})
    data = r.get_json()
    check('/api/ai/chat answers truncated false and finishReason "stop" when the model finished; no maxTokens given -> the default 4096 went to Ollama', data.get('truncated') is False and data.get('finishReason') == 'stop' and data.get('message') == 'The answer so far' and requests_seen[-1]['options']['num_predict'] == 4096, (data, requests_seen[-1].get('options')))

    # ---- the streams
    MODE['done_reason'] = 'length'
    r = client.post('/api/ai/ask', json={'message': 'hello', 'systemPrompt': 'be brief', 'provider': 'ollama', 'model': 'qwen3:30b', 'maxTokens': 1000, 'stream': True})
    events = [json.loads(line[6:]) for line in r.get_data(as_text=True).split('\n') if line.startswith('data: ')]
    types = [e.get('type') for e in events]
    check('/api/ai/ask with stream: true answers SSE: thinking_start, thinking, thinking_end, content..., done', r.mimetype == 'text/event-stream' and types[:3] == ['thinking_start', 'thinking', 'thinking_end'] and 'content' in types and types[-1] == 'done', types)
    check('...the done event says the reply was cut off (finishReason length, truncated true); the system prompt went first', events[-1].get('truncated') is True and events[-1].get('finishReason') == 'length' and requests_seen[-1]['messages'][0] == {'role': 'system', 'content': 'be brief'} and requests_seen[-1]['stream'] is True, (events[-1], requests_seen[-1].get('messages')))
    MODE['done_reason'] = 'stop'
    r = client.post('/api/ai/chat-stream', json={'messages': [{'role': 'user', 'content': 'hi'}], 'provider': 'ollama', 'model': 'llama3', 'maxTokens': 600})
    events = [json.loads(line[6:]) for line in r.get_data(as_text=True).split('\n') if line.startswith('data: ')]
    check('/api/ai/chat-stream ends with done, truncated false, finishReason stop; num_predict from maxTokens', events[-1] == {'type': 'done', 'finishReason': 'stop', 'truncated': False} and requests_seen[-1]['options']['num_predict'] == 600, (events[-1], requests_seen[-1].get('options')))
    check('no "finish" event leaks to the client (it is folded into done)', not any(e.get('type') == 'finish' for e in events))

    # ---- the helpers
    check('is_truncated: length / max_tokens / MAX_TOKENS yes; stop / end_turn / None no', all(ai_chat.is_truncated(r) for r in ('length', 'max_tokens', 'MAX_TOKENS')) and not any(ai_chat.is_truncated(r) for r in ('stop', 'end_turn', None, '')))
    reply = ai_chat.ai_reply('text', 'max_tokens')
    check('ai_reply is a str carrying finish_reason; reply_json puts both beside the text', reply == 'text' and isinstance(reply, str) and reply.finish_reason == 'max_tokens' and ai_chat.reply_json('response', reply) == {'response': 'text', 'finishReason': 'max_tokens', 'truncated': True})
    check('/api/ai/models defaults carry maxTokens (the source of the UIs\' default)', "'maxTokens': default_max_tokens()" in open(os.path.join(REPO, 'backend', 'ai_chat.py')).read())
finally:
    srv.shutdown()

print(f"\n{failed} check(s) failed" if failed else "\nAll checks passed")
sys.exit(1 if failed else 0)
