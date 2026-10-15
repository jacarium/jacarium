"""
Where the Taskwarrior routes may read and write.

Every ``/api/taskwarrior`` route takes the instance's ``rcPath`` and
``dataPath`` from the request (the UI keeps them per instance in its
database) and hands them to the ``task`` CLI as ``rc:<path>`` and
``rc.data.location=<path>``; ``/instances/init`` also writes a taskrc file
at ``rcPath``.

Desktop (``JACARIUM_AUTH_MODE=app-token``): unrestricted, as before -
the user points instances wherever they like on their own machine, and
every request carries the per-launch app token.

Browser deployment (any other auth mode): the backend serves anyone who can
reach the proxy, so a client-chosen path is an arbitrary file write (the
taskrc) and an arbitrary data directory (``pending.data`` and friends land
wherever ``rc.data.location`` points). Both are therefore confined, with the
same realpath-containment rule as ``reports_root.py``:

  - ``dataPath`` must be the Taskwarrior root or inside it
    (``JACARIUM_TASK_ROOT``, default ``~/.task`` - ``/data/.task`` in
    the container, where entrypoint.sh points the default instance);
  - ``rcPath`` must be inside the root too, or exactly the default
    ``~/.taskrc`` the entrypoint writes - that is what the UI's default
    instance uses.

A relative path resolves under the root; ``~`` is expanded; symlinks are
resolved before the check so a link inside the root cannot point outside.

The taskrc ``config`` lines ``/instances/init`` writes are validated here
too, in every mode: allow-listed key syntax, and no key that would make
``task`` read or write somewhere else or run something (``data.location``,
``include``, ``hooks``, ``editor``, ``alias.*``, ``taskd.*``, ...).
"""
import os
import re

from user_context import accounts_mode, auth_mode, expand_user_path

ROOT_ENV = 'JACARIUM_TASK_ROOT'


class TaskPathError(ValueError):
    pass


def _confined():
    """True when paths are confined (every mode except the desktop's)."""
    return auth_mode() != 'app-token'


def task_root():
    """
    The confining Taskwarrior root as a real path, or None when unrestricted.
    With sign-in every account has its own root (``~/.task`` under the
    account's home - user_context.py); JACARIUM_TASK_ROOT only
    applies without accounts.
    """
    if accounts_mode():
        return os.path.realpath(expand_user_path('~/.task'))
    raw = os.environ.get(ROOT_ENV)
    if raw:
        return os.path.realpath(os.path.expanduser(raw))
    if _confined():
        return os.path.realpath(os.path.expanduser('~/.task'))
    return None


def default_rc_path():
    """The taskrc ``task`` reads when no ``rc:`` override is given."""
    return os.path.realpath(expand_user_path('~/.taskrc'))


def account_defaults(rc_path, data_path):
    """
    With sign-in a request that names no instance paths must still act on
    the account's own Taskwarrior - never on the server's HOME (where
    ``task`` would otherwise look): fill in ``~/.taskrc`` / ``~/.task`` of
    the account, and write a minimal taskrc the first time (the same lines
    the container's entrypoint writes for the server).
    """
    if not accounts_mode():
        return rc_path, data_path
    root = task_root()
    rc_path = rc_path or default_rc_path()
    data_path = data_path or root
    if rc_path == default_rc_path() and not os.path.exists(rc_path):
        os.makedirs(root, exist_ok=True)
        with open(rc_path, 'w', encoding='utf-8') as fh:
            fh.write(f'# Jacarium - Taskwarrior configuration (this account)\ndata.location={root}\nconfirmation=off\n')
    return rc_path, data_path


def _resolve_under_root(text, root):
    expanded = expand_user_path(text)
    if not os.path.isabs(expanded):
        expanded = os.path.join(root, expanded)
    return os.path.realpath(expanded)


def _inside(real, root):
    return real == root or real.startswith(root + os.sep)


def resolve_data_path(candidate):
    """
    The path to pass as ``rc.data.location``. ``None`` / blank stays
    ``None`` (``task`` uses the taskrc's data.location). With a root
    configured the result must be the root or inside it, else
    TaskPathError. Unrestricted: ``~`` expanded, exactly as before.
    """
    if candidate is None:
        return None
    if not isinstance(candidate, str):
        raise TaskPathError('dataPath must be a string')
    text = candidate.strip()
    if not text:
        return None
    root = task_root()
    if root is None:
        return expand_user_path(text)
    real = _resolve_under_root(text, root)
    if not _inside(real, root):
        raise TaskPathError(
            f'The Taskwarrior data directory must be inside {root} on this server')
    return real


def resolve_rc_path(candidate):
    """
    The path to pass as ``rc:``. ``None`` / blank stays ``None``. With a
    root configured the file must be inside the root or be the default
    ``~/.taskrc``, else TaskPathError.
    """
    if candidate is None:
        return None
    if not isinstance(candidate, str):
        raise TaskPathError('rcPath must be a string')
    text = candidate.strip()
    if not text:
        return None
    root = task_root()
    if root is None:
        return expand_user_path(text)
    real = _resolve_under_root(text, root)
    if real == default_rc_path() or _inside(real, root):
        return real
    raise TaskPathError(
        f'The taskrc file must be inside {root} (or be ~/.taskrc) on this server')


# ---------------------------------------------------------------------------
# taskrc content written by /instances/init
# ---------------------------------------------------------------------------
# A key is dotted lower-case words (report.next.columns, uda.estimate.type,
# color.due.today, urgency.user.tag.next.coefficient ...). Keys that change
# WHERE task reads/writes or WHAT it runs are refused outright, as is
# anything that could rename a command (alias) or weaken the parser's
# command matching (abbreviation.minimum).
_CONFIG_KEY_RE = re.compile(r'^[a-z][a-z0-9_]*(\.[A-Za-z0-9_-]+){0,8}$')
_DENIED_CONFIG_PREFIXES = (
    'data.',          # data.location
    'include',        # include <file>
    'hooks',          # hooks=on + hook scripts under data.location
    'editor',         # program run by `task edit`
    'alias.',         # alias.foo=<any command>
    'taskd.',         # sync server credentials / certificates
    'rc.',
    'default.command',
    'abbreviation.',
    'locking',
    'journal.',
    'gc',
    'sync.',
)
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')
_MAX_CONFIG_KEYS = 200
_MAX_CONFIG_VALUE = 1024


def validate_taskrc_config(config):
    """
    Return an ordered list of (key, value) pairs safe to write as taskrc
    lines, or raise TaskPathError. ``config`` must be a dict (None / {}
    gives []).
    """
    if config is None:
        return []
    if not isinstance(config, dict):
        raise TaskPathError('config must be an object of key/value pairs')
    if len(config) > _MAX_CONFIG_KEYS:
        raise TaskPathError('too many taskrc settings')
    pairs = []
    for key, value in config.items():
        if not isinstance(key, str) or not _CONFIG_KEY_RE.match(key):
            raise TaskPathError(f'invalid taskrc setting name: {key!r}')
        lowered = key.lower()
        if any(lowered == p.rstrip('.') or lowered.startswith(p) for p in _DENIED_CONFIG_PREFIXES):
            raise TaskPathError(f'taskrc setting {key!r} cannot be set from the app')
        if value is None:
            value = ''
        if isinstance(value, bool):
            value = 'on' if value else 'off'
        if not isinstance(value, (str, int, float)):
            raise TaskPathError(f'taskrc setting {key!r} must be a string or number')
        text = str(value)
        if len(text) > _MAX_CONFIG_VALUE:
            raise TaskPathError(f'taskrc setting {key!r} is too long')
        if _CONTROL_CHARS.search(text):
            raise TaskPathError(f'taskrc setting {key!r} contains a line break or control character')
        pairs.append((key, text.strip()))
    return pairs
