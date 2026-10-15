import os
import re

def parse(directory):
    result = {}

    def read_lines(path):
        try:
            with open(path, 'r') as f:
                return f.readlines()
        except Exception:
            return []

    def read_key_value_file(path):
        data = {}
        lines = read_lines(path)
        for line in lines:
            if ':' in line:
                key, value = line.split(':', 1)
                data[key.strip()] = value.strip()
        return data

    def parse_uptime(path):
        try:
            with open(path, 'r') as f:
                line = f.readline().strip()
            match = re.search(
                r"(\d{2}:\d{2}:\d{2})\s+up\s+(.*?),\s+(\d+)\s+user[s]?,\s+load average:\s+([\d.]+),\s+([\d.]+),\s+([\d.]+)",
                line
            )
            if match:
                current_time, uptime_str, users, load1, load5, load15 = match.groups()
                return {
                    "current_time": current_time,
                    "uptime": uptime_str,
                    "users": int(users),
                    "load_average": {
                        "1min": float(load1),
                        "5min": float(load5),
                        "15min": float(load15)
                    }
                }
        except Exception:
            pass
        return {}

    def parse_free(path):
        lines = read_lines(path)
        for line in lines:
            if line.startswith("Mem:"):
                fields = line.split()
                return {
                    "total": round(int(fields[1]) / 1024, 2),
                    "used": round(int(fields[2]) / 1024, 2),
                    "free": round(int(fields[3]) / 1024, 2),
                    "shared": round(int(fields[4]) / 1024, 2),
                    "buff_cache": round(int(fields[5]) / 1024, 2),
                    "available": round(int(fields[6]) / 1024, 2)
                }
        return {}

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    result['hostnamectl'] = read_key_value_file(os.path.join(directory, 'sos_commands', 'host', 'hostnamectl_status'))
    result['uptime'] = parse_uptime(os.path.join(directory, 'uptime'))
    result['cpuinfo'] = read_key_value_file(os.path.join(directory, 'sos_commands', 'processor', 'lscpu'))
    result['free_memory'] = parse_free(os.path.join(directory, 'sos_commands', 'memory', 'free_-m'))

    return result
