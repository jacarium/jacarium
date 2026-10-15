#!/usr/bin/env python3
"""
Guards the adoption of a container's pre-accounts data when the first admin
is created (backend/legacy_migration.py, called by POST /api/auth/setup).

What this test proves (Flask test client, a throwaway data volume prepared
the way a no-sign-in container leaves it, synthetic contents only):
  - the shared settings file becomes the server defaults (settings.env,
    0600); the admin inherits its keys at once; the original is untouched;
  - .task/ and .taskrc are copied to the admin's home, data.location
    rewritten to the admin's own .task; the originals stay;
  - known_hosts and the SSH identities are copied (0600 / 0644), nothing
    else from .ssh;
  - the Google Calendar token is copied (0600);
  - the vector DB is left alone;
  - a marker records what was done; running the migration again is a no-op;
  - a later-created user inherits nothing of the admin's adopted files;
  - a setup on an empty data volume copies nothing and reports that.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/accounts_legacy_migration.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-migration-')
HOME = os.path.join(TMP, 'data')
os.makedirs(os.path.join(HOME, '.task'))
os.makedirs(os.path.join(HOME, '.ssh'), mode=0o700)
os.makedirs(os.path.join(HOME, '.jacarium', 'vector_db'))
with open(os.path.join(HOME, '.jacarium.env'), 'w') as fh:
    fh.write('# old shared settings\nJIRA_URL=https://jira.example.test\nJIRA_PAT=old-shared-synthetic-pat\nDEFAULT_AI_PROVIDER=ollama\n')
with open(os.path.join(HOME, '.task', 'pending.data'), 'w') as fh:
    fh.write('[description:"synthetic task" entry:"1700000000" status:"pending" uuid:"11111111-2222-3333-4444-555555555555"]\n')
with open(os.path.join(HOME, '.taskrc'), 'w') as fh:
    fh.write(f'# Jacarium - Taskwarrior configuration (container)\ndata.location={HOME}/.task\nconfirmation=off\n')
with open(os.path.join(HOME, '.ssh', 'known_hosts'), 'w') as fh:
    fh.write('host.example.test ssh-ed25519 AAAAsynthetic\n')
with open(os.path.join(HOME, '.ssh', 'id_ed25519'), 'w') as fh:
    fh.write('synthetic private key\n')
with open(os.path.join(HOME, '.ssh', 'id_ed25519.pub'), 'w') as fh:
    fh.write('synthetic public key\n')
with open(os.path.join(HOME, '.ssh', 'unrelated.txt'), 'w') as fh:
    fh.write('not a key\n')
with open(os.path.join(HOME, '.jacarium-gcal-token.pickle'), 'wb') as fh:
    fh.write(b'synthetic pickle')
with open(os.path.join(HOME, '.jacarium', 'vector_db', 'marker'), 'w') as fh:
    fh.write('index\n')

os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
for key in ('JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB', 'JIRA_URL', 'JIRA_PAT'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import legacy_migration  # noqa: E402
from user_context import user_home_for  # noqa: E402

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


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


code = open(os.path.join(HOME, 'setup-code')).read().strip()
admin = app_module.app.test_client()
r = admin.post('/api/auth/setup', json={'setupCode': code, 'username': 'admin', 'password': 'admin password 1'}, headers=HDR, base_url=BASE)
report = body(r).get('migration', {})
check('setup succeeds and returns the migration report', r.status_code == 201 and isinstance(report, dict) and not report.get('errors'), json.dumps(report)[:300])
home = user_home_for(body(r)['user']['id'])

# --- settings -> server defaults --------------------------------------------------
defaults = os.path.join(HOME, 'settings.env')
check('the shared settings became the server defaults (0600)', os.path.isfile(defaults) and mode(defaults) == 0o600 and 'JIRA_PAT=old-shared-synthetic-pat' in open(defaults).read())
check('the original settings file is untouched', open(os.path.join(HOME, '.jacarium.env')).read().startswith('# old shared settings'))
r = admin.get('/api/settings', base_url=BASE)
check('the admin inherits the old keys right away (secrets as true only)', body(r).get('inherited', {}).get('JIRA_URL') == 'https://jira.example.test' and body(r)['inherited'].get('JIRA_PAT') is True and 'old-shared-synthetic-pat' not in r.get_data(as_text=True), r.get_data(as_text=True)[:200])

# --- Taskwarrior ----------------------------------------------------------------------
check(".task/ was copied to the admin's home", os.path.isfile(os.path.join(home, '.task', 'pending.data')) and 'synthetic task' in open(os.path.join(home, '.task', 'pending.data')).read())
rc = open(os.path.join(home, '.taskrc')).read() if os.path.isfile(os.path.join(home, '.taskrc')) else ''
check('.taskrc was copied with data.location rewritten to the admin\'s .task', f'data.location={os.path.join(home, ".task")}' in rc and 'confirmation=off' in rc, rc.replace('\n', ' | '))
check('the original .task/ and .taskrc stay', os.path.isfile(os.path.join(HOME, '.task', 'pending.data')) and f'data.location={HOME}/.task' in open(os.path.join(HOME, '.taskrc')).read())

# --- SSH ----------------------------------------------------------------------------------
ssh = os.path.join(home, '.ssh')
check('known_hosts and the identities were copied with safe modes, nothing else',
      os.path.isfile(os.path.join(ssh, 'known_hosts')) and mode(os.path.join(ssh, 'known_hosts')) == 0o600
      and mode(os.path.join(ssh, 'id_ed25519')) == 0o600 and mode(os.path.join(ssh, 'id_ed25519.pub')) == 0o644
      and not os.path.exists(os.path.join(ssh, 'unrelated.txt')) and mode(ssh) == 0o700,
      str(sorted(os.listdir(ssh))))

# --- calendar token, vector DB ------------------------------------------------------------
token = os.path.join(home, '.jacarium-gcal-token.pickle')
check('the Google Calendar token was copied (0600)', os.path.isfile(token) and mode(token) == 0o600 and open(token, 'rb').read() == b'synthetic pickle')
check('the shared vector DB was left alone (nothing copied)', os.path.isfile(os.path.join(HOME, '.jacarium', 'vector_db', 'marker')) and not os.path.exists(os.path.join(home, '.jacarium', 'vector_db')))

# --- marker / idempotence --------------------------------------------------------------------
marker = os.path.join(HOME, legacy_migration.MARKER_NAME)
check('a marker records what was done (0600)', os.path.isfile(marker) and mode(marker) == 0o600 and len(json.load(open(marker))['copied']) == 5, json.dumps(json.load(open(marker)).get('copied')))
again = legacy_migration.migrate_container_data(home)
check('running the migration again is a no-op', again.get('skipped') == 'already migrated')

# --- a later user inherits only the server defaults -------------------------------------------
r = admin.post('/api/admin/users', json={'username': 'later', 'password': 'later password 1'}, headers=HDR, base_url=BASE)
later_home = user_home_for(body(r)['user']['id'])
check("a later user's home has none of the adopted files", not os.path.exists(os.path.join(later_home, '.task')) and not os.path.exists(os.path.join(later_home, '.ssh')) and not os.path.exists(os.path.join(later_home, '.taskrc')))

# --- an empty volume --------------------------------------------------------------------
EMPTY = os.path.join(TMP, 'empty')
os.makedirs(EMPTY)
rep = legacy_migration.migrate_container_data(os.path.join(EMPTY, 'users', 'x'), server=EMPTY)
check('an empty data volume: nothing copied, every step skipped, no errors', rep['copied'] == [] and len(rep['skipped']) == 5 and rep['errors'] == [], json.dumps(rep)[:200])

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
