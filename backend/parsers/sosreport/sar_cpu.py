"""SAR > CPU: the per-CPU utilisation blocks of a report's sar text files
(the `sar -u ALL -P ALL` sections), one point per sample interval.

Files: var/log/sa/sarDD (the sa2 cron job's text, when it runs) and
sos_commands/sar/sarDD (what sos renders from the saDD binaries) through
_common.sar_files; a host in a 12-hour locale prints `12:10:01 AM`, folded
into the 24-hour time by _common.sar_split. The header reads `%usr` with
`-u ALL` and `%user` without it: both are accepted (as `%usr`). Sampling
keeps the first point of every sample_interval_minutes bucket per CPU, so
a day of ten-minute samples stays a day of ten-minute points however dense
the capture is.

Result: {'day_DD': {cpu_id: [{'time': 'HH:MM:SS', '%usr': .., ...}, ...]}}
"""
from collections import defaultdict

from parsers.findings import finding, sort_findings

from ._common import open_text, sar_files, sar_no_data, sar_split


def parse_sar_cpu(file_path, sample_interval_minutes=None):
    cpu_data = defaultdict(list)
    headers = []
    last_bucket_by_cpu = {}

    def bucket(time_str):
        h, m, _ = (int(x) for x in time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return h, m

    try:
        with open_text(file_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('Average:'):
                    if headers:
                        break       # the CPU block's averages: the block is over
                    continue
                split = sar_split(line)
                if not split:
                    continue
                timestamp, rest = split
                if rest and rest[0] == 'CPU' and ('%usr' in rest or '%user' in rest):
                    headers = ['%usr' if h == '%user' else h for h in rest[1:]]
                    continue
                if not headers or len(rest) < len(headers) + 1:
                    continue
                cpu_id = rest[0]
                try:
                    metrics = {k: float(v) for k, v in zip(headers, rest[1:])}
                except ValueError:
                    continue
                metrics['time'] = timestamp
                if sample_interval_minutes is not None:
                    b = bucket(timestamp)
                    if last_bucket_by_cpu.get(cpu_id) == b:
                        continue
                    last_bucket_by_cpu[cpu_id] = b
                cpu_data[cpu_id].append(metrics)
    except OSError:
        return {}
    return cpu_data


def parse(sos_dir, sample_interval_minutes=10):
    result = {}
    for day, path in sar_files(sos_dir):
        cpu_stats = parse_sar_cpu(path, sample_interval_minutes=sample_interval_minutes)
        if cpu_stats:
            result[f'day_{day}'] = cpu_stats
    return result


def findings(sos_dir, sample_interval_minutes=10):
    """The Findings strip (the page calls it separately: the day keys of parse() stay the chart's data): per day the
    'all' CPU's samples with iowait over 20% (warn; bad over 40%), steal over 5%, idle under 10% (saturated), counted
    as a share of the day's samples."""
    out = []
    for day, path in sar_files(sos_dir):
        stats = parse_sar_cpu(path, sample_interval_minutes=sample_interval_minutes)
        points = stats.get('all') or []
        if not points:
            continue
        n = len(points)
        iow = [p for p in points if p.get('%iowait', 0) >= 20]
        steal = [p for p in points if p.get('%steal', 0) >= 5]
        busy = [p for p in points if p.get('%idle', 100) <= 10]
        label = f"day {day}"
        if iow:
            peak = max(p['%iowait'] for p in iow)
            out.append(finding('bad' if peak >= 40 else 'warn', f"{label}: I/O wait over 20% in {len(iow)} of {n} samples (peak {peak:g}% at {max(iow, key=lambda p: p['%iowait'])['time']})", "the CPUs sat idle waiting for disks; see the disk latency of the same day", tab='sar', sub_tab='sar_disk', count=len(iow)))
        if steal:
            peak = max(p['%steal'] for p in steal)
            out.append(finding('warn', f"{label}: CPU steal over 5% in {len(steal)} of {n} samples (peak {peak:g}%)", "the hypervisor took CPU time from this guest: an oversubscribed host", count=len(steal)))
        if busy:
            out.append(finding('info', f"{label}: under 10% idle in {len(busy)} of {n} samples", f"from {busy[0]['time']} to {busy[-1]['time']}: the CPUs were saturated", tab='system', sub_tab='processes', count=len(busy)))
    nd = sar_no_data(sos_dir)
    if nd:
        return [nd]
    if not out:
        out.append(finding('good', f"No I/O wait, steal or saturation episode in the {len(sar_files(sos_dir))} sar day{'s' if len(sar_files(sos_dir)) != 1 else ''} of this report"))
    return sort_findings(out)
