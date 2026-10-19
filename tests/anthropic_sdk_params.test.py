#!/usr/bin/env python3
"""
Guards against "Messages.stream() got an unexpected keyword argument 'temperature'".

The anthropic SDK pinned in backend/requirements.txt (1.0.0) no longer accepts
`temperature` on messages.create() / messages.stream(). backend/ai_chat.py still
passed it, so every Anthropic chat (API key and Vertex AI, Quick AI, AI Chat,
streaming or not) failed before a request was sent.

Also guarded here (the follow-ups of the review of that fix):
  - no sampling parameter at all reaches the SDK (temperature, top_p, top_k);
  - the response text is every text block joined: an empty content list, or
    one that starts with a thinking block, used to raise on content[0].text;
  - the streaming handler turns the SDK's events into thinking_start /
    thinking / thinking_end / content in order;
  - the Bedrock path (boto3 swapped for a fake) still sends the system prompt
    as a list, keeps temperature in its raw body (only the SDK dropped it),
    and joins the text blocks of the raw body;
  - the fallback model is the API alias on the API-key path and the Vertex
    "@date" id on Vertex AI;
  - OpenAI goes through the v1 client (openai.ChatCompletion was removed in
    openai>=1.0 - every OpenAI chat raised APIRemovedInV1) and sends no
    temperature to the reasoning models (o1/o3..., gpt-5...).

This test imports the REAL backend/ai_chat module and swaps the SDK clients
(anthropic.Anthropic, anthropic.AnthropicVertex) for fakes whose
messages.create / messages.stream bind the call against the REAL SDK method
signatures - so any keyword the installed SDK would reject fails here the same
way, without a network call or a key. Covered: the non-streaming handler and the
streaming handler, each with an API key and with Vertex AI.

Run:  backend/venv/bin/python tests/anthropic_sdk_params.test.py
Exit code 0 = all checks passed, 1 = failure.
"""
import inspect
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'backend'))

try:
    import anthropic
    from anthropic.resources.messages import Messages
except ImportError:
    print('Missing dependency "anthropic". Run with the backend venv: backend/venv/bin/python tests/anthropic_sdk_params.test.py')
    sys.exit(1)

failures = 0


def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f' | {detail}' if detail and not ok else ''))
    if not ok:
        failures += 1


CREATE_SIG = inspect.signature(Messages.create)
STREAM_SIG = inspect.signature(Messages.stream)
calls = []


class FakeText:
    type = 'text'
    text = 'ok'


class FakeResponse:
    content = [FakeText()]


class FakeThinking:
    type = 'thinking'
    thinking = 'hmm'


# what the SDK's stream yields, in the shapes the handler reads
class Ev:
    def __init__(self, type, **attrs):
        self.type = type
        for k, v in attrs.items():
            setattr(self, k, v)


class Attrs:
    def __init__(self, **attrs):
        for k, v in attrs.items():
            setattr(self, k, v)


STREAM_EVENTS = [
    Ev('message_start'),
    Ev('content_block_start', index=0, content_block=Attrs(type='thinking')),
    Ev('content_block_delta', index=0, delta=Attrs(type='thinking_delta', thinking='let me see')),
    Ev('content_block_stop', index=0),
    Ev('content_block_start', index=1, content_block=Attrs(type='text', text='')),
    Ev('content_block_delta', index=1, delta=Attrs(type='text_delta', text='Hello')),
    Ev('content_block_delta', index=1, delta=Attrs(type='text_delta', text=' there')),
    Ev('content_block_stop', index=1),
    Ev('message_stop'),
]
next_response = {'content': [FakeText()]}


class FakeStream:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(STREAM_EVENTS)


class FakeMessages:
    def create(self, **kwargs):
        CREATE_SIG.bind(None, **kwargs)  # raises TypeError exactly like the SDK would
        calls.append(('create', kwargs))
        response = FakeResponse()
        response.content = next_response['content']
        return response

    def stream(self, **kwargs):
        STREAM_SIG.bind(None, **kwargs)
        calls.append(('stream', kwargs))
        return FakeStream()


class FakeClient:
    def __init__(self, *args, **kwargs):
        self.messages = FakeMessages()


anthropic.Anthropic = FakeClient
anthropic.AnthropicVertex = FakeClient

import ai_chat  # noqa: E402  (after the SDK clients are swapped)

settings = {}
ai_chat.setting = lambda key, default=None: settings.get(key, default)

MESSAGES = [{'role': 'system', 'content': 'be brief'}, {'role': 'user', 'content': 'hi'}]

for mode, values in (
    ('API key', {'ANTHROPIC_API_KEY': 'test-key'}),
    ('Vertex AI', {'ANTHROPIC_USE_VERTEX': 'true', 'ANTHROPIC_GCP_PROJECT_ID': 'test-project'}),
):
    settings.clear()
    settings.update(values)

    calls.clear()
    try:
        out = ai_chat.handle_anthropic_chat(MESSAGES, 'claude-test', 0, 64)
        check(f'{mode}: non-streaming chat sends only parameters the SDK accepts', calls and calls[0][0] == 'create' and out == 'ok', repr(calls))
    except TypeError as e:
        check(f'{mode}: non-streaming chat sends only parameters the SDK accepts', False, str(e))

    calls.clear()
    try:
        list(ai_chat.handle_anthropic_chat_stream(MESSAGES, 'claude-test', 0, 64))
        check(f'{mode}: streaming chat sends only parameters the SDK accepts', calls and calls[0][0] == 'stream', repr(calls))
    except TypeError as e:
        check(f'{mode}: streaming chat sends only parameters the SDK accepts', False, str(e))

    if calls:
        kw = calls[0][1]
        check(f'{mode}: the system prompt, model and max_tokens are still sent', kw.get('model') == 'claude-test' and kw.get('max_tokens') == 64 and kw.get('system'), repr(kw))
        check(f'{mode}: no sampling parameter reaches the SDK (temperature, top_p, top_k)', not ({'temperature', 'top_p', 'top_k'} & set(kw)), repr(sorted(kw)))

    # (b) the response text is every text block joined: thinking-first and empty content do not crash
    for label, content, expected in (
        ('a thinking block first', [FakeThinking(), FakeText()], 'ok'),
        ('two text blocks', [FakeText(), FakeText()], 'okok'),
        ('an empty content list', [], ''),
    ):
        next_response['content'] = content
        try:
            out = ai_chat.handle_anthropic_chat(MESSAGES, 'claude-test', 0, 64)
            check(f'{mode}: {label} gives the joined text ({expected!r})', out == expected, repr(out))
        except Exception as e:  # noqa: BLE001 - the old code raised AttributeError / IndexError here
            check(f'{mode}: {label} gives the joined text ({expected!r})', False, f'{type(e).__name__}: {e}')
    next_response['content'] = [FakeText()]

    # (c) the streaming handler's events, in order
    calls.clear()
    events = list(ai_chat.handle_anthropic_chat_stream(MESSAGES, 'claude-test', 0, 64))
    check(f'{mode}: the stream yields thinking_start, thinking, thinking_end, then the text deltas', events == [
        {'type': 'thinking_start'}, {'type': 'thinking', 'content': 'let me see'}, {'type': 'thinking_end'},
        {'type': 'content', 'content': 'Hello'}, {'type': 'content', 'content': ' there'},
    ], repr(events))

    # the fallback model, per path
    calls.clear()
    ai_chat.handle_anthropic_chat(MESSAGES, '', 0, 64)
    fallback = calls[0][1].get('model')
    check(f'{mode}: with no model configured the fallback is the {"Vertex id" if mode == "Vertex AI" else "API alias"}',
          fallback == ('claude-sonnet-4-5@20250929' if mode == 'Vertex AI' else 'claude-sonnet-4-5'), repr(fallback))
    calls.clear()
    list(ai_chat.handle_anthropic_chat_stream(MESSAGES, '', 0, 64))
    check(f'{mode}: ...streaming too', calls[0][1].get('model') == ('claude-sonnet-4-5@20250929' if mode == 'Vertex AI' else 'claude-sonnet-4-5'), repr(calls[0][1].get('model')))

# (d) Bedrock: a raw invoke_model body through a fake boto3
import json  # noqa: E402
import types  # noqa: E402

bedrock_calls = []


class FakeBody:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload


class FakeBedrock:
    def invoke_model(self, modelId, body):
        bedrock_calls.append((modelId, json.loads(body)))
        return {'body': FakeBody({'content': [{'type': 'thinking', 'thinking': 'x'}, {'type': 'text', 'text': 'from '}, {'type': 'text', 'text': 'bedrock'}]})}


fake_boto3 = types.ModuleType('boto3')
fake_boto3.client = lambda service_name, region_name=None: FakeBedrock()
sys.modules['boto3'] = fake_boto3
settings.clear()
settings.update({'ANTHROPIC_USE_BEDROCK': 'true', 'AWS_REGION': 'us-east-1'})
out = ai_chat.handle_anthropic_chat(MESSAGES, 'anthropic.claude-test:0', 0.2, 64)
body = bedrock_calls[0][1] if bedrock_calls else {}
check('Bedrock: the raw body keeps temperature (only the SDK dropped it), the system prompt as a list, max_tokens', body.get('temperature') == 0.2 and body.get('system') == [{'type': 'text', 'text': 'be brief'}] and body.get('max_tokens') == 64, repr(body))
check('Bedrock: the text blocks of the raw body are joined, a thinking block skipped', out == 'from bedrock', repr(out))

# OpenAI: the v1 client, no temperature for the reasoning models
import openai  # noqa: E402

openai_calls = []


class FakeCompletions:
    def create(self, **kwargs):
        openai_calls.append(kwargs)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content='hi'))])


class FakeOpenAI:
    def __init__(self, api_key=None, **kwargs):
        self.chat = types.SimpleNamespace(completions=FakeCompletions())


openai.OpenAI = FakeOpenAI
settings.clear()
settings.update({'OPENAI_API_KEY': 'test-key'})
openai_calls.clear()
out = ai_chat.handle_openai_chat(MESSAGES, 'gpt-4o-mini', 0.3, 64)
check('OpenAI: the v1 client is used (openai.ChatCompletion is gone in openai>=1.0) and a chat model gets its temperature', out == 'hi' and openai_calls and openai_calls[0].get('temperature') == 0.3 and openai_calls[0].get('model') == 'gpt-4o-mini', repr(openai_calls))
for model in ('o1-mini', 'o3', 'gpt-5', 'gpt-5-mini'):
    openai_calls.clear()
    ai_chat.handle_openai_chat(MESSAGES, model, 0, 64)
    check(f'OpenAI: {model} (a reasoning model) is sent no temperature', openai_calls and 'temperature' not in openai_calls[0], repr(openai_calls))

print()
if failures:
    print(f'{failures} check(s) failed')
    sys.exit(1)
print('All checks passed')
