#!/usr/bin/env python3
"""
What Flask-Compress does to the backend's responses, pinned at the version requirements.lock holds (1.25 since
the 3.4.9 dependency batch; 1.15 before). backend/extensions.py registers Compress(app) with no COMPRESS_*
setting, so the library's defaults are the backend's behaviour - and 1.16..1.25 changed several of them:
the algorithm order (zstd first, then br, gzip, deflate), streaming responses compressed chunk by chunk with
zstd / br / deflate (never gzip), conditional requests evaluated by default (ETag carries ":<algorithm>",
If-None-Match answers 304), a wider mimetype list. This test fixes what matters here:

 1. a JSON answer of 500 bytes or more is compressed with what the client accepts - gzip, br or zstd - and
    decompresses to the same bytes; a browser's list (gzip, deflate, br, zstd) now gets zstd; Vary carries
    Accept-Encoding; a small answer (< 500 bytes) and a non-2xx answer stay as they are;
 2. the server-sent event streams (text/event-stream: ai_chat.py, rag_chat.py, log_viewer.py) are NOT compressed
    (the mimetype is outside COMPRESS_MIMETYPES) and arrive event by event, in order, uncompressed - the live
    chats and log tails depend on that; a guard reads the three modules so a future mimetype change is caught;
 3. a streamed text/plain response (none in the backend today) shows the new streaming behaviour: chunk by chunk
    with zstd/br/deflate, never gzip, and decompresses whole;
 4. the conditional default: an answer with an ETag gets ":<algorithm>" appended and a matching If-None-Match
    is a 304.

Run: backend/venv/bin/python tests/flask_compress_responses.test.py
"""
import gzip
import json
import os
import re
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

try:
    from flask import Flask, Response, jsonify, stream_with_context
    from flask_compress import Compress
    import flask_compress
except ImportError:
    print('Missing dependency "flask"/"flask_compress". Run with the backend venv: backend/venv/bin/python tests/flask_compress_responses.test.py')
    sys.exit(1)
try:
    import brotli
except ImportError:
    brotli = None
try:
    from compression import zstd  # Python 3.14 standard library (what Flask-Compress 1.25 uses here)
except ImportError:
    zstd = None

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def version_tuple(text):
    return tuple(int(x) for x in re.findall(r'\d+', text)[:2])


locked = re.search(r'^flask-compress==([\d.]+)', open(os.path.join(BACKEND, 'requirements.lock'), encoding='utf-8').read(), re.M)
installed = getattr(flask_compress, '__version__', None) or __import__('importlib.metadata').metadata.version('Flask-Compress')
check(f'the installed Flask-Compress ({installed}) is the locked one ({locked.group(1) if locked else "?"})',
      locked is not None and version_tuple(installed) == version_tuple(locked.group(1)), f'{installed} vs {locked and locked.group(1)}')

# the backend's registration: no COMPRESS_* setting, so the defaults below are the backend's behaviour
extensions_src = open(os.path.join(BACKEND, 'extensions.py'), encoding='utf-8').read()
check('backend/extensions.py registers Compress(app) with no COMPRESS_* setting (the defaults apply)',
      'Compress(app)' in extensions_src and 'COMPRESS_' not in extensions_src)

# the same registration on a small app with the response shapes the backend produces
app = Flask(__name__)
Compress(app)
BIG = {'rows': [{'id': i, 'name': f'row-{i}', 'note': 'x' * 40} for i in range(40)]}   # well over 500 bytes
EVENTS = [f'data: {json.dumps({"chunk": i, "text": "word " * 5})}\n\n' for i in range(6)]


@app.route('/big')
def big():
    return jsonify(BIG)


@app.route('/small')
def small():
    return jsonify({'ok': True})


@app.route('/missing')
def missing():
    return jsonify({'error': 'no', 'pad': 'x' * 600}), 404


@app.route('/tagged')
def tagged():
    r = jsonify(BIG)
    r.set_etag('v1')
    return r


@app.route('/events')
def events():
    # the shape of ai_chat.py / rag_chat.py / log_viewer.py: a generator, stream_with_context, text/event-stream
    def generate():
        for e in EVENTS:
            yield e
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@app.route('/plain-stream')
def plain_stream():
    def generate():
        for i in range(6):
            yield ('line %d ' % i) + ('y' * 200) + '\n'
    return Response(stream_with_context(generate()), mimetype='text/plain')


client = app.test_client()
BROWSER = 'gzip, deflate, br, zstd'


def get(path, accept):
    return client.get(path, headers={'Accept-Encoding': accept} if accept is not None else {})


def decompress(body, encoding):
    if encoding == 'gzip':
        return gzip.decompress(body)
    if encoding == 'deflate':
        return zlib.decompress(body)
    if encoding == 'br':
        return brotli.decompress(body)
    if encoding == 'zstd':
        return zstd.decompress(body)
    raise ValueError(encoding)


# --- 1. ordinary JSON answers ------------------------------------------------
expected = json.dumps(BIG).encode()
r = get('/big', 'gzip')
check('a large JSON answer is gzip-compressed for a gzip-only client and decompresses to the same JSON',
      r.headers.get('Content-Encoding') == 'gzip' and json.loads(decompress(r.data, 'gzip')) == BIG, r.headers.get('Content-Encoding'))
check('Vary: Accept-Encoding is set', 'accept-encoding' in (r.headers.get('Vary') or '').lower(), r.headers.get('Vary'))
check('Content-Length is the compressed length', r.headers.get('Content-Length') == str(len(r.data)) and len(r.data) < len(expected))
if brotli:
    r = get('/big', 'br')
    check('br for a brotli client', r.headers.get('Content-Encoding') == 'br' and json.loads(decompress(r.data, 'br')) == BIG, r.headers.get('Content-Encoding'))
else:
    print('SKIP - brotli not importable in this interpreter')
if zstd:
    r = get('/big', 'zstd')
    check('zstd for a zstd client (the standard library compression.zstd on Python 3.14)', r.headers.get('Content-Encoding') == 'zstd' and json.loads(decompress(r.data, 'zstd')) == BIG, r.headers.get('Content-Encoding'))
    r = get('/big', BROWSER)
    check("a browser's Accept-Encoding (gzip, deflate, br, zstd) gets zstd - the 1.25 priority (1.15 chose br)", r.headers.get('Content-Encoding') == 'zstd', r.headers.get('Content-Encoding'))
else:
    print('SKIP - compression.zstd not importable (Python < 3.14)')
r = get('/big', None)
check('no Accept-Encoding: uncompressed JSON', 'Content-Encoding' not in r.headers and r.get_json() == BIG)
r = get('/small', BROWSER)
check('a small answer (< 500 bytes) is not compressed', 'Content-Encoding' not in r.headers and r.get_json() == {'ok': True})
r = get('/missing', BROWSER)
check('a non-2xx answer is not compressed', r.status_code == 404 and 'Content-Encoding' not in r.headers)

# --- 2. the server-sent event streams ------------------------------------------
r = get('/events', BROWSER)
chunks = list(r.response) if not isinstance(r.response, (bytes, str)) else [r.response]
chunks = [c.decode() if isinstance(c, bytes) else c for c in chunks]
check('text/event-stream is outside COMPRESS_MIMETYPES: the SSE stream is not compressed',
      'Content-Encoding' not in r.headers and r.mimetype == 'text/event-stream', dict(r.headers))
check('the events arrive one per chunk, in order, unchanged (nothing buffered or re-chunked)', chunks == EVENTS, (len(chunks), chunks[:2]))
r.close()
check("'text/event-stream' is not in the library's default mimetype list",
      'text/event-stream' not in {m for m in app.config['COMPRESS_MIMETYPES']})
for module, marker in (('ai_chat.py', 'text/event-stream'), ('rag_chat.py', 'text/event-stream'), ('log_viewer.py', 'text/event-stream')):
    src = open(os.path.join(BACKEND, module), encoding='utf-8').read()
    check(f"{module} streams as mimetype='{marker}' (outside the compressed mimetypes)", f"mimetype='{marker}'" in src)
check('streaming defaults: COMPRESS_STREAMS on, streaming algorithms zstd/br/deflate and never gzip',
      app.config['COMPRESS_STREAMS'] is True and 'gzip' not in app.config['COMPRESS_ALGORITHM_STREAMING'] and set(app.config['COMPRESS_ALGORITHM_STREAMING']) <= {'zstd', 'br', 'deflate'}, app.config['COMPRESS_ALGORITHM_STREAMING'])

# --- 3. a streamed text/plain response: the new chunk-by-chunk behaviour ---------------------
r = get('/plain-stream', 'gzip')
body = b''.join(c if isinstance(c, bytes) else c.encode() for c in r.response); r.close()
check('a streamed text/plain response stays uncompressed for a gzip-only client (gzip is not a streaming algorithm)',
      'Content-Encoding' not in r.headers and body.startswith(b'line 0 '), r.headers.get('Content-Encoding'))
if zstd:
    r = get('/plain-stream', BROWSER)
    parts = [c if isinstance(c, bytes) else c.encode() for c in r.response]; r.close()
    whole = decompress(b''.join(parts), r.headers.get('Content-Encoding', ''))
    check('a streamed text/plain response is compressed in the stream (zstd for a browser), no Content-Length, and decompresses whole',
          r.headers.get('Content-Encoding') == 'zstd' and 'Content-Length' not in r.headers and whole.count(b'\n') == 6 and whole.startswith(b'line 0 '), (r.headers.get('Content-Encoding'), len(parts)))
    # _compress_chunks feeds each chunk to the compressor without a flush, so output appears only when the
    # compressor's buffer fills or at the end: a compressed stream is NOT delivered chunk by chunk (six small
    # lines came out as one part here). That is why the live event streams must stay outside the compressed
    # mimetypes (checked above) - compressing them would hold the events back until the stream ends.
    check('a compressed stream is buffered by the compressor (fewer parts than source chunks) - the reason SSE must not be compressed',
          len(parts) < 6, len(parts))

# --- 4. conditional requests (COMPRESS_EVALUATE_CONDITIONAL_REQUEST on by default) -------------
r = get('/tagged', 'gzip')
etag = r.headers.get('ETag')
check('a strong ETag gets ":<algorithm>" appended on the compressed answer', etag == '"v1:gzip"', etag)
r2 = client.get('/tagged', headers={'Accept-Encoding': 'gzip', 'If-None-Match': etag or ''})
check('a matching If-None-Match answers 304 with no body (conditional requests are evaluated by default now)',
      r2.status_code == 304 and not r2.data, (r2.status_code, len(r2.data)))
check('conditional evaluation is on and applies to the static endpoint of a stream only',
      app.config['COMPRESS_EVALUATE_CONDITIONAL_REQUEST'] is True and app.config['COMPRESS_STREAMING_ENDPOINT_CONDITIONAL'] == ['static'])

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
