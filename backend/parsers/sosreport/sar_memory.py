"""SAR > Memory: the `sar -r` block of a report's sar text files (kbmemfree,
kbavail, kbmemused, %memused, ...), one point per sample interval.

Files and the 12-hour clock through _common.sar_files / sar_split (see
sar_cpu.py). Result: {'day_DD': [{'time': 'HH:MM:SS', 'kbmemfree': .., ...}]}
"""
from parsers.findings import finding, sort_findings

from ._common import open_text, sar_files, sar_no_data, sar_split


def parse_sar_memory(file_path, sample_interval_minutes=None):
    mem_data = []
    headers = []
    last_bucket = None

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
                    if headers:
                        break
                    continue
                split = sar_split(line)
                if not split:
                    continue
                timestamp, rest = split
                if 'kbmemfree' in rest:
                    headers = rest
                    continue
                if not headers:
                    continue
                if rest and not rest[0].replace('.', '', 1).isdigit():
                    headers = []          # the next block's header (another metric set)
                    continue
                if len(rest) < len(headers):
                    continue
                b = bucket(timestamp) if sample_interval_minutes else None
                if sample_interval_minutes and b == last_bucket:
                    continue
                last_bucket = b
                try:
                    metrics = {k: float(v) for k, v in zip(headers, rest)}
                except ValueError:
                    continue
                mem_data.append({'time': timestamp, **metrics})
    except OSError:
        return []
    return mem_data


def parse(directory, sample_interval_minutes=10):
    result = {}
    for day, path in sar_files(directory):
        mem_stats = parse_sar_memory(path, sample_interval_minutes=sample_interval_minutes)
        if mem_stats:
            result[f'day_{day}'] = mem_stats
    return result


def findings(directory, sample_interval_minutes=10):
    """The Findings strip: per day, samples with %memused over 95% (warn; bad when kbavail - sysstat 11.6+ - is under
    5% of the memory), %commit over 200% (info: overcommitted)."""
    out = []
    for day, path in sar_files(directory):
        points = parse_sar_memory(path, sample_interval_minutes=sample_interval_minutes)
        if not points:
            continue
        n = len(points)
        label = f"day {day}"
        total = max((p.get('kbmemfree', 0) + p.get('kbmemused', 0)) for p in points) or 0
        tight = [p for p in points if ('kbavail' in p and total and p['kbavail'] / total < 0.05)]
        full = [p for p in points if p.get('%memused', 0) >= 95]
        if tight:
            out.append(finding('bad', f"{label}: under 5% of memory available in {len(tight)} of {n} samples", f"from {tight[0]['time']} to {tight[-1]['time']}: the page cache was gone, reclaim and swapping follow", tab='cgroups', sub_tab='cgroups_memory', count=len(tight)))
        elif full:
            out.append(finding('warn', f"{label}: memory over 95% used in {len(full)} of {n} samples", "used includes the page cache: a problem only if `kbavail` is low too (shown when sysstat prints it)", count=len(full)))
        commit = [p for p in points if p.get('%commit', 0) >= 200]
        if commit:
            out.append(finding('info', f"{label}: memory committed over 200% in {len(commit)} of {n} samples", "the allocations promised exceed twice the RAM + swap: overcommit relies on them not being used at once", count=len(commit)))
    nd = sar_no_data(directory)
    if nd:
        return [nd]
    if not out:
        out.append(finding('good', f"No memory-pressure episode in the {len(sar_files(directory))} sar day{'s' if len(sar_files(directory)) != 1 else ''} of this report"))
    return sort_findings(out)
