"""
Jira REST proxy for the app in a browser.

The desktop app calls Jira from the Electron main process ('jira-fetch' in
electron/main.cjs) with the PAT from the env file, so the renderer never
holds the credential and is not subject to CORS. This blueprint is the
same thing server-side:

    <method> /api/jira/<subpath>?<query>   ->   <JIRA_URL>/rest/api/3/<subpath>?<query>

Allowlist: exactly the configured host (``JIRA_URL``, Settings >
Integrations > Jira - there is no built-in default: without it the proxy
answers 412 and says which setting to fill), the ``/rest/api/3/`` prefix, a
subpath of plain path characters, GET/POST/PUT/DELETE, JSON bodies only, no
redirects followed. Credentials: Basic
``JIRA_EMAIL:JIRA_PAT`` when the email is set (Atlassian Cloud), else
``Bearer JIRA_PAT``.
"""
import base64
import os
import re
from urllib.parse import urlsplit

from flask import Blueprint, Response, jsonify, request

from settings_store import setting

jira_proxy = Blueprint('jira_proxy', __name__)

JIRA_URL_MISSING = ('JIRA_URL not configured - set your Jira URL in Settings > Integrations > Jira '
                    '(e.g. https://your-company.atlassian.net)')
_SUBPATH_RE = re.compile(r'^[A-Za-z0-9_\-./]+$')
_ALLOWED_METHODS = ('GET', 'POST', 'PUT', 'DELETE')
_TIMEOUT_SECONDS = 30
_MAX_BODY_BYTES = 2 * 1024 * 1024
_FORWARDED_RESPONSE_HEADERS = ('content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after')


class JiraNotConfigured(Exception):
    """No JIRA_URL anywhere (user file, server defaults, environment)."""


def jira_base_url():
    raw = (setting('JIRA_URL') or '').strip().rstrip('/')
    if not raw:
        raise JiraNotConfigured(JIRA_URL_MISSING)
    parts = urlsplit(raw)
    if parts.scheme != 'https' or not parts.netloc or parts.path not in ('', '/'):
        raise ValueError('JIRA_URL must be an https:// origin without a path')
    return f'https://{parts.netloc}'


def auth_header():
    pat = setting('JIRA_PAT', '')
    if not pat:
        return None
    email = setting('JIRA_EMAIL', '')
    if email:
        token = base64.b64encode(f'{email}:{pat}'.encode('utf-8')).decode('ascii')
        return f'Basic {token}'
    return f'Bearer {pat}'


def validate_subpath(subpath):
    if not subpath or not _SUBPATH_RE.match(subpath) or '..' in subpath or '//' in subpath:
        raise ValueError('invalid Jira API path')
    return subpath.lstrip('/')


@jira_proxy.route('/api/jira/<path:subpath>', methods=_ALLOWED_METHODS)
def proxy(subpath):
    # the path first: a bad request is refused (400) whatever the configuration
    try:
        clean = validate_subpath(subpath)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    try:
        base = jira_base_url()
    except JiraNotConfigured as exc:
        return jsonify({'error': str(exc), 'code': 'JIRA_URL_MISSING'}), 412
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    auth = auth_header()
    if not auth:
        return jsonify({'error': 'JIRA_PAT not configured (Settings > Integrations)', 'code': 'JIRA_PAT_MISSING'}), 412
    body = None
    if request.method in ('POST', 'PUT'):
        if request.content_length and request.content_length > _MAX_BODY_BYTES:
            return jsonify({'error': 'request body too large'}), 413
        body = request.get_data()
    url = f'{base}/rest/api/3/{clean}'
    if request.query_string:
        url += '?' + request.query_string.decode('utf-8', 'replace')
    headers = {
        'Authorization': auth,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
    import requests
    try:
        upstream = requests.request(
            request.method, url, headers=headers, data=body,
            timeout=_TIMEOUT_SECONDS, allow_redirects=False,
        )
    except requests.RequestException as exc:
        return jsonify({'error': f'Jira request failed: {exc.__class__.__name__}'}), 502
    out = Response(upstream.content, status=upstream.status_code)
    for name in _FORWARDED_RESPONSE_HEADERS:
        if name in upstream.headers:
            out.headers[name] = upstream.headers[name]
    return out
