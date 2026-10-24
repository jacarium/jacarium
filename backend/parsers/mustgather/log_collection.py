"""Log Collection: what a must-gather holds, by size. The top-level
directories with their recursive totals (namespaces/, cluster-scoped-
resources/, host_service_logs/, audit_logs/, network_logs/, ...), the
namespaces by size, the largest container logs (current and previous,
with namespace/pod/container), the host service logs (kubelet, crio) and
the audit logs, every section largest first.

One os.scandir walk from the data directory (resolve_data_dir unwraps
the image directory like every other must-gather parser), each entry
stat'ed once, symlinks never followed (they count as nothing), directory
sizes summed on the way back up. A must-gather can hold tens of
thousands of files, so the per-section lists are bounded while walking
(the largest KEEP items kept with a heap) and the template shows the top
TOP with "show all". Nothing is read.
"""
import heapq
import os

from parsers.mustgather._common import resolve_data_dir

TOP = 15            # rows shown per section before "show all"
KEEP = 300          # rows kept per section (the largest)
MAX_ENTRIES = 2_000_000

SECTIONS = [
    ('top', 'Top-level directories', '<must-gather>/'),
    ('namespaces', 'Namespaces', 'namespaces/<ns>/'),
    ('pod_logs', 'Container logs', 'namespaces/<ns>/pods/<pod>/<container>/<container>/logs/'),
    ('host', 'Host service logs', 'host_service_logs/'),
    ('audit', 'Audit logs', 'audit_logs/'),
    ('network', 'Network logs', 'network_logs/'),
]


def human(size):
    if size is None:
        return ''
    if size < 1024:
        return f"{size} B"
    if size < 1024 ** 2:
        return f"{size / 1024:.1f} KiB"
    if size < 1024 ** 3:
        return f"{size / 1024 ** 2:.1f} MiB"
    return f"{size / 1024 ** 3:.2f} GiB"


def sort_key(item):
    """(unknown size last, largest first, then by name)."""
    return (item['size'] is None, -(item['size'] or 0), item['name'])


class _Keeper:
    """The KEEP largest items of a section, kept with a heap while walking;
    items without a size are kept apart (they sort last)."""

    def __init__(self, limit=KEEP):
        self.limit = limit
        self.heap = []      # (size, name, item)
        self.unknown = []
        self.count = 0
        self.total = 0
        self.seq = 0

    def add(self, item):
        self.count += 1
        if item['size'] is None:
            if len(self.unknown) < self.limit:
                self.unknown.append(item)
            return
        self.total += item['size']
        self.seq += 1
        entry = (item['size'], -self.seq, item)  # -seq: among equal sizes the earlier (sorted) name stays
        if len(self.heap) < self.limit:
            heapq.heappush(self.heap, entry)
        elif entry > self.heap[0]:
            heapq.heapreplace(self.heap, entry)

    def rows(self):
        out = [e[2] for e in self.heap] + self.unknown
        out.sort(key=sort_key)
        return out


def _item(name, size, is_dir=False, files=0, detail=''):
    return {'name': name, 'size': size, 'size_text': human(size), 'unreadable': size is None, 'is_dir': is_dir, 'files': files, 'detail': detail}


def parse(directory):
    root = resolve_data_dir(directory)
    keepers = {key: _Keeper() for key, _, _ in SECTIONS}
    state = {'files': 0, 'entries': 0, 'size': 0, 'capped': False, 'unreadable': 0}

    def walk(path, rel_parts):
        """Returns (recursive size, file count) of a directory; symlinks are
        not followed and count as nothing."""
        size = 0
        files = 0
        try:
            it = os.scandir(path)
        except OSError:
            return None, 0
        with it:
            for entry in it:
                state['entries'] += 1
                if state['entries'] > MAX_ENTRIES:
                    state['capped'] = True
                    break
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        sub_size, sub_files = walk(entry.path, rel_parts + (entry.name,))
                        if sub_size is not None:
                            size += sub_size
                        files += sub_files
                        _classify_dir(rel_parts + (entry.name,), sub_size, sub_files)
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    st = entry.stat(follow_symlinks=False)
                    fsize = st.st_size
                except OSError:
                    fsize = None
                    state['unreadable'] += 1
                files += 1
                state['files'] += 1
                if fsize is not None:
                    size += fsize
                    state['size'] += fsize
                _classify_file(rel_parts + (entry.name,), fsize)
        return size, files

    def _classify_dir(parts, size, files):
        if len(parts) == 1:
            keepers['top'].add(_item(parts[0] + '/', size, is_dir=True, files=files))
        elif len(parts) == 2 and parts[0] == 'namespaces':
            keepers['namespaces'].add(_item(parts[1], size, is_dir=True, files=files))

    def _classify_file(parts, size):
        head = parts[0]
        if len(parts) == 1:
            keepers['top'].add(_item(head, size))
        elif head == 'namespaces' and len(parts) >= 7 and parts[2] == 'pods' and parts[-2] == 'logs':
            # namespaces/<ns>/pods/<pod>/<container>/<container>/logs/<current|previous>.log
            keepers['pod_logs'].add(_item(f"{parts[1]}/{parts[3]}/{parts[4]} ({parts[-1]})", size, detail=parts[-1]))
        elif head == 'host_service_logs':
            keepers['host'].add(_item('/'.join(parts[1:]), size))
        elif head == 'audit_logs':
            keepers['audit'].add(_item('/'.join(parts[1:]), size))
        elif head == 'network_logs':
            keepers['network'].add(_item('/'.join(parts[1:]), size))

    walk(root, ())

    sections = []
    rows = []
    largest = None
    for color, (key, label, hint) in enumerate(SECTIONS):
        k = keepers[key]
        if not k.count:
            continue
        items = k.rows()
        sections.append({'key': key, 'label': label, 'hint': hint, 'rows': items, 'count_all': k.count, 'count': k.count, 'kept': len(items),
                         'total': k.total, 'total_text': human(k.total), 'top': TOP, 'more': max(0, len(items) - TOP),
                         'pct': round(100.0 * k.total / state['size'], 1) if state['size'] else 0.0, 'color': color})
        for i, item in enumerate(items):
            # a container log "ns/pod/container (file)": namespace / pod / container shown as segments, the file as the detail
            segments = item['name'].split(' (', 1)[0].split('/')[:3] if key == 'pod_logs' else None
            rows.append(dict(item, section=key, section_label=label, color=color, segments=segments,
                             detail=item['detail'] if key == 'pod_logs' else '', rotated=False, extra=i >= TOP, bar_pct=0.0))
            if not item['is_dir'] and item['size'] is not None and (largest is None or item['size'] > largest['size']):
                largest = {'name': item['name'], 'size': item['size'], 'size_text': item['size_text'], 'section_label': label}
    rows.sort(key=sort_key)
    max_file = max((r['size'] or 0 for r in rows if not r['is_dir']), default=0)
    max_dir = max((r['size'] or 0 for r in rows if r['is_dir']), default=0)
    for r in rows:
        ref = max_dir if r['is_dir'] else max_file
        r['bar_pct'] = round(100.0 * r['size'] / ref, 1) if ref and r['size'] else 0.0
    # the band's split: the top-level entries (directories and loose files), the seven largest and "other"
    bar = []
    top_rows = [i for i in keepers['top'].rows() if i['size']]
    other = 0
    for i, item in enumerate(top_rows):
        if i < 7:
            bar.append({'key': item['name'], 'label': item['name'], 'total': item['size'], 'total_text': item['size_text'],
                        'pct': round(100.0 * item['size'] / state['size'], 1) if state['size'] else 0.0, 'color': i})
        else:
            other += item['size']
    if other:
        bar.append({'key': 'other', 'label': 'other', 'total': other, 'total_text': human(other), 'pct': round(100.0 * other / state['size'], 1) if state['size'] else 0.0, 'color': 7})
    lc = {
        'sections': sections, 'bar': bar, 'rows': rows, 'largest': largest, 'top': TOP, 'keep': KEEP,
        'extra_count': sum(1 for r in rows if r['extra']), 'max_file': max_file, 'max_dir': max_dir,
        'total_files': state['files'], 'total_size': state['size'], 'total_size_text': human(state['size']),
        'unreadable': state['unreadable'], 'capped': state['capped'],
        'root': os.path.basename(root.rstrip('/')), 'image_dir': os.path.basename(root.rstrip('/')) if root != directory else '',
    }
    return {'log_collection': lc, 'findings': findings_for(lc)}


def findings_for(lc):
    """The Findings strip: unreadable files (warn), the listing capped, the totals; no logs (info)."""
    from parsers.findings import finding, no_data, sort_findings
    if not lc.get('rows'):
        return [no_data('No logs in this must-gather', ['namespaces/*/pods/*/*/logs', 'host_service_logs', 'audit_logs'], 'trimmed gather')]
    out = []
    if lc.get('unreadable'):
        out.append(finding('warn', f"{lc['unreadable']} file{'s' if lc['unreadable'] != 1 else ''} unreadable", 'the size could not be read: a broken symlink or a permission problem', count=lc['unreadable']))
    if lc.get('capped'):
        out.append(finding('info', 'The listing is capped', 'the gather holds more files than are listed'))
    out.append(finding('info', f"{lc.get('total_files', 0)} files, {lc.get('total_size_text', '')}", (f"the largest: {lc['largest'].get('name', '')} ({lc['largest'].get('size_text', '')})" if lc.get('largest') else '')))
    return sort_findings(out)
