"""The sosreport Log Viewer's journal parse and its stream AS THEY WERE before the speed-up (JournalctlParser.parse_entries_streaming at
c5bc7e0, verbatim): the oracle of tests/log_viewer_identical.test.py - the new code must give byte-for-byte the same
rows. Called with a JournalctlParser as `self` (its binary search and timestamp helpers are unchanged)."""
import os  # noqa: F401
import re
from datetime import datetime

from parsers.sosreport.log_viewer import (  # noqa: F401
    _SEVERITY_BY_K8S_CODE, _SEVERITY_BY_PRIORITY, _SEVERITY_BY_WORD, _SEVERITY_FIELD_RE, _SEVERITY_K8S_RE, _SEVERITY_LEVELS,
    _SEVERITY_PRIORITY_RE, _SEVERITY_TOKEN_RE, _SEVERITY_WORD_RE)
from parsers.sosreport.log_viewer import JOURNAL_LINE_RE, JOURNAL_TS_RE, JournalctlParser, _find_main_journal, classify_severity, get_parser_for_file, report_capture_time  # noqa: F401


def legacy_parse_entries_streaming(self, filepath, start_date, end_date):
    """Parse journalctl log entries and yield one at a time"""
    timestamp_pattern = JOURNAL_TS_RE
    self._reference = report_capture_time(filepath)
    current_year = self._reference.year if self._reference else datetime.now().year

    try:
        # Get file size
        file_size = os.path.getsize(filepath)

        if start_date or end_date:
            print(f"[JournalctlParser] Using binary search to find date range: {start_date} to {end_date}")
            print(f"[JournalctlParser] File size: {file_size:,} bytes")

            # Binary search to find start and end positions
            start_pos, start_ts = self._binary_search_start(filepath, start_date, file_size, current_year, timestamp_pattern)
            end_pos, end_ts = self._binary_search_end(filepath, end_date, file_size, current_year, timestamp_pattern)

            # If start_date provided but no entries >= start_date found, return empty
            if start_date and start_ts is None:
                print(f"[JournalctlParser] No entries found >= start_date, returning 0 results")
                print(f"[JournalctlParser] Streaming complete: 0 entries")
                return

            # If end_date provided but no entries <= end_date found, return empty
            # (This means all entries are after end_date)
            if end_date and end_ts is None and start_ts and start_ts > end_date:
                print(f"[JournalctlParser] No entries found <= end_date, returning 0 results")
                print(f"[JournalctlParser] Streaming complete: 0 entries")
                return

            bytes_to_read = end_pos - start_pos
            percent_of_file = (bytes_to_read / file_size * 100) if file_size > 0 else 0
            print(f"[JournalctlParser] Reading {percent_of_file:.1f}% of file")

        else:
            print(f"[JournalctlParser] No date filter, reading entire file...")
            start_pos = 0
            end_pos = file_size

    except Exception as e:
        print(f"[JournalctlParser] Error during binary search: {e}")
        import traceback
        traceback.print_exc()
        start_pos = 0
        end_pos = file_size

    issue_patterns = {
        'kernel_panic': re.compile(r'kernel panic', re.IGNORECASE),
        'oom_killer': re.compile(r'out of memory|oom[-_]killer|killed process', re.IGNORECASE),
        'segfault': re.compile(r'segfault|segmentation fault', re.IGNORECASE),
        'disk_error': re.compile(r'i/o error|disk.*error|blk.*error', re.IGNORECASE),
        'network_error': re.compile(r'network.*unreachable|connection.*refused|timeout', re.IGNORECASE),
        'service_failed': re.compile(r'failed to start|service.*failed', re.IGNORECASE),
        'authentication_failure': re.compile(r'authentication failure|failed password', re.IGNORECASE),
    }

    full_pattern = JOURNAL_LINE_RE   # host, process[pid]: message after any of the timestamp forms

    current_entry = None
    use_prev_year = False
    if start_date and start_date.year < current_year:
        use_prev_year = True

    print(f"[JournalctlParser] Starting streaming parse...")
    entry_count = 0

    # Parse file line-by-line without loading everything into memory
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            # Seek to the start position: the START of the first line in
            # range (_binary_search_start returns line starts), so nothing
            # is skipped there. Skipping a "partial line" here dropped the
            # first entry of every date-ranged load ("Loaded N entries"
            # was one short, and a range of a single moment found nothing).
            f.seek(start_pos)

            line_num = 0
            bytes_read = f.tell()

            while bytes_read < end_pos:
                line = f.readline()
                if not line:
                    break

                line_num += 1
                bytes_read = f.tell()

                # Progress logging
                if line_num % 100000 == 0:
                    print(f"[JournalctlParser] Streamed {entry_count:,} entries so far...")

                # Sanitize line
                line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

                timestamp_match = timestamp_pattern.match(line)

                if timestamp_match:
                    # Yield the previous entry
                    if current_entry:
                        yield current_entry
                        entry_count += 1

                    timestamp_str = timestamp_match.group(1)

                    try:
                        timestamp_obj = self._parse_timestamp(timestamp_str, current_year)
                        if timestamp_obj is None:
                            raise ValueError(timestamp_str)
                        if use_prev_year and timestamp_obj > datetime.now():
                            timestamp_obj = timestamp_obj.replace(year=timestamp_obj.year - 1)
                    except:
                        timestamp_obj = None
                        current_entry = None
                        continue

                    full_match = full_pattern.match(line)
                    if full_match:
                        hostname = full_match.group('host')
                        process = full_match.group('proc')
                        pid = full_match.group('pid') or ''
                        message = full_match.group('msg')
                    else:
                        hostname = ''
                        process = ''
                        pid = ''
                        message = line.strip()

                    # the level the message states (classify_severity: the same rules for every parser)
                    severity = classify_severity(message)

                    issues_found = []
                    for issue_name, pattern in issue_patterns.items():
                        if pattern.search(line):
                            issues_found.append(issue_name)

                    current_entry = {
                        'line_number': line_num,
                        'timestamp': timestamp_str,
                        'timestamp_obj': timestamp_obj.isoformat() if timestamp_obj else None,
                        'hostname': hostname,
                        'process': process,
                        'pid': pid,
                        'severity': severity,
                        'message': message,
                        'issues': issues_found
                    }
                else:
                    # Continuation line
                    if current_entry:
                        current_entry['message'] += '\n' + line.strip()

                        for issue_name, pattern in issue_patterns.items():
                            if pattern.search(line) and issue_name not in current_entry['issues']:
                                current_entry['issues'].append(issue_name)

            # Yield the last entry
            if current_entry:
                yield current_entry
                entry_count += 1

    except Exception as e:
        print(f"[JournalctlParser] Error streaming: {e}")
        import traceback
        traceback.print_exc()

    print(f"[JournalctlParser] Streaming complete: {entry_count:,} entries")


def legacy_parse_date_range_stream(directory, start_date_str, end_date_str, log_paths=None, batch_size=5000):
    """Stream log entries progressively as they're parsed - yields batches

    Args:
        directory: sosreport directory path
        start_date_str: start date ISO string
        end_date_str: end date ISO string
        log_paths: list of log file paths to parse
        batch_size: number of entries per batch (default 5000)

    Yields:
        Dict containing batch of entries and stats
    """
    # Parse start and end dates
    try:
        start_date = datetime.fromisoformat(start_date_str) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str) if end_date_str else None
    except:
        start_date = None
        end_date = None

    # Handle sosreport directory structure
    entries_list = os.listdir(directory)
    if len(entries_list) == 1:
        inner = os.path.join(directory, entries_list[0])
        if os.path.isdir(inner):
            directory = inner

    # If no log_paths specified, default to main journalctl
    if not log_paths:
        log_paths = [_find_main_journal(directory) or os.path.join(directory, "sos_commands/logs/journalctl_--no-pager")]

    print(f"[Log Viewer Stream] Starting to parse {len(log_paths)} files")

    # Parse each file and yield batches
    batch = []
    total_count = 0
    stats = {
        'error': 0,
        'warning': 0,
        'critical': 0,
        'info': 0,
        'debug': 0,
        'other': 0
    }

    # each chunk names the file it comes from (1-based) and the count: the viewer's progress line
    file_index = 0
    for file_index, log_path in enumerate(log_paths, start=1):
        if not os.path.exists(log_path):
            print(f"[Log Viewer Stream] Skipping non-existent path: {log_path}")
            continue

        try:
            parser = get_parser_for_file(log_path)
            print(f"[Log Viewer Stream] Parsing {log_path} with {parser.__class__.__name__}")

            # Parse entries line-by-line
            entries = legacy_parse_entries_streaming(parser, log_path, start_date, end_date) if isinstance(parser, JournalctlParser) else parser.parse_entries_streaming(log_path, start_date, end_date)
            for entry in entries:
                batch.append(entry)
                total_count += 1

                # Update stats
                severity = entry.get('severity', 'other')
                if severity in stats:
                    stats[severity] += 1

                # Yield batch when it reaches batch_size
                if len(batch) >= batch_size:
                    yield {
                        'entries': batch,
                        'stats': stats.copy(),
                        'total_count': total_count,
                        'file': file_index,
                        'files': len(log_paths),
                        'done': False
                    }
                    batch = []

        except Exception as e:
            print(f"[Log Viewer Stream] Error parsing {log_path}: {e}")
            import traceback
            traceback.print_exc()
            continue

    # Yield any remaining entries
    if batch:
        yield {
            'entries': batch,
            'stats': stats.copy(),
            'total_count': total_count,
            'file': len(log_paths),
            'files': len(log_paths),
            'done': False
        }

    # Final yield with completion flag
    yield {
        'entries': [],
        'stats': stats,
        'total_count': total_count,
        'done': True
    }

    print(f"[Log Viewer Stream] Completed - streamed {total_count} total entries")


def legacy_classify_severity(message):
    """The level a log message states, or 'other' when it states none."""
    if not message:
        return 'other'
    m = _SEVERITY_PRIORITY_RE.match(message)
    if m:
        # <N> carries facility*8 + level; the level is the low three bits
        return _SEVERITY_BY_PRIORITY.get(int(m.group(1)) & 7, 'other')
    m = _SEVERITY_K8S_RE.match(message)
    if m:
        return _SEVERITY_BY_K8S_CODE.get(m.group(1), 'other')
    m = _SEVERITY_FIELD_RE.search(message)
    if m and m.group(1).lower() in _SEVERITY_BY_WORD:
        return _SEVERITY_BY_WORD[m.group(1).lower()]
    m = _SEVERITY_TOKEN_RE.search(message)
    if m:
        return _SEVERITY_BY_WORD[m.group(1).lower()]
    # whole words, any case; the strongest level wins when several appear
    found = {_SEVERITY_BY_WORD[w.lower()] for w in _SEVERITY_WORD_RE.findall(message)}
    for level in _SEVERITY_LEVELS:
        if level in found:
            return level
    return 'other'


# ---- the must-gather Log Viewer's search (parsers/mustgather/log_viewer.search at c5bc7e0, verbatim) --------------
import time  # noqa: E402
from parsers.mustgather.log_viewer import (  # noqa: E402,F401 - the helpers it calls, unchanged
    BUDGET_SECONDS, CHECK_EVERY, MAX_LINE, _begin, _current, _has_timestamps, _open, _ref_of, _row, _year_of, resolve_data_dir, source_key)


def legacy_mg_search(directory, q, budget_seconds=BUDGET_SECONDS):
    """One page of the search: see the module docstring."""
    root = resolve_data_dir(directory)
    year = _year_of(directory)
    ref = _ref_of(directory)
    mine = _begin(root)
    t0 = time.monotonic()
    deadline = t0 + budget_seconds
    entries, scanned, lines_read = [], 0, 0
    fi, offset = q['cursor']['file'], q['cursor']['offset']
    sources = q['sources']
    cancelled = False
    truncated = 0
    while fi < len(sources):
        source = sources[fi]
        path = source['path']
        stop_here = False
        try:
            untimestamped = not _has_timestamps(path, year, ref)
            with _open(path) as f:
                f.seek(offset)
                last = None
                while True:
                    raw = f.readline()
                    if not raw:
                        break
                    offset = f.tell()
                    lines_read += 1
                    if lines_read % CHECK_EVERY == 0:
                        if not _current(root, mine):
                            cancelled = True
                            break
                        if time.monotonic() > deadline:
                            stop_here = True
                            break
                    line = raw.decode('utf-8', 'replace').rstrip('\n\r')
                    if len(line) > MAX_LINE:
                        line = line[:MAX_LINE] + ' …'
                        truncated += 1
                    row = _row(line, source, year, untimestamped, ref)
                    if row is None:
                        # a continuation line (a traceback, a wrapped message) belongs to the row before it
                        if last is not None and line.strip():
                            last['message'] += '\n' + line
                        continue
                    last = row
                    # the date range applies to dated rows; a log without timestamps loads whole, in file order
                    if row['timestamp_obj']:
                        if q['start'] and datetime.fromisoformat(row['timestamp_obj']) < q['start']:
                            continue
                        if q['end'] and datetime.fromisoformat(row['timestamp_obj']) > q['end']:
                            continue
                    if q['level'] and row['severity'] != q['level']:
                        continue
                    if q['source'] and source_key(row) != q['source']:
                        continue
                    if q['query'] or q['exclude']:
                        text = (row['hostname'] + ' ' + row['process'] + ' ' + row['message']).lower()
                        if q['query'] and not any(t in text for t in q['query']):
                            continue
                        if q['exclude'] and any(t in text for t in q['exclude']):
                            continue
                    entries.append(row)
                    if len(entries) >= q['limit']:
                        stop_here = True
                        break
        except OSError as e:
            entries.append({'timestamp': '', 'timestamp_obj': '', 'severity': 'error', 'hostname': '', 'process': source['name'], 'pid': '', 'message': f'this log could not be read: {e.strerror or e}', 'badges': [{'kind': 'bad', 'text': 'unreadable'}]})
        if cancelled:
            return {'ok': False, 'cancelled': True, 'error': 'cancelled', 'message': 'a newer search replaced this one', 'entries': [], 'cursor': None, 'done': True}
        if stop_here:
            break
        scanned += 1
        fi += 1
        offset = 0
    done = fi >= len(sources)
    return {'ok': True, 'entries': entries, 'cursor': None if done else {'file': fi, 'offset': offset}, 'done': done, 'scanned': scanned,
            'files': len(sources), 'seconds': round(time.monotonic() - t0, 3), 'lines': lines_read, 'truncated': truncated}
