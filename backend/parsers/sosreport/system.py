"""System > System Information: the host's identity, CPU, memory, load and
the facts that frame a case (the kernel taint, SELinux, a recent boot), with
the Findings strip first (parsers/findings.py): load per core, memory
pressure, swap in use, a tainted kernel, an estimated `available`.

Captures: sos_commands/host/hostnamectl_status, sos_commands/processor/lscpu,
sos_commands/memory/free_-m (RHEL 7's six-column layout too, through
_common.parse_free), uptime, proc/sys/kernel/tainted,
sos_commands/selinux/sestatus_-b (else etc/selinux/config).
"""
import os
import re

from parsers.findings import finding, no_data, sort_findings

from ._common import first_existing, parse_free as _parse_free, read_lines, read_text, report_root

# the kernel's taint bits (Documentation/admin-guide/tainted-kernels.rst)
TAINT_FLAGS = [
    (0, 'P', 'proprietary module'), (1, 'F', 'force-loaded module'), (2, 'S', 'SMP with an unsafe CPU'), (3, 'R', 'force-unloaded module'),
    (4, 'M', 'machine check exception'), (5, 'B', 'bad page'), (6, 'U', 'user-requested taint'), (7, 'D', 'kernel oops / BUG'),
    (8, 'A', 'ACPI table override'), (9, 'W', 'kernel warning'), (10, 'C', 'staging driver'), (11, 'I', 'firmware workaround'),
    (12, 'O', 'out-of-tree module'), (13, 'E', 'unsigned module'), (14, 'L', 'soft lockup'), (15, 'K', 'live-patched'),
    (16, 'X', 'auxiliary taint'), (17, 'T', 'randomised struct layout'), (18, 'N', 'in-kernel test'),
]
TAINT_SERIOUS = {4, 5, 7, 14}   # a machine check, a bad page, an oops, a soft lockup: the kernel itself hit a fault


def decode_taint(value):
    try:
        v = int(str(value).strip())
    except (TypeError, ValueError):
        return []
    return [{'bit': bit, 'letter': letter, 'text': text} for bit, letter, text in TAINT_FLAGS if v & (1 << bit)]


def read_key_value_file(path):
    data = {}
    for line in read_lines(path):
        if ':' in line:
            key, value = line.split(':', 1)
            data[key.strip()] = value.strip()
    return data


RE_UPTIME = re.compile(r"(\d{1,2}:\d{2}:\d{2})\s+up\s+(.*?),\s+(\d+)\s+users?,\s+load average:\s+([\d.,]+),\s+([\d.,]+),\s+([\d.,]+)")


def parse_uptime(path):
    """`uptime` ("09:31:55 up 23 days,  4:12,  2 users,  load average: 0.10, 0.20, 0.30"); a decimal comma
    (a de_DE host) is accepted."""
    line = read_text(path, 400).strip()
    m = RE_UPTIME.search(line)
    if not m:
        return {}
    current_time, uptime_str, users, load1, load5, load15 = m.groups()
    num = lambda s: float(s.replace(',', '.'))  # noqa: E731
    return {
        'current_time': current_time, 'uptime': uptime_str, 'users': int(users),
        'uptime_seconds': uptime_seconds(uptime_str),
        'load_average': {'1min': num(load1), '5min': num(load5), '15min': num(load15)},
    }


def uptime_seconds(text):
    """'23 days,  4:12' / '1 day, 0:03' / '4:12' / '3 min' -> seconds, or None."""
    if not text:
        return None
    s = 0
    m = re.search(r'(\d+)\s+day', text)
    if m:
        s += int(m.group(1)) * 86400
    rest = text.split('day')[-1] if 'day' in text else text
    m = re.search(r'(\d+):(\d{2})(?!\d)', rest)
    if m:
        s += int(m.group(1)) * 3600 + int(m.group(2)) * 60
    else:
        m = re.search(r'(\d+)\s+min', rest)
        if m:
            s += int(m.group(1)) * 60
        m = re.search(r'(\d+)\s+(?:hr|hour)', rest)
        if m:
            s += int(m.group(1)) * 3600
    return s if re.search(r'\d', text) else None


def selinux_mode(root):
    """'enforcing' / 'permissive' / 'disabled' / '' - the live mode from sestatus, else the configured one."""
    p = first_existing(root, 'sos_commands/selinux/sestatus_-b', 'sos_commands/selinux/sestatus', 'sos_commands/selinux/sestatus_-v')
    if p:
        txt = read_text(p, 4000)
        m = re.search(r'^Current mode:\s*(\w+)', txt, re.M)
        if m:
            return m.group(1).lower()
        if re.search(r'^SELinux status:\s*disabled', txt, re.M):
            return 'disabled'
    p = os.path.join(root, 'etc/selinux/config')
    if os.path.isfile(p):
        m = re.search(r'^SELINUX=(\w+)', read_text(p, 4000), re.M)
        if m:
            return m.group(1).lower()
    return ''


def findings_for(result):
    """The Findings strip: load per core (1x warn, 2x bad), memory available under 20% / 10%, swap over half used,
    the taint (a fault bit is bad, anything else informational), SELinux not enforcing, a boot under a day ago."""
    out = []
    if not result.get('hostnamectl') and not result.get('cpuinfo') and not result.get('free_memory') and not result.get('uptime'):
        return [no_data('No host facts in this report', ['sos_commands/host/hostnamectl_status', 'sos_commands/processor/lscpu', 'sos_commands/memory/free_-m', 'uptime'], 'sos ran without the host / processor / memory plugins, or the report is trimmed')]
    cpus = 0
    try:
        cpus = int(str(result.get('cpuinfo', {}).get('CPU(s)', '0')).split()[0])
    except (ValueError, IndexError):
        cpus = 0
    load = (result.get('uptime') or {}).get('load_average') or {}
    load1 = load.get('1min')
    if load1 is not None and cpus:
        per_core = load1 / cpus
        tail = f"5 min {load.get('5min', 0):g}, 15 min {load.get('15min', 0):g}"
        if per_core >= 2:
            out.append(finding('bad', f"Load {load1:g} on {cpus} CPUs ({per_core:.1f} per core)", tail + ": the run queue is far longer than the CPUs; see which processes take the CPU", tab='system', sub_tab='processes'))
        elif per_core >= 1:
            out.append(finding('warn', f"Load {load1:g} on {cpus} CPUs ({per_core:.1f} per core)", tail + ": every CPU had a task waiting", tab='system', sub_tab='processes'))
    mem = result.get('free_memory') or {}
    total, avail = mem.get('total'), mem.get('available')
    if total and avail is not None:
        share = avail / total
        if share < 0.10:
            out.append(finding('bad', f"Memory: {avail:g} of {total:g} GiB available ({share * 100:.0f}%)", "at the edge of swapping or the OOM killer; see the cgroups and the kernel log", tab='cgroups', sub_tab='cgroups_memory'))
        elif share < 0.20:
            out.append(finding('warn', f"Memory: {avail:g} of {total:g} GiB available ({share * 100:.0f}%)", "little room left for page cache and bursts", tab='cgroups', sub_tab='cgroups_memory'))
        if mem.get('available_estimated'):
            out.append(finding('info', "Available memory is an estimate", "this `free` (procps 3.3.10, RHEL 7) prints no `available` column: free + buffers + cache is shown instead"))
    st, su = mem.get('swap_total'), mem.get('swap_used')
    if st and su is not None:
        sshare = su / st
        if sshare >= 0.5:
            out.append(finding('warn' if sshare < 0.9 else 'bad', f"Swap: {su:g} of {st:g} GiB in use ({sshare * 100:.0f}%)", "the host has been paging; the memory pressure is not new"))
    flags = result.get('taint') or []
    if flags:
        serious = [f for f in flags if f['bit'] in TAINT_SERIOUS]
        names = ', '.join(f"{f['letter']}: {f['text']}" for f in flags)
        if serious:
            out.append(finding('bad', "The kernel is tainted by a fault: " + ', '.join(f['text'] for f in serious), f"taint flags {names}; the kernel log holds the event", tab='kernel', sub_tab='kernel_stack_traces'))
        else:
            out.append(finding('info', "Kernel taint flags: " + ', '.join(f['letter'] for f in flags), names))
    mode = result.get('selinux')
    if mode in ('permissive', 'disabled'):
        out.append(finding('info', f"SELinux is {mode}", "the policy is not enforced on this host"))
    up = (result.get('uptime') or {}).get('uptime_seconds')
    if up is not None and up < 86400:
        when = f"{up / 3600:.1f} h" if up >= 3600 else f"{up // 60:.0f} min"
        out.append(finding('info', f"Booted {when} before the report", "a recent reboot: what led to it is in the rotated logs and the kernel log", tab='kernel', sub_tab='kernel_stack_traces'))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', "No load, memory, swap or kernel-taint problem in this report"))
    return sort_findings(out)


def parse(directory):
    root = report_root(directory)
    result = {}
    result['hostnamectl'] = read_key_value_file(os.path.join(root, 'sos_commands', 'host', 'hostnamectl_status'))
    result['uptime'] = parse_uptime(os.path.join(root, 'uptime'))
    result['cpuinfo'] = read_key_value_file(os.path.join(root, 'sos_commands', 'processor', 'lscpu'))
    # GiB for the page; procps 3.3.10 (RHEL 7) has no `available` column: the shared parser estimates it
    result['free_memory'] = _parse_free(os.path.join(root, 'sos_commands', 'memory', 'free_-m'), unit='GiB')
    result['taint'] = decode_taint(read_text(os.path.join(root, 'proc', 'sys', 'kernel', 'tainted'), 40))
    result['selinux'] = selinux_mode(root)
    result['findings'] = findings_for(result)
    return result
