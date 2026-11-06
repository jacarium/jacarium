#!/usr/bin/env python3
"""Apply a release's OpenVEX document to Grype's findings on that release's SBOMs.

Grype applies --vex only when it knows the image's tags or repo digests, which it does for an image but not for
an SBOM (`grype sbom:...` sees the manifest digest alone), so in the weekly rescan of the published SBOMs
(.github/workflows/scan.yml) no statement ever matched. This does the matching itself, on Grype's JSON (and the
SARIF made in the same run):

  a finding is dropped when a statement of the VEX with status not_affected or fixed names its vulnerability
  (the id or one of its aliases, against the finding's id and its related ids) and, when the statement lists
  subcomponents, one of them is the finding's package (its purl without qualifiers / subpath / version-less
  forms compared). affected and under_investigation statements drop nothing.

The VEX is the release's own (one document per release), so its products are not matched again here. The
dropped findings are printed, and kept in the JSON under "vexSuppressed" so the summary can show them.

  apply-vex.py GRYPE_JSON VEX_JSON [--sarif SARIF]     rewrites the files in place
"""
import json
import sys
from urllib.parse import unquote

DROP = {'not_affected', 'fixed'}


def purl_key(purl):
    """type/namespace/name@version, lower-cased type and name; qualifiers and subpath dropped."""
    if not purl:
        return None
    base = unquote(purl.split('#', 1)[0].split('?', 1)[0])
    if not base.startswith('pkg:'):
        return None
    head, _, version = base[4:].partition('@')
    kind, _, rest = head.partition('/')
    return f'{kind.lower()}/{rest.lower()}@{version}'


def statements(vex):
    out = []
    for st in vex.get('statements', []):
        if st.get('status') not in DROP:
            continue
        v = st.get('vulnerability') or {}
        ids = {v.get('name'), v.get('@id'), *(v.get('aliases') or [])} - {None}
        subs = {purl_key(s.get('@id')) for p in st.get('products', []) for s in (p.get('subcomponents') or [])} - {None}
        out.append((ids, subs, st.get('status')))
    return out


def covered(match, rules):
    vuln = match.get('vulnerability') or {}
    ids = {vuln.get('id')} | {r.get('id') for r in match.get('relatedVulnerabilities') or []}
    ids.discard(None)
    pkg = purl_key((match.get('artifact') or {}).get('purl'))
    for rule_ids, subs, status in rules:
        if ids & rule_ids and (not subs or pkg in subs):
            return status
    return None


def main(argv):
    if len(argv) not in (3, 5) or (len(argv) == 5 and argv[3] != '--sarif'):
        print(__doc__.strip().splitlines()[-1].strip(), file=sys.stderr)
        return 2
    grype_path, vex_path = argv[1], argv[2]
    with open(vex_path) as f:
        rules = statements(json.load(f))
    with open(grype_path) as f:
        doc = json.load(f)
    kept, dropped = [], []
    for m in doc.get('matches', []):
        status = covered(m, rules)
        if status:
            dropped.append({'id': m['vulnerability']['id'], 'package': m['artifact'].get('name'),
                            'version': m['artifact'].get('version'), 'status': status})
        else:
            kept.append(m)
    doc['matches'] = kept
    doc['vexSuppressed'] = dropped
    with open(grype_path, 'w') as f:
        json.dump(doc, f)
    for d in dropped:
        print(f"VEX {d['status']}: {d['id']} {d['package']} {d['version']} - not counted")
    if len(argv) == 5:
        gone = {f"{d['id']}-{d['package']}" for d in dropped}
        with open(argv[4]) as f:
            sarif = json.load(f)
        for run in sarif.get('runs', []):
            run['results'] = [r for r in run.get('results', []) if r.get('ruleId') not in gone]
        with open(argv[4], 'w') as f:
            json.dump(sarif, f)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
