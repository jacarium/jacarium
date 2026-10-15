#!/usr/bin/env python3
"""
Guards the Google Calendar OAuth token file permissions fix
(backend/google_calendar.py: _save_token / _tighten_token_permissions).

THE BUG: the pickled credentials (which contain a live refresh token for the
user's Google account) were written with plain open(..., 'wb'), i.e. with the
process umask - typically 0644, readable by every local user - and never
tightened afterwards.

THE FIX: every write goes through _save_token(), which creates the file via
os.open(..., 0o600) (never wider, O_TRUNC so a looser pre-existing file is
replaced in place) and chmods it to 0600; every read is preceded by
_tighten_token_permissions(), so a file left behind by an older version is
tightened on first use. Both are no-ops on Windows.

What this test proves (temp token path, real functions, no Google calls):
  - a fresh save produces a 0600 file whose contents round-trip via pickle;
  - a pre-existing 0644 file is replaced and ends up 0600;
  - _tighten_token_permissions fixes a 0644 file and leaves a missing file
    alone (no exception);
  - saving with a restrictive umask still yields 0600, saving with a
    permissive umask (0000) still yields 0600 (never wider);
  - the module no longer contains a bare `open(TOKEN_FILE, 'wb')`.

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/gcal_token_permissions.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import pickle
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

if os.name == 'nt':
    print('POSIX permission bits are not meaningful on Windows - nothing to test here.')
    sys.exit(0)

try:
    import google_calendar as gc
except ImportError as e:
    print(f'Missing dependency ({e}). Run with the backend venv: backend/venv/bin/python tests/gcal_token_permissions.test.py')
    sys.exit(1)

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def mode_of(path):
    return stat.S_IMODE(os.stat(path).st_mode)


workdir = tempfile.mkdtemp(prefix='gcal-token-')
token_path = os.path.join(workdir, 'token.pickle')
payload = {'refresh_token': 'not-a-real-token', 'scopes': ['calendar']}

try:
    gc._save_token(payload, token_path)
    check('fresh save -> file exists with mode 0600', os.path.exists(token_path) and mode_of(token_path) == 0o600, oct(mode_of(token_path)))
    with open(token_path, 'rb') as f:
        check('fresh save -> contents round-trip', pickle.load(f) == payload)

    os.chmod(token_path, 0o644)
    check('setup: loosened to 0644', mode_of(token_path) == 0o644)
    gc._save_token({'v': 2}, token_path)
    with open(token_path, 'rb') as f:
        check('save over a 0644 file -> replaced in place and tightened to 0600', mode_of(token_path) == 0o600 and pickle.load(f) == {'v': 2}, oct(mode_of(token_path)))

    os.chmod(token_path, 0o644)
    gc._tighten_token_permissions(token_path)
    check('_tighten_token_permissions fixes a 0644 legacy file', mode_of(token_path) == 0o600, oct(mode_of(token_path)))
    os.chmod(token_path, 0o600)
    gc._tighten_token_permissions(token_path)
    check('_tighten_token_permissions leaves a 0600 file alone', mode_of(token_path) == 0o600)
    try:
        gc._tighten_token_permissions(os.path.join(workdir, 'missing.pickle'))
        check('_tighten_token_permissions tolerates a missing file', True)
    except Exception as e:  # noqa: BLE001
        check('_tighten_token_permissions tolerates a missing file', False, str(e))

    old = os.umask(0o000)
    try:
        p2 = os.path.join(workdir, 'permissive-umask.pickle')
        gc._save_token(payload, p2)
        check('save under umask 0000 is still 0600 (never wider)', mode_of(p2) == 0o600, oct(mode_of(p2)))
    finally:
        os.umask(old)
    old = os.umask(0o077)
    try:
        p3 = os.path.join(workdir, 'restrictive-umask.pickle')
        gc._save_token(payload, p3)
        check('save under umask 0077 is 0600', mode_of(p3) == 0o600, oct(mode_of(p3)))
    finally:
        os.umask(old)

    src = open(os.path.join(BACKEND, 'google_calendar.py')).read()
    check("no bare open(TOKEN_FILE, 'wb') left in google_calendar.py", "open(TOKEN_FILE, 'wb')" not in src)
    check('reads are preceded by a tighten call', '_tighten_token_permissions()' in src.split("open(TOKEN_FILE, 'rb')")[0])
finally:
    import shutil
    shutil.rmtree(workdir, ignore_errors=True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
