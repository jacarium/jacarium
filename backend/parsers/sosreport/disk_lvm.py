"""Disk > LVM: the pvs / vgs / lvs reports of a sosreport
(sos_commands/lvm2/{pvs,vgs,lvs}_*), one row per physical volume, volume
group and logical volume with the report's columns by name.

The column layout is read with _common.lvm_table, which assigns a row's
tokens to the header they sit under (lvm right-aligns sizes and counts, so
a value wider than its header starts before it: `<100.00g` under `PSize`
used to be cut to `00.00g` by a slice from the header's start). A report
without the lvm2 plugin, or with "No volume groups found", gives empty
lists, not an error.
"""
import fnmatch
import os
import re

from parsers.findings import level, finding, sort_findings

from ._common import lvm_table, read_lines, report_root

PVS_HEADERS = ["PV", "VG", "Fmt", "Attr", "PSize", "PFree", "DevSize", "PV UUID", "PMdaFree", "PMdaSize", "#PMda", "#PMdaUse", "1st PE"]
VGS_HEADERS = ["VG", "Attr", "Ext", "#PV", "#LV", "#SN", "VSize", "VFree", "VG UUID", "VProfile", "#VMda", "VMdaFree", "VMdaSize", "#VMdaUse", "VG Tags", "System ID"]
LVS_HEADERS = ["LV", "VG", "Attr", "LSize", "Pool", "Origin", "Data%", "Meta%", "Move Log", "Cpy%Sync", "Convert", "LV Tags", "Devices", "KRahead", "Rahead", "#Str", "Stripe"]


def _find(directory, prefix):
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    for name in names:
        if fnmatch.fnmatch(name, prefix + '*') and os.path.isfile(os.path.join(directory, name)):
            return os.path.join(directory, name)
    return None


def _table(path, headers):
    if not path:
        return []
    lines = read_lines(path)
    if any('No volume groups found' in l or 'No physical volume' in l or 'No logical volume' in l for l in lines):
        return []
    return lvm_table(lines, headers)


def parse(directory):
    root = report_root(directory)
    lvm_path = os.path.join(root, 'sos_commands', 'lvm2')
    lvm = {
        'vgs': _table(_find(lvm_path, 'vgs_'), VGS_HEADERS),
        'pvs': _table(_find(lvm_path, 'pvs_'), PVS_HEADERS),
        'lvs': _table(_find(lvm_path, 'lvs_'), LVS_HEADERS),
    }
    return {'lvm': lvm, 'findings': findings_for(lvm, os.path.isdir(lvm_path))}

RE_SIZE = re.compile(r'^<?([\d.]+)([kmgtpKMGTP]?)')


def size_bytes(text):
    """'<100.00g' / '4.00m' / '1.82t' -> bytes (lvm's binary units)."""
    m = RE_SIZE.match((text or '').strip())
    if not m:
        return None
    return float(m.group(1)) * {'': 1, 'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3, 't': 1024 ** 4, 'p': 1024 ** 5}[m.group(2).lower()]


def _pct(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def findings_for(lvm, present):
    """The Findings strip: a missing physical volume (the VG attribute 'p' = partial, a PV attribute 'm'), a logical
    volume that is not active, a thin pool over 90% of its data or metadata, a volume group with no free space, the
    counts when nothing is wrong."""
    out = []
    if not present:
        return [finding('info', 'No LVM capture in this report', 'sos_commands/lvm2 is missing: the host may not use LVM, or sos ran without the lvm2 plugin')]
    for vg in lvm['vgs']:
        attr = vg.get('Attr', '')
        if len(attr) > 3 and attr[3] == 'p':
            out.append(finding('bad', f"Volume group {vg.get('VG')} is partial: a physical volume is missing", f"attr {attr}; the logical volumes on the missing PV cannot be activated", count=2))
        free, size = size_bytes(vg.get('VFree')), size_bytes(vg.get('VSize'))
        if size and free is not None and free / size < 0.02:
            out.append(finding('info', f"Volume group {vg.get('VG')} has no free space ({vg.get('VFree')} of {vg.get('VSize')})", "no room to grow a logical volume or take a snapshot"))
    for pv in lvm['pvs']:
        attr = pv.get('Attr', '')
        if 'm' in attr:
            out.append(finding('bad', f"Physical volume {pv.get('PV')} is missing", f"attr {attr} in volume group {pv.get('VG')}", count=2))
    for lv in lvm['lvs']:
        attr = lv.get('Attr', '')
        name = f"{lv.get('VG')}/{lv.get('LV')}"
        if len(attr) > 4 and attr[4] != 'a' and not attr.startswith(('t', 'e', 'V')) and not lv.get('LV', '').startswith('['):
            out.append(finding('warn', f"Logical volume {name} is not active", f"attr {attr}: not usable until activated (vgchange -ay)"))
        data, meta = _pct(lv.get('Data%')), _pct(lv.get('Meta%'))
        lv['data_pct'], lv['meta_pct'] = data, meta
        lv['data_role'] = level(data, 'thin_pool') if data is not None else 'muted'
        lv['meta_role'] = level(meta, 'thin_pool') if meta is not None else 'muted'
        if attr.startswith('t') and (lv['data_role'] in ('warn', 'bad') or lv['meta_role'] in ('warn', 'bad')):
            worst = max(data or 0, meta or 0)
            out.append(finding('bad' if worst >= 95 else 'warn', f"Thin pool {name} is {worst:g}% full", f"data {data if data is not None else '-'}%, metadata {meta if meta is not None else '-'}%: a full pool takes every thin volume on it read-only", count=int(worst)))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{len(lvm['vgs'])} volume groups, {len(lvm['pvs'])} physical volumes, {len(lvm['lvs'])} logical volumes: every PV present, every LV active, no thin pool near full"))
    return sort_findings(out)
