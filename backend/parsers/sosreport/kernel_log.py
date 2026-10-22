"""The kernel log scanner behind the three kernel diagnostics tabs
(kernel_stack_traces, kernel_hung_task, kernel_oom_killer).

One pass over every kernel log a sosreport can hold, in order of trust:

  sos_commands/logs/journalctl_--no-pager        the full journal
  sos_commands/logs/journalctl_--no-pager_--boot  the current boot only
  sos_commands/kernel/dmesg                       [seconds since boot]
  sos_commands/kernel/dmesg_-T                    [wall-clock] (human dmesg)
  var/log/messages, messages-YYYYMMDD, messages.N(.gz), var/log/dmesg*,
  var/log/kern.log*                                rsyslog, RHEL 7 and others

Each line's prefix is normalised (syslog "Oct 12 09:31:55 host kernel:",
ISO / short-iso journals, "[ 1234.567890]", "[Mon Oct 12 09:31:55 2026]",
an optional "<N>" facility and an optional printk "[ 1234.5]" stamp), the
kernel lines are fed to three small state machines (stack traces, hung
tasks, OOM kills) and the events are deduplicated across sources (the same
WARNING sits in the journal, the boot journal and dmesg). dmesg's seconds
since boot are mapped to wall time from the report's `date` and `uptime`
(or /proc/stat btime) when present.

Everything is streamed line by line: no file is read whole, the number of
lines per file and of events per kind are capped, every regex runs once per
line and a malformed line never raises. The parsed result for a directory
is cached by the sources' sizes and mtimes, so the three tabs share one
scan.

Report content is untrusted text: nothing here interprets it beyond
regexes, and the templates escape everything they print.
"""
import glob
import gzip
import hashlib
import os
import re
from collections import Counter, OrderedDict
from datetime import datetime, timedelta

MAX_LINES_PER_FILE = 3_000_000
MAX_EVENTS_PER_KIND = 500
MAX_BLOCK_LINES = 4000
MAX_FRAMES = 200
MAX_OOM_TASKS = 2000

MONTHS = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}

# --- line prefixes -----------------------------------------------------------
RE_SYSLOG = re.compile(r'^(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+(?P<time>\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+(?P<host>\S+)\s+(?P<tag>[^:\s]+?)(?:\[\d+\])?:\s?(?P<msg>.*)$')
RE_ISO = re.compile(r'^(?P<date>\d{4}-\d{2}-\d{2})[T ](?P<time>\d{2}:\d{2}:\d{2})(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+(?P<host>\S+)\s+(?P<tag>[^:\s]+?)(?:\[\d+\])?:\s?(?P<msg>.*)$')
RE_DMESG = re.compile(r'^\[\s*(?P<secs>\d+\.\d+)\]\s?(?P<msg>.*)$')
RE_DMESG_T = re.compile(r'^\[(?:[A-Z][a-z]{2}) (?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2}) (?P<time>\d{2}:\d{2}:\d{2}) (?P<year>\d{4})\]\s?(?P<msg>.*)$')
RE_FACILITY = re.compile(r'^<\d{1,3}>')
RE_PRINTK = re.compile(r'^\[\s*\d+\.\d+\]\s?')

# --- events -------------------------------------------------------------------
RE_HUNG = re.compile(r'INFO: task (?P<comm>.+?):(?P<pid>\d+) blocked for more than (?P<secs>\d+) seconds')
RE_TASK_META = re.compile(r'^task:(?P<comm>\S+)\s+state:(?P<state>\S+)\s+stack:\s*(?P<stack>\S+)\s+pid:\s*(?P<pid>\d+)(?:\s+tgid:\s*(?P<tgid>\d+))?\s+ppid:\s*(?P<ppid>\d+)\s+flags:\s*(?P<flags>0x[0-9a-fA-F]+)')
RE_TASK_META_OLD = re.compile(r'^task:\s*(?P<addr>[0-9a-f]+)\s+ti:\s*[0-9a-f]+\s+task\.ti:\s*[0-9a-f]+')
RE_TASK_RHEL7 = re.compile(r'^(?P<comm>\S+)\s+(?P<state>[DRSTZX])\s+(?:[0-9a-f]{8,16}\s+)?\d+\s+(?P<pid>\d+)\s+(?P<ppid>\d+)\s+(?P<flags>0x[0-9a-fA-F]+)\s*$')
RE_TAINT = re.compile(r'Tainted:\s*(?P<flags>[A-Z ]+?)\s*-+|Tainted:\s*(?P<flags2>[A-Z]+(?: [A-Z]+)*)')
RE_NOT_TAINTED = re.compile(r'Not tainted')
RE_KERNEL_VER = re.compile(r'(\d+\.\d+\.\d+[-.][\w.+-]+)')
RE_CPU_LINE = re.compile(r'^CPU:\s*(?P<cpu>\d+)\s+(?:UID:\s*\d+\s+)?PID:\s*(?P<pid>\d+)\s+Comm:\s*(?P<comm>.+?)\s+(?P<taint>Not tainted|Tainted:.*?)\s+(?P<kernel>\S+)\s*(?:#\d+.*)?$')
RE_FRAME = re.compile(r'^\s*(?P<q>\?\s+)?(?:\[<[0-9a-fx]+>\]\s+)?(?P<sym>[A-Za-z_$.][\w.$]*(?:\+0x[0-9a-f]+/0x[0-9a-f]+)?)(?:\s+\[(?P<mod>[\w-]+)\])?\s*$')
RE_HEX_DUMP = re.compile(r'^(?:[0-9a-f]{16}\s*){2,}$')
RE_WARNING = re.compile(r'^WARNING:\s*(?:CPU:\s*(?P<cpu>\d+)\s+PID:\s*(?P<pid>\d+)\s+)?at\s+(?P<file>\S+?)(?::(?P<line>\d+))?\s+(?P<fn>\S+)(?:\s+\[(?P<mod>[\w-]+)\])?')
RE_RIP = re.compile(r'^(?:RIP|PC is at|pc|NIP|EIP):\s*(?:\d{4}:)?(?:\[<[0-9a-fx]+>\]\s*)?(?P<sym>[A-Za-z_$.][\w.$]*(?:\+0x[0-9a-f]+/0x[0-9a-f]+)?)(?:\s+\[(?P<mod>[\w-]+)\])?')
RE_SOFT_LOCKUP = re.compile(r'soft lockup - (?P<rest>CPU#\d+ stuck for \d+s! \[.*?\])')
RE_HARD_LOCKUP = re.compile(r'hard LOCKUP(?: on cpu (?P<cpu>\d+))?')
RE_RCU_STALL = re.compile(r'(?:rcu:\s*)?INFO:\s*(?P<rest>rcu_\w+ (?:self-)?detected (?:expedited )?stalls? on (?:CPUs?|tasks?)(?:/tasks?)?.*|rcu_\w+ detected .*|rcu_\w+ kthread starved .*)')
RE_MODULE_ITEM = re.compile(r'^(?P<name>[\w-]+)(?:\((?P<flags>[A-Z+-]+)\))?$')
RE_CODE_FAULT = re.compile(r'^<[0-9a-f]{2}>$')

TAINT_TEXT = OrderedDict([
    ('P', 'proprietary module'), ('G', ''), ('F', 'force-loaded module'), ('R', 'force-unloaded module'),
    ('M', 'machine check'), ('B', 'bad page'), ('U', 'user-requested taint'), ('D', 'died (earlier oops)'),
    ('A', 'ACPI table override'), ('W', 'earlier warning'), ('C', 'staging driver'), ('I', 'firmware bug workaround'),
    ('O', 'out-of-tree module'), ('E', 'unsigned module'), ('L', 'earlier soft lockup'), ('K', 'live-patched'),
    ('X', 'auxiliary taint'), ('T', 'randstruct'), ('N', 'in-kernel test'), ('S', 'SMP unsafe'),
])

SCHEDULER_FRAMES = ('__schedule', 'schedule', 'schedule_timeout', 'io_schedule', 'io_schedule_timeout', 'schedule_preempt_disabled',
                    'bit_wait', 'bit_wait_io', '__wait_on_bit', 'out_of_line_wait_on_bit', 'wait_on_page_bit', '__wait_on_buffer',
                    'wait_for_completion', 'wait_for_common', 'rpc_wait_bit_killable', '__mutex_lock', 'mutex_lock', '__mutex_lock_slowpath',
                    'rwsem_down_read_slowpath', 'rwsem_down_write_slowpath', 'down_read', 'down_write', 'down', '__down', '__down_common',
                    'msleep', 'schedule_hrtimeout_range', 'schedule_hrtimeout_range_clock', 'do_wait_for_common', '__wait_for_common',
                    'folio_wait_bit_common', 'folio_wait_bit', '__folio_lock', 'wait_on_bit_io', 'wait_woken', 'rq_qos_wait', '__blkdev_issue_discard')

CONSTRAINT_TEXT = {
    'CONSTRAINT_NONE': 'The whole machine ran out of memory (CONSTRAINT_NONE): the allocation found no free pages and no reclaimable memory anywhere, so the kernel killed the task with the highest badness score. Not a cgroup limit.',
    'CONSTRAINT_MEMCG': 'A memory cgroup hit its own limit (CONSTRAINT_MEMCG): the container or service, not the whole machine, ran out of memory. The kernel killed the largest task charged to that cgroup; its memory limit or its growth is the lever.',
    'CONSTRAINT_CPUSET': 'The allocation was restricted to a cpuset (CONSTRAINT_CPUSET): the NUMA nodes this task may use ran out while others may still have had memory free.',
    'CONSTRAINT_MEMORY_POLICY': 'The allocation was restricted by a NUMA memory policy (CONSTRAINT_MEMORY_POLICY): the nodes the policy allowed ran out while others may still have had memory free.',
}

SOURCE_GLOBS = [
    ('sos_commands/logs/journalctl_--no-pager', 'journal'),
    ('sos_commands/logs/journalctl_--no-pager_--boot', 'journal (boot)'),
    ('sos_commands/logs/journalctl_--no-pager_--catalog_--boot', 'journal (boot)'),
    ('sos_commands/kernel/dmesg', 'dmesg'),
    ('sos_commands/kernel/dmesg_-T', 'dmesg -T'),
    ('var/log/messages', 'messages'),
    ('var/log/messages-*', 'messages (rotated)'),
    ('var/log/messages.*', 'messages (rotated)'),
    ('var/log/kern.log', 'kern.log'),
    ('var/log/kern.log.*', 'kern.log (rotated)'),
    ('var/log/dmesg', 'var/log/dmesg'),
    ('var/log/dmesg.*', 'var/log/dmesg (rotated)'),
]

_cache = {}


# =============================================================================
# Public entry points
# =============================================================================
def report_root(directory):
    """A report extracted into a single wrapper directory is unwrapped, like
    the other sosreport parsers do."""
    try:
        entries = os.listdir(directory)
    except OSError:
        return directory
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            return inner
    return directory


def scan(directory):
    """All kernel events of a report: {'traces', 'hung', 'oom', 'sources',
    'sources_missing', 'capped', 'boot_time'}. Cached per directory while the
    sources' sizes and mtimes stay the same."""
    directory = report_root(directory)
    sources = find_sources(directory)
    key = (directory, tuple((p, s, m) for p, _, s, m in sources))
    hit = _cache.get(directory)
    if hit and hit[0] == key:
        return hit[1]
    result = _scan(directory, sources)
    _cache.clear()
    _cache[directory] = (key, result)
    return result


def find_sources(directory):
    """[(path, label, size, mtime)] of the kernel logs present, in trust order."""
    found = []
    seen = set()
    for pattern, label in SOURCE_GLOBS:
        for path in sorted(glob.glob(os.path.join(directory, pattern))):
            if path in seen or not os.path.isfile(path):
                continue
            seen.add(path)
            try:
                st = os.stat(path)
            except OSError:
                continue
            found.append((path, label, st.st_size, int(st.st_mtime)))
    return found


# =============================================================================
# Reading and normalising lines
# =============================================================================
def iter_lines(path):
    """Yield (line_no, text) from a plain or gzip log, never raising."""
    opener = gzip.open if path.endswith('.gz') else open
    try:
        with opener(path, 'rt', encoding='utf-8', errors='replace') as f:
            for n, line in enumerate(f, 1):
                if n > MAX_LINES_PER_FILE:
                    break
                yield n, line.rstrip('\r\n')
    except (OSError, EOFError, ValueError):
        return


class Clock:
    """Turns the various prefixes into wall-clock datetimes. The year of a
    syslog stamp comes from the report's collection date (a month after
    the collection month belongs to the previous year); dmesg seconds map
    through the boot time when the report gives one."""

    def __init__(self, directory):
        self.collected = _collection_date(directory)
        self.boot_time = _boot_time(directory, self.collected)

    def syslog(self, mon, day, time):
        month = MONTHS.get(mon)
        if not month:
            return None
        year = self.collected.year if self.collected else datetime.now().year
        if self.collected and month > self.collected.month:
            year -= 1
        try:
            return datetime.strptime(f"{year}-{month:02d}-{int(day):02d} {time}", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None

    def dmesg(self, secs):
        if self.boot_time is None:
            return None
        try:
            return self.boot_time + timedelta(seconds=float(secs))
        except (ValueError, OverflowError):
            return None


def _read_small(path, limit=4096):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read(limit)
    except OSError:
        return ''


def _collection_date(directory):
    for rel in ('date', 'sos_commands/date/date', 'sos_commands/date/date_--utc'):
        text = _read_small(os.path.join(directory, rel)).strip()
        for fmt in ("%a %b %d %H:%M:%S %Z %Y", "%a %b %d %H:%M:%S %Y", "%a %d %b %Y %H:%M:%S %p %Z", "%a %d %b %H:%M:%S %Z %Y"):
            try:
                return datetime.strptime(re.sub(r'\s+', ' ', text), fmt)
            except ValueError:
                continue
        m = re.search(r'(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})', text)
        if m:
            return datetime(*(int(x) for x in m.groups()))
    # the journal header: "-- Logs begin at Sat 2026-09-19 10:17:55 UTC, end at Mon 2026-10-12 14:29:58 UTC. --"
    head = _read_small(os.path.join(directory, 'sos_commands/logs/journalctl_--no-pager'), 400)
    m = re.search(r'end at \w+ (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})', head)
    if m:
        return datetime(*(int(x) for x in m.groups()))
    return None


RE_UPTIME = re.compile(r'up\s+(?:(?P<days>\d+)\s+days?,\s*)?(?:(?P<h>\d+):(?P<m>\d{2})|(?P<min>\d+)\s+min)')


def _boot_time(directory, collected):
    stat = _read_small(os.path.join(directory, 'proc/stat'), 200000)
    m = re.search(r'^btime (\d+)$', stat, re.M)
    if m:
        try:
            return datetime.utcfromtimestamp(int(m.group(1)))
        except (ValueError, OverflowError, OSError):
            pass
    proc_uptime = _read_small(os.path.join(directory, 'proc/uptime')).split()
    if proc_uptime and collected:
        try:
            return collected - timedelta(seconds=float(proc_uptime[0]))
        except ValueError:
            pass
    for rel in ('uptime', 'sos_commands/host/uptime', 'sos_commands/general/uptime'):
        m = RE_UPTIME.search(_read_small(os.path.join(directory, rel)))
        if m and collected:
            days = int(m.group('days') or 0)
            if m.group('min'):
                secs = int(m.group('min')) * 60
            else:
                secs = int(m.group('h')) * 3600 + int(m.group('m')) * 60
            return collected - timedelta(days=days, seconds=secs)
    return None


def normalise(raw, clock):
    """One raw log line -> (datetime|None, seconds-since-boot|None, msg,
    is_kernel, indented). msg is the kernel message without its prefix and
    without surrounding whitespace; indented says whether it was indented
    (a stack frame, a hex dump, a continuation). Lines that are not kernel
    lines (another process in the journal, a journal header) come back
    with is_kernel False."""
    line = raw.strip()
    if not line or line.startswith('-- '):
        return None, None, '', False, False
    m = RE_SYSLOG.match(line)
    if m:
        if not m.group('tag').startswith('kernel'):
            return None, None, '', False, False
        return (clock.syslog(m.group('mon'), m.group('day'), m.group('time')), None) + _strip_msg(m.group('msg'))
    m = RE_ISO.match(line)
    if m:
        if not m.group('tag').startswith('kernel'):
            return None, None, '', False, False
        try:
            ts = datetime.strptime(f"{m.group('date')} {m.group('time')}", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            ts = None
        return (ts, None) + _strip_msg(m.group('msg'))
    m = RE_DMESG.match(line)
    if m:
        return (clock.dmesg(m.group('secs')), float(m.group('secs'))) + _strip_msg(m.group('msg'))
    m = RE_DMESG_T.match(line)
    if m:
        try:
            ts = datetime.strptime(f"{m.group('year')}-{MONTHS.get(m.group('mon'), 1):02d}-{int(m.group('day')):02d} {m.group('time')}", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            ts = None
        return (ts, None) + _strip_msg(m.group('msg'))
    # a bare kernel line (var/log/dmesg on some systems, or a continuation)
    return (None, None) + _strip_msg(raw.rstrip('\r\n'))


def _strip_msg(msg):
    """-> (msg, is_kernel=True, indented)"""
    msg = RE_FACILITY.sub('', msg)
    msg = RE_PRINTK.sub('', msg)
    stripped = msg.strip()
    return stripped, True, msg != msg.lstrip() and bool(stripped)


# =============================================================================
# The scan
# =============================================================================
def _scan(directory, sources):
    clock = Clock(directory)
    traces, hung, oom = [], [], []
    capped = False
    labels = []
    for path, label, _, _ in sources:
        labels.append(label if label not in labels else None)
        found = _scan_file(path, label, clock)
        for kind, bucket in (('traces', traces), ('hung', hung), ('oom', oom)):
            for ev in found[kind]:
                if len(bucket) >= MAX_EVENTS_PER_KIND * 4:
                    capped = True
                    break
                bucket.append(ev)
    traces = _dedupe(traces)
    hung = _dedupe(hung)
    oom = _dedupe(oom)
    if any(len(b) > MAX_EVENTS_PER_KIND for b in (traces, hung, oom)):
        capped = True
    return {
        'traces': traces[:MAX_EVENTS_PER_KIND], 'hung': hung[:MAX_EVENTS_PER_KIND], 'oom': oom[:MAX_EVENTS_PER_KIND],
        'sources': [l for l in labels if l], 'capped': capped, 'boot_time': clock.boot_time,
        'collected': clock.collected,
    }


def _scan_file(path, label, clock):
    traces, hung, oom = [], [], []
    current = None  # the active collector
    for n, raw in iter_lines(path):
        try:
            ts, secs, msg, is_kernel, indented = normalise(raw, clock)
        except Exception:
            continue
        if not is_kernel:
            continue
        if current is not None:
            if current.feed(msg, raw, indented):
                continue
            # the collector refused the line: the block is over
            _finish(current, traces, hung, oom)
            current = None
        current = _start(msg, raw, ts, secs, label, n)
        if current is None:
            continue
    if current is not None:
        _finish(current, traces, hung, oom)
    return {'traces': traces, 'hung': hung, 'oom': oom}


def _start(msg, raw, ts, secs, label, n):
    if 'invoked oom-killer' in msg:
        return OomCollector(msg, raw, ts, secs, label, n)
    if RE_HUNG.search(msg):
        return HungCollector(msg, raw, ts, secs, label, n)
    if TraceCollector.starts(msg):
        return TraceCollector(msg, raw, ts, secs, label, n)
    return None


def _finish(collector, traces, hung, oom):
    try:
        ev = collector.result()
    except Exception:
        return
    if not ev:
        return
    {'trace': traces, 'hung': hung, 'oom': oom}[collector.kind].append(ev)


class Collector:
    kind = ''

    def __init__(self, msg, raw, ts, secs, label, n):
        self.lines = [msg]
        self.raw = [raw.strip()]
        self.ts = ts
        self.secs = secs
        self.source = label
        self.line_no = n
        self.frames = []
        self.in_trace = False

    def add(self, msg, raw):
        if len(self.lines) >= MAX_BLOCK_LINES:
            return False
        self.lines.append(msg)
        self.raw.append(raw.strip())
        return True

    def add_frame(self, m):
        if len(self.frames) >= MAX_FRAMES:
            return
        sym = m.group('sym')
        self.frames.append({
            'text': ('? ' if m.group('q') else '  ') + sym + (f" [{m.group('mod')}]" if m.group('mod') else ''),
            'symbol': sym.split('+', 1)[0], 'unreliable': bool(m.group('q')),
            'module': m.group('mod') or '', 'fault': False, 'blocked': False,
        })

    def base(self):
        return {'ts': self.ts, 'secs': self.secs, 'source': self.source, 'line_no': self.line_no, 'raw': self.raw}


TRACE_META = ('Modules linked in:', 'CPU:', 'Hardware name:', 'Workqueue:', 'RIP:', 'RSP:', 'RAX:', 'RDX:', 'RBP:', 'R10:', 'R13:', 'FS:', 'CS:',
              'CR2:', 'DR0:', 'DR3:', 'PKRU:', 'Code:', 'Call Trace:', 'Stack:', 'Kernel Offset', 'task:', 'pc :', 'lr :', 'sp :', 'x29:', 'NIP:',
              'LR:', 'REGS:', 'TRAP:', 'MSR:', 'GPR', 'NMI backtrace for cpu', 'Sending NMI', 'Mem-Info', 'irq event stamp', 'hardirqs last',
              'softirqs last', 'EFLAGS:', 'EIP:', 'ESP:', 'EAX:', 'ESI:', 'DS:', 'traps:', 'Oops:', '#PF:', 'PGD ', 'P4D ', 'PUD ', 'PMD ',
              'note:', 'Exception stack', 'Hardware name', 'Process ', 'Pid:', 'invalid opcode:', 'rcu:', 'RCU', 'dump_stack', 'Dumping ftrace',
              'Kernel panic', 'CPU features:', 'pstate:', 'Internal error:', 'Trace/breakpoint trap', 'Stack trace:', 'pc:', 'ra:', 'epc:',
              '(detected by', 'Backtrace', 'Unhandled fault', 'Shutting down cpus', 'Rebooting in', 'Workqueue', 'Showing stack', 'Thread')
# (text, type, where): 'start' = the message begins with it, 'in' = it
# appears in the message's first 60 characters (a "watchdog: " or "rcu: "
# prefix before it). The order matters: the first match names the type.
TRACE_STARTS = (
    ('------------[ cut here ]------------', 'warning', 'start'),
    ('watchdog: BUG: soft lockup', 'soft_lockup', 'start'), ('NMI watchdog: BUG: soft lockup', 'soft_lockup', 'start'), ('BUG: soft lockup', 'soft_lockup', 'start'),
    ('Watchdog detected hard LOCKUP', 'hard_lockup', 'in'),
    ('rcu: INFO:', 'rcu_stall', 'start'), ('INFO: rcu_', 'rcu_stall', 'start'),
    ('Kernel panic - not syncing', 'panic', 'start'),
    ('WARNING:', 'warning', 'start'), ('refcount_t:', 'warning', 'start'),
    ('BUG:', 'bug', 'start'), ('kernel BUG at', 'bug', 'start'), ('list_del corruption', 'bug', 'start'), ('list_add corruption', 'bug', 'start'),
    ('Oops:', 'oops', 'start'), ('general protection fault', 'oops', 'start'), ('Unable to handle kernel', 'oops', 'start'), ('unable to handle kernel', 'oops', 'start'),
    ('kernel tried to execute NX-protected page', 'oops', 'start'), ('Internal error: Oops', 'oops', 'start'), ('double fault:', 'oops', 'start'),
    ('unregister_netdevice: waiting for', 'netdev_wait', 'start'),
    ('mce: [Hardware Error]', 'mce', 'start'), ('Machine check events logged', 'mce', 'start'),
)
TYPE_LABELS = {'warning': 'WARNING', 'bug': 'BUG', 'oops': 'Oops', 'soft_lockup': 'soft lockup', 'hard_lockup': 'hard lockup',
               'rcu_stall': 'RCU stall', 'panic': 'panic', 'netdev_wait': 'netdev wait', 'mce': 'hardware error', 'other': 'trace'}
TYPE_SEVERITY = {'warning': 'warning', 'bug': 'critical', 'oops': 'critical', 'soft_lockup': 'critical', 'hard_lockup': 'critical',
                 'rcu_stall': 'warning', 'panic': 'critical', 'netdev_wait': 'info', 'mce': 'critical', 'other': 'info'}
# a BUG/soft-lockup header seen while a block is open belongs to that block (not a new event)
TRACE_CONTINUATIONS = ('WARNING:', 'BUG:', 'Oops:', 'kernel BUG at', 'general protection fault', 'Unable to handle', 'unable to handle', 'Kernel panic')


class TraceCollector(Collector):
    kind = 'trace'

    @staticmethod
    def match(msg):
        for text, key, where in TRACE_STARTS:
            if (msg.startswith(text) if where == 'start' else text in msg[:60]):
                return key
        return None

    @staticmethod
    def starts(msg):
        return TraceCollector.match(msg) is not None and 'blocked for more than' not in msg

    def __init__(self, msg, raw, ts, secs, label, n):
        super().__init__(msg, raw, ts, secs, label, n)
        self.type_key = 'other'
        self.header = ''
        self.meta = {'cpu': '', 'pid': '', 'comm': '', 'kernel': '', 'hardware': '', 'taint': None, 'file': '', 'line': '', 'function': '',
                     'rip': '', 'rip_mod': '', 'modules': [], 'code': [], 'registers': [], 'workqueue': ''}
        self.seen_frames = False
        self.closed = False
        self.classify(msg)

    def classify(self, msg):
        """The block's type: the first header names it ("cut here" does not,
        the next line does); a BUG followed by its Oops line stays a BUG; a
        lockup or panic header wins over anything."""
        key = TraceCollector.match(msg)
        if key is None or msg.startswith('------------[ cut here'):
            return
        if self.type_key == 'other':
            self.type_key = key
        elif key in ('soft_lockup', 'hard_lockup', 'panic'):
            self.type_key = key
        elif self.type_key == 'warning' and key in ('bug', 'oops'):
            self.type_key = key
        if not self.header:
            self.header = msg

    def feed(self, msg, raw, indented=False):
        if self.closed:
            return False
        if msg.startswith('------------[ cut here ]------------') and self.seen_frames:
            return False
        if 'invoked oom-killer' in msg or RE_HUNG.search(msg):
            return False
        if msg.startswith('---[ end trace') or msg.startswith('---[ end Kernel panic'):
            self.closed = True
            return self.add(msg, raw)
        if msg.startswith(TRACE_CONTINUATIONS) and not self.header:
            self.classify(msg)
            return self.add(msg, raw)
        if msg.startswith(TRACE_CONTINUATIONS) and self.header and not self.seen_frames and len(self.lines) <= 8:
            self.classify(msg)
            return self.add(msg, raw)
        if self.seen_frames and TraceCollector.starts(msg):
            return False  # a new header after this block's frames: the next event
        if msg.startswith(('<TASK>', '</TASK>', '<IRQ>', '</IRQ>', '<NMI>', '</NMI>', '<EOI>', '</EOI>')):
            return self.add(msg, raw)
        if msg.startswith('Call Trace:') or msg.startswith('Call trace:'):
            self.in_trace = True
            return self.add(msg, raw)
        fm = RE_FRAME.match(msg)
        if fm and (self.in_trace or self.seen_frames):
            self.seen_frames = True
            self.add_frame(fm)
            return self.add(msg, raw)
        if RE_HEX_DUMP.match(msg):
            return self.add(msg, raw)
        if msg.startswith(TRACE_META) or indented or msg.startswith('(') or RE_SOFT_LOCKUP.search(msg) or RE_RCU_STALL.search(msg):
            if msg.startswith('RIP:') or msg.startswith('pc :') or msg.startswith('NIP:'):
                m = RE_RIP.match(msg)
                if m and not self.meta['rip']:
                    self.meta['rip'] = m.group('sym')
                    self.meta['rip_mod'] = m.group('mod') or ''
            return self.add(msg, raw)
        if self.seen_frames or len(self.lines) > 1:
            return False
        return self.add(msg, raw)

    def result(self):
        meta = self.meta
        for msg in self.lines:
            if msg.startswith('Modules linked in:') and not meta['modules']:
                for item in msg[len('Modules linked in:'):].split():
                    m = RE_MODULE_ITEM.match(item)
                    if m:
                        meta['modules'].append({'name': m.group('name'), 'flags': m.group('flags') or ''})
            elif msg.startswith('CPU:') and 'Comm:' in msg and not meta['comm']:
                m = RE_CPU_LINE.match(msg)
                if m:
                    meta['cpu'], meta['pid'], meta['comm'] = m.group('cpu'), m.group('pid'), m.group('comm').strip()
                    meta['taint'] = parse_taint(m.group('taint'))
                    meta['kernel'] = m.group('kernel')
                else:
                    cm = re.search(r'Comm:\s+(\S+)', msg)
                    if cm:
                        meta['comm'] = cm.group(1)
                    vm = RE_KERNEL_VER.search(msg)
                    if vm:
                        meta['kernel'] = vm.group(1)
                    meta['taint'] = parse_taint(msg)
            elif msg.startswith('Hardware name:') and not meta['hardware']:
                meta['hardware'] = msg[len('Hardware name:'):].strip()
            elif msg.startswith('Workqueue:') and not meta['workqueue']:
                meta['workqueue'] = msg[len('Workqueue:'):].strip()
            elif msg.startswith('Code:'):
                meta['code'] = [{'text': p, 'fault': bool(RE_CODE_FAULT.match(p))} for p in msg[5:].split()]
            elif re.match(r'^(RSP|RAX|RDX|RBP|R10|R13|FS|CS|CR2|DR0|DR3|EFLAGS):', msg):
                meta['registers'].append(msg)
        header = self.header or self.lines[0]
        title = header
        if self.type_key == 'warning':
            m = RE_WARNING.search(header)
            if m:
                meta['file'], meta['line'], meta['function'] = m.group('file'), m.group('line') or '', m.group('fn')
                if m.group('mod'):
                    meta['function'] += f" [{m.group('mod')}]"
                meta['cpu'] = meta['cpu'] or (m.group('cpu') or '')
                meta['pid'] = meta['pid'] or (m.group('pid') or '')
                title = meta['function']
            else:
                title = header[len('WARNING:'):].strip() if header.startswith('WARNING:') else header
        elif self.type_key == 'soft_lockup':
            m = RE_SOFT_LOCKUP.search(header)
            title = m.group('rest') if m else header
        elif self.type_key == 'rcu_stall':
            m = RE_RCU_STALL.search(header)
            title = m.group('rest') if m else header
            for msg in self.lines[1:6]:
                cm = re.match(r'^(?:rcu:\s*)?(\d+)-[.O]{4}:', msg)
                if cm and title.endswith(('CPU', 'CPUs', 'CPUs/tasks')):
                    title += f" {cm.group(1)}"
                jm = re.search(r'\(t=(\d+) jiffies', msg)
                if jm:
                    title += f" (t={jm.group(1)} jiffies)"
                    break
        elif self.type_key in ('bug', 'oops'):
            title = re.sub(r'^(BUG:|Oops:)\s*', '', header)
        elif self.type_key == 'panic':
            title = header.replace('Kernel panic - not syncing:', '').strip() or header
        if meta['rip'] and not meta['function']:
            meta['function'] = meta['rip'] + (f" [{meta['rip_mod']}]" if meta['rip_mod'] else '')
        fault_symbol = (meta['rip'] or meta['function']).split('+', 1)[0].split(' ', 1)[0]
        marked = False
        for f in self.frames:
            if not marked and fault_symbol and f['symbol'] == fault_symbol and not f['unreliable']:
                f['fault'] = True
                marked = True
        if not marked and fault_symbol and not meta['rip']:
            pass
        # the group key: type + title with the volatile numbers removed (a
        # soft lockup's "stuck for 22s", a stall's jiffies, addresses) + the
        # reliable frames, so the same trace at another moment is one row
        key_title = meta['function'] if self.type_key == 'warning' else title
        key_title = re.sub(r'\d+s!', 'Ns!', key_title)
        key_title = re.sub(r't=\d+ jiffies', 't=N jiffies', key_title)
        key_title = re.sub(r'0x[0-9a-f]+|\b[0-9a-f]{8,16}\b', 'ADDR', key_title)
        group_key = (self.type_key, key_title, tuple((f['symbol'], f['module']) for f in self.frames if not f['unreliable']))
        ev = self.base()
        ev.update({
            'type_key': self.type_key, 'type_label': TYPE_LABELS.get(self.type_key, 'trace'), 'severity': TYPE_SEVERITY.get(self.type_key, 'info'),
            'header': header, 'title': title[:300], 'cpu': meta['cpu'], 'pid': meta['pid'], 'comm': meta['comm'], 'kernel': meta['kernel'],
            'hardware': meta['hardware'], 'taint': meta['taint'] or {'flags': '', 'text': ''}, 'file': meta['file'], 'line': meta['line'],
            'function': meta['function'], 'modules': meta['modules'], 'rip': meta['rip'], 'frames': self.frames, 'code': meta['code'],
            'registers': meta['registers'], 'workqueue': meta['workqueue'], 'group_key': group_key, 'body': _body(self.lines),
        })
        return ev


class HungCollector(Collector):
    kind = 'hung'

    def __init__(self, msg, raw, ts, secs, label, n):
        super().__init__(msg, raw, ts, secs, label, n)
        m = RE_HUNG.search(msg)
        self.comm, self.pid, self.duration = m.group('comm'), m.group('pid'), int(m.group('secs'))
        self.meta = {'state': '', 'stack_ptr': '', 'ppid': '', 'flags': '', 'tgid': '', 'kernel': '', 'taint': None}
        self.seen_task = False

    def feed(self, msg, raw, indented=False):
        if RE_HUNG.search(msg) or 'invoked oom-killer' in msg or msg.startswith('------------[ cut here'):
            return False
        if msg.startswith('Tainted:') or msg.startswith('Not tainted'):
            self.meta['taint'] = parse_taint(msg)
            vm = RE_KERNEL_VER.search(msg)
            if vm:
                self.meta['kernel'] = vm.group(1)
            return self.add(msg, raw)
        if msg.startswith('"echo 0 > /proc/sys/kernel/hung_task') or 'hung_task_timeout_secs' in msg or msg.startswith('task:'):
            m = RE_TASK_META.match(msg)
            if m:
                self.meta.update({'state': m.group('state'), 'stack_ptr': m.group('stack'), 'ppid': m.group('ppid'), 'flags': m.group('flags'), 'tgid': m.group('tgid') or ''})
                self.comm = m.group('comm') or self.comm
                self.pid = m.group('pid') or self.pid
            elif RE_TASK_META_OLD.match(msg):
                self.meta['state'] = self.meta['state'] or 'D'
            if msg.startswith('task:'):
                self.seen_task = True
            return self.add(msg, raw)
        if msg.startswith(('Call Trace:', 'Call trace:', '<TASK>', '</TASK>', '<IRQ>', '</IRQ>', 'Workqueue:', 'INFO: lockdep', 'Showing all locks', 'Kernel panic')):
            self.in_trace = True
            return self.add(msg, raw)
        if RE_HEX_DUMP.match(msg):
            return self.add(msg, raw)
        fm = RE_FRAME.match(msg)
        if fm and (self.in_trace or self.seen_task):
            self.add_frame(fm)
            return self.add(msg, raw)
        m7 = RE_TASK_RHEL7.match(msg)
        if m7 and not self.seen_task:
            # RHEL 7: "kworker/u16:3   D ffff88085fc13140     0  8821      2 0x00000080"
            self.meta.update({'state': m7.group('state'), 'ppid': m7.group('ppid'), 'flags': m7.group('flags')})
            self.pid = m7.group('pid') or self.pid
            self.seen_task = True
            return self.add(msg, raw)
        if indented and not fm:
            return self.add(msg, raw)
        if msg.startswith(('Future hung task reports are suppressed', 'Kernel panic - not syncing: hung_task')):
            return self.add(msg, raw)
        return False

    def result(self):
        blocked_in = _blocked_in(self.frames)
        for f in self.frames:
            if blocked_in and f['symbol'] == blocked_in['symbol'] and not f['unreliable']:
                f['blocked'] = True
                break
        ev = self.base()
        ev.update({
            'comm': self.comm, 'pid': self.pid, 'duration': self.duration, 'state': self.meta['state'] or 'D', 'stack_ptr': self.meta['stack_ptr'],
            'ppid': self.meta['ppid'], 'flags': self.meta['flags'], 'tgid': self.meta['tgid'], 'kernel': self.meta['kernel'],
            'taint': self.meta['taint'] or {'flags': '', 'text': ''}, 'frames': self.frames, 'blocked_in': blocked_in,
            'group_key': (self.comm, self.pid, tuple((f['symbol'], f['module']) for f in self.frames if not f['unreliable'])),
            'body': _body(self.lines),
        })
        return ev


def _blocked_in(frames):
    """The first reliable frame after the scheduler/wait frames: where the
    task is actually stuck (nfs_wait_on_request, xfs_log_force, ...)."""
    candidates = [f for f in frames if not f['unreliable']]
    for f in candidates:
        if f['symbol'] in SCHEDULER_FRAMES or f['symbol'].startswith(('__schedule', 'schedule_', 'wait_', '__wait', 'prepare_to_wait', 'finish_wait', '__down', 'down_', '__mutex', 'mutex_', 'rwsem_', '__rwsem', 'rt_mutex', '_raw_spin', 'bit_wait', 'folio_wait', '__folio', 'wait_on', '__wait_on', 'rpc_wait', 'io_schedule', 'out_of_line', 'var_wake', 'woken_wake', 'autoremove', 'default_wake', '__pfx')):
            continue
        return {'symbol': f['symbol'], 'module': f['module'], 'text': f['symbol'] + (f" [{f['module']}]" if f['module'] else '')}
    if candidates:
        f = candidates[-1]
        return {'symbol': f['symbol'], 'module': f['module'], 'text': f['symbol'] + (f" [{f['module']}]" if f['module'] else '')}
    return None


RE_OOM_HEADER = re.compile(r'^(?P<comm>.+?) invoked oom-killer:\s*gfp_mask=(?P<gfp>0x[0-9a-f]+)(?:\((?P<flags>[^)]*)\))?,\s*(?:nodemask=\S+,\s*)?order=(?P<order>-?\d+),\s*oom_score_adj=(?P<adj>-?\d+)')
RE_OOM_KILLED = re.compile(r'(?:Out of memory(?: \(oom_kill_allocating_task\))?|Memory cgroup out of memory|Out of memory \(.*?\)): Killed process (?P<pid>\d+) \((?P<comm>.+?)\)(?P<rest>.*)$')
RE_OOM_KILLED_OLD = re.compile(r'^Killed process (?P<pid>\d+)(?:, UID \d+,)? \((?P<comm>.+?)\)(?P<rest>.*)$')
RE_OOM_KILL_CHOICE = re.compile(r'Out of memory: Kill process (?P<pid>\d+) \((?P<comm>.+?)\) score (?P<score>-?\d+)')
RE_OOM_CONSTRAINT = re.compile(r'oom-kill:constraint=(?P<constraint>\w+),nodemask=(?P<nodemask>[^,]*),cpuset=(?P<cpuset>[^,]*),mems_allowed=(?P<mems>[^,]*),(?P<rest>.*)$')
RE_OOM_END = re.compile(r'Out of memory and no killable processes|oom_reaper: reaped process|Kill process \d+ .* failed|Killed process \d+')
RE_KV_KB = re.compile(r'(\w[\w-]*):\s*(-?\d+)\s*kB')
RE_KV_PAGES = re.compile(r'(\w[\w-]*):(\d+)\b')
RE_PAGES_RAM = re.compile(r'^(\d+) pages RAM')
RE_ZONE_LINE = re.compile(r'^Node \d+ (?:DMA|DMA32|Normal|Movable|HighMem|Device)\b')
RE_SWAP = re.compile(r'^(Free|Total) swap\s*=\s*(\d+)\s*kB')
RE_MEMCG_USAGE = re.compile(r'^memory: usage (\d+)kB, limit (\d+)kB')
RE_MEMCG_STATS = re.compile(r'^Memory cgroup stats for (\S+?):?\s*$')
RE_TASKS_HEADER = re.compile(r'^\[\s*pid\s*\]\s+(?P<cols>.+)$')
RE_TASK_ROW = re.compile(r'^\[\s*(?P<pid>\d+)\]\s+(?P<rest>.+)$')


class OomCollector(Collector):
    kind = 'oom'

    def __init__(self, msg, raw, ts, secs, label, n):
        super().__init__(msg, raw, ts, secs, label, n)
        self.kills = []
        self.choice = None
        self.constraint = None
        self.mem = {}
        self.memcg = {}
        self.tasks = []
        self.task_cols = None
        self.tasks_total = 0
        self.trigger = {'comm': '', 'pid': '', 'cpu': '', 'gfp_mask': '', 'gfp_flags': '', 'order': '', 'oom_score_adj': ''}
        self.header_info = {'kernel': '', 'taint': None, 'hardware': ''}
        m = RE_OOM_HEADER.match(msg)
        if m:
            self.trigger.update({'comm': m.group('comm').strip(), 'gfp_mask': m.group('gfp'), 'gfp_flags': (m.group('flags') or '').replace('|', ' | '),
                                 'order': m.group('order'), 'oom_score_adj': m.group('adj')})
        self.done = False

    def feed(self, msg, raw, indented=False):
        if self.done:
            return False
        if 'invoked oom-killer' in msg or RE_HUNG.search(msg) or msg.startswith('------------[ cut here'):
            return False
        ok = self.add(msg, raw)
        if not ok:
            return False
        if msg.startswith('CPU:') and 'Comm:' in msg and not self.trigger['pid']:
            m = RE_CPU_LINE.match(msg)
            if m:
                self.trigger['cpu'], self.trigger['pid'] = m.group('cpu'), m.group('pid')
                self.trigger['comm'] = self.trigger['comm'] or m.group('comm').strip()
                self.header_info['kernel'] = m.group('kernel')
                self.header_info['taint'] = parse_taint(m.group('taint'))
        elif msg.startswith('Hardware name:'):
            self.header_info['hardware'] = msg[len('Hardware name:'):].strip()
        elif msg.startswith('Call Trace:') or msg.startswith('Call trace:'):
            self.in_trace = True
        elif self.in_trace and RE_FRAME.match(msg) and not msg.startswith(('Mem-Info', 'Node ')):
            self.add_frame(RE_FRAME.match(msg))
        elif msg.startswith('Mem-Info') or msg.startswith('Tasks state') or msg.startswith('Node ') or msg.startswith('memory:') or msg.startswith('swap:'):
            self.in_trace = False
            if msg.startswith('Mem-Info') or msg.startswith('Tasks state'):
                pass
            self._mem_line(msg)
        else:
            self._mem_line(msg)
        km = RE_OOM_KILLED.search(msg) or (RE_OOM_KILLED_OLD.match(msg) if msg.startswith('Killed process') else None)
        if km:
            self.kills.append(self._kill(km))
            if 'oom_group' not in (self.constraint or {}).get('rest', '') and len(self.kills) >= 1:
                self.done = True
        elif RE_OOM_KILL_CHOICE.search(msg):
            self.choice = RE_OOM_KILL_CHOICE.search(msg).groupdict()
        elif RE_OOM_END.search(msg):
            self.done = True
        return True

    def _mem_line(self, msg):
        m = RE_OOM_CONSTRAINT.search(msg)
        if m:
            d = m.groupdict()
            rest = {}
            for part in d['rest'].split(','):
                if '=' in part:
                    k, v = part.split('=', 1)
                    rest[k] = v
                elif part:
                    rest[part] = True
            self.constraint = {'name': d['constraint'], 'nodemask': d['nodemask'], 'cpuset': d['cpuset'], 'mems': d['mems'],
                               'cgroup': rest.get('task_memcg') or rest.get('oom_memcg') or '', 'oom_memcg': rest.get('oom_memcg') or '',
                               'global': bool(rest.get('global_oom')), 'task': rest.get('task') or '', 'rest': d['rest']}
            return
        m = RE_MEMCG_USAGE.match(msg)
        if m:
            self.memcg['usage_kb'] = int(m.group(1))
            self.memcg['limit_kb'] = int(m.group(2))
            return
        m = RE_MEMCG_STATS.match(msg)
        if m:
            self.memcg['path'] = m.group(1)
            return
        m = RE_PAGES_RAM.match(msg)
        if m:
            self.mem['ram_kb'] = int(m.group(1)) * 4
            return
        m = RE_SWAP.match(msg)
        if m:
            self.mem[('swap_free_kb' if m.group(1) == 'Free' else 'swap_total_kb')] = int(m.group(2))
            return
        if msg.startswith('Node ') and 'kB' in msg:
            # "Node 0 active_anon:...kB ..." carries the node totals; the zone
            # lines ("Node 0 DMA32 free:...kB min:...kB ...") only add the free pages
            zone = RE_ZONE_LINE.match(msg)
            for k, v in RE_KV_KB.findall(msg):
                if zone and k != 'free':
                    continue
                key = 'node_' + k
                self.mem[key] = self.mem.get(key, 0) + int(v)
            return
        if msg.startswith('anon ') or msg.startswith('file ') or msg.startswith('kernel_stack ') or msg.startswith('slab '):
            parts = msg.split()
            if len(parts) == 2 and parts[1].isdigit():
                self.memcg['stat_' + parts[0]] = int(parts[1]) // 1024
            return
        m = RE_TASKS_HEADER.match(msg)
        if m:
            self.task_cols = m.group('cols').split()
            return
        m = RE_TASK_ROW.match(msg)
        if m and self.task_cols:
            self.tasks_total += 1
            if len(self.tasks) < MAX_OOM_TASKS:
                vals = m.group('rest').split(None, len(self.task_cols) - 1)
                row = {'pid': int(m.group('pid'))}
                for col, val in zip(self.task_cols, vals):
                    row[col] = val
                self.tasks.append(row)
            return
        if ':' in msg and ' ' in msg and not msg.startswith('[') and len(self.lines) < 60:
            # Mem-Info pages: "active_anon:7012345 inactive_anon:812345 isolated_anon:0"
            for k, v in RE_KV_PAGES.findall(msg):
                if k in ('active_anon', 'inactive_anon', 'active_file', 'inactive_file', 'unevictable', 'dirty', 'writeback', 'slab_reclaimable',
                         'slab_unreclaimable', 'mapped', 'shmem', 'pagetables', 'free', 'free_pcp', 'free_cma', 'kernel_misc_reclaimable', 'sec_pagetables'):
                    self.mem['pages_' + k] = int(v) * 4

    def _kill(self, km):
        d = {'pid': km.group('pid'), 'comm': km.group('comm'), 'rest': km.group('rest')}
        for k, v in RE_KV_KB.findall(km.group('rest')):
            d[k.lower()] = int(v)
        um = re.search(r'UID:(\d+)', km.group('rest'))
        d['uid'] = um.group(1) if um else ''
        am = re.search(r'oom_score_adj:(-?\d+)', km.group('rest'))
        d['oom_score_adj'] = am.group(1) if am else ''
        return d

    def result(self):
        no_kill = not self.kills
        if no_kill:
            # a block that never got to a kill (log truncated, or "no killable processes"): still an event, without a victim
            self.kills.append({'pid': '', 'comm': '', 'rest': '', 'uid': '', 'oom_score_adj': ''})
        ev = self.base()
        ev.update({
            'no_kill': no_kill,
            'trigger': self.trigger, 'kills': self.kills, 'choice': self.choice, 'constraint': self.constraint, 'mem': self.mem, 'memcg': self.memcg,
            'tasks': self.tasks, 'tasks_total': self.tasks_total, 'frames': self.frames, 'kernel': self.header_info['kernel'],
            'taint': self.header_info['taint'] or {'flags': '', 'text': ''}, 'hardware': self.header_info['hardware'],
            'group_key': ('oom', self.kills[0]['pid'], self.kills[0]['comm']), 'body': _body(self.lines),
        })
        return ev


# =============================================================================
# Shared helpers
# =============================================================================
def parse_taint(text):
    """'Tainted: G           OE     -------  ---' -> {'flags': 'G OE', 'text': 'O: out-of-tree module, E: unsigned module'}"""
    if not text:
        return {'flags': '', 'text': ''}
    if RE_NOT_TAINTED.search(text):
        return {'flags': '', 'text': 'not tainted'}
    m = RE_TAINT.search(text)
    if not m:
        return {'flags': '', 'text': ''}
    flags = (m.group('flags') or m.group('flags2') or '').split()
    letters = [c for group in flags for c in group]
    parts = [f"{c}: {TAINT_TEXT[c]}" for c in letters if c in TAINT_TEXT and TAINT_TEXT[c]]
    return {'flags': ' '.join(flags), 'text': ', '.join(parts)}


def _body(lines):
    """The event's text with the volatile bits (addresses, jiffies, trace ids) removed: the dedupe key."""
    text = '\n'.join(lines)
    text = re.sub(r'0x[0-9a-f]{8,}', '0x', text)
    text = re.sub(r'\b[0-9a-f]{16}\b', 'ADDR', text)
    text = re.sub(r'end trace [0-9a-f]+', 'end trace', text)
    return hashlib.sha1(text.encode('utf-8', 'replace')).hexdigest()


def _dedupe(events):
    """The same event from several sources is one event with every source
    listed. Two events are the same when their bodies match and their wall
    times are within 2 seconds; a dmesg stamp mapped through the boot time
    (which `uptime` only gives to the minute) gets 90 seconds; an event
    without a wall time (dmesg on a report without a boot time) matches by
    body alone. The journal is scanned first, so its stamp is the one kept."""
    out = []
    by_body = {}
    for ev in events:
        same = None
        for cand in by_body.get(ev['body'], []):
            a, b = cand['ts'], ev['ts']
            tolerance = 90 if (cand.get('secs') is not None or ev.get('secs') is not None) else 2
            if a is None or b is None or abs((a - b).total_seconds()) <= tolerance:
                same = cand
                break
        if same is not None:
            if ev['source'] not in same['sources']:
                same['sources'].append(ev['source'])
            if same['ts'] is None and ev['ts'] is not None:
                same['ts'] = ev['ts']
            continue
        ev['sources'] = [ev['source']]
        by_body.setdefault(ev['body'], []).append(ev)
        out.append(ev)
    out.sort(key=lambda e: (e['ts'] or datetime.min, e['secs'] or 0, e['line_no']))
    return out


def fmt_ts(ev):
    """'Oct 12 09:31:55' for display, '[ 1234.567]' when only dmesg seconds are known."""
    if ev.get('ts'):
        return ev['ts'].strftime('%b %d %H:%M:%S')
    if ev.get('secs') is not None:
        return f"[{ev['secs']:.3f}]"
    return ''


def sort_ts(ev):
    if ev.get('ts'):
        return ev['ts'].strftime('%Y-%m-%dT%H:%M:%S')
    if ev.get('secs') is not None:
        return f"0000-boot+{ev['secs']:014.3f}"
    return ''


def human_kb(kb):
    """1234 -> '1.2 MB' (kB in, a short decimal out); '' for None."""
    if kb is None or kb == '':
        return ''
    try:
        kb = float(kb)
    except (TypeError, ValueError):
        return ''
    if kb < 1024:
        return f"{kb:.0f} kB"
    mb = kb / 1024
    if mb < 1024:
        return f"{mb:.1f} MB" if mb < 100 else f"{mb:.0f} MB"
    gb = mb / 1024
    return f"{gb:.1f} GB"


def timeline(events, label):
    """Events -> {label, buckets: [{label, count}], max, first, last}: per
    day when the span is over two days, per hour otherwise, at most 60
    buckets (wider buckets when the span is long)."""
    stamps = sorted(e['ts'] for e in events if e.get('ts'))
    if not stamps:
        return None
    first, last = stamps[0], stamps[-1]
    span = (last - first).total_seconds()
    if span <= 2 * 86400:
        unit = 3600
        start = first.replace(minute=0, second=0, microsecond=0)
        n = int((last - start).total_seconds() // unit) + 1
        fmt = '%b %d %H:00'
    else:
        unit = 86400
        start = first.replace(hour=0, minute=0, second=0, microsecond=0)
        n = int((last - start).total_seconds() // unit) + 1
        fmt = '%b %d'
    while n > 60:
        unit *= 2
        n = int((last - start).total_seconds() // unit) + 1
    counts = [0] * n
    for s in stamps:
        counts[min(n - 1, int((s - start).total_seconds() // unit))] += 1
    buckets = [{'label': (start + timedelta(seconds=i * unit)).strftime(fmt), 'count': c} for i, c in enumerate(counts)]
    return {'label': label, 'buckets': buckets, 'max': max(counts) if counts else 0,
            'first': start.strftime(fmt), 'last': (start + timedelta(seconds=(n - 1) * unit)).strftime(fmt)}


def top(counter, n=8):
    return [{'name': name, 'count': count} for name, count in counter.most_common(n)]


def taint_summary(events):
    c = Counter()
    text = {}
    for e in events:
        t = e.get('taint') or {}
        if t.get('flags'):
            c[t['flags']] += 1
            text[t['flags']] = t.get('text', '')
    if not c:
        return {'flags': '', 'text': ''}
    flags = c.most_common(1)[0][0]
    return {'flags': flags, 'text': text.get(flags, '')}
