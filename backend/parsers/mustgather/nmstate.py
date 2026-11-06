"""Network > Node Network Config (NNCP): the kubernetes-nmstate objects of a
must-gather - what the policies ask for, what each node did with them and
what each node's network actually looks like.

  NodeNetworkConfigurationPolicy (NNCP)    per policy: the nodeSelector, the desired interfaces (type, state,
                                           bond mode / options / ports, VLAN id and base interface, bridge ports
                                           for linux-bridge / ovs-bridge, MTU, ipv4 / ipv6 dhcp or addresses),
                                           routes, DNS, the status conditions (Available / Degraded / Progressing
                                           with reason and message), the enactment counts
  NodeNetworkConfigurationEnactment (NNCE) per node and policy: the status (Available / Failing / Progressing /
                                           Pending / Aborted) with the message of a failure
  NodeNetworkState (NNS)                   per node: the current interfaces (type, state, MTU, bond mode and ports
                                           with the active one, bridge ports, addresses, link), routes, DNS -
                                           and, against every policy that selects the node, the desired-vs-actual
                                           comparison: an interface missing, another type or state, another
                                           bond mode, ports or bridge ports missing or extra, another MTU, a
                                           static address missing - each a mismatch on the node's row and a
                                           Finding

The objects are read from cluster-scoped-resources/nmstate.io/<kind>/ and, when a gather put them there, from
namespaces/openshift-nmstate/nmstate.io/<kind>/ (either a List or one object per file). Nothing of nmstate in the
gather: the page says so (no_data), never an empty table.
"""
import glob
import os
import re

from parsers.findings import finding, no_data, recall, remember, sort_findings
from parsers.mustgather._common import collection_time, list_items, resolve_data_dir, safe_load_all, unreadable, unreadable_finding

KINDS = {
    'NodeNetworkConfigurationPolicy': 'nodenetworkconfigurationpolicies',
    'NodeNetworkConfigurationEnactment': 'nodenetworkconfigurationenactments',
    'NodeNetworkState': 'nodenetworkstates',
}
LOOKED = ['cluster-scoped-resources/nmstate.io/', 'namespaces/openshift-nmstate/nmstate.io/']


# The ports ovn-controller creates at runtime on an OVS bridge and nmstate never owns: the patch ports to br-int
# (one per localnet VLAN / bridge mapping, "patch-<bridge>_<node>-to-br-int", "patch-br-int-to-...",
# "...ovn_localnet_port..."). They are never in an NNCP's desired state, so they are no mismatch; the node panel
# lists them apart. The same for the interfaces OVN-Kubernetes / OVS own on every node (br-int, the Geneve tunnel
# interface, the management port, the datapath), should a desired state ever name them.
OVN_PORT_RE = re.compile(r'^patch-.*-to-br-int$|^patch-br-int-to-|_ovn_localnet_port|^ovn-k8s-mp\d+$|^genev_sys_\d+$|^br-int$|^ovs-system$')


def is_ovn_managed(name, iface=None):
    """Is this OVS port / interface one ovn-controller or OVS manages (by its name, or by being a patch port)?"""
    if iface and (iface.get('patch') or iface.get('type') == 'patch'):
        return True
    return bool(OVN_PORT_RE.search(name or ''))


def _load_kind(directory, kind, broken):
    """Every object of `kind` from the two places a gather puts nmstate objects (List files or one per file)."""
    items = []
    for base in ('cluster-scoped-resources', os.path.join('namespaces', 'openshift-nmstate')):
        for path in sorted(glob.glob(os.path.join(directory, base, 'nmstate.io', KINDS[kind], '*.yaml'))):
            try:
                with open(path, 'r') as fh:
                    for doc in safe_load_all(fh):
                        items.extend(list_items(doc, kind))
            except Exception as e:   # noqa: BLE001 - a broken file: a readable reason
                broken.append(unreadable(path, e, directory))
    return items


def _cond(obj, ctype):
    for c in ((obj.get('status') or {}).get('conditions') or []):
        if c.get('type') == ctype:
            return {'status': c.get('status', ''), 'reason': c.get('reason', '') or '', 'message': c.get('message', '') or '', 'since': c.get('lastTransitionTime', '') or ''}
    return {'status': '', 'reason': '', 'message': '', 'since': ''}


def _ip(section):
    s = section or {}
    addrs = []
    for a in s.get('address') or []:
        if isinstance(a, dict) and a.get('ip'):
            addrs.append(f"{a['ip']}/{a.get('prefix-length', '')}".rstrip('/'))
    return {'enabled': bool(s.get('enabled', False)), 'dhcp': bool(s.get('dhcp', False)), 'autoconf': bool(s.get('autoconf', False)), 'addresses': addrs}


def normalize_interface(i):
    """One nmstate interface (desired or current) in the shape the page and the comparison use."""
    i = i or {}
    itype = i.get('type', '') or ''
    la = i.get('link-aggregation') or {}
    bridge = i.get('bridge') or {}
    ports = []
    if la:
        ports = list(la.get('port') or la.get('slaves') or [])
    bridge_ports = []
    for p in bridge.get('port') or bridge.get('ports') or []:
        if isinstance(p, dict) and p.get('name'):
            bridge_ports.append(p['name'])
        elif isinstance(p, str):
            bridge_ports.append(p)
    vlan = i.get('vlan') or {}
    out = {
        'name': i.get('name', ''), 'type': itype, 'state': i.get('state', '') or '', 'mtu': i.get('mtu'), 'mac': i.get('mac-address', '') or '',
        'description': i.get('description', '') or '',
        'bond': {'mode': la.get('mode', '') or '', 'options': {k: str(v) for k, v in (la.get('options') or {}).items()}, 'ports': [str(p) for p in ports]} if la or itype == 'bond' else {},
        'vlan': {'id': vlan.get('id'), 'base': vlan.get('base-iface', '') or ''} if vlan or itype == 'vlan' else {},
        'bridge': {'ports': bridge_ports, 'options': bridge.get('options') or {}} if bridge or itype in ('linux-bridge', 'ovs-bridge') else {},
        'ipv4': _ip(i.get('ipv4')), 'ipv6': _ip(i.get('ipv6')),
        'controller': i.get('controller', '') or '',
        'lldp': bool((i.get('lldp') or {}).get('enabled', False)),
        'patch': ((i.get('patch') or {}).get('peer', '') or '') if isinstance(i.get('patch'), dict) else '',
    }
    # ovs-interface: the bridge it belongs to, from its controller or from an ovs-bridge's port list later
    return out


def _routes(section):
    out = []
    for r in ((section or {}).get('config') or []) + ((section or {}).get('running') or []):
        if isinstance(r, dict):
            out.append({'destination': r.get('destination', ''), 'next_hop': r.get('next-hop-address', '') or '', 'iface': r.get('next-hop-interface', '') or '', 'metric': r.get('metric', ''), 'table': r.get('table-id', '')})
    # the same route in config and running once
    seen, uniq = set(), []
    for r in out:
        key = (r['destination'], r['next_hop'], r['iface'])
        if key not in seen:
            seen.add(key)
            uniq.append(r)
    return uniq


def _dns(section):
    s = section or {}
    cfg = s.get('config') or s.get('running') or {}
    return {'servers': list(cfg.get('server') or []), 'search': list(cfg.get('search') or [])}


def parse_policy(obj):
    meta = obj.get('metadata') or {}
    spec = obj.get('spec') or {}
    desired = spec.get('desiredState') or {}
    interfaces = [normalize_interface(i) for i in (desired.get('interfaces') or [])]
    _attach_bridge_membership(interfaces)
    status = obj.get('status') or {}
    return {
        'name': meta.get('name', ''), 'selector': dict(spec.get('nodeSelector') or {}), 'capture': bool(spec.get('capture')),
        'interfaces': interfaces, 'routes': _routes(desired.get('routes')), 'dns': _dns(desired.get('dns-resolver')),
        'available': _cond(obj, 'Available'), 'degraded': _cond(obj, 'Degraded'), 'progressing': _cond(obj, 'Progressing'),
        'last_unavailable_node_count': status.get('lastUnavailableNodeCountUpdate', ''),
        'enactments': [], 'mismatched_nodes': [],
    }


def _attach_bridge_membership(interfaces):
    """Every interface named in a bridge's port list learns its bridge (member_of), so the table can say
    'bond0 -> br-ex (ovs-bridge)'; an ovs-interface with a controller too."""
    bridges = [i for i in interfaces if i.get('bridge')]
    for i in interfaces:
        i['member_of'] = ''
        for b in bridges:
            # (an OVS bridge's internal interface carries the bridge's name: the same name, another object)
            if i is not b and i['name'] in (b['bridge'].get('ports') or []):
                i['member_of'] = f"{b['name']} ({b['type']})"
        if not i['member_of'] and i.get('controller'):
            i['member_of'] = i['controller']
    for i in interfaces:
        for other in interfaces:
            if other.get('bond') and i['name'] in (other['bond'].get('ports') or []) and not i['member_of']:
                i['member_of'] = f"{other['name']} (bond)"


def parse_enactment(obj):
    meta = obj.get('metadata') or {}
    labels = meta.get('labels') or {}
    name = meta.get('name', '')
    node = labels.get('nmstate.io/node') or (obj.get('spec') or {}).get('nodeName') or name.split('.', 1)[0]
    policy = labels.get('nmstate.io/policy') or (name.split('.', 1)[1] if '.' in name else '')
    status = obj.get('status') or {}
    conds = {t: _cond(obj, t) for t in ('Available', 'Failing', 'Progressing', 'Pending', 'Aborted', 'Matching')}
    if conds['Failing']['status'] == 'True':
        state, kind = 'Failing', 'bad'
    elif conds['Aborted']['status'] == 'True':
        state, kind = 'Aborted', 'bad'
    elif conds['Progressing']['status'] == 'True':
        state, kind = 'Progressing', 'warn'
    elif conds['Pending']['status'] == 'True':
        state, kind = 'Pending', 'warn'
    elif conds['Available']['status'] == 'True':
        state, kind = 'Available', 'good'
    elif conds['Matching']['status'] == 'False':
        state, kind = 'Not matching', 'muted'
    else:
        state, kind = 'Unknown', 'muted'
    detail = next((c for t, c in conds.items() if c['status'] == 'True' and t in ('Failing', 'Aborted', 'Progressing', 'Pending')), conds['Available'])
    return {'name': name, 'node': node, 'policy': policy, 'state': state, 'kind': kind, 'reason': detail.get('reason', ''), 'message': detail.get('message', ''),
            'since': detail.get('since', ''), 'desired': [normalize_interface(i) for i in ((status.get('desiredState') or {}).get('interfaces') or [])],
            'policy_generation': status.get('policyGeneration', '')}


def parse_node_state(obj):
    meta = obj.get('metadata') or {}
    status = obj.get('status') or {}
    current = status.get('currentState') or {}
    interfaces = [normalize_interface(i) for i in (current.get('interfaces') or [])]
    _attach_bridge_membership(interfaces)
    # the active port of a bond and the link state come from the current state's extras when present
    for i in interfaces:
        raw = next((r for r in (current.get('interfaces') or []) if r.get('name') == i['name']), {}) or {}
        la = raw.get('link-aggregation') or {}
        i['bond_active'] = la.get('active-port', '') or (la.get('options') or {}).get('active_slave', '') or ''
        i['link'] = 'up' if (raw.get('state') == 'up' and raw.get('mtu')) else raw.get('state', '')
        ovn = raw.get('ovs-db') or {}
        i['ovs_external_ids'] = ovn.get('external_ids') or {}
    ovn = current.get('ovn') or {}
    mappings = ovn.get('bridge-mappings') or []
    return {'node': meta.get('name', ''), 'interfaces': interfaces, 'routes': _routes(current.get('routes')), 'dns': _dns(current.get('dns-resolver')),
            'bridge_mappings': [{'localnet': m.get('localnet', ''), 'bridge': m.get('bridge', '')} for m in mappings if isinstance(m, dict)],
            'bridge_mappings_text': ', '.join(f"{m.get('localnet', '')} -> {m.get('bridge', '')}" for m in mappings if isinstance(m, dict)),
            'last_successful_update': status.get('lastSuccessfulUpdateTime', ''), 'host_name': (status.get('hostNetworkManagerVersion') or ''), 'mismatches': []}


def actual_index(interfaces):
    """The current interfaces by (name, type) and by name - an OVS bridge and its internal interface share a name."""
    out = {}
    for i in interfaces:
        out.setdefault((i['name'], i['type']), i)
        out.setdefault(i['name'], i)
    return out


def _lookup(actual, desired):
    typed = actual.get((desired['name'], desired.get('type', '')))
    if typed is not None:
        return typed
    # no interface of that type: the one by name, unless the name exists only under other types (then it is missing)
    if any(isinstance(k, tuple) and k[0] == desired['name'] for k in actual):
        return None
    return actual.get(desired['name'])


def _row(iface, setting, kind, desired, actual, text):
    return {'iface': iface, 'setting': setting, 'kind': kind, 'desired': desired, 'actual': actual, 'text': text}


def _ovn_port(name, actual_by_name):
    return is_ovn_managed(name, actual_by_name.get(name) if isinstance(actual_by_name, dict) else None)


def compare(desired, actual_by_name):
    """The mismatches of one desired interface against the node's current state: rows {iface, setting, kind, desired,
    actual, text}. kind: 'differs' (both values), 'missing' (desired, not on the node) or 'unexpected' (on the node,
    not desired). Only what the policy asks for is compared: an interface, address or route the node has beyond the
    desired state is not a mismatch, and the OVS ports ovn-controller manages (is_ovn_managed) are not counted
    among a bridge's extra ports."""
    out = []
    name = desired['name']
    a = _lookup(actual_by_name, desired)
    if desired.get('state') == 'absent':
        if a:
            out.append(_row(name, 'interface', 'unexpected', 'absent', a.get('type') or 'present', f"{name} should be absent but exists"))
        return out
    if not a:
        out.append(_row(name, 'interface', 'missing', desired.get('type') or 'present', '', f"{name} ({desired['type']}) is missing"))
        return out
    if desired.get('type') and a.get('type') and desired['type'] != a['type']:
        out.append(_row(name, 'type', 'differs', desired['type'], a['type'], f"{name}: type {desired['type']} desired, {a['type']} actual"))
    if desired.get('state') and a.get('state') and desired['state'] != a['state']:
        out.append(_row(name, 'state', 'differs', desired['state'], a['state'], f"{name}: state {desired['state']} desired, {a['state']} actual"))
    if desired.get('mtu') and a.get('mtu') and int(desired['mtu']) != int(a['mtu']):
        out.append(_row(name, 'MTU', 'differs', str(desired['mtu']), str(a['mtu']), f"{name}: MTU {desired['mtu']} desired, {a['mtu']} actual"))
    if desired.get('bond'):
        db, ab = desired['bond'], a.get('bond') or {}
        if db.get('mode') and ab.get('mode') and db['mode'] != ab['mode']:
            out.append(_row(name, 'bond mode', 'differs', db['mode'], ab['mode'], f"{name}: bond mode {db['mode']} desired, {ab['mode']} actual"))
        dp, ap = set(db.get('ports') or []), set(ab.get('ports') or [])
        if dp:
            for port in sorted(dp - ap):
                out.append(_row(name, 'bond port', 'missing', port, '', f"{name}: bond ports missing {port}"))
            for port in sorted(ap - dp):
                out.append(_row(name, 'bond port', 'unexpected', '', port, f"{name}: bond ports extra {port}"))
        for k in ('primary', 'miimon'):
            if db.get('options', {}).get(k) and ab.get('options', {}).get(k) and db['options'][k] != ab['options'][k]:
                out.append(_row(name, f'bond {k}', 'differs', db['options'][k], ab['options'][k], f"{name}: bond {k} {db['options'][k]} desired, {ab['options'][k]} actual"))
    if desired.get('bridge'):
        dp, ap = set(desired['bridge'].get('ports') or []), set((a.get('bridge') or {}).get('ports') or [])
        if dp:
            for port in sorted(dp - ap):
                out.append(_row(name, 'bridge port', 'missing', port, '', f"{name}: bridge ports missing {port}"))
            for port in sorted(ap - dp):
                if _ovn_port(port, actual_by_name):
                    continue
                out.append(_row(name, 'bridge port', 'unexpected', '', port, f"{name}: bridge ports extra {port}"))
    if desired.get('vlan') and desired['vlan'].get('id') is not None and a.get('vlan') and a['vlan'].get('id') is not None and int(desired['vlan']['id']) != int(a['vlan']['id']):
        out.append(_row(name, 'VLAN id', 'differs', str(desired['vlan']['id']), str(a['vlan']['id']), f"{name}: VLAN id {desired['vlan']['id']} desired, {a['vlan']['id']} actual"))
    for fam in ('ipv4', 'ipv6'):
        d, ac = desired.get(fam) or {}, a.get(fam) or {}
        if d.get('enabled') and not d.get('dhcp') and d.get('addresses'):
            missing = [x for x in d['addresses'] if x not in (ac.get('addresses') or [])]
            if missing:
                out.append(_row(name, f'{fam} address', 'differs', ', '.join(missing), ', '.join(ac.get('addresses') or []) or 'none',
                                f"{name}: {fam} address {', '.join(missing)} desired, actual {', '.join(ac.get('addresses') or []) or 'none'}"))
        if d.get('enabled') and d.get('dhcp') and ac.get('enabled') and not ac.get('dhcp') and not ac.get('addresses'):
            out.append(_row(name, f'{fam} DHCP', 'differs', 'dhcp', 'no address', f"{name}: {fam} DHCP desired, no address actual"))
    return out


def ovn_ports(interfaces):
    """The OVN-managed ports on the node's OVS bridges: [{bridge, port, peer}], for the node panel's information."""
    by_name = {i['name']: i for i in interfaces}
    out = []
    for b in interfaces:
        if b.get('type') != 'ovs-bridge':
            continue
        for port in (b.get('bridge') or {}).get('ports') or []:
            if port != b['name'] and is_ovn_managed(port, by_name.get(port)):
                out.append({'bridge': b['name'], 'port': port, 'peer': (by_name.get(port) or {}).get('patch', '')})
    return out


def _selects(selector, node_labels):
    return all(node_labels.get(k) == v for k, v in (selector or {}).items())


def _node_labels(directory):
    """{node: labels} from cluster-scoped-resources/core/nodes, for the policies' nodeSelector."""
    out = {}
    for path in glob.glob(os.path.join(directory, 'cluster-scoped-resources', 'core', 'nodes', '*.yaml')):
        try:
            with open(path, 'r') as fh:
                for doc in safe_load_all(fh):
                    for n in list_items(doc, 'Node'):
                        meta = n.get('metadata') or {}
                        if meta.get('name'):
                            out[meta['name']] = meta.get('labels') or {}
        except Exception:   # noqa: BLE001
            continue
    return out


def parse(directory):
    gather_time = collection_time(directory)
    directory = resolve_data_dir(directory)
    broken = []
    policies = [parse_policy(o) for o in _load_kind(directory, 'NodeNetworkConfigurationPolicy', broken)]
    enactments = [parse_enactment(o) for o in _load_kind(directory, 'NodeNetworkConfigurationEnactment', broken)]
    states = [parse_node_state(o) for o in _load_kind(directory, 'NodeNetworkState', broken)]
    labels = _node_labels(directory)
    by_policy = {p['name']: p for p in policies}
    for p in policies:
        p['mismatch_counts'] = {}
    for e in enactments:
        if e['policy'] in by_policy:
            by_policy[e['policy']]['enactments'].append(e)
    # desired vs actual per node, for every policy that selects the node (or every policy when the labels are
    # unknown but an enactment names the node)
    for s in states:
        actual = actual_index(s['interfaces'])
        for p in policies:
            selected = _selects(p['selector'], labels.get(s['node'], {})) if s['node'] in labels else any(e['node'] == s['node'] for e in p['enactments'])
            if not selected:
                continue
            rows = []
            for d in p['interfaces']:
                rows.extend(compare(d, actual))
            if rows:
                s['mismatches'].append({'policy': p['name'], 'rows': rows, 'lines': [r['text'] for r in rows]})
                p['mismatched_nodes'].append(s['node'])
                p['mismatch_counts'][s['node']] = len(rows)
        s['ovn_ports'] = ovn_ports(s['interfaces'])
    policies.sort(key=lambda p: (0 if p['degraded']['status'] == 'True' else 1 if p['progressing']['status'] == 'True' else 2, p['name']))
    enactments.sort(key=lambda e: (0 if e['kind'] == 'bad' else 1 if e['kind'] == 'warn' else 2, e['node'], e['policy']))
    states.sort(key=lambda s: (0 if s['mismatches'] else 1, s['node']))
    result = {'policies': policies, 'enactments': enactments, 'nodes': states, 'broken': broken, 'gather_time': gather_time,
              'present': bool(policies or enactments or states)}
    result['findings'] = findings_for(result)
    remember(('nmstate', directory), result['findings'])
    return result


def findings(directory):
    return recall(('nmstate', resolve_data_dir(directory)), lambda: parse(directory)['findings'])


def findings_for(result):
    out = []
    if not result['present']:
        out.append(no_data('No nmstate data in this must-gather', LOOKED, 'no NodeNetworkConfigurationPolicy, Enactment or NodeNetworkState was collected'))
        bf = unreadable_finding(result['broken'], 'nmstate')
        if bf:
            out.append(bf)
        return sort_findings(out)
    for p in result['policies']:
        if p['degraded']['status'] == 'True':
            out.append(finding('bad', f"Policy {p['name']} is Degraded", f"{p['degraded']['reason']}: {p['degraded']['message']}".strip(': '), tab='network', sub_tab='nmstate', query=p['name']))
        elif p['progressing']['status'] == 'True':
            out.append(finding('warn', f"Policy {p['name']} is Progressing", p['progressing']['message'] or p['progressing']['reason'], tab='network', sub_tab='nmstate', query=p['name']))
        elif p['available']['status'] != 'True':
            out.append(finding('warn', f"Policy {p['name']} is not Available", p['available']['message'] or p['available']['reason'] or 'no Available condition', tab='network', sub_tab='nmstate', query=p['name']))
    for e in result['enactments']:
        if e['kind'] == 'bad':
            out.append(finding('bad', f"{e['node']}: enactment of {e['policy']} is {e['state']}", (e['message'] or e['reason'])[:300], tab='network', sub_tab='nmstate', query=e['node']))
        elif e['kind'] == 'warn':
            out.append(finding('warn', f"{e['node']}: enactment of {e['policy']} is {e['state']}", (e['message'] or e['reason'])[:300], tab='network', sub_tab='nmstate', query=e['node']))
    for s in result['nodes']:
        for m in s['mismatches']:
            out.append(finding('warn', f"{s['node']}: the actual state differs from policy {m['policy']}", '; '.join(m['lines'])[:300], count=len(m['lines']), tab='network', sub_tab='nmstate', query=s['node']))
    bf = unreadable_finding(result['broken'], 'nmstate')
    if bf:
        out.append(bf)
    if not result['nodes']:
        out.append(no_data('No NodeNetworkState in this must-gather: desired vs actual cannot be compared', ['nmstate.io/nodenetworkstates']))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{len(result['policies'])} polic{'y' if len(result['policies']) == 1 else 'ies'} Available on {len(result['nodes'])} node{'s' if len(result['nodes']) != 1 else ''}, the actual state matches"))
    return sort_findings(out)
