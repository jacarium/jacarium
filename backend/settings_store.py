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
``os.environ.get``.

Format
    ``KEY=VALUE`` lines, ``#`` comments, same as the Electron reader.
    Values are sanitized like electron/env-file.cjs: no control characters
    and no line breaks (a value with a newline would inject settings on
    read-back). Keys this dialog does not know are preserved.
"""
import os
import re
import tempfile
import threading
from collections import OrderedDict

from flask import Blueprint, g, has_request_context, jsonify, request

from user_context import accounts_mode, server_home, user_home

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


def setting(key, default=None):
    """
    The effective value of a setting for this request:
    accounts mode   the user's file, else the server defaults, else the
                    process environment;
    other modes     the process environment (the env file is loaded into it).
    An empty value counts as unset.
    """
    if accounts_mode():
        for source in (request_user_settings(), server_defaults()):
            value = source.get(key)
            if value:
                return value
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


def get_settings_for(path, *, with_inherited=False):
    values = read_env_file(path)
    plain, secrets = public_view(values)
    answer = {'values': plain, 'secrets': secrets, 'secretKeys': sorted(SECRET_KEYS)}
    if with_inherited:
        # Keys an account gets from the server defaults while its own file
        # does not set them: the dialog shows them as inherited.
        inherited = {}
        for key, value in server_defaults().items():
            if value != '' and key not in values:
                inherited[key] = True if is_secret_key(key) else value
        answer['inherited'] = inherited
    return jsonify(answer)


def put_settings_for(path, *, apply_environ):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'JSON object expected'}), 400
    plain_updates = body.get('values', {})
    secret_updates = body.get('secrets', {})
    if not isinstance(plain_updates, dict) or not isinstance(secret_updates, dict):
        return jsonify({'error': '"values" and "secrets" must be objects'}), 400
    with _write_lock:
        current = read_env_file(path)
        try:
            new_values = merge_update(current, plain_updates, secret_updates)
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        write_env_file(new_values, path)
        if apply_environ:
            apply_to_environ(new_values, previous=current)
    invalidate_request_settings()
    plain, secrets = public_view(new_values)
    return jsonify({'ok': True, 'values': plain, 'secrets': secrets})


@settings_api.route('/api/settings', methods=['GET'])
def get_settings():
    return get_settings_for(env_file_path(), with_inherited=accounts_mode())


@settings_api.route('/api/settings', methods=['PUT'])
def put_settings():
    # Outside accounts mode the one file is mirrored into os.environ (the
    # providers read it from there); with accounts, setting() resolves per
    # request and nothing of a user's file reaches the process environment.
    return put_settings_for(env_file_path(), apply_environ=not accounts_mode())
