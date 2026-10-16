"""
Release check against GitHub, for a self-hosted server.

The SERVER checks, not the browsers: one request per server, when an
administrator turned the check on, at most once a day, and the result is
shown to administrators only (Settings > About says "a newer release is
available" with the update commands). Ordinary users' browsers never
contact GitHub, and neither does the server unless it was told to.

Privacy: a plain unauthenticated GET of the releases list with two fixed
headers (Accept and a version-less User-Agent, which GitHub requires); no
version, identifier or cookie goes out. GitHub sees the request's IP
address. The outbound request goes through `requests`, which honours the
HTTP(S)_PROXY / NO_PROXY environment. Any failure (offline, proxy, GitHub
down or rate-limited) is recorded and otherwise silent.

State: <server home>/update-check.json (/data in the container) holds the
setting, the last result and when it was fetched. JACARIUM_UPDATE_CHECK=on
in the environment turns the check on without the setting (for a quadlet
or compose file).

Routes (administrators only):
    GET  /api/update-check             the setting and the last result
    POST /api/update-check/run         one request now, whatever the setting
    PUT  /api/update-check/settings    {"autoCheck": true|false}
"""
import json
import os
import re
import threading
import time

from flask import Blueprint, jsonify, request

RELEASES_API_URL = 'https://api.github.com/repos/jacarium/jacarium/releases?per_page=30'
RELEASES_PAGE_URL = 'https://github.com/jacarium/jacarium/releases'
CHECK_INTERVAL_S = 24 * 60 * 60
REQUEST_TIMEOUT_S = 10
RELEASE_TAG = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')
REQUEST_HEADERS = {'Accept': 'application/vnd.github+json', 'User-Agent': 'jacarium-update-check'}

update_check_api = Blueprint('update_check_api', __name__)
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# pure helpers (tests/update_check_backend.test.py)
# ---------------------------------------------------------------------------
def parse_version(value):
    """(major, minor, patch) of '3.1.9' / 'v3.1.9', or None."""
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)$', str(value or '').strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def compare_versions(a, b):
    pa = parse_version(a) or (-1, -1, -1)
    pb = parse_version(b) or (-1, -1, -1)
    return (pa > pb) - (pa < pb)


def normalize_releases(payload):
    """Published vX.Y.Z releases of the GitHub answer, newest first."""
    if not isinstance(payload, list):
        return []
    out = []
    for r in payload:
        if not isinstance(r, dict) or r.get('draft') or r.get('prerelease'):
            continue
        m = RELEASE_TAG.match(str(r.get('tag_name') or ''))
        if not m:
            continue
        out.append({
            'version': '%s.%s.%s' % m.groups(),
            'tag': r.get('tag_name'),
            'name': r.get('name') if isinstance(r.get('name'), str) else '',
            'body': r.get('body') if isinstance(r.get('body'), str) else '',
            'publishedAt': r.get('published_at') if isinstance(r.get('published_at'), str) else None,
            'url': r.get('html_url') if isinstance(r.get('html_url'), str) else RELEASES_PAGE_URL,
        })
    out.sort(key=lambda r: parse_version(r['version']), reverse=True)
    return out


def releases_newer_than(releases, current):
    return [r for r in releases if compare_versions(r['version'], current) > 0]


def notes_since(releases, current):
    """One Markdown section per version newer than `current`, newest first."""
    parts = []
    for r in releases_newer_than(releases, current):
        date = ' (%s)' % r['publishedAt'][:10] if r.get('publishedAt') else ''
        parts.append('## Version %s%s\n\n%s\n' % (r['version'], date, (r.get('body') or '').strip() or '_No release notes._'))
    return '\n'.join(parts)


def is_check_due(last_checked_at, now, interval_s=CHECK_INTERVAL_S):
    try:
        last = float(last_checked_at or 0)
    except (TypeError, ValueError):
        last = 0
    return now - last >= interval_s


# ---------------------------------------------------------------------------
# the checker
# ---------------------------------------------------------------------------
class UpdateChecker:
    """
    One per server. `fetch_json(url, headers, timeout)` and `now()` are
    injectable for the tests; the defaults use `requests` and the clock.
    """

    def __init__(self, current_version, store_path, fetch_json=None, now=None, env=None, log=None):
        self.current_version = current_version
        self.store_path = store_path
        self._fetch_json = fetch_json or _requests_fetch_json
        self._now = now or time.time
        self._env = env if env is not None else os.environ
        self._log = log or (lambda message: None)

    # -- store --
    def _read(self):
        try:
            with open(self.store_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, partial):
        data = self._read()
        data.update(partial)
        try:
            os.makedirs(os.path.dirname(self.store_path) or '.', exist_ok=True)
            tmp = self.store_path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, self.store_path)
        except OSError as error:
            self._log('[UpdateCheck] could not save %s: %s' % (self.store_path, error))

    # -- settings --
    def auto_check_enabled(self):
        if str(self._env.get('JACARIUM_UPDATE_CHECK', '')).lower() in ('on', '1', 'true', 'yes'):
            return True
        return self._read().get('autoCheck') is True

    def set_auto_check(self, enabled):
        self._write({'autoCheck': enabled is True})
        return self.status()

    # -- state --
    def status(self):
        store = self._read()
        releases = store.get('releases') if isinstance(store.get('releases'), list) else []
        newer = releases_newer_than(releases, self.current_version)
        latest = newer[0] if newer else None
        return {
            'currentVersion': self.current_version,
            'autoCheck': self.auto_check_enabled(),
            'autoCheckFromEnvironment': str(self._env.get('JACARIUM_UPDATE_CHECK', '')).lower() in ('on', '1', 'true', 'yes'),
            'lastCheckedAt': store.get('lastCheckedAt'),
            'lastError': store.get('lastError'),
            'latestVersion': latest['version'] if latest else None,
            'updateAvailable': latest is not None,
            'releases': [{'version': r['version'], 'name': r.get('name'), 'publishedAt': r.get('publishedAt'), 'url': r.get('url')} for r in newer],
            'notes': notes_since(releases, self.current_version),
            'releasesPage': RELEASES_PAGE_URL,
        }

    def check(self, manual=False):
        """One request; the scheduled check only when turned on. Never raises."""
        if not manual and not self.auto_check_enabled():
            return self.status()
        with _lock:
            try:
                payload = self._fetch_json(RELEASES_API_URL, dict(REQUEST_HEADERS), REQUEST_TIMEOUT_S)
                releases = normalize_releases(payload)
                self._write({'lastCheckedAt': self._now(), 'lastError': None, 'releases': releases})
                self._log('[UpdateCheck] %d release(s); newest %s, running %s' % (len(releases), releases[0]['version'] if releases else 'none', self.current_version))
            except Exception as error:  # offline, proxy, GitHub down or rate-limited: silent
                self._write({'lastCheckedAt': self._now(), 'lastError': str(error)})
                self._log('[UpdateCheck] check failed: %s' % error)
        return self.status()

    def tick(self):
        if not self.auto_check_enabled():
            return None
        if not is_check_due(self._read().get('lastCheckedAt'), self._now()):
            return None
        return self.check()


def _requests_fetch_json(url, headers, timeout):
    import requests
    response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    if response.status_code != 200:
        raise RuntimeError('GitHub answered %s' % response.status_code)
    return response.json()


# ---------------------------------------------------------------------------
# the server's instance, its hourly tick and the routes
# ---------------------------------------------------------------------------
_checker = None


def checker():
    """The server's checker (created on first use: home and version are known by then)."""
    global _checker
    if _checker is None:
        from user_context import server_home
        from version_info import version_info
        _checker = UpdateChecker(version_info()['app'], os.path.join(server_home(), 'update-check.json'), log=print)
    return _checker


def start_update_check_scheduler(interval_s=60 * 60):
    """A daemon thread: every hour, the scheduled tick (which does nothing while the check is off)."""
    def run():
        while True:
            time.sleep(interval_s)
            try:
                checker().tick()
            except Exception as error:  # never let the thread die
                print('[UpdateCheck] tick failed: %s' % error)
    thread = threading.Thread(target=run, name='update-check', daemon=True)
    thread.start()
    return thread


def _admin_only():
    from auth import require_admin
    return require_admin()


@update_check_api.route('/api/update-check', methods=['GET'])
def _status():
    refused = _admin_only()
    if refused:
        return refused
    return jsonify(checker().status())


@update_check_api.route('/api/update-check/run', methods=['POST'])
def _run():
    refused = _admin_only()
    if refused:
        return refused
    return jsonify(checker().check(manual=True))


@update_check_api.route('/api/update-check/settings', methods=['PUT'])
def _settings():
    refused = _admin_only()
    if refused:
        return refused
    body = request.get_json(silent=True) or {}
    if not isinstance(body.get('autoCheck'), bool):
        return jsonify({'error': 'autoCheck must be true or false'}), 400
    return jsonify(checker().set_auto_check(body['autoCheck']))
