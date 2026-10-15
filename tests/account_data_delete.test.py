#!/usr/bin/env python3
"""
Guards "Delete all my data on the server" (backend/account_data.py,
backend/sync_store.py generation/reset, backend/sync_api.py):
  - the owner deletes with a fresh password + typed username: a backup in
    Export Database format is written under the account first (documents,
    boards with their cards, tasks with their instances, media), the sync
    store is emptied, the generation bumped; a device pushing with the old
    generation is refused (409 STALE_GENERATION) and a pull answers the
    new generation with nothing in it
  - wrong password 403 (audited), username mismatch 400, a linked device's
    token 403, rate limited 429 after 3 attempts per hour
  - includeFiles archives and removes the Taskwarrior/SSH/settings files
    but keeps the backups, the central pairing and the sync store
  - backups are listed and downloadable by the owner, the last 3 kept
  - an administrator deletes another account's data (own password, the
    target's username); a non-admin cannot; audit log entries

Flask test client, synthetic data in a temp directory.
Run: backend/venv/bin/python tests/account_data_delete.test.py
"""
import json
import os
import sys
import tarfile
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')
TMP = tempfile.mkdtemp(prefix='jacarium-data-delete-')
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
import account_data  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def body(r):
    try:
        return r.get_json() or {}
    except Exception:
        return {}


def client():
    return app_module.app.test_client()


def post(c, path, payload=None, headers=None):
    return c.post(path, json=payload or {}, headers={**HDR, **(headers or {})}, base_url=BASE)


def get(c, path, headers=None):
    return c.get(path, headers=headers or {}, base_url=BASE)


code = open(os.path.join(HOME, 'setup-code')).read().strip()
alice = client()
check('alice (admin) exists', post(alice, '/api/auth/setup', {'setupCode': code, 'username': 'alice', 'password': 'alices password'}).status_code == 201)
alice_id = body(get(alice, '/api/auth/me'))['user']['id']
home = os.path.join(HOME, 'users', alice_id)

# a device of alice's pushes a small world: a board with a card, an instance with a task, a document, a media file
now = time.time() * 1000
changes = [
    {'collection': 'kanbanBoards', 'key': 'board-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'title': 'Sprint', 'category': 'Work', 'updatedAt': '2026-10-11T00:00:00Z'}},
    {'collection': 'kanbanCards', 'key': 'card-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'title': 'Fix it', 'boardIdSync': 'board-1', 'column': 'todo'}},
    {'collection': 'taskwarriorInstances', 'key': 'inst-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'name': 'work', 'rcPath': '~/.task/work/taskrc', 'dataPath': '~/.task/work'}},
    {'collection': 'tasks', 'key': 'uuid-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'uuid': 'uuid-1', 'description': 'Buy milk', 'status': 'pending', 'instanceIdSync': 'inst-1'}},
    {'collection': 'documents', 'key': 'doc-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'title': 'Runbook', 'content': 'secret-free synthetic text', 'category': 'General', 'stableId': 'doc-1'}},
    {'collection': 'documents', 'key': 'doc-2', 'baseRev': 0, 'updatedAt': now, 'deleted': True},
    {'collection': 'media', 'key': 'media-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'filename': 'x.png', 'mimeType': 'image/png', 'size': 3, 'blob': 'data:image/png;base64,AAAA'}},
    {'collection': 'templates', 'key': 'jql-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'name': 'My JQL', 'category': 'General', 'query': 'project = X'}},
    {'collection': 'customFields', 'key': 'cf-1', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'id': 'cf-1', 'name': 'extra'}},
]
r = post(alice, '/api/sync/push', {'device': 'laptop', 'changes': changes})
check('the device pushed the records', r.status_code == 200 and all(x['status'] == 'ok' for x in body(r)['results']), r.get_data(as_text=True)[:200])
gen0 = body(get(alice, '/api/sync/status'))['generation']
check('the store starts at generation 1', gen0 == 1)
# some per-account files
os.makedirs(os.path.join(home, '.task', 'work'), exist_ok=True)
open(os.path.join(home, '.task', 'work', 'pending.data'), 'w').write('synthetic')
os.makedirs(os.path.join(home, '.ssh'), exist_ok=True)
open(os.path.join(home, '.ssh', 'id_ed25519'), 'w').write('synthetic key material (not a real key)')
open(os.path.join(home, '.jacarium.env'), 'w').write('JIRA_EMAIL=a@example.test\n')
open(os.path.join(home, 'central-pairing.json'), 'w').write(json.dumps({'serverUrl': 'https://c.example.test', 'machineId': 'alice@account-x', 'secret': 'synthetic'}))

# --- refusals ---------------------------------------------------------------------------
r = post(alice, '/api/account/data/delete', {'password': 'wrong', 'confirmUsername': 'alice'})
check('a wrong password is refused (403) and nothing happens', r.status_code == 403 and body(get(alice, '/api/sync/status'))['records'] == 9)
r = post(alice, '/api/account/data/delete', {'password': 'alices password', 'confirmUsername': 'alicia'})
check('a mismatched username is refused (400)', r.status_code == 400)
tok = body(post(alice, '/api/auth/devices', {'name': 'desktop'}))['token']
r = client().post('/api/account/data/delete', json={'password': 'alices password', 'confirmUsername': 'alice'}, headers={**HDR, 'Authorization': f'Bearer {tok}'}, base_url=BASE)
check('a linked device (bearer token) cannot do it (403)', r.status_code == 403)
check('nothing was deleted by the refused attempts', body(get(alice, '/api/sync/status'))['records'] == 9 and os.path.isfile(os.path.join(home, '.jacarium.env')))

# --- the deletion -------------------------------------------------------------------------
r = post(alice, '/api/account/data/delete', {'password': 'alices password', 'confirmUsername': 'alice', 'includeFiles': False})
answer = body(r)
check('the owner deletes with a fresh password and the typed username', r.status_code == 200 and answer['ok'] and answer['deleted']['records'] == 9 and answer['generation'] == 2, r.get_data(as_text=True)[:200])
backup_name = answer['backups'][0]
backup_path = os.path.join(home, 'backups', backup_name)
check('a backup was written under the account first (0600)', os.path.isfile(backup_path) and (os.stat(backup_path).st_mode & 0o777) == 0o600, backup_name)
export = json.load(open(backup_path))
check('...in Export Database format: documents (tombstone left out)', export.get('version') == '1.0' and [d['title'] for d in export['documents']] == ['Runbook'])
check('...boards with their cards referring to the board by its file id', export['kanbanBoards'][0]['title'] == 'Sprint' and export['kanbanCards'][0]['boardId'] == export['kanbanBoards'][0]['id'])
check('...tasks with their instance (format 1 flat tasks)', export['taskwarriorInstances'][0]['name'] == 'work' and export['tasks'][0]['instanceId'] == export['taskwarriorInstances'][0]['id'] and export['tasks'][0]['uuid'] == 'uuid-1')
check('...media as base64 data, JQL templates under their file name', export['media'][0]['data'].startswith('data:image/png') and export['jqlTemplates'][0]['name'] == 'My JQL')
check('...collections the file format does not know travel under syncExtra', export['syncExtra']['customFields'][0]['name'] == 'extra')
status = body(get(alice, '/api/sync/status'))
check('the sync store is empty at generation 2', status['records'] == 0 and status['generation'] == 2, str(status))
r = get(alice, '/api/sync/pull?since=0')
check('a pull answers the new generation with nothing in it', body(r)['generation'] == 2 and body(r)['changes'] == [])
r = post(alice, '/api/sync/push', {'device': 'offline-laptop', 'generation': 1, 'changes': [changes[4]]})
check('a device that was offline pushes with the old generation -> 409 STALE_GENERATION, nothing resurrected', r.status_code == 409 and body(r)['code'] == 'STALE_GENERATION' and body(r)['generation'] == 2 and body(get(alice, '/api/sync/status'))['records'] == 0)
r = post(alice, '/api/sync/push', {'device': 'laptop', 'generation': 2, 'changes': [changes[4]]})
check('a push with the current generation is accepted', r.status_code == 200 and body(r)['results'][0]['status'] == 'ok')
check('the per-account files were left alone (includeFiles off)', os.path.isfile(os.path.join(home, '.jacarium.env')) and os.path.isfile(os.path.join(home, '.task', 'work', 'pending.data')))
r = get(alice, '/api/account/backups')
check('the owner lists the backup', r.status_code == 200 and body(r)['backups'][0]['name'] == backup_name and body(r)['keep'] == 3)
r = get(alice, f'/api/account/backups/{backup_name}')
check('...and downloads it', r.status_code == 200 and json.loads(r.get_data(as_text=True))['documents'][0]['title'] == 'Runbook')
check('a bogus backup name is refused', get(alice, '/api/account/backups/../accounts.sqlite').status_code in (404, 400) and get(alice, '/api/account/backups/x.json').status_code == 404)

# --- includeFiles -------------------------------------------------------------------------
time.sleep(1.1)   # a new backup stamp
account_data.delete_limiter._hits.clear()   # the refused attempts above count towards the limit (by design)
r = post(alice, '/api/account/data/delete', {'password': 'alices password', 'confirmUsername': 'alice', 'includeFiles': True})
answer = body(r)
check('with includeFiles the per-account files are archived and removed', r.status_code == 200 and sorted(answer['deleted']['files']) == ['.jacarium.env', '.ssh', '.task'] and answer['generation'] == 3, r.get_data(as_text=True)[:200])
archive = [n for n in answer['backups'] if n.endswith('.tar.gz')][0]
with tarfile.open(os.path.join(home, 'backups', archive)) as tar:
    names = tar.getnames()
check('...the archive holds them', '.task/work/pending.data' in names and '.ssh/id_ed25519' in names and '.jacarium.env' in names, str(names))
check('...the backups, the central pairing and the sync store stay', os.path.isdir(os.path.join(home, 'backups')) and os.path.isfile(os.path.join(home, 'central-pairing.json')) and os.path.isfile(os.path.join(home, 'sync.sqlite')) and not os.path.exists(os.path.join(home, '.task')))

# --- rate limit ---------------------------------------------------------------------------
account_data.delete_limiter._hits.clear()
codes = [post(alice, '/api/account/data/delete', {'password': 'wrong', 'confirmUsername': 'alice'}).status_code for _ in range(4)]
check('every attempt counts: the fourth within the hour is rate limited (429)', codes == [403, 403, 403, 429], str(codes))

# --- an administrator over another account ------------------------------------------------
bob_id = body(post(alice, '/api/admin/users', {'username': 'bob', 'password': 'bobs password 1'}))['user']['id']
bob = client()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
post(bob, '/api/sync/push', {'device': 'bobs', 'changes': [{'collection': 'documents', 'key': 'bob-doc', 'baseRev': 0, 'updatedAt': now, 'deleted': False, 'body': {'title': 'Bobs doc', 'content': 'x', 'category': 'General', 'stableId': 'bob-doc'}}]})
r = post(bob, f'/api/admin/users/{alice_id}/data/delete', {'password': 'bobs password 1', 'confirmUsername': 'alice'})
check('a non-admin cannot delete another account\'s data', r.status_code == 403)
account_data.delete_limiter._hits.clear()
r = post(alice, f'/api/admin/users/{bob_id}/data/delete', {'password': 'alices password', 'confirmUsername': 'bob'})
check('an admin deletes bob\'s data with her OWN password and bob\'s username', r.status_code == 200 and body(r)['deleted']['records'] == 1 and body(get(bob, '/api/sync/status'))['records'] == 0, r.get_data(as_text=True)[:160])
r = get(alice, f'/api/admin/users/{bob_id}/backups')
check('...and sees bob\'s backup', r.status_code == 200 and len(body(r)['backups']) == 1)
r = post(alice, f'/api/admin/users/{bob_id}/data/delete', {'password': 'alices password', 'confirmUsername': 'alice'})
check('the typed username must be the TARGET\'s', r.status_code == 400)

# --- retention + audit --------------------------------------------------------------------
for i in range(4):
    stamp = f'2026010{i + 1}T000000Z'
    open(os.path.join(home, 'backups', f'{stamp}-before-delete.json'), 'w').write('{}')
account_data._prune(home)
kept = sorted(os.listdir(os.path.join(home, 'backups')))
check('only the last 3 backup sets are kept', len({n.split('-')[0] for n in kept}) == 3 and not any(n.startswith('20260101') for n in kept), str(kept))
log = open(os.path.join(HOME, 'accounts-audit.log')).read()
check('every deletion (and the refused attempt) is in the audit log with who/whom', log.count('data-deleted') == 3 and 'data-delete-refused user=alice by=alice reason=wrong-password' in log and 'data-deleted user=bob by=alice' in log)
check('...without the password', 'alices password' not in log)

failed = [n for n, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
