#!/usr/bin/env python3
"""The sosreport Log Viewer's faster journal parse gives BYTE-FOR-BYTE the rows it gave before.

The oracle is the code as it was (tests/helpers/legacy_journal_parser.py: JournalctlParser.parse_entries_streaming,
parse_date_range_stream and classify_severity at c5bc7e0, verbatim). Compared, field by field and in order:

  - a journal of tricky lines: control characters, tabs, a lone CR and CRLF, invalid and truncated UTF-8, a 2 MB
    line, continuation lines (a traceback longer than a chunk, after an entry and after a timestamp that does not
    parse), a timestamp that does not parse, the issue words in every case and in Unicode that folds to them (the
    long s, the Kelvin sign), every journal timestamp form, a line without host / process, no final newline;
  - the mock journals of generate.py (the default and --large; the 1,000,000-line variant with
    LOG_VIEWER_IDENTICAL_BIG=1);
  - serially (workers=1) and in worker processes (2, 4 and 7, every size read in parallel, tiny byte ranges so the
    boundaries fall everywhere), over the whole file and over date ranges (the binary search);
  - the batched stream /parse_log_viewer_stream sends (parse_date_range_stream: entries, stats, counts, file
    numbers), serially and in parallel;
  - the must-gather search (parsers/mustgather/log_viewer.search), every page with its cursor and counts, serially and
    in worker processes, for six filter sets and two page sizes, over a container log (continuation lines, lines over
    the cap, invalid UTF-8, stderr) and a node journal;
  - classify_severity and the issue tags against the old patterns on 400,000 / 300,000 random messages.
Run with the backend venv's Python: backend/venv/bin/python tests/log_viewer_identical.test.py
"""
import contextlib
import io
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path[:0] = [os.path.join(REPO, "backend"), os.path.join(HERE, "helpers")]

import parsers.sosreport.log_viewer as lv  # noqa: E402
import legacy_journal_parser as legacy  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:700]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i, x, y
    return min(len(a), len(b)), (a[len(b):len(b) + 1] or None), (b[len(a):len(a) + 1] or None)


WORK = tempfile.mkdtemp(prefix="lv-identical-")

# ---------------------------------------------------------------- the tricky journals (a sosreport tree around each)


def tricky_journal(name, stoppers):
    """A journal of tricky lines. With stoppers it also holds the two lines where the read has always stopped (and
    still does, in parallel too): a line ending in a bare CR (a text-mode tell() after it carries the newline
    decoder's state) and the word 'ſegfault' (classify_severity's KeyError: the case-insensitive pattern folds the
    long s, str.lower() does not)."""
    tricky_root = os.path.join(WORK, name)
    os.makedirs(os.path.join(tricky_root, "sos_commands", "logs"))
    with open(os.path.join(tricky_root, "date"), "w") as f:
        f.write("Mon Jan  5 10:00:00 UTC 2026\n")   # a January capture: December lines are last year's
    open(os.path.join(tricky_root, "hostname"), "w").write("node-01.example.test\n")
    rnd = random.Random(42)
    parts = []


    def add(s):
        parts.append(s.encode("utf-8") if isinstance(s, str) else s)


    for day, month in ((30, "Dec"), (31, "Dec"), (1, "Jan"), (2, "Jan"), (3, "Jan")):
        for k in range(400):
            h, m, sec = (k // 60) % 24, k % 60, rnd.randint(0, 59)
            ts = f"{month} {day:2d} {h:02d}:{m:02d}:{sec:02d}"
            kind = k % 23
            if kind == 0:
                add(f"{ts} node-01.example.test kernel: segfault at 0 ip 0000 sp 0000 error 4 in libc.so.6\n")
            elif kind == 1:
                add(f"{ts} node-01.example.test app[{k}]: Traceback (most recent call last):\n")
                for j in range(rnd.randint(1, 6)):
                    add(f"  File \"/srv/app/m{j}.py\", line {j}, in f\n    raise TimeoutError('connection refused by 192.0.2.{j}')\n")
            elif kind == 2:
                add(f"{ts} node-01.example.test app[{k}]: ctl \x00\x01\x07 bell \x1b[31mred\x1b[0m del\x7f end\n")
            elif kind == 3:
                add(f"{ts} node-01.example.test app[{k}]:\ttabbed\tfields\terror\n")
            elif kind == 4:
                add(f"{ts} node-01.example.test app[{k}]: a lone CR\rsplits this line in text mode\n".encode() if stoppers else f"{ts} node-01.example.test app[{k}]: a CR in the middle is a control character only with lone_cr\n".encode())
            elif kind == 5:
                add(f"{ts} node-01.example.test app[{k}]: CRLF line ending service xyz failed\r\n".encode())
            elif kind == 6:
                add(f"{ts} node-01.example.test app[{k}]: invalid utf-8 ".encode() + b"\xff\xfe\xc3(" + b" then text\n")
            elif kind == 7:
                add(f"{ts} node-01.example.test app[{k}]: truncated multibyte at the end ".encode() + b"\xe2\x82\n")
            elif kind == 8:
                word = "ſegfault" if stoppers else "xſegfault"   # inside a word: the issue pattern folds it, the level words do not see it
                add(f"{ts} node-01.example.test kernel: {word} and the Kelvin Kernel panic žluťoučký kůň\n")
            elif kind == 9:
                add(f"Feb 30 {h:02d}:{m:02d}:{sec:02d} node-01.example.test app[{k}]: an impossible date ends the entry\n  a continuation after it is dropped\n")
            elif kind == 10:
                add(f"{ts} a line without host and process but with a timestamp\n")
            elif kind == 11:
                add(f"2026-01-0{min(day, 9)}T{h:02d}:{m:02d}:{sec:02d}+0000 node-01.example.test app[{k}]: short-iso Out Of Memory: Killed Process {k}\n")
            elif kind == 12:
                add(f"2026-01-0{min(day, 9)}T{h:02d}:{m:02d}:{sec:02d}.123456+0000 node-01.example.test app[{k}]: short-iso-precise <3> disk sda error\n")
            elif kind == 13:
                add(f"Mon 2026-01-0{min(day, 9)} {h:02d}:{m:02d}:{sec:02d} UTC node-01.example.test app[{k}]: short-full level=warn network eth0 unreachable\n")
            elif kind == 14:
                add(f"{ts}.951198 node-01.example.test sshd[{k}]: short-precise Failed password for invalid user admin from 198.51.100.{k % 250} port 22\n")
            elif kind == 15:
                add("\n")   # an empty line: a continuation (an empty one)
            elif kind == 16:
                add(f"{ts} node-01.example.test app[{k}]: E1012 klog-style | ERROR | [WARN] (INFO) authentication failure blk_update error\n")
            elif kind == 17:
                add(f"{ts} node-01.example.test systemd[1]: Failed to start example.service: oom-killer, OOM_KILLER\n")
            else:
                add(f"{ts} node-01.example.test app[{k}]: routine message {k} from 203.0.113.{k % 250}\n")
        # a traceback longer than a byte range, a 2 MB line, after a timestamp that does not parse
        add(f"{month} {day:2d} 23:59:00 node-01.example.test app[9]: Traceback (most recent call last):\n")
        for j in range(900):
            add(f"  continuation {j} of a long traceback: timeout waiting for disk I/O error\n")
        add(f"Feb 31 23:59:30 node-01.example.test app[9]: impossible again\n")
        for j in range(50):
            add(f"  dropped continuation {j}\n")
    add(b"Jan  3 23:59:59 node-01.example.test app[1]: a 2 MB line " + b"x" * (2 << 20) + b" panic\n")
    add("Jan  3 23:59:59 node-01.example.test app[1]: the last line has no newline: kernel panic")
    TRICKY = os.path.join(tricky_root, "sos_commands", "logs", "journalctl_--no-pager")
    with open(TRICKY, "wb") as f:
        f.write(b"".join(parts))
    print(f"  ({name}: {os.path.getsize(TRICKY):,} bytes)")
    return tricky_root, TRICKY


TRICKY_ROOT, TRICKY = tricky_journal('sosreport-node-01-2026-10-12-tricky', False)
CR_ROOT, CR = tricky_journal('sosreport-node-01-2026-10-12-stoppers', True)

# ---------------------------------------------------------------- the mock journals
gen = subprocess.run([sys.executable, os.path.join(HERE, "fixtures", "diagnostics-mock", "generate.py"), "--out", os.path.join(WORK, "mock"), "--no-archives", "--large"], capture_output=True, text=True)
check("the mock reports generate (the default and --large)", gen.returncode == 0, gen.stderr[-300:])
# compared with the old parse: everything but the two lines where the old read stopped (the stoppers journal below)
JOURNALS = [("tricky", TRICKY_ROOT, TRICKY)]
for name in ("sosreport-web-01-2026-10-13-abcdef", "sosreport-web-02-2026-10-13-bigjrnl"):
    root = os.path.join(WORK, "mock", name)
    JOURNALS.append((name, root, os.path.join(root, "sos_commands", "logs", "journalctl_--no-pager")))
if os.environ.get("LOG_VIEWER_IDENTICAL_BIG") == "1":
    big = subprocess.run([sys.executable, os.path.join(HERE, "fixtures", "diagnostics-mock", "generate.py"), "--out", os.path.join(WORK, "big"), "--no-archives", "--large", "--large-lines", "1000000"], capture_output=True, text=True)
    root = os.path.join(WORK, "big", "sosreport-web-02-2026-10-13-bigjrnl")
    JOURNALS.append(("1M lines", root, os.path.join(root, "sos_commands", "logs", "journalctl_--no-pager")))

# ---------------------------------------------------------------- entries: serial and parallel against the old parse
RANGES = [(None, None)]
for name, root, path in JOURNALS:
    ranges = [(None, None)]
    first, last, _ = quiet(lv.extract_date_range, path)
    if first and last:
        span = (last - first) / 5
        ranges += [(first + span, first + 3 * span), (first + span * 2, None), (None, first + span)]
    for rng in ranges:
        tag = f"{name} {('all' if rng == (None, None) else str(rng[0])[:16] + '..' + str(rng[1])[:16])}"
        t = time.perf_counter()
        old = quiet(lambda: list(legacy.legacy_parse_entries_streaming(lv.JournalctlParser(), path, *rng)))
        t_old = time.perf_counter() - t
        t = time.perf_counter()
        new = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(path, *rng)))
        t_new = time.perf_counter() - t
        check(f"{tag}: the serial parse gives the same {len(old):,} entries, field for field, in order (old {t_old:.2f} s, new {t_new:.2f} s)", old == new and (len(old) > 0 or rng != (None, None)), first_diff(old, new))
        for w in (2, 4, 7):
            info = {}
            chunk = 64 << 10 if name != "1M lines" else 4 << 20
            par = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(path, *rng, workers=w, info=info, min_bytes=0, chunk_bytes=chunk)))
            check(f"{tag}: {w} worker processes ({info.get('mode')}, {chunk >> 10} KB ranges) give the same entries", old == par and (info.get("mode") == "parallel" or rng != (None, None) or os.path.getsize(path) < 2 * chunk), (info, first_diff(old, par)))

# ---------------------------------------------------------------- the two lines where the old read stopped: read on
# The old parse stopped a file at a line ending in a bare CR (a text-mode tell() carried the newline decoder's state
# past the range's end) and at the word 'ſegfault' (classify_severity's KeyError: the patterns fold the long s,
# str.lower() does not). Both files are now read to the end. The expectation is the old parse of the same file with
# each bare CR written as LF (how a text-mode read splits it) and 'ſegfault' as 'segfault' (a read that never meets
# the long s) - every line, the same rows - with the one message that keeps its 'ſ'.
whole = quiet(lambda: list(legacy.legacy_parse_entries_streaming(lv.JournalctlParser(), TRICKY, None, None)))
check("the tricky journal is read whole by the old parse too (every case above compared with it)", len(whole) > 1500 and whole[-1]['message'].endswith('kernel panic'), len(whole))
variant_root = os.path.join(WORK, "sosreport-node-01-2026-10-12-stoppers-as-lf")
shutil.copytree(CR_ROOT, variant_root)
VARIANT = os.path.join(variant_root, "sos_commands", "logs", "journalctl_--no-pager")
raw = open(CR, "rb").read()
# the bare CRs (not those of a CRLF) as LF, the long s as s: the same length in bytes per line (offsets unchanged)
fixed = bytearray(raw)
for i in range(len(raw)):
    if raw[i] == 0x0D and raw[i + 1:i + 2] != b"\n":
        fixed[i] = 0x0A
open(VARIANT, "wb").write(bytes(fixed).replace("\u017fegfault and the Kelvin".encode(), b"segfault and the Kelvin"))
# (the rows carry no byte offsets: the one byte less per long s changes none of them; the message keeps its 'ſ')
expected = quiet(lambda: list(legacy.legacy_parse_entries_streaming(lv.JournalctlParser(), VARIANT, None, None)))
for e in expected:
    e["message"] = e["message"].replace("segfault and the Kelvin", "\u017fegfault and the Kelvin")
new_whole = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(CR, None, None)))
cr_lines = raw.count(b"a lone CR\r")
check(f"a journal with bare CRs ({cr_lines}) and 'ſegfault' lines is read to the end: every row the old parse gives once the CRs are line ends and the long s an s ({len(expected):,} rows)",
      len(expected) > 1500 and new_whole == expected and new_whole[-1]["message"].endswith("kernel panic"), first_diff(expected, new_whole))
lsl = [e for e in new_whole if "\u017fegfault" in e["message"] and not e["message"].startswith("x")]
check("... the 'ſegfault' rows: no exception, classified critical (the line also says Kernel panic: the strongest level wins), tagged segfault and kernel panic, the rows after them present", lsl and all(e["severity"] == "critical" and e["issues"] == ["kernel_panic", "segfault"] for e in lsl) and new_whole.index(lsl[-1]) < len(new_whole) - 1, [(e["severity"], e["issues"]) for e in lsl[:3]])
crs = [e for e in new_whole if e["message"].startswith("a lone CR")]
check("... a line with a bare CR: the CR ends it (universal newlines), what follows is its continuation, the lines after it present", crs and all(e["message"] == "a lone CR\nsplits this line in text mode" for e in crs) and new_whole.index(crs[-1]) < len(new_whole) - 1, [e["message"] for e in crs[:2]])
for w in (2, 4, 7):
    info = {}
    par = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(CR, None, None, workers=w, info=info, min_bytes=0, chunk_bytes=64 << 10)))
    check(f"... the same rows in {w} worker processes ({info.get('mode')})", par == new_whole and info.get("mode") == "parallel", first_diff(new_whole, par))
first, last, _ = quiet(lv.extract_date_range, CR)
span = (last - first) / 5
for rng in ((first + span, first + 3 * span), (first + 2 * span, None)):
    exp = quiet(lambda: list(legacy.legacy_parse_entries_streaming(lv.JournalctlParser(), VARIANT, *rng)))
    for e in exp:
        e["message"] = e["message"].replace("segfault and the Kelvin", "\u017fegfault and the Kelvin")
    got = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(CR, *rng)))
    got4 = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(CR, *rng, workers=4, min_bytes=0, chunk_bytes=64 << 10)))
    check(f"... over {str(rng[0])[:16]}..{str(rng[1])[:16]} (the binary search over the same lines): the same rows, serially and in 4 worker processes ({len(exp):,})", len(exp) > 0 and got == exp == got4, first_diff(exp, got))
small = os.path.join(WORK, "small-cr.log")
with open(small, "wb") as f:
    f.write(b"Oct 12 10:00:00 node-01.example.test app[1]: before\n")
    f.write(b"Oct 12 10:00:01 node-01.example.test app[1]: a bare CR\rin the middle\n")
    f.write(b"Oct 12 10:00:02 node-01.example.test kernel: \xc5\xbfegfault at 0 ip 0 sp 0 error 4\n")
    for k in range(50):
        f.write(f"Oct 12 10:01:{k:02d} node-01.example.test app[1]: after {k}\n".encode())
rows = quiet(lambda: list(lv.JournalctlParser().parse_entries_streaming(small, None, None)))
check("a small file: the lines after a bare CR and after 'ſegfault' are all there (53 rows, 'after 49' last), the long-s row an error", len(rows) == 53 and rows[-1]["message"] == "after 49" and rows[2]["severity"] == "error" and rows[1]["message"] == "a bare CR\nin the middle", [(r["message"], r["severity"]) for r in rows[:3]] + [len(rows)])
rows_dep = quiet(lambda: lv.JournalctlParser().parse_entries(small, None, None))
check("... the deprecated non-streaming parse (/parse_log_viewer_range) gives the same rows", rows_dep == rows)

# ---------------------------------------------------------------- the batched stream the route sends
saved = (lv.LOG_PARALLEL_MIN_BYTES, lv.LOG_CHUNK_BYTES, lv.LOG_FIRST_CHUNK_BYTES)
for name, root, path in JOURNALS[:3]:
    paths = [path]
    old = quiet(lambda: list(legacy.legacy_parse_date_range_stream(root, None, None, paths, batch_size=5000)))
    ser = quiet(lambda: list(lv.parse_date_range_stream(root, None, None, paths, batch_size=5000)))
    try:
        lv.LOG_PARALLEL_MIN_BYTES, lv.LOG_CHUNK_BYTES, lv.LOG_FIRST_CHUNK_BYTES = 0, 96 << 10, 16 << 10
        par = quiet(lambda: list(lv.parse_date_range_stream(root, None, None, paths, batch_size=5000, workers=3)))
    finally:
        lv.LOG_PARALLEL_MIN_BYTES, lv.LOG_CHUNK_BYTES, lv.LOG_FIRST_CHUNK_BYTES = saved
    check(f"{name}: the stream's batches (entries, stats, counts, file numbers) are the same, serially and in 3 worker processes ({len(old)} batches)", old == ser == par, (first_diff(old, ser), first_diff(old, par)))
    sev = quiet(lambda: list(lv.parse_date_range_stream(root, "2026-01-02T00:00", "2026-01-02T23:59", paths)))
    sev_old = quiet(lambda: list(legacy.legacy_parse_date_range_stream(root, "2026-01-02T00:00", "2026-01-02T23:59", paths)))
    check(f"{name}: the stream over a date range is the same", sev == sev_old)

# ---------------------------------------------------------------- the must-gather search, page by page
import parsers.mustgather.log_viewer as mglv  # noqa: E402
mg_root = os.path.join(WORK, "must-gather.local.4444444444")
inner = os.path.join(mg_root, "quay-io-example-org-must-gather-sha256-0123")
logs = os.path.join(inner, "namespaces", "demo-app", "pods", "api-0", "api", "api", "logs")
os.makedirs(logs)
with open(os.path.join(mg_root, "timestamp"), "w") as f:
    f.write("2026-10-12 23:59:00.000000000 +0000 UTC m=+0.000000001\n")
rnd = random.Random(7)
container = os.path.join(logs, "current.log")
with open(container, "wb") as f:
    for i in range(30000):
        ts = f"2026-10-12T{(i // 1500) % 24:02d}:{(i // 25) % 60:02d}:{i % 60:02d}.{i:06d}Z"
        kind = i % 41
        if kind == 0:
            msg = f"E1012 10:00:00.000000 1 controller.go:211] reconcile failed: conflict on obj-{i % 50}"
        elif kind == 1:
            msg = "W1012 10:00:00.000000 1 reflector.go:300] watch of *v1.Pod ended with: too old resource version"
        elif kind == 2:
            msg = "x" * 5000 + " a line over the cap, reconcile failed at its end"
        else:
            msg = f'I1012 10:00:00.000000 1 controller.go:{i % 900}] "Reconciling" object="ns-{i % 40}/obj-{i % 9999}"'
        stream = "stderr" if kind in (0, 1) else "stdout"
        f.write(f"{ts} {stream} F {msg}\n".encode())
        if kind in (0, 5):
            f.write(b"  a continuation of a stack trace \xff\xfe after a row\n  and a second one\n")
        if i % 997 == 0:
            f.write("the raw output of a program, no timestamp, reconcile failed\n".encode())
node_dir = os.path.join(inner, "nodes", "worker-0.example.test")
os.makedirs(node_dir)
node = os.path.join(node_dir, "worker-0.example.test_logs_journal")
with open(node, "w") as f:
    for i in range(20000):
        f.write(f"Oct 12 {(i // 900) % 24:02d}:{(i // 15) % 60:02d}:{i % 60:02d} worker-0.example.test kubelet[2101]: {'E' if i % 37 == 0 else 'I'}1012 sync loop {i} reconcile failed\n" if i % 37 == 0 else f"Oct 12 {(i // 900) % 24:02d}:{(i // 15) % 60:02d}:{i % 60:02d} worker-0.example.test kubelet[2101]: I1012 SyncLoop (housekeeping) {i}\n")
paths = [container, node]


def mg_pages(search, params, **kw):
    q, err = mglv.validate(dict(params, paths=paths), mg_root)
    assert not err, err
    out = []
    while True:
        r = quiet(search, mg_root, q, budget_seconds=1e9, **kw)
        out.append((r["entries"], r["cursor"], r["done"], r["lines"], r["truncated"]))
        if r["done"] or not r["cursor"]:
            return out
        q["cursor"] = r["cursor"]


import parsers.sosreport.log_viewer as slv  # noqa: E402
saved = (slv.LOG_PARALLEL_MIN_BYTES, slv.LOG_CHUNK_BYTES, slv.LOG_FIRST_CHUNK_BYTES)
for params in ({"query": ["reconcile failed"]}, {"level": "error"}, {"exclude": ["reconciling"]}, {"query": ["obj-1"], "start": "2026-10-12T03:00", "end": "2026-10-12T09:00"},
               {"source": "demo-app/api-0/api"}, {"query": ["sync loop"], "exclude": ["housekeeping"]}):
    # a small page size puts the page ends inside the byte ranges (a broad filter: a larger one, fewer pages)
    for limit in (2000, 401 if ("exclude" in params and "query" not in params) or "source" in params else 37):
        p2 = dict(params, limit=limit)
        old = mg_pages(legacy.legacy_mg_search, p2)
        new1 = mg_pages(mglv.search, p2, workers=1)
        try:
            slv.LOG_PARALLEL_MIN_BYTES, slv.LOG_CHUNK_BYTES, slv.LOG_FIRST_CHUNK_BYTES = 0, 96 << 10, 16 << 10
            pars = {w: mg_pages(mglv.search, p2, workers=w) for w in ((2, 4, 7) if limit == 2000 else (4,))}   # a pool per page: one count for the many pages
        finally:
            slv.LOG_PARALLEL_MIN_BYTES, slv.LOG_CHUNK_BYTES, slv.LOG_FIRST_CHUNK_BYTES = saved
        rows = sum(len(pg[0]) for pg in old)
        check(f"must-gather search {params} limit {limit}: every page (rows, cursor, done, counts) the same, serially and in {' / '.join(map(str, pars))} worker processes ({rows} rows, {len(old)} pages)",
              rows > 0 and old == new1 and all(pars[w] == old for w in pars), (first_diff(old, new1), {w: first_diff(old, pars[w])[0] for w in pars}))

# a must-gather log with the long s and a bare CR: the search answers its rows (the old classifier raised a KeyError
# out of the search: a 500)
odd = os.path.join(logs, "previous.log")
with open(odd, "wb") as f:
    for k in range(40):
        f.write(f"2026-10-12T03:00:{k:02d}.000000Z stderr F {'kernel: \u017fegfault at 0' if k == 20 else 'a bare CR' + chr(13) + 'inside' if k == 21 else 'step ' + str(k)}\n".encode())
q, err = mglv.validate({"paths": [odd], "limit": 2000}, mg_root)
r = quiet(mglv.search, mg_root, q, budget_seconds=1e9)
seg = [e for e in r.get("entries") or [] if "\u017fegfault" in e["message"]]
check("must-gather search: a log with 'ſegfault' and a bare CR answers all its 40 rows, the long-s row an error", r.get("ok") and len(r["entries"]) == 40 and seg and seg[0]["severity"] == "error", (r.get("ok"), len(r.get("entries") or []), seg[:1]))

# ---------------------------------------------------------------- the classifiers against the old code
rnd = random.Random(9)
pieces = ['ERROR', 'Error', 'error', 'ERR', 'err', 'errors', 'WARN', 'Warning', 'warnings', 'INFO', 'info:', 'Informational', 'notice', 'NOTICE', 'debug', 'TRACE', 'tracer',
          'critical', 'CRIT', 'fatal', 'FATAL', 'panic', 'PANIC', 'emerg', 'EMERG', 'emergency', 'ALERT', 'alert', 'failed', 'failure', 'fail', 'segfault', 'oops', 'bug', 'bugs',
          'deprecated', 'level=', 'level=warn', 'severity="error"', "lvl='info'", 'LEVEL=Debug', 'level=xyz', '<3>', '<14>', ' <6>', 'E1012 ', 'W1012 ', '| ERROR |', '[WARN]',
          '(INFO)', 'CRITICAL -', 'x', 'foo_bar', '_err_', 'ſ', 'K', 'ﬁle', 'ü', 'ſegfault', 'İNFO', 'warnİng', ' ', '', '\t', '-', ',', ':', '|', '[', ']', '(', ')', '"', "'", '=']
bad, raised = [], 0
for m in (''.join(rnd.choice(pieces) + rnd.choice(['', ' ', '-']) for _ in range(rnd.randint(0, 7))) for _ in range(400000)):
    folds = any(ch in m for ch in '\u017f\u212a\u0130')   # the letters the patterns fold and str.lower() does not
    try:
        old = legacy.legacy_classify_severity(m)
        if folds:
            # the old classifier skipped (or raised on) a level word spelled with them; the new one reads it: a level
            if lv.classify_severity(m) not in ('critical', 'error', 'warning', 'info', 'debug', 'other'):
                bad.append(m)
            continue
    except KeyError:
        # the old classifier raised on a word the patterns fold and str.lower() does not ('ſegfault', 'İNFO'): the new
        # one answers the level that word names
        raised += 1
        if lv.classify_severity(m) not in ('critical', 'error', 'warning', 'info', 'debug'):
            bad.append(m)
        continue
    if lv.classify_severity(m) != old:
        bad.append(m)
check(f"classify_severity answers as before on 400,000 random messages without the folding letters, and never raises on the others ({raised:,} where the old one raised: a level instead)", not bad and raised > 0, bad[:3])
for msg, level in (("kernel: \u017fegfault at 0", "error"), ("\u0130NFO started", "info"), ("level=WARN\u0130NG disk", "warning"), ("\u212a ok", "other"), ("deprecated \u017f\u017f", "warning")):
    check(f"classify_severity({msg!r}) is {level}", lv.classify_severity(msg) == level, lv.classify_severity(msg))
words = ['disk', 'DISK', 'error', 'ErRoR', 'blk', 'network', 'unreachable', 'connection', 'refused', 'timeout', 'TimeOut', 'failed', 'to', 'start', 'service', 'kernel', 'panic',
         'out', 'of', 'memory', 'oom-killer', 'oom_killer', 'OOM-Killer', 'killed', 'process', 'segfault', 'segmentation', 'fault', 'i/o', 'authentication', 'failure', 'password',
         'x', ' ', '', 'diskerror', 'servicefailed', 'ſegfault', 'Kernel panic', 'ü']
bad = []
for _ in range(300000):
    line = ''.join(rnd.choice(words) + rnd.choice([' ', '', '-', '\t']) for _ in range(rnd.randint(1, 8))) + '\n'
    if lv._issues_of(line) != [name for name, p in lv._ISSUE_PATTERNS if p.search(line)]:
        bad.append(line)
check("the issue tags are the old patterns' on 300,000 random lines (ASCII and Unicode)", not bad, bad[:3])

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAIL' if FAILED else 'OK'}: {FAILED} failed")
sys.exit(1 if FAILED else 0)
