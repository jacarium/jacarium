#!/usr/bin/env python3
"""
Guards against the "custom/Ollama AI endpoint can hang a backend thread forever" bug.

backend/ai_chat.py talks to a user-configured endpoint (CUSTOM_AI_ENDPOINT - a local
Ollama instance or any OpenAI-compatible API). Two requests.post() calls used to have
no timeout= at all:

  - handle_custom_chat()        -> POST ... (non-streaming)
  - handle_custom_chat_stream() -> POST ... stream=True

If that endpoint accepted the connection but never replied (hung process, silently
dropped connection with no RST), requests blocked forever: the Flask worker thread was
tied up permanently and the frontend's chat request hung with no recovery short of
restarting the backend. Every other outbound HTTP call in the backend already set an
explicit timeout; these two were the only exceptions.

The fix adds timeout=CUSTOM_AI_TIMEOUT (120s) to both. As a single scalar, requests
applies it as the connect timeout AND the maximum gap between received bytes, so it
will not cut off a slow-but-live stream - only a connection that has gone fully silent.

This test is self-contained with NO test framework:
  - starts a real TCP server that accepts connections and NEVER responds,
  - points CUSTOM_AI_ENDPOINT at it and imports the REAL backend/ai_chat module,
  - temporarily shrinks ai_chat.CUSTOM_AI_TIMEOUT so the test finishes quickly
    (this also proves the constant is read at call time, not baked in),
  - asserts both handlers raise requests.exceptions.Timeout instead of hanging,
  - asserts Timeout is catchable by the routes' existing `except Exception`,
  - statically asserts every requests.post/get in ai_chat.py passes a timeout, so a
    newly added un-timed-out call is caught too.

Run:  backend/venv/bin/python tests/ai_chat_timeout.test.py
      (or any python3 that has the backend's deps: flask, requests, ...)
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import re
import socket
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

# How long we let a "hung endpoint" call run before declaring the fix broken.
PATCHED_TIMEOUT = 3
GRACE = 10

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


HUNG = object()  # sentinel: the call never returned within the watchdog window


def call_with_watchdog(fn):
    """Run fn() on a daemon thread and give up on it after PATCHED_TIMEOUT + GRACE.

    Without this the test would HANG FOREVER against the un-fixed code (that is the
    bug being guarded), instead of failing and exiting non-zero the way CI needs.
    The thread is a daemon, so a wedged request cannot keep the process alive.
    """
    box = {}

    def runner():
        try:
            box['value'] = fn()
        except BaseException as exc:  # noqa: BLE001 - the type is the assertion
            box['error'] = exc

    th = threading.Thread(target=runner, daemon=True)
    started = time.time()
    th.start()
    th.join(PATCHED_TIMEOUT + GRACE)
    elapsed = time.time() - started
    if th.is_alive():
        return HUNG, elapsed
    return box.get('error', box.get('value')), elapsed


# ---------- precondition checks ----------
try:
    import requests  # noqa: F401
except ImportError:
    print('Missing dependency "requests". Run: backend/venv/bin/python tests/ai_chat_timeout.test.py')
    sys.exit(1)
try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask" (backend/ai_chat.py imports it).')
    print('Run with the backend venv: backend/venv/bin/python tests/ai_chat_timeout.test.py')
    sys.exit(1)

import requests

# ---------- a server that accepts and then says nothing, forever ----------
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', 0))
srv.listen(8)
HUNG_PORT = srv.getsockname()[1]
_held = []  # keep accepted sockets open so the peer never sees EOF/RST


def _accept_loop():
    while True:
        try:
            conn, _ = srv.accept()
            _held.append(conn)
        except OSError:
            return


threading.Thread(target=_accept_loop, daemon=True).start()

os.environ['CUSTOM_AI_ENDPOINT'] = 'http://127.0.0.1:%d/api/chat' % HUNG_PORT
os.environ.pop('CUSTOM_API_KEY', None)

exit_code = 1
try:
    import ai_chat

    # ---------- 1. the constant itself ----------
    real_timeout = getattr(ai_chat, 'CUSTOM_AI_TIMEOUT', None)
    check('ai_chat defines CUSTOM_AI_TIMEOUT', isinstance(real_timeout, (int, float)), repr(real_timeout))
    check('CUSTOM_AI_TIMEOUT is generous enough for slow local models (>= 60s)',
          isinstance(real_timeout, (int, float)) and real_timeout >= 60, repr(real_timeout))
    check('CUSTOM_AI_TIMEOUT is bounded (not None/0/infinite)',
          isinstance(real_timeout, (int, float)) and 0 < real_timeout < 3600, repr(real_timeout))

    # ---------- 2. static: no un-timed-out outbound calls remain ----------
    with open(os.path.join(BACKEND, 'ai_chat.py')) as fh:
        src = fh.read()
    # match each requests.post(/get( call and its balanced-ish argument text
    calls = re.findall(r'requests\.(post|get)\(((?:[^()]|\([^()]*\))*)\)', src, re.S)
    check('found the outbound HTTP calls in ai_chat.py', len(calls) >= 4, '%d call(s)' % len(calls))
    untimed = [c for c in calls if 'timeout' not in c[1]]
    check('every requests.post/get in ai_chat.py passes a timeout', not untimed,
          'missing on: %s' % [c[1][:60] for c in untimed])

    # Shrink so the test does not actually wait the full production timeout.
    ai_chat.CUSTOM_AI_TIMEOUT = PATCHED_TIMEOUT

    messages = [{'role': 'user', 'content': 'hello'}]

    for label, call in (
        ('handle_custom_chat',
         lambda: ai_chat.handle_custom_chat(messages, 'llama3', 0, 100)),
        ('handle_custom_chat_stream',
         lambda: list(ai_chat.handle_custom_chat_stream(messages, 'llama3', 0, 100))),
    ):
        outcome, elapsed = call_with_watchdog(call)
        check('%s does not hang against a dead-silent endpoint' % label,
              outcome is not HUNG,
              'still blocked after %.0fs - missing timeout=' % elapsed if outcome is HUNG else '%.1fs' % elapsed)
        check('%s raises requests Timeout' % label,
              isinstance(outcome, requests.exceptions.Timeout),
              type(outcome).__name__ if outcome is not HUNG else 'HUNG')
        check('%s honours the module timeout constant' % label,
              outcome is not HUNG and elapsed >= PATCHED_TIMEOUT - 1,
              '%.1fs vs %ss' % (elapsed, PATCHED_TIMEOUT))

    # ---------- 5. the error reaches the frontend instead of crashing ----------
    # /api/ai/ask, /api/ai/chat and /api/ai/chat-stream each wrap the handler call
    # in a broad `except Exception` that returns/yields {"error": str(e)}.
    check('requests Timeout is caught by the routes\' existing except Exception',
          issubclass(requests.exceptions.Timeout, Exception))

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception as e:  # noqa: BLE001
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    try:
        srv.close()
    except OSError:
        pass
    for c in _held:
        try:
            c.close()
        except OSError:
            pass
    sys.exit(exit_code)
