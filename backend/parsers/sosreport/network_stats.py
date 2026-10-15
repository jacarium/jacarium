import re

def parse(directory):
    result = {}
    try:
        with open(f"{directory}/sos_commands/networking/ip_-s_-d_link", "r") as f:
            raw = f.read()

        interfaces = {}
        blocks = re.split(r'\n(?=\d+:)', raw)

        for block in blocks:
            lines = block.strip().splitlines()
            if not lines:
                continue

            match = re.match(r'\d+: (\S+):', lines[0])
            if not match:
                continue

            iface = match.group(1)
            stats = {'RX': {}, 'TX': {}, 'VFs': {}, 'MTU': None, 'State': None}

            i = 0
            while i < len(lines):
                line = lines[i].strip()

                if 'mtu' in line and 'minmtu' not in line and 'maxmtu' not in line:
                    mtu_match = re.search(r'mtu (\d+)', line)
                    if mtu_match:
                        stats['MTU'] = int(mtu_match.group(1))

                if 'state' in line and 'link-state' not in line:
                    state_match = re.search(r'state (\S+)', line)
                    if state_match:
                        stats['State'] = state_match.group(1).upper()

                if line.startswith("RX:"):
                    headers = re.findall(r'\S+', line[3:].strip())
                    i += 1
                    values = re.findall(r'\S+', lines[i].strip())
                    if len(headers) == len(values):
                        stats['RX'] = dict(zip(headers, map(int, values)))

                elif line.startswith("TX:"):
                    headers = re.findall(r'\S+', line[3:].strip())
                    i += 1
                    values = re.findall(r'\S+', lines[i].strip())
                    if len(headers) == len(values):
                        stats['TX'] = dict(zip(headers, map(int, values)))

                elif line.startswith("vf "):
                    vf_match = re.match(r"vf (\d+)", line)
                    if vf_match:
                        vf_id = vf_match.group(1)
                        vf_name = f"vf {vf_id}"
                        stats['VFs'][vf_name] = {'RX': {}, 'TX': {}}

                        j = i + 1
                        while j < len(lines):
                            next_line = lines[j].strip()
                            if next_line.startswith("RX:"):
                                headers = re.findall(r'\S+', next_line[3:].strip())
                                j += 1
                                values = re.findall(r'\S+', lines[j].strip())
                                if len(headers) == len(values):
                                    stats['VFs'][vf_name]['RX'] = dict(zip(headers, map(int, values)))
                            elif next_line.startswith("TX:"):
                                headers = re.findall(r'\S+', next_line[3:].strip())
                                j += 1
                                values = re.findall(r'\S+', lines[j].strip())
                                if len(headers) == len(values):
                                    stats['VFs'][vf_name]['TX'] = dict(zip(headers, map(int, values)))
                            elif next_line.startswith("vf ") or re.match(r'\d+: \S+:', next_line):
                                break
                            j += 1
                        i = j - 1
                i += 1

            interfaces[iface] = stats

        result['ip_info'] = interfaces
        return result

    except FileNotFoundError:
        result['ip_info'] = {}
        return result
