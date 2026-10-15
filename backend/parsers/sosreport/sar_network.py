import os
import re
from collections import defaultdict

def parse_sar_iface(file_path, sample_interval_minutes=None):
    iface_data = defaultdict(list)
    current_headers = []
    last_kept_bucket_by_iface = {}

    def time_bucket_key(time_str):
        h, m, _ = map(int, time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return f"{h:02}:{m:02}"

    header_re = re.compile(r'^\d{2}:\d{2}:\d{2}\s+IFACE\s+\S+')
    average_line_re = re.compile(r'^Average:\s+(\S+)')
    time_re = re.compile(r'^\d{2}:\d{2}:\d{2}')

    try:
        with open(file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                if header_re.match(line):
                    parts = re.split(r'\s+', line)
                    current_headers = parts[2:]
                    continue

                if average_line_re.match(line):
                    current_headers = []
                    continue

                if not current_headers or not time_re.match(line):
                    continue

                parts = re.split(r'\s+', line)
                if len(parts) < len(current_headers) + 2:
                    continue

                timestamp, iface, *values = parts

                bucket = time_bucket_key(timestamp) if sample_interval_minutes else None
                if sample_interval_minutes and last_kept_bucket_by_iface.get(iface) == bucket:
                    continue
                last_kept_bucket_by_iface[iface] = bucket

                try:
                    metrics = {metric: float(val) for metric, val in zip(current_headers, values)}
                except ValueError:
                    continue

                iface_data[iface].append({
                    'time': timestamp,
                    **metrics
                })

    except FileNotFoundError:
        print(f"File not found: {file_path}")

    return dict(iface_data)


def parse(sos_dir, sample_interval_minutes=10):
    sa_dir = os.path.join(sos_dir, "var/log/sa")
    result = {}
    total_points = 0

    if not os.path.isdir(sa_dir):
        print(f"No sar directory found at {sa_dir}")
        return result

    for entry in sorted(os.listdir(sa_dir)):
        full_path = os.path.join(sa_dir, entry)
        if os.path.isfile(full_path) and re.fullmatch(r'sar\d{2}', entry):
            day = entry[-2:]
            iface_stats = parse_sar_iface(full_path, sample_interval_minutes=sample_interval_minutes)
            if iface_stats:
                result[f'day_{day}'] = iface_stats
                for iface, points in iface_stats.items():
                    total_points += len(points)

    return result
