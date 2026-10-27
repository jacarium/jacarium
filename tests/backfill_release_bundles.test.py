#!/usr/bin/env python3
"""
scripts/backfill-release-bundles.sh: the attestation bundles (<file>.intoto.jsonl) attached to releases that
predate release.yml attaching them, against a STUB GitHub CLI (a `gh` shim first on PATH that logs every call,
serves a fixture release and records uploads) - the real GitHub is never reached.

 1. a dry run downloads every attested asset's bundles (not SHA256SUMS.txt), verifies each from disk with
    --bundle, the signer workflow and --deny-self-hosted-runners (the SPDX and VEX predicates on installers),
    prints the names and uploads nothing;
 2. --yes uploads exactly the bundles, one per attested asset, named <asset>.intoto.jsonl, no --clobber;
 3. a release that already has bundle assets is skipped, and replaced with --clobber;
 4. a provenance that does not verify stops the run with nothing uploaded; an installer without a VEX
    attestation (an older release) is reported, not fatal;
 5. --repo reaches every gh call; a bad tag, no tags, a signed-out gh and a missing gh are refused clearly.

Run: python3 tests/backfill_release_bundles.test.py
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, 'scripts', 'backfill-release-bundles.sh')
failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:700]) if info and not ok else ''}")
    if not ok:
        failed += 1


INSTALLERS = ['Jacarium-9.9.9.AppImage', 'Jacarium-9.9.9-arm64.AppImage', 'jacarium_9.9.9_amd64.deb', 'jacarium_9.9.9_arm64.deb',
              'jacarium-9.9.9.x86_64.rpm', 'jacarium-9.9.9.aarch64.rpm', 'Jacarium-9.9.9-arm64.dmg']
OTHERS = ['jacarium-9.9.9-linux-x64.spdx.json', 'jacarium-9.9.9-linux-x64.cdx.json', 'jacarium-9.9.9-image-amd64.packages.spdx.json',
          'jacarium-9.9.9.openvex.json']
ATTESTED = INSTALLERS + OTHERS

SHIM = r'''#!/bin/bash
# a stub GitHub CLI: every call logged to $STUB_LOG; the release's assets are the files of $STUB_ASSETS plus the
# names in $STUB_UPLOADS (what earlier uploads attached); STUB_AUTH_EXIT, STUB_VERIFY_FAIL (a file name whose
# provenance fails) and STUB_NO_VEX=1 (no VEX attestation on anything) shape the answers
printf '%s\n' "$*" >> "$STUB_LOG"
cmd="$1 $2"; shift 2
case "$cmd" in
  "auth status") exit "${STUB_AUTH_EXIT:-0}" ;;
  "release view") ls "$STUB_ASSETS"; [ -f "$STUB_UPLOADS" ] && cat "$STUB_UPLOADS"; exit 0 ;;
  "release download")
    dir=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    cp "$STUB_ASSETS"/* "$dir"/; [ -f "$STUB_UPLOADS" ] && while IFS= read -r u; do echo stale > "$dir/$u"; done < "$STUB_UPLOADS"; exit 0 ;;
  "attestation download")
    f="$1"; d="$(shasum -a 256 "$f" | cut -d ' ' -f 1)"; n=1
    case "$f" in *.AppImage|*.deb|*.rpm|*.dmg) n=3 ;; esac
    : > "sha256:$d.jsonl"; i=0; while [ $i -lt $n ]; do i=$((i + 1)); printf '{"stub":"bundle %s of %s"}\n' "$i" "$(basename "$f")" >> "sha256:$d.jsonl"; done; exit 0 ;;
  "attestation verify")
    f=""; bundle=""; pred=""
    while [ $# -gt 0 ]; do case "$1" in --bundle) bundle="$2"; shift ;; --predicate-type) pred="$2"; shift ;; --repo|--signer-workflow) shift ;; --*) ;; *) f="$1" ;; esac; shift; done
    [ -f "$bundle" ] || { echo "stub: no bundle $bundle" >&2; exit 1; }
    [ "$(basename "$f")" != "${STUB_VERIFY_FAIL:-}" ] || { echo "stub: $f fails" >&2; exit 1; }
    [ "${STUB_NO_VEX:-}" != 1 ] || [ "$pred" != "https://openvex.dev/ns/v0.2.0" ] || exit 1
    exit 0 ;;
  "release upload")
    tag="$1"; shift; clobber=no; names=""
    while [ $# -gt 0 ]; do case "$1" in --repo) shift ;; --clobber) clobber=yes ;; *) names="$names $(basename "$1")" ;; esac; shift; done
    for n in $names; do
      if [ -f "$STUB_UPLOADS" ] && grep -qx "$n" "$STUB_UPLOADS" && [ "$clobber" = no ]; then echo "stub: asset $n exists" >&2; exit 1; fi
      grep -qx "$n" "$STUB_UPLOADS" 2>/dev/null || echo "$n" >> "$STUB_UPLOADS"
    done
    echo "uploaded:$clobber:$tag:$names" >> "$STUB_LOG"; exit 0 ;;
  *) echo "stub: unexpected gh $cmd $*" >&2; exit 99 ;;
esac
'''

WORK = tempfile.mkdtemp(prefix='jacarium-backfill-test-')
try:
    shim_dir = os.path.join(WORK, 'bin'); os.makedirs(shim_dir)
    with open(os.path.join(shim_dir, 'gh'), 'w', encoding='utf-8') as fh:
        fh.write(SHIM)
    os.chmod(os.path.join(shim_dir, 'gh'), stat.S_IRWXU)
    assets = os.path.join(WORK, 'assets'); os.makedirs(assets)
    for i, name in enumerate(ATTESTED + ['SHA256SUMS.txt']):
        with open(os.path.join(assets, name), 'w', encoding='utf-8') as fh:
            fh.write(f'asset {i} {name}\n')
    home = os.path.join(WORK, 'home'); os.makedirs(home)

    def run(*args, env=None, uploads='uploads.txt', log='gh.log', path=None):
        e = {**os.environ, 'HOME': home, 'JACARIUM_RELEASE_ENV': os.path.join(WORK, 'none.env'),
             'PATH': (path if path is not None else shim_dir) + os.pathsep + os.environ.get('PATH', ''),
             'STUB_LOG': os.path.join(WORK, log), 'STUB_ASSETS': assets, 'STUB_UPLOADS': os.path.join(WORK, uploads)}
        e.pop('STUB_VERIFY_FAIL', None); e.pop('STUB_NO_VEX', None); e.pop('STUB_AUTH_EXIT', None)
        if env:
            e.update(env)
        r = subprocess.run(['bash', SCRIPT, *args], cwd=WORK, env=e, capture_output=True, text=True)
        calls = open(e['STUB_LOG'], encoding='utf-8').read().splitlines() if os.path.exists(e['STUB_LOG']) else []
        ups = open(e['STUB_UPLOADS'], encoding='utf-8').read().split() if os.path.exists(e['STUB_UPLOADS']) else []
        return r, calls, ups

    # 1. the dry run
    r, calls, ups = run('v9.9.9', log='dry.log', uploads='dry-up.txt')
    dl = [c for c in calls if c.startswith('attestation download ')]
    ver = [c for c in calls if c.startswith('attestation verify ')]
    check('dry run: exit 0, every attested asset downloaded once from the store, SHA256SUMS.txt left out', r.returncode == 0 and len(dl) == len(ATTESTED) and all(any(c.endswith(f'/{n} --repo jacarium/jacarium') for c in dl) for n in ATTESTED) and not any('SHA256SUMS' in c for c in dl), (r.returncode, r.stderr[-400:], dl[:3]))
    check('every bundle verified from disk: --bundle <asset>.intoto.jsonl, the signer workflow, no self-hosted runners', len(ver) >= len(ATTESTED) and all('--bundle ' in c and '.intoto.jsonl' in c and '--signer-workflow jacarium/jacarium/.github/workflows/build.yml' in c and '--deny-self-hosted-runners' in c for c in ver), ver[:2])
    check('the SPDX and VEX predicates are verified on the 7 installers (and only there)', sum('https://spdx.dev/Document/v2.3' in c for c in ver) == 7 and sum('https://openvex.dev/ns/v0.2.0' in c for c in ver) == 7 and all(any(c.split(' --bundle')[0].endswith(f'/{n}') for n in INSTALLERS) for c in ver if '--predicate-type' in c), [c for c in ver if '--predicate-type' in c][:2])
    check('the dry run uploads nothing and says so, naming the bundles and their checksums', not ups and not any(c.startswith('release upload') for c in calls) and 'dry run' in r.stdout and f'{len(ATTESTED)} bundle(s) would be uploaded to v9.9.9' in r.stdout and 'Jacarium-9.9.9-arm64.dmg.intoto.jsonl' in r.stdout and '3 attestation(s), provenance ok, SBOM ok, VEX ok' in r.stdout, r.stdout[-900:])

    # 2. --yes
    r, calls, ups = run('--yes', 'v9.9.9')
    check('--yes: exit 0, exactly one bundle per attested asset uploaded, named <asset>.intoto.jsonl, without --clobber', r.returncode == 0 and sorted(ups) == sorted(f'{n}.intoto.jsonl' for n in ATTESTED) and any(c.startswith('uploaded:no:v9.9.9:') for c in calls) and '1 release(s) updated' in r.stdout, (r.returncode, r.stderr[-300:], ups))

    # 3. the same release again
    r, calls, ups = run('--yes', 'v9.9.9', log='again.log')
    check('a release that has its bundles is skipped (no download, no upload) unless --clobber', r.returncode == 0 and 'skipped' in (r.stdout + r.stderr) and not any(c.startswith('release download') or c.startswith('release upload') for c in calls), (r.stdout + r.stderr)[-400:])
    r, calls, ups = run('--yes', '--clobber', 'v9.9.9', log='clobber.log')
    check('--clobber replaces them (the upload carries --clobber; the stale bundles in the download are not re-bundled)', r.returncode == 0 and any(c.startswith('uploaded:yes:v9.9.9:') for c in calls) and sum(c.startswith('attestation download') for c in calls) == len(ATTESTED), (r.returncode, r.stderr[-300:]))

    # 4. failures and older releases
    r, calls, ups = run('--yes', 'v9.9.9', env={'STUB_VERIFY_FAIL': 'jacarium_9.9.9_arm64.deb'}, log='fail.log', uploads='fail-up.txt')
    check('a provenance that does not verify stops the run: non-zero, the file named, nothing uploaded', r.returncode != 0 and 'jacarium_9.9.9_arm64.deb does not verify' in r.stderr and not ups, (r.returncode, r.stderr[-300:], ups))
    r, calls, ups = run('v9.9.9', env={'STUB_NO_VEX': '1'}, log='novex.log', uploads='novex-up.txt')
    check('an installer without a VEX attestation (an older release) is reported, the run goes on', r.returncode == 0 and 'no VEX attestation' in r.stdout and 'provenance ok' in r.stdout, (r.returncode, r.stdout[-400:]))

    # 5. arguments and the CLI
    r, calls, ups = run('--repo', 'example/other', 'v9.9.9', log='repo.log', uploads='repo-up.txt')
    check('--repo reaches every gh call (view, download, attestation download / verify, with the signer workflow of that repository)', r.returncode == 0 and all('--repo example/other' in c for c in calls if not c.startswith('auth ')) and any('--signer-workflow example/other/.github/workflows/build.yml' in c for c in calls), [c for c in calls if '--repo example/other' not in c][:3])
    r, calls, ups = run('3.4.0', log='badtag.log')
    check('a tag without the v / not X.Y.Z is refused before any gh call', r.returncode != 0 and 'not a release tag' in r.stderr and not calls, (r.returncode, r.stderr[-200:]))
    r, calls, ups = run(log='notags.log')
    check('no tag: the usage and a refusal', r.returncode != 0 and 'which release' in r.stderr)
    r, calls, ups = run('v9.9.9', env={'STUB_AUTH_EXIT': '1'}, log='auth.log')
    check('a signed-out gh is refused', r.returncode != 0 and 'not signed in' in r.stderr, r.stderr[-200:])
    empty = os.path.join(WORK, 'empty'); os.makedirs(empty, exist_ok=True)
    r, calls, ups = run('v9.9.9', path=empty, env={'PATH': empty + os.pathsep + '/usr/bin:/bin'}, log='nogh.log')
    check('no gh on PATH: a clear message', r.returncode != 0 and 'gh is required' in r.stderr, r.stderr[-200:])
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
