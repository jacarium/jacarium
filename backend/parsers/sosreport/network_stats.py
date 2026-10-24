"""Network > Interface Statistics: every interface of a sosreport with its
state, MTU, addresses, driver and the RX / TX counters (`ip -s -d link`),
the bonds with their slaves (proc/net/bonding), and the Findings strip:
errors and drops on an interface, a bond slave down, an interface down
that carries an address, MTU mismatches inside a bond.

Captures: sos_commands/networking/ip_-s_-d_link (iproute2 4.x-6.x: the RX
and TX header names are read as they come), sos_commands/networking/
ip_-d_address (or ip_address), proc/net/bonding/<bond>,
sos_commands/networking/ethtool_-i_<iface> (driver, version, firmware).
"""
import os
import re

from parsers.findings import finding, human_count, sort_findings

from ._common import first_existing, read_text, report_root

RE_IFACE = re.compile(r'^\d+: (\S+?)(?:@\S+)?:')


def parse_ip_link(raw):
    interfaces = {}
    for block in re.split(r'\n(?=\d+:)', raw):
        lines = block.strip().splitlines()
        if not lines:
            continue
        m = RE_IFACE.match(lines[0])
        if not m:
            continue
        iface = m.group(1)
        stats = {'RX': {}, 'TX': {}, 'VFs': {}, 'MTU': None, 'State': None, 'master': None}
        mtu = re.search(r'\bmtu (\d+)', lines[0])
        if mtu:
            stats['MTU'] = int(mtu.group(1))
        st = re.search(r'\bstate (\S+)', lines[0])
        if st:
            stats['State'] = st.group(1).upper()
        master = re.search(r'\bmaster (\S+)', lines[0])
        if master:
            stats['master'] = master.group(1)
        i = 1
        target = stats
        while i < len(lines):
            line = lines[i].strip()
            if line.startswith('vf '):
                vm = re.match(r'vf (\d+)', line)
                target = stats['VFs'].setdefault(f"vf {vm.group(1)}", {'RX': {}, 'TX': {}}) if vm else stats
            elif line.startswith('RX:') or line.startswith('TX:'):
                side = line[:2]
                headers = line[3:].split()
                values = lines[i + 1].split() if i + 1 < len(lines) else []
                if len(headers) == len(values):
                    try:
                        target[side] = dict(zip(headers, map(int, values)))
                    except ValueError:
                        pass
                i += 1
            i += 1
        interfaces[iface] = stats
    return interfaces


def parse_ip_address(raw):
    """{iface: [addresses]} from `ip -d address` / `ip address`."""
    out = {}
    iface = None
    for line in raw.splitlines():
        m = RE_IFACE.match(line)
        if m:
            iface = m.group(1)
            out.setdefault(iface, [])
            continue
        s = line.strip()
        if iface and (s.startswith('inet ') or s.startswith('inet6 ')):
            parts = s.split()
            if len(parts) > 1 and not parts[1].startswith('fe80:'):
                out[iface].append(parts[1])
    return out


def parse_bonding(root):
    """{bond: {'mode', 'mii_status', 'slaves': [{'name', 'mii_status', 'speed', 'failures'}]}} from proc/net/bonding."""
    bonds = {}
    d = os.path.join(root, 'proc', 'net', 'bonding')
    if not os.path.isdir(d):
        return bonds
    for name in sorted(os.listdir(d)):
        txt = read_text(os.path.join(d, name), 200000)
        if not txt:
            continue
        bond = {'mode': '', 'mii_status': '', 'slaves': []}
        slave = None
        for line in txt.splitlines():
            s = line.strip()
            if s.startswith('Bonding Mode:'):
                bond['mode'] = s.split(':', 1)[1].strip()
            elif s.startswith('Slave Interface:'):
                slave = {'name': s.split(':', 1)[1].strip(), 'mii_status': '', 'speed': '', 'failures': 0}
                bond['slaves'].append(slave)
            elif s.startswith('MII Status:'):
                if slave:
                    slave['mii_status'] = s.split(':', 1)[1].strip()
                else:
                    bond['mii_status'] = s.split(':', 1)[1].strip()
            elif s.startswith('Speed:') and slave:
                slave['speed'] = s.split(':', 1)[1].strip()
            elif s.startswith('Link Failure Count:') and slave:
                try:
                    slave['failures'] = int(s.split(':', 1)[1].strip())
                except ValueError:
                    pass
        bonds[name] = bond
    return bonds


def parse_ethtool_i(root, iface):
    p = os.path.join(root, 'sos_commands', 'networking', f'ethtool_-i_{iface}')
    if not os.path.isfile(p):
        return {}
    out = {}
    for line in read_text(p, 4000).splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            if k.strip() in ('driver', 'version', 'firmware-version'):
                out[k.strip()] = v.strip()
    return out


def parse(directory):
    root = report_root(directory)
    result = {'ip_info': {}, 'bonds': {}, 'findings': []}
    link = first_existing(root, 'sos_commands/networking/ip_-s_-d_link', 'sos_commands/networking/ip_-s_link')
    if not link:
        result['findings'] = [finding('info', 'No interface counters in this report', 'sos_commands/networking/ip_-s_-d_link is missing')]
        return result
    interfaces = parse_ip_link(read_text(link))
    addr_path = first_existing(root, 'sos_commands/networking/ip_-d_address', 'sos_commands/networking/ip_address', 'sos_commands/networking/ip_-o_addr')
    addresses = parse_ip_address(read_text(addr_path)) if addr_path else {}
    for iface, stats in interfaces.items():
        stats['addresses'] = addresses.get(iface, [])
        stats['ethtool'] = parse_ethtool_i(root, iface)
    result['ip_info'] = interfaces
    result['bonds'] = parse_bonding(root)
    result['findings'] = findings_for(interfaces, result['bonds'])
    return result


def findings_for(interfaces, bonds):
    """The Findings strip: RX / TX errors or drops (warn; bad over 1% of the packets), a bond slave down (bad) or a
    bond with one slave left (warn), an interface DOWN that carries an address, MTU mismatches inside a bond."""
    out = []
    for iface, st in interfaces.items():
        if iface == 'lo':
            continue
        for side in ('RX', 'TX'):
            c = st.get(side) or {}
            packets = c.get('packets', 0) or 0
            errors = c.get('errors', 0) or 0
            dropped = c.get('dropped', 0) or 0
            missed = c.get('missed', 0) or 0
            bad = errors + dropped + missed
            if bad:
                share = (100.0 * bad / packets) if packets else 0
                out.append(finding('bad' if share >= 1 else 'warn', f"{iface}: {human_count(bad)} {side} {'errors' if errors and not dropped else 'drops' if dropped and not errors else 'errors and drops'}",
                                   f"{human_count(errors)} errors, {human_count(dropped)} dropped, {human_count(missed)} missed of {human_count(packets)} packets ({share:.2f}%)", count=int(share * 100)))
        if st.get('State') == 'DOWN' and st.get('addresses'):
            out.append(finding('warn', f"{iface} is DOWN but configured", f"addresses {', '.join(st['addresses'][:3])}"))
    for name, b in bonds.items():
        down = [s for s in b['slaves'] if s['mii_status'].lower() != 'up']
        up = [s for s in b['slaves'] if s['mii_status'].lower() == 'up']
        if down:
            out.append(finding('bad', f"{name}: slave {', '.join(s['name'] for s in down)} down", f"{b['mode']}; {len(up)} of {len(b['slaves'])} slaves up", count=len(down)))
        elif len(b['slaves']) == 1:
            out.append(finding('warn', f"{name} has a single slave ({b['slaves'][0]['name']})", f"{b['mode']}: no redundancy"))
        flaps = [s for s in b['slaves'] if s['failures'] >= 3]
        if flaps:
            out.append(finding('warn', f"{name}: link failures on {', '.join(f'{s['name']} ({s['failures']})' for s in flaps)}", "the link went down and up repeatedly"))
        mtus = {interfaces.get(s['name'], {}).get('MTU') for s in b['slaves'] if interfaces.get(s['name'], {}).get('MTU')}
        if len(mtus) > 1:
            out.append(finding('warn', f"{name}: its slaves have different MTUs ({', '.join(str(m) for m in sorted(mtus))})"))
    ups = [i for i, st in interfaces.items() if st.get('State') == 'UP']
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"No errors or drops on {len(interfaces)} interfaces ({len(ups)} up)" + (f", {len(bonds)} bond{'s' if len(bonds) != 1 else ''} healthy" if bonds else '')))
    return sort_findings(out)
