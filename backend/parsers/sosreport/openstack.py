import os
import re

def parse(directory):
    result = {}

    def read_lines(path):
        try:
            with open(path, 'r') as f:
                return f.readlines()
        except Exception:
            return []

    def read_key_value_file(path):
        data = {}
        lines = read_lines(path)
        for line in lines:
            if ':' in line:
                key, value = line.split(':', 1)
                data[key.strip()] = value.strip()
        return data

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    def parse_release_info(path):
        release_info = {}
        try:
            with open(path, 'r') as f:
                content = f.read().strip()
                if content:
                    match = re.match(r'Red Hat OpenStack Platform release (\d+\.\d+\.\d+) \((\w+)\)', content)
                    if match:
                        release_info['version'] = match.group(1)
                        release_info['codename'] = match.group(2)
                        return release_info
        except Exception:
            return {}





    result['hostnamectl'] = read_key_value_file(os.path.join(directory, 'sos_commands', 'host', 'hostnamectl_status'))
    result['rhosp_release'] = parse_release_info(os.path.join(directory, 'etc', 'rhosp-release'))
    # the Findings: the three sub-tabs' strips, each named and linked
    from parsers.findings import finding, sort_findings
    from parsers.sosreport import haproxy, openstack_dpdk, pacemaker
    out = []
    for sub, mod in (('openstack_dpdk', openstack_dpdk), ('haproxy', haproxy), ('pacemaker', pacemaker)):
        try:
            items = (mod.parse(directory) or {}).get('findings', [])
        except Exception as e:  # noqa: BLE001
            items = [finding('warn', f"{sub} could not be read", str(e)[:200])]
        for f in items:
            f = dict(f)
            if not f.get('link'):
                f['link'] = {'tab': 'openstack', 'sub_tab': sub, 'query': ''}
            f['title'] = f"{sub}: {f['title']}"
            out.append(f)
    result['findings'] = sort_findings(out)
    return result
