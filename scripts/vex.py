#!/usr/bin/env python3
"""
The release's OpenVEX document from the reviewed decisions: vex/decisions.yaml (one entry per advisory - the
status, the justification or action, the products and components, who decided and when) becomes
vex/jacarium-<version>.openvex.json, validated against the vendored OpenVEX 0.2.0 schema. Scanner reports can be
handed in so the run lists the findings no decision covers (and, with --strict, fails on them): Grype JSON and
Trivy JSON are understood.

    scripts/vex.py --version 3.4.0                                  write vex/jacarium-3.4.0.openvex.json
    scripts/vex.py --version 3.4.0 --scan grype.json --scan trivy.json [--strict]
    scripts/vex.py --check vex/jacarium-3.4.0.openvex.json          validate an existing document
    scripts/vex.py --version 3.4.0 --osv-config osv-scanner.toml    the not_affected ids as an OSV-Scanner ignore list
    scripts/vex.py --version 3.4.0 --grype-ignore .grype.yaml       the same for Grype's ignore list (what --vex covers anyway)

No dependency beyond PyYAML (the backend venv's, or the runner's). The schema check is a small interpreter of the
vendored schema - type, required, enum, properties, items, uniqueItems, const - enough for OpenVEX's shape; the
semantic rules the schema cannot express are checked by hand: a not_affected statement carries a justification
(and an impact_statement), an affected one an action_statement, a fixed one names the fixed version in its notes.

The document's products are package URLs: the image per version (pkg:oci/jacarium?repository_url=quay.io/zerodayz/jacarium&tag=<version>)
and the desktop application (pkg:generic/jacarium@<version>); a statement about one component inside them names
it as a subcomponent (pkg:golang/..., pkg:pypi/..., pkg:rpm/redhat/...).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VEX_DIR = os.path.join(REPO, 'vex')
SCHEMA = os.path.join(VEX_DIR, 'openvex_json_schema_0.2.0.json')
DECISIONS = os.path.join(VEX_DIR, 'decisions.yaml')
CONTEXT = 'https://openvex.dev/ns/v0.2.0'
AUTHOR = 'Jacarium maintainers (https://github.com/jacarium/jacarium)'
STATUSES = ('not_affected', 'affected', 'fixed', 'under_investigation')
JUSTIFICATIONS = ('component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path',
                  'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist')


def products_for(version):
    """The product identifiers a statement speaks about. The image is named three times, without a repository
    qualifier, so that Grype matches it wherever it meets it: the pushed manifest list (quay.io/...:<version>)
    and the per-architecture archives the release gate scans before anything is pushed
    (localhost/jacarium:<version>-<arch>). Grype builds pkg:oci/<name>?tag=<tag> identifiers from an image's
    tags and compares only the qualifiers a statement names, so a purl without repository_url fits both."""
    return {
        'image': [{'@id': f'pkg:oci/jacarium?tag={version}'}, {'@id': f'pkg:oci/jacarium?tag={version}-amd64'}, {'@id': f'pkg:oci/jacarium?tag={version}-arm64'}],
        'desktop': [{'@id': f'pkg:generic/jacarium@{version}'}],
    }


# ---------------------------------------------------------------- the document
def build(decisions, version, now=None):
    """The OpenVEX document for one version from the decisions list (each: id, aliases?, status, products
    (image / desktop), components (purls), justification?, impact?, action?, notes?, decided_by, decided_on)."""
    now = now or dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    prods = products_for(version)
    statements = []
    for d in decisions:
        if d.get('versions') and version not in d['versions'] and not any(_version_matches(v, version) for v in d['versions']):
            continue
        st = {
            'vulnerability': {'name': d['id'], **({'aliases': list(d['aliases'])} if d.get('aliases') else {}), **({'description': d['description']} if d.get('description') else {})},
            'timestamp': _iso(d.get('decided_on'), now),
            'products': [{**prod, **({'subcomponents': [{'@id': c} for c in d['components']]} if d.get('components') else {})} for p in d.get('products') or ['image'] for prod in prods[p]],
            'status': d['status'],
        }
        if d.get('justification'):
            st['justification'] = d['justification']
        if d.get('impact'):
            st['impact_statement'] = d['impact']
        if d.get('action'):
            st['action_statement'] = d['action']
            st['action_statement_timestamp'] = _iso(d.get('decided_on'), now)
        if d.get('notes') or d.get('decided_by'):
            st['status_notes'] = ' '.join(x for x in (d.get('notes'), f"Decided by {d['decided_by']}." if d.get('decided_by') else '') if x)
        statements.append(st)
    return {
        '@context': CONTEXT,
        '@id': f'https://github.com/jacarium/jacarium/vex/jacarium-{version}.openvex.json',
        'author': AUTHOR,
        'role': 'Document creator',
        'timestamp': now.isoformat().replace('+00:00', 'Z'),
        'version': 1,
        'tooling': 'scripts/vex.py (jacarium)',
        'statements': statements,
    }


def _version_matches(pattern, version):
    """'3.4.*', '>=3.4.0', '<3.4.0' (numeric major.minor.patch) or an exact version."""
    if pattern == version:
        return True
    if pattern.endswith('.*'):
        return version.startswith(pattern[:-1])
    m = re.fullmatch(r'(>=|<)(\d+)\.(\d+)\.(\d+)', pattern)
    if m:
        want = tuple(int(x) for x in m.groups()[1:])
        got = tuple(int(x) for x in version.split('.')[:3]) if re.fullmatch(r'\d+\.\d+\.\d+', version) else None
        if got is None:
            return False
        return got >= want if m.group(1) == '>=' else got < want
    return False


def _iso(value, now):
    if isinstance(value, (dt.date, dt.datetime)):
        if isinstance(value, dt.datetime):
            return value.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        return dt.datetime(value.year, value.month, value.day, tzinfo=dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    if isinstance(value, str) and value:
        return value if value.endswith('Z') else value + 'T00:00:00Z'
    return now.isoformat().replace('+00:00', 'Z')


# ---------------------------------------------------------------- the checks
def validate_schema(doc, schema, path='$'):
    """A small interpreter of the vendored schema: type, required, enum, const, properties, items, uniqueItems."""
    errors = []

    def walk(value, node, where):
        if '$ref' in node:
            ref = node['$ref']
            assert ref.startswith('#/$defs/'), ref
            node = {**schema['$defs'][ref[len('#/$defs/'):]], **{k: v for k, v in node.items() if k != '$ref'}}
        t = node.get('type')
        if t:
            types = t if isinstance(t, list) else [t]
            ok = any(_is_type(value, x) for x in types)
            if not ok:
                errors.append(f'{where}: expected {t}, got {type(value).__name__}')
                return
        if 'enum' in node and value not in node['enum']:
            errors.append(f'{where}: {value!r} is not one of {node["enum"]}')
        if 'const' in node and value != node['const']:
            errors.append(f'{where}: must be {node["const"]!r}')
        if isinstance(value, dict):
            for req in node.get('required') or []:
                if req not in value:
                    errors.append(f'{where}: missing {req}')
            for k, v in value.items():
                sub = (node.get('properties') or {}).get(k)
                if sub is not None:
                    walk(v, sub, f'{where}.{k}')
                elif node.get('additionalProperties') is False:
                    errors.append(f'{where}: unknown property {k}')
        if isinstance(value, list):
            if node.get('uniqueItems') and len({json.dumps(x, sort_keys=True) for x in value}) != len(value):
                errors.append(f'{where}: items are not unique')
            if 'items' in node:
                for i, item in enumerate(value):
                    walk(item, node['items'], f'{where}[{i}]')

    walk(doc, schema, path)
    return errors


def _is_type(value, t):
    return {'object': isinstance(value, dict), 'array': isinstance(value, list), 'string': isinstance(value, str),
            'integer': isinstance(value, int) and not isinstance(value, bool), 'number': isinstance(value, (int, float)) and not isinstance(value, bool),
            'boolean': isinstance(value, bool), 'null': value is None}.get(t, False)


def validate_semantics(doc):
    """What the schema cannot say: justification + impact for not_affected, an action for affected, notes for
    fixed; every product a package URL; no duplicate (vulnerability, product) pair."""
    errors = []
    seen = set()
    for i, st in enumerate(doc.get('statements') or []):
        name = (st.get('vulnerability') or {}).get('name') or f'#{i}'
        status = st.get('status')
        if status == 'not_affected':
            if st.get('justification') not in JUSTIFICATIONS:
                errors.append(f'{name}: not_affected needs a justification from the OpenVEX list')
            if not st.get('impact_statement'):
                errors.append(f'{name}: not_affected needs an impact_statement saying why')
        if status == 'affected' and not st.get('action_statement'):
            errors.append(f'{name}: affected needs an action_statement (what the user should do, or what fix is pending)')
        if status == 'fixed' and not st.get('status_notes'):
            errors.append(f'{name}: fixed needs status_notes naming the fixed version')
        for p in st.get('products') or []:
            pid = p.get('@id') or ''
            if not pid.startswith('pkg:'):
                errors.append(f'{name}: product {pid!r} is not a package URL')
            key = (name, pid)
            if key in seen:
                errors.append(f'{name}: more than one statement for {pid}')
            seen.add(key)
            for c in p.get('subcomponents') or []:
                if not (c.get('@id') or '').startswith('pkg:'):
                    errors.append(f'{name}: subcomponent {c.get("@id")!r} is not a package URL')
    return errors


# ---------------------------------------------------------------- scanner reports
def findings(path):
    """{(id, package, version)} of High / Critical findings with a fix in a Grype or Trivy JSON report."""
    with open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    out = {}
    if 'matches' in d:   # grype
        for m in d['matches']:
            v, a = m['vulnerability'], m['artifact']
            if (v.get('severity') or '').lower() in ('high', 'critical') and (v.get('fix') or {}).get('state') == 'fixed':
                out[(v['id'], a['name'], a['version'])] = {'severity': v.get('severity'), 'fixed': ','.join((v.get('fix') or {}).get('versions') or []), 'aliases': [r.get('id') for r in m.get('relatedVulnerabilities') or []]}
    elif 'Results' in d:   # trivy
        for r in d['Results'] or []:
            for v in r.get('Vulnerabilities') or []:
                if v.get('Severity') in ('HIGH', 'CRITICAL') and v.get('FixedVersion'):
                    out[(v['VulnerabilityID'], v['PkgName'], v['InstalledVersion'])] = {'severity': v['Severity'], 'fixed': v['FixedVersion'], 'aliases': []}
    else:
        raise SystemExit(f'{path}: neither a Grype nor a Trivy JSON report')
    return out


def undecided(found, decisions):
    ids = set()
    for d in decisions:
        ids.add(d['id'])
        ids.update(d.get('aliases') or [])
    return {k: v for k, v in found.items() if k[0] not in ids and not (set(v.get('aliases') or []) & ids)}


def osv_config(decisions):
    """OSV-Scanner's ignore list: the not_affected decisions (what OpenVEX says, in the form osv-scanner reads)."""
    lines = ['# Generated by scripts/vex.py from vex/decisions.yaml - the not_affected decisions only; do not edit.']
    for d in decisions:
        if d['status'] != 'not_affected':
            continue
        for vid in [d['id']] + list(d.get('aliases') or []):
            reason = (d.get('impact') or d.get('notes') or '').replace('"', "'")[:200]
            lines += ['', '[[IgnoredVulns]]', f'id = "{vid}"', f'reason = "{d["justification"]}: {reason}"']
    return '\n'.join(lines) + '\n'


def grype_ignore(decisions):
    rules = [{'vulnerability': vid, 'reason': f"{d['justification']}: {(d.get('impact') or '')[:160]}"} for d in decisions if d['status'] == 'not_affected' for vid in [d['id']] + list(d.get('aliases') or [])]
    return yaml.safe_dump({'ignore': rules}, sort_keys=False)


# ---------------------------------------------------------------- main
def load_decisions(path):
    with open(path, encoding='utf-8') as fh:
        data = yaml.safe_load(fh) or {}
    decisions = data.get('decisions') or []
    for d in decisions:
        for k in ('id', 'status', 'decided_by', 'decided_on'):
            if not d.get(k):
                raise SystemExit(f'decisions: {d.get("id", "?")}: {k} is required')
        if d['status'] not in STATUSES:
            raise SystemExit(f'decisions: {d["id"]}: status {d["status"]!r} is not one of {STATUSES}')
        for p in d.get('products') or ['image']:
            if p not in ('image', 'desktop'):
                raise SystemExit(f'decisions: {d["id"]}: product {p!r} is not image / desktop')
    return decisions


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--version', help='the release version the document is for')
    ap.add_argument('--decisions', default=DECISIONS)
    ap.add_argument('--schema', default=SCHEMA)
    ap.add_argument('--out', help='where to write the document (default vex/jacarium-<version>.openvex.json)')
    ap.add_argument('--scan', action='append', default=[], help='a Grype or Trivy JSON report; the undecided High / Critical fixable findings are listed')
    ap.add_argument('--strict', action='store_true', help='fail when a scanned finding has no decision')
    ap.add_argument('--check', help='validate this existing OpenVEX document and exit')
    ap.add_argument('--osv-config', help='also write OSV-Scanner\'s ignore list here')
    ap.add_argument('--grype-ignore', help='also write a Grype ignore list here')
    ap.add_argument('--now', help='the timestamp to use (tests)')
    args = ap.parse_args(argv)
    with open(args.schema, encoding='utf-8') as fh:
        schema = json.load(fh)
    if args.check:
        with open(args.check, encoding='utf-8') as fh:
            doc = json.load(fh)
        errors = validate_schema(doc, schema) + validate_semantics(doc)
        for e in errors:
            print('invalid:', e)
        print(f"{args.check}: {'valid' if not errors else str(len(errors)) + ' problem(s)'}, {len(doc.get('statements') or [])} statements")
        return 1 if errors else 0
    if not args.version:
        ap.error('--version is required (or --check)')
    decisions = load_decisions(args.decisions)
    now = dt.datetime.fromisoformat(args.now.replace('Z', '+00:00')) if args.now else None
    doc = build(decisions, args.version, now)
    errors = validate_schema(doc, schema) + validate_semantics(doc)
    if errors:
        for e in errors:
            print('invalid:', e)
        return 1
    out = args.out or os.path.join(VEX_DIR, f'jacarium-{args.version}.openvex.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2)
        fh.write('\n')
    print(f'wrote {out}: {len(doc["statements"])} statements')
    if args.osv_config:
        with open(args.osv_config, 'w', encoding='utf-8') as fh:
            fh.write(osv_config(decisions))
        print(f'wrote {args.osv_config}')
    if args.grype_ignore:
        with open(args.grype_ignore, 'w', encoding='utf-8') as fh:
            fh.write(grype_ignore(decisions))
        print(f'wrote {args.grype_ignore}')
    rc = 0
    for scan in args.scan:
        found = findings(scan)
        left = undecided(found, decisions)
        print(f'{scan}: {len(found)} High / Critical findings with a fix, {len(left)} without a decision')
        for (vid, pkg, ver), info in sorted(left.items()):
            print(f'  undecided: {vid} {pkg} {ver} ({info["severity"]}, fixed in {info["fixed"]})')
        if left and args.strict:
            rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main())
