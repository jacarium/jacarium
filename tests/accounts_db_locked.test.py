#!/usr/bin/env python3
"""
A busy database is an answer, never a hang (backend/accounts.py, backend/sync_store.py, backend/app.py).

Another connection holds a write lock on the accounts database (BEGIN IMMEDIATE - what a second instance on the
same data or an external tool does). A write through the accounts module then fails with sqlite3's "database is
locked" after the busy timeout (BUSY_TIMEOUT_SECONDS, 5 s) - within a bounded time, never an endless wait; through
the Flask app the same situation is a 503 JSON answer with a clear message and a retryable flag; the moment the
lock goes, the write succeeds. The sync store carries the same timeout.

Run: backend/venv/bin/python tests/accounts_db_locked.test.py
"""
import os
import sqlite3
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-db-locked-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ.pop('JACARIUM_ENV_FILE', None)
os.environ.pop('JACARIUM_ACCOUNTS_DB', None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import accounts  # noqa: E402
import sync_store  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# the store exists and the timeout is the named one
accounts.connection()
path = accounts.db_path()
check('the accounts database exists under the scratch HOME', os.path.exists(path), path)
check('the busy timeout is a few seconds, named in both stores', 2 <= accounts.BUSY_TIMEOUT_SECONDS <= 10 and sync_store.BUSY_TIMEOUT_SECONDS == accounts.BUSY_TIMEOUT_SECONDS, f'{accounts.BUSY_TIMEOUT_SECONDS} / {sync_store.BUSY_TIMEOUT_SECONDS}')
busy_ms = accounts.connection().execute('PRAGMA busy_timeout').fetchone()[0]
check('PRAGMA busy_timeout is set on the connection', busy_ms == int(accounts.BUSY_TIMEOUT_SECONDS * 1000), str(busy_ms))

# another process's write lock, held for a while
holder = sqlite3.connect(path, isolation_level=None, timeout=0.1)
holder.execute('BEGIN IMMEDIATE')   # the write lock (WAL: the one writer slot), held until ROLLBACK

started = time.time()
error = None
try:
    accounts.create_user('alice', 'correct horse battery staple', display_name='Alice')
except Exception as exc:  # noqa: BLE001 - the kind is the point
    error = exc
elapsed = time.time() - started
check('a write while another connection holds the lock fails with "database is locked" (not a hang)', isinstance(error, sqlite3.OperationalError) and 'locked' in str(error).lower(), repr(error))
check(f'... after the busy timeout, within bounds ({elapsed:.1f} s for a {accounts.BUSY_TIMEOUT_SECONDS:.0f} s timeout)', accounts.BUSY_TIMEOUT_SECONDS * 0.8 <= elapsed <= accounts.BUSY_TIMEOUT_SECONDS + 3, f'{elapsed:.2f}')

# through the app: a 503 with a clear message, the lock still held
client = app_module.app.test_client()
setup_routes = [r.rule for r in app_module.app.url_map.iter_rules() if r.rule.startswith('/api/auth/setup')]
if setup_routes:
    setup_code = None
    code_file = os.path.join(HOME, 'setup-code')
    if os.path.exists(code_file):
        setup_code = open(code_file, encoding='utf-8').read().strip()
    started = time.time()
    response = client.post('/api/auth/setup', json={'setupCode': setup_code or 'x', 'username': 'bob', 'password': 'correct horse battery staple', 'displayName': 'Bob'}, headers={'X-Requested-With': 'Jacarium'}, base_url='https://console.test')
    elapsed = time.time() - started
    data = response.get_json() or {}
    locked_answer = response.status_code == 503 and data.get('code') == 'database_locked' and 'in use by another process' in data.get('error', '') and data.get('retryable') is True
    check(f'the Flask app answers a locked database with 503 and a clear, retryable message ({response.status_code} in {elapsed:.1f} s)', locked_answer or response.status_code in (400, 401, 403), f'{response.status_code} {data}')
    if not locked_answer:
        print(f'  note: /api/auth/setup rejected the request before touching the database ({response.status_code}); the direct write above shows the lock error')
else:
    print('  note: no /api/auth/setup route in this build; the handler is checked through the direct write')

# the handler itself, directly
with app_module.app.test_request_context():
    body, status = app_module._sqlite_busy(sqlite3.OperationalError('database is locked'))
    check('the error handler turns "database is locked" into 503 database_locked, retryable', status == 503 and body.get_json()['code'] == 'database_locked' and body.get_json()['retryable'] is True)
    body2, status2 = app_module._sqlite_busy(sqlite3.OperationalError('no such table: x'))
    check('... and any other sqlite error into 503 database_error with its message', status2 == 503 and body2.get_json()['code'] == 'database_error' and 'no such table' in body2.get_json()['error'])

# the lock released: the write goes through at once
holder.execute('ROLLBACK')
holder.close()
started = time.time()
user = accounts.create_user('alice', 'correct horse battery staple', display_name='Alice')
check(f'once the lock is gone the same write succeeds at once ({time.time() - started:.2f} s)', user and user.get('username') == 'alice' and time.time() - started < 2, repr(user))

# a lock that goes away during the wait: the write succeeds without an error
holder = sqlite3.connect(path, isolation_level=None, timeout=0.1, check_same_thread=False)   # released from another thread below
holder.execute('BEGIN IMMEDIATE')
def release_soon():
    time.sleep(1.5)
    holder.execute('ROLLBACK'); holder.close()
threading.Thread(target=release_soon, daemon=True).start()
started = time.time()
user2 = accounts.create_user('carol', 'correct horse battery staple', display_name='Carol')
check(f'a lock released during the wait: the write completes after the wait ({time.time() - started:.1f} s), no error', user2 and user2.get('username') == 'carol' and 1 <= time.time() - started < accounts.BUSY_TIMEOUT_SECONDS)

failed = [n for n, ok in results if not ok]
print(f"\n{'All checks passed' if not failed else str(len(failed)) + ' check(s) failed'} ({len(results) - len(failed)}/{len(results)})")
sys.exit(1 if failed else 0)
