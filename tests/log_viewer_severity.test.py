#!/usr/bin/env python3
"""
Guards the Log Viewer's severity classification
(backend/parsers/sosreport/log_viewer.py classify_severity()).

THE BUG: every parser carried its own copy of the rules and they disagreed.
The container-log parser matched SUBSTRINGS of the upper-cased message, so
"preferred route" (ERR inside preFERRed) and "unfailed" were errors, and it
answered 'info' when nothing said a level while the journal parser answered
'other' - the same text was a different level in a different file. Neither
read a syslog priority prefix (<3>), and the journal parser searched the
whole line, so a process named error-reporter made every line an error.

THE FIX: one classify_severity(message) for all parsers: the <N> priority,
the Kubernetes code, an explicit level= field, an explicit upper-case token,
then whole words (any case), else 'other'.

Run: python3 tests/log_viewer_severity.test.py   (no deps beyond the repo)
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'backend'))

import parsers.sosreport.log_viewer as lv  # noqa: E402

failed = 0


def check(name, passed, detail=''):
    global failed
    print(f"{'PASS' if passed else 'FAIL'}: {name}{(' | ' + str(detail)[:300]) if detail and not passed else ''}")
    if not passed:
        failed += 1


C = lv.classify_severity
cases = [
    ('preferred route refresh ok', 'other', '"preferred" is not an error (ERR is inside the word)'),
    ('the unfailed retry went through', 'other', '"unfailed" is not "failed"'),
    ('Started Session 7 of user example.', 'other', 'a line that says nothing about its level is other, not info'),
    ('ERROR: edge-sync failed [code=E42]', 'error', 'an explicit ERROR token'),
    ('2026-01-02 03:04:05,125 | INFO  | worker started', 'info', 'the structured "| INFO |" form'),
    ('[WARN] cache nearing capacity', 'warning', 'a bracketed WARN token'),
    ('level=warn msg="disk 90 percent full"', 'warning', 'an explicit level= field'),
    ('severity=critical reactor offline', 'critical', 'an explicit severity= field'),
    ('E0101 12:00:00.000001 1 edge.go:1] watch closed', 'error', 'a Kubernetes/glog E code'),
    ('W0101 12:00:00.000001 1 edge.go:1] slow watch', 'warning', 'a Kubernetes/glog W code'),
    ('F0101 12:00:00.000001 1 main.go:1] cannot start', 'critical', 'a Kubernetes/glog F code is fatal'),
    ('<3>edge driver reset after timeout', 'error', 'syslog priority 3 is err'),
    ('<11>kernel: oops', 'error', 'priority 11 = facility 1, level 3 (the low three bits)'),
    ('<4>link down', 'warning', 'priority 4 is warning'),
    ('<6>link up', 'info', 'priority 6 is info'),
    ('<7>probe', 'debug', 'priority 7 is debug'),
    ('<0>system halt', 'critical', 'priority 0 is emerg'),
    ('debug: edge trace tick', 'debug', 'a lower-case debug word'),
    ('notice: profile applied', 'info', 'notice is info'),
    ('Failed to connect to 192.0.2.10:9999', 'error', 'failed, any case'),
    ('warning: Deprecated option used', 'warning', 'warning/deprecated'),
    ('Kernel panic - not syncing', 'critical', 'panic is critical'),
    ('warning: the error count is 0', 'error', 'when several levels appear the strongest wins'),
    ('', 'other', 'an empty message is other'),
]
for message, expected, why in cases:
    got = C(message)
    check(f'classify_severity({message[:40]!r}) == {expected!r}: {why}', got == expected, f'got {got!r}')

# the parsers use it: the journal parser classifies the message, not the process name
tmp = tempfile.mkdtemp(prefix='lv-severity-')
try:
    logs = os.path.join(tmp, 'report', 'sos_commands', 'logs')
    os.makedirs(logs)
    journal = os.path.join(logs, 'journalctl_--no-pager')
    with open(journal, 'w') as f:
        f.write('-- Logs begin at Thu 2026-01-01 00:00:00 UTC. --\n')
        f.write('Jan  1 00:00:01 host error-reporter[1]: preferred route refresh ok\n')
        f.write('Jan  1 00:00:02 host edge[2]: ERROR: sync failed\n')
        f.write('Jan  1 00:00:03 host edge[3]: <4>link flapping\n')
    entries = lv.JournalctlParser().parse_entries(journal, None, None)
    sev = [e['severity'] for e in entries]
    check('journal parser: a process named error-reporter does not make its line an error; ERROR and <4> are read', sev == ['other', 'error', 'warning'], sev)
    entries = list(lv.JournalctlParser().parse_entries_streaming(journal, None, None))
    flat = [e for chunk in entries for e in (chunk if isinstance(chunk, list) else [chunk])]
    check('journal parser (streaming) agrees', [e['severity'] for e in flat if isinstance(e, dict)] == ['other', 'error', 'warning'], [e.get('severity') for e in flat if isinstance(e, dict)])

    containers = os.path.join(tmp, 'report', 'var', 'log', 'containers')
    os.makedirs(containers)
    clog = os.path.join(containers, 'edge-pod_ns_edge-abc123.log')
    with open(clog, 'w') as f:
        f.write('2026-01-01T00:00:01.000000000+00:00 stdout F preferred route refresh ok\n')
        f.write('2026-01-01T00:00:02.000000000+00:00 stderr F Started Session 7 of user example.\n')
        f.write('2026-01-01T00:00:03.000000000+00:00 stderr F E0101 00:00:03.000001 1 edge.go:1] watch closed\n')
    centries = lv.ContainerLogParser().parse_entries(clog, None, None)
    csev = [e['severity'] for e in centries]
    check('container parser: "preferred" is other (was error by substring), a plain line is other (was info), the k8s code is read', csev == ['other', 'other', 'error'], csev)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

src = open(os.path.join(REPO, 'backend', 'parsers', 'sosreport', 'log_viewer.py')).read()
check('the journal and container parsers use the shared classifier; no substring level check is left', "x in message_upper" not in src and src.count('classify_severity(message)') >= 3)

print('\nAll checks passed' if not failed else f'\n{failed} check(s) failed')
sys.exit(1 if failed else 0)
