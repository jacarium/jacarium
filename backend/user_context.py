"""
Who is making this request, and where their files live.

Three auth modes (``JACARIUM_AUTH_MODE``, see extensions.py):

    app-token  the desktop app: one implicit user, the OS account the
               app runs as; files live under the real home directory.
    none       the browser deployment without sign-in: one anonymous
               user, files under the container's HOME (/data).
    accounts   the browser deployment with sign-in: the user comes from
               the session cookie (``g.user``), and everything personal
               lives under ``<HOME>/users/<user id>/`` - the same layout a
               home directory has (``.jacarium.env``, ``.taskrc``,
               ``.task/``, ``.ssh/known_hosts``, ``.jacarium/
               vector_db``, ``reports/``, ...), so every module keeps its
               ``~/...`` paths and only the meaning of ``~`` changes.

``expand_user_path('~/x')`` is the one function the modules use instead of
``os.path.expanduser``; outside accounts mode it is exactly that.

Socket.IO handlers run outside the HTTP request that authenticated the
socket: ``bind_socket_user`` / ``socket_user`` keep the user per sid so an
event handler can act as that user (``as_user`` sets ``g.user`` for it).
"""
import os
import threading

from flask import g, has_app_context, has_request_context

_AUTH_MODE_ENV = 'JACARIUM_AUTH_MODE'


def auth_mode():
    return (os.environ.get(_AUTH_MODE_ENV) or 'app-token').strip().lower() or 'app-token'


def accounts_mode():
    return auth_mode() == 'accounts'


def current_user():
    """The authenticated user dict (accounts mode) or None."""
    if not has_app_context():
        return None
    return getattr(g, 'user', None)


def set_current_user(user):
    g.user = user


def is_admin():
    user = current_user()
    return bool(user and user.get('role') == 'admin')


def server_home():
    """The server's own home (HOME: /data in the container)."""
    return os.path.expanduser('~')


def profile_home():
    """
    The desktop's per-profile home (app-token mode): a named profile of the
    Electron app passes JACARIUM_PROFILE_HOME (electron/profiles.cjs)
    so that ``~/.task``, ``~/.taskrc``, the RAG index, the calendar token
    and the settings file of that profile live under it. None for the
    default profile (the real home).
    """
    raw = os.environ.get('JACARIUM_PROFILE_HOME')
    return os.path.expanduser(raw) if raw else None


def users_root():
    return os.path.join(server_home(), 'users')


def user_home_for(user_id):
    """The home directory of one account (created on first use, 0700)."""
    if not user_id or '/' in str(user_id) or str(user_id).startswith('.'):
        raise ValueError('invalid user id')
    home = os.path.join(users_root(), str(user_id))
    if not os.path.isdir(home):
        os.makedirs(home, mode=0o700, exist_ok=True)
    return home


def user_home():
    """Where ``~`` points for this request."""
    if not accounts_mode():
        if auth_mode() == 'app-token':
            profile = profile_home()
            if profile:
                return profile
        return server_home()
    user = current_user()
    if not user:
        raise PermissionError('no authenticated user')
    return user_home_for(user['id'])


def expand_user_path(path):
    """``~`` and ``~/...`` resolved against the request's home; else unchanged."""
    if path is None:
        return None
    text = str(path)
    if text == '~':
        return user_home()
    if text.startswith('~/'):
        return os.path.join(user_home(), text[2:])
    return os.path.expanduser(text)


def ssh_identity_files():
    """
    The account's own SSH private keys (``~/.ssh/id_*``, not ``.pub``),
    accounts mode only: with sign-in a connection must never use keys that
    belong to the server or to another account. [] outside accounts mode
    (ssh then uses the agent / the default identities as before).
    """
    if not accounts_mode():
        return []
    import glob
    ssh_dir = os.path.join(user_home(), '.ssh')
    return sorted(p for p in glob.glob(os.path.join(ssh_dir, 'id_*'))
                  if os.path.isfile(p) and not p.endswith('.pub'))


# ---------------------------------------------------------------------------
# Socket.IO: user per socket id
# ---------------------------------------------------------------------------
_socket_users = {}
_socket_lock = threading.Lock()


def bind_socket_user(sid, user):
    with _socket_lock:
        if user is None:
            _socket_users.pop(sid, None)
        else:
            _socket_users[sid] = user


def socket_user(sid):
    with _socket_lock:
        return _socket_users.get(sid)


def as_socket_user(sid):
    """Make the socket's user the request's user (event handlers)."""
    user = socket_user(sid)
    if has_request_context() or has_app_context():
        g.user = user
    return user
