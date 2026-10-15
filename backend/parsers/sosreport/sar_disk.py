import os
import re
from collections import defaultdict

def parse_sar_disk(file_path, sample_interval_minutes=None):
    disk_data = defaultdict(list)
    current_headers = []
    last_kept_time_by_disk = {}

    def time_bucket_key(time_str):
        h, m, _ = map(int, time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return f"{h:02}:{m:02}"

    header_re = re.compile(r'^\d{2}:\d{2}:\d{2}\s+DEV\s+tps')
    average_re = re.compile(r'^Average:')
    time_re = re.compile(r'^\d{2}:\d{2}:\d{2}')

    try:
        with open(file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                if average_re.match(line) and current_headers:
                    break

                if header_re.match(line):
                    parts = line.split()
                    current_headers = parts[2:]
                    continue

                if not current_headers or not time_re.match(line):
                    continue

                parts = line.split()
                if len(parts) < 2 + len(current_headers):
                    continue

                timestamp = parts[0]
                disk = parts[1]
                values = parts[2:]

                try:
                    metrics = {
                        metric: float(val)
                        for metric, val in zip(current_headers, values)
                    }
                except ValueError:
                    print(f"Skipping line due to ValueError: {line}")
                    continue

                metrics['time'] = timestamp

                if sample_interval_minutes is not None:
                    bucket = time_bucket_key(timestamp)
                    if last_kept_time_by_disk.get(disk) == bucket:
                        continue
                    last_kept_time_by_disk[disk] = bucket

                disk_data[disk].append(metrics)

    except FileNotFoundError:
        print(f"File not found: {file_path}")

    return dict(disk_data)


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

            disk_stats = parse_sar_disk(full_path, sample_interval_minutes=sample_interval_minutes)

            if disk_stats:
                result[f'day_{day}'] = disk_stats
                for disk_id, points in disk_stats.items():
                    total_points += len(points)

    return result
