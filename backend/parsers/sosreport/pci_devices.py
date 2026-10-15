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

    def parse_lspci(path):
        devices = []
        device = None

        def start_new_device(header_line):
            match = re.match(r"^(\S+) (.+?) \[(\w+)\]: (.+?) \[(\w+):(\w+)\](?: \(rev (\w+)\))?", header_line)
            d = {
                "summary": header_line.strip(),
                "details": [],
            }
            if match:
                d.update({
                    "slot": match.group(1),
                    "type": match.group(2),
                    "class_id": match.group(3),
                    "description": match.group(4),
                    "vendor_id": match.group(5),
                    "device_id": match.group(6),
                    "revision": match.group(7) if match.group(7) else None,
                    "class": match.group(2),
                })
            return d

        lines = read_lines(path)
        for line in lines:
            line = line.rstrip()
            if not line.strip():
                continue

            if re.match(r"^\S+ .*?\[\w+\]: .*?\[\w+:\w+\](?: \(rev \w+\))?", line):
                if device:
                    devices.append(device)
                device = start_new_device(line)
                continue

            if device is None:
                continue

            device["details"].append(line)

        if device:
            devices.append(device)

        return devices


    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    lspci_paths = [
        os.path.join(directory, 'sos_commands', 'hardware', 'lspci_-vvv'),
        os.path.join(directory, 'lspci'),
    ]
    for path in lspci_paths:
        if os.path.isfile(path):
            lspci_path = path
            break
    else:
        return result

    result['lspci'] = parse_lspci(lspci_path)
    return result
