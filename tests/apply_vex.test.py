#!/usr/bin/env python3
"""
.github/scripts/apply-vex.py: the weekly rescan applies the release's VEX to Grype's findings on the SBOMs itself
(grype's --vex needs an image's tags or repo digests, which an SBOM does not carry).

 1. a not_affected statement drops the finding it names - by the id, by an alias (against the finding's id and
    its related ids), for the listed package (purl qualifiers / case ignored) - and a fixed one does too;
 2. it drops nothing else: another package with the same advisory, another advisory on the same package, an
    affected or under_investigation statement, a statement for another version of the package;
 3. the dropped findings are printed and kept under "vexSuppressed"; the SARIF loses exactly those results;
 4. the High / Critical count the workflow takes from the JSON goes down by the dropped ones only.

Run: python3 tests/apply_vex.test.py
"""
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, '.github', 'scripts', 'apply-vex.py')
failed = 0


def check(name, ok, detail=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{' | ' + str(detail)[:300] if detail else ''}")
    if not ok:
        failed += 1


def match(vid, name, version, purl, severity='High', related=()):
    return {'vulnerability': {'id': vid, 'severity': severity},
            'relatedVulnerabilities': [{'id': r} for r in related],
            'artifact': {'name': name, 'version': version, 'purl': purl}}


def statement(name, status, subs=(), aliases=()):
    st = {'vulnerability': {'name': name, 'aliases': list(aliases)}, 'status': status,
          'products': [{'@id': 'pkg:oci/jacarium?tag=9.9.9-arm64', 'subcomponents': [{'@id': s} for s in subs]}]}
    if status == 'not_affected':
        st['justification'] = 'vulnerable_code_not_in_execute_path'
    return st


MATCHES = [
    match('GHSA-3jp2-3mrg-2vxc', 'oauthlib', '4.0.0', 'pkg:pypi/oauthlib@4.0.0'),                        # 0 dropped: id + package
    match('GHSA-3jp2-3mrg-2vxc', 'other', '1.0.0', 'pkg:pypi/other@1.0.0'),                              # 1 kept: another package
    match('GHSA-xxxx-yyyy-zzzz', 'oauthlib', '4.0.0', 'pkg:pypi/oauthlib@4.0.0'),                        # 2 kept: another advisory
    match('GO-2026-6603', 'golang.org/x/net', 'v0.59.0', 'pkg:golang/golang.org/x/net@v0.59.0',
          related=['CVE-2026-1111']),                                                                     # 3 dropped: by alias
    match('CVE-2026-2222', 'libfoo', '1.0', 'pkg:rpm/redhat/libfoo@1.0?arch=aarch64&distro=rhel-9.8'),   # 4 dropped: qualifiers ignored
    match('CVE-2026-3333', 'libbar', '2.0', 'pkg:rpm/redhat/libbar@2.0'),                                # 5 kept: affected
    match('CVE-2026-4444', 'libbaz', '3.0', 'pkg:rpm/redhat/libbaz@3.0'),                                # 6 kept: under_investigation
    match('CVE-2026-5555', 'Requests', '2.0', 'pkg:pypi/Requests@2.0'),                                  # 7 dropped: fixed, name case
    match('CVE-2026-6666', 'libqux', '4.0', 'pkg:rpm/redhat/libqux@4.0'),                                # 8 kept: VEX names 4.1
]
VEX = {'@context': 'https://openvex.dev/ns/v0.2.0', 'statements': [
    statement('GHSA-3jp2-3mrg-2vxc', 'not_affected', ['pkg:pypi/oauthlib@4.0.0'], ['CVE-2026-49272']),
    statement('CVE-2026-1111', 'not_affected', ['pkg:golang/golang.org/x/net@v0.59.0']),
    statement('CVE-2026-2222', 'not_affected', ['pkg:rpm/redhat/libfoo@1.0']),
    statement('CVE-2026-3333', 'affected', ['pkg:rpm/redhat/libbar@2.0']),
    statement('CVE-2026-4444', 'under_investigation', ['pkg:rpm/redhat/libbaz@3.0']),
    statement('CVE-2026-5555', 'fixed', ['pkg:pypi/requests@2.0']),
    statement('CVE-2026-6666', 'not_affected', ['pkg:rpm/redhat/libqux@4.1']),
]}
SARIF = {'runs': [{'results': [{'ruleId': f"{m['vulnerability']['id']}-{m['artifact']['name']}"} for m in MATCHES]}]}

with tempfile.TemporaryDirectory() as d:
    g, v, s = (os.path.join(d, n) for n in ('g.json', 'v.json', 's.sarif'))
    for path, data in ((g, {'matches': MATCHES}), (v, VEX), (s, SARIF)):
        with open(path, 'w') as f:
            json.dump(data, f)
    r = subprocess.run([sys.executable, SCRIPT, g, v, '--sarif', s], capture_output=True, text=True)
    check('the script runs', r.returncode == 0, r.stderr)
    out = json.load(open(g))
    kept = [(m['vulnerability']['id'], m['artifact']['name']) for m in out['matches']]
    dropped = [(x['id'], x['package'], x['status']) for x in out['vexSuppressed']]
    check('1. not_affected by id and package: oauthlib dropped', ('GHSA-3jp2-3mrg-2vxc', 'oauthlib', 'not_affected') in dropped)
    check('1. by an alias against the finding\'s related ids: x/net dropped', ('GO-2026-6603', 'golang.org/x/net', 'not_affected') in dropped)
    check('1. purl qualifiers ignored: libfoo dropped', ('CVE-2026-2222', 'libfoo', 'not_affected') in dropped)
    check('1. a fixed statement drops too, package name case ignored', ('CVE-2026-5555', 'Requests', 'fixed') in dropped)
    check('2. kept: the same advisory on another package, another advisory on the package, affected, under_investigation, another version',
          kept == [('GHSA-3jp2-3mrg-2vxc', 'other'), ('GHSA-xxxx-yyyy-zzzz', 'oauthlib'), ('CVE-2026-3333', 'libbar'), ('CVE-2026-4444', 'libbaz'), ('CVE-2026-6666', 'libqux')], kept)
    check('3. each dropped finding is printed', all(f'{i} {p}' in r.stdout for i, p, _ in dropped) and r.stdout.count('not counted') == 4, r.stdout)
    rules = [x['ruleId'] for x in json.load(open(s))['runs'][0]['results']]
    check('3. the SARIF loses exactly the dropped results', rules == [f'{i}-{p}' for i, p in kept], rules)
    hc = sum(1 for m in out['matches'] if m['vulnerability']['severity'] in ('High', 'Critical'))
    check('4. the High / Critical count is the kept findings only', hc == 5, hc)
    r = subprocess.run([sys.executable, SCRIPT, g], capture_output=True, text=True)
    check('a wrong call is refused (exit 2)', r.returncode == 2, r.returncode)

wf = open(os.path.join(REPO, '.github', 'workflows', 'scan.yml')).read()
check('scan.yml: the rescan applies the release\'s VEX with apply-vex.py to each SBOM\'s JSON and SARIF, before counting',
      'python3 .github/scripts/apply-vex.py "out/$n.json" "$VEX" --sarif "out/$n.sarif"' in wf
      and wf.index('apply-vex.py "out/$n.json"') < wf.index('hc="$(jq'))
check('scan.yml: the summary lists what the VEX covered', '.vexSuppressed // []' in wf)

print(f"\n{'All checks passed' if not failed else f'{failed} check(s) failed'}")
sys.exit(1 if failed else 0)
