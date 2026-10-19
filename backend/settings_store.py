"""
Settings (the ``.jacarium.env`` file) over HTTP, for the app in a
browser, and the one place the backend reads a setting from.

The desktop app reads and writes that file from the Electron main process
('read-env-file' / 'write-env-file' in electron/main.cjs). In a container
there is no main process: the browser talks to this blueprint instead.

Write-only secrets
    Values that are credentials (Jira PAT, API keys, client secrets,
    passwords - see ``is_secret_key``) are never returned to the browser.
    ``GET /api/settings`` reports them only as set / not set;
    ``PUT /api/settings`` changes a secret only when the request carries a
    new non-empty value for it, clears it on an explicit ``null``, and
    leaves it untouched when the key is absent - so saving the dialog
    without typing a secret again never wipes it.

Where the file lives
    app-token / none:  ``JACARIUM_ENV_FILE`` if set, else
                       ``~/.jacarium.env`` (the container runs with
                       HOME=/data, so /data/.jacarium.env). After
                       every write the values are re-applied to
                       ``os.environ`` so the rest of this process sees them
                       without a restart.
    accounts:          every account has its own ``~/.jacarium.env``
                       (``~`` = the account's home, see user_context.py),
                       and an admin keeps *server defaults* in
                       ``<server home>/settings.env`` (``JACARIUM_SERVER_SETTINGS``)
                       that every account inherits. Nothing is mirrored
                       into ``os.environ``: ``setting(key)`` resolves
                       account file -> server defaults -> process
                       environment, per request.

``setting(key, default)`` is what the providers (AI chat, Jira, Calendar,
RAG, SSH AI) call instead of ``os.getenv``; outside accounts mode it is
``os.environ.get`` - unless the desktop app has switched this backend to
its account's settings (see "Settings scope" below).

Settings scope (the desktop app linked to a home server)
    A desktop profile runs either on its own file ("This device") or, as a
    whole, on its account's settings on the home server ("My account": the
    account file over the server defaults, secrets included, the way the
    server resolves them for the browser). For the latter the desktop's
    main process fetches ``GET /api/settings/effective?secrets=1`` from the
    home server - a device-token-only route (a browser session is refused),
    limited to the token's own account, audited and rate-limited - keeps
    the secrets in the OS keychain, and hands the resolved values to THIS
    (app-token) backend through ``POST /api/internal/settings`` on the
    loopback: an in-memory overlay that ``setting()`` consults instead of
    the process environment while it is active. Nothing is written to a
    file; deactivating it (the switch back, an unlink, a revoked token)
    returns the backend to the file at once.

Revisions
    Every write bumps a revision per key and one for the file, kept in
    ``<file>.meta.json``. A PUT may carry ``ifRevision: {KEY: rev}``; a key
    that changed since answers 409 with the current values, so two devices
    editing the same account never overwrite each other blindly.

Format
    ``KEY=VALUE`` lines, ``#`` comments, same as the Electron reader.
    Values are sanitized like electron/env-file.cjs: no control characters
    and no line breaks (a value with a newline would inject settings on
    read-back). Keys this dialog does not know are preserved.
"""
import json
import os
import re
import tempfile
import threading
import time
from collections import OrderedDict

from flask import Blueprint, g, has_request_context, jsonify, request

from user_context import accounts_mode, current_user, server_home, user_home

settings_api = Blueprint('settings_api', __name__)

ENV_FILE_ENV = 'JACARIUM_ENV_FILE'
SERVER_SETTINGS_ENV = 'JACARIUM_SERVER_SETTINGS'

# Keys whose values are credentials. Anything else matching the suffix
# pattern (``_KEY``, ``_SECRET``, ``_TOKEN``, ``_PASSWORD``, ``_PAT``) is a
# secret too, so a provider added later is covered without a code change.
SECRET_KEYS = frozenset({
    'JIRA_PAT',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'HF_TOKEN',
    'CUSTOM_API_KEY',
    'SSH_AI_PASSWORD',
})
_SECRET_SUFFIX = re.compile(r'(_KEY|_SECRET|_TOKEN|_PASSWORD|_PAT|_PASS)$')
_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')
_MAX_VALUE_LENGTH = 8192
_MAX_KEYS = 200

# Known keys in the order the file is written (readability only). The
# dialog's sections: Jira, OpenAI, Anthropic, Gemini, Google Calendar,
# Hugging Face, custom endpoint, SSH AI, defaults.
KNOWN_KEYS = (
    'JIRA_URL', 'JIRA_EMAIL', 'JIRA_PAT',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_USE_BEDROCK', 'AWS_REGION',
    'ANTHROPIC_USE_VERTEX', 'ANTHROPIC_GCP_PROJECT_ID', 'ANTHROPIC_GCP_LOCATION', 'ANTHROPIC_VERTEX_MODELS',
    'GEMINI_API_KEY', 'GEMINI_USE_VERTEX', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GEMINI_VERTEX_MODELS',
    'GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET',
    'HF_TOKEN', 'HF_EMBEDDING_MODEL',
    'CUSTOM_AI_ENDPOINT', 'CUSTOM_API_KEY',
    'SSH_AI_HOST', 'SSH_AI_USER', 'SSH_AI_PASSWORD', 'SSH_AI_DISPLAY_NAME',
    'SSH_AI_COMMAND_INITIAL', 'SSH_AI_COMMAND_FOLLOWUP',
    'DEFAULT_AI_PROVIDER', 'DEFAULT_AI_MODEL', 'DEFAULT_AI_TEMPERATURE', 'DEFAULT_AI_MAX_TOKENS',
)

# Names a Settings save may never set. The file is mirrored into os.environ
# (apply_to_environ) and inherited by the `task` and `ssh` subprocesses, so
# a key that steers the process or a child - where it loads libraries from,
# which proxy outbound requests use, which CA bundle TLS trusts, where
# Taskwarrior keeps its data, how the backend itself is configured - would
# turn a settings write into something else entirely. Keys the dialog knows
# (KNOWN_KEYS) are never affected; an operator-written line in the file
# stays as it is (only PUT is refused).
_RESERVED_KEYS = frozenset({
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
    'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'NODE_PATH',
    'SSHPASS', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
    'TASKRC', 'TASKDATA',
    'APP_AUTH_TOKEN', 'PORT', 'DEBUG_LOGGING',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
})
_RESERVED_PREFIXES = (
    'LD_', 'DYLD_', 'PYTHON', 'JACARIUM_', 'FLASK_', 'GUNICORN_',
    'HF_HUB_', 'TRANSFORMERS_', 'GIT_', 'NODE_', 'TLS_',
)


def is_reserved_key(key):
    """True for a name a Settings save must not set (see _RESERVED_KEYS)."""
    if key in KNOWN_KEYS:
        return False
    return key in _RESERVED_KEYS or key.startswith(_RESERVED_PREFIXES)


_write_lock = threading.Lock()


# ---------------------------------------------------------------------------
# where the files are
# ---------------------------------------------------------------------------
def env_file_path():
    """The settings file of this request's user (accounts) or the one file."""
    if accounts_mode():
        return os.path.join(user_home(), '.jacarium.env')
    explicit = os.environ.get(ENV_FILE_ENV)
    if explicit:
        return os.path.expanduser(explicit)
    return os.path.expanduser('~/.jacarium.env')


def server_defaults_path():
    """The admin-kept defaults every account inherits (accounts mode)."""
    explicit = os.environ.get(SERVER_SETTINGS_ENV)
    if explicit:
        return os.path.expanduser(explicit)
    return os.path.join(server_home(), 'settings.env')


def is_secret_key(key):
    return key in SECRET_KEYS or bool(_SECRET_SUFFIX.search(key))


def sanitize_value(value):
    """Same rule as electron/env-file.cjs: a string without control characters."""
    if value is None:
        return ''
    text = str(value)
    if len(text) > _MAX_VALUE_LENGTH:
        raise ValueError('value too long')
    return _CONTROL_CHARS.sub('', text).strip()


def read_env_file(path=None):
    """KEY=VALUE pairs of the file (empty when it does not exist)."""
    path = path or env_file_path()
    values = OrderedDict()
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                if _KEY_RE.match(key):
                    values[key] = value.strip()
    except FileNotFoundError:
        return values
    return values


def write_env_file(values, path=None):
    """Write the pairs atomically (temp file + rename), mode 0600."""
    path = path or env_file_path()
    lines = [
        '# Jacarium settings',
        '# This file is written by the Settings dialog (via the backend in a browser)',
        '# Configure the API keys and tokens for the services you want to use',
        '',
    ]
    written = set()
    for key in KNOWN_KEYS:
        if key in values and values[key] != '':
            lines.append(f'{key}={values[key]}')
            written.add(key)
    extra = [k for k in values if k not in written and values[k] != '']
    if extra:
        lines.append('')
        lines.append('# Other settings')
        for key in extra:
            lines.append(f'{key}={values[key]}')
    content = '\n'.join(lines) + '\n'
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.jacarium.env.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(content)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def apply_to_environ(values, previous=None):
    """Mirror the file into os.environ so the running backend uses the new values."""
    for key in (previous or {}):
        if key not in values and key in os.environ:
            del os.environ[key]
    for key, value in values.items():
        if value == '':
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


# ---------------------------------------------------------------------------
# the resolver: setting(key)
# ---------------------------------------------------------------------------
_defaults_cache = {'path': None, 'mtime': None, 'values': OrderedDict()}
_defaults_lock = threading.Lock()


def server_defaults():
    """The server-default values (cached by the file's mtime)."""
    path = server_defaults_path()
    try:
        mtime = os.stat(path).st_mtime_ns
    except FileNotFoundError:
        mtime = None
    with _defaults_lock:
        if _defaults_cache['path'] == path and _defaults_cache['mtime'] == mtime:
            return _defaults_cache['values']
        values = read_env_file(path) if mtime is not None else OrderedDict()
        _defaults_cache.update(path=path, mtime=mtime, values=values)
        return values


def request_user_settings():
    """This request's user file, read once per request (accounts mode)."""
    if has_request_context():
        cached = getattr(g, '_user_settings', None)
        if cached is not None:
            return cached
    try:
        values = read_env_file(env_file_path())
    except PermissionError:
        values = OrderedDict()
    if has_request_context():
        g._user_settings = values
    return values


def invalidate_request_settings():
    if has_request_context() and hasattr(g, '_user_settings'):
        del g._user_settings


# The desktop's "My account" overlay (see the module doc): the whole
# resolved map of the account, or None while the backend runs on its file.
_overlay = {'active': False, 'values': {}, 'since': None}
_overlay_lock = threading.Lock()


def overlay_active():
    return _overlay['active']


def set_overlay(values=None, active=True):
    """Install (active) or drop (not active) the account overlay."""
    with _overlay_lock:
        if active:
            _overlay['values'] = {str(k): str(v) for k, v in (values or {}).items() if v not in (None, '')}
            _overlay['active'] = True
            _overlay['since'] = time.time()
        else:
            _overlay['values'] = {}
            _overlay['active'] = False
            _overlay['since'] = None


def setting(key, default=None):
    """
    The effective value of a setting for this request:
    accounts mode   the user's file, else the server defaults, else the
                    process environment;
    other modes     the process environment (the env file is loaded into it),
                    or - while the desktop runs on its account - the overlay
                    alone (the file is not consulted: the scope is whole).
    An empty value counts as unset.
    """
    if accounts_mode():
        for source in (request_user_settings(), server_defaults()):
            value = source.get(key)
            if value:
                return value
    elif _overlay['active']:
        value = _overlay['values'].get(key)
        return value if value else default
    value = os.environ.get(key)
    return value if value else default


def setting_bool(key, default=False):
    value = setting(key)
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


# ---------------------------------------------------------------------------
# the HTTP contract
# ---------------------------------------------------------------------------
def public_view(values):
    """What the browser may see: plain values, secrets as set / not set."""
    plain = {}
    secrets = {}
    for key, value in values.items():
        if is_secret_key(key):
            secrets[key] = value != ''
        else:
            plain[key] = value
    return plain, secrets


def merge_update(current, plain_updates, secret_updates):
    """
    Apply a PUT: plain values replace (an empty string removes the key);
    secrets change only when a new non-empty value arrives, clear on None,
    and are otherwise kept. Returns the new mapping.
    """
    new = OrderedDict(current)
    for key, value in plain_updates.items():
        if not _KEY_RE.match(key):
            raise ValueError(f'invalid key: {key}')
        if is_reserved_key(key):
            raise ValueError(f'{key} cannot be set from Settings')
        if is_secret_key(key):
            raise ValueError(f'{key} is a secret: send it under "secrets"')
        clean = sanitize_value(value)
        if clean == '':
            new.pop(key, None)
        else:
            new[key] = clean
    for key, value in secret_updates.items():
        if not _KEY_RE.match(key):
            raise ValueError(f'invalid key: {key}')
        if is_reserved_key(key):
            raise ValueError(f'{key} cannot be set from Settings')
        if value is None:
            new.pop(key, None)
            continue
        clean = sanitize_value(value)
        if clean == '':
            continue  # "" means "no change", like an untouched password field
        new[key] = clean
    if len(new) > _MAX_KEYS:
        raise ValueError('too many settings')
    return new


# ---------------------------------------------------------------------------
# revisions: <file>.meta.json = {"revision": n, "keys": {KEY: n}}
# ---------------------------------------------------------------------------
def meta_path(path):
    return path + '.meta.json'


def read_meta(path):
    try:
        with open(meta_path(path), 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            keys = data.get('keys') if isinstance(data.get('keys'), dict) else {}
            return {'revision': int(data.get('revision') or 0), 'keys': {str(k): int(v) for k, v in keys.items()}}
    except (OSError, ValueError, TypeError):
        pass
    return {'revision': 0, 'keys': {}}


def write_meta(path, meta):
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.jacarium.env.meta.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(meta, handle)
        os.chmod(tmp, 0o600)
        os.replace(tmp, meta_path(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def settings_revision(path=None):
    """The file's revision (0 for a file never written through here)."""
    return read_meta(path or env_file_path())['revision']


def _request_limiter_key():
    user = current_user()
    return 'user:%s' % user['id'] if user else 'anon'


def _is_device_token_request():
    header = request.headers.get('Authorization', '') if has_request_context() else ''
    return header.lower().startswith('bearer ')


def _audit(action, **fields):
    """An audit line in accounts mode (never a value, only key names)."""
    if not accounts_mode():
        return
    try:
        import accounts
        user = current_user() or {}
        accounts.audit(action, user=user.get('username', '?'), by='device-token' if _is_device_token_request() else 'session', **fields)
    except Exception:  # pragma: no cover - the audit log must never break a save
        pass


def get_settings_for(path, *, with_inherited=False):
    values = read_env_file(path)
    plain, secrets = public_view(values)
    meta = read_meta(path)
    answer = {'values': plain, 'secrets': secrets, 'secretKeys': sorted(SECRET_KEYS), 'revision': meta['revision'], 'revisions': meta['keys']}
    if with_inherited:
        # Keys an account gets from the server defaults while its own file
        # does not set them: the dialog shows them as inherited.
        inherited = {}
        for key, value in server_defaults().items():
            if value != '' and key not in values:
                inherited[key] = True if is_secret_key(key) else value
        answer['inherited'] = inherited
    return jsonify(answer)


def put_settings_for(path, *, apply_environ, audit_scope='own'):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'JSON object expected'}), 400
    plain_updates = body.get('values', {})
    secret_updates = body.get('secrets', {})
    if_revision = body.get('ifRevision', None)
    if not isinstance(plain_updates, dict) or not isinstance(secret_updates, dict):
        return jsonify({'error': '"values" and "secrets" must be objects'}), 400
    if if_revision is not None and not isinstance(if_revision, dict):
        return jsonify({'error': '"ifRevision" must be an object'}), 400
    if accounts_mode():
        allowed, retry_after = put_limiter.hit(_request_limiter_key())
        if not allowed:
            response = jsonify({'error': 'Too many settings saves. Try again later.', 'retryAfter': retry_after})
            response.status_code = 429
            response.headers['Retry-After'] = str(retry_after)
            return response
    with _write_lock:
        current = read_env_file(path)
        meta = read_meta(path)
        if if_revision:
            # a key another device changed since this dialog loaded: refuse,
            # hand back what the file holds now (secrets as set / not set)
            conflicts = []
            for key, seen in if_revision.items():
                try:
                    seen = int(seen)
                except (TypeError, ValueError):
                    seen = -1
                now_rev = meta['keys'].get(str(key), 0)
                if now_rev != seen:
                    value = current.get(str(key), '')
                    conflicts.append({'key': str(key), 'revision': now_rev,
                                      'current': (value != '') if is_secret_key(str(key)) else value})
            if conflicts:
                return jsonify({'error': 'Changed on another device - reload the settings', 'conflicts': conflicts, 'revision': meta['revision']}), 409
        try:
            new_values = merge_update(current, plain_updates, secret_updates)
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        changed = [k for k in set(current) | set(new_values) if current.get(k, '') != new_values.get(k, '')]
        if changed:
            meta['revision'] += 1
            for key in changed:
                meta['keys'][key] = meta['revision']
        write_env_file(new_values, path)
        if changed:
            write_meta(path, meta)
        if apply_environ:
            apply_to_environ(new_values, previous=current)
    invalidate_request_settings()
    if changed:
        _audit('settings-saved', scope=audit_scope, keys=','.join(sorted(changed)))
    plain, secrets = public_view(new_values)
    return jsonify({'ok': True, 'values': plain, 'secrets': secrets, 'revision': meta['revision'], 'revisions': meta['keys']})


def effective_settings(*, with_secrets):
    """
    The account's resolved settings (its file over the server defaults),
    with the source of each key and, on request, the secret VALUES - for
    the desktop app running on its account (device token only, see the
    route). Keys the process environment supplies are not included: they
    are the server's own.
    """
    own = read_env_file(env_file_path())
    defaults = server_defaults()
    resolved = OrderedDict()
    sources = {}
    for key, value in defaults.items():
        if value != '':
            resolved[key] = value
            sources[key] = 'everyone'
    for key, value in own.items():
        if value != '':
            resolved[key] = value
            sources[key] = 'account'
    plain = {}
    secrets = {}
    secret_values = {}
    for key, value in resolved.items():
        if is_secret_key(key):
            secrets[key] = True
            if with_secrets:
                secret_values[key] = value
        else:
            plain[key] = value
    meta = read_meta(env_file_path())
    answer = {'values': plain, 'secrets': secrets, 'sources': sources, 'revision': meta['revision'], 'revisions': meta['keys'],
              'serverRevision': read_meta(server_defaults_path())['revision']}
    if with_secrets:
        answer['secretValues'] = secret_values
    return answer


# a save a second is plenty for a dialog; the secret download is rarer still
put_limiter = None
effective_limiter = None


def _limiters():
    global put_limiter, effective_limiter
    if put_limiter is None:
        from accounts import RateLimiter
        put_limiter = RateLimiter(60, 60)
        effective_limiter = RateLimiter(20, 60)
    return put_limiter, effective_limiter


@settings_api.route('/api/settings', methods=['GET'])
def get_settings():
    return get_settings_for(env_file_path(), with_inherited=accounts_mode())


@settings_api.route('/api/settings', methods=['PUT'])
def put_settings():
    # Outside accounts mode the one file is mirrored into os.environ (the
    # providers read it from there); with accounts, setting() resolves per
    # request and nothing of a user's file reaches the process environment.
    _limiters()
    return put_settings_for(env_file_path(), apply_environ=not accounts_mode())


@settings_api.route('/api/settings/effective', methods=['GET'])
def get_effective_settings():
    """
    The account's resolved settings for the desktop app that runs on them
    (see the module doc). Device tokens only: a browser session is refused
    even for the same account - the secret values leave the server for a
    linked device's keychain, never for a page. ``?secrets=1`` adds the
    secret values; every call is audited with the key names, never a value.
    """
    if not accounts_mode() or not current_user():
        return jsonify({'error': 'Only with sign-in'}), 404
    if not _is_device_token_request():
        return jsonify({'error': 'Only a linked device may read the resolved settings'}), 403
    _limiters()
    allowed, retry_after = effective_limiter.hit(_request_limiter_key())
    if not allowed:
        response = jsonify({'error': 'Too many requests. Try again later.', 'retryAfter': retry_after})
        response.status_code = 429
        response.headers['Retry-After'] = str(retry_after)
        return response
    with_secrets = str(request.args.get('secrets', '')).lower() in ('1', 'true', 'yes')
    answer = effective_settings(with_secrets=with_secrets)
    if with_secrets:
        _audit('settings-fetched-with-secrets', keys=','.join(sorted(answer.get('secretValues', {}).keys())) or '-')
    return jsonify(answer)


@settings_api.route('/api/internal/settings', methods=['POST', 'GET'])
def internal_settings_overlay():
    """
    The desktop's main process installs ({active: true, values: {...}}) or
    drops ({active: false}) the account overlay on THIS backend. Loopback
    only, app-token mode only (the before_request app-token check already
    guards it); on a server with accounts it does not exist.
    """
    if accounts_mode():
        return jsonify({'error': 'Not available with sign-in'}), 404
    if request.remote_addr not in ('127.0.0.1', '::1'):
        return jsonify({'error': 'Loopback only'}), 403
    if request.method == 'GET':
        return jsonify({'active': _overlay['active'], 'keys': sorted(_overlay['values'].keys()), 'since': _overlay['since']})
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'JSON object expected'}), 400
    if body.get('active'):
        values = body.get('values', {})
        if not isinstance(values, dict) or len(values) > _MAX_KEYS:
            return jsonify({'error': '"values" must be an object'}), 400
        clean = {}
        for key, value in values.items():
            if not _KEY_RE.match(str(key)) or is_reserved_key(str(key)):
                return jsonify({'error': f'invalid key: {key}'}), 400
            try:
                clean[str(key)] = sanitize_value(value)
            except ValueError as exc:
                return jsonify({'error': f'{key}: {exc}'}), 400
        set_overlay(clean, active=True)
    else:
        set_overlay(active=False)
    return jsonify({'ok': True, 'active': _overlay['active'], 'keys': sorted(_overlay['values'].keys())})
