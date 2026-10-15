import os
import re
import fnmatch


def parse(directory):
    result = {}

    def find_matching_file(directory, prefix):
        for fname in os.listdir(directory):
            if fnmatch.fnmatch(fname, f'{prefix}*'):
                return os.path.join(directory, fname)
        return None

    def parse_pvs_output(file_path):
        with open(file_path, 'r') as f:
            lines = [
                line.rstrip('\n')
                for line in f
                if "Reloading config files" not in line.strip() and "WARNING:" not in line
            ]

        if len(lines) < 2:
            return []

        header_line = lines[0]
        data_lines = lines[1:]

        expected_headers = [
            "PV", "VG", "Fmt", "Attr", "PSize", "PFree", "DevSize",
            "PV UUID", "PMdaFree", "PMdaSize", "#PMda", "#PMdaUse", "1st PE"
        ]

        header_positions = [m.start() for m in re.finditer(r'\S+', header_line)]
        header_positions.append(len(header_line) + 1)

        result = []

        for line in data_lines:
            values = []
            for i in range(len(header_positions) - 1):
                start = header_positions[i]
                end = header_positions[i + 1]
                values.append(line[start:end].strip())

            values += [''] * (len(expected_headers) - len(values))
            result.append(dict(zip(expected_headers, values)))

        return result

    def parse_vgs_output(file_path):
        with open(file_path, 'r') as f:
            lines = [
                line.rstrip('\n')
                for line in f
                if "Reloading config files" not in line.strip() and "WARNING:" not in line
            ]

        if any("No volume groups found" in line for line in lines):
            return []

        if len(lines) < 2:
            return []

        header_line = lines[0]
        data_lines = lines[1:]

        expected_headers = [
            "VG", "Attr", "Ext", "#PV", "#LV", "#SN", "VSize", "VFree",
            "VG UUID", "VProfile", "#VMda", "VMdaFree", "VMdaSize",
            "#VMdaUse", "VG Tags", "System ID"
        ]

        header_positions = [m.start() for m in re.finditer(r'\S+', header_line)]
        header_positions.append(len(header_line) + 1)

        result = []

        for line in data_lines:
            values = []
            for i in range(len(header_positions) - 1):
                start = header_positions[i]
                end = header_positions[i + 1]
                values.append(line[start:end].strip())

            values += [''] * (len(expected_headers) - len(values))
            parsed = dict(zip(expected_headers, values))
            result.append(parsed)

        return result

    def parse_lvs_output(file_path):
        with open(file_path, 'r') as f:
            lines = [
                line.rstrip('\n')
                for line in f
                if "Reloading config files" not in line.strip() and "WARNING:" not in line
            ]

        if len(lines) < 2:
            return []

        header_line = lines[0]
        data_lines = lines[1:]

        expected_headers = [
            "LV", "VG", "Attr", "LSize", "Pool", "Origin", "Data%", "Meta%",
            "Move Log", "Cpy%Sync", "Convert", "LV Tags", "Devices",
            "KRahead", "Rahead", "#Str", "Stripe"
        ]

        header_positions = [m.start() for m in re.finditer(r'\S+', header_line)]
        header_positions.append(len(header_line) + 1)

        result = []

        for line in data_lines:
            values = []
            for i in range(len(header_positions) - 1):
                start = header_positions[i]
                end = header_positions[i + 1]
                values.append(line[start:end].strip())

            values += [''] * (len(expected_headers) - len(values))
            entry = dict(zip(expected_headers, values))
            result.append(entry)

        return result


    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    lvm_path = os.path.join(directory, 'sos_commands', 'lvm2')

    vgs_file = find_matching_file(lvm_path, 'vgs_')
    pvs_file = find_matching_file(lvm_path, 'pvs_')
    lvs_file = find_matching_file(lvm_path, 'lvs_')
    result['lvm'] = {}
    result['lvm']['vgs'] = parse_vgs_output(vgs_file) if vgs_file else []
    result['lvm']['pvs'] = parse_pvs_output(pvs_file) if pvs_file else []
    result['lvm']['lvs'] = parse_lvs_output(lvs_file) if lvs_file else []

    return result