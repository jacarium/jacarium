import os
import re


def parse(directory):
    result = {}

    def strip_syslog_prefix(line):
        return re.sub(r'^\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+kernel:\s+', '', line)

    def extract_syslog_timestamp(line):
        match = re.match(r'^(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+', line)
        return match.group(1) if match else ''

    def parse_hung_tasks(path):
        try:
            with open(path, 'r') as f:
                lines = f.readlines()
        except Exception:
            return []

        hung_tasks = []
        for i, line in enumerate(lines):
            if 'blocked for more than' in line:
                task_info = {
                    'timestamp': extract_syslog_timestamp(line),
                    'task_line': strip_syslog_prefix(line).strip(),
                    'details': {
                        'task': None,
                        'pid': None,
                        'ppid': None,
                        'state': None,
                        'stack': None,
                        'flags': None,
                        'kernel': None,
                        'call_trace': [],
                        'raw': []
                    }
                }

                match = re.search(r'task (\S+):(\d+) blocked for more than (\d+) seconds', line)
                if match:
                    task_info['details']['task'] = match.group(1)
                    task_info['details']['pid'] = match.group(2)
                    task_info['details']['duration'] = match.group(3)

                context_lines = lines[i:i+50]
                in_call_trace = False
                in_task_flag = False
                kernel_lines = []

                for idx, context_line in enumerate(context_lines):
                    clean_line = strip_syslog_prefix(context_line).rstrip('\n')
                    stripped_line = clean_line.strip()

                    if stripped_line:
                        task_info['details']['raw'].append(stripped_line)

                    if stripped_line.startswith("task:"):
                        meta_match = re.search(
                            # RHEL 8/9 kernels pad the numbers ("pid: 4311 ppid:  4200");
                            # older ones print them tight ("pid:4311 ppid:4200").
                            r'task:(\S+)\s+state:(\S+)\s+stack:\s*(\S+)\s+pid:\s*(\d+)\s+ppid:\s*(\d+)\s+flags:\s*(0x[0-9a-fA-F]+)',
                            stripped_line
                        )
                        if meta_match:
                            task_info['details']['task'] = meta_match.group(1)
                            task_info['details']['state'] = meta_match.group(2)
                            task_info['details']['stack'] = meta_match.group(3)
                            task_info['details']['pid'] = meta_match.group(4)
                            task_info['details']['ppid'] = meta_match.group(5)
                            task_info['details']['flags'] = meta_match.group(6)
                        continue

                    if stripped_line.startswith('Tainted:') or stripped_line.startswith('Linux version'):
                        kernel_lines = [stripped_line]
                        for cont_line in context_lines[idx+1:]:
                            cont_clean = strip_syslog_prefix(cont_line).strip()
                            if cont_clean.startswith('#') or cont_clean.startswith(' ') or cont_clean == '':
                                kernel_lines.append(cont_clean)
                            else:
                                break
                        task_info['details']['kernel'] = "\n".join(kernel_lines).strip()
                        continue

                    if 'Call Trace:' in stripped_line:
                        in_call_trace = True
                        continue

                    if in_call_trace:
                        if (stripped_line.startswith("task:") or
                                stripped_line.startswith('Tainted:') or
                                stripped_line.startswith('Linux version') or
                                'blocked for more than' in stripped_line):
                            in_call_trace = False
                        else:
                            if stripped_line.startswith('<TASK>'):
                                in_task_flag = True
                                continue
                            elif stripped_line.startswith('</TASK>'):
                                in_task_flag = False
                                break

                            if in_task_flag:
                                task_info['details']['call_trace'].append(stripped_line)
                                continue

                hung_tasks.append(task_info)

        return hung_tasks

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    journal_path = f"{directory}/sos_commands/logs/journalctl_--no-pager"
    result['hung_tasks'] = parse_hung_tasks(journal_path)

    return result