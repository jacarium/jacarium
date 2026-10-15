import os
import re


def parse(directory):
    result = {}

    def parse_oom_kills(filepath):
        oom_entries = []
        # Not every sosreport captures the journal (sos_commands/logs/
        # journalctl_--no-pager). That is an ordinary "nothing to show" case,
        # not a read failure, so say so instead of surfacing the OSError text.
        if not os.path.isfile(filepath):
            print(f"[Kernel OOM] Journal not captured in this report, nothing to scan: {filepath}")
            return oom_entries
        try:
            with open(filepath, 'r') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"Failed to read {filepath}: {e}")
            return oom_entries

        start_re = re.compile(r'invoked oom-killer:')
        end_re = re.compile(r'Killed process \d+')

        capturing = False
        current_block = []

        for line in lines:
            if start_re.search(line):
                capturing = True
                current_block = [line]
            elif capturing:
                current_block.append(line)
                if end_re.search(line):
                    oom_entries.append("".join(current_block))
                    capturing = False
                    current_block = []

        return oom_entries

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    result['oom_killer'] = parse_oom_kills(f"{directory}/sos_commands/logs/journalctl_--no-pager")
    return result
