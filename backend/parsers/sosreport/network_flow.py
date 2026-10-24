"""The network_flow group page of a sosreport: its Findings are the sum of its sub-tabs' (worst first, each one
named after the tab it came from and linked to it), so the group reads as one overview."""
from parsers.findings import finding, no_data, sort_findings

SUBS = ()


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
                f['link'] = {'tab': 'network_flow', 'sub_tab': sub, 'query': ''}
            f['title'] = f"{sub}: {f['title']}"
            out.append(f)
    if not out:
        out.append(no_data('Flow Visualization has no data source yet', [], 'what it should show (OVS flows, nftables, conntrack) is an open design question'))
    return {'findings': sort_findings(out)}
