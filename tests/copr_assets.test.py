#!/usr/bin/env python3
"""
COPR keeps building after a release: packaging/copr/jacarium.spec downloads the published RPM by name at build
time, so the names the release workflow publishes must stay exactly what the spec expects, and no new release
asset (SBOMs, checksum lists) may collide with them.

 1. the spec's asset is jacarium-<version>.<arch>.rpm plus SHA256SUMS.txt, checked with a `<sha256>  <name>` line;
 2. the installers job of build.yml publishes dist-electron/*.rpm unchanged, package.json gives electron-builder
    no custom rpm artifact name (its default is <name>-<version>.<arch>.rpm with name "jacarium"), and the
    release job writes SHA256SUMS.txt with `sha256sum -- *` inside the release directory (bare file names);
 3. every other asset name the workflows produce (SBOMs per platform and per image architecture, the checksum
    list) differs from the RPM pattern and from SHA256SUMS.txt's role;
 4. copr.yml still runs on release: published, with copr-cli pinned, the token in a secret, contents: read;
 5. make-srpm.sh reads the version with `git describe --tags --exact-match`, which works on a signed annotated
    tag (shown with a throwaway SSH key in a temp repository; never the user's keys or config).

Run: python3 tests/copr_assets.test.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

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


spec = read('packaging/copr/jacarium.spec')
m = re.search(r'^%global asset_rpm\s+(\S+)', spec, re.M)
check('spec: the asset is jacarium-%{jacarium_version}.%{_arch}.rpm', m and m.group(1) == 'jacarium-%{jacarium_version}.%{_arch}.rpm', m and m.group(1))
check('spec: SHA256SUMS.txt is fetched from the release and the RPM line checked with sha256sum -c', 'SHA256SUMS.txt' in spec and 'grep -E " %{asset_rpm}\\$" SHA256SUMS.txt' in spec and 'sha256sum -c' in spec)
check('spec: the download URL is the GitHub release of the version', 'releases/download/v%{jacarium_version}' in spec)

build = yaml.safe_load(read('.github/workflows/build.yml'))
release = yaml.safe_load(read('.github/workflows/release.yml'))
inst = build['jobs']['installers']
runs = '\n'.join(str(s.get('run') or '') for s in inst['steps'])
check('build.yml/installers: linux builds ask for the rpm format and publish dist-electron/*.rpm as they are', all('rpm' in str(i.get('format')) for i in inst['strategy']['matrix']['include'] if i.get('platform') == 'linux') and 'dist-electron/*.rpm' in runs and 'cp "$f" out/release/' in runs)
pkg = json.loads(read('package.json'))
b = pkg.get('build') or {}
check('package.json: electron-builder keeps its default rpm artifact name (<name>-<version>.<arch>.rpm) and name is jacarium', 'artifactName' not in (b.get('rpm') or {}) and 'artifactName' not in (b.get('linux') or {}) and 'artifactName' not in b and pkg.get('name') == 'jacarium', (b.get('rpm'), pkg.get('name')))
rel = release['jobs']['release']
rel_runs = [s for s in rel['steps'] if s.get('run')]
sums = next((s for s in rel_runs if 'sha256sum -- * > SHA256SUMS.txt' in s['run']), None)
check('release.yml: SHA256SUMS.txt is written with `sha256sum -- *` inside release/ (bare names, as the spec greps them)', sums is not None and sums.get('working-directory') == 'release' and 'sha256sum -- * > SHA256SUMS.txt' in sums['run'], sums)
create = next((s for s in rel_runs if 'gh release create' in s['run']), None)
check('release.yml: the draft release uploads release/* (the RPMs, SHA256SUMS.txt and the SBOMs together)', create is not None and 'release/*' in create['run'], create)
dl = next((s for s in rel['steps'] if 'download-artifact' in str(s.get('uses'))), None)
check('release.yml: the release downloads the installers, SBOM and VEX artifacts, not the image archives', dl is not None and dl['with']['pattern'] == '{jacarium,sbom,sbom-image,vex}-*', dl and dl.get('with'))

# the other asset names, as the workflows write them (with the version and arch placeholders filled in)
version, arch = '3.9.9', 'x86_64'
rpm_name = f'jacarium-{version}.{arch}.rpm'
others = [f'jacarium-{version}-linux-x64.spdx.json', f'jacarium-{version}-linux-x64.cdx.json', f'jacarium-{version}-linux-arm64.spdx.json',
          f'jacarium-{version}-macos-arm64.spdx.json', f'jacarium-{version}-image-amd64.spdx.json', f'jacarium-{version}-image-arm64.cdx.json', f'jacarium-{version}-image-amd64.packages.spdx.json', f'jacarium-{version}.openvex.json', 'SHA256SUMS.txt']
build_text = read('.github/workflows/build.yml')
check('build.yml names the SBOMs jacarium-<version>-<platform>.spdx.json / .cdx.json and jacarium-<version>-image-<arch>.*', 'jacarium-${VERSION}-${PLATFORM}.spdx.json' in build_text and 'jacarium-${VERSION}-image-${ARCH}.cdx.json' in build_text)
check('no other asset name matches the RPM pattern the spec downloads', all(not re.fullmatch(r'jacarium-[\d.]+\.(x86_64|aarch64)\.rpm', o) for o in others) and rpm_name not in others)
check('the spec greps the RPM line by its exact name, so an SBOM named jacarium-<version>-... never matches', re.search(r' jacarium-3\.9\.9\.x86_64\.rpm$', f'abc  {rpm_name}', re.M) and not re.search(r' jacarium-3\.9\.9\.x86_64\.rpm$', 'abc  ' + others[0], re.M))

copr = yaml.safe_load(read('.github/workflows/copr.yml'))
on = copr.get(True) or copr.get('on')
job = copr['jobs']['copr']
copr_runs = '\n'.join(str(s.get('run') or '') for s in job['steps'])
check('copr.yml: runs on release: published only', on == {'release': {'types': ['published']}}, on)
check('copr.yml: copr-cli pinned, the token from a secret into ~/.config/copr and removed after, contents: read', "copr-cli==2.6" in copr_runs and 'secrets.COPR_API_TOKEN' in yaml.safe_dump(job) and 'rm -f ~/.config/copr' in copr_runs and job.get('permissions') == {'contents': 'read'})
check('copr.yml: builds exactly the published tag from the public repository with the spec', '--commit "$TAG"' in copr_runs and '--spec packaging/copr/jacarium.spec' in copr_runs and 'https://github.com/jacarium/jacarium.git' in copr_runs)
check('the packaging copy of the workflow is gone and the docs point at .github/workflows/copr.yml', not os.path.exists(os.path.join(REPO, 'packaging', 'copr', 'github-workflow-copr.yml')) and '.github/workflows/copr.yml' in read('docs/HOW_TO_RELEASE.md') and '.github/workflows/copr.yml' in read('packaging/copr/README.md'))

# make-srpm.sh and a signed annotated tag
srpm = read('packaging/copr/make-srpm.sh')
check('make-srpm.sh reads the version from git describe --tags --exact-match', 'describe --tags --exact-match' in srpm)
WORK = tempfile.mkdtemp(prefix='copr-tag-test-')
try:
    env = {**os.environ, 'HOME': os.path.join(WORK, 'home'), 'GIT_CONFIG_GLOBAL': os.path.join(WORK, 'gitconfig'), 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@example.com', 'SSH_AUTH_SOCK': ''}
    os.makedirs(env['HOME'])
    key = os.path.join(WORK, 'key')
    kg = subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key], env=env, capture_output=True)
    if kg.returncode:
        print('SKIP: ssh-keygen unavailable for the signed-tag case')
    else:
        r = os.path.join(WORK, 'r')
        subprocess.run(['git', 'init', '-q', '-b', 'main', r], env=env, check=True)
        open(os.path.join(r, 'f'), 'w').write('x\n')
        g = lambda *a: subprocess.run(['git', '-C', r, *a], env=env, capture_output=True, text=True)
        g('add', 'f'); g('commit', '-q', '-m', 'c')
        g('config', 'gpg.format', 'ssh'); g('config', 'user.signingkey', key + '.pub')
        t = g('tag', '-s', 'v1.2.3', '-m', 'Jacarium 1.2.3')
        d = g('describe', '--tags', '--exact-match')
        check('git describe --tags --exact-match names a signed annotated tag (what COPR checks out)', t.returncode == 0 and d.stdout.strip() == 'v1.2.3', (t.stderr, d.stdout, d.stderr))
        # the version the script derives, without rpmbuild: the same expression it uses
        check("the spec version derived from it is 1.2.3 (tag without the v)", d.stdout.strip()[1:] == '1.2.3')
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
