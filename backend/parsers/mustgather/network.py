"""The Network group page of a must-gather: its Findings are the sum of its sub-tabs' (worst first, each one
named after the tab it came from and linked to it), so the group reads as one overview."""
from parsers.findings import finding, sort_findings
from parsers.mustgather import nmstate

SUBS = ('nmstate',)


def parse(directory):
    out = []
    for sub in SUBS:
        mod = globals()[sub]
        try:
            items = mod.findings(directory) if hasattr(mod, 'findings') else (mod.parse(directory) or {}).get('findings', [])
        except Exception as e:  # noqa: BLE001
            items = [finding('warn', f"{sub} could not be read", str(e)[:200])]
        for f in items:
            f = dict(f)
            if not f.get('link'):
                f['link'] = {'tab': 'network', 'sub_tab': sub, 'query': ''}
            f['title'] = f"{sub}: {f['title']}"
            out.append(f)
    return {'findings': sort_findings(out)}
