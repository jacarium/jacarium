#!/usr/bin/env python3
"""
Guards the desktop profile home in the backend (backend/user_context.py:
JACARIUM_PROFILE_HOME, app-token mode).

A named desktop profile (electron/profiles.cjs) runs its backend with
JACARIUM_PROFILE_HOME=<profile>/backend, and everything that used
to live under the real home - the Taskwarrior paths, the RAG index, the
Google Calendar token - lives there instead; the settings file and
known_hosts come through their own variables. The default profile sets
nothing and keeps the real home: today's behaviour, unchanged.

What this test proves (two child interpreters, app-token mode, a
throwaway HOME and profile home, synthetic values):
  - with the variable: ~/.task, ~/.taskrc, the vector DB directory, the
    calendar token and the settings file resolve under the profile home,
    while reports still default to the real home's Downloads (desktop:
    unrestricted) and task paths stay unrestricted;
  - without it: every path resolves under the real home exactly as before;
  - the variable is ignored in the browser modes (none / accounts never
    see a desktop profile).

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/profile_home_backend.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-profile-home-')
HOME = os.path.join(TMP, 'home')
PROFILE = os.path.join(TMP, 'profile', 'backend')
os.makedirs(HOME)
os.makedirs(PROFILE)

PROBE = r'''
import json, os, sys
sys.path.insert(0, %r); os.chdir(%r)
from user_context import expand_user_path, user_home
import task_paths, settings_store, google_calendar, extensions
print(json.dumps({
    "home": user_home(),
    "task": expand_user_path("~/.task"),
    "taskrc": task_paths.default_rc_path(),
    "task_root": task_paths.task_root(),
    "data_path": task_paths.resolve_data_path("~/anywhere") if task_paths.task_root() is None else None,
    "vector": extensions.vector_db_path(),
    "gcal": google_calendar.token_file(),
    "env_file": settings_store.env_file_path(),
    "reports_default": __import__("reports_root").default_directory(),
}))
''' % (BACKEND, BACKEND)

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def probe(extra_env):
    env = {k: v for k, v in os.environ.items() if not k.startswith('JACARIUM_')}
    env.update({'HOME': HOME, 'APP_AUTH_TOKEN': 'synthetic'})
    env.update(extra_env)
    out = subprocess.run([sys.executable, '-c', PROBE], env=env, capture_output=True, text=True, timeout=180)
    lines = [l for l in out.stdout.splitlines() if l.startswith('{')]
    if not lines:
        print(out.stdout[-500:], out.stderr[-800:])
        return {}
    return json.loads(lines[-1])


named = probe({'JACARIUM_PROFILE_HOME': PROFILE, 'JACARIUM_ENV_FILE': os.path.join(PROFILE, '.jacarium.env'),
               'JACARIUM_KNOWN_HOSTS': os.path.join(PROFILE, '.ssh', 'known_hosts')})
real = os.path.realpath
check('named profile: ~ is the profile home', named.get('home') == PROFILE, str(named.get('home')))
check('named profile: ~/.task and ~/.taskrc live under it', named.get('task') == os.path.join(PROFILE, '.task') and named.get('taskrc') == real(os.path.join(PROFILE, '.taskrc')), f"{named.get('task')} {named.get('taskrc')}")
check('named profile: task paths stay unrestricted (desktop)', named.get('task_root') is None and named.get('data_path') == os.path.join(PROFILE, 'anywhere'))
check('named profile: the RAG index and the calendar token live under it', named.get('vector') == os.path.join(PROFILE, '.jacarium', 'vector_db') and named.get('gcal') == os.path.join(PROFILE, '.jacarium-gcal-token.pickle'))
check('named profile: the settings file is the profile\'s', named.get('env_file') == os.path.join(PROFILE, '.jacarium.env'))
check('named profile: reports still default to Downloads (unrestricted desktop)', named.get('reports_default') == 'Downloads')

default = probe({})
check('default profile: ~ is the real home', default.get('home') == HOME)
check('default profile: every path is under the real home, as before',
      default.get('task') == os.path.join(HOME, '.task') and default.get('vector') == os.path.join(HOME, '.jacarium', 'vector_db')
      and default.get('gcal') == os.path.join(HOME, '.jacarium-gcal-token.pickle') and default.get('env_file') == os.path.join(HOME, '.jacarium.env'))

none_mode = probe({'JACARIUM_PROFILE_HOME': PROFILE, 'JACARIUM_AUTH_MODE': 'none', 'JACARIUM_REPORTS_ROOT': os.path.join(HOME, 'reports')})
check('the variable is ignored outside the desktop (none mode keeps the server home)', none_mode.get('home') == HOME and none_mode.get('task') == os.path.join(HOME, '.task'))

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
