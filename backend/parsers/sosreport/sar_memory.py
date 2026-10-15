import os
import re

def parse_sar_memory(file_path, sample_interval_minutes=None):
    mem_data = []
    headers = []
    last_kept_bucket = None

    def time_bucket_key(time_str):
        h, m, _ = map(int, time_str.split(':'))
        if sample_interval_minutes:
            m = (m // sample_interval_minutes) * sample_interval_minutes
        return f"{h:02}:{m:02}"

    average_re = re.compile(r'^Average:')
    time_re = re.compile(r'^\d{2}:\d{2}:\d{2}(?:\s+[AP]M)?')

    try:
        with open(file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                if average_re.match(line) and headers:
                    break

                if time_re.match(line) and 'kbmemfree' in line:
                    parts = re.split(r'\s+', line)
                    headers = parts[1:]
                    continue

                if not headers:
                    continue

                if time_re.match(line):
                    parts = re.split(r'\s+', line)
                    if len(parts) < len(headers) + 1:
                        continue

                    timestamp = parts[0]
                    values = parts[1:]

                    bucket = time_bucket_key(timestamp) if sample_interval_minutes else None
                    if sample_interval_minutes and bucket == last_kept_bucket:
                        continue
                    last_kept_bucket = bucket

                    try:
                        metrics = {
                            metric: float(val)
                            for metric, val in zip(headers, values)
                        }
                        mem_data.append({
                            'time': timestamp,
                            **metrics
                        })
                    except ValueError as e:
                        print(f"Skipping bad line: {line} ({e})")

    except FileNotFoundError:
        print(f"File not found: {file_path}")

    return mem_data


def parse(directory, sample_interval_minutes=10):
    sa_dir = os.path.join(directory, "var/log/sa")
    result = {}
    total_points = 0

    if not os.path.isdir(sa_dir):
        print(f"No sar directory found at {sa_dir}")
        return result

    for entry in sorted(os.listdir(sa_dir)):
        full_path = os.path.join(sa_dir, entry)

        if os.path.isfile(full_path) and re.fullmatch(r'sar\d{2}', entry):
            day = entry[-2:]
            mem_stats = parse_sar_memory(full_path, sample_interval_minutes=sample_interval_minutes)

            if mem_stats:
                result[f'day_{day}'] = mem_stats
                total_points += len(mem_stats)

    return result
