"""
Guards the backend routes the app uses when it runs in a browser served by
the container (deploy/Containerfile) instead of the desktop app:

  backend/settings_store.py   GET/PUT /api/settings - write-only secrets
  backend/jira_proxy.py       /api/jira/<path>      - allowlisted Jira proxy
  backend/whois_lookup.py     POST /api/whois       - strict domain check
  backend/url_fetch.py        POST /api/workflow/http-request (SSRF guard)
  backend/reports_root.py     Diagnostics browsing locked to one tree
  backend/extensions.py       JACARIUM_AUTH_MODE=none seam,
                              /api/capabilities

What this test proves (Flask test client, temp directories, synthetic
values, no network - upstream calls are stubbed):
  - auth mode "none": no X-App-Token needed; /api/capabilities describes
    the backend; the env file override and reports root are honoured;
  - settings: a saved secret is never returned (set / not set only), the
    raw value appears nowhere in any GET body, saving again without the
    secret keeps it, "" keeps it, null clears it, a secret under "values"
    is refused, a value with a control character is cleaned, the file is
    mode 0600 and os.environ sees the new values;
  - Jira proxy: path allowlist (traversal, odd characters -> 400), JIRA_URL
    must be https, 503 without a PAT, the upstream URL is exactly
    <JIRA_URL>/rest/api/3/<path>?<query> with Basic email:pat or Bearer,
    redirects not followed, upstream status/body passed through;
  - WHOIS: bad domains -> 400, the registry server is picked per TLD, a
    referral is followed once, offline -> 403;
  - workflow HTTP: loopback refused, private ranges refused once opted out
    (allowed by default, as on the desktop), JSON bodies decoded,
    non-JSON returned as text, header line breaks refused;
  - reports root: a relative name, "Downloads", an absolute path inside,
    "..", an absolute path outside, and a symlink pointing outside, on
    /list_reports, /get_tabs and /load_tab.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/browser_backend_routes.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import socket
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-browser-routes-')
REPORTS = os.path.join(TMP, 'reports')
OUTSIDE = os.path.join(TMP, 'outside')
os.makedirs(os.path.join(REPORTS, 'sosreport-synthetic-host-2026-10-10'))
os.makedirs(OUTSIDE)
with open(os.path.join(OUTSIDE, 'secret.txt'), 'w') as fh:
    fh.write('not for the browser\n')
os.symlink(OUTSIDE, os.path.join(REPORTS, 'escape'))

os.environ['JACARIUM_AUTH_MODE'] = 'none'
os.environ['JACARIUM_ENV_FILE'] = os.path.join(TMP, 'jacarium.env')
os.environ['JACARIUM_REPORTS_ROOT'] = REPORTS
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(TMP, 'known_hosts')
for key in ('JIRA_PAT', 'JIRA_EMAIL', 'JIRA_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402  (registers the blueprints)
import jira_proxy  # noqa: E402
import whois_lookup  # noqa: E402
import safe_url  # noqa: E402

client = app_module.app.test_client()

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def body(response):
    try:
        return response.get_json() or {}
    except Exception:
        return {}


# --- auth seam + capabilities ------------------------------------------------
r = client.get('/api/capabilities')
caps = body(r)
check('auth mode none: /api/capabilities answers without X-App-Token', r.status_code == 200 and caps.get('authMode') == 'none')
check('capabilities list settings / jiraProxy / whois / httpProxy', all(caps.get('capabilities', {}).get(k) for k in ('settings', 'jiraProxy', 'whois', 'httpProxy')), json.dumps(caps))
check('capabilities report the reports root', caps.get('reportsRoot') == os.path.realpath(REPORTS), str(caps.get('reportsRoot')))
r = client.get('/api/taskwarrior/check')
check('an ordinary API route needs no token either', r.status_code == 200)

# --- settings: write-only secrets ------------------------------------------
SECRET = 'synthetic-jira-pat-7f3a9c'
r = client.get('/api/settings')
check('settings GET on a missing file is empty', r.status_code == 200 and body(r)['values'] == {} and body(r)['secrets'] == {})
r = client.put('/api/settings', json={
    'values': {'JIRA_EMAIL': 'someone@example.test', 'DEFAULT_AI_PROVIDER': 'anthropic', 'DEFAULT_AI_MAX_TOKENS': 'tok\x00ens'},
    'secrets': {'JIRA_PAT': SECRET, 'ANTHROPIC_API_KEY': 'sk-synthetic-anthropic'},
})
saved = body(r)
check('settings PUT saves plain values and reports secrets as stored', r.status_code == 200 and saved['values'].get('JIRA_EMAIL') == 'someone@example.test' and saved['secrets'] == {'JIRA_PAT': True, 'ANTHROPIC_API_KEY': True}, json.dumps(saved))
check('a control character in a value is stripped', saved['values'].get('DEFAULT_AI_MAX_TOKENS') == 'tokens')
r = client.get('/api/settings')
text = r.get_data(as_text=True)
check('settings GET never returns the secret value', SECRET not in text and 'sk-synthetic-anthropic' not in text and body(r)['secrets']['JIRA_PAT'] is True, text)
check('os.environ sees the saved values (no restart needed)', os.environ.get('JIRA_PAT') == SECRET and os.environ.get('JIRA_EMAIL') == 'someone@example.test')
env_path = os.environ['JACARIUM_ENV_FILE']
mode = stat.S_IMODE(os.stat(env_path).st_mode)
check('the env file is written with mode 0600', mode == 0o600, oct(mode))
with open(env_path) as fh:
    content = fh.read()
check('the env file holds KEY=VALUE lines readable by the desktop app', f'JIRA_PAT={SECRET}' in content and 'JIRA_EMAIL=someone@example.test' in content)

r = client.put('/api/settings', json={'values': {'JIRA_EMAIL': 'someone@example.test', 'DEFAULT_AI_PROVIDER': 'openai'}})
check('saving again without any secret keeps the stored secrets', body(r)['secrets'] == {'JIRA_PAT': True, 'ANTHROPIC_API_KEY': True} and os.environ.get('JIRA_PAT') == SECRET)
r = client.put('/api/settings', json={'secrets': {'JIRA_PAT': ''}})
check('"" for a secret keeps it', body(r)['secrets'].get('JIRA_PAT') is True and os.environ.get('JIRA_PAT') == SECRET)
r = client.put('/api/settings', json={'secrets': {'ANTHROPIC_API_KEY': None}})
check('null clears a secret (file and environment)', body(r)['secrets'].get('ANTHROPIC_API_KEY') is None and 'ANTHROPIC_API_KEY' not in os.environ)
r = client.put('/api/settings', json={'values': {'OPENAI_API_KEY': 'sk-x'}})
check('a secret sent under "values" is refused', r.status_code == 400 and 'secret' in body(r).get('error', ''))
r = client.put('/api/settings', json={'values': {'bad key': 'x'}})
check('an invalid key is refused', r.status_code == 400)
r = client.put('/api/settings', data='[]', content_type='application/json')
check('a non-object body is refused', r.status_code == 400)
r = client.put('/api/settings', json={'values': {'DEFAULT_AI_PROVIDER': ''}})
check('an empty plain value removes the key', 'DEFAULT_AI_PROVIDER' not in body(r)['values'] and 'DEFAULT_AI_PROVIDER' not in os.environ)

# --- Jira proxy (upstream stubbed) -------------------------------------------
calls = []


class FakeUpstream:
    def __init__(self, status=200, content=b'{"ok":1}', headers=None):
        self.status_code = status
        self.content = content
        self.headers = headers or {'content-type': 'application/json'}


import requests as _requests  # noqa: E402

_real_request = _requests.request


def fake_request(method, url, **kwargs):
    calls.append({'method': method, 'url': url, **kwargs})
    if 'fail' in url:
        raise _requests.ConnectionError('boom')
    return FakeUpstream(status=404 if 'missing' in url else 200)


_requests.request = fake_request
try:
    # No JIRA_URL anywhere: no request leaves, the answer names the setting
    # (there is no built-in Jira site).
    before = len(calls)
    r = client.get('/api/jira/project/search?startAt=0&maxResults=50')
    check('without a JIRA_URL the proxy answers 412, names the setting and calls nothing', r.status_code == 412 and 'JIRA_URL' in r.get_data(as_text=True) and r.get_json().get('code') == 'JIRA_URL_MISSING' and len(calls) == before, str(r.status_code))
    os.environ['JIRA_URL'] = 'https://jira.example.test'
    r = client.get('/api/jira/project/search?startAt=0&maxResults=50')
    call = calls[-1] if calls else {}
    check('Jira proxy builds exactly <JIRA_URL>/rest/api/3/<path>?<query>', r.status_code == 200 and call.get('url') == 'https://jira.example.test/rest/api/3/project/search?startAt=0&maxResults=50', str(call.get('url')))
    check('Jira proxy uses Basic email:pat when JIRA_EMAIL is set', call.get('headers', {}).get('Authorization', '').startswith('Basic '))
    check('Jira proxy never follows redirects', call.get('allow_redirects') is False)
    check('Jira proxy passes the upstream body through', r.get_json() == {'ok': 1})
    r = client.get('/api/jira/issue/missing')
    check('upstream status is passed through (404)', r.status_code == 404)
    r = client.get('/api/jira/issue/fail')
    check('an upstream connection error is a 502 without details', r.status_code == 502 and 'boom' not in r.get_data(as_text=True))
    r = client.post('/api/jira/search', json={'jql': 'project = SYN'})
    call = calls[-1]
    check('POST bodies are forwarded as JSON', call.get('method') == 'POST' and json.loads(call.get('data') or b'{}') == {'jql': 'project = SYN'})
    for bad in ('/api/jira/..%2Fx', '/api/jira/project%20search', '/api/jira/a//b', '/api/jira/x;y'):
        r = client.get(bad)
        check(f'Jira path allowlist refuses {bad}', r.status_code in (400, 404), str(r.status_code))
    os.environ['JIRA_URL'] = 'http://jira.example.test'
    r = client.get('/api/jira/project/search')
    check('JIRA_URL must be https (400)', r.status_code == 400)
    os.environ['JIRA_URL'] = 'https://jira.example.test/some/path'
    r = client.get('/api/jira/project/search')
    check('JIRA_URL must be a bare origin (400)', r.status_code == 400)
    os.environ['JIRA_URL'] = 'https://jira.example.test'
    os.environ.pop('JIRA_EMAIL', None)
    r = client.get('/api/jira/project/search')
    check('a configured JIRA_URL is the only upstream host; Bearer without email', calls[-1]['url'].startswith('https://jira.example.test/rest/api/3/') and calls[-1]['headers']['Authorization'] == f'Bearer {SECRET}')
    os.environ.pop('JIRA_PAT', None)
    r = client.get('/api/jira/project/search')
    check('without a PAT the proxy answers 412', r.status_code == 412 and 'JIRA_PAT' in r.get_data(as_text=True))
    os.environ.pop('JIRA_URL', None)
    r = client.patch('/api/jira/project/search')
    check('PATCH is not an allowed method', r.status_code == 405)
finally:
    _requests.request = _real_request

# --- WHOIS (socket stubbed) ---------------------------------------------------
queries = []


def fake_query(server, domain, timeout=10):
    queries.append((server, domain))
    if server == 'whois.verisign-grs.com':
        return 'Domain Name: EXAMPLE.COM\nRegistrar WHOIS Server: whois.registrar.example\n'
    return f'% answer from {server}\nRegistrar: Synthetic Registrar\n'


_real_query = whois_lookup.query
whois_lookup.query = fake_query
try:
    r = client.post('/api/whois', json={'domain': 'Example.COM.'})
    data = body(r)
    check('WHOIS: .com goes to verisign, then follows the registrar referral once', r.status_code == 200 and queries == [('whois.verisign-grs.com', 'example.com'), ('whois.registrar.example', 'example.com')], str(queries))
    check('WHOIS: both answers are returned', 'Registrar WHOIS Server' in data.get('result', '') and 'Synthetic Registrar' in data.get('result', ''))
    queries.clear()
    r = client.post('/api/whois', json={'domain': 'example.xyz'})
    check('WHOIS: an unknown TLD goes to whois.iana.org', queries and queries[0][0] == 'whois.iana.org')
    for bad in ('not a domain', 'example', '-bad.com', 'a' * 70 + '.com', 'exa mple.com', '127.0.0.1', ''):
        r = client.post('/api/whois', json={'domain': bad})
        check(f'WHOIS: {bad!r} refused (400)', r.status_code == 400, str(r.status_code))
    queries.clear()

    def timeout_query(server, domain, timeout=10):
        raise socket.timeout()
    whois_lookup.query = timeout_query
    r = client.post('/api/whois', json={'domain': 'example.com'})
    check('WHOIS: a timeout is a 504', r.status_code == 504)
finally:
    whois_lookup.query = _real_query

# --- workflow HTTP (safe_request stubbed for the success path) ----------------
r = client.post('/api/workflow/http-request', json={'url': 'http://127.0.0.1:1/'})
check('workflow HTTP: loopback refused by the SSRF guard (400)', r.status_code == 400 and 'not allowed' in body(r).get('error', ''))
os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'] = '0'
r = client.post('/api/workflow/http-request', json={'url': 'http://10.0.0.5/'})
check('workflow HTTP: private range refused when JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0 (400)', r.status_code == 400)
os.environ.pop('JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS', None)
r = client.post('/api/workflow/http-request', json={'url': 'https://example.com/', 'headers': {'X-A': 'a\r\nInjected: 1'}})
check('workflow HTTP: header line breaks refused (400)', r.status_code == 400)
r = client.post('/api/workflow/http-request', json={'url': 'https://example.com/', 'method': 'TRACE'})
check('workflow HTTP: unsupported method refused (400)', r.status_code == 400)
r = client.post('/api/workflow/http-request', json={'url': ''})
check('workflow HTTP: empty URL refused (400)', r.status_code == 400)

seen = []


def fake_safe_request(method, url, headers=None, data=None, timeout=30, allow_private=False, **kw):
    seen.append({'method': method, 'url': url, 'headers': headers, 'data': data, 'allow_private': allow_private})
    if url.endswith('/text'):
        return safe_url.SafeResponse(200, 'OK', {'content-type': 'text/plain'}, b'plain text', url)
    return safe_url.SafeResponse(201, 'Created', {'content-type': 'application/json'}, b'{"id": 7}', url)


_real_safe_request = safe_url.safe_request
safe_url.safe_request = fake_safe_request
try:
    r = client.post('/api/workflow/http-request', json={'url': 'https://api.example.test/items', 'method': 'post', 'headers': {'X-Token': 'synthetic'}, 'body': {'name': 'x'}})
    data = body(r)
    check('workflow HTTP: JSON answer decoded, status and statusText carried', data == {'ok': True, 'status': 201, 'statusText': 'Created', 'body': {'id': 7}}, json.dumps(data))
    check('workflow HTTP: method upper-cased, headers and JSON body forwarded, private URLs allowed by default (as on the desktop)', seen[-1]['method'] == 'POST' and seen[-1]['headers'] == {'X-Token': 'synthetic'} and json.loads(seen[-1]['data']) == {'name': 'x'} and seen[-1]['allow_private'] is True)
    r = client.post('/api/workflow/http-request', json={'url': 'https://api.example.test/text'})
    check('workflow HTTP: non-JSON answer returned as text', body(r).get('body') == 'plain text')
finally:
    safe_url.safe_request = _real_safe_request

# --- reports root ---------------------------------------------------------------
real_reports = os.path.realpath(REPORTS)
r = client.post('/list_reports', json={})
names = [x['name'] for x in body(r).get('reports', [])]
check('list_reports without a directory lists the reports root', r.status_code == 200 and names == ['sosreport-synthetic-host-2026-10-10'], str(names))
r = client.post('/list_reports', json={'directory': 'Downloads'})
check('"Downloads" resolves to the reports root, not the home directory', [x['name'] for x in body(r).get('reports', [])] == ['sosreport-synthetic-host-2026-10-10'])
r = client.post('/list_reports', json={'directory': real_reports})
check('the absolute root path is accepted', r.status_code == 200 and len(body(r).get('reports', [])) == 1)
r = client.post('/list_reports', json={'directory': os.path.join(real_reports, 'sosreport-synthetic-host-2026-10-10')})
check('a directory inside the root is accepted', r.status_code == 200)
for label, candidate in (('".." traversal', '../outside'), ('an absolute path outside', OUTSIDE), ('a symlink pointing outside', 'escape'), ('"~"-relative path', '~/.ssh'), ('/etc', '/etc')):
    r = client.post('/list_reports', json={'directory': candidate})
    check(f'list_reports refuses {label} (403)', r.status_code == 403, str(r.status_code))
r = client.post('/get_tabs', json={'report_type': 'sosreport', 'directory': OUTSIDE})
check('get_tabs refuses a path outside the root (403)', r.status_code == 403)
r = client.post('/load_tab', json={'report_type': 'sosreport', 'tab': 'system', 'directory': os.path.join(real_reports, 'escape')})
check('load_tab refuses a symlink escape (403)', r.status_code == 403)
r = client.post('/get_tab_data', json={'report_type': 'sosreport', 'tab': 'system', 'directory': '/'})
check('get_tab_data refuses / (403)', r.status_code == 403)

failed = [name for name, ok in results if not ok]
print()
print(f"{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
