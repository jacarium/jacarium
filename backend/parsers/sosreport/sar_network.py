"""SAR > Network: the `sar -n DEV` block of a report's sar text files
(rxpck/s, txpck/s, rxkB/s, txkB/s, ... per interface), one point per
sample interval.

The `-n EDEV` block (rxerr/s, txerr/s, coll/s, rxdrop/s, ...) carries the
same IFACE column: it is kept apart (it used to be merged into the DEV
series, which alternated two metric sets under one interface). Files and
the 12-hour clock through _common.sar_files / sar_split (see sar_cpu.py).

Result: {'day_DD': {iface: [{'time': 'HH:MM:SS', 'rxpck/s': .., ...}]}}
(the DEV block). parse_sar_iface(..., block='EDEV') returns the error block.
"""
from collections import defaultdict

from parsers.findings import finding, human_count, sort_findings

from ._common import open_text, sar_files, sar_no_data, sar_split

BLOCK_MARKER = {'DEV': 'rxpck/s', 'EDEV': 'rxerr/s'}


def parse_sar_iface(file_path, sample_interval_minutes=None, block='DEV'):
    iface_data = defaultdict(list)
    headers = []
    last_bucket_by_iface = {}
    marker = BLOCK_MARKER.get(block, 'rxpck/s')

    def bucket(time_str):
        h, m, _ = (int(x) for x in time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return f"{h:02}:{m:02}"

    try:
        with open_text(file_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('Average:'):
                    headers = []
                    continue
                split = sar_split(line)
                if not split:
                    continue
                timestamp, rest = split
                if rest and rest[0] == 'IFACE':
                    headers = rest[1:] if marker in rest else []
                    continue
                if not headers or len(rest) < len(headers) + 1:
                    continue
                iface = rest[0]
                b = bucket(timestamp) if sample_interval_minutes else None
                if sample_interval_minutes and last_bucket_by_iface.get(iface) == b:
                    continue
                last_bucket_by_iface[iface] = b
                try:
                    metrics = {k: float(v) for k, v in zip(headers, rest[1:])}
                except ValueError:
                    continue
                iface_data[iface].append({'time': timestamp, **metrics})
    except OSError:
        return {}
    return dict(iface_data)


def parse(sos_dir, sample_interval_minutes=10):
    result = {}
    for day, path in sar_files(sos_dir):
        iface_stats = parse_sar_iface(path, sample_interval_minutes=sample_interval_minutes)
        if iface_stats:
            result[f'day_{day}'] = iface_stats
    return result


def findings(sos_dir, sample_interval_minutes=10):
    """The Findings strip: per day and interface, samples at 80% of the line rate (%ifutil, warn), the EDEV block's
    drops and errors (rxdrop/s, txdrop/s, rxerr/s, txerr/s: warn when any sample shows them)."""
    out = []
    for day, path in sar_files(sos_dir):
        dev = parse_sar_iface(path, sample_interval_minutes=sample_interval_minutes)
        edev = parse_sar_iface(path, sample_interval_minutes=sample_interval_minutes, block='EDEV')
        label = f"day {day}"
        for iface, points in dev.items():
            hot = [p for p in points if p.get('%ifutil', 0) >= 80]
            if hot:
                out.append(finding('warn', f"{label}: {iface} at 80%+ of its line rate in {len(hot)} of {len(points)} samples (peak {max(p['%ifutil'] for p in hot):g}%)", f"from {hot[0]['time']} to {hot[-1]['time']}", count=len(hot)))
        for iface, points in edev.items():
            drops = sum(p.get('rxdrop/s', 0) + p.get('txdrop/s', 0) for p in points)
            errs = sum(p.get('rxerr/s', 0) + p.get('txerr/s', 0) for p in points)
            if drops or errs:
                samples = sum(1 for p in points if p.get('rxdrop/s', 0) + p.get('txdrop/s', 0) + p.get('rxerr/s', 0) + p.get('txerr/s', 0) > 0)
                out.append(finding('warn', f"{label}: {iface} dropped or errored packets in {samples} of {len(points)} samples", f"about {human_count(int(drops))} drops/s and {human_count(int(errs))} errors/s summed over the samples", tab='network', sub_tab='network_stats', count=samples))
    nd = sar_no_data(sos_dir)
    if nd:
        return [nd]
    if not out:
        out.append(finding('good', f"No saturated interface, no drops or errors in the {len(sar_files(sos_dir))} sar day{'s' if len(sar_files(sos_dir)) != 1 else ''} of this report"))
    return sort_findings(out)
