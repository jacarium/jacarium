#!/usr/bin/env python3
"""
scripts/vex.py and vex/decisions.yaml: the release's OpenVEX document is built from the reviewed decisions and
validated against the vendored OpenVEX 0.2.0 schema.

 1. the real decisions file builds a valid document for a version (every statement with a name, a status from
    the OpenVEX list, package-URL products; not_affected ones with a justification and an impact statement,
    affected ones with an action statement), and `--check` accepts it;
 2. the schema check rejects a bad status, a missing vulnerability name and a non-unique products list; the
    semantic check rejects a not_affected statement without a justification and a duplicate statement;
 3. scanner reports: a synthetic Grype report and a synthetic Trivy report are read, decided ids (and aliases)
    are not "undecided", the rest are, and --strict fails on them;
 4. the OSV-Scanner ignore list and the Grype ignore list carry exactly the not_affected ids;
 5. versions: a decision limited to "3.4.*" or ">=3.5.0" applies to the right releases only;
 6. the seeded decisions are honest: every not_affected one names a verified reason in its impact statement,
    every affected one says what fix is pending, and the Caddy Go advisories are there as affected.

Run: backend/venv/bin/python tests/vex.test.py   (PyYAML)
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
sys.path.insert(0, os.path.join(REPO, 'scripts'))
import vex  # noqa: E402

failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:500]) if info and not ok else ''}")
    if not ok:
        failed += 1


WORK = tempfile.mkdtemp(prefix='vex-test-')
try:
    schema = json.load(open(vex.SCHEMA, encoding='utf-8'))
    decisions = vex.load_decisions(vex.DECISIONS)
    check('decisions.yaml loads and holds decisions', len(decisions) >= 5, len(decisions))
    doc = vex.build(decisions, '3.9.9')
    errors = vex.validate_schema(doc, schema) + vex.validate_semantics(doc)
    check('the document for a version is valid against the schema and the semantic rules', not errors, errors)
    check('the document names the two products as package URLs and the context / author / timestamp', doc['@context'] == 'https://openvex.dev/ns/v0.2.0' and doc['author'] and doc['timestamp'].endswith('Z')
          and all(p['@id'].startswith('pkg:') for s in doc['statements'] for p in s['products']) and any(p['@id'] == 'pkg:oci/jacarium?tag=3.9.9' for s in doc['statements'] for p in s['products']))
    # the command line, end to end
    out = os.path.join(WORK, 'jacarium-3.9.9.openvex.json')
    r = subprocess.run([sys.executable, os.path.join(REPO, 'scripts', 'vex.py'), '--version', '3.9.9', '--out', out, '--now', '2026-10-26T12:00:00Z'], capture_output=True, text=True)
    check('scripts/vex.py --version writes the document', r.returncode == 0 and os.path.exists(out) and 'statements' in r.stdout, (r.returncode, r.stdout, r.stderr))
    r = subprocess.run([sys.executable, os.path.join(REPO, 'scripts', 'vex.py'), '--check', out], capture_output=True, text=True)
    check('--check accepts it', r.returncode == 0 and 'valid' in r.stdout, (r.returncode, r.stdout))
    written = json.load(open(out))
    check('the document is written with the fixed timestamp (reproducible given --now)', written['timestamp'] == '2026-10-26T12:00:00Z')

    # 2. the checks reject what they should
    bad = json.loads(json.dumps(doc))
    bad['statements'][0]['status'] = 'maybe'
    check('schema: a status outside the OpenVEX list is rejected', any('is not one of' in e for e in vex.validate_schema(bad, schema)))
    bad = json.loads(json.dumps(doc))
    del bad['statements'][0]['vulnerability']['name']
    check('schema: a vulnerability without a name is rejected', any('missing name' in e for e in vex.validate_schema(bad, schema)))
    bad = json.loads(json.dumps(doc))
    bad['statements'][0]['products'] = [bad['statements'][0]['products'][0]] * 2
    check('schema: duplicate products are rejected (uniqueItems)', any('not unique' in e for e in vex.validate_schema(bad, schema)))
    bad = json.loads(json.dumps(doc))
    na = next(s for s in bad['statements'] if s['status'] == 'not_affected')
    del na['justification']
    check('semantics: not_affected without a justification is rejected', any('needs a justification' in e for e in vex.validate_semantics(bad)))
    bad = json.loads(json.dumps(doc))
    bad['statements'].append(json.loads(json.dumps(bad['statements'][0])))
    check('semantics: two statements for the same vulnerability and product are rejected', any('more than one statement' in e for e in vex.validate_semantics(bad)))
    bad = json.loads(json.dumps(doc))
    bad['statements'][0]['products'][0]['@id'] = 'quay.io/zerodayz/jacarium:3.9.9'
    check('semantics: a product that is not a package URL is rejected', any('not a package URL' in e for e in vex.validate_semantics(bad)))

    # 3. scanner reports
    decided_id = decisions[0]['id']
    grype = {'matches': [
        {'vulnerability': {'id': decided_id, 'severity': 'High', 'fix': {'state': 'fixed', 'versions': ['9.9']}}, 'relatedVulnerabilities': [], 'artifact': {'name': 'x', 'version': '1'}},
        {'vulnerability': {'id': 'GHSA-zzzz-zzzz-zzzz', 'severity': 'Critical', 'fix': {'state': 'fixed', 'versions': ['2.0']}}, 'relatedVulnerabilities': [{'id': 'CVE-2099-0001'}], 'artifact': {'name': 'libz', 'version': '1.0'}},
        {'vulnerability': {'id': 'CVE-2099-0002', 'severity': 'High', 'fix': {'state': 'not-fixed', 'versions': []}}, 'relatedVulnerabilities': [], 'artifact': {'name': 'nofix', 'version': '1'}},
        {'vulnerability': {'id': 'CVE-2099-0003', 'severity': 'Low', 'fix': {'state': 'fixed', 'versions': ['1.1']}}, 'relatedVulnerabilities': [], 'artifact': {'name': 'low', 'version': '1'}},
    ]}
    gpath = os.path.join(WORK, 'grype.json'); json.dump(grype, open(gpath, 'w'))
    found = vex.findings(gpath)
    check('grype report: only High / Critical findings with a fix are read', set(k[0] for k in found) == {decided_id, 'GHSA-zzzz-zzzz-zzzz'}, found)
    left = vex.undecided(found, decisions)
    check('a decided id is not undecided, an unknown one is', set(k[0] for k in left) == {'GHSA-zzzz-zzzz-zzzz'}, left)
    alias_decisions = decisions + [{'id': 'CVE-2099-0001', 'status': 'under_investigation', 'decided_by': 't', 'decided_on': '2026-10-26'}]
    check('an alias of a decided id (relatedVulnerabilities) counts as decided', not vex.undecided(found, alias_decisions))
    trivy = {'Results': [{'Type': 'python-pkg', 'Vulnerabilities': [
        {'VulnerabilityID': 'CVE-2099-0004', 'PkgName': 'p', 'InstalledVersion': '1', 'FixedVersion': '2', 'Severity': 'HIGH'},
        {'VulnerabilityID': 'CVE-2099-0005', 'PkgName': 'q', 'InstalledVersion': '1', 'FixedVersion': '', 'Severity': 'CRITICAL'},
        {'VulnerabilityID': 'CVE-2099-0006', 'PkgName': 'r', 'InstalledVersion': '1', 'FixedVersion': '2', 'Severity': 'MEDIUM'},
    ]}]}
    tpath = os.path.join(WORK, 'trivy.json'); json.dump(trivy, open(tpath, 'w'))
    check('trivy report: the same reading', set(k[0] for k in vex.findings(tpath)) == {'CVE-2099-0004'})
    r = subprocess.run([sys.executable, os.path.join(REPO, 'scripts', 'vex.py'), '--version', '3.9.9', '--out', out, '--scan', gpath, '--scan', tpath, '--strict'], capture_output=True, text=True)
    check('--scan lists the undecided findings and --strict fails on them', r.returncode == 1 and 'undecided: GHSA-zzzz-zzzz-zzzz libz 1.0' in r.stdout and 'undecided: CVE-2099-0004 p 1' in r.stdout, (r.returncode, r.stdout))
    r = subprocess.run([sys.executable, os.path.join(REPO, 'scripts', 'vex.py'), '--version', '3.9.9', '--out', out, '--scan', gpath], capture_output=True, text=True)
    check('without --strict the undecided findings are listed but the run passes', r.returncode == 0 and 'without a decision' in r.stdout, (r.returncode, r.stdout))

    # 4. the ignore lists
    osv = vex.osv_config(decisions)
    na_ids = [vid for d in decisions if d['status'] == 'not_affected' for vid in [d['id']] + list(d.get('aliases') or [])]
    other_ids = [d['id'] for d in decisions if d['status'] != 'not_affected']
    check('the OSV-Scanner ignore list holds exactly the not_affected ids (with aliases) and their justification', all(f'id = "{i}"' in osv for i in na_ids) and not any(f'id = "{i}"' in osv for i in other_ids) and 'vulnerable_code_not_in_execute_path' in osv, osv[:300])
    gi = yaml.safe_load(vex.grype_ignore(decisions))
    check('the Grype ignore list holds the same ids', sorted(r['vulnerability'] for r in gi['ignore']) == sorted(na_ids))

    # 5. versions
    scoped = [{'id': 'CVE-2099-0010', 'status': 'under_investigation', 'decided_by': 't', 'decided_on': '2026-10-26', 'versions': ['3.4.*']},
              {'id': 'CVE-2099-0011', 'status': 'under_investigation', 'decided_by': 't', 'decided_on': '2026-10-26', 'versions': ['>=3.5.0']}]
    names = lambda v: [s['vulnerability']['name'] for s in vex.build(scoped, v)['statements']]  # noqa: E731
    check('a decision limited to 3.4.* applies to 3.4.2 and not to 3.5.0; >=3.5.0 the other way round', names('3.4.2') == ['CVE-2099-0010'] and names('3.5.0') == ['CVE-2099-0011'] and names('3.3.9') == [])
    below = [{'id': 'CVE-2099-0012', 'status': 'under_investigation', 'decided_by': 't', 'decided_on': '2026-10-26', 'versions': ['<3.4.0']}]
    check("'<3.4.0' applies to 3.3.9 and not to 3.4.0 or 3.10.0", [s['vulnerability']['name'] for s in vex.build(below, '3.3.9')['statements']] == ['CVE-2099-0012'] and vex.build(below, '3.4.0')['statements'] == [] and vex.build(below, '3.10.0')['statements'] == [])

    # 6. the seeded decisions
    by_status = {}
    for d in decisions:
        by_status.setdefault(d['status'], []).append(d)
    check('every not_affected decision has a justification from the list and an impact statement that names where the code is and why it never runs', all(d.get('justification') in vex.JUSTIFICATIONS and len(d.get('impact') or '') > 60 for d in by_status.get('not_affected', [])), [d['id'] for d in by_status.get('not_affected', []) if not d.get('impact')])
    check('every affected decision says what fix is pending', all('pending' in (d.get('action') or '').lower() or 'upgrade' in (d.get('action') or '').lower() for d in by_status.get('affected', [])), [d['id'] for d in by_status.get('affected', [])])
    # the Go toolchain and x/net entries (chi and go-jose, other Go modules Caddy pulls in, have their own checks below)
    XNET_HTML = ('GO-2026-6860', 'GO-2026-6866')   # the 3.5.2 x/net html pair has its own checks below
    caddy = [d for d in decisions if any('golang' in c for c in d.get('components') or []) and not any('go-chi' in c or 'go-jose' in c for c in d.get('components') or []) and d['id'] not in XNET_HTML]
    server_side = [d for d in caddy if d['status'] == 'affected']
    fixed = [d for d in caddy if d['status'] == 'fixed']
    client_side = [d for d in caddy if d['status'] == 'not_affected']
    check("the Caddy Go advisories: affected for the releases before 3.4.0 (upgrade as the action), fixed from 3.4.0 on (the Go / x/net versions named, the GO-ids with their CVE aliases), the x509 client-side one not_affected with the Caddyfile as the reason",
          len(server_side) >= 3 and all(d.get('versions') == ['<3.4.0'] and 'Upgrade to Jacarium 3.4.0' in (d.get('action') or '') for d in server_side)
          and len(fixed) >= 11 and all(d.get('versions') == ['>=3.4.0'] and '1.27.2' in (d.get('notes') or '') and d['id'].startswith('GO-') and any(a.startswith('CVE-') for a in d.get('aliases') or []) for d in fixed)
          and client_side and all(d['justification'] == 'vulnerable_code_not_in_execute_path' and 'Caddyfile' in (d.get('impact') or '') for d in client_side), [(d['id'], d['status'], d.get('versions')) for d in caddy])
    old, new = vex.build(decisions, '3.3.9'), vex.build(decisions, '3.4.0')
    st = lambda doc: {s['vulnerability']['name']: s['status'] for s in doc['statements']}  # noqa: E731
    check('for 3.3.9 the Caddy CVEs are affected and no GO-id is fixed; for 3.4.0 the GO-ids are fixed and the affected ones are gone', st(old).get('CVE-2026-78669') == 'affected' and 'GO-2026-6612' not in st(old) and st(new).get('GO-2026-6612') == 'fixed' and 'CVE-2026-78669' not in st(new), (st(old), st(new)))
    check("the image products carry no repository qualifier and name the list tag and both per-architecture tags, so Grype matches the release gate's local archives and the pushed image", [p['@id'] for p in new['statements'][0]['products']] == ['pkg:oci/jacarium?tag=3.4.0', 'pkg:oci/jacarium?tag=3.4.0-amd64', 'pkg:oci/jacarium?tag=3.4.0-arm64'], [p['@id'] for p in new['statements'][0]['products']])
    check("the base image's npm modules are not_affected (component_not_present) from 3.4.0 on", all(st(new).get(i) == 'not_affected' for i in ('GHSA-6j4f-fj2g-mc7p', 'GHSA-qhr7-859c-m2p7', 'GHSA-c2c7-rcm5-vvqj')) and 'GHSA-c2c7-rcm5-vvqj' not in st(old))
    check('every decision names who decided and when', all(d.get('decided_by') and d.get('decided_on') for d in decisions))
    # 3.5.1: the python-314 base's system Python 3.9 (never executed - the image runs Python 3.14), xz (reachable
    # through the sos report parser: affected) and chi in Caddy (affected before 3.5.1, fixed from it).
    # 3.5.2: the image moves to ubi9-minimal - no Python 3.9 at all (the statements stop at 3.5.1, nothing is
    # claimed for an absent package), xz-libs raised to the fixed RPM, go-jose raised in the Caddy build.
    py = {d['id']: d for d in decisions if any('/python3' in c for c in d.get('components') or [])}
    check("the system python3 3.9 CVEs (2026-19445, 2026-19553, 2026-12345) are not_affected for exactly 3.5.0 and 3.5.1 (vulnerable_code_not_in_execute_path), the impact naming Python 3.14 as what runs and ubi9-minimal from 3.5.2",
          all(py.get(i) and py[i]['status'] == 'not_affected' and py[i]['justification'] == 'vulnerable_code_not_in_execute_path' and py[i].get('versions') == ['3.5.0', '3.5.1']
              and 'Python 3.14' in py[i]['impact'] and 'ubi9-minimal' in py[i]['impact'] for i in ('CVE-2026-19445', 'CVE-2026-19553', 'CVE-2026-12345')), sorted(py))
    xz = [d for d in decisions if d['id'] == 'CVE-2026-34743']
    check('xz CVE-2026-34743: affected before 3.5.2 (the sos report parser named as the path, the upgrade as the action), fixed from 3.5.2 naming xz-libs 5.2.5-8.el9_8.1',
          sorted((d['status'], tuple(d.get('versions') or [])) for d in xz) == [('affected', ('<3.5.2',)), ('fixed', ('>=3.5.2',))]
          and any('sos report' in (d.get('action') or '') and 'Upgrade to Jacarium 3.5.2' in (d.get('action') or '') and len(d['components']) == 3 for d in xz)
          and any('5.2.5-8.el9_8.1' in (d.get('notes') or '') and d['components'] == ['pkg:rpm/redhat/xz-libs@5.2.5-8.el9_8.1'] for d in xz), xz)
    jose = [d for d in decisions if d['id'] == 'GHSA-mgcc-cww5-fp2q']
    check('go-jose GHSA-mgcc-cww5-fp2q (CVE-2026-116587): affected before 3.5.2 with the upgrade as the action, fixed from 3.5.2 naming v4.1.6',
          sorted((d['status'], tuple(d.get('versions') or [])) for d in jose) == [('affected', ('<3.5.2',)), ('fixed', ('>=3.5.2',))]
          and all('CVE-2026-116587' in (d.get('aliases') or []) for d in jose) and any('v4.1.6' in (d.get('notes') or '') for d in jose) and any('Upgrade to Jacarium 3.5.2' in (d.get('action') or '') for d in jose), jose)
    chi = [d for d in decisions if d['id'] == 'GHSA-j6qf-3m9c-vwj3']
    check('chi GHSA-j6qf-3m9c-vwj3 (CVE-2026-114437): affected before 3.5.1 with the upgrade as the action, fixed from 3.5.1 naming v5.4.0',
          sorted((d['status'], tuple(d.get('versions') or [])) for d in chi) == [('affected', ('<3.5.1',)), ('fixed', ('>=3.5.1',))]
          and all('CVE-2026-114437' in (d.get('aliases') or []) for d in chi) and any('v5.4.0' in (d.get('notes') or '') for d in chi) and any('Upgrade to Jacarium 3.5.1' in (d.get('action') or '') for d in chi), chi)
    v350, v351, v352 = st(vex.build(decisions, '3.5.0')), st(vex.build(decisions, '3.5.1')), st(vex.build(decisions, '3.5.2'))
    check('for 3.5.0 chi is affected and the python3 CVEs not_affected; for 3.5.1 chi is fixed, xz still affected',
          v350.get('GHSA-j6qf-3m9c-vwj3') == 'affected' and v350.get('CVE-2026-19445') == 'not_affected' and v351.get('GHSA-j6qf-3m9c-vwj3') == 'fixed' and v351.get('CVE-2026-34743') == 'affected' and v351.get('CVE-2026-19553') == 'not_affected')
    check('for 3.5.2 (ubi9-minimal) xz and go-jose are fixed, chi stays fixed, and no python3 3.9 statement is made (the package is not in the image)',
          v352.get('CVE-2026-34743') == 'fixed' and v352.get('GHSA-mgcc-cww5-fp2q') == 'fixed' and v352.get('GHSA-j6qf-3m9c-vwj3') == 'fixed'
          and not any(i in v352 for i in ('CVE-2026-19445', 'CVE-2026-19553', 'CVE-2026-12345')) and v351.get('GHSA-mgcc-cww5-fp2q') == 'affected', {k: v352.get(k) for k in ('CVE-2026-34743', 'GHSA-mgcc-cww5-fp2q', 'CVE-2026-19445')})
    with open(os.path.join(REPO, 'deploy', 'Containerfile'), encoding='utf-8') as fh:
        containerfile = fh.read()
    check('deploy/Containerfile builds Caddy with chi v5.4.0 and checks it in caddy build-info', 'ARG CHI_VERSION=v5.4.0' in containerfile and 'go get "github.com/go-chi/chi/v5@${CHI_VERSION}"' in containerfile and 'dep\\s+github.com/go-chi/chi/v5\\s+${CHI_VERSION}' in containerfile)
    xnet = [d for d in decisions if d['id'] in XNET_HTML]
    check('x/net html GO-2026-6860 / GO-2026-6866 (CVE-2026-78661 / 97045): affected before 3.5.2 with the upgrade as the action, fixed from 3.5.2 naming 0.62.0',
          sorted((d['id'], d['status'], tuple(d.get('versions') or [])) for d in xnet) == [('GO-2026-6860', 'affected', ('<3.5.2',)), ('GO-2026-6860', 'fixed', ('>=3.5.2',)), ('GO-2026-6866', 'affected', ('<3.5.2',)), ('GO-2026-6866', 'fixed', ('>=3.5.2',))]
          and all(any(a.startswith('CVE-') for a in d.get('aliases') or []) for d in xnet) and all('0.62.0' in (d.get('notes') or d.get('action') or '') for d in xnet), xnet)
    check('deploy/Containerfile builds Caddy with x/net 0.62.0 and checks it in caddy build-info', 'ARG XNET_VERSION=v0.62.0' in containerfile and 'dep\\s+golang.org/x/net\\s+${XNET_VERSION}' in containerfile)
    check('deploy/Containerfile builds Caddy with go-jose v4.1.6 and checks it in caddy build-info', 'ARG GOJOSE_VERSION=v4.1.6' in containerfile and 'go get "github.com/go-jose/go-jose/v4@${GOJOSE_VERSION}"' in containerfile and 'dep\\s+github.com/go-jose/go-jose/v4\\s+${GOJOSE_VERSION}' in containerfile)
    check('deploy/Containerfile runs on ubi9-minimal pinned by digest, installs xz-libs 5.2.5-8.el9_8.1 and checks that python3 3.9, python3-urllib3, brotli and dnf are absent',
          re.search(r'^FROM registry\.access\.redhat\.com/ubi9-minimal:9\.8-\d+@sha256:[0-9a-f]{64}\n', containerfile, re.M) is not None and 'ubi9/python-314:' not in containerfile
          and 'upgrade xz-libs' in containerfile and 'rpm -q xz-libs-5.2.5-8.el9_8.1' in containerfile and 'rpm -q python3 python3-libs python3-urllib3 python3-pip libbrotli brotli brotli-devel dnf nodejs npm' in containerfile)
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
