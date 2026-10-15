#!/usr/bin/env python3
"""
Gemini in backend/ai_chat.py goes through the google-genai SDK
(`from google import genai`); the deprecated google-generativeai package is
gone. This pins down what the two code paths send to the SDK, with the SDK
replaced by a fake installed in sys.modules - no key, no network.

 - GET /api/ai/models with GEMINI_API_KEY: Client(api_key=...), the models
   that support generateContent, listed by their short name.
 - handle_gemini_chat with an API key: Client(api_key=...), a chat on the
   requested model ('gemini-pro' when none), every earlier *user* message
   replayed through the chat, the last message sent with the temperature /
   max_output_tokens config, the reply's text returned.
 - handle_gemini_chat with GEMINI_USE_VERTEX=true: Client(vertexai=True,
   project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION or us-central1), the
   conversation flattened to "User: ... / Assistant: ..." text, generated on
   the requested model ('gemini-2.0-flash-exp' when none).
 - The errors for a missing key / project.
 - google.generativeai is never imported.

Run: backend/venv/bin/python tests/ai_chat_gemini.test.py
"""
import json
import os
import sys
import tempfile
import types as pytypes

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'backend'))

WORKDIR = tempfile.mkdtemp(prefix='ai-chat-gemini-test-')
os.environ['HOME'] = WORKDIR
os.environ['APP_AUTH_TOKEN'] = 'test-token'
for key in ('GEMINI_API_KEY', 'GEMINI_USE_VERTEX', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION',
            'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CUSTOM_AI_ENDPOINT'):
    os.environ.pop(key, None)

# ---------------------------------------------------------------------------
# A fake google.genai: records every call, answers with synthetic data
# ---------------------------------------------------------------------------
calls = []


class FakeModel:
    def __init__(self, name, actions):
        self.name = name
        self.supported_actions = actions


class FakeResponse:
    def __init__(self, text):
        self.text = text


class FakeChat:
    def __init__(self, model, history, config):
        self.model, self.history, self.config = model, history, config
        self.sent = []

    def send_message(self, message, config=None):
        self.sent.append((message, config))
        calls.append(('send_message', message, config))
        return FakeResponse(f'reply to {message!r} from {self.model}')


class FakeModels:
    def list(self, config=None):
        calls.append(('models.list',))
        return iter([
            FakeModel('models/gemini-synthetic-chat', ['generateContent', 'countTokens']),
            FakeModel('models/embedding-synthetic', ['embedContent']),
            FakeModel('models/gemini-synthetic-noactions', None),
            FakeModel('models/gemini-synthetic-flash', ['generateContent']),
        ])

    def generate_content(self, *, model, contents, config=None):
        calls.append(('generate_content', model, contents, config))
        return FakeResponse(f'vertex reply from {model}')


class FakeChats:
    def create(self, *, model, config=None, history=None):
        chat = FakeChat(model, history, config)
        calls.append(('chats.create', model, history, config))
        return chat


class FakeClient:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.models = FakeModels()
        self.chats = FakeChats()
        FakeClient.instances.append(self)


class GenerateContentConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def __repr__(self):
        return f'GenerateContentConfig({self.kwargs})'


fake_types = pytypes.ModuleType('google.genai.types')
fake_types.GenerateContentConfig = GenerateContentConfig
fake_genai = pytypes.ModuleType('google.genai')
fake_genai.Client = FakeClient
fake_genai.types = fake_types
import google  # noqa: E402  (the real namespace package from google-auth & co.)
sys.modules['google.genai'] = fake_genai
sys.modules['google.genai.types'] = fake_types
google.genai = fake_genai

import extensions  # noqa: E402
import ai_chat  # noqa: E402

app = extensions.app
app.register_blueprint(ai_chat.ai_chat_bp)
client = app.test_client()
H = {'X-App-Token': 'test-token'}

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def reset():
    calls.clear()
    FakeClient.instances.clear()


# --- models listing ---------------------------------------------------------
reset()
os.environ['GEMINI_API_KEY'] = 'gm-synthetic-not-real'
r = client.get('/api/ai/models', headers=H)
models = (r.get_json(silent=True) or {}).get('gemini')
check('/api/ai/models lists the generateContent models by short name',
      r.status_code == 200 and models == ['gemini-synthetic-chat', 'gemini-synthetic-flash'], f'{r.status_code} {models}')
check('...through a Client built with the API key only',
      [c.kwargs for c in FakeClient.instances] == [{'api_key': 'gm-synthetic-not-real'}], str([c.kwargs for c in FakeClient.instances]))

# --- API-key chat -------------------------------------------------------------
reset()
conversation = [
    {'role': 'user', 'content': 'first question'},
    {'role': 'assistant', 'content': 'first answer'},
    {'role': 'user', 'content': 'second question'},
]
text = ai_chat.handle_gemini_chat(conversation, 'gemini-synthetic-flash', 0.3, 512)
check('API key: the reply text is returned', text == "reply to 'second question' from gemini-synthetic-flash", text)
check('API key: one Client with the key', [c.kwargs for c in FakeClient.instances] == [{'api_key': 'gm-synthetic-not-real'}])
create = [c for c in calls if c[0] == 'chats.create']
check('API key: a chat on the requested model with empty history',
      create == [('chats.create', 'gemini-synthetic-flash', [], None)], str(create))
sent = [c for c in calls if c[0] == 'send_message']
check('API key: earlier user messages are replayed, assistant ones are not',
      [m for _, m, _ in sent] == ['first question', 'second question'], str([m for _, m, _ in sent]))
check('API key: the replay carries no config, the last message carries temperature and max_output_tokens',
      sent[0][2] is None and isinstance(sent[1][2], GenerateContentConfig)
      and sent[1][2].kwargs == {'temperature': 0.3, 'max_output_tokens': 512}, str(sent))

reset()
ai_chat.handle_gemini_chat([{'role': 'user', 'content': 'hi'}], '', 0.7, 100)
check("API key: no model requested -> 'gemini-pro'", calls[0] == ('chats.create', 'gemini-pro', [], None), str(calls[0]))

# system messages (/api/ai/ask sends one) -> system_instruction, joined in order
reset()
with_system = [
    {'role': 'system', 'content': 'You are terse.'},
    {'role': 'user', 'content': 'first question'},
    {'role': 'system', 'content': 'Answer in English.'},
    {'role': 'user', 'content': 'second question'},
]
ai_chat.handle_gemini_chat(with_system, 'gemini-synthetic-flash', 0.3, 512)
create = calls[0]
check('API key: system messages become the chat system_instruction, joined in order',
      create[0] == 'chats.create' and isinstance(create[3], GenerateContentConfig)
      and create[3].kwargs == {'system_instruction': 'You are terse.\n\nAnswer in English.'}, str(create))
sent = [c for c in calls if c[0] == 'send_message']
check('API key: system messages are not replayed as user messages',
      [m for _, m, _ in sent] == ['first question', 'second question'], str([m for _, m, _ in sent]))
check('API key: the last message repeats the system_instruction with temperature / max_output_tokens',
      sent[0][2] is None and sent[1][2].kwargs == {'temperature': 0.3, 'max_output_tokens': 512,
                                                   'system_instruction': 'You are terse.\n\nAnswer in English.'}, str(sent[1]))

reset()
os.environ.pop('GEMINI_API_KEY')
try:
    ai_chat.handle_gemini_chat([{'role': 'user', 'content': 'hi'}], 'm', 0.7, 100)
    check('API key missing -> ValueError', False, 'returned')
except ValueError as e:
    check('API key missing -> ValueError', 'GEMINI_API_KEY' in str(e), str(e))
check('...and no Client was built', FakeClient.instances == [])

# --- Vertex chat ----------------------------------------------------------------
reset()
os.environ['GEMINI_USE_VERTEX'] = 'true'
os.environ['GEMINI_PROJECT_ID'] = 'synthetic-project'
os.environ.pop('GEMINI_LOCATION', None)
text = ai_chat.handle_gemini_chat(conversation, '', 0.3, 512)
check('Vertex: the reply text is returned', text == 'vertex reply from gemini-2.0-flash-exp', text)
check('Vertex: Client(vertexai=True, project, default location us-central1)',
      [c.kwargs for c in FakeClient.instances] == [{'vertexai': True, 'project': 'synthetic-project', 'location': 'us-central1'}],
      str([c.kwargs for c in FakeClient.instances]))
gen = [c for c in calls if c[0] == 'generate_content']
check('Vertex: the conversation is flattened to User/Assistant text, no extra config',
      gen == [('generate_content', 'gemini-2.0-flash-exp',
               'User: first question\n\nAssistant: first answer\n\nUser: second question\n\n', None)], str(gen))

reset()
os.environ['GEMINI_LOCATION'] = 'europe-west4'
ai_chat.handle_gemini_chat([{'role': 'user', 'content': 'hi'}], 'gemini-synthetic-pro', 0.3, 512)
check('Vertex: GEMINI_LOCATION and the requested model are used',
      FakeClient.instances[0].kwargs['location'] == 'europe-west4' and calls[0][1] == 'gemini-synthetic-pro', str(calls[0]))

reset()
ai_chat.handle_gemini_chat(with_system, '', 0.3, 512)
gen = calls[0]
check('Vertex: system messages become system_instruction, not "Assistant:" lines',
      gen[0] == 'generate_content' and gen[2] == 'User: first question\n\nUser: second question\n\n'
      and isinstance(gen[3], GenerateContentConfig)
      and gen[3].kwargs == {'system_instruction': 'You are terse.\n\nAnswer in English.'}, str(gen))

reset()
os.environ.pop('GEMINI_PROJECT_ID')
try:
    ai_chat.handle_gemini_chat([{'role': 'user', 'content': 'hi'}], 'm', 0.7, 100)
    check('Vertex: GEMINI_PROJECT_ID missing -> ValueError', False, 'returned')
except ValueError as e:
    check('Vertex: GEMINI_PROJECT_ID missing -> ValueError', 'GEMINI_PROJECT_ID' in str(e), str(e))

check('google.generativeai was never imported', 'google.generativeai' not in sys.modules)

failed = [n for n, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
