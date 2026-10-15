"""
Accounts for the browser deployment (``JACARIUM_AUTH_MODE=accounts``).

One SQLite file, ``accounts.sqlite`` next to the rest of the server state
(``JACARIUM_ACCOUNTS_DB``, default ``<HOME>/accounts.sqlite`` -
``/data/accounts.sqlite`` in the container):

    users          id, username (unique, case-insensitive), display_name,
                   password_hash (scrypt), role admin|user, disabled,
                   oidc_subject (unused yet - for a later sign-in provider),
                   created_at, password_changed_at
    sessions       id (sha256 of the cookie value - the raw id is never
                   stored), user_id, created_at, last_seen, user_agent
    device_tokens  for later phases (the desktop app linking to this server):
                   id, user_id, name, token_hash, created_at, last_seen, revoked

Passwords: ``hashlib.scrypt`` (stdlib, no extra wheel for the desktop
builds), n=2^15 r=8 p=1, a 32-byte salt, constant-time comparison.

Sessions: a 256-bit random id goes into the cookie; the table holds its
hash. A session is valid while it was used within SESSION_IDLE_SECONDS
(30 days, sliding) and is younger than SESSION_MAX_AGE_SECONDS (90 days).

First run: while the table is empty a one-time *setup code* is written to
``<HOME>/setup-code`` (0600) and printed to the log; POST /api/auth/setup
needs it and only works while no user exists, so whoever reaches a fresh
server first cannot simply become its admin.

Rate limiting: a per-key sliding window (ip, and username for logins) so
guessing turns into 429s. In-process state: the container runs one
gunicorn worker.

The desktop (app-token mode) and ``none`` mode never touch this module.
"""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import sys
import time
import uuid

DB_ENV = 'JACARIUM_ACCOUNTS_DB'

SESSION_IDLE_SECONDS = 30 * 24 * 3600
SESSION_MAX_AGE_SECONDS = 90 * 24 * 3600
SESSION_TOUCH_SECONDS = 300          # last_seen is written at most this often

USERNAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,31}$')
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 1024
DISPLAY_NAME_MAX_LENGTH = 64

_SCRYPT_N = 2 ** 15
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
# scrypt needs 128*n*r bytes (32 MiB here); OpenSSL's default cap is exactly that, so raise it
_SCRYPT_MAXMEM = 128 * _SCRYPT_N * _SCRYPT_R * 2

_lock = threading.RLock()
_conn = None
_conn_path = None


class AccountsError(ValueError):
    pass


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------
def db_path():
    explicit = os.environ.get(DB_ENV)
    if explicit:
        return os.path.expanduser(explicit)
    return os.path.join(os.path.expanduser('~'), 'accounts.sqlite')


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    disabled INTEGER NOT NULL DEFAULT 0,
    oidc_subject TEXT,
    created_at REAL NOT NULL,
    password_changed_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    last_seen REAL NOT NULL,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL,
    last_seen REAL,
    revoked INTEGER NOT NULL DEFAULT 0
);
"""


def connection():
    """The process-wide connection (one worker; serialized by _lock)."""
    global _conn, _conn_path
    path = db_path()
    with _lock:
        if _conn is not None and _conn_path == path:
            return _conn
        if _conn is not None:
            _conn.close()
        directory = os.path.dirname(path) or '.'
        os.makedirs(directory, exist_ok=True)
        existed = os.path.exists(path)
        conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA foreign_keys=ON')
        conn.executescript(_SCHEMA)
        _migrate(conn)
        if not existed:
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        _conn, _conn_path = conn, path
        return conn


def _migrate(conn):
    """Columns added after the first release (CREATE IF NOT EXISTS leaves an old table alone)."""
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(users)').fetchall()}
    if 'must_change_password' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')


def reset_for_tests():
    """Forget the open connection (tests that switch the DB path)."""
    global _conn, _conn_path
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn, _conn_path = None, None


# ---------------------------------------------------------------------------
# passwords
# ---------------------------------------------------------------------------
def hash_password(password):
    if not isinstance(password, str):
        raise AccountsError('password must be a string')
    if len(password) < PASSWORD_MIN_LENGTH:
        raise AccountsError(f'password must be at least {PASSWORD_MIN_LENGTH} characters')
    if len(password) > PASSWORD_MAX_LENGTH:
        raise AccountsError('password is too long')
    salt = secrets.token_bytes(32)
    digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN, maxmem=_SCRYPT_MAXMEM)
    return f'scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}'


def verify_password(password, stored):
    try:
        scheme, n, r, p, salt_hex, digest_hex = str(stored).split('$')
        if scheme != 'scrypt':
            return False
        if not isinstance(password, str) or len(password) > PASSWORD_MAX_LENGTH:
            return False
        digest = hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt_hex),
                                n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(digest_hex)),
                                maxmem=128 * int(n) * int(r) * 2)
        return hmac.compare_digest(digest, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


# A hash to verify against when the username does not exist, so a login
# attempt costs the same either way (no username probing by timing).
_DUMMY_HASH = None


def _dummy_hash():
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_hex(16))
    return _DUMMY_HASH


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------
def normalize_username(username):
    if not isinstance(username, str):
        raise AccountsError('username must be a string')
    name = username.strip().lower()
    if not USERNAME_RE.match(name):
        raise AccountsError('username: 1-32 characters, letters, digits, ".", "_" and "-", starting with a letter or digit')
    return name


def clean_display_name(display_name, fallback):
    text = (display_name if isinstance(display_name, str) else '').strip()
    text = re.sub(r'[\x00-\x1f\x7f]', '', text)
    if not text:
        return fallback
    if len(text) > DISPLAY_NAME_MAX_LENGTH:
        raise AccountsError(f'display name: at most {DISPLAY_NAME_MAX_LENGTH} characters')
    return text


def _row_to_user(row):
    if row is None:
        return None
    return {
        'id': row['id'],
        'username': row['username'],
        'displayName': row['display_name'],
        'role': row['role'],
        'disabled': bool(row['disabled']),
        'createdAt': row['created_at'],
        # set by a host-side password recovery: only /api/auth/password is
        # allowed until the user chose a password of their own
        'mustChangePassword': bool(row['must_change_password']) if 'must_change_password' in row.keys() else False,
    }


def user_count():
    return connection().execute('SELECT COUNT(*) FROM users').fetchone()[0]


def get_user(user_id):
    row = connection().execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    return _row_to_user(row)


def get_user_by_username(username):
    try:
        name = normalize_username(username)
    except AccountsError:
        return None
    row = connection().execute('SELECT * FROM users WHERE username = ?', (name,)).fetchone()
    return _row_to_user(row)


def list_users():
    rows = connection().execute('SELECT * FROM users ORDER BY created_at').fetchall()
    return [_row_to_user(r) for r in rows]


def create_user(username, password, display_name=None, role='user', *, require_empty=False):
    """
    Insert a user. With require_empty the insert only succeeds while the
    table is empty (the first-run admin), atomically - two concurrent setup
    requests cannot both become admin.
    """
    name = normalize_username(username)
    if role not in ('admin', 'user'):
        raise AccountsError('role must be admin or user')
    display = clean_display_name(display_name, name)
    pw_hash = hash_password(password)
    now = time.time()
    user_id = str(uuid.uuid4())
    conn = connection()
    with _lock:
        try:
            conn.execute('BEGIN IMMEDIATE')
            if require_empty and conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] != 0:
                conn.execute('ROLLBACK')
                raise AccountsError('setup is already done: an account exists')
            try:
                conn.execute(
                    'INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, password_changed_at) '
                    'VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
                    (user_id, name, display, pw_hash, role, now, now))
            except sqlite3.IntegrityError:
                conn.execute('ROLLBACK')
                raise AccountsError('that username is already taken')
            conn.execute('COMMIT')
        except AccountsError:
            raise
        except Exception:
            try:
                conn.execute('ROLLBACK')
            except sqlite3.OperationalError:
                pass
            raise
    return get_user(user_id)


def set_user_disabled(user_id, disabled):
    conn = connection()
    with _lock:
        cur = conn.execute('UPDATE users SET disabled = ? WHERE id = ?', (1 if disabled else 0, user_id))
        if cur.rowcount == 0:
            raise AccountsError('no such user')
        if disabled:
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    return get_user(user_id)


def set_user_password(user_id, password, *, keep_sessions=None):
    """Change a password; every other session of the user is ended."""
    pw_hash = hash_password(password)
    conn = connection()
    with _lock:
        cur = conn.execute('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0 WHERE id = ?', (pw_hash, time.time(), user_id))
        if cur.rowcount == 0:
            raise AccountsError('no such user')
        if keep_sessions:
            conn.execute('DELETE FROM sessions WHERE user_id = ? AND id != ?', (user_id, _session_hash(keep_sessions)))
        else:
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))


def set_user_role(user_id, role):
    """'admin' or 'user'. The caller guards the last administrator."""
    if role not in ('admin', 'user'):
        raise AccountsError('role must be admin or user')
    with _lock:
        cur = connection().execute('UPDATE users SET role = ? WHERE id = ?', (role, user_id))
        if cur.rowcount == 0:
            raise AccountsError('no such user')
    return get_user(user_id)


def delete_user(user_id):
    """Remove the account row (its sessions and device tokens go with it); the home directory stays."""
    with _lock:
        cur = connection().execute('DELETE FROM users WHERE id = ?', (user_id,))
        if cur.rowcount == 0:
            raise AccountsError('no such user')


def list_sessions(user_id, current_raw=None):
    """The live sessions of a user (ids are the stored hashes, never the cookie value)."""
    now = time.time()
    current = _session_hash(current_raw) if current_raw else None
    rows = connection().execute(
        'SELECT id, created_at, last_seen, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', (user_id,)).fetchall()
    out = []
    for r in rows:
        if now - r['last_seen'] > SESSION_IDLE_SECONDS or now - r['created_at'] > SESSION_MAX_AGE_SECONDS:
            continue
        out.append({'id': r['id'], 'createdAt': r['created_at'], 'lastSeen': r['last_seen'], 'userAgent': r['user_agent'] or '', 'current': r['id'] == current})
    return out


def delete_session_id(user_id, session_id):
    """End one session by its stored id (as list_sessions reports it)."""
    with _lock:
        cur = connection().execute('DELETE FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id))
    return cur.rowcount > 0


def delete_other_sessions(user_id, keep_raw):
    with _lock:
        cur = connection().execute('DELETE FROM sessions WHERE user_id = ? AND id != ?', (user_id, _session_hash(keep_raw) if keep_raw else ''))
    return cur.rowcount


def read_audit(limit=200):
    """The last `limit` audit lines, newest first, parsed: {at, action, fields}."""
    try:
        with open(audit_log_path(), 'r', encoding='utf-8') as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    out = []
    for line in reversed(lines[-max(1, min(int(limit or 200), 2000)):]):
        parts = line.split(' ')
        if len(parts) < 2:
            continue
        fields = {}
        for part in parts[2:]:
            if '=' in part:
                k, v = part.split('=', 1)
                fields[k] = v
        out.append({'at': parts[0], 'action': parts[1], 'fields': fields})
    return out


def set_display_name(user_id, display_name):
    user = get_user(user_id)
    if not user:
        raise AccountsError('no such user')
    display = clean_display_name(display_name, user['username'])
    with _lock:
        connection().execute('UPDATE users SET display_name = ? WHERE id = ?', (display, user_id))
    return get_user(user_id)


def audit_log_path():
    return os.path.join(os.path.expanduser('~'), 'accounts-audit.log')


def audit(action, **fields):
    """One line per administrative act (who, when, what) in the data directory; never a secret."""
    line = ' '.join([time.strftime('%Y-%m-%dT%H:%M:%S%z'), action] + [f'{k}={v}' for k, v in fields.items()])
    try:
        fd = os.open(audit_log_path(), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except OSError:
        pass
    return line


def temporary_password():
    """A one-time password that is easy to type: four groups of four lowercase letters/digits."""
    alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    return '-'.join(''.join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def recover_password(username, *, revoke_devices=False, make_admin=False, by='host'):
    """
    Host-side password recovery (whoever can run the CLI on the server owns
    it; there is no e-mail). Sets a random temporary password that must be
    changed at the next sign-in, ends every session of the user, re-enables
    the account, keeps its device tokens unless asked otherwise. Returns
    (user, temporary password).
    """
    name = normalize_username(username)
    conn = connection()
    with _lock:
        row = conn.execute('SELECT * FROM users WHERE username = ?', (name,)).fetchone()
        if row is None:
            raise AccountsError(f'no such user: {name}')
        temp = temporary_password()
        role = 'admin' if make_admin else row['role']
        conn.execute(
            'UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 1, disabled = 0, role = ? WHERE id = ?',
            (hash_password(temp), time.time(), role, row['id']))
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (row['id'],))
        devices = 0
        if revoke_devices:
            devices = conn.execute('UPDATE device_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', (row['id'],)).rowcount
        user = _row_to_user(conn.execute('SELECT * FROM users WHERE id = ?', (row['id'],)).fetchone())
    audit('password-recovered', user=name, by=by, was_disabled=int(bool(row['disabled'])), made_admin=int(bool(make_admin and row['role'] != 'admin')), devices_revoked=devices)
    return user, temp


def check_login(username, password):
    """The user dict when the credentials are right and the account is enabled, else None."""
    row = None
    try:
        name = normalize_username(username)
        row = connection().execute('SELECT * FROM users WHERE username = ?', (name,)).fetchone()
    except AccountsError:
        pass
    if row is None:
        verify_password(password if isinstance(password, str) else '', _dummy_hash())
        return None
    if not verify_password(password, row['password_hash']):
        return None
    if row['disabled']:
        return None
    return _row_to_user(row)


def admin_count():
    return connection().execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0").fetchone()[0]


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------
def _session_hash(raw):
    return hashlib.sha256(str(raw).encode('utf-8')).hexdigest()


def create_session(user_id, user_agent=''):
    """Returns the raw session id for the cookie (only its hash is stored)."""
    raw = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        connection().execute(
            'INSERT INTO sessions (id, user_id, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)',
            (_session_hash(raw), user_id, now, now, (user_agent or '')[:256]))
    return raw


def validate_session(raw, now=None):
    """The user dict for a live session (touching last_seen), else None."""
    if not raw or not isinstance(raw, str) or len(raw) > 128:
        return None
    now = time.time() if now is None else now
    conn = connection()
    with _lock:
        row = conn.execute(
            'SELECT s.id AS sid, s.created_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
            (_session_hash(raw),)).fetchone()
        if row is None:
            return None
        if now - row['last_seen'] > SESSION_IDLE_SECONDS or now - row['created_at'] > SESSION_MAX_AGE_SECONDS or row['disabled']:
            conn.execute('DELETE FROM sessions WHERE id = ?', (row['sid'],))
            return None
        if now - row['last_seen'] > SESSION_TOUCH_SECONDS:
            conn.execute('UPDATE sessions SET last_seen = ? WHERE id = ?', (now, row['sid']))
    return _row_to_user(row)


def delete_session(raw):
    if not raw:
        return
    with _lock:
        connection().execute('DELETE FROM sessions WHERE id = ?', (_session_hash(raw),))


def purge_expired_sessions(now=None):
    now = time.time() if now is None else now
    with _lock:
        connection().execute('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?',
                             (now - SESSION_IDLE_SECONDS, now - SESSION_MAX_AGE_SECONDS))


# ---------------------------------------------------------------------------
# device tokens: the desktop app linked to this server (Authorization: Bearer)
# ---------------------------------------------------------------------------
def _token_hash(raw):
    return hashlib.sha256(str(raw).encode('utf-8')).hexdigest()


def create_device_token(user_id, name):
    """Mint a token for a device of the user; returns (token_id, raw token) - the raw value is shown once."""
    raw = 'scd_' + secrets.token_urlsafe(32)
    token_id = str(uuid.uuid4())
    label = clean_display_name(name, 'device')[:64]
    with _lock:
        connection().execute(
            'INSERT INTO device_tokens (id, user_id, name, token_hash, created_at, last_seen, revoked) VALUES (?, ?, ?, ?, ?, NULL, 0)',
            (token_id, user_id, label, _token_hash(raw), time.time()))
    return token_id, raw


def validate_device_token(raw, now=None):
    """The user dict for a live (not revoked) token of an enabled account, else None."""
    if not raw or not isinstance(raw, str) or len(raw) > 256:
        return None
    now = time.time() if now is None else now
    conn = connection()
    with _lock:
        row = conn.execute(
            'SELECT t.id AS tid, t.revoked, t.last_seen, u.* FROM device_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
            (_token_hash(raw),)).fetchone()
        if row is None or row['revoked'] or row['disabled']:
            return None
        if row['last_seen'] is None or now - row['last_seen'] > SESSION_TOUCH_SECONDS:
            conn.execute('UPDATE device_tokens SET last_seen = ? WHERE id = ?', (now, row['tid']))
    return _row_to_user(row)


def list_device_tokens(user_id):
    rows = connection().execute(
        'SELECT id, name, created_at, last_seen, revoked FROM device_tokens WHERE user_id = ? ORDER BY created_at', (user_id,)).fetchall()
    return [{'id': r['id'], 'name': r['name'], 'createdAt': r['created_at'], 'lastSeen': r['last_seen'], 'revoked': bool(r['revoked'])} for r in rows]


def revoke_device_token(user_id, token_id):
    with _lock:
        cur = connection().execute('UPDATE device_tokens SET revoked = 1 WHERE id = ? AND user_id = ?', (token_id, user_id))
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# first-run setup code
# ---------------------------------------------------------------------------
def setup_code_path():
    return os.path.join(os.path.expanduser('~'), 'setup-code')


def setup_required():
    return user_count() == 0


def ensure_setup_code(log=print):
    """
    While no account exists, make sure a setup code is on disk (0600) and
    say where it is. Returns the code, or None once setup is done (any
    leftover file is removed then).
    """
    path = setup_code_path()
    if not setup_required():
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return None
    code = None
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            code = fh.read().strip()
    except FileNotFoundError:
        pass
    if not code or not re.fullmatch(r'[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}', code):
        code = '-'.join(secrets.token_hex(3) for _ in range(3))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(code + '\n')
    log('[Accounts] No account exists yet. Create the first (admin) account on the sign-in page with this one-time setup code:')
    log(f'[Accounts]   {code}')
    log(f'[Accounts]   (also in {path}; the file is removed once the account exists)')
    return code


def verify_setup_code(presented):
    expected = None
    try:
        with open(setup_code_path(), 'r', encoding='utf-8') as fh:
            expected = fh.read().strip()
    except FileNotFoundError:
        return False
    if not expected or not isinstance(presented, str):
        return False
    return hmac.compare_digest(expected.encode('utf-8'), presented.strip().lower().encode('utf-8'))


def clear_setup_code():
    try:
        os.unlink(setup_code_path())
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# rate limiting
# ---------------------------------------------------------------------------
class RateLimiter:
    """Sliding-window counter per key: at most `limit` hits per `window` seconds."""

    def __init__(self, limit, window_seconds):
        self.limit = limit
        self.window = window_seconds
        self._hits = {}
        self._lock = threading.Lock()

    def hit(self, key, now=None):
        """Record a hit; returns (allowed, retry_after_seconds)."""
        now = time.time() if now is None else now
        key = str(key or 'unknown')
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return False, int(self.window - (now - hits[0])) + 1
            hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > 10000:
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window]:
                    del self._hits[k]
            return True, 0

    def clear(self, key):
        with self._lock:
            self._hits.pop(str(key), None)

    def reset(self):
        with self._lock:
            self._hits.clear()


# ---------------------------------------------------------------------------
# host-side command line (inside the container: cd /app/backend; python -m accounts ...)
# ---------------------------------------------------------------------------
def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(prog='python -m accounts', description='Jacarium accounts, from the server itself (host access is the proof of ownership).')
    sub = parser.add_subparsers(dest='command')
    sub.add_parser('list-users', help='usernames, roles and state (never a hash or a password)')
    reset = sub.add_parser('reset-password', help='set a one-time temporary password for a user, printed once; it must be changed at the next sign-in')
    reset.add_argument('username')
    reset.add_argument('--revoke-devices', action='store_true', help='also revoke the linked desktop profiles (device tokens); kept by default')
    reset.add_argument('--make-admin', action='store_true', help='make the user an administrator as well')
    args = parser.parse_args(argv)
    if args.command == 'list-users':
        users = list_users()
        if not users:
            print('no accounts yet (the sign-in page creates the first one with the setup code)')
            return 0
        width = max(len(u['username']) for u in users)
        print(f"{'USERNAME'.ljust(width)}  ROLE   STATE     DISPLAY NAME")
        for u in users:
            state = 'disabled' if u['disabled'] else ('must-change-password' if u.get('mustChangePassword') else 'active')
            print(f"{u['username'].ljust(width)}  {u['role'].ljust(5)}  {state.ljust(9)} {u['displayName']}")
        return 0
    if args.command == 'reset-password':
        try:
            user, temp = recover_password(args.username, revoke_devices=args.revoke_devices, make_admin=args.make_admin, by='host-cli')
        except AccountsError as exc:
            names = ', '.join(u['username'] for u in list_users()) or '(none)'
            print(f'error: {exc}. Known usernames: {names} (python -m accounts list-users)', file=sys.stderr)
            return 1
        print(f"Temporary password for {user['username']}: {temp}")
        print('Sign in with it once; the app then asks for a new password before anything else.')
        print(f"Every session of {user['username']} has been ended" + ('; its linked devices were revoked.' if args.revoke_devices else '; linked desktop profiles stay linked.'))
        if user['role'] == 'admin' and args.make_admin:
            print(f"{user['username']} is an administrator now.")
        print(f'(recorded in {audit_log_path()})')
        return 0
    parser.print_help()
    return 2


if __name__ == '__main__':
    sys.exit(main())
