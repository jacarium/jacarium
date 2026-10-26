#!/usr/bin/env python3
"""
Every image build names its platform, and the built image's architecture is checked before it is used.

The incident: an emulated `podman build --platform linux/amd64` left amd64 copies of the digest-pinned base
images in the local store; the next build without --platform resolved the pinned FROMs to those copies and
produced an amd64 image for the arm64 home server (exec format error at deploy; the health check rolled it
back). So:

 1. static: every `podman build` / `docker build` / `$CONTAINER_RUNTIME build` and every `podman pull` in
    deploy/, scripts/, rebuild.sh, tests/ and .github/workflows/ carries --platform (comments excluded);
 2. static: the deploy scripts check the built image's architecture against the target before deploying
    (deploy-podman.sh and rebuild.sh through scripts/lib.sh's check_image_arch, deploy-to-host.sh against the
    target's T_IMGARCH before anything is sent, build.yml and reproducible.yml against the runner's), and the
    container test checks its own build;
 3. unit: scripts/lib.sh's image_platform_for_arch maps x86_64 / amd64 / aarch64 / arm64 and refuses the rest,
    and check_image_arch passes on a matching architecture and fails loudly on a mismatch - run with a stubbed
    podman in a temp directory, nothing real.

Run: python3 tests/build_platform.test.py
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

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


# ---------------------------------------------------------------- 1. every build / pull names its platform
files = sorted(set(glob.glob(os.path.join(REPO, 'deploy', '*.sh')) + glob.glob(os.path.join(REPO, 'scripts', '*.sh')) + glob.glob(os.path.join(REPO, 'scripts', '*.cjs'))
                   + [os.path.join(REPO, 'rebuild.sh')] + glob.glob(os.path.join(REPO, 'tests', '*.mjs')) + [p for p in glob.glob(os.path.join(REPO, 'tests', 'helpers', '*')) if os.path.isfile(p)]
                   + glob.glob(os.path.join(REPO, '.github', 'workflows', '*.yml'))))
BUILD = re.compile(r'(podman|docker|\$CONTAINER_RUNTIME|"\$CONTAINER_RUNTIME"|\$\{CONTAINER_RUNTIME\})\s+(build|pull)\b')
COMMENT = re.compile(r'^\s*(#|//|\*|\'|`|-\s+`|\\`)')
offenders, found = [], 0
for f in files:
    rel = os.path.relpath(f, REPO)
    if rel == 'tests/build_platform.test.py':
        continue
    for lineno, line in enumerate(read(rel).splitlines(), 1):
        if not BUILD.search(line) or COMMENT.match(line) or 'echo ' in line or 'log_' in line or 'check(' in line or 'console.log' in line or '.includes(' in line or 're.compile' in line or 'description' in line:
            continue
        found += 1
        # a build written as an argument list (the container test's spawnSync) names the flag as a string
        if '--platform' not in line and "'--platform'" not in line and '"--platform"' not in line:
            offenders.append(f'{rel}:{lineno}: {line.strip()[:100]}')
check(f'every image build / pull in deploy, scripts, rebuild.sh, tests and the workflows names --platform ({found} sites: deploy-podman.sh, deploy-to-host.sh, rebuild.sh, build.yml, reproducible.yml)', found >= 5 and not offenders, offenders)

# ---------------------------------------------------------------- 2. the architecture checks
lib = read('scripts/lib.sh')
check('scripts/lib.sh: image_platform_for_arch, host_image_platform and check_image_arch exist and the check reads the image back', all(f in lib for f in ('image_platform_for_arch()', 'host_image_platform()', 'check_image_arch()')) and "image inspect --format '{{.Architecture}}'" in lib)
dp = read('deploy/deploy-podman.sh')
check('deploy-podman.sh builds with --platform "$(host_image_platform)" and checks the image with check_image_arch before running it', 'podman build --platform "$platform"' in dp and 'platform="$(host_image_platform)"' in dp and 'check_image_arch podman "$IMAGE_NAME" "$platform" || exit 1' in dp and dp.index('check_image_arch podman') < dp.index('podman run "${args[@]}"'))
dh = read('deploy/deploy-to-host.sh')
check("deploy-to-host.sh always passes the target's platform (not only when the architectures differ) and keeps the cross-build fallback on its own flag", 'podman build --platform "$T_PLATFORM" --format docker' in dh and 'CROSS_BUILD=yes' in dh and '[ "$CROSS_BUILD" = yes ]' in dh and 'PLATFORM_ARGS' not in dh)
check("deploy-to-host.sh checks the built image's architecture against the target's before anything is sent", 'BUILT_ARCH="$(podman image inspect --format \'{{.Architecture}}\' "localhost/jacarium:$TAG"' in dh and '[ "$BUILT_ARCH" != "$T_IMGARCH" ]' in dh and dh.index('BUILT_ARCH=') < dh.index('applying on $TARGET'))
rb = read('rebuild.sh')
check('rebuild.sh builds its builder image with --platform "$(host_image_platform)" and checks it', 'build --platform "$(host_image_platform)"' in rb and 'check_image_arch "$CONTAINER_RUNTIME" "$IMAGE_NAME"' in rb)
wf = read('.github/workflows/build.yml')
check('build.yml: the image job builds with --platform "linux/${ARCH}" and still checks the architecture', 'podman build --platform "linux/${ARCH}"' in wf and "podman image inspect --format '{{.Architecture}}' \"$image\"" in wf)
rp = read('.github/workflows/reproducible.yml')
check('reproducible.yml: --platform from the runner and an architecture check per build', 'podman build --platform "$platform"' in rp and '[ "$got" = "${platform#linux/}" ]' in rp)
ct = read('tests/container-deploy.test.mjs')
check("the container test builds with --platform for this machine and checks the image's architecture", "'--platform', PLATFORM" in ct and "{{.Architecture}}" in ct)

# ---------------------------------------------------------------- 3. the helpers, with a stubbed podman
WORK = tempfile.mkdtemp(prefix='build-platform-test-')
try:
    stub = os.path.join(WORK, 'bin')
    os.makedirs(stub)
    with open(os.path.join(stub, 'podman'), 'w', encoding='utf-8') as fh:
        fh.write('#!/bin/bash\n# a stub: "image inspect --format {{.Architecture}} <image>" answers $STUB_ARCH (empty = unreadable image)\ncase "$*" in *"image inspect"*) [ -n "${STUB_ARCH-}" ] || exit 125; printf "%s\\n" "$STUB_ARCH" ;; *) exit 1 ;; esac\n')
    os.chmod(os.path.join(stub, 'podman'), 0o755)
    env = {**os.environ, 'PATH': stub + os.pathsep + os.environ.get('PATH', '')}

    def sh(script, **extra):
        return subprocess.run(['bash', '-c', f'. "{REPO}/scripts/lib.sh"; {script}'], env={**env, **extra}, capture_output=True, text=True)

    r = sh('image_platform_for_arch x86_64; image_platform_for_arch amd64; image_platform_for_arch aarch64; image_platform_for_arch arm64')
    check('image_platform_for_arch maps x86_64 / amd64 to linux/amd64 and aarch64 / arm64 to linux/arm64', r.stdout.split() == ['linux/amd64', 'linux/amd64', 'linux/arm64', 'linux/arm64'], r.stdout)
    r = sh('image_platform_for_arch riscv64')
    check('an unknown machine architecture is refused', r.returncode != 0 and r.stdout.strip() == '', (r.returncode, r.stdout))
    r = sh('host_image_platform')
    check("host_image_platform answers this machine's platform", r.returncode == 0 and r.stdout.strip() in ('linux/amd64', 'linux/arm64'), r.stdout)
    r = sh('check_image_arch podman localhost/x:1 linux/arm64', STUB_ARCH='arm64')
    check('check_image_arch passes when the image is the asked-for architecture', r.returncode == 0 and r.stderr.strip() == '', (r.returncode, r.stderr))
    r = sh('check_image_arch podman localhost/x:1 linux/arm64', STUB_ARCH='amd64')
    check('check_image_arch fails loudly on a mismatch, naming both architectures and the cause', r.returncode != 0 and 'amd64' in r.stderr and 'not arm64' in r.stderr and '--platform linux/arm64' in r.stderr, (r.returncode, r.stderr))
    r = sh('check_image_arch podman localhost/missing:1 linux/arm64', STUB_ARCH='')
    check('check_image_arch fails when the image cannot be read', r.returncode != 0, r.returncode)
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
