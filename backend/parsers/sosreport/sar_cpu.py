import os
from collections import defaultdict

def parse_sar_cpu(file_path, sample_interval_minutes=None):
    cpu_data = defaultdict(list)
    current_headers = []
    last_kept_time_by_cpu = {}

    def time_bucket_key(time_str):
        h, m, _ = map(int, time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return h, m

    try:
        with open(file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                if line.startswith("Average:") and current_headers:
                    break

                if "CPU" in line and "%usr" in line:
                    parts = line.split()
                    current_headers = parts[2:]
                    continue

                if not current_headers or len(line) < 8 or line[2] != ':' or line[5] != ':':
                    continue

                parts = line.split()
                if len(parts) < len(current_headers) + 2:
                    continue

                timestamp = parts[0]
                cpu_id = parts[1]
                values = parts[2:]

                try:
                    metrics = {k: float(v) for k, v in zip(current_headers, values)}
                except ValueError:
                    continue

                metrics['time'] = timestamp

                if sample_interval_minutes is not None:
                    bucket = time_bucket_key(timestamp)
                    if last_kept_time_by_cpu.get(cpu_id) == bucket:
                        continue
                    last_kept_time_by_cpu[cpu_id] = bucket

                cpu_data[cpu_id].append(metrics)

    except FileNotFoundError:
        print(f"File not found: {file_path}")

    return cpu_data


def parse(sos_dir, sample_interval_minutes=10):
    sa_dir = os.path.join(sos_dir, "var/log/sa")
    result = {}
    total_points = 0

    if not os.path.isdir(sa_dir):
        print(f"No sar directory found at {sa_dir}")
        return result

    for entry in sorted(os.listdir(sa_dir)):
        full_path = os.path.join(sa_dir, entry)

        if os.path.isfile(full_path) and entry.startswith('sar') and entry[3:].isdigit():
            day = entry[-2:]
            cpu_stats = parse_sar_cpu(full_path, sample_interval_minutes=sample_interval_minutes)

            if cpu_stats:
                result[f'day_{day}'] = cpu_stats
                for cpu_id, points in cpu_stats.items():
                    total_points += len(points)

    return result