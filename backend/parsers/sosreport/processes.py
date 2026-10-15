import os

def parse_ps_file(ps_path, variant="ps_auxwwwm"):
    processes = []

    standard_headers = [
        "USER", "LABEL", "PID", "PPID", "%CPU", "%MEM", "VSZ", "RSS", "TTY",
        "STAT", "START", "TIME", "COMMAND"
    ]

    try:
        with open(ps_path, "r") as f:
            lines = f.readlines()

        if not lines:
            return {"headers": standard_headers, "processes": []}

        header_line = lines[0].strip()
        raw_headers = header_line.split()

        header_map = {h: i for i, h in enumerate(raw_headers)}
        expected_fields = len(raw_headers)

        for required in ["PID", "%CPU", "COMMAND"]:
            if required not in header_map:
                return {"error": f"Missing expected header: {required}", "headers": standard_headers, "processes": []}

        pid_index = header_map["PID"]
        cpu_index = header_map["%CPU"]
        command_index = header_map["COMMAND"]

        raw_headers.insert(pid_index + 1, "PPID")

        last_pid = None
        last_cmd = None

        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue

            parts = line.split(None, expected_fields - 1)
            if len(parts) < expected_fields:
                parts += ['-'] * (expected_fields - len(parts))

            pid = parts[pid_index]
            cmd = parts[command_index]

            is_thread = pid == '-'

            if not is_thread:
                last_pid = pid
                if cmd != '-':
                    last_cmd = cmd

            ppid = last_pid if is_thread else '-'
            parts.insert(pid_index + 1, ppid)

            if is_thread and (cmd == '-' or not cmd.strip()):
                parts[-1] = last_cmd or '-'

            full_data = dict(zip(raw_headers, parts))
            normalized = {h: full_data.get(h, '-') for h in standard_headers}

            processes.append(normalized)

        return {
            "headers": standard_headers,
            "processes": processes
        }

    except Exception as e:
        return {
            "error": str(e),
            "headers": standard_headers,
            "processes": []
        }


def parse(directory):
    result = {}

    ps_sources = [
        ("ps_auxwwwm", "sos_commands/process/ps_auxwwwm"),
        ("ps_auxZww", "sos_commands/selinux/ps_auxZww"),
    ]

    for name, rel_path in ps_sources:
        ps_path = os.path.join(directory, rel_path)
        if os.path.isfile(ps_path):
            result[name] = parse_ps_file(ps_path, variant=name)
        else:
            result[name] = {
                "headers": [
                    "USER", "LABEL", "PID", "PPID", "%CPU", "%MEM", "VSZ", "RSS", "TTY",
                    "STAT", "START", "TIME", "COMMAND"
                ],
                "processes": []
            }
    return result
