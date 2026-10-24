"""System > PCI Devices: the `lspci` capture of a sosreport, one entry per
device with its slot, class, description, ids and the verbose lines that
follow it.

sos has written the capture under several names: sos_commands/pci/lspci_-nnvv
(sos 4.x, with the class and vendor:device ids in brackets), the older
sos_commands/hardware/lspci_-nnvv / lspci_-nvv / lspci_-vvv and the plain
sos_commands/{pci,hardware}/lspci, plus the `lspci` symlink in the report
root. The first that exists is read. Three header forms are recognised:

  -nn   00:03.0 Ethernet controller [0200]: Vendor Device [8086:10d3] (rev 02)
  -n    00:03.0 0200: 8086:10d3 (rev 02)
  plain 00:03.0 Ethernet controller: Vendor Device (rev 02)

so a report with a plain or numeric capture lists its devices instead of
showing an empty page. Fields the other forms lack stay empty strings.
"""
import os
import re

from parsers.findings import finding, no_data, sort_findings

from ._common import first_existing, read_lines, report_root

# the slot: 00:1f.2, 0000:00:1f.2
RE_NN = re.compile(r'^((?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]) (.+?) \[([0-9a-f]{4})\]: (.+?) \[([0-9a-f]{4}):([0-9a-f]{4})\](?: \(rev ([0-9a-f]+)\))?', re.I)
RE_N = re.compile(r'^((?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]) ([0-9a-f]{4}): ([0-9a-f]{4}):([0-9a-f]{4})(?: \(rev ([0-9a-f]+)\))?', re.I)
RE_PLAIN = re.compile(r'^((?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]) ([^:\[]+?): (.+?)(?: \(rev ([0-9a-f]+)\))?$', re.I)

CAPTURES = (
    'sos_commands/pci/lspci_-nnvv', 'sos_commands/hardware/lspci_-nnvv',
    'sos_commands/pci/lspci_-nvv', 'sos_commands/hardware/lspci_-nvv',
    'sos_commands/hardware/lspci_-vvv', 'sos_commands/pci/lspci_-vvv',
    'sos_commands/pci/lspci', 'sos_commands/hardware/lspci', 'lspci',
)


def parse_header(line):
    """The device dict of an lspci header line, or None for any other line."""
    m = RE_NN.match(line)
    if m:
        slot, cls, class_id, desc, vendor, device, rev = m.groups()
        return {'slot': slot, 'type': cls, 'class': cls, 'class_id': class_id, 'description': desc, 'vendor_id': vendor, 'device_id': device, 'revision': rev}
    m = RE_N.match(line)
    if m:
        slot, class_id, vendor, device, rev = m.groups()
        return {'slot': slot, 'type': f'class {class_id}', 'class': f'class {class_id}', 'class_id': class_id, 'description': f'{vendor}:{device}', 'vendor_id': vendor, 'device_id': device, 'revision': rev}
    m = RE_PLAIN.match(line)
    if m:
        slot, cls, desc, rev = m.groups()
        return {'slot': slot, 'type': cls, 'class': cls, 'class_id': '', 'description': desc, 'vendor_id': '', 'device_id': '', 'revision': rev}
    return None


def parse_lspci(path):
    devices = []
    device = None
    for line in read_lines(path):
        line = line.rstrip()
        if not line.strip():
            continue
        if not line[0].isspace():
            header = parse_header(line)
            if header:
                if device:
                    devices.append(device)
                device = dict(header, summary=line.strip(), details=[])
                continue
        if device is None:
            continue
        device['details'].append(line)
    if device:
        devices.append(device)
    return devices


def parse(directory):
    root = report_root(directory)
    path = first_existing(root, *CAPTURES)
    if not path:
        return {'findings': [no_data('No lspci capture in this report', list(CAPTURES), 'sos ran without the pci / hardware plugin, or lspci is not installed on the host')]}
    devices = parse_lspci(path)
    extra = enrich(devices)
    return {'lspci': devices, 'source': os.path.relpath(path, root), **extra}

NETWORK_CLASSES = ('ethernet', 'network', 'infiniband', 'fibre channel')
STORAGE_CLASSES = ('sata', 'scsi', 'raid', 'non-volatile memory', 'nvm', 'mass storage', 'serial attached')


# the vendor part of an lspci description ("Intel Corporation 82574L Gigabit Network Connection")
RE_VENDOR = re.compile(r'^(.+?(?:Corporation|Corp\.?|Inc\.?|Ltd\.?|Limited|Co\.,? Ltd\.?|Technologies|Technology|Systems|Semiconductor|Semiconductors|Microsystems|Electronics|GmbH|Company|Devices|Labs|AG|LLC|NV|SA|Co\.)|\S+)\s+(.*)$')
RE_LINK = re.compile(r'Speed\s+([\d.]+\s*GT/s)[^,]*,\s*Width\s+x(\d+)', re.I)
RE_SIZE = re.compile(r'\[size=([^\]]+)\]')
# the error flags of the Status line (a set one means the device reported an error)
ERROR_FLAGS = {'ParErr', '>TAbort', '<TAbort', '<MAbort', '>SERR', '<PERR', 'DEVSTA: CorrErr', 'UncorrErr', 'FatalErr'}
RE_FLAG = re.compile(r'(\S+?)([+-])(?=\s|$)')


def split_vendor(desc):
    m = RE_VENDOR.match(desc or '')
    if not m:
        return '', desc or ''
    return m.group(1), m.group(2)


def parse_flags(text):
    """'I/O+ Mem+ BusMaster- SpecCycle-' -> [{name, on, bad}]"""
    out = []
    for m in RE_FLAG.finditer(text or ''):
        name, sign = m.group(1), m.group(2)
        on = sign == '+'
        out.append({'name': name, 'on': on, 'bad': on and name in ERROR_FLAGS})
    return out


def speed_value(text):
    try:
        return float(str(text).split('GT')[0])
    except ValueError:
        return 0.0


def parse_details(d):
    """Reads the verbose lines of one device into fields: subsystem, physical slot, NUMA node, IOMMU group, the driver
    and modules, the interrupt, the regions with their sizes, the link capability vs status (a downgraded link is
    flagged), the Control and Status flags (the set error flags flagged)."""
    f = {'subsystem': '', 'physical_slot': '', 'iommu_group': '', 'interrupt': '', 'regions': [], 'link': None, 'control': [], 'status': [], 'latency': '', 'capabilities': []}
    d['driver'], d['modules'], d['numa_node'] = '', '', ''
    lnkcap = lnksta = None
    for line in d.get('details', []):
        s = line.strip()
        if s.startswith('Kernel driver in use:'):
            d['driver'] = s.split(':', 1)[1].strip()
        elif s.startswith('Kernel modules:'):
            d['modules'] = s.split(':', 1)[1].strip()
        elif s.startswith('NUMA node:'):
            d['numa_node'] = s.split(':', 1)[1].strip()
        elif s.startswith('Subsystem:'):
            f['subsystem'] = s.split(':', 1)[1].strip()
        elif s.startswith('Physical Slot:'):
            f['physical_slot'] = s.split(':', 1)[1].strip()
        elif s.startswith('IOMMU group:'):
            f['iommu_group'] = s.split(':', 1)[1].strip()
        elif s.startswith('Interrupt:'):
            f['interrupt'] = s.split(':', 1)[1].strip()
        elif s.startswith('Latency:'):
            f['latency'] = s.split(':', 1)[1].strip()
        elif s.startswith('Region ') or s.startswith('Expansion ROM'):
            m = RE_SIZE.search(s)
            f['regions'].append({'text': s, 'size': m.group(1) if m else ''})
        elif s.startswith('LnkCap:'):
            lnkcap = RE_LINK.search(s)
        elif s.startswith('LnkSta:'):
            lnksta = RE_LINK.search(s)
        elif s.startswith('Control:') and not f['control']:
            f['control'] = parse_flags(s.split(':', 1)[1])
        elif s.startswith('Status:') and not f['status']:
            f['status'] = parse_flags(s.split(':', 1)[1])
        elif s.startswith('Capabilities:') and '] ' in s:
            f['capabilities'].append(s.split('] ', 1)[1].split(':')[0].strip())
    if lnkcap and lnksta:
        cap_speed, cap_width = lnkcap.group(1).replace(' ', ''), int(lnkcap.group(2))
        sta_speed, sta_width = lnksta.group(1).replace(' ', ''), int(lnksta.group(2))
        down = speed_value(sta_speed) < speed_value(cap_speed) or sta_width < cap_width
        f['link'] = {'cap_speed': cap_speed, 'cap_width': cap_width, 'sta_speed': sta_speed, 'sta_width': sta_width, 'downgraded': down,
                     'text': f"{sta_speed} x{sta_width}", 'cap_text': f"{cap_speed} x{cap_width}"}
    f['error_flags'] = [x['name'] for x in f['status'] if x['bad']]
    d['vendor'], d['model'] = split_vendor(d.get('description') or '')
    d.update(f)
    return d


def enrich(devices):
    """Reads each device's verbose lines into fields (parse_details), counts the classes (by_class), and builds the
    Findings: network / storage devices without a driver bound, downgraded PCIe links, set error flags, the NICs
    (linked to the interface counters)."""
    out = []
    by_class = {}
    for d in devices:
        parse_details(d)
        cls = d.get('class') or ''
        by_class[cls] = by_class.get(cls, 0) + 1
    verbose = any(d.get('details') for d in devices)
    is_kind = lambda d, kinds: any(k in (d.get('class') or '').lower() for k in kinds)  # noqa: E731
    if verbose:
        nodrv = [d for d in devices if not d['driver'] and is_kind(d, NETWORK_CLASSES + STORAGE_CLASSES)]
        if nodrv:
            out.append(finding('warn', f"{len(nodrv)} network / storage device{'s' if len(nodrv) != 1 else ''} without a kernel driver", ', '.join(f"{d['slot']} {(d.get('description') or '')[:40]}" for d in nodrv[:6]) + (' …' if len(nodrv) > 6 else ''), count=len(nodrv)))
        for d in [d for d in devices if d.get('link') and d['link']['downgraded']]:
            lk = d['link']
            out.append(finding('warn', f"{d['slot']} {d.get('model') or d.get('description') or ''}: PCIe link downgraded", f"{lk['cap_text']} capable, running {lk['text']}: a slot, a riser or a cable limits the bandwidth", tab='system', sub_tab='pci_devices', query=d['slot']))
        for d in [d for d in devices if d.get('error_flags')]:
            out.append(finding('warn', f"{d['slot']} {d.get('model') or d.get('description') or ''}: PCI error flags set", ', '.join(x + '+' for x in d['error_flags']) + " in the device's Status: a bus error was reported", tab='system', sub_tab='pci_devices', query=d['slot']))
    nics = [d for d in devices if is_kind(d, NETWORK_CLASSES)]
    if nics:
        drivers = ', '.join(sorted({d['driver'] or 'no driver' for d in nics})) if verbose else 'drivers not in this capture'
        out.append(finding('info', f"{len(nics)} network controller{'s' if len(nics) != 1 else ''}", drivers + "; the interfaces' counters are under Network", tab='network', sub_tab='network_stats', count=len(nics)))
    if devices and not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{len(devices)} PCI devices, every network and storage device has its driver, no downgraded link, no error flag" if verbose else f"{len(devices)} PCI devices (a plain capture: no driver or link information)"))
    return {'findings': sort_findings(out), 'by_class': dict(sorted(by_class.items(), key=lambda kv: (-kv[1], kv[0])))}
