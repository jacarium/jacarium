import os
import re

from parsers.findings import finding, human_bytes, level, no_data, sort_findings

from ._common import report_root

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

    unit_header_re = re.compile(r'^[●○×*] (\S+)(?: - (.*))?$')   # a unit without a description has no ' - ...' part
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
            current_fields = {'description': header_match.group(2) or ''}
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

    directory = report_root(directory)

    path = os.path.join(directory, 'sos_commands/systemd/systemctl_status_--all')
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        cleaned_content = clean_unit_not_found_errors(content)
        units = parse_systemctl_status(cleaned_content)
        result['findings'] = findings_for(units)   # sorts the units worst first too
        result['systemctl'] = {'units': units}
    except Exception:
        result['systemctl'] = {'units': []}
        result['findings'] = findings_for([])   # the no-data finding

    return result

# the order of the units on the page: failed, then the ones in flux, then active, then inactive
UNIT_RANK = [('failed', 0), ('activating', 1), ('deactivating', 1), ('reloading', 1), ('active', 2), ('inactive', 3)]
RE_TASKS = re.compile(r'^(\d+)\s*\(limit:\s*(\d+)\)')
RE_MEM = re.compile(r'^([\d.]+)([KMGT]?)')
RE_MEM_LIMIT = re.compile(r'\b(?:max|limit|high):\s*([\d.]+)([KMGT]?)', re.I)
RE_SINCE = re.compile(r'since\s+(.+?)(?:;\s*(.+))?$')
RE_PID = re.compile(r'^(\d+)')


def unit_rank(unit):
    a = (unit.get('active') or '').lower()
    for word, rank in UNIT_RANK:
        if a.startswith(word):
            return rank
    return 4


def unit_memory_bytes(text):
    """'812.4M' / '1.2G (peak: 1.5G)' -> bytes (the first number, systemd's units)."""
    m = RE_MEM.match((text or '').strip())
    if not m:
        return 0
    return int(float(m.group(1)) * {'': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4}[m.group(2)])


def unit_fields(u):
    """The structured fields the page shows: the load / active / sub states, the unit file and its enablement, since
    when and how long ago, the main PID, the tasks and memory with their limits and meter roles (the shared
    thresholds), the drop-in files, the cgroup lines."""
    active = (u.get('active') or '').strip()
    u['active_state'] = active.split(' ')[0] if active else ''
    u['sub_state'] = active[active.find('(') + 1:active.find(')')] if '(' in active and ')' in active else ''
    m = RE_SINCE.search(active)
    u['since'] = m.group(1).strip() if m else ''
    u['ago'] = (m.group(2) or '').strip() if m else ''
    loaded = (u.get('loaded') or '').strip()
    u['load_state'] = loaded.split(' ')[0] if loaded else ''
    inner = loaded[loaded.find('(') + 1:loaded.rfind(')')] if '(' in loaded else ''
    parts = [p.strip() for p in inner.split(';')] if inner else []
    u['unit_file'] = parts[0] if parts and parts[0].startswith('/') else ''
    u['enablement'] = parts[1] if len(parts) > 1 else ''
    m = RE_PID.match((u.get('main_pid') or u.get('main pid') or '').strip())
    u['pid'] = m.group(1) if m else ''
    m = RE_TASKS.match((u.get('tasks') or '').strip())
    u['tasks_used'] = int(m.group(1)) if m else None
    u['tasks_limit'] = int(m.group(2)) if m else None
    u['tasks_pct'] = round(100 * u['tasks_used'] / u['tasks_limit'], 1) if m and u['tasks_limit'] else None
    u['tasks_role'] = level(u['tasks_pct'], 'tasks') if u['tasks_pct'] is not None else 'muted'
    u['memory_bytes'] = unit_memory_bytes(u.get('memory'))
    u['memory_text'] = human_bytes(u['memory_bytes']) if u['memory_bytes'] else (u.get('memory') or '')
    lm = RE_MEM_LIMIT.search(u.get('memory') or '')
    u['memory_limit'] = int(float(lm.group(1)) * {'': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4}[lm.group(2)]) if lm else None
    u['memory_pct'] = round(100 * u['memory_bytes'] / u['memory_limit'], 1) if u['memory_limit'] else None
    u['memory_role'] = level(u['memory_pct'], 'memory') if u['memory_pct'] is not None else 'muted'
    drop = [ln.strip() for ln in (u.get('drop_in') or '').splitlines() if ln.strip()]
    files = []
    folder = ''
    for ln in drop:
        if ln.startswith('/'):
            folder = ln
        else:
            name = ln.lstrip('└─├─│ ').strip()
            if name:
                files.append(folder + '/' + name if folder else name)
    u['drop_ins'] = files
    u['cgroup_lines'] = [ln.rstrip() for ln in (u.get('cgroup') or '').splitlines() if ln.strip()]
    return u


def findings_for(units):
    """The Findings strip: every failed unit (linked to the Log Viewer with the unit's name), units restarting in a
    loop, units near their task limit, the largest memory users; sorts `units` worst first (rank, memory, name)."""
    out = []
    if not units:
        return [no_data('No systemd unit listing in this report', ['sos_commands/systemd/systemctl_status_--all'], 'sos ran without the systemd plugin, or the capture is empty')]
    for u in units:
        u['rank'] = unit_rank(u)
        unit_fields(u)
    failed = [u for u in units if u['rank'] == 0]
    for u in failed[:10]:
        out.append(finding('bad', f"{u['name']} failed", (u.get('active') or '').strip(), tab='log_collection', sub_tab='log_viewer', query=u['name'].rsplit('.', 1)[0]))
    if len(failed) > 10:
        out.append(finding('bad', f"{len(failed) - 10} more failed units", ', '.join(u['name'] for u in failed[10:20]) + (' …' if len(failed) > 20 else ''), count=len(failed) - 10))
    for u in [u for u in units if 'auto-restart' in (u.get('active') or '')][:5]:
        out.append(finding('warn', f"{u['name']} keeps restarting", (u.get('active') or '').strip(), tab='log_collection', sub_tab='log_viewer', query=u['name'].rsplit('.', 1)[0]))
    for u in units:
        if u['tasks_role'] in ('warn', 'bad'):
            out.append(finding(u['tasks_role'], f"{u['name']} at {u['tasks_used']} of {u['tasks_limit']} tasks", "the unit cannot start another thread or process once TasksMax is reached", tab='system', sub_tab='services', query=u['name']))
        if u['memory_role'] in ('warn', 'bad'):
            out.append(finding(u['memory_role'], f"{u['name']} at {u['memory_pct']:g}% of its memory limit", f"{u['memory_text']} of {human_bytes(u['memory_limit'])}: the kernel kills a process of the unit at the limit", tab='system', sub_tab='services', query=u['name']))
    big = sorted((u for u in units if u['memory_bytes'] >= 2 * 1024 ** 3), key=lambda u: -u['memory_bytes'])
    if big:
        out.append(finding('info', f"{len(big)} unit{'s' if len(big) != 1 else ''} over 2 GiB of memory", ', '.join(f"{u['name']} ({human_bytes(u['memory_bytes'])})" for u in big[:5]) + (' …' if len(big) > 5 else ''), count=len(big)))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"No failed or restarting unit among {len(units)}"))
    units.sort(key=lambda u: (u['rank'], -u['memory_bytes'], u['name']))
    return sort_findings(out)
