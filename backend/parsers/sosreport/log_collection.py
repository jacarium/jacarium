"""Log Collection: the group page for the logs a sosreport carries (the
journal captures under sos_commands/logs, the kernel ring buffer, the
files under var/log with their rotations), with their sizes. Its sub-tab
Log Viewer (parsers/sosreport/log_viewer.py) opens them.

This listing is deliberately light: no file is read, so the group page
opens at once even on a report with a multi-gigabyte journal; the Log
Viewer does the parsing when it is opened.
"""
import os

MAX_FILES = 400


def _report_root(directory):
    try:
        entries = os.listdir(directory)
    except OSError:
        return directory
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            return inner
    return directory


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return None


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


def parse(directory):
    root = _report_root(directory)
    groups = [
        {'key': 'journal', 'label': 'Journal captures', 'hint': 'sos_commands/logs', 'files': []},
        {'key': 'kernel', 'label': 'Kernel ring buffer', 'hint': 'sos_commands/kernel', 'files': []},
        {'key': 'syslog', 'label': 'System logs', 'hint': 'var/log', 'files': []},
        {'key': 'app', 'label': 'Application logs', 'hint': 'var/log/*', 'files': []},
    ]
    by_key = {g['key']: g for g in groups}
    count = 0

    def add(key, name, path):
        nonlocal count
        if count >= MAX_FILES:
            return
        size = _size(path)
        by_key[key]['files'].append({'name': name, 'size': size, 'size_text': human(size), 'unreadable': size is None, 'rotated': name.endswith('.gz') or name.split('.')[-1].isdigit() or '-20' in name})
        count += 1

    logs_dir = os.path.join(root, 'sos_commands', 'logs')
    if os.path.isdir(logs_dir):
        for name in sorted(os.listdir(logs_dir)):
            if name.startswith('journalctl'):
                add('journal', name, os.path.join(logs_dir, name))
    kernel_dir = os.path.join(root, 'sos_commands', 'kernel')
    if os.path.isdir(kernel_dir):
        for name in sorted(os.listdir(kernel_dir)):
            if name.startswith('dmesg'):
                add('kernel', name, os.path.join(kernel_dir, name))
    var_log = os.path.join(root, 'var', 'log')
    if os.path.isdir(var_log):
        for dirpath, dirnames, filenames in os.walk(var_log):
            dirnames.sort()
            rel_dir = os.path.relpath(dirpath, var_log)
            for name in sorted(filenames):
                rel = name if rel_dir == '.' else os.path.join(rel_dir, name)
                base = name.split('.')[0].split('-')[0]
                key = 'syslog' if rel_dir == '.' and base in ('messages', 'secure', 'cron', 'maillog', 'boot', 'dmesg', 'kern', 'syslog', 'auth') else 'app'
                add(key, rel, os.path.join(dirpath, name))
            if count >= MAX_FILES:
                break
    total = sum(f['size'] or 0 for g in groups for f in g['files'])
    return {'log_collection': {
        'groups': [g for g in groups if g['files']],
        'total_files': count, 'total_size': total, 'total_size_text': human(total),
        'capped': count >= MAX_FILES,
        'journal_present': bool(by_key['journal']['files']),
    }}
