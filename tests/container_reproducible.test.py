#!/usr/bin/env python3
"""
The pieces that make the container image build reproducibly (docs/security/reproducible-builds.md) stay in
place: deploy/Containerfile installs the Python packages without compiling and then writes hash-based
bytecode (unchecked-hash), removes microdnf's cache and the dnf logs and history after its one microdnf install; every build passes
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
pip_runs = [m for m in re.findall(r'RUN w="\$\(ls /usr/share/python3\.14-wheels/pip-\*\.whl\)"(?:[^\n]*\\\n)*[^\n]*', cf)]
check('Containerfile: pip itself (from the base RPM\'s wheel, run in place) and the application packages are installed with --no-compile and every site-packages directory is then compiled, forced, to unchecked-hash bytecode', any(r.count('--no-compile') == 2 and 'python "$w/pip" install' in r and '-c /app/backend/requirements.lock' in r and 'compileall -q -f --invalidation-mode unchecked-hash /opt/app-root/lib/python3.14/site-packages /opt/app-root/lib64/python3.14/site-packages' in r for r in pip_runs), pip_runs)
check('Containerfile: pip itself is pinned to an exact version, never "the newest at build time"', any(re.search(r"install --no-cache-dir --no-compile 'pip==\d+\.\d+(\.\d+)?'", r) for r in pip_runs), pip_runs)
check('Containerfile: the venv is made without pip (the wheel bootstraps the pinned one in the pip layer, with bytecode written only by the compileall step)', 'python3.14 -m venv --without-pip /opt/app-root' in cf)
dnf_runs = [m for m in re.findall(r'RUN microdnf -y --setopt=install_weak_deps=0 --nodocs install(?:[^\n]*\\\n)*[^\n]*', cf)]
runtime_dnf = [r for r in dnf_runs if 'openssh-clients' in r]
check('Containerfile: the runtime microdnf install removes its cache, the dnf logs and history, the rhsm log, the countme cookies and ldconfig\'s aux-cache (the rpm database is what remains)', runtime_dnf and all('/var/cache/yum' in r and '/var/cache/ldconfig/aux-cache' in r and '/var/log/dnf*' in r and '/var/log/hawkey.log' in r and '/var/lib/dnf/history.sqlite*' in r and '/var/log/rhsm' in r and '/var/lib/dnf/repos/*/countme' in r and 'microdnf clean all' in r for r in runtime_dnf), runtime_dnf)
check('Containerfile: no blanket update at build time - the one package raised past the pinned base is xz-libs (the security exception), named explicitly', 'dnf -y update' not in cf and 'dnf -y upgrade' not in cf and 'microdnf -y update' not in cf and all(re.fullmatch(r'microdnf -y --setopt=install_weak_deps=0 --nodocs upgrade xz-libs', m.strip()) for m in re.findall(r'microdnf -y [^\n\\]*upgrade[^\n\\]*', cf)) and 'upgrade xz-libs' in cf)
check("Containerfile: the runtime stage checks that the packages the ubi9-minimal base was chosen to be rid of (Python 3.9, python3-urllib3, brotli, dnf, Node.js RPMs) are absent, and runs the Node copied from the UI stage", runtime_dnf and all("rpm -q python3 python3-libs python3-urllib3 python3-pip libbrotli brotli brotli-devel dnf nodejs npm 2>&1 | grep -vc 'is not installed'" in r for r in runtime_dnf) and 'COPY --from=ui /usr/local/bin/node /usr/local/bin/node' in cf)
check('Containerfile: every stage that is not the official node / golang image is ubi9-minimal pinned by digest, the same digest in both', len(set(re.findall(r'^FROM (registry\.access\.redhat\.com/ubi9-minimal:\S+@sha256:[0-9a-f]{64})', cf, re.M))) == 1 and len(re.findall(r'^FROM registry\.access\.redhat\.com/ubi9-minimal:', cf, re.M)) == 2 and 'ubi9/python-314' not in re.sub(r'#[^\n]*', '', cf))
caddy_stage = re.search(r'FROM docker\.io/library/golang:(\S+)@sha256:[0-9a-f]{64} AS caddy(.*?)\nFROM ', cf, re.S)
check('Containerfile: Caddy is built from source on the official golang image pinned by digest, static, trimmed, VCS-free, with x/net raised, and checked with caddy version / build-info', caddy_stage is not None and 'CGO_ENABLED=0' in caddy_stage.group(2) and 'go get "github.com/caddyserver/caddy/v2@${CADDY_VERSION}"' in caddy_stage.group(2) and 'go get "golang.org/x/net@${XNET_VERSION}"' in caddy_stage.group(2) and '-trimpath -buildvcs=false' in caddy_stage.group(2) and 'caddy build-info' in caddy_stage.group(2) and 'COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy' in cf, caddy_stage and caddy_stage.group(1))
check('Containerfile: no published Caddy image is used any more', 'docker.io/library/caddy:' not in cf)
dp = read('deploy/deploy-podman.sh')
check('deploy-podman.sh builds with --timestamp from the commit time', re.search(r'podman build --platform "\$platform" --format docker --timestamp "\$epoch"', dp) is not None and 'log -1 --format=%ct' in dp)
wf = read('.github/workflows/build.yml')
check("build.yml's image job builds with --timestamp from the commit time", '--timestamp "$(git log -1 --format=%ct)"' in wf)
rp = read('.github/workflows/reproducible.yml')
check('reproducible.yml builds twice with --no-cache and --timestamp and compares the layers', rp.count('podman build') >= 1 and '--no-cache' in rp and '--timestamp "$epoch"' in rp and 'RootFS' in rp)
doc = read('docs/security/reproducible-builds.md')
check('the documentation names the measured results and the remaining microdnf layer', 'rpm database' in doc and '--timestamp' in doc and 'unchecked-hash' in doc and 'not reproducible' in doc.lower() and 'microdnf' in doc)
sec = read('SECURITY.md')
check('SECURITY.md points at the reproducible-builds note', 'reproducible-builds.md' in sec)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
