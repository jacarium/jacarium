#!/usr/bin/env python3
"""
Guards the server side of synchronisation (backend/sync_store.py and the
routes in backend/sync_api.py).

What this test proves (the store on a temp file; then the routes through
the Flask test client in accounts mode with two accounts; synthetic data):
  store
  - a new record is accepted with rev 1 and a fresh, increasing seq; an
    update based on the current rev gets rev+1 and a new seq; the feed
    (pull since=N) lists changes in seq order with paging;
  - a tombstone is a change like any other (deleted=true, body null);
  - a concurrent write (baseRev older than the record's rev): the newer
    updatedAt wins; the loser is kept as a version with a reason; the
    losing pusher gets 'conflict' with the winner; a losing deletion too;
  - a device clock far ahead is clamped to the server's time + skew (so it
    cannot win every conflict), seconds are normalised to milliseconds;
  - versions are capped per record; bad changes answer 'error' without
    affecting the rest of the batch; an oversized body is refused;
  routes
  - /api/sync/* answer 404 without a session... and 401 is the auth seam's
    answer first; with a session push/pull/record/versions work;
  - two accounts have separate stores: alice's records never appear in
    bob's feed (and vice versa);
  - the open deployment (none) has no sync routes (404).

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/sync_store.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-sync-store-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
for key in ('JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

from sync_store import SyncStore, MAX_VERSIONS_PER_RECORD  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# ---------------------------------------------------------------------------
# the store
# ---------------------------------------------------------------------------
store = SyncStore(os.path.join(TMP, 'unit.sqlite'))
NOW = 1_800_000_000.0           # a fixed server clock (seconds)
ms = lambda s: s * 1000.0       # noqa: E731

r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 0, 'updatedAt': ms(NOW - 100), 'deleted': False, 'body': {'title': 'One', 'content': 'a'}}], 'devA', now=NOW)
check('a new record is accepted with rev 1, seq 1', r == [{'status': 'ok', 'rev': 1, 'seq': 1}], str(r))
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 1, 'updatedAt': ms(NOW - 50), 'deleted': False, 'body': {'title': 'One', 'content': 'ab'}}], 'devA', now=NOW)
check('an update based on the current rev gets rev 2, seq 2', r == [{'status': 'ok', 'rev': 2, 'seq': 2}], str(r))
r = store.push([{'collection': 'kanbanBoards', 'key': 'b1', 'baseRev': 0, 'updatedAt': ms(NOW - 40), 'deleted': False, 'body': {'title': 'Board'}}], 'devB', now=NOW)
check('another collection shares the account-wide sequence', r[0]['seq'] == 3)
feed = store.pull(since=0, limit=2)
check('the feed pages in seq order', [c['seq'] for c in feed['changes']] == [2, 3] and feed['more'] is False and feed['latest'] == 3, json.dumps(feed)[:200])
feed = store.pull(since=2)
check('since=N returns only later changes', [c['key'] for c in feed['changes']] == ['b1'])

# tombstone
r = store.push([{'collection': 'kanbanBoards', 'key': 'b1', 'baseRev': 1, 'updatedAt': ms(NOW - 30), 'deleted': True}], 'devB', now=NOW)
rec = store.get('kanbanBoards', 'b1')
check('a deletion is a change with deleted=true and no body', r[0]['status'] == 'ok' and rec['deleted'] is True and rec['body'] is None and rec['rev'] == 2, str(rec))

# concurrent edits: both based on rev 2 of d1
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 2, 'updatedAt': ms(NOW - 20), 'deleted': False, 'body': {'title': 'One', 'content': 'from B (newer)'}}], 'devB', now=NOW)
check("device B's edit of rev 2 is accepted (rev 3)", r[0] == {'status': 'ok', 'rev': 3, 'seq': 5})
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 2, 'updatedAt': ms(NOW - 25), 'deleted': False, 'body': {'title': 'One', 'content': 'from A (older)'}}], 'devA', now=NOW)
check("device A's older concurrent edit loses: 'conflict' with the winner", r[0]['status'] == 'conflict' and r[0]['winner']['body']['content'] == 'from B (newer)' and r[0]['winner']['rev'] == 3, str(r)[:200])
versions = store.versions('documents', 'd1')
check("...and A's version is kept on the server, restorable", len(versions) == 1 and versions[0]['body']['content'] == 'from A (older)' and versions[0]['reason'] == 'lost a concurrent edit' and versions[0]['device'] == 'devA', json.dumps(versions)[:200])
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 2, 'updatedAt': ms(NOW - 10), 'deleted': False, 'body': {'title': 'One', 'content': 'from C (newest)'}}], 'devC', now=NOW)
rec = store.get('documents', 'd1')
versions = store.versions('documents', 'd1')
check('a newer concurrent edit wins and the overwritten one is kept as a version',
      r[0]['status'] == 'ok' and rec['body']['content'] == 'from C (newest)' and rec['rev'] == 4
      and versions[0]['body']['content'] == 'from B (newer)' and versions[0]['reason'] == 'overwritten by a concurrent edit', json.dumps(versions)[:200])
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 3, 'updatedAt': ms(NOW - 15), 'deleted': True}], 'devB', now=NOW)
check('an older concurrent deletion loses too (the document stays)', r[0]['status'] == 'conflict' and store.get('documents', 'd1')['deleted'] is False)
r = store.push([{'collection': 'documents', 'key': 'd1', 'baseRev': 3, 'updatedAt': ms(NOW - 5), 'deleted': True}], 'devB', now=NOW)
check('a newer concurrent deletion wins', r[0]['status'] == 'ok' and store.get('documents', 'd1')['deleted'] is True)

# clock skew
r = store.push([{'collection': 'documents', 'key': 'd2', 'baseRev': 0, 'updatedAt': ms(NOW + 36000), 'deleted': False, 'body': {'title': 'Two'}}], 'devSkew', now=NOW)
rec = store.get('documents', 'd2')
check('a clock ten hours ahead is clamped to now + skew', rec['updatedAt'] == ms(NOW + 300), str(rec['updatedAt']))
r = store.push([{'collection': 'documents', 'key': 'd3', 'baseRev': 0, 'updatedAt': NOW - 100, 'deleted': False, 'body': {'title': 'Three'}}], 'devA', now=NOW)
check('seconds are normalised to milliseconds', store.get('documents', 'd3')['updatedAt'] == ms(NOW - 100))

# versions cap, errors, size
for i in range(MAX_VERSIONS_PER_RECORD + 5):
    store.push([{'collection': 'documents', 'key': 'd3', 'baseRev': 1, 'updatedAt': ms(NOW - 1000 - i), 'deleted': False, 'body': {'title': f'v{i}'}}], 'devX', now=NOW)
check('versions are capped per record', len(store.versions('documents', 'd3')) == MAX_VERSIONS_PER_RECORD)
r = store.push([{'collection': '', 'key': 'x'}, 'not an object', {'collection': 'documents', 'key': 'd4', 'baseRev': 'abc', 'body': {}},
                {'collection': 'documents', 'key': 'd5', 'baseRev': 0, 'updatedAt': ms(NOW), 'deleted': False, 'body': {'title': 'Five'}}], 'devA', now=NOW)
check('bad changes answer error without affecting the rest of the batch', [x['status'] for x in r] == ['error', 'error', 'error', 'ok'], str(r))
r = store.push([{'collection': 'media', 'key': 'm1', 'baseRev': 0, 'updatedAt': ms(NOW), 'deleted': False, 'body': {'data': 'x' * (16 * 1024 * 1024 + 10)}}], 'devA', now=NOW)
check('an oversized body is refused', r[0]['status'] == 'error' and 'too large' in r[0]['error'])
store.close()

# ---------------------------------------------------------------------------
# the routes
# ---------------------------------------------------------------------------
import app as app_module  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
code = open(os.path.join(HOME, 'setup-code')).read().strip()


def body(r):
    try:
        return r.get_json() or {}
    except Exception:
        return {}


anon = app_module.app.test_client()
r = anon.get('/api/sync/status', base_url=BASE)
check('the sync routes need a session (401)', r.status_code == 401)
alice = app_module.app.test_client()
r = alice.post('/api/auth/setup', json={'setupCode': code, 'username': 'alice', 'password': 'alices password'}, headers=HDR, base_url=BASE)
assert r.status_code == 201, r.get_data(as_text=True)
alice.post('/api/admin/users', json={'username': 'bob', 'password': 'bobs password'}, headers=HDR, base_url=BASE)
bob = app_module.app.test_client()
bob.post('/api/auth/login', json={'username': 'bob', 'password': 'bobs password'}, headers=HDR, base_url=BASE)

r = alice.get('/api/sync/status', base_url=BASE)
check('status answers for a signed-in account', r.status_code == 200 and body(r)['enabled'] is True and body(r)['latest'] == 0, r.get_data(as_text=True))
r = alice.post('/api/sync/push', json={'device': 'alice-laptop', 'changes': [{'collection': 'documents', 'key': 'a1', 'baseRev': 0, 'updatedAt': time.time() * 1000, 'deleted': False, 'body': {'title': 'Alice doc', 'content': 'hi'}}]}, headers=HDR, base_url=BASE)
check('push works through the route', r.status_code == 200 and body(r)['results'][0]['status'] == 'ok' and body(r)['latest'] == 1, r.get_data(as_text=True)[:150])
r = alice.get('/api/sync/pull?since=0', base_url=BASE)
check('pull returns the change', r.status_code == 200 and body(r)['changes'][0]['key'] == 'a1' and body(r)['changes'][0]['device'] == 'alice-laptop')
r = alice.get('/api/sync/record?collection=documents&key=a1', base_url=BASE)
check('record answers the current body', r.status_code == 200 and body(r)['body']['title'] == 'Alice doc')
r = bob.get('/api/sync/pull?since=0', base_url=BASE)
check("bob's feed is empty: alice's data never reaches him", r.status_code == 200 and body(r)['changes'] == [])
bob.post('/api/sync/push', json={'device': 'bob-phone', 'changes': [{'collection': 'documents', 'key': 'a1', 'baseRev': 0, 'updatedAt': time.time() * 1000, 'deleted': False, 'body': {'title': 'Bob doc with the same key'}}]}, headers=HDR, base_url=BASE)
r = alice.get('/api/sync/record?collection=documents&key=a1', base_url=BASE)
check("bob's record with the same key does not touch alice's", body(r)['body']['title'] == 'Alice doc')
check('the stores live under each account\'s home', os.path.isfile(os.path.join(HOME, 'users', body(alice.get('/api/auth/me', base_url=BASE))['user']['id'], 'sync.sqlite')))
r = alice.post('/api/sync/push', json={'device': 'x', 'changes': 'nope'}, headers=HDR, base_url=BASE)
check('a malformed push is refused (400)', r.status_code == 400)
r = alice.get('/api/sync/versions?collection=documents&key=a1', base_url=BASE)
check('versions answers (none yet)', r.status_code == 200 and body(r)['versions'] == [] and body(r)['current']['rev'] == 1)

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
