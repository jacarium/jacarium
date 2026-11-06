"""Network > Network Configuration: how the host's network is configured and
how it actually runs, side by side.

  bonds      proc/net/bonding/<bond> (parsed once, in network_stats.parse_bonding):
             mode, the primary and the currently active slave (marked
             primary / secondary / active), MII status and polling, the up /
             down delays, the 802.3ad details (aggregator ids, actor / partner
             keys, the partner MAC), per slave the MII status, speed / duplex,
             link failure count, permanent HW address
  profiles   NetworkManager connection profiles: nmcli connection show (the
             table) and the per-connection `nmcli connection show <id>`
             captures under sos_commands/networkmanager/, the keyfiles under
             etc/NetworkManager/system-connections/ when sos collected them,
             the legacy etc/sysconfig/network-scripts/ifcfg-* files - each as
             type, interface, controller (master) and port type, bond options,
             VLAN id / parent, bridge, IP method / addresses / gateway / DNS,
             MTU, autoconnect. SECRETS (wifi PSK, 802.1x passwords, VPN
             secrets, private keys - any psk / password / secret / passphrase /
             private-key key) are masked before anything leaves the parser.
  runtime    ip -d link / ip -d address (kinds: bond, vlan with id and parent,
             bridge, openvswitch; master; state; MTU; addresses), ip route,
             ethtool <iface> (speed, duplex, link), `bridge link`
  bridges    Open vSwitch (sos_commands/openvswitch: ovs-vsctl show / list-br /
             list-ports / list interface) - the bridges with their ports and
             interface types (system = a NIC or bond uplink, internal, patch,
             the br-ex of OVN-Kubernetes); Linux bridges from ip -d link
             (kind bridge, the members by master) and `bridge link`
  nmcli      the collected nmcli outputs as they are (general status, device
             status, device show, connection show, the per-connection
             dumps), tables where tabular, key/value blocks otherwise,
             secrets masked

The comparison: a configured bond primary that is not the active slave, a
configured bond port missing at runtime, a profile MTU that differs from the
interface's, a profile's bridge membership not seen at runtime - each a
marker on the row and a Finding.
"""
import glob
import os
import re

from parsers.findings import finding, no_data, sort_findings

from ._common import first_existing, read_text, report_root
from .network_stats import parse_bonding, parse_ip_address

RE_IFACE = re.compile(r'^\d+: (\S+?)(?:@(\S+))?:')
SECRET_KEY = re.compile(r'(psk|password|secret|passphrase|private-key|pin\b|token)', re.I)
MASK = '<redacted>'

# ---------------------------------------------------------------------------
# secrets
# ---------------------------------------------------------------------------

def is_secret_key(key):
    """Does a profile / nmcli key hold a secret (its value is never shown)?"""
    k = str(key or '')
    if k.endswith('-flags') or k.endswith('_FLAGS'):
        return False
    return bool(SECRET_KEY.search(k))


def mask_value(key, value):
    return MASK if is_secret_key(key) and str(value or '').strip() not in ('', '--', '<hidden>') else value


# ---------------------------------------------------------------------------
# runtime: ip -d link / address / route, ethtool, bridge link
# ---------------------------------------------------------------------------

def parse_ip_d_link(raw):
    """{iface: {'kind', 'state', 'mtu', 'master', 'mac', 'vlan_id', 'parent', 'bond_mode', 'flags'}} from `ip -d link`
    (or `ip -s -d link`: the detail line names the kind - bond, vlan, bridge, openvswitch, veth, bond_slave ...)."""
    out = {}
    for block in re.split(r'\n(?=\d+:)', raw or ''):
        lines = block.strip().splitlines()
        if not lines:
            continue
        m = RE_IFACE.match(lines[0])
        if not m:
            continue
        name, parent = m.group(1), m.group(2)
        head = lines[0]
        d = {'kind': '', 'state': '', 'mtu': None, 'master': '', 'mac': '', 'vlan_id': None, 'parent': parent or '',
             'bond_mode': '', 'flags': '', 'slave_kind': ''}
        fm = re.search(r'<([^>]*)>', head)
        if fm:
            d['flags'] = fm.group(1)
        mtu = re.search(r'\bmtu (\d+)', head)
        if mtu:
            d['mtu'] = int(mtu.group(1))
        st = re.search(r'\bstate (\S+)', head)
        if st:
            d['state'] = st.group(1).upper()
        master = re.search(r'\bmaster (\S+)', head)
        if master:
            d['master'] = master.group(1)
        for line in lines[1:]:
            s = line.strip()
            if s.startswith('link/'):
                parts = s.split()
                if len(parts) > 1 and parts[0] != 'link/loopback':
                    d['mac'] = parts[1]
                continue
            km = re.match(r'^(bond_slave|bridge_slave|openvswitch_slave|vlan|bond|bridge|openvswitch|veth|tun|dummy|macvlan|ipvlan|vrf|vxlan|team|team_slave)\b(.*)$', s)
            if km:
                kind, rest = km.group(1), km.group(2)
                if kind.endswith('_slave'):
                    d['slave_kind'] = kind[:-6]
                    continue
                d['kind'] = kind
                if kind == 'vlan':
                    vid = re.search(r'\bid (\d+)', rest)
                    if vid:
                        d['vlan_id'] = int(vid.group(1))
                elif kind == 'bond':
                    mm = re.search(r'\bmode (\S+)', rest)
                    if mm:
                        d['bond_mode'] = mm.group(1)
        if name == 'lo':
            d['kind'] = 'loopback'
        out[name] = d
    return out


def parse_routes(raw):
    """[{'dst', 'via', 'dev', 'proto', 'metric', 'table', 'src'}] from `ip route show table all` (main table and
    default routes first; the local table's entries are skipped)."""
    routes = []
    for line in (raw or '').splitlines():
        s = line.strip()
        if not s or s.startswith(('local ', 'broadcast ', 'unreachable ', 'multicast ', 'anycast ')):
            continue
        parts = s.split()
        r = {'dst': parts[0], 'via': '', 'dev': '', 'proto': '', 'metric': '', 'table': 'main', 'src': ''}
        for i, p in enumerate(parts[1:], start=1):
            if p in ('via', 'dev', 'proto', 'metric', 'table', 'src') and i + 1 < len(parts):
                r[p] = parts[i + 1]
        if r['table'] == 'local':
            continue
        routes.append(r)
    return routes


def parse_ethtool(root, iface):
    """{'speed', 'duplex', 'link', 'port', 'auto_negotiation'} from sos_commands/networking/ethtool_<iface>."""
    p = os.path.join(root, 'sos_commands', 'networking', f'ethtool_{iface}')
    if not os.path.isfile(p):
        return {}
    out = {}
    for line in read_text(p, 20000).splitlines():
        s = line.strip()
        if ':' not in s:
            continue
        k, v = (x.strip() for x in s.split(':', 1))
        if k == 'Speed':
            out['speed'] = v
        elif k == 'Duplex':
            out['duplex'] = v
        elif k == 'Link detected':
            out['link'] = v
        elif k == 'Port':
            out['port'] = v
        elif k == 'Auto-negotiation':
            out['auto_negotiation'] = v
    return out


def parse_bridge_link(raw):
    """{member: bridge} from `bridge link` (`2: eth1: <...> master br0 state forwarding ...`)."""
    out = {}
    for line in (raw or '').splitlines():
        m = re.match(r'^\d+:\s+(\S+?)(?:@\S+)?:.*\bmaster (\S+)', line.strip())
        if m:
            out[m.group(1)] = m.group(2)
    return out


# ---------------------------------------------------------------------------
# Open vSwitch
# ---------------------------------------------------------------------------

def parse_ovs_vsctl_show(raw):
    """{bridge: {'ports': [{'name', 'interfaces': [{'name', 'type', 'options'}], 'tag', 'bond': bool}], 'fail_mode',
    'datapath_type'}} from `ovs-vsctl show` (the indented tree: Bridge / Port / Interface / type / options / tag)."""
    bridges = {}
    bridge = port = iface = None
    for line in (raw or '').splitlines():
        s = line.strip()
        indent = len(line) - len(line.lstrip(' '))
        if not s:
            continue
        m = re.match(r'^Bridge\s+"?([^"\s]+)"?', s)
        if m:
            bridge = bridges.setdefault(m.group(1), {'ports': [], 'fail_mode': '', 'datapath_type': ''})
            port = iface = None
            continue
        if bridge is None:
            continue
        m = re.match(r'^Port\s+"?([^"\s]+)"?', s)
        if m:
            port = {'name': m.group(1), 'interfaces': [], 'tag': '', 'bond': False, 'indent': indent}
            bridge['ports'].append(port)
            iface = None
            continue
        m = re.match(r'^Interface\s+"?([^"\s]+)"?', s)
        if m and port is not None:
            iface = {'name': m.group(1), 'type': 'system', 'options': ''}
            port['interfaces'].append(iface)
            if len(port['interfaces']) > 1:
                port['bond'] = True
            continue
        m = re.match(r'^type:\s*"?([^"\s]+)"?', s)
        if m and iface is not None:
            iface['type'] = m.group(1)
            continue
        m = re.match(r'^options:\s*(.*)$', s)
        if m and iface is not None:
            iface['options'] = m.group(1).strip('{} ')
            continue
        m = re.match(r'^tag:\s*(\d+)', s)
        if m and port is not None:
            port['tag'] = m.group(1)
            continue
        m = re.match(r'^fail_mode:\s*(\S+)', s)
        if m:
            bridge['fail_mode'] = m.group(1)
            continue
        m = re.match(r'^datapath_type:\s*(\S+)', s)
        if m:
            bridge['datapath_type'] = m.group(1)
    for b in bridges.values():
        for p in b['ports']:
            p.pop('indent', None)
    return bridges


def parse_ovs_list_interface(raw):
    """{name: {'type', 'admin_state', 'link_state', 'mtu', 'mac_in_use', 'ofport'}} from `ovs-vsctl list interface`
    (records separated by blank lines, `key : value`)."""
    out = {}
    rec = {}
    def flush():
        if rec.get('name'):
            out[rec['name']] = {k: rec.get(k, '') for k in ('type', 'admin_state', 'link_state', 'mtu', 'mac_in_use', 'ofport')}
    for line in (raw or '').splitlines():
        s = line.strip()
        if not s:
            flush()
            rec = {}
            continue
        if ':' in s:
            k, v = (x.strip() for x in s.split(':', 1))
            rec[k] = v.strip('"')
    flush()
    return out


def ovs_membership(bridges):
    """{member interface or bond: {'bridge', 'type', 'port'}} - every interface of every OVS port (a system
    interface is a NIC or a bond uplink; internal / patch ports are OVS's own)."""
    out = {}
    for bname, b in bridges.items():
        for p in b['ports']:
            for i in p['interfaces']:
                out[i['name']] = {'bridge': bname, 'type': i['type'], 'port': p['name'], 'tag': p.get('tag', '')}
    return out


# ---------------------------------------------------------------------------
# NetworkManager: nmcli captures, keyfiles, ifcfg
# ---------------------------------------------------------------------------

def parse_nmcli_table(raw):
    """A tabular nmcli output (connection show, device status) as [{'NAME': .., 'UUID': .., ...}]: the header's
    column starts give the cells (a NAME may contain spaces)."""
    lines = [l for l in (raw or '').splitlines() if l.strip()]
    if not lines:
        return []
    header = lines[0]
    cols = [(m.group(0), m.start()) for m in re.finditer(r'\S+', header)]
    if not cols:
        return []
    rows = []
    for line in lines[1:]:
        row = {}
        for i, (name, start) in enumerate(cols):
            end = cols[i + 1][1] if i + 1 < len(cols) else None
            row[name] = line[start:end].strip() if end is not None else line[start:].strip()
        rows.append(row)
    return rows


def parse_nmcli_kv(raw, mask=True):
    """A `nmcli connection show <id>` / `nmcli device show <dev>` dump as an ordered list of (key, value), the
    multi-value keys (IP4.ADDRESS[1], ipv4.addresses) as they come; secrets masked."""
    out = []
    for line in (raw or '').splitlines():
        if ':' not in line:
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if not k:
            continue
        out.append((k, mask_value(k, v) if mask else v))
    return out


def kv_dict(pairs):
    d = {}
    for k, v in pairs:
        d.setdefault(k, v)
    return d


def parse_keyfile(raw):
    """A NetworkManager keyfile (.nmconnection): {section.key: value}, secrets masked."""
    out = {}
    section = ''
    for line in (raw or '').splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('[') and s.endswith(']'):
            section = s[1:-1].strip()
            continue
        if '=' in s:
            k, v = (x.strip() for x in s.split('=', 1))
            key = f'{section}.{k}' if section else k
            out[key] = mask_value(key, v)
    return out


def parse_ifcfg(raw):
    """An ifcfg-<name> file: {KEY: value} (quotes stripped), secrets masked."""
    out = {}
    for line in (raw or '').splitlines():
        s = line.strip()
        if not s or s.startswith('#') or '=' not in s:
            continue
        k, v = (x.strip() for x in s.split('=', 1))
        v = v.strip('"').strip("'")
        out[k] = mask_value(k, v)
    return out


def _bond_options(text):
    """'mode=active-backup,miimon=100,primary=eth3' -> {'mode': .., 'miimon': .., 'primary': ..} (also space-separated)."""
    opts = {}
    for part in re.split(r'[,\s]+', str(text or '').strip()):
        if '=' in part:
            k, v = part.split('=', 1)
            opts[k.strip()] = v.strip()
    return opts


def _split_list(value):
    return [x.strip() for x in re.split(r'[,\s]+', str(value or '')) if x.strip() and x.strip() != '--']


def profile_from_nmcli(pairs, name=None):
    """The profile shape from a `nmcli connection show <id>` dump (keys like connection.type, bond.options)."""
    d = kv_dict(pairs)
    g = lambda k, default='': (d.get(k) if d.get(k) not in (None, '--', '') else default)   # noqa: E731
    ctype = g('connection.type')
    p = _profile_base(name or g('connection.id'), ctype, g('connection.interface-name'))
    p['uuid'] = g('connection.uuid')
    p['controller'] = g('connection.master') or g('connection.controller')
    p['port_type'] = g('connection.slave-type') or g('connection.port-type')
    p['autoconnect'] = g('connection.autoconnect', 'yes')
    p['bond_options'] = _bond_options(g('bond.options'))
    p['vlan'] = {'id': g('vlan.id'), 'parent': g('vlan.parent')} if ctype == 'vlan' else {}
    p['ipv4'] = {'method': g('ipv4.method'), 'addresses': _split_list(g('ipv4.addresses')), 'gateway': g('ipv4.gateway'), 'dns': _split_list(g('ipv4.dns'))}
    p['ipv6'] = {'method': g('ipv6.method'), 'addresses': _split_list(g('ipv6.addresses')), 'gateway': g('ipv6.gateway'), 'dns': _split_list(g('ipv6.dns'))}
    mtu = g('802-3-ethernet.mtu') or g('vlan.mtu') or g('bond.mtu') or g('bridge.mtu') or g('ovs-interface.mtu') or g('802-11-wireless.mtu')
    p['mtu'] = mtu if mtu not in ('', 'auto', '0') else ''
    p['bridge'] = {'stp': g('bridge.stp')} if ctype == 'bridge' else {}
    p['wifi'] = {'ssid': g('802-11-wireless.ssid'), 'key_mgmt': g('802-11-wireless-security.key-mgmt'), 'secret': MASK if g('802-11-wireless-security.psk') else ''} if ctype in ('802-11-wireless', 'wifi') else {}
    p['raw'] = [(k, v) for k, v in pairs if not k[:1].isupper()]   # the settings (the runtime IP4./GENERAL. lines are the device's)
    return p


def profile_from_keyfile(kf, filename=''):
    g = lambda k, default='': kf.get(k, default) or default   # noqa: E731
    ctype = g('connection.type')
    p = _profile_base(g('connection.id') or filename, ctype, g('connection.interface-name'))
    p['uuid'] = g('connection.uuid')
    p['controller'] = g('connection.master') or g('connection.controller')
    p['port_type'] = g('connection.slave-type') or g('connection.port-type')
    p['autoconnect'] = 'no' if g('connection.autoconnect').lower() in ('false', 'no') else 'yes'
    p['bond_options'] = {k.split('.', 1)[1]: v for k, v in kf.items() if k.startswith('bond.') and k != 'bond.mtu'}
    p['vlan'] = {'id': g('vlan.id'), 'parent': g('vlan.parent')} if ctype == 'vlan' else {}
    for fam in ('ipv4', 'ipv6'):
        addrs = []
        gw = ''
        for k in sorted(kf):
            if re.match(rf'^{fam}\.address\d*$', k):
                a, _, gwv = kf[k].partition(',')
                addrs.append(a.strip())
                if gwv.strip():
                    gw = gwv.strip()
        p[fam] = {'method': g(f'{fam}.method'), 'addresses': addrs, 'gateway': g(f'{fam}.gateway') or gw, 'dns': [x for x in g(f'{fam}.dns').rstrip(';').split(';') if x]}
    mtu = g('ethernet.mtu') or g('802-3-ethernet.mtu') or g('vlan.mtu') or g('bond.mtu')
    p['mtu'] = mtu if mtu not in ('', '0') else ''
    p['wifi'] = {'ssid': g('wifi.ssid'), 'key_mgmt': g('wifi-security.key-mgmt'), 'secret': MASK if g('wifi-security.psk') else ''} if ctype in ('wifi', '802-11-wireless') else {}
    p['raw'] = sorted(kf.items())
    return p


IFCFG_TYPES = {'Bond': 'bond', 'Ethernet': '802-3-ethernet', 'Vlan': 'vlan', 'Bridge': 'bridge', 'OVSBridge': 'ovs-bridge', 'OVSPort': 'ovs-port', 'OVSIntPort': 'ovs-interface'}


def profile_from_ifcfg(cfg, filename=''):
    g = lambda k, default='': cfg.get(k, default) or default   # noqa: E731
    dev = g('DEVICE') or g('NAME') or filename.replace('ifcfg-', '')
    ctype = IFCFG_TYPES.get(g('TYPE'), g('TYPE').lower() or '802-3-ethernet')
    if g('VLAN').lower() == 'yes' or '.' in dev and not g('TYPE'):
        ctype = 'vlan'
    if g('BONDING_MASTER').lower() == 'yes':
        ctype = 'bond'
    p = _profile_base(g('NAME') or dev, ctype, dev)
    p['uuid'] = g('UUID')
    p['controller'] = g('MASTER') or g('BRIDGE') or g('OVS_BRIDGE')
    p['port_type'] = 'bond' if g('SLAVE').lower() == 'yes' or g('MASTER') else ('bridge' if g('BRIDGE') else ('ovs-port' if g('OVS_BRIDGE') else ''))
    p['autoconnect'] = 'no' if g('ONBOOT').lower() == 'no' else 'yes'
    p['bond_options'] = _bond_options(g('BONDING_OPTS'))
    if ctype == 'vlan':
        vid = g('VLAN_ID') or (dev.rsplit('.', 1)[1] if '.' in dev else '')
        p['vlan'] = {'id': vid, 'parent': g('PHYSDEV') or (dev.rsplit('.', 1)[0] if '.' in dev else '')}
    method = 'auto' if g('BOOTPROTO').lower() == 'dhcp' else ('manual' if g('IPADDR') else ('disabled' if g('BOOTPROTO').lower() == 'none' else g('BOOTPROTO').lower()))
    addrs = []
    for k in sorted(cfg):
        if re.match(r'^IPADDR\d*$', k):
            n = k[6:]
            prefix = cfg.get(f'PREFIX{n}') or cfg.get('PREFIX') or ''
            addrs.append(f"{cfg[k]}/{prefix}" if prefix else cfg[k])
    p['ipv4'] = {'method': method, 'addresses': addrs, 'gateway': g('GATEWAY'), 'dns': [cfg[k] for k in sorted(cfg) if re.match(r'^DNS\d+$', k)]}
    p['ipv6'] = {'method': 'auto' if g('IPV6INIT').lower() == 'yes' and not g('IPV6ADDR') else ('manual' if g('IPV6ADDR') else ''), 'addresses': [g('IPV6ADDR')] if g('IPV6ADDR') else [], 'gateway': g('IPV6_DEFAULTGW'), 'dns': []}
    p['mtu'] = g('MTU')
    p['raw'] = sorted(cfg.items())
    return p


def _profile_base(name, ctype, iface):
    return {'name': name or '', 'type': ctype or '', 'interface': iface or '', 'uuid': '', 'controller': '', 'port_type': '',
            'autoconnect': 'yes', 'bond_options': {}, 'vlan': {}, 'bridge': {}, 'wifi': {}, 'ipv4': {}, 'ipv6': {}, 'mtu': '', 'raw': [], 'source': ''}


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------

def _read(root, *rels):
    p = first_existing(root, *rels)
    return read_text(p) if p else ''


def _nm_captures(root):
    """{'general': table, 'devices': table, 'device_show': {dev: pairs}, 'connections': table, 'connection_show':
    {name: pairs}, 'files': [names], 'captures': [one per file]} from sos_commands/networkmanager (every capture
    masked). A capture: {'file', 'command' (the readable command, e.g. "nmcli connection show bond0"), 'kind'
    (general / devices / connections / device / connection / other), 'target' (the connection or device the
    command names, '' for a list), 'entries' (rows or keys), 'rows' (a table) or 'pairs' (key / value),
    'secrets_masked'}."""
    d = os.path.join(root, 'sos_commands', 'networkmanager')
    out = {'general': [], 'devices': [], 'device_show': {}, 'connections': [], 'connection_show': {}, 'files': [], 'captures': []}
    if not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            continue
        txt = read_text(p, 400000)
        out['files'].append(name)
        low = name.lower()
        cap = {'file': name, 'command': 'nmcli ' + re.sub(r'^nmcli_', '', name).replace('_', ' '), 'kind': 'other', 'target': '', 'entries': 0, 'rows': [], 'pairs': [], 'secrets_masked': False}
        if re.match(r'^nmcli_(general|gen)_status$', low):
            out['general'] = parse_nmcli_table(txt)
            cap.update(command='nmcli general status', kind='general', rows=out['general'])
        elif re.match(r'^nmcli_(dev|device)_status$', low):
            out['devices'] = parse_nmcli_table(txt)
            cap.update(command='nmcli device status', kind='devices', rows=out['devices'])
        elif re.match(r'^nmcli_(dev|device)_show(_|$)', low):
            # one capture with every device, or one per device: split on the GENERAL.DEVICE lines
            pairs = parse_nmcli_kv(txt)
            current = None
            devices = []
            for k, v in pairs:
                if k == 'GENERAL.DEVICE':
                    current = v
                    devices.append(v)
                    out['device_show'].setdefault(current, [])
                if current is not None:
                    out['device_show'][current].append((k, v))
            one = re.sub(r'^nmcli_(dev|device)_show_?', '', name)
            cap.update(command='nmcli device show' + (' ' + one if one else ''), kind='device', target=one or (devices[0] if len(devices) == 1 else ''), pairs=pairs)
        elif re.match(r'^nmcli_(con|connection)_show$', low):
            out['connections'] = parse_nmcli_table(txt)
            cap.update(command='nmcli connection show', kind='connections', rows=out['connections'])
        elif re.match(r'^nmcli_(con|connection)_show_', low):
            pairs = parse_nmcli_kv(txt)
            ident = kv_dict(pairs).get('connection.id') or re.sub(r'^nmcli_(con|connection)_show_(id_|uuid_)?', '', name)
            out['connection_show'][ident] = pairs
            cap.update(command=f'nmcli connection show {ident}', kind='connection', target=ident, pairs=pairs)
        else:
            cap['pairs'] = parse_nmcli_kv(txt)
        cap['entries'] = len(cap['rows']) if cap['rows'] else len(cap['pairs'])
        cap['secrets_masked'] = any(v == MASK for _, v in cap['pairs'])
        out['captures'].append(cap)
    return out


def collect_profiles(root, nm):
    profiles = []
    seen = set()
    for ident, pairs in nm['connection_show'].items():
        p = profile_from_nmcli(pairs, ident)
        p['source'] = 'nmcli connection show'
        profiles.append(p)
        seen.add(p['name'])
    kf_dir = os.path.join(root, 'etc', 'NetworkManager', 'system-connections')
    if os.path.isdir(kf_dir):
        for name in sorted(os.listdir(kf_dir)):
            if not name.endswith('.nmconnection'):
                continue
            p = profile_from_keyfile(parse_keyfile(read_text(os.path.join(kf_dir, name), 200000)), name[:-len('.nmconnection')])
            p['source'] = f'etc/NetworkManager/system-connections/{name}'
            if p['name'] in seen:
                for q in profiles:
                    if q['name'] == p['name'] and not q.get('keyfile'):
                        q['keyfile'] = p['source']
                continue
            profiles.append(p)
            seen.add(p['name'])
    for path in sorted(glob.glob(os.path.join(root, 'etc', 'sysconfig', 'network-scripts', 'ifcfg-*'))):
        base = os.path.basename(path)
        if base in ('ifcfg-lo',):
            continue
        p = profile_from_ifcfg(parse_ifcfg(read_text(path, 100000)), base)
        p['source'] = f'etc/sysconfig/network-scripts/{base}'
        if p['name'] in seen:
            continue
        profiles.append(p)
        seen.add(p['name'])
    for p in profiles:
        p['secrets_masked'] = any(is_secret_key(k) and v == MASK for k, v in p.get('raw') or [])
    return profiles


def parse(directory):
    root = report_root(directory)
    out = {'bonds': {}, 'interfaces': [], 'profiles': [], 'ovs': {}, 'bridges': [], 'routes': [], 'dns': [], 'nm': {}, 'findings': [], 'sources': []}

    link_raw = _read(root, 'sos_commands/networking/ip_-d_link', 'sos_commands/networking/ip_-s_-d_link', 'sos_commands/networking/ip_link')
    links = parse_ip_d_link(link_raw)
    addr_raw = _read(root, 'sos_commands/networking/ip_-d_address', 'sos_commands/networking/ip_address', 'sos_commands/networking/ip_-o_addr')
    addresses = parse_ip_address(addr_raw) if addr_raw else {}
    out['routes'] = parse_routes(_read(root, 'sos_commands/networking/ip_route_show_table_all', 'sos_commands/networking/ip_route', 'sos_commands/networking/ip_route_show'))
    out['dns'] = [l.split()[1] for l in read_text(os.path.join(root, 'etc', 'resolv.conf')).splitlines() if l.startswith('nameserver ') and len(l.split()) > 1] if os.path.isfile(os.path.join(root, 'etc', 'resolv.conf')) else []
    bonds = parse_bonding(root)
    out['bonds'] = bonds
    bridge_link = parse_bridge_link(_read(root, 'sos_commands/networking/bridge_link', 'sos_commands/networking/bridge_-d_link', 'sos_commands/networking/bridge_link_show'))
    ovs_raw = _read(root, 'sos_commands/openvswitch/ovs-vsctl_-t_5_show', 'sos_commands/openvswitch/ovs-vsctl_show', 'sos_commands/openvswitch/ovs-vsctl_-t_10_show')
    ovs = parse_ovs_vsctl_show(ovs_raw) if ovs_raw else {}
    ovs_ifaces = parse_ovs_list_interface(_read(root, 'sos_commands/openvswitch/ovs-vsctl_-t_5_list_interface', 'sos_commands/openvswitch/ovs-vsctl_-t_5_list_Interface', 'sos_commands/openvswitch/ovs-vsctl_list_interface'))
    out['ovs'] = {'bridges': ovs, 'interfaces': ovs_ifaces, 'present': bool(ovs_raw)}
    nm = _nm_captures(root)
    out['nm'] = nm
    profiles = collect_profiles(root, nm)
    out['profiles'] = profiles
    membership = ovs_membership(ovs)
    # the profile of an interface: when several name it (an ovs-port and the ovs-interface of br-ex), the one that
    # carries the settings (not the ovs-port) wins
    by_iface = {}
    for p in profiles:
        if not p.get('interface'):
            continue
        cur = by_iface.get(p['interface'])
        if cur is None or (cur['type'] == 'ovs-port' and p['type'] != 'ovs-port'):
            by_iface[p['interface']] = p
    by_name = {p['name']: p for p in profiles}

    def expected_bridge(p):
        """The bridge a profile puts its interface under: its controller, or - for an ovs-interface whose controller is
        an ovs-port profile - that port's controller."""
        c = p.get('controller') or ''
        via = by_name.get(c)
        if via and via.get('type') == 'ovs-port' and via.get('controller'):
            return via['controller']
        return c

    # the bonds' slave roles (primary / secondary / active) and their profile
    for bname, b in bonds.items():
        for s in b['slaves']:
            s['role'] = 'primary' if s['name'] == b.get('primary') else 'secondary'
            s['is_active'] = s['name'] == b.get('active')
        b['profile'] = by_iface.get(bname, {}).get('name', '')
        b['configured_primary'] = (by_iface.get(bname, {}).get('bond_options') or {}).get('primary', '')
        b['configured_ports'] = sorted(p['interface'] for p in profiles if p.get('controller') == bname and p.get('interface'))
        b['member_of'] = _member_of(bname, links.get(bname, {}), membership, bridge_link)

    # the interfaces table: runtime, the profile, the bridge membership, the markers
    rows = []
    for name, d in links.items():
        p = by_iface.get(name) or {}
        row = {'name': name, 'kind': d['kind'] or ('bond slave' if d['slave_kind'] == 'bond' else ('bridge port' if d['slave_kind'] in ('bridge', 'openvswitch') else 'ethernet' if d['mac'] else '')),
               'state': d['state'], 'mtu': d['mtu'], 'mac': d['mac'], 'master': d['master'], 'addresses': addresses.get(name, []),
               'vlan_id': d['vlan_id'], 'parent': d['parent'], 'bond_mode': d['bond_mode'], 'flags': d['flags'],
               'ethtool': parse_ethtool(root, name), 'profile': p.get('name', ''), 'profile_type': p.get('type', ''),
               'member_of': _member_of(name, d, membership, bridge_link), 'markers': [], 'ovs_type': membership.get(name, {}).get('type', '')}
        if name in bonds:
            row['kind'] = 'bond'
            row['bond'] = bname_summary(bonds[name])
        # the configured vs the running: MTU, the bridge membership, a bond port's controller
        if p:
            if p.get('mtu') and d['mtu'] and str(p['mtu']) != str(d['mtu']):
                row['markers'].append(f"profile MTU {p['mtu']}, running {d['mtu']}")
            if p.get('controller'):
                # the OVS bridge the interface is a port of (ovs-vsctl show) counts before the kernel's master, which
                # is ovs-system for every OVS port
                runtime_master = membership.get(name, {}).get('bridge', '') or ('' if d['master'] == 'ovs-system' else d['master'])
                wanted = expected_bridge(p)
                if runtime_master != wanted:
                    row['markers'].append(f"profile says port of {wanted}, running {('under ' + runtime_master) if runtime_master else 'standalone'}")
        rows.append(row)
    rows.sort(key=lambda r: (0 if r['kind'] == 'bond' else 1 if r['kind'] in ('bridge', 'openvswitch') else 2 if r['kind'] == 'vlan' else 3 if r['kind'] == 'loopback' else 2.5, r['name']))
    out['interfaces'] = rows

    # the bridges (OVS and Linux) with their members
    bridges = []
    for bname, b in ovs.items():
        members = []
        for port in b['ports']:
            for i in port['interfaces']:
                members.append({'name': i['name'], 'type': i['type'], 'port': port['name'], 'tag': port.get('tag', ''), 'bond': port.get('bond', False), 'uplink': i['type'] == 'system' and i['name'] != bname, 'address': addresses.get(i['name'], [])})
        bridges.append({'name': bname, 'kind': 'OVS', 'members': members, 'fail_mode': b.get('fail_mode', ''), 'addresses': addresses.get(bname, []), 'profile': by_iface.get(bname, {}).get('name', '')})
    for name, d in links.items():
        if d['kind'] == 'bridge':
            members = [{'name': n, 'type': 'linux', 'port': n, 'tag': '', 'bond': False, 'uplink': True, 'address': addresses.get(n, [])} for n, l in links.items() if l['master'] == name]
            for n, br in bridge_link.items():
                if br == name and not any(m['name'] == n for m in members):
                    members.append({'name': n, 'type': 'linux', 'port': n, 'tag': '', 'bond': False, 'uplink': True, 'address': addresses.get(n, [])})
            bridges.append({'name': name, 'kind': 'Linux', 'members': members, 'fail_mode': '', 'addresses': addresses.get(name, []), 'profile': by_iface.get(name, {}).get('name', '')})
    out['bridges'] = bridges
    out['sources'] = [s for s in ('sos_commands/networking/ip_-d_link' if link_raw else '', 'proc/net/bonding' if bonds else '', 'sos_commands/networkmanager' if nm['files'] else '', 'sos_commands/openvswitch' if ovs_raw else '') if s]
    out['findings'] = findings_for(out, links)
    return out


def bname_summary(b):
    return {'mode': b.get('mode', ''), 'primary': b.get('primary', ''), 'active': b.get('active', ''), 'slaves': [s['name'] for s in b.get('slaves', [])]}


def _member_of(name, d, membership, bridge_link):
    """'bond0 -> br-ex (OVS)'-style membership of an interface: the OVS bridge whose port it is, the Linux bridge it
    is a port of (ip -d link master / bridge link), the bond it is a slave of."""
    m = membership.get(name)
    if m:
        return {'name': m['bridge'], 'kind': 'OVS', 'via': m['port'] if m['port'] != name else '', 'type': m['type']}
    master = (d or {}).get('master') or bridge_link.get(name, '')
    if master:
        kind = 'bond' if (d or {}).get('slave_kind') == 'bond' else ('OVS' if (d or {}).get('slave_kind') == 'openvswitch' else 'bridge')
        return {'name': master, 'kind': kind, 'via': '', 'type': ''}
    return None


def findings_for(data, links):
    """Findings: a bond whose configured primary is not the active slave (warn), a configured bond port missing at
    runtime (bad), a slave down (the Interface Statistics page says it; here the role), a profile MTU differing
    from the running one (warn), a profile's bridge membership not seen at runtime (warn), masked secrets (info),
    and the absence of each capture (info)."""
    out = []
    bonds = data['bonds']
    for name, b in bonds.items():
        slaves = {s['name'] for s in b['slaves']}
        primary = b.get('configured_primary') or b.get('primary')
        if primary and b.get('active') and primary != b.get('active') and b['mode'].startswith('fault-tolerance'):
            out.append(finding('warn', f"{name}: the primary {primary} is not the active slave", f"{b['active']} carries the traffic now (a failover, or primary_reselect keeps it there)", tab='network', sub_tab='network_config', query=name))
        for port in b.get('configured_ports') or []:
            if port not in slaves:
                out.append(finding('bad', f"{name}: the configured port {port} is not a slave at runtime", f"profiles name {', '.join(b['configured_ports'])}; proc/net/bonding lists {', '.join(sorted(slaves)) or 'no slave'}", tab='network', sub_tab='network_config', query=name))
        if b.get('configured_primary') and b['configured_primary'] not in slaves:
            out.append(finding('bad', f"{name}: the configured primary {b['configured_primary']} is not a slave", f"slaves: {', '.join(sorted(slaves)) or 'none'}", tab='network', sub_tab='network_config', query=name))
    for row in data['interfaces']:
        for marker in row['markers']:
            out.append(finding('warn', f"{row['name']}: {marker}", f"profile {row['profile']}", tab='network', sub_tab='network_config', query=row['name']))
    masked = [p['name'] for p in data['profiles'] if p.get('secrets_masked')]
    if masked:
        out.append(finding('info', f"Secrets masked in {len(masked)} profile{'s' if len(masked) != 1 else ''}", f"{', '.join(masked[:5])}: the PSK / password values are never shown", count=len(masked)))
    if not links:
        out.append(no_data('No interface capture in this report', ['sos_commands/networking/ip_-d_link', 'ip_-s_-d_link']))
    if not bonds:
        out.append(no_data('No bonds in this report', ['proc/net/bonding']))
    if not data['profiles']:
        out.append(no_data('No NetworkManager profiles in this report', ['sos_commands/networkmanager/nmcli_con_show_*', 'etc/NetworkManager/system-connections', 'etc/sysconfig/network-scripts/ifcfg-*']))
    if not data['ovs']['present']:
        out.append(no_data('No Open vSwitch capture in this report', ['sos_commands/openvswitch/ovs-vsctl_-t_5_show'], 'no OVS bridges (br-ex) to show'))
    if not any(f['severity'] in ('bad', 'warn') for f in out) and (bonds or data['profiles']):
        out.append(finding('good', f"Configuration and runtime agree: {len(bonds)} bond{'s' if len(bonds) != 1 else ''}, {len(data['profiles'])} profile{'s' if len(data['profiles']) != 1 else ''}, {len(data['bridges'])} bridge{'s' if len(data['bridges']) != 1 else ''}"))
    return sort_findings(out)
