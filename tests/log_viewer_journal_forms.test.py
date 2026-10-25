#!/usr/bin/env python3
"""
The journal line parser shared by the Log Viewers (backend/parsers/sosreport/log_viewer.py: parse_journal_ts,
parse_journal_line, report_capture_time) and the sosreport JournalctlParser on every journalctl output form.

THE BUG: the journal parsers accepted only `Mon DD HH:MM:SS host proc[pid]:` - journalctl's short form. A capture
in short-precise (`Oct 21 20:51:31.951198`, as must-gather's host service logs and many sos runs), short-iso,
short-iso-precise or short-full gave rows without a time, the role directory as the host and the whole prefix
left in the message; the year came from the clock of the machine reading the report, not from the report.

THE FIX: one parser for the five forms; the year-less forms take the year of the report's `date` capture (the
gather's timestamp on the must-gather side), and a line later than that capture by more than a month is last
year's (a December log read by a January capture).

Run: backend/venv/bin/python tests/log_viewer_journal_forms.test.py
"""
import os
import shutil
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'backend'))

import parsers.sosreport.log_viewer as lv  # noqa: E402

failed = 0


def check(name, passed, detail=''):
    global failed
    print(f"{'PASS' if passed else 'FAIL'}: {name}{(' | ' + str(detail)[:400]) if detail and not passed else ''}")
    if not passed:
        failed += 1


# ---------------------------------------------------------------- the shared parser
ref = datetime(2026, 10, 23, 4, 33, 48)
cases = [
    ("short", "Oct 21 20:51:31 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot", "2026-10-21T20:51:31"),
    ("short-precise", "Oct 21 20:51:31.951198 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot", "2026-10-21T20:51:31.951198"),
    ("short-iso", "2026-10-21T20:51:31+0000 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot", "2026-10-21T20:51:31"),
    ("short-iso-precise", "2026-10-21T20:51:31.951198+0000 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot", "2026-10-21T20:51:31.951198"),
    ("short-full", "Wed 2026-10-21 20:51:31 UTC ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot", "2026-10-21T20:51:31"),
]
for name, line, iso in cases:
    j = lv.parse_journal_line(line, 2026, ref)
    check(f"parse_journal_line: {name} -> the time {iso}, the host, the process and pid, the message",
          j is not None and j['ts'].isoformat() == iso and j['host'] == 'ip-192-0-2-116' and j['process'] == 'rpm-ostreed' and j['pid'] == '1933' and j['message'] == 'Locked sysroot', j)
    tok = line.split(' ip-192-0-2-116')[0]
    check(f"parse_journal_ts: the {name} token alone -> {iso}", (lambda t: t is not None and t.isoformat() == iso)(lv.parse_journal_ts(tok, 2026, ref)), lv.parse_journal_ts(tok, 2026, ref))
check("a line without a pid, a kernel line", (lambda j: j and j['process'] == 'kernel' and j['pid'] == '' and j['message'].startswith('eth1:'))(lv.parse_journal_line("Oct 21 20:51:31 web-01 kernel: eth1: link up", 2026, ref)))
check("a line that is not a journal line", lv.parse_journal_line("2026-10-21T20:51:31Z I am a container log line", 2026, ref) is None and lv.parse_journal_line("plain text", 2026, ref) is None)
check("an impossible date is not a time", lv.parse_journal_line("Feb 30 10:00:00 host proc: x", 2026, ref) is None and lv.parse_journal_ts("Xyz 21 20:51:31", 2026, ref) is None)
check("the year rollover: a December line read by a January capture is last year's; one within a month of the capture keeps the year",
      lv.parse_journal_ts("Dec 30 23:59:59", 2027, datetime(2027, 1, 3)).isoformat() == "2026-12-30T23:59:59" and lv.parse_journal_ts("Jan 02 10:00:00", 2027, datetime(2027, 1, 3)).isoformat() == "2027-01-02T10:00:00"
      and lv.parse_journal_ts("Nov 10 10:00:00", 2026, ref).isoformat() == "2026-11-10T10:00:00")
check("no year and no reference: this year", lv.parse_journal_ts("Oct 21 20:51:31").year == datetime.now().year)

# ---------------------------------------------------------------- the sosreport parser over a report
WORK = tempfile.mkdtemp(prefix="sos-journal-")


def report(name, date_text, journal_text):
    d = os.path.join(WORK, name)
    os.makedirs(os.path.join(d, "sos_commands", "logs"))
    with open(os.path.join(d, "date"), "w") as f:
        f.write(date_text + "\n")
    p = os.path.join(d, "sos_commands", "logs", "journalctl_--no-pager")
    with open(p, "w") as f:
        f.write(journal_text)
    return p


P = lv.JournalctlParser()
precise = "\n".join([
    "Oct 21 20:51:31.951198 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot",
    "Oct 21 20:51:32.102334 ip-198-51-100-159 rpm-ostreed[2004]: Initiated txn Cleanup for client(id:cli dbus:1.422 unit:machine-config-daemon-firstboot.service uid:0): /org/projectatomic/rpmostree1/rhcos",
    "Oct 21 20:51:33.000001 ip-203-0-113-67 rpm-ostreed[1871]: error: Failed to unlock sysroot: permission denied",
    "Oct 22 03:12:10.500000 ip-192-0-2-116 kernel: eth1: RX ring buffer overrun, 7 packets dropped",
    "Oct 23 04:30:00.000000 ip-198-51-100-159 rpm-ostreed[2004]: Unlocked sysroot",
]) + "\n"
p1 = report("sosreport-a-2026-10-23-precise", "Fri Oct 23 04:40:00 UTC 2026", precise)
check("report_capture_time reads the report's date capture above the file", lv.report_capture_time(p1) == datetime(2026, 10, 23, 4, 40), lv.report_capture_time(p1))
lo, hi, _n = P.extract_date_range(p1)
check("extract_date_range over a short-precise journal: the first and the last line, the year from the report's date (not the clock)",
      lo is not None and hi is not None and lo.isoformat() == "2026-10-21T20:51:31.951198" and hi.isoformat() == "2026-10-23T04:30:00", (lo, hi))
rows = list(P.parse_entries_streaming(p1, None, None))
check("the streamed rows of a short-precise journal: the time, the real host of each line, the process and pid, the message without the prefix",
      len(rows) == 5 and rows[0]['timestamp_obj'] == "2026-10-21T20:51:31.951198" and rows[0]['hostname'] == 'ip-192-0-2-116' and rows[0]['process'] == 'rpm-ostreed' and rows[0]['pid'] == '1933'
      and rows[0]['message'] == 'Locked sysroot' and rows[1]['hostname'] == 'ip-198-51-100-159' and rows[3]['process'] == 'kernel' and rows[3]['pid'] == '' and rows[2]['severity'] == 'error', rows[:1])
rows = list(P.parse_entries_streaming(p1, datetime(2026, 10, 22), datetime(2026, 10, 22, 23, 59, 59)))
check("a date range over the short-precise journal (the binary search reads the precise timestamps): the one line of Oct 22", len(rows) == 1 and rows[0]['process'] == 'kernel', rows)
iso_full = ("2026-10-21T20:52:19+0000 web-01 systemd[1]: Started Kubernetes Kubelet.\n"
            "2026-10-21T20:52:20.250000+0000 web-01 kubenswrapper[2271]: I1021 20:52:20.250000    2271 server.go:490] \"Kubelet version\"\n"
            "Wed 2026-10-21 20:53:00 UTC web-01 crio[1961]: time=\"2026-10-21T20:53:00Z\" level=warning msg=\"Pulling image\"\n")
p2 = report("sosreport-b-2026-10-23-iso", "Fri Oct 23 04:40:00 UTC 2026", iso_full)
rows = list(P.parse_entries_streaming(p2, None, None))
lo, hi, _n = P.extract_date_range(p2)
check("short-iso, short-iso-precise and short-full lines in one journal: every row dated, the hosts and processes, the range over them",
      [r['timestamp_obj'] for r in rows] == ["2026-10-21T20:52:19", "2026-10-21T20:52:20.250000", "2026-10-21T20:53:00"] and [r['process'] for r in rows] == ['systemd', 'kubenswrapper', 'crio']
      and rows[2]['severity'] == 'warning' and lo.isoformat() == "2026-10-21T20:52:19" and hi.isoformat() == "2026-10-21T20:53:00", (rows, lo, hi))
p3 = report("sosreport-c-2027-01-03-jan", "Sun Jan  3 02:00:00 UTC 2027", "Dec 30 23:59:59.123456 web-01 kubenswrapper[2]: before the new year\nJan 02 10:00:00.000000 web-01 kubenswrapper[2]: after it\n")
rows = list(P.parse_entries_streaming(p3, None, None))
lo, hi, _n = P.extract_date_range(p3)
check("the year rollover in a sosreport: a January capture's December lines are last year's, the January line this year's, the range spans the two",
      [r['timestamp_obj'][:4] for r in rows] == ["2026", "2027"] and lo.isoformat() == "2026-12-30T23:59:59.123456" and hi.isoformat() == "2027-01-02T10:00:00", (rows, lo, hi))

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
