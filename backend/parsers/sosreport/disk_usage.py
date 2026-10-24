"""Disk > Disk Usage: the mounted filesystems of a sosreport with their
size, use and inode use, worst first, and the Findings strip (a filesystem
over 90% / 95%, inodes over 90%).

Captures: `df` in the report root (sos's symlink to the -al capture), else
sos_commands/filesys/df_-al_-x_autofs / df_-al / df_-h; the inode table
from sos_commands/filesys/df_-ali_-x_autofs / df_-ali / df_-i. Sizes come
in 1K blocks (`df -al`): the rows carry the raw block counts (what the
page's sort uses) and the human text. Pseudo filesystems (tmpfs, devtmpfs,
overlay, squashfs, ...) sort after the real ones: a full /dev/shm matters,
but the disks come first.
"""
import os
import re

from parsers.findings import level, finding, human_bytes, no_data, sort_findings

from ._common import first_existing, read_lines, report_root

PSEUDO = ('tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'nsfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'debugfs', 'tracefs', 'mqueue', 'hugetlbfs', 'bpf', 'pstore', 'securityfs', 'configfs', 'fusectl', 'binfmt_misc', 'rpc_pipefs', 'selinuxfs', 'efivarfs', 'autofs', 'devpts', 'none', 'udev')
HEADER_MAP = {'Filesystem': 'filesystem', '1K-blocks': 'size', 'Size': 'size', 'Used': 'used', 'Available': 'available', 'Avail': 'available', 'Use%': 'used_percent',
              'Mounted': 'mounted', 'Inodes': 'inodes', 'IUsed': 'iused', 'IFree': 'ifree', 'IUse%': 'iuse_percent', 'Type': 'type'}
RE_PCT = re.compile(r'^(\d+)%$')


def _rows(path):
    """The rows of a df table keyed by HEADER_MAP; `Mounted on` is two words, so a row has one field more than the
    headers and the last field is the mount point (a mount point with spaces keeps them)."""
    lines = read_lines(path)
    if not lines:
        return []
    headers = [HEADER_MAP.get(h, h) for h in lines[0].split()]
    if 'mounted' in headers:
        headers = headers[:headers.index('mounted') + 1]
    out = []
    for line in lines[1:]:
        parts = line.rstrip('\n').split(None, len(headers) - 1)
        if len(parts) < len(headers):
            continue
        out.append(dict(zip(headers, parts)))
    return out


def _pct(text):
    m = RE_PCT.match((text or '').strip())
    return int(m.group(1)) if m else None


def _int(text):
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def parse(directory):
    root = report_root(directory)
    df_path = first_existing(root, 'df', 'sos_commands/filesys/df_-al_-x_autofs', 'sos_commands/filesys/df_-al', 'sos_commands/filesys/df_-h')
    rows = _rows(df_path) if df_path else []
    inode_path = first_existing(root, 'sos_commands/filesys/df_-ali_-x_autofs', 'sos_commands/filesys/df_-ali', 'sos_commands/filesys/df_-i')
    inodes = {}
    for r in (_rows(inode_path) if inode_path else []):
        inodes[(r.get('filesystem'), r.get('mounted'))] = r
    entries = []
    for r in rows:
        fs = r.get('filesystem', '')
        pseudo = fs.split('/')[0] in PSEUDO or fs in PSEUDO
        size, used, avail = _int(r.get('size')), _int(r.get('used')), _int(r.get('available'))
        pct = _pct(r.get('used_percent'))
        ino = inodes.get((fs, r.get('mounted')), {})
        entries.append({
            'filesystem': fs, 'mounted': r.get('mounted', ''), 'pseudo': pseudo,
            'size': r.get('size', ''), 'used': r.get('used', ''), 'available': r.get('available', ''), 'used_percent': r.get('used_percent', '-'),
            'size_text': human_bytes(size, kib=True) if size is not None else r.get('size', ''),
            'used_text': human_bytes(used, kib=True) if used is not None else r.get('used', ''),
            'available_text': human_bytes(avail, kib=True) if avail is not None else r.get('available', ''),
            'pct': pct, 'inodes': _int(ino.get('inodes')), 'iused': _int(ino.get('iused')), 'iuse_percent': ino.get('iuse_percent', ''), 'ipct': _pct(ino.get('iuse_percent')),
            # the meter roles (the same thresholds as the Findings below: parsers/findings.THRESHOLDS)
            'role': level(pct, 'disk'), 'irole': level(_pct(ino.get('iuse_percent')), 'inodes'),
        })
    # worst first: the real filesystems by use, then the pseudo ones by use
    entries.sort(key=lambda e: (e['pseudo'], -(e['pct'] if e['pct'] is not None else -1), e['mounted']))
    return {'df': {'df': entries, 'source': os.path.relpath(df_path, root) if df_path else '', 'inodes': bool(inode_path)}, 'findings': findings_for(entries, bool(inode_path))}


def findings_for(entries, have_inodes):
    """The Findings strip: a filesystem over 95% (bad) or 90% (warn), inodes over 90% (warn, 95% bad), the largest
    real filesystem as context when nothing is wrong."""
    out = []
    if not entries:
        return [no_data('No filesystem listing in this report', ['df', 'sos_commands/filesys/df_-al_-x_autofs', 'df_-al', 'df_-h'], 'sos ran without the filesys plugin, or the capture is empty')]
    for e in entries:
        where = f"{e['mounted']} ({e['filesystem']})"
        if e['role'] in ('warn', 'bad'):
            out.append(finding(e['role'], f"{where} is {e['pct']}% full", f"{e['used_text']} of {e['size_text']} used, {e['available_text']} left" + (" (a pseudo filesystem: memory-backed)" if e['pseudo'] else ""), count=e['pct']))
        if e['irole'] in ('warn', 'bad'):
            out.append(finding(e['irole'], f"{where} has {e['ipct']}% of its inodes used", f"{e['iused']:,} of {e['inodes']:,}: writes fail with 'No space left on device' even with free blocks".replace(',', '\u202f'), count=e['ipct']))
    if not have_inodes and entries:
        out.append(finding('info', "No inode table in this report", "sos_commands/filesys/df_-ali is missing (older sos): inode exhaustion cannot be seen here"))
    real = [e for e in entries if not e['pseudo'] and e['pct'] is not None]
    if real and not any(f['severity'] in ('bad', 'warn') for f in out):
        top = real[0]
        out.append(finding('good', f"No filesystem over 90%: the fullest is {top['mounted']} at {top['pct']}%", f"{len(real)} real filesystems, {len(entries) - len(real)} pseudo"))
    return sort_findings(out)
