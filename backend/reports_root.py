"""
Where the Diagnostics page may browse for sosreports / must-gathers.

Desktop: anywhere the user points it (a directory the app reads from the
local disk, ``Downloads`` by default).

Container without sign-in: ``JACARIUM_REPORTS_ROOT`` (``/data/reports``)
is the only browsable tree. The user copies reports into the mounted
volume; every directory the log viewer routes receive is resolved (``~``
expansion, realpath - so symlinks cannot point outside) and must lie under
that root, otherwise the request is refused. ``list_reports``'s bare names
(``Downloads``) resolve relative to the root instead of the home directory.

Container with sign-in (accounts): two trees - the account's own
``~/reports`` (its default, where ``~`` is the account's home) and the
shared ``JACARIUM_REPORTS_ROOT``, which an administrator fills on
the server (read-only through the app: there is no upload). A path must
lie under one of them.
"""
import os

from user_context import accounts_mode, expand_user_path

ROOT_ENV = 'JACARIUM_REPORTS_ROOT'


class ReportsRootError(ValueError):
    pass


def shared_reports_root():
    """The operator-configured tree as a real path, or None when unset."""
    raw = os.environ.get(ROOT_ENV)
    if not raw:
        return None
    return os.path.realpath(os.path.expanduser(raw))


def reports_root():
    """
    The restricting root as a real path, or None when unrestricted. With
    accounts: the account's own reports directory (created on first use).
    """
    if accounts_mode():
        own = os.path.realpath(expand_user_path('~/reports'))
        os.makedirs(own, exist_ok=True)
        return own
    return shared_reports_root()


def allowed_roots():
    """Every tree a client may browse (empty when unrestricted)."""
    roots = []
    own = reports_root()
    if own:
        roots.append(own)
    if accounts_mode():
        shared = shared_reports_root()
        if shared and shared not in roots:
            roots.append(shared)
    return roots


def default_directory():
    """What the page should browse when the user has not chosen a location."""
    return reports_root() or 'Downloads'


def _inside(real, root):
    return real == root or real.startswith(root + os.sep)


def resolve_directory(candidate, *, relative_base=None):
    """
    The real path for a directory the client sent. With a root configured
    the result must be a root or inside one (symlinks resolved first), or
    ReportsRootError is raised; a relative name resolves under the own
    root. Without a root: ``~`` expansion, relative names under
    ``relative_base`` (the home directory by default) - the desktop
    behaviour.
    """
    text = (candidate or '').strip()
    roots = allowed_roots()
    if roots:
        root = roots[0]
        if not text or text in ('Downloads', '~', '.'):
            return root
        expanded = expand_user_path(text)
        if not os.path.isabs(expanded):
            expanded = os.path.join(root, expanded)
        real = os.path.realpath(expanded)
        if not any(_inside(real, r) for r in roots):
            raise ReportsRootError('That location is outside the reports directory')
        return real
    # Unrestricted (desktop): the caller's own string, ~ expanded, exactly as
    # before - the parsers' path-based log-type detection and the page's
    # cache keys see the path the user chose, not its realpath.
    expanded = os.path.expanduser(text or 'Downloads')
    if not os.path.isabs(expanded):
        base = relative_base or os.path.expanduser('~')
        expanded = os.path.join(base, expanded)
    return expanded
