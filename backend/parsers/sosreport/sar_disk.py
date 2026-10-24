"""SAR > Disk: the `sar -d` block of a report's sar text files (tps, rkB/s,
wkB/s, areq-sz, aqu-sz, await, %util per device), one point per sample
interval. sysstat 11 named the columns rd_sec/s, wr_sec/s, avgrq-sz,
avgqu-sz, svctm: they come through under their own names.

Files and the 12-hour clock through _common.sar_files / sar_split (see
sar_cpu.py). Result: {'day_DD': {device: [{'time': 'HH:MM:SS', 'tps': .., ...}]}}
"""
from collections import defaultdict

from parsers.findings import finding, sort_findings

from ._common import open_text, sar_files, sar_no_data, sar_split


def parse_sar_disk(file_path, sample_interval_minutes=None):
    disk_data = defaultdict(list)
    headers = []
    last_bucket_by_disk = {}

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
                if len(rest) >= 2 and rest[0] == 'DEV' and rest[1] == 'tps':
                    headers = rest[1:]
                    continue
                if not headers:
                    continue
                if len(rest) < len(headers) + 1:
                    continue
                disk = rest[0]
                try:
                    metrics = {k: float(v) for k, v in zip(headers, rest[1:])}
                except ValueError:
                    continue
                metrics['time'] = timestamp
                if sample_interval_minutes is not None:
                    b = bucket(timestamp)
                    if last_bucket_by_disk.get(disk) == b:
                        continue
                    last_bucket_by_disk[disk] = b
                disk_data[disk].append(metrics)
    except OSError:
        return {}
    return dict(disk_data)


def parse(sos_dir, sample_interval_minutes=10):
    result = {}
    for day, path in sar_files(sos_dir):
        disk_stats = parse_sar_disk(path, sample_interval_minutes=sample_interval_minutes)
        if disk_stats:
            result[f'day_{day}'] = disk_stats
    return result


def findings(sos_dir, sample_interval_minutes=10):
    """The Findings strip: per day and device, samples with await over 50 ms (warn; bad over 200 ms) and %util over
    90% (info: the device was busy, a problem only with the latency)."""
    out = []
    for day, path in sar_files(sos_dir):
        devs = parse_sar_disk(path, sample_interval_minutes=sample_interval_minutes)
        label = f"day {day}"
        for dev, points in devs.items():
            slow = [p for p in points if p.get('await', 0) >= 50]
            if slow:
                peak = max(p['await'] for p in slow)
                out.append(finding('bad' if peak >= 200 else 'warn', f"{label}: {dev} answered in 50+ ms in {len(slow)} of {len(points)} samples (peak {peak:g} ms at {max(slow, key=lambda p: p['await'])['time']})", "I/O latency the applications saw; the CPUs' iowait of the same day shows who waited", tab='sar', sub_tab='sar_cpu', count=len(slow)))
            busy = [p for p in points if p.get('%util', 0) >= 90]
            if busy and not slow:
                out.append(finding('info', f"{label}: {dev} over 90% busy in {len(busy)} of {len(points)} samples", "saturated but answering in time", count=len(busy)))
    nd = sar_no_data(sos_dir)
    if nd:
        return [nd]
    if not out:
        out.append(finding('good', f"No slow disk in the {len(sar_files(sos_dir))} sar day{'s' if len(sar_files(sos_dir)) != 1 else ''} of this report"))
    return sort_findings(out)
