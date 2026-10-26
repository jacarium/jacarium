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
          and all(p['@id'].startswith('pkg:') for s in doc['statements'] for p in s['products']) and any('quay.io/zerodayz/jacarium' in p['@id'] and 'tag=3.9.9' in p['@id'] for s in doc['statements'] for p in s['products']))
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

    # 6. the seeded decisions
    by_status = {}
    for d in decisions:
        by_status.setdefault(d['status'], []).append(d)
    check('every not_affected decision has a justification from the list and an impact statement that names where the code is and why it never runs', all(d.get('justification') in vex.JUSTIFICATIONS and len(d.get('impact') or '') > 60 for d in by_status.get('not_affected', [])), [d['id'] for d in by_status.get('not_affected', []) if not d.get('impact')])
    check('every affected decision says what fix is pending', all('pending' in (d.get('action') or '').lower() or 'upgrade' in (d.get('action') or '').lower() for d in by_status.get('affected', [])), [d['id'] for d in by_status.get('affected', [])])
    caddy = [d for d in decisions if any('golang' in c for c in d.get('components') or [])]
    server_side = [d for d in caddy if d['status'] == 'affected']
    client_side = [d for d in caddy if d['status'] == 'not_affected']
    check("the Caddy Go toolchain and x/net advisories: the server-side denial-of-service ones affected with the upstream Caddy fix pending, the x509 client-side one not_affected with the Caddyfile as the reason",
          len(caddy) >= 4 and len(server_side) >= 3 and all('Caddy' in (d.get('action') or '') and 'pending' in (d.get('action') or '').lower() for d in server_side)
          and client_side and all(d['justification'] == 'vulnerable_code_not_in_execute_path' and 'Caddyfile' in (d.get('impact') or '') for d in client_side), [(d['id'], d['status']) for d in caddy])
    check('every decision names who decided and when', all(d.get('decided_by') and d.get('decided_on') for d in decisions))
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
