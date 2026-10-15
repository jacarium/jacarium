"""
HAProxy Parser for sosreport
Parses HAProxy configuration and logs to identify issues
"""

import os
import re
import gzip
from datetime import datetime, timedelta
from collections import defaultdict
from glob import glob


def parse_haproxy_config(config_path):
    """Parse haproxy.cfg and extract backend/frontend information"""
    if not os.path.exists(config_path):
        return None

    config = {
        'frontends': {},
        'backends': {},
        'defaults': {'raw': []},
        'global': {'raw': []},
        'stats_enabled': False,
        'stats_socket': None,
        'stats_bind': None
    }

    current_section = None
    current_name = None

    try:
        with open(config_path, 'r') as f:
            for line in f:
                line = line.strip()

                # Skip comments and empty lines for section detection
                if not line or line.startswith('#'):
                    continue

                # Section headers
                if line.startswith('global'):
                    current_section = 'global'
                    continue
                elif line.startswith('defaults'):
                    current_section = 'defaults'
                    continue
                elif line.startswith('frontend'):
                    current_section = 'frontend'
                    current_name = line.split()[1] if len(line.split()) > 1 else 'unknown'
                    config['frontends'][current_name] = {
                        'binds': [],
                        'acls': [],
                        'use_backend': [],
                        'default_backend': None,
                        'raw': []
                    }
                    continue
                elif line.startswith('backend'):
                    current_section = 'backend'
                    current_name = line.split()[1] if len(line.split()) > 1 else 'unknown'
                    config['backends'][current_name] = {
                        'servers': [],
                        'balance': None,
                        'mode': None,
                        'options': [],
                        'raw': []
                    }
                    continue
                elif line.startswith('listen'):
                    current_section = 'listen'
                    current_name = line.split()[1] if len(line.split()) > 1 else 'unknown'
                    # Listen combines frontend and backend
                    config['frontends'][current_name] = {
                        'binds': [],
                        'acls': [],
                        'use_backend': [],
                        'default_backend': None,
                        'raw': []
                    }
                    config['backends'][current_name] = {
                        'servers': [],
                        'balance': None,
                        'mode': None,
                        'options': [],
                        'raw': []
                    }
                    continue

                # Store raw line for all sections
                if current_section == 'global':
                    config['global']['raw'].append(line)
                    if 'stats socket' in line:
                        config['stats_socket'] = line.split('stats socket')[1].strip()

                elif current_section == 'defaults':
                    config['defaults']['raw'].append(line)

                elif current_section == 'frontend' and current_name:
                    config['frontends'][current_name]['raw'].append(line)
                    if line.startswith('bind'):
                        config['frontends'][current_name]['binds'].append(line.split('bind')[1].strip())
                    elif line.startswith('acl'):
                        config['frontends'][current_name]['acls'].append(line)
                    elif line.startswith('use_backend'):
                        config['frontends'][current_name]['use_backend'].append(line)
                    elif line.startswith('default_backend'):
                        config['frontends'][current_name]['default_backend'] = line.split()[1]

                elif current_section == 'backend' and current_name:
                    config['backends'][current_name]['raw'].append(line)
                    if line.startswith('server'):
                        parts = line.split()
                        server_info = {
                            'name': parts[1] if len(parts) > 1 else 'unknown',
                            'address': parts[2] if len(parts) > 2 else 'unknown',
                            'config': ' '.join(parts[3:]) if len(parts) > 3 else '',
                            'check': 'check' in line,
                            'backup': 'backup' in line
                        }
                        config['backends'][current_name]['servers'].append(server_info)
                    elif line.startswith('balance'):
                        config['backends'][current_name]['balance'] = line.split()[1]
                    elif line.startswith('mode'):
                        config['backends'][current_name]['mode'] = line.split()[1]
                    elif line.startswith('option'):
                        config['backends'][current_name]['options'].append(line)

                elif current_section == 'listen' and current_name:
                    # Listen sections can have both frontend and backend directives
                    config['backends'][current_name]['raw'].append(line)
                    if line.startswith('bind'):
                        config['frontends'][current_name]['binds'].append(line.split('bind')[1].strip())
                    elif line.startswith('stats'):
                        config['stats_enabled'] = True
                        if 'bind' in line:
                            config['stats_bind'] = line.split('bind')[1].strip()
                    elif line.startswith('server'):
                        parts = line.split()
                        server_info = {
                            'name': parts[1] if len(parts) > 1 else 'unknown',
                            'address': parts[2] if len(parts) > 2 else 'unknown',
                            'config': ' '.join(parts[3:]) if len(parts) > 3 else '',
                            'check': 'check' in line,
                            'backup': 'backup' in line
                        }
                        config['backends'][current_name]['servers'].append(server_info)
                    elif line.startswith('balance'):
                        config['backends'][current_name]['balance'] = line.split()[1]
                    elif line.startswith('mode'):
                        config['backends'][current_name]['mode'] = line.split()[1]

    except Exception as e:
        print(f"Error parsing haproxy config: {e}")
        return None

    return config


def parse_single_log_file(log_file):
    """Parse a single HAProxy log file and return issues and timestamps"""
    issues = {
        'backend_down': [],
        'server_down': [],
        'errors': [],
        'timeouts': [],
        'connection_errors': []
    }

    # Track HTTP status codes dynamically
    http_status_codes = defaultdict(list)

    # Track termination state codes dynamically
    termination_states = defaultdict(list)

    all_timestamps = []
    current_year = datetime.now().year

    # Patterns to match
    patterns = {
        'server_down': re.compile(r'Server\s+(\S+)/(\S+)\s+is\s+DOWN', re.IGNORECASE),
        'backend_down': re.compile(r'backend\s+(\S+)\s+has\s+no\s+server\s+available', re.IGNORECASE),
        'error': re.compile(r'\berror\b', re.IGNORECASE),
        'timeout': re.compile(r'timeout', re.IGNORECASE),
        'connection_error': re.compile(r'connection\s+error', re.IGNORECASE),
        # HAProxy HTTP mode log format: <Tq>/<Tw>/<Tc>/<Tr>/<Tt> <status_code> <bytes_read>
        # Timing values can be numbers or -1 (using -?\d+ to match optional minus and digits)
        # Match status code after the five timing values
        'http_status': re.compile(r'-?\d+/-?\d+/-?\d+/-?\d+/-?\d+\s+(\d{3})\s+'),
        # Termination state for HTTP mode: Tq/Tw/Tc/Tr/Tt <status_code> <bytes> <state>
        'termination_state_http': re.compile(r'-?\d+/-?\d+/-?\d+/-?\d+/-?\d+\s+\d{3}\s+\d+\s+([a-zA-Z\-]{2})\s+'),
        # Termination state for TCP mode: Tc/Tw/Tt <bytes> <state> (only 3 timing values, no status code)
        'termination_state_tcp': re.compile(r'-?\d+/-?\d+/-?\d+\s+\d+\s+([a-zA-Z\-]{2})\s+')
    }

    def process_line(line):
        """Process a single log line"""
        # Try to extract timestamp
        timestamp_match = re.match(r'^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})', line)
        timestamp = timestamp_match.group(1) if timestamp_match else 'Unknown'

        # Collect all timestamps for time range
        if timestamp != 'Unknown':
            try:
                # Normalize spaces in timestamp (handle single-digit days with double space)
                normalized_ts = ' '.join(timestamp.split())
                ts = datetime.strptime(f"{normalized_ts} {current_year}", "%b %d %H:%M:%S %Y")
                all_timestamps.append(ts)
            except:
                pass

        # Check for server down
        match = patterns['server_down'].search(line)
        if match:
            issues['server_down'].append({
                'timestamp': timestamp,
                'backend': match.group(1),
                'server': match.group(2),
                'message': line.strip()
            })

        # Check for backend down
        match = patterns['backend_down'].search(line)
        if match:
            issues['backend_down'].append({
                'timestamp': timestamp,
                'backend': match.group(1),
                'message': line.strip()
            })

        # Check for errors
        if patterns['error'].search(line):
            issues['errors'].append({
                'timestamp': timestamp,
                'message': line.strip()
            })

        # Check for timeouts
        if patterns['timeout'].search(line):
            issues['timeouts'].append({
                'timestamp': timestamp,
                'message': line.strip()
            })

        # Check for connection errors
        if patterns['connection_error'].search(line):
            issues['connection_errors'].append({
                'timestamp': timestamp,
                'message': line.strip()
            })

        # Check for HTTP status codes (all codes)
        status_match = patterns['http_status'].search(line)
        if status_match:
            status_code = status_match.group(1)

            # Track all status codes
            http_status_codes[status_code].append({
                'timestamp': timestamp,
                'message': line.strip()
            })

        # Check for termination state codes (try both HTTP and TCP patterns)
        term_match = patterns['termination_state_http'].search(line)
        if not term_match:
            # Try TCP mode pattern if HTTP mode didn't match
            term_match = patterns['termination_state_tcp'].search(line)

        if term_match:
            term_state = term_match.group(1)

            # Only track non-normal terminations (anything except --)
            if term_state != '--':
                termination_states[term_state].append({
                    'timestamp': timestamp,
                    'message': line.strip()
                })

    try:
        # Check if file is gzipped
        if log_file.endswith('.gz'):
            with gzip.open(log_file, 'rt', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    process_line(line)
        else:
            with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    process_line(line)
    except Exception as e:
        print(f"Error parsing log file {log_file}: {e}")
        return None, None

    # Limit results to prevent overwhelming the UI
    for key in issues:
        if len(issues[key]) > 100:
            issues[key] = issues[key][-100:]

    # Limit HTTP status code entries
    for code in http_status_codes:
        if len(http_status_codes[code]) > 100:
            http_status_codes[code] = http_status_codes[code][-100:]

    # Limit termination state entries
    for state in termination_states:
        if len(termination_states[state]) > 100:
            termination_states[state] = termination_states[state][-100:]

    # Merge HTTP status codes into issues dict
    for code, entries in http_status_codes.items():
        issues[f'http_{code}'] = entries

    # Merge termination states into issues dict
    for state, entries in termination_states.items():
        issues[f'term_{state}'] = entries

    return issues, all_timestamps


def get_available_log_files(log_dir):
    """Get list of available HAProxy log files"""
    if not os.path.exists(log_dir):
        return None

    try:
        pattern = os.path.join(log_dir, 'haproxy.log*')
        log_files = sorted(glob(pattern))
        return [os.path.basename(f) for f in log_files] if log_files else None
    except Exception as e:
        print(f"Error finding log files: {e}")
        return None


def parse_haproxy_logs(log_dir, file_name='haproxy.log'):
    """Parse a specific haproxy log file or all files if file_name is '__all__'"""

    # Handle "All" option - combine all log files
    if file_name == '__all__':
        available_files = get_available_log_files(log_dir)
        if not available_files:
            return None

        # Combine issues and timestamps from all files
        combined_issues = defaultdict(list)
        combined_timestamps = []

        for log_file in available_files:
            log_path = os.path.join(log_dir, log_file)
            issues, timestamps = parse_single_log_file(log_path)

            if issues and timestamps:
                # Merge issues
                for issue_type, issue_list in issues.items():
                    combined_issues[issue_type].extend(issue_list)
                # Merge timestamps
                combined_timestamps.extend(timestamps)

        if combined_issues and combined_timestamps:
            # Convert defaultdict to regular dict
            combined_issues = dict(combined_issues)

            # Limit combined results
            for key in combined_issues:
                if len(combined_issues[key]) > 100:
                    combined_issues[key] = combined_issues[key][-100:]

            return {
                'issues': combined_issues,
                'timestamps': combined_timestamps,
                'time_series': aggregate_issues_by_time(combined_issues, combined_timestamps)
            }
        return None

    # Parse single file
    log_path = os.path.join(log_dir, file_name)

    if not os.path.exists(log_path):
        return None

    issues, all_timestamps = parse_single_log_file(log_path)

    if issues and all_timestamps:
        return {
            'issues': issues,
            'timestamps': all_timestamps,
            'time_series': aggregate_issues_by_time(issues, all_timestamps)
        }

    return None


def aggregate_issues_by_time(issues, all_timestamps):
    """Aggregate issues into time buckets for charting"""
    if not all_timestamps:
        return None

    current_year = datetime.now().year

    # Determine time span and bucket size
    min_time = min(all_timestamps)
    max_time = max(all_timestamps)
    time_span = (max_time - min_time).total_seconds()

    # If span > 24 hours, use daily buckets; otherwise use hourly
    use_daily = time_span > 86400  # 24 hours

    # Identify all issue types (including dynamic HTTP status codes and termination states)
    all_issue_types = set(issues.keys())
    http_status_codes = sorted([k.replace('http_', '') for k in all_issue_types if k.startswith('http_')])
    termination_states = sorted([k.replace('term_', '') for k in all_issue_types if k.startswith('term_')])
    system_issues = [k for k in all_issue_types if not k.startswith('http_') and not k.startswith('term_')]

    # Create empty bucket template
    empty_bucket = {issue_type: 0 for issue_type in all_issue_types}

    # Create time buckets - initialize all buckets in the time range with zeros
    time_buckets = {}

    # Generate all bucket keys in the time range
    current_time = min_time
    if use_daily:
        # Round down to start of day
        current_time = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        while current_time <= max_time:
            bucket_key = current_time.strftime("%Y-%m-%d")
            time_buckets[bucket_key] = empty_bucket.copy()
            current_time += timedelta(days=1)
    else:
        # Round down to start of hour
        current_time = current_time.replace(minute=0, second=0, microsecond=0)
        while current_time <= max_time:
            bucket_key = current_time.strftime("%Y-%m-%d %H:00")
            time_buckets[bucket_key] = empty_bucket.copy()
            current_time += timedelta(hours=1)

    # Aggregate each issue type into the buckets
    for issue_type, issue_list in issues.items():
        for issue in issue_list:
            ts_str = issue.get('timestamp', 'Unknown')
            if ts_str != 'Unknown':
                try:
                    # Normalize spaces in timestamp
                    normalized_ts = ' '.join(ts_str.split())
                    ts = datetime.strptime(f"{normalized_ts} {current_year}", "%b %d %H:%M:%S %Y")

                    if use_daily:
                        bucket_key = ts.strftime("%Y-%m-%d")
                    else:
                        bucket_key = ts.strftime("%Y-%m-%d %H:00")

                    if bucket_key in time_buckets:
                        time_buckets[bucket_key][issue_type] += 1
                except:
                    pass

    # Convert to sorted list for charting
    sorted_buckets = sorted(time_buckets.items())

    result = {
        'labels': [bucket[0] for bucket in sorted_buckets],
        'granularity': 'daily' if use_daily else 'hourly',
        'http_status_codes': http_status_codes,
        'termination_states': termination_states,
        'system_issues': system_issues
    }

    # Build data dict for all issue types
    result['data'] = {}
    for issue_type in all_issue_types:
        result['data'][issue_type] = [bucket[1][issue_type] for bucket in sorted_buckets]

    return result


def parse(sosreport_path):
    """Main parser function for HAProxy"""
    result = {
        'config': None,
        'log_files': None,
        'current_log': None
    }

    # Parse configuration
    config_path = os.path.join(
        sosreport_path,
        'var/lib/config-data/puppet-generated/haproxy/etc/haproxy/haproxy.cfg'
    )

    config = parse_haproxy_config(config_path)
    if config:
        result['config'] = config

    # Get list of available log files and parse only haproxy.log
    log_dir = os.path.join(
        sosreport_path,
        'var/log/containers/haproxy'
    )

    available_files = get_available_log_files(log_dir)
    if available_files:
        result['log_files'] = available_files
        # Parse only the default file (haproxy.log)
        default_file = 'haproxy.log' if 'haproxy.log' in available_files else available_files[0]
        result['current_log'] = parse_haproxy_logs(log_dir, default_file)

    return result
