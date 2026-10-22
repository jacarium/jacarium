"""Sos Report: the group page for the report's own metadata (the sos
version, the command line, when and how long it ran, the policy and
preset, the host it was taken on, what sos_reports/ holds). Its sub-tab
Blame (parsers/sosreport/blame.py) breaks the run time down by plugin.

Like the other sosreport parsers: parse(directory) -> a dict for
tabs/sosreport_sos_report.html; a report without a manifest gives the
empty state, never an exception.
"""
import os

from . import blame


def parse(directory):
    root = blame._report_root(directory)
    manifest, reason = blame.load_manifest(root)
    version_txt = ''
    try:
        with open(os.path.join(root, 'version.txt'), 'r', encoding='utf-8', errors='replace') as f:
            version_txt = f.read(200).strip()
    except OSError:
        pass
    files = []
    reports_dir = os.path.join(root, 'sos_reports')
    if os.path.isdir(reports_dir):
        for name in sorted(os.listdir(reports_dir))[:50]:
            path = os.path.join(reports_dir, name)
            try:
                files.append({'name': name, 'size': os.path.getsize(path) if os.path.isfile(path) else 0, 'is_dir': os.path.isdir(path)})
            except OSError:
                continue
    info = {
        'available': manifest is not None, 'reason': reason, 'version_txt': version_txt, 'files': files,
        'node': os.path.basename(root.rstrip('/')), 'node_label': blame.short_node_label(os.path.basename(root.rstrip('/'))),
        'version': '', 'cmdline': '', 'start': '', 'end': '', 'total': '', 'policy': '', 'preset': '', 'hostname': '', 'kernel': '',
        'components': [], 'plugins': 0, 'compression': '', 'tmpdir': '',
    }
    if manifest is not None:
        b = blame.parse(root)['blame']
        report = (manifest.get('components') or {}).get('report') if isinstance(manifest.get('components'), dict) else None
        info.update({
            'version': b['version'], 'cmdline': b['cmdline'], 'start': b['start'], 'end': b['end'], 'total': b['total'],
            'policy': b['policy'], 'preset': b['preset'], 'hostname': b['hostname'], 'kernel': b['kernel'],
            'components': sorted(k for k in (manifest.get('components') or {}).keys()) if isinstance(manifest.get('components'), dict) else [],
            'plugins': len(report.get('plugins') or {}) if isinstance(report, dict) and isinstance(report.get('plugins'), dict) else 0,
            'compression': str(manifest.get('compression') or ''), 'tmpdir': str(manifest.get('tmpdir') or ''),
            'blame_available': b['available'], 'blame_reason': b['reason'],
        })
    return {'sos_report': info}
