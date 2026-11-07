#!/usr/bin/env python3
"""backend/parsers/parallel.py: one function over many items in worker processes, for the Diagnostics parsers.

  - parallel and serial give identical results, in the items' order; the work ran in other processes;
  - the parent's __main__ is never re-imported by a worker (this script would write a marker if it were);
  - an item that raises is a WorkerError with the type, message and the worker's traceback; a worker that dies
    mid-item is a WorkerError with its exit code; neither leaves a process behind;
  - cancellation (Generation): a newer run or cancel() stops a running one within a poll - the workers are
    terminated mid-item, Cancelled is raised, nothing is left;
  - the serial fallback: a pool that cannot start (the process start refused, a worker that never answers) runs
    the items in this process and says why in info['fallback'];
  - workers: JACARIUM_WORKERS overrides the default (cores - 1, at most MAX_WORKERS); 1 or one item is serial;
  - a pool started from a request thread (the Flask / gunicorn gthread case) works the same;
  - progress(done, total) after every item; a function of __main__ or a lambda is refused;
  - imap: the results streamed in the items' order (also when later items finish first), at most `ahead` items run
    beyond the one the consumer waits for, closing the generator or a cancel stops the workers, errors, the fallback.
Run with the backend venv's Python: backend/venv/bin/python tests/parallel.test.py
"""
import multiprocessing
import os
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
MARKER = os.path.join(tempfile.gettempdir(), f"jacarium-parallel-test-main-{os.getppid() if __name__ == '__mp_main__' else os.getpid()}")
if __name__ == "__mp_main__":
    # a worker that re-imported this script as its main module: what parallel.py must prevent (app.py would start
    # the app's schedulers again)
    with open(MARKER, "w") as f:
        f.write("imported in a worker\n")

sys.path.insert(0, os.path.join(REPO, "backend"))
# the worker-count setting (Settings > Performance) of this machine must not decide the defaults checked here
os.environ["JACARIUM_PARALLEL_SETTINGS"] = os.path.join(tempfile.gettempdir(), f"jacarium-parallel-test-{os.getpid()}-none.json")
sys.path.insert(0, os.path.join(HERE, "helpers"))
from parsers import parallel  # noqa: E402
import parallel_jobs as jobs  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:600]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


def no_workers_left(wait=3.0):
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not parallel.alive_workers():
            return True
        time.sleep(0.05)
    return not parallel.alive_workers()


if __name__ == "__main__":
    if os.path.exists(MARKER):
        os.unlink(MARKER)

    # ---------------------------------------------------------------- identical results, other processes
    items = list(range(40))
    info, progress = {}, []
    par = parallel.run(jobs.square, items, workers=3, info=info, progress=lambda d, n: progress.append((d, n)))
    ser = parallel.run(jobs.square, items, workers=1)
    strip = lambda rs: [(r['x'], r['square']) for r in rs]  # noqa: E731
    check("parallel and serial give the same results in the items' order", strip(par) == strip(ser) == [(x, x * x) for x in items])
    pids = {r['pid'] for r in par}
    check("the parallel run used worker processes (3), none of them this one", info.get("mode") == "parallel" and info.get("workers") == 3 and os.getpid() not in pids and 2 <= len(pids) <= 3, (info, pids))
    check("the serial run stayed in this process", {r['pid'] for r in ser} == {os.getpid()})
    check("progress(done, total) after every item, ending at (40, 40)", len(progress) == 40 and progress[-1] == (40, 40) and [d for d, _ in progress] == list(range(1, 41)), progress[-3:])
    check("no worker is left after the run", no_workers_left())
    check("the workers never re-imported this script as their main module (no marker)", not os.path.exists(MARKER))
    big = parallel.run(jobs.summary, [100000] * 4, workers=2)
    check("a worker returns a summary, not its input (counts per key)", all(len(b) == 50 and sum(b.values()) == 100000 for b in big))

    # ---------------------------------------------------------------- errors
    try:
        parallel.run(jobs.boom, list(range(8)), workers=3)
        check("an item that raises is a WorkerError", False, "no error")
    except parallel.WorkerError as e:
        check("an item that raises is a WorkerError with its type, message and the worker's traceback", "ValueError: item 3 is bad" in str(e) and "Traceback" in e.details and "boom" in e.details, (str(e), e.details[-300:]))
    check("... and no worker is left", no_workers_left())
    try:
        parallel.run(jobs.die, list(range(6)), workers=2)
        check("a worker that dies mid-item is a WorkerError", False, "no error")
    except parallel.WorkerError as e:
        check("a worker that dies mid-item is a WorkerError naming the item and its exit code", "item 2" in str(e) and "exit code 3" in str(e), str(e))
    check("... and no worker is left", no_workers_left())
    try:
        parallel.run(jobs.boom, [3], workers=1)
        check("serial: the item's own exception", False)
    except ValueError as e:
        check("serial: the item's own exception propagates unchanged", str(e) == "item 3 is bad")

    # ---------------------------------------------------------------- cancellation
    gen = parallel.Generation()
    token = gen.begin("report")
    out = {}

    def run_slow():
        t0 = time.monotonic()
        try:
            parallel.run(jobs.slow, [5] * 6, workers=3, cancelled=gen.checker("report", token))
            out["result"] = "finished"
        except parallel.Cancelled:
            out["result"] = "cancelled"
        out["seconds"] = time.monotonic() - t0
    th = threading.Thread(target=run_slow)
    th.start()
    time.sleep(1.5)
    newer = gen.begin("report")   # a newer analysis of the same report
    th.join(20)
    check("a newer run of the same key cancels the running one within a poll (items of 5 s each, stopped at ~1.5 s)", out.get("result") == "cancelled" and out.get("seconds", 99) < 3.5, out)
    check("... the workers were terminated mid-item: none is left", no_workers_left())
    check("Generation: the newer token is current, the older is not; cancel() makes it stale", gen.current("report", newer) and not gen.current("report", token) and (gen.cancel("report") or True) and not gen.current("report", newer))
    try:
        parallel.run(jobs.square, [1, 2, 3], workers=1, cancelled=lambda: True)
        check("serial: a cancel before an item raises Cancelled", False)
    except parallel.Cancelled:
        check("serial: a cancel before an item raises Cancelled", True)

    # ---------------------------------------------------------------- the fallback
    real_get_context = multiprocessing.get_context

    class RefusingContext:
        def __init__(self, ctx):
            self._ctx = ctx

        def Pipe(self, duplex=True):
            return self._ctx.Pipe(duplex=duplex)

        def Process(self, *a, **k):
            raise PermissionError("process creation is not allowed here")
    multiprocessing.get_context = lambda method=None: RefusingContext(real_get_context(method))
    try:
        info = {}
        res = parallel.run(jobs.square, list(range(6)), workers=3, info=info)
    finally:
        multiprocessing.get_context = real_get_context
    check("a pool that cannot start (the process start refused) falls back to serial, with the same results and the reason", info.get("mode") == "serial" and "PermissionError" in (info.get("fallback") or "") and [r["square"] for r in res] == [x * x for x in range(6)], info)
    info = {}
    res = parallel.run(jobs.square, list(range(6)), workers=3, info=info, startup_timeout=0.0)
    check("workers that do not answer in time: torn down, serial instead (the fallback names it)", info.get("mode") == "serial" and "did not start" in (info.get("fallback") or "") and len(res) == 6 and no_workers_left(), info)

    # ---------------------------------------------------------------- the worker count
    saved = os.environ.get(parallel.ENV_WORKERS)
    try:
        os.environ[parallel.ENV_WORKERS] = "1"
        info = {}
        parallel.run(jobs.square, list(range(5)), info=info)
        check("JACARIUM_WORKERS=1: always serial", parallel.default_workers() == 1 and info.get("mode") == "serial")
        os.environ[parallel.ENV_WORKERS] = "3"
        check("JACARIUM_WORKERS=3: three workers", parallel.default_workers() == 3)
        os.environ[parallel.ENV_WORKERS] = "lots"
        expected = max(1, min((os.cpu_count() or 1) - 1, parallel.MAX_WORKERS))
        check("an unreadable JACARIUM_WORKERS: the default (cores - 1, at most MAX_WORKERS)", parallel.default_workers() == expected, (parallel.default_workers(), expected))
    finally:
        if saved is None:
            os.environ.pop(parallel.ENV_WORKERS, None)
        else:
            os.environ[parallel.ENV_WORKERS] = saved
    info = {}
    parallel.run(jobs.square, [7], workers=4, info=info)
    check("one item: serial, no pool", info.get("mode") == "serial" and info.get("fallback") is None)

    # ---------------------------------------------------------------- a request thread (Flask, gunicorn gthread)
    box = {}

    def request_thread():
        i = {}
        box["res"] = parallel.run(jobs.square, list(range(10)), workers=2, info=i)
        box["info"] = i
    t = threading.Thread(target=request_thread, name="request")
    t.start()
    t.join(60)
    check("a pool started from a request thread works the same (parallel, the results in order)", box.get("info", {}).get("mode") == "parallel" and [r["square"] for r in box.get("res", [])] == [x * x for x in range(10)], box.get("info"))
    check("... and no worker is left", no_workers_left())

    # ---------------------------------------------------------------- what may run in a worker
    for name, func in (("a lambda", lambda x: x), ("a function of __main__", check)):
        try:
            parallel.run(func, [1, 2], workers=2)
            check(f"{name} is refused (a worker imports the function by name)", False)
        except TypeError:
            check(f"{name} is refused (a worker imports the function by name)", True)

    # ---------------------------------------------------------------- imap: streamed, in order
    info = {}
    got = list(parallel.imap(jobs.square, list(range(30)), workers=3, info=info))
    check("imap yields the same results as run, in the items' order, from worker processes", [r["square"] for r in got] == [x * x for x in range(30)] and info.get("mode") == "parallel" and os.getpid() not in {r["pid"] for r in got}, info)
    check("imap: no worker is left after it", no_workers_left())
    mixed = list(parallel.imap(jobs.slow, [0.4, 0.0, 0.0, 0.2, 0.0, 0.0], workers=3))
    check("imap keeps the order when later items finish first", mixed == [0.4, 0.0, 0.0, 0.2, 0.0, 0.0])
    with tempfile.TemporaryDirectory() as d:
        it = parallel.imap(jobs.mark, [(d, i) for i in range(40)], workers=2, ahead=4)
        first = next(it)
        time.sleep(1.0)   # a slow consumer: the workers may run ahead only `ahead` items
        started = len([f for f in os.listdir(d) if f.startswith("started-")])
        rest = list(it)
    check("imap runs at most `ahead` items beyond the one the consumer waits for (memory stays flat)", first == 0 and started <= 1 + 4 and rest == list(range(1, 40)), started)
    # the consumer stops early: closing the generator stops the workers (a streamed request's client went away)
    it = parallel.imap(jobs.slow, [0.0, 5, 5, 5, 5], workers=3)
    next(it)
    time.sleep(0.3)
    busy_before = len(parallel.alive_workers())
    it.close()
    check("imap: closing the generator mid-way terminates the workers at once", busy_before == 3 and no_workers_left(2.0), busy_before)
    gen = parallel.Generation()
    tok = gen.begin("r")
    out = {}

    def consume():
        t1 = time.monotonic()
        try:
            for _ in parallel.imap(jobs.slow, [5] * 6, workers=3, cancelled=gen.checker("r", tok)):
                pass
            out["r"] = "finished"
        except parallel.Cancelled:
            out["r"] = "cancelled"
        out["s"] = time.monotonic() - t1
    th = threading.Thread(target=consume)
    th.start()
    time.sleep(1.0)
    gen.cancel("r")
    th.join(20)
    check("imap: a cancel (a newer run) stops it within a poll, the workers terminated", out.get("r") == "cancelled" and out.get("s", 99) < 3 and no_workers_left(), out)
    try:
        list(parallel.imap(jobs.boom, list(range(8)), workers=3))
        check("imap: an item that raises is a WorkerError", False)
    except parallel.WorkerError as e:
        check("imap: an item that raises is a WorkerError, and no worker is left", "item 3 is bad" in str(e) and no_workers_left(), str(e))
    real_get_context = multiprocessing.get_context

    class Refusing:
        def __init__(self, ctx):
            self._ctx = ctx

        def Pipe(self, duplex=True):
            return self._ctx.Pipe(duplex=duplex)

        def Process(self, *a, **k):
            raise PermissionError("no processes here")
    multiprocessing.get_context = lambda method=None: Refusing(real_get_context(method))
    try:
        info = {}
        res = list(parallel.imap(jobs.square, list(range(6)), workers=3, info=info))
    finally:
        multiprocessing.get_context = real_get_context
    check("imap falls back to serial (the same results, the reason in info) when a pool cannot start", info.get("mode") == "serial" and "PermissionError" in (info.get("fallback") or "") and [r["square"] for r in res] == [x * x for x in range(6)], info)
    lazy = parallel.imap(jobs.square, list(range(3)), workers=1)
    check("imap with one worker is serial and lazy (each item computed when asked for)", [r["square"] for r in lazy] == [0, 1, 4])

    check("the marker is still absent: no worker of this whole test imported its main module", not os.path.exists(MARKER))
    print(f"\n{'FAIL' if FAILED else 'OK'}: {FAILED} failed")
    sys.exit(1 if FAILED else 0)
