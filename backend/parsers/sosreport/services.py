import os
import re

def clean_unit_not_found_errors(text):
    error_re = re.compile(r'Unit \S+ could not be found\.\n')
    warning_re = re.compile(r'Warning: The unit file, source configuration file or drop-ins of \S+ changed on disk\. Run \'systemctl daemon-reload\' to reload units\.\n')

    text = error_re.sub('', text)
    text = warning_re.sub('', text)

    lines = [line for line in text.splitlines()]

    return "\n".join(lines)

def parse_systemctl_status(text):
    units = []
    unit_block = []
    valid_keys = {
        "loaded", "active", "transient", "drop_in", "cgroup", "tasks", "memory",
        "cpu", "io", "status", "description", "unit", "load_state", "active_state",
        "until", "where", "what", "docs", "triggers", "follows", "device",
        "triggeredby", "process", "main pid",
    }

    multiline_keys = {"drop_in", "cgroup", "docs"}

    unit_header_re = re.compile(r'^[●○×*] (\S+) - (.+)$')
    field_re = re.compile(r'^\s*(\w[\w\s-]*):\s*(.*)$')
    junk_line_re = re.compile(r'^Unit \S+ could not be found\.$')

    current_unit_name = None
    capturing = False
    current_fields = {}
    last_field = None

    def finalize_unit():
        nonlocal current_unit_name, unit_block, current_fields
        if not current_unit_name:
            return
        unit_data = {
            "name": current_unit_name,
            "raw": "\n".join(unit_block)
        }
        for key, val in current_fields.items():
            k = key.strip().lower().replace("-", "_")
            if k not in valid_keys:
                continue
            if isinstance(val, list):
                unit_data[k] = "\n".join(val)
            else:
                unit_data[k] = val.strip()
        units.append(unit_data)
        current_unit_name = None
        unit_block = []
        current_fields = {}

    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]

        if junk_line_re.match(line):
            i += 1
            continue

        header_match = unit_header_re.match(line)

        if header_match:
            if capturing:
                finalize_unit()
            current_unit_name = header_match.group(1)
            unit_block = [line]
            capturing = True
            current_fields = {}
            last_field = None
        elif capturing:
            unit_block.append(line)
            field_match = field_re.match(line)

            if field_match:
                key, value = field_match.groups()
                key = key.strip().lower().replace("-", "_")

                if key in multiline_keys:
                    current_fields[key] = [value.rstrip()]
                else:
                    current_fields[key] = value.rstrip()
                last_field = key
            elif last_field:
                stripped = line.lstrip()
                if last_field in multiline_keys:
                    if stripped or isinstance(current_fields.get(last_field), list):
                        if isinstance(current_fields[last_field], list):
                            current_fields[last_field].append(stripped)
                        else:
                            current_fields[last_field] = [current_fields[last_field], stripped]
                elif line.startswith(" "):
                    if isinstance(current_fields[last_field], list):
                        current_fields[last_field].append(stripped)
                    else:
                        current_fields[last_field] = [current_fields[last_field], stripped]
            else:
                if "●" in line:
                    parts = line.split("●")
                    for part in parts:
                        if part.strip():
                            possible_header = "● " + part.strip()
                            if unit_header_re.match(possible_header):
                                lines.insert(i + 1, possible_header)
                                break
        i += 1

    if capturing:
        finalize_unit()

    return units


def parse(directory):
    result = {}

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    path = os.path.join(directory, 'sos_commands/systemd/systemctl_status_--all')
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        cleaned_content = clean_unit_not_found_errors(content)
        result['systemctl'] = {'units': parse_systemctl_status(cleaned_content)}
    except Exception as e:
        print(f"Error reading systemctl status: {e}")
        result['systemctl'] = {'units': []}

    return result
