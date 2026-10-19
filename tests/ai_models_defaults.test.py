#!/usr/bin/env python3
"""
/api/ai/models carries the Settings default AI provider / model
(backend/ai_chat.py ai_models), so Robin's page and the AI chat sidebar
pick a conversation's starting model in one order, on the desktop and the
web alike (src/utils/aiDefaults.js resolveModelOption: the saved model
when configured, else DEFAULT_AI_MODEL, else DEFAULT_AI_PROVIDER's first
model, else the first configured). Before, only the sidebar read the
defaults - from the Electron env file, so never on the web - and the page
never did.

Checks, through a Flask test client with nothing configured (no provider
keys; the env file path pointed at an empty temp file):
  1. with DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL set the answer carries
     them under "defaults";
  2. unset, "defaults" is there with empty strings (the UIs need the key);
  3. the provider lists are unaffected (empty here).

Run:  backend/venv/bin/python tests/ai_models_defaults.test.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')
# an empty env file of its own, never the user's ~/.jacarium.env
fd, ENV_FILE = tempfile.mkstemp(prefix='ai-models-defaults-', suffix='.env')
os.close(fd)
os.environ['JACARIUM_ENV_FILE'] = ENV_FILE
for key in ('ANTHROPIC_API_KEY', 'ANTHROPIC_USE_BEDROCK', 'ANTHROPIC_USE_VERTEX', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
            'GEMINI_USE_VERTEX', 'CUSTOM_AI_ENDPOINT', 'OLLAMA_ENDPOINT', 'SSH_AI_HOST', 'DEFAULT_AI_PROVIDER', 'DEFAULT_AI_MODEL'):
    os.environ.pop(key, None)

try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/ai_models_defaults.test.py')
    sys.exit(1)

import ai_chat  # noqa: E402

app = Flask(__name__)
app.register_blueprint(ai_chat.ai_chat_bp)
client = app.test_client()
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)[:300]) if detail and not cond else ''))


try:
    os.environ['DEFAULT_AI_PROVIDER'] = 'ollama'
    os.environ['DEFAULT_AI_MODEL'] = 'qwen3:30b'
    r = client.get('/api/ai/models')
    body = r.get_json() or {}
    check('/api/ai/models answers 200 with the provider lists', r.status_code == 200 and isinstance(body.get('anthropic'), list) and isinstance(body.get('ollama'), list), (r.status_code, list(body.keys())))
    check('...and carries the Settings defaults: {"provider": "ollama", "model": "qwen3:30b"}', body.get('defaults') == {'provider': 'ollama', 'model': 'qwen3:30b'}, body.get('defaults'))
    os.environ.pop('DEFAULT_AI_PROVIDER', None)
    os.environ.pop('DEFAULT_AI_MODEL', None)
    r = client.get('/api/ai/models')
    body = r.get_json() or {}
    check('with no defaults configured the key is still there, both empty', body.get('defaults') == {'provider': '', 'model': ''}, body.get('defaults'))
    check('nothing configured: every provider list is empty (ssh only appears when configured)', all(body.get(k) == [] for k in ('anthropic', 'openai', 'gemini', 'ollama')) and not body.get('ssh'), {k: body.get(k) for k in ('anthropic', 'openai', 'gemini', 'ollama', 'ssh')})
    exit_code = 0 if all(ok for _, ok in results) else 1
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    results.append(('UNEXPECTED ERROR: %s' % e, False))
    exit_code = 1
finally:
    try:
        os.remove(ENV_FILE)
    except OSError:
        pass

failed = [n for n, ok in results if not ok]
print('\n%d/%d checks passed' % (len(results) - len(failed), len(results)))
sys.exit(exit_code)
