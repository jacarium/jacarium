#!/usr/bin/env python3
"""
The pieces that make the container image build reproducibly (docs/security/reproducible-builds.md) stay in
place: deploy/Containerfile installs the Python packages without compiling and then writes hash-based
bytecode (unchecked-hash), removes the dnf logs and history after its one dnf install; every build passes
--timestamp with the commit's time (deploy/deploy-podman.sh, the image job of .github/workflows/build.yml, the
reproducible.yml check); the documentation names the one layer that still differs. Static: no image is built here.

Run: python3 tests/container_reproducible.test.py
"""
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:300]) if info and not ok else ''}")
    if not ok:
        failed += 1


def read(rel):
    with open(os.path.join(REPO, rel), encoding='utf-8') as fh:
        return fh.read()


cf = read('deploy/Containerfile')
pip_runs = [m for m in re.findall(r'RUN pip install(?:[^\n]*\\\n)*[^\n]*', cf)]
check('Containerfile: pip itself and the application packages are installed with --no-compile and every site-packages directory is then compiled, forced, to unchecked-hash bytecode', any(r.count('--no-compile') == 2 and '-c /app/backend/requirements.lock' in r and 'compileall -q -f --invalidation-mode unchecked-hash /opt/app-root/lib/python3.14/site-packages /opt/app-root/lib64/python3.14/site-packages' in r for r in pip_runs), pip_runs)
check('Containerfile: pip itself is pinned to an exact version, never "the newest at build time"', any(re.search(r"--upgrade 'pip==\d+\.\d+(\.\d+)?'", r) for r in pip_runs), pip_runs)
dnf_runs = [m for m in re.findall(r'RUN dnf -y install(?:[^\n]*\\\n)*[^\n]*', cf)]
runtime_dnf = [r for r in dnf_runs if 'openssh-clients' in r]
check('Containerfile: the runtime dnf install removes the dnf logs and history, the rhsm log and the countme cookies (the rpm database is what remains)', runtime_dnf and all('/var/log/dnf*' in r and '/var/log/hawkey.log' in r and '/var/lib/dnf/history.sqlite*' in r and '/var/log/rhsm' in r and '/var/lib/dnf/repos/*/countme' in r for r in runtime_dnf), runtime_dnf)
check('Containerfile: no dnf update at build time (the image stays what the pinned base plus the three packages are)', 'dnf -y update' not in cf and 'dnf -y upgrade' not in cf)
dp = read('deploy/deploy-podman.sh')
check('deploy-podman.sh builds with --timestamp from the commit time', re.search(r'podman build --format docker --timestamp "\$epoch"', dp) is not None and 'log -1 --format=%ct' in dp)
wf = read('.github/workflows/build.yml')
check("build.yml's image job builds with --timestamp from the commit time", '--timestamp "$(git log -1 --format=%ct)"' in wf)
rp = read('.github/workflows/reproducible.yml')
check('reproducible.yml builds twice with --no-cache and --timestamp and compares the layers', rp.count('podman build') >= 1 and '--no-cache' in rp and '--timestamp "$epoch"' in rp and 'RootFS' in rp)
doc = read('docs/security/reproducible-builds.md')
check('the documentation names the measured results and the remaining dnf layer', 'rpm database' in doc and '--timestamp' in doc and 'unchecked-hash' in doc and 'not reproducible' in doc.lower())
sec = read('SECURITY.md')
check('SECURITY.md points at the reproducible-builds note', 'reproducible-builds.md' in sec)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
