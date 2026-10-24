"""The cgroups group page of a sosreport: its Findings are the sum of its sub-tabs' (worst first, each one
named after the tab it came from and linked to it), so the group reads as one overview."""
from parsers.findings import finding, no_data, sort_findings
from parsers.sosreport import cgroups_cpu, cgroups_memory

SUBS = ('cgroups_cpu', 'cgroups_memory')


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
                f['link'] = {'tab': 'cgroups', 'sub_tab': sub, 'query': ''}
            f['title'] = f"{sub}: {f['title']}"
            out.append(f)
    return {'findings': sort_findings(out)}
