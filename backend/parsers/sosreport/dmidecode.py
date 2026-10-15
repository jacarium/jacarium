import os
import re

def parse_dmidecode(path):
    entries = []
    current_entry = None

    status_rules = {
        "system power supply": [
            # "Non-Critical" also matches "Critical"; test the specific one first.
            (r"Status.*Non-Critical", "WARN"),
            (r"Status.*Non-Recoverable", "ERROR"),
            (r"Status.*Critical", "ERROR"),
            (r"Status.*OK", "OK"),
        ],
        "cooling device": [
            (r"Status.*OK", "OK"),
        ],
        "temperature probe": [
            (r"Status.*OK", "OK"),
        ],
        "voltage probe": [
            (r"Status.*OK", "OK"),
        ],
        "electrical current probe": [
            (r"Status.*OK", "OK"),
        ],
        "system boot information": [
            (r"No errors detected", "OK"),
            (r"No bootable media", "ERROR"),
            (r"Operating system failed to load", "ERROR"),
            (r"Firmware-detected hardware failure", "ERROR"),
            (r"Operating system-detected hardware failure", "ERROR"),
            (r"User-requested boot", "OK"),
            (r"System security violation", "WARN"),
            (r"Previously-requested image", "OK"),
            (r"System watchdog timer expired", "ERROR"),
        ],
    }

    def determine_status(entry):
        entry_type = entry["type_lc"]
        status = ""

        if entry_type in status_rules:
            detail_text = "\n".join(entry["details"])
            for pattern, level in status_rules[entry_type]:
                if re.search(pattern, detail_text, re.IGNORECASE):
                    status = level
                    break
        return status

    def extract_summary_info(entry):
        type_lc = entry.get("type_lc", "")
        info = {}

        if type_lc == "memory device":
            for line in entry["details"]:
                line = line.strip()
                if line.startswith("Manufacturer:"):
                    info["Manufacturer"] = line.split(":", 1)[1].strip()
                elif line.startswith("Speed:"):
                    info["Speed"] = line.split(":", 1)[1].strip()
                elif line.startswith("Size:") and "No Module Installed" not in line:
                    info["Size"] = line.split(":", 1)[1].strip()
                elif line.startswith("Type:") and not line.startswith("Type Detail:"):
                    if "Unknown" not in line and "Other" not in line:
                        info["Type"] = line.split(":", 1)[1].strip()


        elif type_lc == "physical memory array":
            for line in entry["details"]:
                line = line.strip()
                if line.startswith("Location:"):
                    info["Location"] = line.split(":", 1)[1].strip()
                elif line.startswith("Maximum Capacity:"):
                    info["MaximumCapacity"] = line.split(":", 1)[1].strip()
                elif line.startswith("Number Of Devices:"):
                    try:
                        info["NumberOfDevices"] = int(line.split(":", 1)[1].strip())
                    except ValueError:
                        pass

        elif type_lc == "processor information":
            for line in entry["details"]:
                line = line.strip()
                if line.startswith("Socket Designation:"):
                    info["Socket"] = line.split(":", 1)[1].strip()
                elif line.startswith("Version:"):
                    info["Version"] = line.split(":", 1)[1].strip()
                elif line.startswith("Manufacturer:"):
                    info["Manufacturer"] = line.split(":", 1)[1].strip()
                elif line.startswith("Max Speed:"):
                    info["MaxSpeed"] = line.split(":", 1)[1].strip()
                elif line.startswith("Core Count:"):
                    info["Core"] = line.split(":", 1)[1].strip()
                elif line.startswith("Core Enabled:"):
                    info["CoreEnabled"] = line.split(":", 1)[1].strip()
                elif line.startswith("Thread Count:"):
                    info["Threads"] = line.split(":", 1)[1].strip()

        elif type_lc == "base board information":
            for line in entry["details"]:
                line = line.strip()
                if line.startswith("Manufacturer:"):
                    info["Manufacturer"] = line.split(":", 1)[1].strip()
                elif line.startswith("Product Name:"):
                    info["ProductName"] = line.split(":", 1)[1].strip()
        elif type_lc == "cache information":
            for line in entry["details"]:
                line = line.strip()
                if line.startswith("Configuration:"):
                    info["Configuration"] = line.split(":", 1)[1].strip()
                elif line.startswith("Installed Size:"):
                    info["InstalledSize"] = line.split(":", 1)[1].strip()
                elif line.startswith("Speed:") and "Unknown" not in line:
                    info["Speed"] = line.split(":", 1)[1].strip()
                elif line.startswith("Socket Designation:"):
                    info["SocketDesignation"] = line.split(":", 1)[1].strip()
        elif type_lc == "hpe bios pxe nic pci and mac information":
            for line in entry["details"]:
                line = line.strip()
                match = re.match(r"NIC (\d+): PCI device ([0-9a-fA-F:.]+), MAC address ([0-9A-Fa-f:]+)", line)
                if match:
                    nic_number, pci_device, mac_address = match.groups()
                    info["NIC"] = nic_number
                    info["PCIAddress"] = pci_device
                    info["MACAddress"] = mac_address

        return info


    skip_summaries = {"end of table", "oem-specific type", "oem strings", "unknown type"}

    with open(path, 'r') as f:
        for line in f:
            line = line.rstrip()
            if not line.strip():
                continue

            if line.startswith("Handle"):
                if current_entry:
                    summary_lc = current_entry.get("summary", "").strip().lower()
                    if summary_lc not in skip_summaries:
                        current_entry["status"] = determine_status(current_entry)
                        current_entry["summary_info"] = extract_summary_info(current_entry)
                        entries.append(current_entry)
                current_entry = {
                    "summary": "",
                    "type": "",
                    "type_lc": "",
                    "vendor": "",
                    "vendor_lc": "",
                    "details": [],
                    "status": "OK",
                    "summary_info": {}
                }
                continue

            if current_entry is None:
                continue

            if not line.startswith('\t') and not current_entry["summary"]:
                type_str = line.strip()
                current_entry["summary"] = type_str
                current_entry["type"] = type_str
                current_entry["type_lc"] = type_str.lower()
            else:
                current_entry["details"].append(line)

            if 'Manufacturer:' in line or 'Vendor:' in line:
                vendor_str = line.split(':', 1)[-1].strip()
                current_entry["vendor"] = vendor_str
                current_entry["vendor_lc"] = vendor_str.lower()

    if current_entry:
        summary_lc = current_entry.get("summary", "").strip().lower()
        if summary_lc not in skip_summaries:
            current_entry["status"] = determine_status(current_entry)
            current_entry["summary_info"] = extract_summary_info(current_entry)
            entries.append(current_entry)

    return entries

def parse(directory):
    result = {}

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    dmidecode_paths = [
        os.path.join(directory, 'sos_commands', 'hardware', 'dmidecode'),
        os.path.join(directory, 'dmidecode'),
    ]
    for path in dmidecode_paths:
        if os.path.isfile(path):
            result['dmidecode'] = parse_dmidecode(path)
            break
    return result
