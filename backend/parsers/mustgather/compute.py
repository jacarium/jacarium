"""The compute group page of a must-gather: its Findings are the sum of its sub-tabs' (worst first, each linked to
the tab it came from), so the group reads as one overview."""
from parsers.findings import finding, sort_findings
from parsers.mustgather import nodes, mcp

SUBS = ('nodes', 'mcp')


def parse(directory):
    out = []
    for sub in SUBS:
        mod = globals()[sub]
        try:
            items = mod.findings(directory) if hasattr(mod, 'findings') else (mod.parse(directory) or {}).get('findings', [])
        except Exception as e:  # noqa: BLE001 - a readable reason, never the raw exception
            from parsers.mustgather._common import reason_of
            items = [finding('warn', f"{sub} could not be read", reason_of(e))]
        for f in items:
            f = dict(f)
            if f.get('severity') in ('bad', 'warn') and not f.get('link'):
                f['link'] = {'tab': 'compute', 'sub_tab': sub, 'query': ''}
            f['title'] = f"{sub}: {f['title']}"
            out.append(f)
    return {'findings': sort_findings(out)}
