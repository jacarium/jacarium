"""Shared pieces of the sosreport parsers.

Every parser of this package reads the same kind of report, so what one
parser gets wrong about a report's layout, the others get wrong too. The
helpers here hold the knowledge once:

  report_root     the report's own directory (a sosreport unpacks into one
                  nested directory; a parser receives the directory the
                  user picked)
  read_text       a capture's text, with the odd undecodable byte replaced
                  (a command line or a device name is not always UTF-8)
  first_existing  the first of several capture paths that exists (sos has
                  moved and renamed files across versions)
  parse_free      `free -m` of procps 3.3.10 (RHEL 7: buffers and cached
                  as two columns, no `available`) and of procps 3.3.11+
                  (RHEL 8/9/10: buff/cache and available), by header name
  parse_ps_file   `ps auxwwwm` / `ps auxZww` (the thread rows of -m, the
                  LABEL column of -Z), one copy for Processes and the two
                  Control Groups tabs
  sar_files       the sar text files of a report: var/log/sa/sarDD (the sa2
                  cron job's, when it runs) and sos_commands/sar/sarDD (what
                  sos itself writes from the saDD binaries)
  sar_split       a sar line into its 24-hour time and its tokens, whether
                  the host printed `00:10:01` or `12:10:01 AM`
  report_year     the year the report was taken (the `date` capture), for
                  syslog timestamps that carry none
  lvm_table       a pvs / vgs / lvs report into rows by header, right-aligned
                  values wider than their header included

Report content is untrusted text: nothing here interprets it beyond
splitting and regexes.
"""
import os
import re
from datetime import datetime


ROOT_MARKERS = ('sos_commands', 'sos_reports', 'version.txt', 'proc', 'var', 'etc', 'sys')


def report_root(directory):
    """The report's own directory: the directory itself when it holds a
    report's top-level entries (sos_commands, proc, var, version.txt, ...),
    else the single nested directory an unpacked tarball leaves."""
    try:
        entries = os.listdir(directory)
    except OSError:
        return directory
    if any(e in ROOT_MARKERS for e in entries):
        return directory
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            return inner
    return directory


def read_text(path, max_bytes=None):
    """A capture's text ('' when missing or unreadable); undecodable bytes
    become U+FFFD instead of failing the whole tab."""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read(max_bytes) if max_bytes else f.read()
    except OSError:
        return ''


def read_lines(path):
    text = read_text(path)
    return text.splitlines(True) if text else []


def first_existing(root, *relpaths):
    """The first path under root that is a file, or None."""
    for rel in relpaths:
        p = os.path.join(root, rel)
        if os.path.isfile(p):
            return p
    return None


# ---------------------------------------------------------------------------
# free -m
# ---------------------------------------------------------------------------
def parse_free(path, unit='MiB'):
    """The Mem: line of `free -m` as a dict (total, used, free, shared,
    buff_cache, available), by the header's column names.

    The Swap: line gives swap_total / swap_used / swap_free when present.
    procps 3.3.10 (RHEL 7) prints `total used free shared buffers cached`:
    buff_cache is buffers + cached and available is estimated as free +
    buff_cache (the kernel's MemAvailable is not in that output), flagged
    with available_estimated. unit='GiB' divides by 1024 (two decimals)."""
    lines = read_lines(path)
    headers = None
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        if headers is None:
            if parts[0].lower().startswith('total') or (len(parts) >= 3 and parts[-1].lower() in ('available', 'cached')):
                headers = [h.lower() for h in parts]
            continue
        if parts[0].rstrip(':').lower() != 'mem':
            continue
        values = parts[1:]
        if headers is None or len(headers) != len(values):
            # no usable header: assume the modern column order
            headers = ['total', 'used', 'free', 'shared', 'buff/cache', 'available'][:len(values)]
        row = {}
        for h, v in zip(headers, values):
            try:
                row[h] = int(v)
            except ValueError:
                try:
                    row[h] = int(float(v))
                except ValueError:
                    row[h] = 0
        buff_cache = row.get('buff/cache')
        if buff_cache is None:
            buff_cache = row.get('buffers', 0) + row.get('cached', 0)
        available = row.get('available')
        estimated = available is None
        if estimated:
            available = row.get('free', 0) + buff_cache
        out = {
            'total': row.get('total', 0), 'used': row.get('used', 0), 'free': row.get('free', 0),
            'shared': row.get('shared', 0), 'buff_cache': buff_cache, 'available': available,
        }
        # the Swap: line (total used free) follows Mem:, for the memory-pressure finding
        for later in lines[lines.index(line) + 1:]:
            p = later.split()
            if p and p[0].rstrip(':').lower() == 'swap' and len(p) >= 4:
                try:
                    out.update({'swap_total': int(p[1]), 'swap_used': int(p[2]), 'swap_free': int(p[3])})
                except ValueError:
                    pass
                break
        if unit == 'GiB':
            out = {k: round(v / 1024, 2) for k, v in out.items()}
        out['available_estimated'] = estimated
        return out
    return {}


# ---------------------------------------------------------------------------
# ps
# ---------------------------------------------------------------------------
PS_HEADERS = ["USER", "LABEL", "PID", "PPID", "%CPU", "%MEM", "VSZ", "RSS", "TTY", "STAT", "START", "TIME", "COMMAND"]
# where sos keeps a ps form that carries the parent PID (ps aux has none): PID PPID pairs are read from the first found
PS_PPID_SOURCES = ('sos_commands/process/ps_-elfL', 'sos_commands/process/ps_-elf', 'sos_commands/process/ps_-ef', 'sos_commands/process/ps_alxwww',
                   'sos_commands/process/ps_axo_pid_ppid_user_group_lwp_nlwp_start_time_comm_cgroup', 'sos_commands/process/ps_axo_flags_state_uid_pid_ppid_pgid_sid_cls_pri_addr_sz_wchan_lstart_tty_time_cmd')


def ppid_map(root):
    """{pid: ppid} from the first ps capture that has a PPID column (ps -elfL lists threads too: the LWP rows repeat
    the process's PID, so the map stays one entry per process)."""
    for rel in PS_PPID_SOURCES:
        p = os.path.join(root, rel)
        if not os.path.isfile(p):
            continue
        lines = read_lines(p)
        if not lines:
            continue
        headers = lines[0].split()
        if 'PID' not in headers or 'PPID' not in headers:
            continue
        pi, ppi = headers.index('PID'), headers.index('PPID')
        out = {}
        for line in lines[1:]:
            parts = line.split()
            if len(parts) > max(pi, ppi) and parts[pi].isdigit() and parts[ppi].isdigit():
                out.setdefault(parts[pi], parts[ppi])
        if out:
            return out
    return {}


def parse_ps_file(ps_path, variant="ps_auxwwwm", ppids=None):
    """`ps auxwwwm` / `ps auxZww` / `ps auxwww` (and any ps form whose header names its columns) into processes.

    The result: {'headers': PS_HEADERS, 'processes': [row, ...], 'thread_count': N, 'has_threads': bool} where a row
    is keyed by PS_HEADERS (missing columns are '-') and carries 'threads': [thread rows] and 'thread_count'.
    `ps m` prints every process line followed by its thread lines, which show '-' for the per-process columns
    (PID, %MEM, VSZ, RSS, TTY, COMMAND) and their own %CPU, STAT and TIME: those lines are attached to the process
    above them, never listed as processes. The process line of `ps m` shows '-' for STAT and TIME (the threads
    carry them): the process takes the STAT of its busiest state (R > D > others) and the summed TIME is left to
    the threads. The PPID column comes from `ppids` ({pid: ppid}, see ppid_map) when ps aux has none.

    Report content is untrusted text: the fields are split, never interpreted."""
    ppids = ppids or {}
    try:
        lines = read_lines(ps_path)
        if not lines:
            return {"headers": list(PS_HEADERS), "processes": [], "thread_count": 0, "has_threads": False}
        raw_headers = lines[0].split()
        header_map = {h: i for i, h in enumerate(raw_headers)}
        expected_fields = len(raw_headers)
        for required in ["PID", "COMMAND"] if "COMMAND" in header_map else ["PID", "CMD"]:
            if required not in header_map:
                return {"error": f"Missing expected header: {required}", "headers": list(PS_HEADERS), "processes": [], "thread_count": 0, "has_threads": False}
        cmd_key = "COMMAND" if "COMMAND" in header_map else "CMD"
        pid_index = header_map["PID"]
        processes = []
        current = None
        thread_count = 0
        for line in lines[1:]:
            line = line.rstrip('\n')
            if not line.strip():
                continue
            parts = line.split(None, expected_fields - 1)
            if len(parts) < expected_fields:
                parts += ['-'] * (expected_fields - len(parts))
            full = dict(zip(raw_headers, parts))
            if cmd_key != "COMMAND":
                full["COMMAND"] = full.get(cmd_key, '-')
            if full.get("PID") == '-' and current is not None:
                # a thread line of `ps m`: attached to the process above it
                t = {h: full.get(h, '-') for h in PS_HEADERS}
                t["PID"] = current["PID"]
                t["PPID"] = current["PPID"]
                if t["COMMAND"] in ('-', ''):
                    t["COMMAND"] = current["COMMAND"]
                current["threads"].append(t)
                current["thread_count"] += 1
                thread_count += 1
                continue
            row = {h: full.get(h, '-') for h in PS_HEADERS}
            if row["PPID"] == '-' and row["PID"] in ppids:
                row["PPID"] = ppids[row["PID"]]
            row["threads"] = []
            row["thread_count"] = 0
            processes.append(row)
            current = row
        for p in processes:
            if p["threads"]:
                # the process line of `ps m` has no STAT of its own: take the most telling of its threads'
                states = [t["STAT"] for t in p["threads"] if t["STAT"] not in ('-', '')]
                if p["STAT"] in ('-', '') and states:
                    p["STAT"] = next((st for st in states if st.startswith('R')), next((st for st in states if st.startswith('D')), states[0]))
                if p["TIME"] in ('-', '') and p["threads"]:
                    p["TIME"] = p["threads"][0]["TIME"]
            if p["thread_count"] == 0:
                p["thread_count"] = 1 if variant.endswith('m') or 'L' in variant else 0
        return {"headers": list(PS_HEADERS), "processes": processes, "thread_count": thread_count, "has_threads": thread_count > 0}
    except Exception as e:  # noqa: BLE001 - report content is untrusted; the page shows the error
        return {"error": str(e), "headers": list(PS_HEADERS), "processes": [], "thread_count": 0, "has_threads": False}


# ---------------------------------------------------------------------------
# sar
# ---------------------------------------------------------------------------
RE_SAR_FILE = re.compile(r'^sar(\d{2})(?:\.(?:gz|xz|bz2))?$')
RE_SAR_ANY = re.compile(r'^sar.*?(\d{2})(?:\.(?:gz|xz|bz2))?$')   # sos 4's sar_-A_-f_.var.log.sa.sa12 and the like
RE_SA_BIN = re.compile(r'^sa(\d{2})$')
RE_SAR_TIME = re.compile(r'^(\d{1,2}):(\d{2}):(\d{2})$')
SAR_DIRS = ('sos_commands/sar', 'var/log/sa')


def open_text(path):
    """A text file, gz / xz / bz2 compressed or not (the sa2 cron job compresses old sar text with ZIP=xz)."""
    import bz2
    import gzip
    import lzma
    if path.endswith('.gz'):
        return gzip.open(path, 'rt', encoding='utf-8', errors='replace')
    if path.endswith('.xz'):
        return lzma.open(path, 'rt', encoding='utf-8', errors='replace')
    if path.endswith('.bz2'):
        return bz2.open(path, 'rt', encoding='utf-8', errors='replace')
    return open(path, 'r', encoding='utf-8', errors='replace')


def sar_sources(directory):
    """What a report holds of sar: {'text': [(day, path)] sorted by day, 'binary': [paths of saDD files without a text
    rendering], 'looked': [the directories], 'present': bool (any sar directory exists)}.

    The text forms: var/log/sa/sarDD (the sa2 cron job's, also compressed), sos_commands/sar/sarDD and the longer
    sos 4 names (sar_-A_-f_... with the day in them); var/log/sa wins for a day present in both. The binary saDD
    files are only noted: sar text has to be rendered from them (sadf / sar -f), sos does that when sysstat is
    installed (RHCOS has none by default)."""
    root = report_root(directory)
    found = {}
    binary = {}
    present = False
    for rel in SAR_DIRS[::-1] if False else ('sos_commands/sar', 'var/log/sa'):   # var/log/sa last: it wins
        d = os.path.join(root, rel)
        if not os.path.isdir(d):
            continue
        present = True
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for name in names:
            p = os.path.join(d, name)
            if not os.path.isfile(p):
                continue
            m = RE_SAR_FILE.match(name) or RE_SAR_ANY.match(name)
            if m and not name.startswith('sadf'):
                found[m.group(1)] = p
                continue
            m = RE_SA_BIN.match(name)
            if m:
                binary[m.group(1)] = p
    for day in list(binary):
        if day in found:
            del binary[day]
    return {'text': sorted(found.items()), 'binary': [binary[d] for d in sorted(binary)], 'looked': [os.path.join(rel, 'sarDD') for rel in ('var/log/sa', 'sos_commands/sar')], 'present': present}


def sar_files(directory):
    """[(day, path)] of the sar text files (see sar_sources)."""
    return sar_sources(directory)['text']


def sar_no_data(directory):
    """The INFO finding for a report without readable sar text (None when there is some): binary-only, or no sysstat."""
    from parsers.findings import no_data
    src = sar_sources(directory)
    if src['text']:
        return None
    if src['binary']:
        return no_data('Only binary sa files in this report: no sar text', src['looked'], f"{len(src['binary'])} saDD file{'s' if len(src['binary']) != 1 else ''} under var/log/sa; sos renders them with `sar -A -f` when sysstat is installed - run `sadf` / `sar -f saDD` on the host to read them")
    return no_data('No sar data in this report', src['looked'], 'sysstat not installed or its collection disabled (RHCOS and container hosts have no sysstat by default), or sos ran without the sar plugin')


def sar_split(line):
    """(time as HH:MM:SS in 24-hour form, the remaining tokens) for a sar
    data or header line, or None for any other line. Hosts in a 12-hour
    locale print `12:10:01 AM` / `01:10:01 PM`: the AM/PM token is folded
    into the hour so the columns line up with a 24-hour capture."""
    parts = line.split()
    if not parts:
        return None
    m = RE_SAR_TIME.match(parts[0])
    if not m:
        return None
    h, mi, s = int(m.group(1)), m.group(2), m.group(3)
    rest = parts[1:]
    if rest and rest[0].upper() in ('AM', 'PM'):
        if rest[0].upper() == 'AM' and h == 12:
            h = 0
        elif rest[0].upper() == 'PM' and h != 12:
            h += 12
        rest = rest[1:]
    return f"{h:02d}:{mi}:{s}", rest


# ---------------------------------------------------------------------------
# the report's date
# ---------------------------------------------------------------------------
RE_YEAR = re.compile(r'\b(19|20)(\d{2})\b')


def report_year(directory):
    """The year the report was taken: the `date` capture (the sos root, then
    sos_commands/date/date, then sos_commands/general/date), else the
    report directory's modification year, else this year."""
    root = report_root(directory)
    p = first_existing(root, 'date', 'sos_commands/date/date', 'sos_commands/general/date')
    if p:
        m = RE_YEAR.search(read_text(p, 400))
        if m:
            return int(m.group(1) + m.group(2))
    try:
        return datetime.fromtimestamp(os.path.getmtime(root)).year
    except OSError:
        return datetime.now().year


# ---------------------------------------------------------------------------
# lvm reports
# ---------------------------------------------------------------------------
def lvm_table(lines, known_headers):
    """A pvs / vgs / lvs report (the header line and its rows) into one dict
    per row keyed by header name.

    lvm pads every column to its widest value and separates columns with a
    space: text columns are left-aligned under their header, sizes and
    counts right-aligned to the header's end, so a value can be wider than
    its header and start BEFORE it. Each token of a row goes to the header
    whose span it overlaps (else the nearest one), which keeps `<100.00g`
    whole where a slice from the header's start cut it to `00.00g`. Headers
    with a space in them (PV UUID, 1st PE, VG Tags, System ID, Move Log,
    LV Tags) are found by name in the header line."""
    lines = [l.rstrip('\n') for l in lines if l.strip() and 'Reloading config files' not in l and 'WARNING:' not in l]
    if len(lines) < 2:
        return []
    header_line = lines[0]
    spans = []
    taken = [False] * (len(header_line) + 1)
    for name in sorted(known_headers, key=len, reverse=True):
        for m in re.finditer(r'(?<!\S)' + re.escape(name) + r'(?!\S)', header_line):
            if not any(taken[m.start():m.end()]):
                spans.append((m.start(), m.end(), name))
                for i in range(m.start(), m.end()):
                    taken[i] = True
                break
    for m in re.finditer(r'\S+', header_line):
        if not any(taken[m.start():m.end()]):
            spans.append((m.start(), m.end(), m.group(0)))
    spans.sort()
    names = [s[2] for s in spans]
    rows = []
    for line in lines[1:]:
        values = {n: [] for n in names}
        for m in re.finditer(r'\S+', line):
            ts, te = m.start(), m.end()
            best = None
            best_d = None
            for hs, he, name in spans:
                if ts < he and te > hs:
                    d = 0
                else:
                    d = hs - te if te <= hs else ts - he
                if best is None or d < best_d:
                    best, best_d = name, d
            if best is not None:
                values[best].append(m.group(0))
        row = {n: ' '.join(values[n]) for n in names}
        for n in known_headers:
            row.setdefault(n, '')
        rows.append(row)
    return rows
