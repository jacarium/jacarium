import os
import re
import xml.etree.ElementTree as ET

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

    def parse_pmd_stats(stats_path, rxq_path):
        def read_lines(path):
            # Only hosts running Open vSwitch with DPDK have these captures;
            # a sosreport from any other host simply has no PMD threads.
            if not os.path.exists(path):
                return []
            with open(path) as f:
                return f.readlines()

        lines = read_lines(stats_path)
        threads = []
        current = {}
        header_re = re.compile(r'^pmd thread numa_id (\d+) core_id (\d+):$')
        kv_re = re.compile(r'^\s{2,}(.+?):\s+(.+)$')

        skip = False

        for line in lines:
            line = line.rstrip()

            if re.match(r"^\s*main thread", line, re.IGNORECASE):
                skip = True
                continue

            match = header_re.match(line)
            if match:
                skip = False
                if current and 'core_id' in current:
                    threads.append(current)
                current = {
                    'numa_id': int(match.group(1)),
                    'core_id': int(match.group(2)),
                    'ports': []
                }
                continue

            if skip:
                continue

            match = kv_re.match(line)
            if match:
                key = match.group(1).strip().lower().replace(' ', '_')
                val = match.group(2).strip()
                try:
                    if '%' in val:
                        val = val
                    elif '(' in val:
                        val = val.split('(')[0].strip()
                    if '.' in val:
                        val = float(val)
                    else:
                        val = int(val)
                except ValueError:
                    pass
                current[key] = val

        if current and 'core_id' in current:
            threads.append(current)

        rxq_lines = read_lines(rxq_path)
        rxq_data = {}
        current_key = None
        port_re = re.compile(
            r'^\s*port:\s+(\S+)\s+queue-id:\s+(\d+)\s+\((enabled|disabled)\)\s+pmd usage:\s+(\d+)\s*%$')
        overhead_re = re.compile(r"\s+overhead:\s+(\d+)\s+%")
        header_re = re.compile(r"pmd thread numa_id (\d+) core_id (\d+):")

        for line in rxq_lines:
            line = line.rstrip()

            match_port = port_re.match(line)
            if match_port:
                port_info = {
                    'port': match_port.group(1),
                    'queue_id': int(match_port.group(2)),
                    'enabled': match_port.group(3) == 'enabled',
                    'pmd_usage_percent': int(match_port.group(4))
                }
                if current_key:
                    rxq_data.setdefault(current_key, {}).setdefault('ports', []).append(port_info)
            else:
                match = header_re.match(line)
                if match:
                    numa, core = int(match.group(1)), int(match.group(2))
                    current_key = (numa, core)
                    rxq_data.setdefault(current_key, {})
                elif current_key:
                    match = overhead_re.match(line)
                    if match:
                        rxq_data[current_key]["pmd_overhead"] = int(match.group(1))

        for thread in threads:
            key = (thread['numa_id'], thread['core_id'])
            if key in rxq_data:
                if 'pmd_overhead' in rxq_data[key]:
                    thread['pmd_overhead'] = rxq_data[key]['pmd_overhead']
                if 'ports' in rxq_data[key]:
                    thread['ports'] = rxq_data[key]['ports']

        return threads

    def parse_cpu_ranges(cpu_str):
        cpus = []
        for part in cpu_str.split(','):
            part = part.strip()
            if '-' in part:
                start, end = map(int, part.split('-'))
                cpus.extend(range(start, end + 1))
            elif part.isdigit():
                cpus.append(int(part))
        return cpus

    def postprocess_cpuinfo(cpuinfo):
        new_cpuinfo = {}
        for key, val in cpuinfo.items():
            new_cpuinfo[key] = val
            if key.startswith("NUMA node") and "CPU(s)" in key:
                new_cpuinfo[key + " (parsed)"] = parse_cpu_ranges(val)
        return new_cpuinfo

    def parse_uptime(path):
        try:
            with open(path, 'r') as f:
                line = f.readline().strip()
            match = re.search(
                r"(\d{2}:\d{2}:\d{2})\s+up\s+(.*?),\s+(\d+)\s+user[s]?,\s+load average:\s+([\d.]+),\s+([\d.]+),\s+([\d.]+)",
                line
            )
            if match:
                current_time, uptime_str, users, load1, load5, load15 = match.groups()
                return {
                    "current_time": current_time,
                    "uptime": uptime_str,
                    "users": int(users),
                    "load_average": {
                        "1min": float(load1),
                        "5min": float(load5),
                        "15min": float(load15)
                    }
                }
        except Exception:
            pass
        return {}

    def parse_free(path):
        lines = read_lines(path)
        for line in lines:
            if line.startswith("Mem:"):
                fields = line.split()
                return {
                    "total": round(int(fields[1]) / 1024, 2),
                    "used": round(int(fields[2]) / 1024, 2),
                    "free": round(int(fields[3]) / 1024, 2),
                    "shared": round(int(fields[4]) / 1024, 2),
                    "buff_cache": round(int(fields[5]) / 1024, 2),
                    "available": round(int(fields[6]) / 1024, 2)
                }
        return {}

    def read_file(path):
        try:
            with open(path, 'r') as f:
                return f.read().strip()
        except Exception:
            return ""

    def expand_cpu_ranges(cpu_str):
        cpus = []
        for part in cpu_str.split(','):
            if '-' in part:
                start, end = map(int, part.split('-'))
                cpus.extend(range(start, end + 1))
            else:
                try:
                    cpus.append(int(part))
                except ValueError:
                    continue
        return sorted(set(cpus))

    def parse_cmdline(path):
        def expand_cpu_ranges(s):
            cpus = []
            for part in s.split(','):
                part = part.strip()
                if '-' in part:
                    start, end = map(int, part.split('-'))
                    cpus.extend(range(start, end + 1))
                else:
                    cpus.append(int(part))
            return sorted(set(cpus))

        def expand_bitmask_list(mask_str):
            masks = mask_str.split(',')[::-1]
            cpus = []
            for word_index, word in enumerate(masks):
                word = word.strip().lower()
                if word.startswith("0x"):
                    word = word[2:]
                bits = int(word, 16)
                for bit_index in range(32):
                    if bits & (1 << bit_index):
                        cpus.append(word_index * 32 + bit_index)
            return sorted(set(cpus))

        # Bitmask patterns: must have 0x prefix OR contain hex letters (a-f)
        # This prevents matching plain decimal CPU lists like "3,5,7,9"
        bitmask_with_prefix_regex = r'^0x[0-9a-fA-F]{1,8}(,0x[0-9a-fA-F]{1,8})*$'
        bitmask_with_hex_letters_regex = r'^[0-9a-fA-F]*[a-fA-F]+[0-9a-fA-F]*(,[0-9a-fA-F]*[a-fA-F]+[0-9a-fA-F]*)*$'
        cpu_range_regex = r'^\d+(-\d+)?(,\d+(-\d+)?)*$'
        single_digit_regex = r'^\d+$'

        with open(path) as f:
            content = f.read().strip()

        pairs = {}
        for item in content.split():
            if '=' in item:
                key, value = item.split('=', 1)
                if re.match(single_digit_regex, value):
                    pairs[key] = value
                # Check bitmask BEFORE cpu_range to handle hex properly
                elif re.match(bitmask_with_prefix_regex, value) or re.match(bitmask_with_hex_letters_regex, value):
                    pairs[key] = value
                    pairs[key + '.expanded'] = expand_bitmask_list(value)
                elif re.match(cpu_range_regex, value):
                    pairs[key] = value
                    pairs[key + '.expanded'] = expand_cpu_ranges(value)
                else:
                    pairs[key] = value
            else:
                pairs[item] = True
        return pairs


    def parse_ovs_config(path):
        content = read_file(path)
        match = re.findall(r'(\w[\w\-]*)=("[^"]*"|[^,}]+)', content)
        config = {}
        for key, value in match:
            value = value.strip('"')
            if key == "pmd-cpu-mask":
                config[key] = {
                    "hex": value,
                    "cpus": hex_to_cpu_list(value)
                }
            else:
                config[key] = value
        return config

    def hex_to_cpu_list(hex_mask):
        hex_mask = hex_mask.replace(",", "")
        binary = bin(int(hex_mask, 16))[2:][::-1]
        return [i for i, bit in enumerate(binary) if bit == '1']

    def parse_nova_conf(path):
        lines = read_lines(path)
        result = {}
        for line in lines:
            line = line.strip()
            if line.startswith('#'):
                continue
            if 'cpu_shared_set' in line:
                _, val = line.split('=', 1)
                result['cpu_shared_set'] = expand_cpu_ranges(val)
            if 'cpu_dedicated_set' in line:
                _, val = line.split('=', 1)
                result['cpu_dedicated_set'] = expand_cpu_ranges(val)
        return result

    def parse_instance_xmls(path_dir):
        instances = {}
        if not os.path.isdir(path_dir):
            return instances
        nova_ns = {'nova': 'http://openstack.org/xmlns/libvirt/nova/1.1'}

        for filename in os.listdir(path_dir):
            if re.match(r'instance-.*\.xml$', filename):
                full_path = os.path.join(path_dir, filename)
                try:
                    tree = ET.parse(full_path)
                    root = tree.getroot()

                    name_elem = root.find('name')
                    instance_name = name_elem.text if name_elem is not None else filename

                    vcpu_pins = {}
                    for elem in root.findall(".//vcpupin"):
                        vcpu = elem.attrib.get('vcpu')
                        cpuset = elem.attrib.get('cpuset')
                        if vcpu is not None and cpuset is not None:
                            vcpu_pins[int(vcpu)] = int(cpuset)

                    interfaces = []
                    for iface in root.findall(".//interface"):
                        target = iface.find('target')
                        iface_name = target.attrib.get('dev') if target is not None else None
                        mac = iface.find('mac')
                        driver = iface.find('driver')
                        nic_queues = driver.attrib.get('queues') if driver is not None else None
                        rx_queue_size = driver.attrib.get('rx_queue_size') if driver is not None else None
                        tx_queue_size = driver.attrib.get('tx_queue_size') if driver is not None else None
                        mac_addr = mac.attrib.get('address') if mac is not None else None
                        if iface_name or mac_addr or nic_queues or rx_queue_size or tx_queue_size:
                            interfaces.append({'name': iface_name, 'mac': mac_addr,
                                               'queues': nic_queues, 'rx_queue_size': rx_queue_size,
                                               'tx_queue_size': tx_queue_size})

                    disks = []
                    for disk in root.findall(".//disk"):
                        target = disk.find('target')
                        src = disk.find('source')
                        target_dev = target.attrib.get('dev') if target is not None else None
                        source_file = None
                        if src is not None:
                            source_file = src.attrib.get('file') or src.attrib.get('dev') or src.attrib.get('name')
                        if target_dev or source_file:
                            disks.append({'target': target_dev, 'source': source_file})

                    memory_elem = root.find('memory')
                    current_memory_elem = root.find('currentMemory')
                    memory = {
                        'total_kib': int(memory_elem.text) if memory_elem is not None else None,
                        'current_kib': int(current_memory_elem.text) if current_memory_elem is not None else None,
                        'hugepages': []
                    }

                    pages = root.findall(".//memoryBacking/hugepages/page")
                    for page in pages:
                        memory['hugepages'].append({
                            'size_kib': int(page.attrib.get('size', 0)),
                            'nodeset': page.attrib.get('nodeset'),
                            'unit': page.attrib.get('unit', 'KiB')
                        })

                    metadata_elem = root.find(".//metadata/nova:instance", namespaces=nova_ns)
                    metadata = {}
                    if metadata_elem is not None:
                        metadata['name'] = metadata_elem.findtext("nova:name", default=None, namespaces=nova_ns)
                        metadata['creation_time'] = metadata_elem.findtext("nova:creationTime", default=None, namespaces=nova_ns)

                        flavor_elem = metadata_elem.find("nova:flavor", namespaces=nova_ns)
                        if flavor_elem is not None:
                            metadata['flavor'] = {
                                'name': flavor_elem.attrib.get('name'),
                                'memory': flavor_elem.findtext('nova:memory', default=None, namespaces=nova_ns),
                                'disk': flavor_elem.findtext('nova:disk', default=None, namespaces=nova_ns),
                                'swap': flavor_elem.findtext('nova:swap', default=None, namespaces=nova_ns),
                                'ephemeral': flavor_elem.findtext('nova:ephemeral', default=None, namespaces=nova_ns),
                                'vcpus': flavor_elem.findtext('nova:vcpus', default=None, namespaces=nova_ns)
                            }

                        owner_elem = metadata_elem.find("nova:owner", namespaces=nova_ns)
                        if owner_elem is not None:
                            user_elem = owner_elem.find("nova:user", namespaces=nova_ns)
                            project_elem = owner_elem.find("nova:project", namespaces=nova_ns)
                            metadata['owner'] = {
                                'user': {
                                    'name': user_elem.text if user_elem is not None else None,
                                    'uuid': user_elem.attrib.get('uuid') if user_elem is not None else None
                                },
                                'project': {
                                    'name': project_elem.text if project_elem is not None else None,
                                    'uuid': project_elem.attrib.get('uuid') if project_elem is not None else None
                                }
                            }

                        root_elem = metadata_elem.find("nova:root", namespaces=nova_ns)
                        if root_elem is not None:
                            metadata['root'] = {
                                'type': root_elem.attrib.get('type'),
                                'uuid': root_elem.attrib.get('uuid')
                            }

                        metadata['ports'] = []
                        for port_elem in metadata_elem.findall(".//nova:port", namespaces=nova_ns):
                            port_uuid = port_elem.attrib.get('uuid')
                            ips = []
                            for ip_elem in port_elem.findall("nova:ip", namespaces=nova_ns):
                                ips.append({
                                    'type': ip_elem.attrib.get('type'),
                                    'address': ip_elem.attrib.get('address'),
                                    'version': ip_elem.attrib.get('ipVersion')
                                })
                            metadata['ports'].append({'uuid': port_uuid, 'ips': ips})

                    instances[filename] = {
                        'name': instance_name,
                        'vcpupins': vcpu_pins,
                        'interfaces': interfaces,
                        'disks': disks,
                        'memory': memory,
                        'metadata': metadata
                    }

                except Exception as e:
                    continue

        return instances



    def parse_cpu_topology(proc_cpuinfo_path):
        topology = {}
        current = {}
        siblings_map = {}

        lines = read_lines(proc_cpuinfo_path)
        for line in lines:
            if not line.strip():
                if 'processor' in current and 'core id' in current and 'physical id' in current:
                    cpu = int(current['processor'])
                    core_id = int(current['core id'])
                    socket_id = int(current['physical id'])
                    key = (socket_id, core_id)
                    siblings_map.setdefault(key, []).append(cpu)
                    topology[cpu] = {
                        "core_id": core_id,
                        "socket_id": socket_id
                    }
                current = {}
                continue
            if ':' in line:
                k, v = line.split(':', 1)
                current[k.strip()] = v.strip()

        for (socket_id, core_id), siblings in siblings_map.items():
            for cpu in siblings:
                topology[cpu]["siblings"] = sorted(siblings)

        return topology

    def parse_pmd_perf_show(pmd_perf_path):
        if not os.path.exists(pmd_perf_path):
            return []
        with open(pmd_perf_path, 'r') as f:
            data = f.read().strip()

        thread_blocks = re.findall(r'(pmd thread numa_id \d+ core_id \d+:.*?)(?=\n\npmd thread|\Z)', data, re.DOTALL)
        results = []

        for block in thread_blocks:
            result = {}
            numa_core = re.search(r'pmd thread numa_id (\d+) core_id (\d+):', block)
            if numa_core:
                result['numa_id'] = int(numa_core.group(1))
                result['core_id'] = int(numa_core.group(2))

            def extract_full(pattern):
                match = re.search(pattern, block)
                return match.group(1).strip() if match else ""

            result['iterations']       = extract_full(r'Iterations:\s+(.+?)\n')
            result['used_tsc_cycles']  = extract_full(r'Used TSC cycles:\s+(.+?)\n')
            result['idle_iterations']  = extract_full(r'idle iterations:\s+(.+?)\n')
            result['busy_iterations']  = extract_full(r'busy iterations:\s+(.+?)\n')
            result['rx_packets']       = extract_full(r'Rx packets:\s+(.+?)\n')
            result['tx_packets']       = extract_full(r'Tx packets:\s+(.+?)\n')
            result['tx_batches']       = extract_full(r'Tx batches:\s+(.+?)(?:\n|\Z)')
            result['emc_hits']         = extract_full(r'EMC hits:\s+(.+?)\n')
            result['megaflow_hits']    = extract_full(r'Megaflow hits:\s+(.+?)\n')
            result['upcalls']          = extract_full(r'Upcalls:\s+(.+?)\n')
            result['lost_upcalls']     = extract_full(r'Lost upcalls:\s+(.+?)\n')

            results.append(result)

        return results

    def parse_nova_physnet_numa(nova_conf_path):
        if not os.path.exists(nova_conf_path):
            return {}
        with open(nova_conf_path, 'r') as f:
            content = f.read()

        physnets_match = re.search(r'^\s*physnets\s*=\s*([^\n\r#]+)', content, re.MULTILINE)
        if not physnets_match:
            return {}

        physnet_list = [p.strip() for p in physnets_match.group(1).split(',') if p.strip()]
        results = {}

        for physnet in physnet_list:
            section_pattern = rf'\[neutron_physnet_{re.escape(physnet)}\](.*?)(?=\n\[|$)'
            section_match = re.search(section_pattern, content, re.DOTALL)

            if not section_match:
                results[physnet] = {}
                continue

            section_content = section_match.group(1)
            numa_match = re.search(r'^\s*numa_nodes\s*=\s*([^\n\r#]+)', section_content, re.MULTILINE)
            if numa_match:
                nodes_str = numa_match.group(1).strip()
                nodes_list = [int(n.strip()) for n in nodes_str.split(',') if n.strip()]
                results[physnet] = {
                    "numa_nodes": nodes_list
                }
            else:
                results[physnet] = {}


        return results

    def parse_ovs_interfaces(path):
        def parse_value(val):
            val = val.strip()
            if val.startswith('{') and val.endswith('}'):
                inner = val[1:-1].strip()
                if not inner:
                    return {}
                items = re.findall(r'(\w+)=("[^"]*"|[^,]+)', inner)
                return {k: v.strip('"') for k, v in items}
            elif val.startswith('[') and val.endswith(']'):
                inner = val[1:-1].strip()
                return [] if not inner else [i.strip('"') for i in inner.split(',')]
            elif val.startswith('"') and val.endswith('"'):
                return val.strip('"')
            elif val.lower() in ('true', 'false'):
                return val.lower() == 'true'
            elif val.isdigit():
                return int(val)
            else:
                try:
                    return float(val)
                except ValueError:
                    return val

        interfaces = []
        current = {}

        for line in read_lines(path):
            if not line.strip():
                if current:
                    interfaces.append(current)
                    current = {}
                continue
            if ':' in line:
                key, value = line.split(':', 1)
                current[key.strip()] = parse_value(value.strip())
        if current:
            interfaces.append(current)

        return interfaces


    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    result['cmdline'] = parse_cmdline(os.path.join(directory, 'proc', 'cmdline'))
    result['ovs_config'] = parse_ovs_config(os.path.join(directory, 'sos_commands', 'openvswitch', 'ovs-vsctl_-t_5_get_Open_vSwitch_._other_config'))
    result['nova_cpu_sets'] = parse_nova_conf(os.path.join(directory, 'var', 'lib', 'config-data', 'puppet-generated', 'nova_libvirt', 'etc', 'nova', 'nova.conf'))
    result['instances'] = parse_instance_xmls(os.path.join(directory, 'etc', 'libvirt', 'qemu'))
    result['cpu_topology'] = parse_cpu_topology(os.path.join(directory, 'proc', 'cpuinfo'))
    result['ovs_interfaces'] = parse_ovs_interfaces(
        os.path.join(directory, 'sos_commands', 'openvswitch', 'ovs-vsctl_-t_5_list_interface')
    )
    result['pmd_stats'] = parse_pmd_stats(
        os.path.join(directory, 'sos_commands', 'openvswitch', 'ovs-appctl_dpif-netdev.pmd-stats-show'),
        os.path.join(directory, 'sos_commands', 'openvswitch', 'ovs-appctl_dpif-netdev.pmd-rxq-show')
    )
    result['pmd_perf'] = parse_pmd_perf_show(os.path.join(directory, 'sos_commands', 'openvswitch', 'ovs-appctl_dpif-netdev.pmd-perf-show'))

    result['physnets'] = parse_nova_physnet_numa(
        os.path.join(directory, 'var', 'lib', 'config-data', 'puppet-generated', 'nova_libvirt', 'etc', 'nova', 'nova.conf')
    )
    result['hostnamectl'] = read_key_value_file(os.path.join(directory, 'sos_commands', 'host', 'hostnamectl_status'))
    result['uptime'] = parse_uptime(os.path.join(directory, 'uptime'))
    raw_cpuinfo = read_key_value_file(os.path.join(directory, 'sos_commands', 'processor', 'lscpu'))
    result['cpuinfo'] = postprocess_cpuinfo(raw_cpuinfo)
    result['free_memory'] = parse_free(os.path.join(directory, 'sos_commands', 'memory', 'free_-m'))

    return result
