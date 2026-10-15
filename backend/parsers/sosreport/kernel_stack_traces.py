import os
import re


def parse(directory):
    result = {}

    def strip_syslog_prefix(line):
        return re.sub(r'^\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+kernel:\s+', '', line)

    def extract_syslog_timestamp(line):
        match = re.match(r'^(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+', line)
        return match.group(1) if match else ''

    def parse_kernel_traces(path):
        try:
            with open(path, 'r') as f:
                lines = f.readlines()
        except Exception:
            return []

        traces = []
        current_trace = []
        current_timestamp = ''
        in_trace = False

        for line in lines:
            if '------------[ cut here ]------------' in line:
                if current_trace:
                    traces.append(parse_trace(current_trace, current_timestamp))
                    current_trace = []
                current_timestamp = extract_syslog_timestamp(line)
                in_trace = True
                current_trace.append(strip_syslog_prefix(line))
                continue

            if in_trace:
                current_trace.append(strip_syslog_prefix(line))
                if '---[ end trace' in line:
                    traces.append(parse_trace(current_trace, current_timestamp))
                    current_trace = []
                    in_trace = False

        return traces

    def parse_trace(lines, timestamp):
        trace_data = {
            'timestamp': timestamp,
            'warning': '',
            'cpu': '',
            'pid': '',
            'file': '',
            'function': '',
            'code': [],
            'call_trace': [],
            'comm': '',
            'kernel_version': '',
            'hardware': ''
        }

        for line in lines:
            if 'WARNING: CPU:' in line:
                match = re.search(r'WARNING: CPU: (\d+) PID: (\d+) at ([^:]+):(\d+) (\S+)', line)
                if match:
                    trace_data['cpu'] = match.group(1)
                    trace_data['pid'] = match.group(2)
                    trace_data['file'] = f"{match.group(3)}:{match.group(4)}"
                    trace_data['function'] = match.group(5)
                    trace_data['warning'] = line.strip()
            elif line.strip().startswith('CPU:') and 'Comm:' in line:
                comm_match = re.search(r'Comm:\s+(\S+)', line)
                if comm_match:
                    trace_data['comm'] = comm_match.group(1)
                version_match = re.search(r'(\d+\.\d+\.\d+-[^ ]+)', line)
                if version_match:
                    trace_data['kernel_version'] = version_match.group(1)
            elif 'Hardware name:' in line:
                trace_data['hardware'] = line.strip().split('Hardware name:')[-1].strip()
            elif line.strip().startswith('Code:'):
                trace_data['code'].append(line.strip())
            elif re.match(r'\s+<TASK>', line) or 'Call Trace:' in line:
                continue
            elif re.match(r'^\s*\??\s*\S+\+0x[0-9a-f]+(?:/\S+)?', line):
                trace_data['call_trace'].append(line.strip())

        return trace_data

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner
    result['stack_traces'] = {
        'traces': parse_kernel_traces(f"{directory}/sos_commands/logs/journalctl_--no-pager")
    }
    return result
