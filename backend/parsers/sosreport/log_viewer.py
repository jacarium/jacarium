import os
import re
from datetime import datetime, timedelta
from abc import ABC, abstractmethod
import hashlib
import json
import time

# Session cache for parsed entries
_session_cache = {}
_cache_expiry = {}
CACHE_TTL = 300  # 5 minutes


# Base parser class for different log formats

# ---- severity -------------------------------------------------------------
#
# One classifier for every parser. Each parser used to carry its own copy of
# the rules and they disagreed: the journal parser matched whole words and
# answered 'other' when nothing said a level, the container parser matched
# SUBSTRINGS ('ERR' in "preferred", 'FAILED' in "unfailed") and answered
# 'info'. So the same text was a different level in a different file, and
# "preferred route" was an error. The rules, in order:
#   1. a syslog priority prefix  <N>  (0-2 critical, 3 error, 4 warning,
#      5-6 info, 7 debug - the syslog(3) levels);
#   2. a Kubernetes/glog code at the start: E0528 / W0528 / I0528 / D / F;
#   3. an explicit field: level=warn, severity=error, lvl=info;
#   4. an explicit upper-case token as structured logs print it:
#      "| ERROR |", "[WARN]", "INFO:", "CRITICAL -";
#   5. a level word anywhere (whole words, any case): error/err/failed/...,
#      warning/warn/deprecated, info/notice, debug/trace, critical/panic/fatal;
#   6. otherwise 'other' - the line said nothing about its level.
_SEVERITY_BY_PRIORITY = {0: 'critical', 1: 'critical', 2: 'critical', 3: 'error', 4: 'warning', 5: 'info', 6: 'info', 7: 'debug'}
_SEVERITY_BY_K8S_CODE = {'E': 'error', 'W': 'warning', 'I': 'info', 'D': 'debug', 'F': 'critical'}
_SEVERITY_BY_WORD = {
    'critical': 'critical', 'crit': 'critical', 'fatal': 'critical', 'panic': 'critical', 'emerg': 'critical', 'emergency': 'critical', 'alert': 'critical',
    'error': 'error', 'err': 'error', 'failed': 'error', 'failure': 'error', 'segfault': 'error', 'oops': 'error', 'bug': 'error',
    'warning': 'warning', 'warn': 'warning', 'deprecated': 'warning',
    'info': 'info', 'informational': 'info', 'notice': 'info',
    'debug': 'debug', 'trace': 'debug',
}
_SEVERITY_PRIORITY_RE = re.compile(r'^\s*<(\d{1,3})>')
_SEVERITY_K8S_RE = re.compile(r'^([EWIDF])\d{4}\s')
_SEVERITY_FIELD_RE = re.compile(r'\b(?:level|severity|lvl)=["\']?([A-Za-z]+)', re.IGNORECASE)
_SEVERITY_TOKEN_RE = re.compile(r'(?:^|[\s|\[(])(CRITICAL|CRIT|FATAL|PANIC|EMERG|ALERT|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE)(?=$|[\s|\]):,-])')
_SEVERITY_WORD_RE = re.compile(r'\b(critical|crit|fatal|panic|emergency|error|err|failed|failure|segfault|oops|bug|warning|warn|deprecated|info|notice|debug|trace)\b', re.IGNORECASE)
_SEVERITY_LEVELS = ('critical', 'error', 'warning', 'info', 'debug', 'other')

# ---------------------------------------------------------------------------
# journalctl lines, in every output form sos and must-gather capture:
#   short               Oct 21 20:51:31 host proc[pid]: message
#   short-precise       Oct 21 20:51:31.951198 host proc[pid]: message
#   short-iso           2026-10-21T20:51:31+0000 host proc[pid]: message
#   short-iso-precise   2026-10-21T20:51:31.951198+0000 host proc[pid]: message
#   short-full          Wed 2026-10-21 20:51:31 UTC host proc[pid]: message
# The year-less forms take the year of the capture (the report's `date`, the gather's `timestamp`); a line later
# than the capture by more than a month is last year's (a December log read by a January capture).
# ---------------------------------------------------------------------------
_JOURNAL_TS = (r'(?:[A-Z][a-z]{2}\s+(?=\d{4}-))?'
               r'(?:(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+(?P<t1>\d{2}:\d{2}:\d{2})(?:\.(?P<f1>\d{1,9}))?'
               r'|(?P<date>\d{4}-\d{2}-\d{2})[T ](?P<t2>\d{2}:\d{2}:\d{2})(?:\.(?P<f2>\d{1,9}))?(?:Z|[+-]\d{2}:?\d{2}|\s+[A-Z]{2,5}(?=\s))?)')
JOURNAL_TS_RE = re.compile(r'^(' + _JOURNAL_TS + r')(?=\s)')
JOURNAL_LINE_RE = re.compile(r'^' + _JOURNAL_TS + r'\s+(?P<host>\S+)\s+(?P<proc>[^\s:\[]+)(?:\[(?P<pid>\d+)\])?:\s?(?P<msg>.*)$')
_JOURNAL_MONTHS = {m: i for i, m in enumerate(('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}
_DATE_FILE_FORMATS = ('%a %b %d %H:%M:%S %Z %Y', '%a %b %d %H:%M:%S %Y', '%a %d %b %Y %H:%M:%S %p %Z')


def _journal_datetime(m, year, reference):
    """The datetime a JOURNAL_* match states (micros kept); None for an impossible date."""
    try:
        if m.group('mon'):
            if m.group('mon') not in _JOURNAL_MONTHS:
                return None
            y = year or (reference.year if reference else datetime.now().year)
            micro = int((m.group('f1') or '0')[:6].ljust(6, '0'))
            ts = datetime(y, _JOURNAL_MONTHS[m.group('mon')], int(m.group('day')), *[int(x) for x in m.group('t1').split(':')], micro)
            if reference is not None and ts > reference + timedelta(days=31):
                ts = ts.replace(year=y - 1)
            return ts
        micro = int((m.group('f2') or '0')[:6].ljust(6, '0'))
        return datetime.strptime(m.group('date') + 'T' + m.group('t2'), '%Y-%m-%dT%H:%M:%S').replace(microsecond=micro)
    except ValueError:
        return None


def parse_journal_ts(token, year=None, reference=None):
    """A journal timestamp token (the forms above) as a datetime, or None."""
    m = JOURNAL_TS_RE.match(token.rstrip() + ' ')
    return _journal_datetime(m, year, reference) if m else None


def parse_journal_line(line, year=None, reference=None):
    """A journal line as {'ts', 'host', 'process', 'pid', 'message'}, or None when it is not one."""
    m = JOURNAL_LINE_RE.match(line)
    if not m:
        return None
    ts = _journal_datetime(m, year, reference)
    if ts is None:
        return None
    return {'ts': ts, 'host': m.group('host'), 'process': m.group('proc'), 'pid': m.group('pid') or '', 'message': m.group('msg')}


def report_capture_time(filepath):
    """The time a sosreport was taken, from its `date` capture (the report root above the file, found by its
    markers), as a naive datetime; None without one."""
    d = os.path.dirname(os.path.abspath(filepath))
    for _ in range(8):
        for rel in ('date', 'sos_commands/date/date', 'sos_commands/general/date'):
            p = os.path.join(d, rel)
            if os.path.isfile(p):
                try:
                    with open(p, encoding='utf-8', errors='ignore') as f:
                        text = f.read(200).strip().splitlines()[0].strip() if f else ''
                except (OSError, IndexError):
                    text = ''
                for fmt in _DATE_FILE_FORMATS:
                    try:
                        return datetime.strptime(text, fmt)
                    except ValueError:
                        continue
                m = re.search(r'\b(20\d{2})\b', text)
                return datetime(int(m.group(1)), 12, 31) if m else None
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


# the literal pieces every match of the patterns below contains (the cheap tests before them; see classify_severity)
_SEVERITY_TOKENS = ('CRIT', 'FATAL', 'PANIC', 'EMERG', 'ALERT', 'ERR', 'WARN', 'NOTICE', 'INFO', 'DEBUG', 'TRACE')
_SEVERITY_STEMS = ('crit', 'fatal', 'panic', 'emerg', 'err', 'fail', 'segfault', 'oops', 'bug', 'warn', 'deprecated', 'info', 'notice', 'debug', 'trace')


def _level_of_word(word):
    """The level of a word the case-insensitive patterns matched, or None. str.lower() is not the patterns' case
    folding: 'ſegfault' (the long s) and 'İNFO' (the dotted I) match them, lower() leaves 'ſegfault' / 'i̇nfo'; such a
    word is looked up by the pattern itself (the level word it matches case-insensitively)."""
    level = _SEVERITY_BY_WORD.get(word.lower())
    if level is not None:
        return level
    for known, lv in _SEVERITY_BY_WORD.items():
        if re.fullmatch(re.escape(known), word, re.IGNORECASE):
            return lv
    return None


def classify_severity(message):
    """The level a log message states, or 'other' when it states none.

    Each pattern below only runs when the message holds its literal piece: the upper-case tokens as they are (a
    case-sensitive pattern), the field names and the level words lower-cased in an ASCII message (for ASCII text
    exactly what the case-insensitive patterns match; any other message runs every pattern as it always did)."""
    if not message:
        return 'other'
    m = _SEVERITY_PRIORITY_RE.match(message)
    if m:
        # <N> carries facility*8 + level; the level is the low three bits
        return _SEVERITY_BY_PRIORITY.get(int(m.group(1)) & 7, 'other')
    m = _SEVERITY_K8S_RE.match(message)
    if m:
        return _SEVERITY_BY_K8S_CODE.get(m.group(1), 'other')
    ascii_ = message.isascii()
    low = message.lower() if ascii_ else None
    if not ascii_ or 'level=' in low or 'severity=' in low or 'lvl=' in low:
        m = _SEVERITY_FIELD_RE.search(message)
        level = _level_of_word(m.group(1)) if m else None
        if level is not None:
            return level
    for token in _SEVERITY_TOKENS:
        if token in message:
            m = _SEVERITY_TOKEN_RE.search(message)
            if m:
                return _level_of_word(m.group(1)) or 'other'   # an upper-case ASCII token: always a known word
            break
    if ascii_:
        for stem in _SEVERITY_STEMS:
            if stem in low:
                break
        else:
            return 'other'
    # whole words, any case; the strongest level wins when several appear
    found = {_level_of_word(w) for w in _SEVERITY_WORD_RE.findall(message)}
    for level in _SEVERITY_LEVELS:
        if level in found:
            return level
    return 'other'


class LogParser(ABC):
    """Base class for log file parsers"""

    @abstractmethod
    def can_parse(self, filename):
        """Check if this parser can handle the given filename"""
        pass

    @abstractmethod
    def parse_entries(self, filepath, start_date, end_date):
        """Parse log entries within date range"""
        pass

    def parse_entries_streaming(self, filepath, start_date, end_date):
        """Parse log entries and yield one at a time (generator)

        Default implementation calls parse_entries and yields individually.
        Subclasses should override for true line-by-line streaming.
        """
        entries = self.parse_entries(filepath, start_date, end_date)
        for entry in entries:
            yield entry

    @abstractmethod
    def extract_date_range(self, filepath):
        """Extract min/max dates from log file"""
        pass


class JournalctlParser(LogParser):
    """Parser for journalctl logs"""

    def can_parse(self, filename):
        return 'journalctl' in filename.lower()

    def extract_date_range(self, filepath):
        """Fast extraction of date range - only scan start and end of file"""
        min_date = None
        max_date = None
        total_lines = 0
        first_date = None
        last_date = None

        timestamp_pattern = JOURNAL_TS_RE
        self._reference = report_capture_time(filepath)
        current_year = self._reference.year if self._reference else datetime.now().year

        SAMPLE_SIZE = 1000

        try:
            # Get file size
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate total lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)
            else:
                total_lines = 0

            # Read first SAMPLE_SIZE lines to find first timestamp
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= SAMPLE_SIZE:
                        break

                    timestamp_match = timestamp_pattern.match(line)
                    if timestamp_match and first_date is None:
                        timestamp_str = timestamp_match.group(1)
                        try:
                            first_date = self._parse_timestamp(timestamp_str, current_year)
                            break
                        except:
                            pass

            # Read last SAMPLE_SIZE lines to find last timestamp
            with open(filepath, 'rb') as f:
                avg_line_length = 200
                seek_pos = max(0, file_size - (SAMPLE_SIZE * avg_line_length))
                f.seek(seek_pos)
                f.readline()  # Skip partial line
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-SAMPLE_SIZE:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    timestamp_match = timestamp_pattern.match(line)
                    if timestamp_match and last_date is None:
                        timestamp_str = timestamp_match.group(1)
                        try:
                            last_date = self._parse_timestamp(timestamp_str, current_year)
                            break
                        except:
                            pass
                except:
                    pass

            # Determine actual min/max considering year boundary
            if first_date and last_date:
                if last_date < first_date:
                    min_date = first_date.replace(year=current_year - 1)
                    max_date = last_date
                else:
                    min_date = first_date
                    max_date = last_date

        except Exception as e:
            print(f"Failed to extract date range from {filepath}: {e}")
            import traceback
            traceback.print_exc()

        return min_date, max_date, total_lines

    def _parse_timestamp(self, timestamp_str, current_year):
        """A journal timestamp (any output form) as a datetime; the year-less forms take current_year, and a
        line later than the report's capture by more than a month is last year's (parse_journal_ts)."""
        return parse_journal_ts(timestamp_str, current_year, getattr(self, '_reference', None))

    def _find_timestamp_at_position(self, f, position, current_year, timestamp_pattern, debug=False):
        """Seek to position, find next valid timestamp (and the position of its line). `f` is the file in binary;
        lines and their offsets as _text_lines gives them (universal newlines, exact byte offsets)."""
        start = position
        if position > 0:
            # A probe may land in the middle of a line: skip the rest of it.
            # But when it lands exactly on a line START, that line is whole -
            # skipping it used to make the search settle one line too far and
            # lose the first entry of the range.
            f.seek(position - 1)
            prev, cur = f.read(1), f.read(1)
            at_start = prev == b'\n' or (prev == b'\r' and cur != b'\n')
            if not at_start:
                start = None
                for _line, end in _text_lines(f, position):
                    start = end   # the end of the partial line: the next line starts there
                    break
                if start is None:
                    return None, None

        # Read up to 100 lines looking for a timestamp
        pos = start
        for n, (line, end) in enumerate(_text_lines(f, start)):
            if n >= 100:
                break
            line_start, pos = pos, end
            match = timestamp_pattern.match(line)
            if match:
                timestamp_str = match.group(1)
                timestamp_obj = self._parse_timestamp(timestamp_str, current_year)
                if timestamp_obj:
                    if debug:
                        print(f"[JournalctlParser] At position {position:,}, found timestamp: {timestamp_obj}")
                    return timestamp_obj, line_start

        return None, None

    def _binary_search_start(self, filepath, start_date, file_size, current_year, timestamp_pattern):
        """Binary search to find file position where start_date begins

        Returns: (position, found_timestamp_or_None)
        - If found_timestamp is None, it means no entries >= start_date exist
        """
        if not start_date:
            print(f"[JournalctlParser] No start_date, using position 0")
            return 0, None

        left, right = 0, file_size
        result_pos = 0
        result_ts = None
        iterations = 0

        with open(filepath, 'rb') as f:
            while left < right:
                iterations += 1
                mid = (left + right) // 2
                ts, pos = self._find_timestamp_at_position(f, mid, current_year, timestamp_pattern)

                if ts is None:
                    left = mid + 1
                    continue

                # Debug every timestamp during binary search
                if iterations <= 5:  # Only first 5 iterations to avoid spam
                    print(f"[JournalctlParser] Binary search START iteration {iterations}: found timestamp {ts} at pos {pos}, comparing to {start_date}")

                if ts < start_date:
                    left = mid + 1
                else:
                    result_pos = pos
                    result_ts = ts
                    right = mid

        print(f"[JournalctlParser] Binary search START: {iterations} iterations")
        print(f"[JournalctlParser]   Looking for: {start_date}")
        print(f"[JournalctlParser]   Found at position {result_pos:,}: {result_ts}")
        return result_pos, result_ts

    def _binary_search_end(self, filepath, end_date, file_size, current_year, timestamp_pattern):
        """Binary search to find file position where end_date ends

        Returns: (position, found_timestamp_or_None)
        - If found_timestamp is None, it means no entries <= end_date exist
        """
        if not end_date:
            print(f"[JournalctlParser] No end_date, using file end position {file_size:,}")
            return file_size, None

        left, right = 0, file_size
        result_pos = file_size
        result_ts = None
        iterations = 0

        with open(filepath, 'rb') as f:
            while left < right:
                iterations += 1
                mid = (left + right) // 2
                ts, pos = self._find_timestamp_at_position(f, mid, current_year, timestamp_pattern)

                if ts is None:
                    right = mid
                    continue

                if ts <= end_date:
                    left = mid + 1
                else:
                    result_pos = pos
                    result_ts = ts
                    right = mid

        print(f"[JournalctlParser] Binary search END: {iterations} iterations")
        print(f"[JournalctlParser]   Looking for: {end_date}")
        print(f"[JournalctlParser]   Found at position {result_pos:,}: {result_ts}")
        return result_pos, result_ts

    def _read_range(self, filepath, start_date, end_date):
        """The byte range [start_pos, end_pos) of the lines in the date range (the binary search over the file), and
        the context of the parse: (start_pos, end_pos, current_year, reference, use_prev_year); None when no line can
        be in range."""
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
                    return None

                # If end_date provided but no entries <= end_date found, return empty
                # (This means all entries are after end_date)
                if end_date and end_ts is None and start_ts and start_ts > end_date:
                    print(f"[JournalctlParser] No entries found <= end_date, returning 0 results")
                    print(f"[JournalctlParser] Streaming complete: 0 entries")
                    return None

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
            end_pos = os.path.getsize(filepath) if os.path.exists(filepath) else 0

        use_prev_year = bool(start_date and start_date.year < current_year)
        return start_pos, end_pos, current_year, self._reference, use_prev_year

    def parse_entries_streaming(self, filepath, start_date, end_date, workers=1, cancelled=None, info=None,
                                min_bytes=None, chunk_bytes=None):
        """Parse journalctl log entries and yield one at a time: the date range found by binary search, then one pass
        over its lines (_journal_events, _JournalAssembler). workers=1 (the default) reads in this process; with
        workers=None (parallel.default_workers()) or more, a range of at least min_bytes (LOG_PARALLEL_MIN_BYTES) is
        read in worker processes, chunk_bytes (LOG_CHUNK_BYTES) at a time - the same entries in the same order, each
        yielded as soon as its chunk and every chunk before it are done. cancelled / info as in parallel.imap
        (parallel.Cancelled is raised when cancelled)."""
        rng = self._read_range(filepath, start_date, end_date)
        if rng is None:
            return
        start_pos, end_pos, current_year, reference, use_prev_year = rng
        if workers != 1 and end_pos - start_pos >= (LOG_PARALLEL_MIN_BYTES if min_bytes is None else min_bytes):
            from parsers import parallel
            n = parallel.default_workers() if workers is None else max(1, int(workers))
            if n > 1:
                yield from self._parse_parallel(filepath, rng, n, cancelled, info, chunk_bytes or LOG_CHUNK_BYTES)
                return
        print(f"[JournalctlParser] Starting streaming parse...")
        entry_count = 0
        asm = _JournalAssembler()
        # Parse file line-by-line without loading everything into memory
        try:
            with open(filepath, 'rb') as f:
                for event in _journal_events(f, start_pos, end_pos, current_year, reference, use_prev_year, {}):
                    if event[0] == 'error':
                        done = asm.finish()
                        if done is not None:
                            yield done
                            entry_count += 1
                        raise event[1]
                    done = asm.feed(event)
                    if done is not None:
                        yield done
                        entry_count += 1
                # Yield the last entry
                last = asm.finish()
                if last is not None:
                    yield last
                    entry_count += 1
        except Exception as e:
            print(f"[JournalctlParser] Error streaming: {e}")
            import traceback
            traceback.print_exc()

        print(f"[JournalctlParser] Streaming complete: {entry_count:,} entries")

    def _parse_parallel(self, filepath, rng, workers, cancelled, info, chunk_bytes):
        """The range's bytes split at line starts into chunk_bytes ranges, each parsed by journal_chunk in a worker
        (parallel.imap), stitched back in order: a chunk's leading continuation lines belong to the entry still open
        at the end of the chunk before it; the line numbers count on from the range's start."""
        from parsers import parallel
        start_pos, end_pos, current_year, reference, use_prev_year = rng
        bounds = _line_bounds(filepath, start_pos, end_pos, chunk_bytes)
        items = [{'path': filepath, 'start': a, 'end': b, 'year': current_year, 'ref': reference.isoformat() if reference else None,
                  'prev_year': use_prev_year} for a, b in zip(bounds[:-1], bounds[1:])]
        print(f"[JournalctlParser] Parallel parse: {len(items)} chunks, {workers} workers")
        asm = _JournalAssembler()
        base = entry_count = 0
        try:
            for res in parallel.imap(journal_chunk, items, workers=workers, cancelled=cancelled, info=info):
                for done in asm.stitch(res, base):
                    yield done
                    entry_count += 1
                base += res['lines']
                if res['stopped']:
                    break   # the read stops where the one-pass read stops (an entry that could not be built)
            last = asm.finish()
            if last is not None:
                yield last
                entry_count += 1
        except parallel.Cancelled:
            raise
        except Exception as e:
            print(f"[JournalctlParser] Error streaming: {e}")
            import traceback
            traceback.print_exc()
        print(f"[JournalctlParser] Streaming complete: {entry_count:,} entries")

    def parse_entries(self, filepath, start_date, end_date):
        """Parse journalctl log entries within date range using binary search: the streamed parse's entries, as a list
        (this used to be a second copy of the loop, with the read that stopped at a line ending in a bare CR)"""
        return list(self.parse_entries_streaming(filepath, start_date, end_date))


class ContainerLogParser(LogParser):
    """Parser for container logs (Kubernetes/Podman format)"""

    def can_parse(self, filepath):
        filepath_lower = filepath.lower()
        filename = filepath.split('/')[-1]

        # Kubernetes/Podman container logs have specific filename patterns:
        # - /var/log/containers/<pod>_<namespace>_<container>-<id>.log (has underscores)
        # - /var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log
        #
        # OpenStack logs in /var/log/containers/nova/nova-api.log don't have this pattern
        if '/pods/' in filepath_lower:
            return filepath.endswith('.log')
        elif '/containers/' in filepath_lower:
            # Only match if filename has underscores (Kubernetes pattern)
            # This excludes OpenStack logs like /var/log/containers/nova/nova-api.log
            return filepath.endswith('.log') and '_' in filename
        return False

    def extract_date_range(self, filepath):
        """Extract date range from container log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern: 2025-11-07T09:25:56.458247673+00:00 stderr F ...
        container_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2})\s')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = container_pattern.match(line)
                    if match and min_date is None:
                        timestamp_str = match.group(1)
                        # Convert to timezone-naive UTC for consistency with other parsers
                        min_date = datetime.fromisoformat(timestamp_str).replace(tzinfo=None)
                        break

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    match = container_pattern.match(line)
                    if match and max_date is None:
                        timestamp_str = match.group(1)
                        # Convert to timezone-naive UTC for consistency with other parsers
                        max_date = datetime.fromisoformat(timestamp_str).replace(tzinfo=None)
                        break
                except Exception as parse_err:
                    pass

        except Exception as e:
            print(f"Failed to extract date range from container log {filepath}: {e}")
            import traceback
            traceback.print_exc()

        return min_date, max_date, total_lines

    def parse_entries(self, filepath, start_date, end_date):
        """Parse container log entries within date range"""
        entries = []

        # Pattern: TIMESTAMP STREAM FLAGS MESSAGE
        # Example: 2025-11-07T09:25:56.458247673+00:00 stderr F 2025-11-07T09:25:56.458200Z ERROR ...
        container_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2})\s+(stdout|stderr)\s+([FP])\s+(.*)$')

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"Failed to read {filepath}: {e}")
            return entries

        # Extract pod and container names from filepath
        # Kubernetes format: /var/log/containers/<pod-name>_<namespace>_<container-name>-<container-id>.log
        # Example (synthetic): web-5d8f7c9b4-abcde_default_web-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.log

        pod_name = ''
        container_name = ''

        filename = filepath.split('/')[-1].replace('.log', '')

        if '/pods/' in filepath:
            # For /var/log/pods/namespace_podname_uid/container/0.log
            parts = filepath.split('/')
            if len(parts) >= 2:
                container_name = parts[-2]
                # Try to extract pod from parent directory
                if len(parts) >= 3:
                    parent = parts[-3]
                    # Format: namespace_podname_uid
                    pod_parts = parent.split('_')
                    if len(pod_parts) >= 2:
                        pod_name = pod_parts[1]  # podname
        else:
            # For /var/log/containers/<pod>_<namespace>_<container>-<id>.log
            # Split by underscore to get: [pod_name, namespace, container-id]
            parts = filename.split('_')
            if len(parts) >= 3:
                pod_name = parts[0]
                # Third part is container-hash, extract just container name before the hash
                container_part = parts[2]
                # Remove the container ID (long hex hash after last dash)
                # Format: containername-<64-char-hex-id>
                dash_parts = container_part.split('-')
                if len(dash_parts) >= 2:
                    # Check if last part is a long hex string (container ID)
                    if len(dash_parts[-1]) > 40 and all(c in '0123456789abcdef' for c in dash_parts[-1]):
                        # Remove the hash, keep everything before it
                        container_name = '-'.join(dash_parts[:-1])
                    else:
                        container_name = container_part
                else:
                    container_name = container_part
            else:
                # Fallback: use filename as-is
                container_name = filename

        for line_num, line in enumerate(lines, 1):
            # Sanitize line to remove non-printable characters
            line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

            match = container_pattern.match(line.strip())
            if not match:
                continue

            try:
                timestamp_str_full = match.group(1)
                stream = match.group(2)  # stdout or stderr
                flags = match.group(3)   # F (full) or P (partial)
                message = match.group(4)

                # Convert to timezone-naive UTC for consistency with other parsers
                timestamp_obj = datetime.fromisoformat(timestamp_str_full).replace(tzinfo=None)
            except Exception as e:
                # Skip malformed lines
                continue

            # Check date range
            if start_date and timestamp_obj < start_date:
                continue
            if end_date and timestamp_obj > end_date:
                continue

            # the level the message states (classify_severity: the same rules for every parser)
            severity = classify_severity(message)

            # Format timestamp to match other parsers
            timestamp_str = timestamp_obj.strftime("%b %d %H:%M:%S")

            entry = {
                'line_number': line_num,
                'timestamp': timestamp_str,
                'timestamp_obj': timestamp_obj.isoformat(),
                'hostname': pod_name,
                'process': f"{container_name}[{stream}]",
                'pid': '',
                'severity': severity,
                'message': message,
                'issues': []
            }

            entries.append(entry)

        return entries


class OVSLogParser(LogParser):
    """Parser for OpenVSwitch logs"""

    def can_parse(self, filepath):
        # Check for both directory name and OVS-specific filenames (including rotated logs)
        filepath_lower = filepath.lower()
        filename = filepath_lower.split('/')[-1]
        return ('openvswitch' in filepath_lower or
                'ovs-vswitchd.log' in filename or
                'ovsdb-server.log' in filename)

    def extract_date_range(self, filepath):
        """Extract date range from OVS log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern: 2026-05-25T07:25:30.022Z|...
        ovs_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z?\|')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = ovs_pattern.match(line)
                    if match and min_date is None:
                        timestamp_str = match.group(1)
                        # Parse ISO timestamp: 2026-05-25T07:25:30.022
                        min_date = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S.%f")
                        break

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    match = ovs_pattern.match(line)
                    if match and max_date is None:
                        timestamp_str = match.group(1)
                        max_date = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S.%f")
                        break
                except Exception as parse_err:
                    pass

        except Exception as e:
            print(f"Failed to extract date range from OVS log {filepath}: {e}")
            import traceback
            traceback.print_exc()

        return min_date, max_date, total_lines

    def parse_entries(self, filepath, start_date, end_date):
        """Parse OVS log entries within date range"""
        entries = []

        # Pattern: TIMESTAMP|SEQUENCE|MODULE|LEVEL|MESSAGE
        ovs_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z?\|(\d+)\|([^|]+)\|([^|]+)\|(.*)$')

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"Failed to read {filepath}: {e}")
            return entries

        for line_num, line in enumerate(lines, 1):
            # Sanitize line to remove non-printable characters
            line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

            match = ovs_pattern.match(line.strip())
            if not match:
                continue

            timestamp_str_full = match.group(1)
            sequence = match.group(2)
            module = match.group(3)
            level = match.group(4)
            message = match.group(5)

            # Parse timestamp: 2026-05-25T07:25:30.022
            timestamp_obj = datetime.strptime(timestamp_str_full, "%Y-%m-%dT%H:%M:%S.%f")

            # Check date range
            if start_date and timestamp_obj < start_date:
                continue
            if end_date and timestamp_obj > end_date:
                continue

            # Map OVS levels to standard severity
            level_mapping = {
                'EMER': 'critical',
                'ERR': 'error',
                'WARN': 'warning',
                'INFO': 'info',
                'DBG': 'debug'
            }
            severity = level_mapping.get(level.upper(), 'other')

            # Format timestamp to match other parsers
            timestamp_str = timestamp_obj.strftime("%b %d %H:%M:%S")

            # Extract process name from filepath
            process = filepath.split('/')[-1].replace('.log', '')

            entry = {
                'line_number': line_num,
                'timestamp': timestamp_str,
                'timestamp_obj': timestamp_obj.isoformat(),
                'hostname': '',
                'process': f"{process}[{module}]",
                'pid': sequence,
                'severity': severity,
                'message': message,
                'issues': []
            }

            entries.append(entry)

        return entries


class AuditLogParser(LogParser):
    """Parser for audit.log files"""

    def can_parse(self, filename):
        return 'audit.log' in filename.lower()

    def extract_date_range(self, filepath):
        """Extract date range from audit log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern: type=TYPE msg=audit(TIMESTAMP.MILLISECONDS:SEQUENCE)
        audit_pattern = re.compile(r'msg=audit\((\d+)\.\d+:\d+\)')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = audit_pattern.search(line)
                    if match and min_date is None:
                        timestamp = int(match.group(1))
                        min_date = datetime.fromtimestamp(timestamp)
                        break

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    match = audit_pattern.search(line)
                    if match and max_date is None:
                        timestamp = int(match.group(1))
                        max_date = datetime.fromtimestamp(timestamp)
                        break
                except:
                    pass

        except Exception as e:
            print(f"Failed to extract date range from audit log {filepath}: {e}")
            import traceback
            traceback.print_exc()

        return min_date, max_date, total_lines

    def parse_entries(self, filepath, start_date, end_date):
        """Parse audit log entries within date range"""
        entries = []

        audit_pattern = re.compile(r'type=(\S+)\s+msg=audit\((\d+)\.\d+:\d+\):\s*(.*)')

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"Failed to read {filepath}: {e}")
            return entries

        def decode_hex_if_needed(value):
            """Decode hex-encoded strings commonly found in audit logs"""
            if not value:
                return value
            # Check if the value looks like hex (all hex chars, even length)
            if len(value) > 10 and len(value) % 2 == 0 and all(c in '0123456789ABCDEFabcdef' for c in value):
                try:
                    decoded = bytes.fromhex(value).decode('utf-8', errors='ignore')
                    # Filter to only printable ASCII and common whitespace
                    # Remove control characters and non-ASCII that might render as weird symbols
                    filtered = ''.join(c for c in decoded if c.isprintable() or c in '\n\t ')
                    # Only return decoded if it has substantial printable content
                    if filtered and len(filtered) > 5 and any(c.isalnum() for c in filtered):
                        return filtered
                except:
                    pass
            return value

        for line_num, line in enumerate(lines, 1):
            # Sanitize line to remove non-printable characters that might render as symbols
            line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

            match = audit_pattern.match(line.strip())
            if not match:
                continue

            audit_type = match.group(1)
            timestamp = int(match.group(2))
            message_part = match.group(3)

            timestamp_obj = datetime.fromtimestamp(timestamp)

            # Check date range
            if start_date and timestamp_obj < start_date:
                continue
            if end_date and timestamp_obj > end_date:
                continue

            # Extract key-value pairs
            kv_pattern = re.compile(r'(\w+)=(?:"([^"]*)"|(\S+))')
            fields = {}
            for kv_match in kv_pattern.finditer(message_part):
                key = kv_match.group(1)
                value = kv_match.group(2) if kv_match.group(2) else kv_match.group(3)

                # Decode hex-encoded fields (common in cmd, proctitle, etc.)
                if key in ['cmd', 'proctitle', 'path']:
                    value = decode_hex_if_needed(value)

                fields[key] = value

            # Build structured entry
            hostname = fields.get('hostname', '')
            process = fields.get('exe', '').split('/')[-1] if 'exe' in fields else audit_type
            pid = fields.get('pid', '')

            # Determine severity based on audit type
            severity = 'info'
            if any(x in audit_type for x in ['ANOM', 'ERROR', 'DENIED', 'FAILED']):
                severity = 'error'
            elif any(x in audit_type for x in ['USER_AUTH', 'USER_LOGIN', 'CRED_']):
                severity = 'warning'

            timestamp_str = timestamp_obj.strftime("%b %d %H:%M:%S")

            # Build a more readable message
            # Include decoded cmd if present
            if 'cmd' in fields:
                message_display = f"[{audit_type}] cmd: {fields['cmd']}"
            elif 'proctitle' in fields:
                message_display = f"[{audit_type}] {fields['proctitle']}"
            else:
                message_display = f"[{audit_type}] {message_part}"

            entry = {
                'line_number': line_num,
                'timestamp': timestamp_str,
                'timestamp_obj': timestamp_obj.isoformat(),
                'hostname': hostname,
                'process': process,
                'pid': pid,
                'severity': severity,
                'message': message_display,
                'issues': [],
                'audit_fields': fields  # Store all fields for detailed view
            }

            entries.append(entry)

        return entries


class OpenStackLogParser(LogParser):
    """Parser for OpenStack service logs"""

    def can_parse(self, filepath):
        filepath_lower = filepath.lower()
        # Check for OpenStack service names in path
        openstack_services = [
            'nova', 'neutron', 'cinder', 'glance', 'keystone', 'heat',
            'swift', 'horizon', 'placement', 'octavia', 'manila', 'barbican',
            'designate', 'trove', 'ironic', 'magnum', 'mistral', 'murano',
            'sahara', 'zaqar', 'aodh', 'ceilometer', 'gnocchi', 'panko'
        ]
        return any(service in filepath_lower for service in openstack_services)

    def extract_date_range(self, filepath):
        """Extract date range from OpenStack log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern: 2026-04-02 00:00:56.077 7 INFO nova.compute.manager ...
        openstack_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = openstack_pattern.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            min_date = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S.%f")
                            print(f"[OpenStackParser] Found min_date: {min_date}")
                            break
                        except Exception as e:
                            print(f"[OpenStackParser] Failed to parse timestamp '{timestamp_str}': {e}")

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    match = openstack_pattern.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            max_date = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S.%f")
                            print(f"[OpenStackParser] Found max_date: {max_date}")
                            break
                        except Exception as e:
                            print(f"[OpenStackParser] Failed to parse max timestamp '{timestamp_str}': {e}")
                except Exception as e:
                    continue

        except Exception as e:
            print(f"[OpenStackParser] Failed to extract date range from {filepath}: {e}")
            import traceback
            traceback.print_exc()

        if not min_date or not max_date:
            print(f"[OpenStackParser] WARNING: Could not extract dates from {filepath} (min={min_date}, max={max_date})")

        return min_date, max_date, total_lines

    def parse_entries_streaming(self, filepath, start_date, end_date):
        """Parse OpenStack log entries and yield one at a time"""
        # Pattern: 2026-04-02 00:00:56.077 7 INFO nova.compute.manager [req-id ...] message
        openstack_pattern = re.compile(
            r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+'  # timestamp
            r'(\d+)\s+'  # PID
            r'(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+'  # level
            r'([^\s\[]+)\s*'  # module/logger
            r'(\[.*?\])?\s*'  # optional request context
            r'(.*)$'  # message
        )

        severity_mapping = {
            'CRITICAL': 'critical',
            'ERROR': 'error',
            'WARNING': 'warning',
            'INFO': 'info',
            'DEBUG': 'debug'
        }

        print(f"[OpenStackParser] Starting streaming parse...")
        entry_count = 0

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                line_num = 0
                current_entry = None

                for line in f:
                    line_num += 1

                    if line_num % 100000 == 0:
                        print(f"[OpenStackParser] Streamed {entry_count:,} entries so far...")

                    # Sanitize line
                    line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

                    match = openstack_pattern.match(line)

                    if match:
                        # Yield previous entry if exists
                        if current_entry:
                            yield current_entry
                            entry_count += 1

                        timestamp_str = match.group(1)
                        pid = match.group(2)
                        level = match.group(3)
                        module = match.group(4)
                        request_context = match.group(5) or ''
                        message = match.group(6)

                        try:
                            timestamp_obj = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S.%f")
                        except:
                            current_entry = None
                            continue

                        # Check date range
                        if start_date and timestamp_obj < start_date:
                            current_entry = None
                            continue
                        if end_date and timestamp_obj > end_date:
                            current_entry = None
                            continue

                        severity = severity_mapping.get(level, 'other')

                        # Format timestamp for display
                        display_timestamp = timestamp_obj.strftime("%b %d %H:%M:%S")

                        current_entry = {
                            'line_number': line_num,
                            'timestamp': display_timestamp,
                            'timestamp_obj': timestamp_obj.isoformat(),
                            'hostname': '',
                            'process': module,  # Module/logger name (e.g., nova.compute.manager)
                            'pid': pid,
                            'severity': severity,
                            'message': f"{request_context} {message}".strip(),
                            'issues': []
                        }
                    else:
                        # Continuation line
                        if current_entry:
                            current_entry['message'] += '\n' + line.strip()

                # Yield last entry
                if current_entry:
                    yield current_entry
                    entry_count += 1

        except Exception as e:
            print(f"[OpenStackParser] Error streaming: {e}")
            import traceback
            traceback.print_exc()

        print(f"[OpenStackParser] Streaming complete: {entry_count:,} entries")

    def parse_entries(self, filepath, start_date, end_date):
        """Parse OpenStack log entries within date range"""
        entries = []
        for entry in self.parse_entries_streaming(filepath, start_date, end_date):
            entries.append(entry)
        return entries


class DnfLogParser(LogParser):
    """Parser for DNF/YUM logs"""

    def can_parse(self, filepath):
        filepath_lower = filepath.lower()
        return 'dnf' in filepath_lower or 'yum' in filepath_lower

    def extract_date_range(self, filepath):
        """Extract date range from DNF log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern: 2026-03-06T13:20:33-0800 INFO ...
        dnf_pattern = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})\s')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = dnf_pattern.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            # Parse with timezone, then convert to naive UTC
                            min_date = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S%z").replace(tzinfo=None)
                            print(f"[DnfParser] Found min_date: {min_date}")
                            break
                        except Exception as e:
                            print(f"[DnfParser] Failed to parse timestamp '{timestamp_str}': {e}")

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                    match = dnf_pattern.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            max_date = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S%z").replace(tzinfo=None)
                            print(f"[DnfParser] Found max_date: {max_date}")
                            break
                        except Exception as e:
                            print(f"[DnfParser] Failed to parse max timestamp '{timestamp_str}': {e}")
                except Exception as e:
                    continue

        except Exception as e:
            print(f"[DnfParser] Failed to extract date range from {filepath}: {e}")
            import traceback
            traceback.print_exc()

        if not min_date or not max_date:
            print(f"[DnfParser] WARNING: Could not extract dates from {filepath} (min={min_date}, max={max_date})")

        return min_date, max_date, total_lines

    def parse_entries_streaming(self, filepath, start_date, end_date):
        """Parse DNF log entries and yield one at a time"""
        # Pattern: 2026-03-06T13:20:33-0800 INFO message
        dnf_pattern = re.compile(
            r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})\s+'  # timestamp with timezone
            r'(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+'  # level
            r'(.*)$'  # message
        )

        severity_mapping = {
            'CRITICAL': 'critical',
            'ERROR': 'error',
            'WARNING': 'warning',
            'INFO': 'info',
            'DEBUG': 'debug'
        }

        print(f"[DnfParser] Starting streaming parse...")
        entry_count = 0

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                line_num = 0

                for line in f:
                    line_num += 1

                    if line_num % 100000 == 0:
                        print(f"[DnfParser] Streamed {entry_count:,} entries so far...")

                    # Sanitize line
                    line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

                    match = dnf_pattern.match(line.strip())
                    if not match:
                        continue

                    timestamp_str = match.group(1)
                    level = match.group(2)
                    message = match.group(3)

                    try:
                        # Parse with timezone, then convert to naive UTC
                        timestamp_obj = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S%z").replace(tzinfo=None)
                    except:
                        continue

                    # Check date range
                    if start_date and timestamp_obj < start_date:
                        continue
                    if end_date and timestamp_obj > end_date:
                        continue

                    severity = severity_mapping.get(level, 'other')

                    # Format timestamp for display
                    display_timestamp = timestamp_obj.strftime("%b %d %H:%M:%S")

                    entry = {
                        'line_number': line_num,
                        'timestamp': display_timestamp,
                        'timestamp_obj': timestamp_obj.isoformat(),
                        'hostname': '',
                        'process': 'dnf',
                        'pid': '',
                        'severity': severity,
                        'message': message,
                        'issues': []
                    }

                    yield entry
                    entry_count += 1

        except Exception as e:
            print(f"[DnfParser] Error streaming: {e}")
            import traceback
            traceback.print_exc()

        print(f"[DnfParser] Streaming complete: {entry_count:,} entries")

    def parse_entries(self, filepath, start_date, end_date):
        """Parse DNF log entries within date range"""
        entries = []
        for entry in self.parse_entries_streaming(filepath, start_date, end_date):
            entries.append(entry)
        return entries


class RhsmLogParser(LogParser):
    """Parser for RHSM (Red Hat Subscription Manager) logs"""

    def can_parse(self, filepath):
        filepath_lower = filepath.lower()
        return 'rhsm' in filepath_lower

    def extract_date_range(self, filepath):
        """Extract date range from RHSM log"""
        min_date = None
        max_date = None
        total_lines = 0

        # Pattern 1: 2026-05-26 14:57:01,327 [ERROR] ...
        rhsm_pattern1 = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+)\s')
        # Pattern 2: Wed May 27 06:57:01 2026 [WARN] ...
        rhsm_pattern2 = re.compile(r'^(\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s')

        try:
            with open(filepath, 'rb') as f:
                f.seek(0, 2)
                file_size = f.tell()

            # Estimate lines
            sample_bytes = min(10000, file_size)
            with open(filepath, 'rb') as f:
                sample = f.read(sample_bytes)
                sample_lines = sample.count(b'\n')

            if sample_lines > 0:
                avg_line_length = sample_bytes / sample_lines
                total_lines = int(file_size / avg_line_length)

            # Read first 1000 lines
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f):
                    if i >= 1000:
                        break

                    match = rhsm_pattern1.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            min_date = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S,%f")
                            print(f"[RhsmParser] Found min_date (format 1): {min_date}")
                            break
                        except Exception as e:
                            print(f"[RhsmParser] Failed to parse timestamp '{timestamp_str}': {e}")

                    match = rhsm_pattern2.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            min_date = datetime.strptime(timestamp_str, "%a %b %d %H:%M:%S %Y")
                            print(f"[RhsmParser] Found min_date (format 2): {min_date}")
                            break
                        except Exception as e:
                            print(f"[RhsmParser] Failed to parse timestamp '{timestamp_str}': {e}")

            # Read last 1000 lines
            with open(filepath, 'rb') as f:
                seek_pos = max(0, file_size - 200000)
                f.seek(seek_pos)
                f.readline()
                tail_lines = f.readlines()

            for line_bytes in reversed(tail_lines[-1000:]):
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')

                    match = rhsm_pattern1.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            max_date = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S,%f")
                            print(f"[RhsmParser] Found max_date (format 1): {max_date}")
                            break
                        except Exception as e:
                            print(f"[RhsmParser] Failed to parse max timestamp '{timestamp_str}': {e}")

                    match = rhsm_pattern2.match(line)
                    if match:
                        timestamp_str = match.group(1)
                        try:
                            max_date = datetime.strptime(timestamp_str, "%a %b %d %H:%M:%S %Y")
                            print(f"[RhsmParser] Found max_date (format 2): {max_date}")
                            break
                        except Exception as e:
                            print(f"[RhsmParser] Failed to parse max timestamp '{timestamp_str}': {e}")
                except Exception as e:
                    continue

        except Exception as e:
            print(f"[RhsmParser] Failed to extract date range from {filepath}: {e}")
            import traceback
            traceback.print_exc()

        if not min_date or not max_date:
            print(f"[RhsmParser] WARNING: Could not extract dates from {filepath} (min={min_date}, max={max_date})")

        return min_date, max_date, total_lines

    def parse_entries_streaming(self, filepath, start_date, end_date):
        """Parse RHSM log entries and yield one at a time"""
        # Pattern 1: 2026-05-26 14:57:01,327 [ERROR] rhsmcertd-worker:16084:MainThread @rhsmcertd_worker.py:193 - message
        rhsm_pattern1 = re.compile(
            r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+)\s+'  # timestamp with milliseconds
            r'\[(\w+)\]\s+'  # severity in brackets
            r'([^:]+)'  # process name
            r'(?::(\d+))?'  # optional PID
            r'(?::([^@]+))?'  # optional thread name
            r'(?:@([^-]+))?'  # optional source file
            r'\s*-?\s*(.*)$'  # message
        )

        # Pattern 2: Wed May 27 06:57:01 2026 [WARN] (Cert Check) message
        rhsm_pattern2 = re.compile(
            r'^(\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+'  # timestamp
            r'\[(\w+)\]\s+'  # severity in brackets
            r'(?:\(([^)]+)\)\s+)?'  # optional component in parentheses
            r'(.*)$'  # message
        )

        severity_mapping = {
            'CRITICAL': 'critical',
            'ERROR': 'error',
            'WARNING': 'warning',
            'WARN': 'warning',
            'INFO': 'info',
            'DEBUG': 'debug'
        }

        print(f"[RhsmParser] Starting streaming parse...")
        entry_count = 0

        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                line_num = 0
                current_entry = None

                for line in f:
                    line_num += 1

                    if line_num % 100000 == 0:
                        print(f"[RhsmParser] Streamed {entry_count:,} entries so far...")

                    # Sanitize line
                    line = ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)

                    # Try format 1
                    match = rhsm_pattern1.match(line.strip())
                    if match:
                        # Yield previous entry if exists
                        if current_entry:
                            yield current_entry
                            entry_count += 1

                        timestamp_str = match.group(1)
                        level = match.group(2)
                        process = match.group(3)
                        pid = match.group(4) or ''
                        thread = match.group(5) or ''
                        source = match.group(6) or ''
                        message = match.group(7)

                        try:
                            timestamp_obj = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S,%f")
                        except:
                            continue

                        # Check date range
                        if start_date and timestamp_obj < start_date:
                            current_entry = None
                            continue
                        if end_date and timestamp_obj > end_date:
                            current_entry = None
                            continue

                        severity = severity_mapping.get(level, 'other')

                        # Format timestamp for display
                        display_timestamp = timestamp_obj.strftime("%b %d %H:%M:%S")

                        current_entry = {
                            'line_number': line_num,
                            'timestamp': display_timestamp,
                            'timestamp_obj': timestamp_obj.isoformat(),
                            'hostname': '',
                            'process': process.strip(),
                            'pid': pid,
                            'severity': severity,
                            'message': message.strip(),
                            'issues': []
                        }
                        continue

                    # Try format 2
                    match = rhsm_pattern2.match(line.strip())
                    if match:
                        # Yield previous entry if exists
                        if current_entry:
                            yield current_entry
                            entry_count += 1

                        timestamp_str = match.group(1)
                        level = match.group(2)
                        component = match.group(3) or 'rhsmcertd'
                        message = match.group(4)

                        try:
                            timestamp_obj = datetime.strptime(timestamp_str, "%a %b %d %H:%M:%S %Y")
                        except:
                            continue

                        # Check date range
                        if start_date and timestamp_obj < start_date:
                            current_entry = None
                            continue
                        if end_date and timestamp_obj > end_date:
                            current_entry = None
                            continue

                        severity = severity_mapping.get(level, 'other')

                        # Format timestamp for display
                        display_timestamp = timestamp_obj.strftime("%b %d %H:%M:%S")

                        current_entry = {
                            'line_number': line_num,
                            'timestamp': display_timestamp,
                            'timestamp_obj': timestamp_obj.isoformat(),
                            'hostname': '',
                            'process': component.strip(),
                            'pid': '',
                            'severity': severity,
                            'message': message.strip(),
                            'issues': []
                        }
                        continue

                    # If no match and we have a current entry, it's a multi-line continuation
                    if current_entry:
                        current_entry['message'] += '\n' + line.strip()

                # Yield final entry
                if current_entry:
                    yield current_entry
                    entry_count += 1

        except Exception as e:
            print(f"[RhsmParser] Error streaming: {e}")
            import traceback
            traceback.print_exc()

        print(f"[RhsmParser] Streaming complete: {entry_count:,} entries")

    def parse_entries(self, filepath, start_date, end_date):
        """Parse RHSM log entries within date range"""
        entries = []
        for entry in self.parse_entries_streaming(filepath, start_date, end_date):
            entries.append(entry)
        return entries


# Parser registry
PARSERS = [
    ContainerLogParser(),
    OVSLogParser(),
    AuditLogParser(),
    OpenStackLogParser(),
    DnfLogParser(),
    RhsmLogParser(),
    JournalctlParser(),
]


def get_parser_for_file(filepath):
    """Get appropriate parser for a log file based on path/filename"""
    for parser in PARSERS:
        if parser.can_parse(filepath):
            return parser
    # Default to journalctl parser for unknown types
    return JournalctlParser()


# ---- the journal parse: one pass, shared by the serial stream and the parallel chunks ---------------------------
#
# _journal_events(f, start_pos, end_pos, ...) reads the lines that start in [start_pos, end_pos) of a text-mode file
# (utf-8, errors ignored, universal newlines - exactly as the Log Viewer always read them) and yields, per line:
#   ('new', entry)       a line with a timestamp that parses: a new entry (its line_number counted from start_pos)
#   ('bad',)             a line with a timestamp that does not: the open entry ends, no new one starts
#   ('cont', text, [issues])  any other line: a continuation of the open entry (if any)
#   ('error', exception) building a timestamped line's entry failed: the open entry ends and the read stops there
#                        (a safety net: classify_severity no longer raises on any text)
# _JournalAssembler turns them into complete entries (an entry is complete when the next 'new' or 'bad' comes). The
# costs are the line's, not the rules': a line that is printable throughout skips the per-character sanitize (which
# would leave it as it is), a line that holds none of the issue patterns' literal words skips the seven patterns (a
# match of any pattern holds one of them), a timestamp seen before is not parsed again.

_ISSUE_PATTERNS = (
    ('kernel_panic', re.compile(r'kernel panic', re.IGNORECASE)),
    ('oom_killer', re.compile(r'out of memory|oom[-_]killer|killed process', re.IGNORECASE)),
    ('segfault', re.compile(r'segfault|segmentation fault', re.IGNORECASE)),
    ('disk_error', re.compile(r'i/o error|disk.*error|blk.*error', re.IGNORECASE)),
    ('network_error', re.compile(r'network.*unreachable|connection.*refused|timeout', re.IGNORECASE)),
    ('service_failed', re.compile(r'failed to start|service.*failed', re.IGNORECASE)),
    ('authentication_failure', re.compile(r'authentication failure|failed password', re.IGNORECASE)),
)
# every match of a pattern above contains one of these (the same case-insensitive matching): a non-ASCII line without
# any of them has no issue (an ASCII line is checked with str.find, faster than either)
_ISSUE_WORDS = re.compile(r'panic|memory|oom|killed process|seg|error|unreachable|refused|timeout|failed|failure|password', re.IGNORECASE)
LOG_CHUNK_BYTES = 4 << 20          # a parallel read's byte range
LOG_FIRST_CHUNK_BYTES = 512 << 10  # ... the first one smaller (then doubling): the first rows arrive at once
LOG_PARALLEL_MIN_BYTES = 8 << 20   # below this many bytes to read, a log is read serially (a pool costs ~0.1-0.5 s)
_TS_MEMO_MAX = 200000


def _after(l, first, then):
    """`first.*then` in a lower-cased line without an inner newline: `then` somewhere after the first `first`."""
    i = l.find(first)
    return i >= 0 and l.find(then, i + len(first)) >= 0


def _issues_of(line):
    """The issue tags of a line, in _ISSUE_PATTERNS order. An ASCII line (the usual one) is matched with str.lower()
    and str.find - for ASCII text exactly what the case-insensitive patterns match (a sanitized line holds a newline
    only at its end, so `a.*b` is `b` after the first `a`); any other line goes through the patterns themselves (their
    Unicode case folding, e.g. the long s, is not str.lower())."""
    if not line.isascii():
        if not _ISSUE_WORDS.search(line):
            return []
        return [name for name, pattern in _ISSUE_PATTERNS if pattern.search(line)]
    l = line.lower()
    out = []
    if 'kernel panic' in l:
        out.append('kernel_panic')
    if 'out of memory' in l or 'oom-killer' in l or 'oom_killer' in l or 'killed process' in l:
        out.append('oom_killer')
    if 'segfault' in l or 'segmentation fault' in l:
        out.append('segfault')
    if 'i/o error' in l or _after(l, 'disk', 'error') or _after(l, 'blk', 'error'):
        out.append('disk_error')
    if _after(l, 'network', 'unreachable') or _after(l, 'connection', 'refused') or 'timeout' in l:
        out.append('network_error')
    if 'failed to start' in l or _after(l, 'service', 'failed'):
        out.append('service_failed')
    if 'authentication failure' in l or 'failed password' in l:
        out.append('authentication_failure')
    return out


def _sanitize(line):
    """Every non-printable character but newline and tab as a space (a printable line is returned as it is)."""
    body = line[:-1] if line.endswith('\n') else line
    if body.isprintable():
        return line
    return ''.join(c if c.isprintable() or c in '\n\t ' else ' ' for c in line)


def _split_cr(raw):
    """A binary line (ending in a newline or at the end of the file) cut at its bare CRs: the pieces, each ending in
    its own terminator (CR, CRLF, LF) - universal newlines, as a text-mode file splits it."""
    out, i, n = [], 0, len(raw)
    while i < n:
        j = raw.find(b'\r', i)
        if j < 0:
            out.append(raw[i:])
            break
        if raw[j + 1:j + 2] == b'\n':
            out.append(raw[i:j + 2])
            i = j + 2
        else:
            out.append(raw[i:j + 1])
            i = j + 1
    return out


def _text_lines(f, start_pos, end_pos=None):
    """(line, offset after it) for each line that STARTS in [start_pos, end_pos) of a file opened in binary: universal
    newlines (LF, CRLF and a bare CR end a line, each given as '\n'), UTF-8 with undecodable bytes dropped - what a
    text-mode file gives, with exact byte offsets (a text-mode tell() after a line ending in a bare CR carries the
    newline decoder's state above bit 64: a read that compared it with an offset stopped there)."""
    f.seek(start_pos)
    pos = start_pos
    for raw in f:
        for piece in (_split_cr(raw) if b'\r' in raw else (raw,)):
            if end_pos is not None and pos >= end_pos:
                return
            pos += len(piece)
            text = piece.decode('utf-8', 'ignore')
            if text.endswith('\r\n'):
                text = text[:-2] + '\n'
            elif text.endswith('\r'):
                text = text[:-1] + '\n'
            yield text, pos


def _journal_events(f, start_pos, end_pos, current_year, reference, use_prev_year, memo):
    """See the block comment above. `f` is the file opened in binary (_text_lines)."""
    line_num = 0
    match_ts, match_full = JOURNAL_TS_RE.match, JOURNAL_LINE_RE.match
    for line, _end in _text_lines(f, start_pos, end_pos):
        line_num += 1
        line = _sanitize(line)
        timestamp_match = match_ts(line)
        if timestamp_match:
            timestamp_str = timestamp_match.group(1)
            hit = memo.get(timestamp_str)
            if hit is None:
                try:
                    obj = parse_journal_ts(timestamp_str, current_year, reference)
                except Exception:  # noqa: BLE001 - as before: a timestamp that does not parse ends the entry
                    obj = None
                if len(memo) >= _TS_MEMO_MAX:
                    memo.clear()
                hit = memo[timestamp_str] = (obj, obj.isoformat() if obj is not None else None)
            timestamp_obj, iso = hit
            if timestamp_obj is None:
                yield ('bad',)
                continue
            if use_prev_year:
                try:
                    if timestamp_obj > datetime.now():
                        timestamp_obj = timestamp_obj.replace(year=timestamp_obj.year - 1)
                        iso = timestamp_obj.isoformat()
                except Exception:  # noqa: BLE001 - as before (29 February of a year without one)
                    yield ('bad',)
                    continue
            full_match = match_full(line)
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
            try:
                entry = {
                    'line_number': line_num,
                    'timestamp': timestamp_str,
                    'timestamp_obj': iso,
                    'hostname': hostname,
                    'process': process,
                    'pid': pid,
                    # the level the message states (classify_severity: the same rules for every parser)
                    'severity': classify_severity(message),
                    'message': message,
                    'issues': _issues_of(line),
                }
            except Exception as e:  # noqa: BLE001 - see 'error' above: the read ends here
                yield ('error', e)
                yield ('lines', line_num)
                return
            yield ('new', entry)
        else:
            yield ('cont', line.strip(), _issues_of(line))
    yield ('lines', line_num)


class _JournalAssembler:
    """Events (_journal_events) to complete entries, in order. feed() for one pass; stitch() for a parallel chunk's
    summary (journal_chunk) after the chunks before it."""

    def __init__(self):
        self.current = None

    def feed(self, event):
        """The entry this event completes, or None."""
        kind = event[0]
        if kind == 'cont':
            cur = self.current
            if cur is not None:
                cur['message'] += '\n' + event[1]
                for issue in event[2]:
                    if issue not in cur['issues']:
                        cur['issues'].append(issue)
            return None
        if kind == 'lines':
            return None
        done = self.current
        self.current = event[1] if kind == 'new' else None
        return done

    def finish(self):
        done, self.current = self.current, None
        return done

    def stitch(self, res, base):
        """The entries a chunk completes: the open entry from before it (with the chunk's leading continuations)
        when the chunk starts a new one, then the chunk's own complete entries (line numbers from `base`)."""
        out = []
        for event in res['lead']:
            self.feed(event)
        if res['closed']:
            if self.current is not None:
                out.append(self.current)
            for e in res['entries']:
                e['line_number'] += base
                out.append(e)
            opened = res['open']
            if opened is not None:
                opened['line_number'] += base
            self.current = opened
        return out


def journal_chunk(item):
    """One byte range of a journal (a work item of the parallel read, run in a worker process): {'lead': the
    continuation events before its first timestamped line, 'closed': whether it has one, 'entries': its complete
    entries, 'open': the entry still open at its end (or None), 'lines': its line count, 'stopped': building an entry
    failed and the read ends there, as the one-pass read does} - line numbers local."""
    ref = datetime.fromisoformat(item['ref']) if item.get('ref') else None
    lead, entries = [], []
    closed = failed = False
    asm = _JournalAssembler()
    lines = 0
    with open(item['path'], 'rb') as f:
        for event in _journal_events(f, item['start'], item['end'], item['year'], ref, item['prev_year'], {}):
            kind = event[0]
            if kind == 'lines':
                lines = event[1]
                continue
            if kind == 'error':
                # the failing line ends the entry open before it (the chunk's own, or - when it is the chunk's first
                # timestamped line - the one from the chunks before), and nothing after it is read
                if closed:
                    done = asm.finish()
                    if done is not None:
                        entries.append(done)
                closed = failed = True
                print(f"[JournalctlParser] Error streaming: {event[1]}")
                continue
            if not closed:
                if kind == 'cont':
                    lead.append(event)
                    continue
                closed = True
            done = asm.feed(event)
            if done is not None:
                entries.append(done)
    return {'lead': lead, 'closed': closed, 'entries': entries, 'open': None if failed else asm.finish(), 'lines': lines, 'stopped': failed}


def _line_bounds(filepath, start_pos, end_pos, chunk, first=LOG_FIRST_CHUNK_BYTES):
    """Byte offsets [start_pos, b1, b2, ..., end_pos] that split the range at line starts (each boundary just after a
    newline): the first range `first` bytes, each next one twice the last, up to `chunk` - the first rows come
    quickly, the rest in ranges large enough to keep the workers busy."""
    bounds = [start_pos]
    size = min(first, chunk) if first else chunk
    with open(filepath, 'rb') as f:
        pos = start_pos + size
        while pos < end_pos:
            f.seek(pos)
            f.readline()
            b = f.tell()
            if b >= end_pos:
                break
            if b > bounds[-1]:
                bounds.append(b)
            size = min(chunk, size * 2)
            pos = b + size
    bounds.append(end_pos)
    return bounds


def _readable_file_size(filepath):
    """Size of a regular file in bytes, or None when it cannot be read.

    os.walk() lists a dangling symlink as a file, and sosreports routinely
    contain them: var/log/containers/*.log are symlinks into var/log/pods/...
    which the collector does not always capture. os.path.getsize() on such
    an entry raises FileNotFoundError (or PermissionError for an unreadable
    one), which used to escape parse() and turn the whole Log Viewer tab into
    a 500. A None here tells the caller to list the file as unavailable
    instead of aborting.
    """
    try:
        if not os.path.isfile(filepath):
            return None
        return os.path.getsize(filepath)
    except OSError:
        return None


# sos names the captured command output after the command line with runs of
# non-word characters collapsed to "_", so the system journal is normally
# sos_commands/logs/journalctl_--no-pager. Reports have been seen with a
# doubled separator (journalctl__--no-pager), which the literal string
# comparisons here used to miss entirely: the file was neither listed nor used
# for the date range. Match any number of underscores between the command and
# its first option instead.
_JOURNAL_CAPTURE_RE = re.compile(r'^journalctl_+--no-pager')
_MAIN_JOURNAL_RE = re.compile(r'^journalctl_+--no-pager$')
_MAIN_JOURNAL_CANONICAL = 'journalctl_--no-pager'


def _find_main_journal(directory):
    """Path of the main `journalctl --no-pager` capture, or None.

    Prefers the canonical spelling when several candidates exist. The returned
    path may still be unreadable (a directory, a dangling symlink); callers
    check with _readable_file_size().
    """
    logs_dir = os.path.join(directory, "sos_commands", "logs")
    canonical = os.path.join(logs_dir, _MAIN_JOURNAL_CANONICAL)
    if os.path.lexists(canonical):
        return canonical
    try:
        names = sorted(os.listdir(logs_dir))
    except OSError:
        return None
    for name in names:
        if _MAIN_JOURNAL_RE.match(name):
            return os.path.join(logs_dir, name)
    return None


def _initial_date_range(available_logs):
    """(start_iso, end_iso, total_lines) for the tab's initial date slider.

    The main system journal alone used to decide this, and when it was
    missing, unreadable, or had no parseable timestamps the range stayed
    None - which the tab template then sliced ([:10]) and crashed on. Now the
    system journal is tried first and, failing that, the range is widened over
    every other readable log so the slider still gets sensible bounds. Returns
    (None, None, 0) when nothing yields a timestamp; the template and JS treat
    that as "unknown" rather than a value.
    """
    ordered = ([log for log in available_logs if log['type'] == 'system']
               + [log for log in available_logs if log['type'] != 'system'])

    min_date = None
    max_date = None
    total_lines = 0
    for log in ordered:
        try:
            file_min, file_max, file_lines = extract_date_range(log['path'])
        except Exception as e:  # noqa: BLE001 - one bad file must not take the tab down
            print(f"[Log Viewer] Could not extract date range from {log['path']}: {e}")
            continue
        if not (file_min and file_max):
            continue
        if min_date is None or file_min < min_date:
            min_date = file_min
        if max_date is None or file_max > max_date:
            max_date = file_max
        total_lines += file_lines or 0
        if log['type'] == 'system':
            # The system journal is authoritative when it has timestamps;
            # matches the previous behaviour for the common case.
            break

    if min_date and max_date:
        return min_date.isoformat(), max_date.isoformat(), total_lines
    return None, None, 0


def parse(directory):
    """Initial parse - list available log files"""
    result = _parse(directory)
    result['findings'] = findings_for(result)
    return result


def _parse(directory):
    """Initial parse - list available log files"""
    print(f"[Log Viewer] Parsing directory: {directory}")

    result = {
        'available_logs': [],
        # Log files present in the report tree that cannot be opened (dangling
        # symlinks, unreadable files). Listed separately so the UI can say
        # they exist but are unavailable, rather than failing the whole tab.
        'unavailable_logs': [],
        'date_range': {
            'start': None,
            'end': None
        },
        'total_lines': 0
    }

    # Handle sosreport directory structure
    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    # Find all available log files
    available_logs = []
    unavailable_logs = []

    # 1. System log: journalctl - only the main one as 'system' type
    main_journalctl_path = _find_main_journal(directory)
    if main_journalctl_path is not None:
        file_size = _readable_file_size(main_journalctl_path)
        if file_size is not None:
            available_logs.append({
                'name': 'journalctl (system)',
                'path': main_journalctl_path,
                'size': file_size,
                'type': 'system'
            })
        else:
            # Present in the tree but not a readable regular file (a
            # directory, a dangling symlink, ...). One log line, no traceback.
            print(f"[Log Viewer] Skipping unreadable log file: {main_journalctl_path}")
            unavailable_logs.append({
                'name': 'journalctl (system)',
                'path': main_journalctl_path,
                'type': 'system'
            })

    # 1b. Other journalctl files as 'journal' type (not auto-selected)
    sos_commands_path = os.path.join(directory, "sos_commands")
    if os.path.exists(sos_commands_path):
        for root, dirs, files in os.walk(sos_commands_path):
            for file in files:
                prefix = _JOURNAL_CAPTURE_RE.match(file)
                if prefix:
                    full_path = os.path.join(root, file)
                    if full_path == main_journalctl_path:
                        continue
                    # Extract suffix after 'journalctl_--no-pager'
                    suffix = file[prefix.end():].strip('_-')
                    log_name = f'journalctl ({suffix})' if suffix else 'journalctl'

                    file_size = _readable_file_size(full_path)
                    if file_size is None:
                        print(f"[Log Viewer] Skipping unreadable log file: {full_path}")
                        unavailable_logs.append({
                            'name': log_name,
                            'path': full_path,
                            'type': 'journal'
                        })
                        continue

                    available_logs.append({
                        'name': log_name,
                        'path': full_path,
                        'size': file_size,
                        'type': 'journal'
                    })

    # 2. Application logs: find all .log files
    var_log_path = os.path.join(directory, "var/log")
    if os.path.exists(var_log_path):
        for root, dirs, files in os.walk(var_log_path):
            for file in files:
                if file.endswith('.log') or file.endswith('.log.1') or file.endswith('.log.2'):
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, var_log_path)

                    file_size = _readable_file_size(full_path)
                    if file_size is None:
                        print(f"[Log Viewer] Skipping unreadable log file: {full_path}")
                        unavailable_logs.append({
                            'name': rel_path,
                            'path': full_path,
                            'type': 'application'
                        })
                        continue

                    available_logs.append({
                        'name': rel_path,
                        'path': full_path,
                        'size': file_size,
                        'type': 'application'
                    })

    result['available_logs'] = available_logs
    result['unavailable_logs'] = unavailable_logs
    print(f"[Log Viewer] Found {len(available_logs)} log files"
          + (f", {len(unavailable_logs)} unavailable" if unavailable_logs else ""))

    # Initial date range: system journal first, other readable logs as fallback.
    # Both fields stay None when nothing has a parseable timestamp; the
    # template renders that as "unknown" instead of slicing a None.
    start, end, total_lines = _initial_date_range(available_logs)
    result['date_range']['start'] = start
    result['date_range']['end'] = end
    result['total_lines'] = total_lines

    return result


def extract_date_range(filepath):
    """Fast extraction of date range - delegates to appropriate parser"""
    # Anything that is not a readable regular file (directory, dangling
    # symlink) has no date range. Answer without opening it: every parser's
    # extract_date_range() would otherwise print a full traceback for the
    # IsADirectoryError / FileNotFoundError before returning the same Nones.
    if _readable_file_size(filepath) is None:
        print(f"[Log Viewer] Not a readable log file, no date range: {filepath}")
        return None, None, 0
    # Pass full path so parsers can check directory names too
    parser = get_parser_for_file(filepath)
    return parser.extract_date_range(filepath)


def parse_date_range_stream(directory, start_date_str, end_date_str, log_paths=None, batch_size=5000, workers=1, cancelled=None):
    """Stream log entries progressively as they're parsed - yields batches

    Args:
        directory: sosreport directory path
        start_date_str: start date ISO string
        end_date_str: end date ISO string
        log_paths: list of log file paths to parse
        batch_size: number of entries per batch (default 5000)
        workers: 1 reads in this process; None (parallel.default_workers()) or more reads a journal-format log of
            at least LOG_PARALLEL_MIN_BYTES in worker processes - the same entries in the same order
        cancelled: a callable answering True when the read should stop (parallel.Cancelled is raised)

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

            # Parse entries line-by-line (a large journal-format log in worker processes, in order)
            if isinstance(parser, JournalctlParser):
                entries = parser.parse_entries_streaming(log_path, start_date, end_date, workers=workers, cancelled=cancelled)
            else:
                entries = parser.parse_entries_streaming(log_path, start_date, end_date)
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
            if type(e).__name__ == 'Cancelled':
                raise   # a newer read of the report (or the page going away): the stream stops here
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


def parse_date_range(directory, start_date_str, end_date_str, log_paths=None, limit=None, offset=0):
    """Parse logs within a specific date range - called on-demand

    Parses files progressively to avoid loading millions of entries into memory.

    Args:
        directory: sosreport directory path
        start_date_str: start date ISO string
        end_date_str: end date ISO string
        log_paths: list of log file paths to parse
        limit: maximum number of entries to return (for pagination)
        offset: number of entries to skip (for pagination)
    """
    result = {
        'log_entries': [],
        'stats': {
            'total': 0,
            'error': 0,
            'warning': 0,
            'critical': 0,
            'info': 0,
            'debug': 0,
            'other': 0
        },
        'issues': [],
        'has_more': False,
        'total_count': 0
    }

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

    # Create cache key from request parameters (without offset/limit)
    cache_key_data = {
        'log_paths': sorted(log_paths),
        'start_date': start_date_str,
        'end_date': end_date_str
    }
    cache_key = hashlib.md5(json.dumps(cache_key_data, sort_keys=True).encode()).hexdigest()

    # Clean up expired cache entries
    current_time = time.time()
    expired_keys = [k for k, exp_time in _cache_expiry.items() if current_time > exp_time]
    for k in expired_keys:
        if k in _session_cache:
            del _session_cache[k]
        del _cache_expiry[k]
    if expired_keys:
        print(f"[Log Viewer] Cleaned up {len(expired_keys)} expired cache entries")

    # Check if we have cached results for this query
    if cache_key in _session_cache:
        print(f"[Log Viewer] Using cached entries (key: {cache_key[:8]}...)")
        all_entries = _session_cache[cache_key]
        # Refresh cache expiry with CURRENT time
        _cache_expiry[cache_key] = time.time() + CACHE_TTL
    else:
        print(f"[Log Viewer] Cache miss - parsing files (key: {cache_key[:8]}...)")

        # Parse each selected log file directly from disk
        all_entries = []

        for log_path in log_paths:
            if not os.path.exists(log_path):
                print(f"[Log Viewer] Skipping non-existent path: {log_path}")
                continue

            try:
                # Get appropriate parser for this file (pass full path for directory checking)
                parser = get_parser_for_file(log_path)
                print(f"[Log Viewer] Parsing {log_path} with {parser.__class__.__name__}")

                # Parse entries using the parser (now line-by-line, much faster)
                entries = parser.parse_entries(log_path, start_date, end_date)
                print(f"[Log Viewer] Got {len(entries)} entries from {log_path}")
                all_entries.extend(entries)
            except Exception as e:
                print(f"[Log Viewer] Error parsing {log_path}: {e}")
                import traceback
                traceback.print_exc()
                # Continue with other files instead of failing completely
                continue

        # Don't sort here - frontend handles sorting when user clicks column headers
        print(f"[Log Viewer] Loaded {len(all_entries)} entries from {len(log_paths)} file(s)")

        # Cache the results in memory
        _session_cache[cache_key] = all_entries
        _cache_expiry[cache_key] = time.time() + CACHE_TTL
        print(f"[Log Viewer] Cached {len(all_entries)} entries (expires in {CACHE_TTL}s)")

    # Store total count before pagination
    total_entries = len(all_entries)
    result['total_count'] = total_entries

    # Apply pagination if limit is specified
    if limit is not None:
        start_idx = offset
        end_idx = offset + limit
        paginated_entries = all_entries[start_idx:end_idx]
        result['has_more'] = end_idx < total_entries
        print(f"[Log Viewer] Pagination: offset={offset}, limit={limit}, returning {len(paginated_entries)} of {total_entries} total entries")
    else:
        paginated_entries = all_entries
        result['has_more'] = False

    # Calculate statistics on paginated entries
    result['log_entries'] = paginated_entries
    result['stats']['total'] = len(paginated_entries)

    for entry in paginated_entries:
        severity = entry['severity']
        if severity in result['stats']:
            result['stats'][severity] += 1

        # Collect unique issues
        for issue in entry['issues']:
            if issue not in [i['type'] for i in result['issues']]:
                result['issues'].append({
                    'type': issue,
                    'count': 1,
                    'first_occurrence': entry['line_number']
                })
            else:
                # Increment count
                for i in result['issues']:
                    if i['type'] == issue:
                        i['count'] += 1
                        break

    return result


def findings_for(result):
    """The Findings strip of the Log Viewer: what there is to open (the files, their span), the unreadable ones
    (warn), the way to work (pick files, a date range, Load); no log at all (info)."""
    from parsers.findings import finding, no_data, sort_findings
    logs = result.get('available_logs') or []
    bad = result.get('unavailable_logs') or []
    out = []
    if not logs and not bad:
        return [no_data('No log file to open in this report', ['sos_commands/logs/journalctl*', 'var/log/*'], 'the Log Viewer reads the journal captures and var/log')]
    if bad:
        out.append(finding('warn', f"{len(bad)} log file{'s' if len(bad) != 1 else ''} cannot be opened", ', '.join(b.get('name', '?') for b in bad[:4]) + (' \u2026' if len(bad) > 4 else '') + ': dangling symlinks or unreadable files in the report', count=len(bad)))
    rng = result.get('date_range') or {}
    span = f", {rng['start']} to {rng['end']}" if rng.get('start') and rng.get('end') else ''
    out.append(finding('info', f"{len(logs)} log file{'s' if len(logs) != 1 else ''} to open{span}", 'pick the files and a date range, then Load Logs; the search, the severity and the process filters work on what is loaded'))
    return sort_findings(out)
