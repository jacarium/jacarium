#!/usr/bin/env python3
"""
The Python the installers bundle is the one the release workflow pins, and the build proves it:

 1. build.yml pins an exact CPython (PYTHON_VERSION, X.Y.Z - a range such as '3.14' takes whichever 3.14.x the
    runner image carries in its tool cache: the 4.0.1 Linux installers shipped 3.14.9 with CVE-2026-115557 while
    the macOS runner downloaded 3.14.10), actions/setup-python installs that pin in the one installers job that
    every platform runs, and a step after the build compares the frozen backend's own version with the pin;
    the pin's minor is the one requirements.lock is resolved for;
 2. backend/app_standalone.py answers `--runtime-version` with platform.python_version() before importing the
    app (so the frozen binary prints it without starting anything), and rebuild.sh checks the frozen backend
    against the venv it was built from;
 3. the entry point does what it says: run under the backend venv it prints that interpreter's version and
    nothing else; a frozen backend on disk (backend/dist/flask-backend/flask-backend, when rebuild.sh has run
    here) prints a version with the pin's minor - and the pin itself when this runs in the release workflow.

Run: backend/venv/bin/python tests/bundled_python_version.test.py   (PyYAML from the backend venv)
"""
import os
import platform
import re
import subprocess
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:400]) if info and not ok else ''}")
    if not ok:
        failed += 1


def read(rel):
    with open(os.path.join(REPO, rel), encoding='utf-8') as fh:
        return fh.read()


# ---------------------------------------------------------------- 1. the workflow's pin and its check
build_text = read('.github/workflows/build.yml')
build = yaml.safe_load(build_text)
installers = build['jobs']['installers']
pin = str((installers.get('env') or {}).get('PYTHON_VERSION', ''))
check('build.yml: the installers job pins PYTHON_VERSION to an exact X.Y.Z', re.fullmatch(r'\d+\.\d+\.\d+', pin) is not None, pin)
check('build.yml: the pin is at least 3.14.10 (CVE-2026-115557 is fixed there)', tuple(int(x) for x in pin.split('.')) >= (3, 14, 10) if re.fullmatch(r'\d+\.\d+\.\d+', pin) else False, pin)
setup_steps = [s for s in installers['steps'] if str(s.get('uses', '')).startswith('actions/setup-python@')]
check('build.yml: exactly one actions/setup-python step, python-version taken from the pin (no range)',
      len(setup_steps) == 1 and setup_steps[0].get('with', {}).get('python-version') == '${{ env.PYTHON_VERSION }}', setup_steps)
check('build.yml: one installers job runs every platform (linux-x64, linux-arm64, macos-arm64) with that step - no job pins another Python',
      sorted(m['name'] for m in installers['strategy']['matrix']['include']) == ['linux-arm64', 'linux-x64', 'macos-arm64']
      and all('setup-python' not in str(j) for n, j in build['jobs'].items() if n != 'installers'))
names = [s.get('name', '') for s in installers['steps']]
check_steps = [s for s in installers['steps'] if 'flask-backend --runtime-version' in str(s.get('run', ''))]
check('build.yml: after Build, a step runs the frozen backend with --runtime-version and fails on a version other than the pin',
      len(check_steps) == 1 and names.index(check_steps[0]['name']) > names.index('Build')
      and '"$got" != "$PYTHON_VERSION"' in check_steps[0]['run'] and 'exit 1' in check_steps[0]['run'], check_steps)
lock_minor = re.search(r'(\d+\.\d+)', read('backend/lock-requirements.sh').split('for Python ')[1]).group(1)
check('the pin is on the minor requirements.lock is resolved for', pin.startswith(lock_minor + '.'), (pin, lock_minor))

# ---------------------------------------------------------------- 2. the entry point and rebuild.sh
entry = read('backend/app_standalone.py')
check('app_standalone.py: --runtime-version prints platform.python_version() and exits before the app import',
      entry.index("sys.argv[1] == '--runtime-version'") < entry.index('from app import') and 'print(platform.python_version())' in entry and 'sys.exit(0)' in entry)
rebuild = read('rebuild.sh')
check('rebuild.sh: the frozen backend is run with --runtime-version after the PyInstaller build and compared with the venv Python',
      'dist/flask-backend/flask-backend --runtime-version' in rebuild and 'platform.python_version()' in rebuild
      and rebuild.index('--runtime-version') > rebuild.index('PyInstaller flask-backend.spec') and 'the frozen backend carries Python' in rebuild)

# ---------------------------------------------------------------- 3. it runs
r = subprocess.run([sys.executable, os.path.join(REPO, 'backend', 'app_standalone.py'), '--runtime-version'], capture_output=True, text=True, timeout=60)
check('run under this interpreter, app_standalone.py --runtime-version prints exactly its version', r.returncode == 0 and r.stdout.strip() == platform.python_version() and r.stderr == '', (r.returncode, r.stdout, r.stderr[-300:]))
frozen = os.path.join(REPO, 'backend', 'dist', 'flask-backend', 'flask-backend')
entry_path = os.path.join(REPO, 'backend', 'app_standalone.py')
if os.path.exists(frozen) and os.path.getmtime(frozen) < os.path.getmtime(entry_path):
    # built from an app_standalone.py older than this one (it may not know --runtime-version: it would start the server)
    print('SKIP: the frozen backend at backend/dist/flask-backend predates backend/app_standalone.py (run ./rebuild.sh --no-container to rebuild it)')
elif os.path.exists(frozen):
    f = subprocess.run([frozen, '--runtime-version'], capture_output=True, text=True, timeout=120)
    got = f.stdout.strip()
    check('the frozen backend on disk prints a Python version of the pinned minor', f.returncode == 0 and re.fullmatch(r'\d+\.\d+\.\d+', got) is not None and got.startswith(pin.rsplit('.', 1)[0] + '.'), (f.returncode, got, f.stderr[-300:]))
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        check('in the release workflow the frozen backend carries exactly the pin', got == pin, (got, pin))
else:
    print('SKIP: no frozen backend at backend/dist/flask-backend (run ./rebuild.sh --no-container to build one)')

print(f"\n{'OK' if failed == 0 else f'{failed} FAILED'}")
sys.exit(1 if failed else 0)
