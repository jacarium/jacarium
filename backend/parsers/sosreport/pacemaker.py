"""
Pacemaker Parser for sosreport
Parses Pacemaker cluster status, resources, and configuration
"""

import os
import re
from collections import defaultdict


def parse_pcs_status(status_path):
    """Parse pcs status output"""
    if not os.path.exists(status_path):
        return None

    result = {
        'cluster_name': None,
        'stack': None,
        'nodes': [],
        'resources': [],
        'failures': [],
        'raw_output': []
    }

    current_section = None

    try:
        with open(status_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            result['raw_output'] = content.split('\n')

            lines = content.split('\n')
            i = 0
            while i < len(lines):
                line = lines[i].strip()

                # Cluster name
                if 'Cluster name:' in line:
                    result['cluster_name'] = line.split('Cluster name:')[1].strip()

                # Stack
                if 'Stack:' in line or 'CLUSTER:' in line:
                    if 'Stack:' in line:
                        result['stack'] = line.split('Stack:')[1].strip()

                # Node section
                if line.startswith('Node List:') or line.startswith('Online:') or line.startswith('Offline:'):
                    current_section = 'nodes'

                    # Parse online/offline nodes
                    if 'Online:' in line:
                        nodes_str = line.split('Online:')[1].strip()
                        # Remove brackets and split
                        nodes_str = nodes_str.strip('[]')
                        if nodes_str:
                            for node in nodes_str.split():
                                result['nodes'].append({
                                    'name': node,
                                    'status': 'online',
                                    'resources': []
                                })

                    if 'Offline:' in line or 'OFFLINE:' in line:
                        nodes_str = line.split('OFFLINE:' if 'OFFLINE:' in line else 'Offline:')[1].strip()
                        nodes_str = nodes_str.strip('[]')
                        if nodes_str:
                            for node in nodes_str.split():
                                result['nodes'].append({
                                    'name': node,
                                    'status': 'offline',
                                    'resources': []
                                })

                # Resource section
                if 'Full List of Resources:' in line or 'Full list of resources:' in line:
                    current_section = 'resources'
                    i += 1
                    continue

                # Parse resources
                if current_section == 'resources' and line:
                    # Match resource lines like:
                    # * ip-172.16.0.1	(ocf::heartbeat:IPaddr2):	Started overcloud-controller-0
                    # * openstack-cinder-volume	(systemd:openstack-cinder-volume):	Started overcloud-controller-1
                    # * Clone Set: haproxy-bundle [haproxy-bundle-podman-0]

                    resource_match = re.match(r'\*\s+(\S+)\s+\(([^)]+)\):\s+(\S+)(?:\s+(\S+))?', line)
                    if resource_match:
                        resource_name = resource_match.group(1)
                        resource_type = resource_match.group(2)
                        status = resource_match.group(3)
                        node = resource_match.group(4) if resource_match.group(4) else None

                        result['resources'].append({
                            'name': resource_name,
                            'type': resource_type,
                            'status': status,
                            'node': node,
                            'role': None
                        })

                    # Match clone/master resources
                    clone_match = re.match(r'\*\s+(Clone Set|Master/Slave Set):\s+(\S+)\s+\[([^\]]+)\]', line)
                    if clone_match:
                        clone_type = clone_match.group(1)
                        clone_name = clone_match.group(2)
                        clone_resource = clone_match.group(3)

                        result['resources'].append({
                            'name': clone_name,
                            'type': clone_type,
                            'status': 'Active',
                            'node': None,
                            'role': None,
                            'resource': clone_resource
                        })

                # Parse failures
                if 'Failed Resource Actions:' in line or 'Failed Actions:' in line:
                    current_section = 'failures'
                    i += 1
                    continue

                if current_section == 'failures' and line and not line.startswith('---'):
                    # Parse failure lines
                    # Format: * resource_action_interval on node 'status' (code): details
                    failure_match = re.match(r'\*\s+(\S+)\s+on\s+(\S+)\s+(.+)', line)
                    if failure_match:
                        resource_action = failure_match.group(1)
                        node = failure_match.group(2)
                        message = failure_match.group(3).strip()

                        # Extract resource and action from resource_action
                        # Format is typically: resource_action_interval
                        # Split by underscore and try to separate resource from action
                        action_parts = resource_action.rsplit('_', 2)
                        if len(action_parts) >= 2:
                            resource = action_parts[0]
                            action = '_'.join(action_parts[1:])
                        else:
                            resource = resource_action
                            action = 'unknown'

                        # Extract exit code from message if present
                        # Format: 'status' (code): details
                        exit_code = 'unknown'
                        exit_match = re.search(r'\((\d+)\)', message)
                        if exit_match:
                            exit_code = exit_match.group(1)

                        result['failures'].append({
                            'resource': resource,
                            'action': action,
                            'node': node,
                            'exit_code': exit_code,
                            'message': message
                        })

                i += 1

    except Exception as e:
        print(f"Error parsing pcs status: {e}")
        return None

    return result


def parse_crm_mon(crm_mon_path):
    """Parse crm_mon output for detailed cluster status"""
    if not os.path.exists(crm_mon_path):
        return None

    result = {
        'last_updated': None,
        'stack': None,
        'dc': None,
        'nodes_configured': 0,
        'resources_configured': 0,
        'nodes': [],
        'resources': []
    }

    try:
        with open(crm_mon_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()

            # Extract header info
            if 'Last updated:' in content or 'Last change:' in content:
                for line in content.split('\n'):
                    if 'Last updated:' in line or 'Last change:' in line:
                        result['last_updated'] = line.strip()
                        break

            # Extract DC
            dc_match = re.search(r'Current DC:\s+(\S+)', content)
            if dc_match:
                result['dc'] = dc_match.group(1)

            # Extract node/resource counts
            nodes_match = re.search(r'(\d+)\s+[Nn]odes?\s+configured', content)
            if nodes_match:
                result['nodes_configured'] = int(nodes_match.group(1))

            resources_match = re.search(r'(\d+)\s+[Rr]esources?\s+configured', content)
            if resources_match:
                result['resources_configured'] = int(resources_match.group(1))

    except Exception as e:
        print(f"Error parsing crm_mon: {e}")
        return None

    return result


def parse_pcs_config(config_path):
    """Parse pcs config output"""
    if not os.path.exists(config_path):
        return None

    result = {
        'cluster_properties': {},
        'stonith_enabled': None,
        'constraints': [],
        'raw_config': [],
        'resources': {}
    }

    try:
        with open(config_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            result['raw_config'] = content.split('\n')

            # Check stonith
            if 'stonith-enabled' in content:
                stonith_match = re.search(r'stonith-enabled[=:]\s*(\S+)', content)
                if stonith_match:
                    result['stonith_enabled'] = stonith_match.group(1).lower() == 'true'

            # Parse cluster properties
            props_section = False
            resource_section = False
            current_resource = None
            resource_lines = []

            for line in content.split('\n'):
                stripped = line.strip()

                if 'Cluster Properties:' in stripped:
                    props_section = True
                    resource_section = False
                    continue

                # Only trigger on "Resources:" or "Stonith Devices:" section headers
                if stripped == 'Resources:' or stripped == 'Stonith Devices:':
                    resource_section = True
                    props_section = False
                    continue

                if props_section:
                    if stripped and ':' in stripped and not stripped.startswith('Resource'):
                        try:
                            key, value = stripped.split(':', 1)
                            result['cluster_properties'][key.strip()] = value.strip()
                        except:
                            pass
                    elif stripped.startswith('Resource') or stripped.startswith('Stonith') or stripped.startswith('Fencing'):
                        props_section = False

                # Parse resources section
                if resource_section:
                    # Detect start of a new resource or bundle
                    # Formats: "Resource: name (type):" or "Bundle: name" or "Clone Set: name"
                    resource_match = re.match(r'^\s*Resource:\s+(\S+)', stripped)
                    bundle_match = re.match(r'^\s*Bundle:\s+(\S+)', stripped)
                    clone_match = re.match(r'^\s*(Clone Set|Master):\s+(\S+)', stripped)

                    if resource_match or bundle_match or clone_match:
                        # Save previous resource
                        if current_resource and resource_lines:
                            result['resources'][current_resource] = '\n'.join(resource_lines)

                        # Start new resource
                        if resource_match:
                            current_resource = resource_match.group(1)
                        elif bundle_match:
                            current_resource = bundle_match.group(1)
                        else:
                            current_resource = clone_match.group(2)

                        # Store original line with indentation
                        resource_lines = [line.rstrip()]
                    elif current_resource:
                        # Continue collecting lines for current resource
                        # Stop if we hit a new section (non-indented lines that are section headers)
                        if stripped and not line.startswith(' ') and any(s in stripped for s in ['Stonith Devices:', 'Fencing Levels:', 'Location Constraints:', 'Ordering Constraints:', 'Colocation Constraints:', 'Ticket Constraints:', 'Resources Defaults:', 'Operations Defaults:']):
                            if resource_lines:
                                result['resources'][current_resource] = '\n'.join(resource_lines)
                            current_resource = None
                            resource_lines = []
                            resource_section = False
                        elif line.strip():  # If line has content
                            # Store original line with indentation
                            resource_lines.append(line.rstrip())
                        elif resource_lines:  # Empty line - keep it if we have content
                            resource_lines.append('')

            # Save last resource if any
            if current_resource and resource_lines:
                result['resources'][current_resource] = '\n'.join(resource_lines)

    except Exception as e:
        print(f"Error parsing pcs config: {e}")
        return None

    return result


def parse_pcs_property_list(property_path):
    """Parse pcs property list --all output"""
    if not os.path.exists(property_path):
        return None

    result = {
        'properties': {},
        'raw_output': []
    }

    try:
        with open(property_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            result['raw_output'] = content.split('\n')

            # Parse properties from output
            for line in content.split('\n'):
                line = line.strip()
                if ':' in line and not line.startswith('Cluster') and not line.startswith('Properties'):
                    try:
                        key, value = line.split(':', 1)
                        result['properties'][key.strip()] = value.strip()
                    except:
                        pass

    except Exception as e:
        print(f"Error parsing pcs property list: {e}")
        return None

    return result


def parse_pcs_quorum_status(quorum_path):
    """Parse pcs quorum status output"""
    if not os.path.exists(quorum_path):
        return None

    result = {
        'quorate': None,
        'nodes': [],
        'votes': {},
        'raw_output': []
    }

    try:
        with open(quorum_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            result['raw_output'] = content.split('\n')

            # Check if quorate
            if 'Quorate:' in content:
                quorate_match = re.search(r'Quorate:\s*(\S+)', content)
                if quorate_match:
                    result['quorate'] = quorate_match.group(1).lower() == 'yes'

            # Parse votes
            total_match = re.search(r'Total votes:\s*(\d+)', content)
            if total_match:
                result['votes']['total'] = int(total_match.group(1))

            expected_match = re.search(r'Expected votes:\s*(\d+)', content)
            if expected_match:
                result['votes']['expected'] = int(expected_match.group(1))

            quorum_match = re.search(r'Quorum:\s*(\d+)', content)
            if quorum_match:
                result['votes']['quorum'] = int(quorum_match.group(1))

    except Exception as e:
        print(f"Error parsing pcs quorum status: {e}")
        return None

    return result


def parse_pcs_stonith_history(history_path):
    """Parse pcs stonith history show output"""
    if not os.path.exists(history_path):
        return None

    result = {
        'history': [],
        'raw_output': []
    }

    try:
        with open(history_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            result['raw_output'] = content.split('\n')

            # Parse history entries
            # This will capture the raw history - detailed parsing can be added based on actual format
            if content.strip() and 'No fence history' not in content:
                result['has_history'] = True
            else:
                result['has_history'] = False

    except Exception as e:
        print(f"Error parsing pcs stonith history: {e}")
        return None

    return result


def parse(sosreport_path):
    """Main parser function for Pacemaker"""
    result = {
        'status': None,
        'crm_mon': None,
        'config': None,
        'properties': None,
        'quorum': None,
        'stonith_history': None
    }

    # Parse pcs status
    status_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/pcs_status_--full')
    if os.path.exists(status_path):
        result['status'] = parse_pcs_status(status_path)

    # Parse crm_mon (if exists)
    crm_mon_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/crm_mon_-1')
    if os.path.exists(crm_mon_path):
        result['crm_mon'] = parse_crm_mon(crm_mon_path)

    # Parse pcs config
    config_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/pcs_config')
    if os.path.exists(config_path):
        result['config'] = parse_pcs_config(config_path)

    # Parse pcs property list --all
    property_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/pcs_property_list_--all')
    if os.path.exists(property_path):
        result['properties'] = parse_pcs_property_list(property_path)

    # Parse pcs quorum status
    quorum_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/pcs_quorum_status')
    if os.path.exists(quorum_path):
        result['quorum'] = parse_pcs_quorum_status(quorum_path)

    # Parse pcs stonith history
    stonith_history_path = os.path.join(sosreport_path, 'sos_commands/pacemaker/pcs_stonith_history_show')
    if os.path.exists(stonith_history_path):
        result['stonith_history'] = parse_pcs_stonith_history(stonith_history_path)

    # Merge resource configurations from config into status resources
    if result['status'] and result['status'].get('resources') and result['config'] and result['config'].get('resources'):
        config_resources = result['config']['resources']

        for resource in result['status']['resources']:
            resource_name = resource['name']

            # Try exact match first
            if resource_name in config_resources:
                resource['config'] = config_resources[resource_name]
            else:
                # Try partial match (for clone sets, etc.)
                for config_name, config_data in config_resources.items():
                    if config_name in resource_name or resource_name in config_name:
                        resource['config'] = config_data
                        break

    return result
