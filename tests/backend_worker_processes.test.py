#!/usr/bin/env python3
"""Worker processes (backend/parsers/parallel.py) inside the two ways the backend runs in production: the FROZEN
desktop backend (PyInstaller, backend/flask-backend.spec) and the container's gunicorn (deploy/entrypoint.sh: one
gthread worker, app:app).

The risky part of a process pool is the process that starts it. A spawned worker is a fresh interpreter: in the
frozen app it is the frozen executable run again (without multiprocessing.freeze_support() at the top of
app_standalone.py that child would start a second backend - the app's schedulers, a port bound); under gunicorn it
is the venv's python, inside the worker's request thread. For each target this test runs Log Collection >
Histogram through the real app and checks:

  frozen only:
    1. `flask-backend --runtime-version` still prints the Python version and exits (the build's check);
    2. `flask-backend --selftest-parallel`: a pool job and a Histogram analysis in 3 worker processes of the frozen
       executable (distinct pids, not the parent's), identical to a serial run, nothing alive after;
  both:
    3. the app (PORT on a free port from 5300, an isolated HOME, JACARIUM_WORKERS=3) analyses a synthetic sosreport
       with planted anomalies through /log_histogram_stream in worker processes and finds them; while it runs every
       child of the backend is a multiprocessing child (a spawned worker or the resource tracker, never a second
       app) and none listens on a port; after it no worker is left;
    4. a cancel (/log_histogram_cancel) mid-analysis answers "cancelled" and the workers are gone within seconds;
    5. the sosreport Log Viewer's stream over the same journal: exactly the rows of a serial parse, read in worker
       processes (no second app, no port); a newer load of the report stops the older stream; a client that goes
       away mid-stream leaves no worker behind;
    6. after the backend is stopped, none of its children is left.

The frozen build: FROZEN_BACKEND=<path to dist/flask-backend/flask-backend>, else backend/dist/flask-backend/
flask-backend when it exists, else FROZEN_BUILD=1 builds one into a temporary directory (PyInstaller from
backend/venv, ~1 min); without one the frozen target is SKIPPED and gunicorn still runs. A frozen backend older
than the newest backend source (Python, templates, static assets, the spec, the requirements) is STALE: it is
rebuilt with FROZEN_BUILD=1 or skipped with a "stale frozen backend: rebuild" line - old code is never tested as
if it were current. macOS / Linux (ps, lsof).

    FROZEN_BUILD=1 backend/venv/bin/python tests/backend_worker_processes.test.py
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
VENV_BIN = os.path.join(BACKEND, "venv", "bin")
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))
import mock_log_anomalies as mla  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:800]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


if sys.platform == "win32":
    print("SKIP: the process checks use ps and lsof (macOS / Linux)")
    sys.exit(0)
if not os.path.exists(os.path.join(VENV_BIN, "python")):
    print("SKIP: backend/venv missing")
    sys.exit(0)


def free_port(start=5300):
    for port in range(start, start + 200):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port from 5300")


def children(pid):
    """[(pid, command)] of a process's descendants."""
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            procs[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
    found, frontier = [], {pid}
    while frontier:
        nxt = set()
        for p, (pp, cmd) in procs.items():
            if pp in frontier:
                found.append((p, cmd))
                nxt.add(p)
        frontier = nxt
    return found


def listening(pid):
    out = subprocess.run(["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN"], capture_output=True, text=True).stdout
    return [line for line in out.splitlines()[1:] if line.strip()]


def is_worker(cmd):
    # a spawned worker: the frozen executable with --multiprocessing-fork, or python -c '... spawn_main(...)'
    return "--multiprocessing-fork" in cmd or "multiprocessing.spawn import spawn_main" in cmd


def is_tracker(cmd):
    return "multiprocessing.resource_tracker" in cmd


WORK = tempfile.mkdtemp(prefix="backend-workers-")
REPORT, TRUTH = mla.planted_sosreport(WORK, per_minute=80)   # ~18 MB: over the parallel threshold
BIG, _ = mla.planted_sosreport(WORK, per_minute=400, seed=3, name="sosreport-node-01-2026-10-12-big")   # for the cancel


def run_target(label, argv, cwd, extra_env=None):
    """3-5 above for one way of running the backend (argv starts it, PORT and APP_AUTH_TOKEN from the env)."""
    home = tempfile.mkdtemp(prefix=f"home-{label}-", dir=WORK)
    port = free_port()
    token = secrets.token_hex(16)
    env = dict(os.environ, PORT=str(port), APP_AUTH_TOKEN=token, HOME=home, JACARIUM_PROFILE_HOME=home, JACARIUM_ENV_FILE=os.path.join(home, ".jacarium.env"),
               JACARIUM_KNOWN_HOSTS=os.path.join(home, ".ssh", "known_hosts"), JACARIUM_WORKERS="3", **(extra_env or {}))
    argv = [a.replace("{PORT}", str(port)) for a in argv]
    log_path = os.path.join(WORK, f"{label}.log")
    log = open(log_path, "w")
    proc = subprocess.Popen(argv, env=env, stdout=log, stderr=subprocess.STDOUT, cwd=cwd)
    base = f"http://127.0.0.1:{port}"

    def post(path, body, timeout=300):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-App-Token": token, "X-Requested-With": "Jacarium"})
        return urllib.request.urlopen(req, timeout=timeout)

    def stream_events(path, body):
        events = []
        with post(path, body) as resp:
            buf = ""
            for raw in resp:
                buf += raw.decode()
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    if block.startswith("data: "):
                        events.append(json.loads(block[6:]))
        return events

    try:
        up = False
        for _ in range(240):
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as h:
                    up = h.status == 200
                    break
            except Exception:  # noqa: BLE001 - not up yet
                if proc.poll() is not None:
                    break
                time.sleep(0.5)
        check(f"{label}: the backend starts and answers /health on port {port}", up, open(log_path).read()[-800:])
        if not up:
            return
        # gunicorn: the worker process is the app (the arbiter is its parent); the frozen app: the process itself
        app_pid = proc.pid
        if label == "gunicorn":
            kids = [p for p, cmd in children(proc.pid) if "gunicorn" in cmd or "app:app" in cmd]
            app_pid = kids[0] if kids else proc.pid
        samples, stop = [], threading.Event()

        def sampler():
            while not stop.is_set():
                samples.append([(p, cmd, listening(p)) for p, cmd in children(app_pid)])
                time.sleep(0.05)
        th = threading.Thread(target=sampler, daemon=True)
        th.start()
        journal = os.path.join(REPORT, "sos_commands", "logs", "journalctl_--no-pager")
        t0 = time.monotonic()
        ev = stream_events("/log_histogram_stream", {"directory": REPORT, "report_type": "sosreport", "paths": [journal]})
        took = time.monotonic() - t0
        stop.set()
        th.join(5)
        res = (ev[-1] if ev else {}).get("result") or {}
        run = (res.get("stats") or {}).get("run") or {}
        check(f"{label}: the Histogram analysis ran in 3 worker processes (no fallback)", run.get("mode") == "parallel" and run.get("workers") == 3 and run.get("fallback") is None, (run, str(ev[-1])[:300] if ev else None))
        kinds = {a["kind"] for a in res.get("anomalies") or []}
        check(f"{label}: ... and found the planted anomalies (errors, volume, burst, new, stopped, rare)", {"errors", "volume", "burst", "new", "stopped", "rare"} <= kinds, kinds)
        seen = {}
        for snap in samples:
            for p, cmd, lis in snap:
                seen.setdefault(p, (cmd, []))[1].extend(lis)
        workers = [p for p, (cmd, _) in seen.items() if is_worker(cmd)]
        others = [(p, cmd[:160]) for p, (cmd, _) in seen.items() if not is_worker(cmd) and not is_tracker(cmd)]
        check(f"{label}: while it ran, the app's children were spawned workers and the resource tracker only - no second app",
              len(workers) >= 3 and not others, {"workers": len(workers), "others": others[:5], "samples": len(samples)})
        check(f"{label}: no child of the app listened on a port (the port is the app's alone)", all(not lis for _, (_, lis) in seen.items()), {p: lis for p, (_, lis) in seen.items() if lis})
        time.sleep(1.0)
        after = children(app_pid)
        check(f"{label}: after the analysis no worker is left (only the resource tracker may stay)", not [c for c in after if is_worker(c[1])], after)
        print(f"  ({label}: the analysis took {took:.1f} s over {res.get('stats', {}).get('lines', 0):,} lines, {len(workers)} workers seen)")

        big_journal = os.path.join(BIG, "sos_commands", "logs", "journalctl_--no-pager")
        out = {}

        def run_big():
            out["events"] = stream_events("/log_histogram_stream", {"directory": BIG, "report_type": "sosreport", "paths": [big_journal]})
        t = threading.Thread(target=run_big)
        t.start()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not [c for c in children(app_pid) if is_worker(c[1])]:
            time.sleep(0.05)
        with post("/log_histogram_cancel", {"directory": BIG}) as resp:
            cancel_answer = json.loads(resp.read().decode())
        t.join(60)
        last = (out.get("events") or [{}])[-1]
        check(f"{label}: a cancel mid-analysis: the route answers ok and the stream ends with cancelled", cancel_answer == {"ok": True} and last.get("cancelled") is True, last if "result" not in last else "the analysis finished before the cancel")
        gone = False
        for _ in range(60):
            if not [c for c in children(app_pid) if is_worker(c[1])]:
                gone = True
                break
            time.sleep(0.1)
        check(f"{label}: after the cancel the worker processes are gone within 6 s", gone, children(app_pid))

        # ---- the sosreport Log Viewer's stream: the same rows, from worker processes
        samples.clear()
        stop.clear()
        th = threading.Thread(target=sampler, daemon=True)
        th.start()
        t0 = time.monotonic()
        ev = stream_events("/parse_log_viewer_stream", {"directory": REPORT, "log_paths": [journal], "start_date": "2026-10-12T00:00", "end_date": "2026-10-12T23:59"})
        took = time.monotonic() - t0
        stop.set()
        th.join(5)
        rows = [e for chunk in ev for e in (chunk.get("entries") or [])]
        sys.path.insert(0, BACKEND)
        import contextlib
        import io
        from datetime import datetime
        from parsers.sosreport import log_viewer as slv
        with contextlib.redirect_stdout(io.StringIO()):
            serial = list(slv.JournalctlParser().parse_entries_streaming(journal, datetime(2026, 10, 12, 0, 0), datetime(2026, 10, 12, 23, 59)))
        check(f"{label}: the Log Viewer stream sends exactly the rows of a serial parse ({len(serial):,}), in order, then done", rows == serial and ev and ev[-1].get("done") is True, (len(rows), len(serial)))
        seen = {}
        for snap in samples:
            for p, cmd, lis in snap:
                seen.setdefault(p, (cmd, []))[1].extend(lis)
        workers = [p for p, (cmd, _) in seen.items() if is_worker(cmd)]
        others = [(p, cmd[:160]) for p, (cmd, _) in seen.items() if not is_worker(cmd) and not is_tracker(cmd)]
        check(f"{label}: the Log Viewer stream read the journal in worker processes - no second app, no port", len(workers) >= 2 and not others and all(not lis for _, (_, lis) in seen.items()), {"workers": len(workers), "others": others[:3]})
        print(f"  ({label}: the Log Viewer stream took {took:.1f} s for {len(rows):,} rows)")
        # a newer load of the same report stops the older one's workers; a client that goes away stops its own
        out = {}

        def first_load():
            try:
                out["events"] = stream_events("/parse_log_viewer_stream", {"directory": BIG, "log_paths": [big_journal], "start_date": "2026-10-12T00:00", "end_date": "2026-10-12T23:59"})
            except Exception as e:  # noqa: BLE001 - recorded: a crash is not a cancel
                out["error"] = repr(e)
        t = threading.Thread(target=first_load)
        t.start()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not [c for c in children(app_pid) if is_worker(c[1])]:
            time.sleep(0.05)
        req = urllib.request.Request(base + "/parse_log_viewer_stream", data=json.dumps({"directory": BIG, "log_paths": [big_journal], "start_date": "2026-10-12T00:00", "end_date": "2026-10-12T23:59"}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-App-Token": token, "X-Requested-With": "Jacarium"})
        second = urllib.request.urlopen(req, timeout=300)
        second.read(64)          # the newer load has started
        t.join(60)
        first_events = out.get("events")
        check(f"{label}: a newer load of the same report stops the older stream (it ends, without 'done' - maybe before its first batch)",
              "error" not in out and first_events is not None and not (first_events and first_events[-1].get("done")), (out.get("error"), len(first_events or []), (first_events or [None])[-1]))
        second.close()           # and the newer one's client goes away mid-stream
        gone = False
        for _ in range(150):
            if not [c for c in children(app_pid) if is_worker(c[1])]:
                gone = True
                break
            time.sleep(0.1)
        check(f"{label}: a client that goes away mid-stream leaves no worker behind (gone within 15 s)", gone, children(app_pid))
    finally:
        kids = [p for p, _ in children(proc.pid)]
        proc.terminate()
        try:
            proc.wait(30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(10)
        time.sleep(1.5)
        alive = [p for p in kids if subprocess.run(["ps", "-p", str(p)], capture_output=True).returncode == 0]
        check(f"{label}: after the backend stops, none of its children is left", not alive, alive)
        log.close()


# ---------------------------------------------------------------- the frozen backend
exe = os.environ.get("FROZEN_BACKEND") or os.path.join(BACKEND, "dist", "flask-backend", "flask-backend")
built_dir = None


def newest_backend_source():
    """(mtime, path) of the newest file the frozen build is made from: the backend's Python, templates, static
    assets, the spec and the requirements - not its venv, build and dist directories."""
    newest = (0.0, None)
    skip = {"venv", "dist", "build", "__pycache__", ".pytest_cache", "node_modules"}
    for root, dirs, files in os.walk(BACKEND):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
        for name in files:
            if name.endswith((".py", ".html", ".js", ".css", ".json", ".txt", ".spec", ".toml", ".cfg")):
                full = os.path.join(root, name)
                try:
                    m = os.path.getmtime(full)
                except OSError:
                    continue
                if m > newest[0]:
                    newest = (m, full)
    return newest


# a frozen backend older than the source it was built from runs old code: a stale one is rebuilt
# (FROZEN_BUILD=1) or skipped with a clear message, never tested as if it were current
stale = None
if os.path.isfile(exe):
    src_mtime, src_path = newest_backend_source()
    exe_mtime = os.path.getmtime(exe)
    if src_path and src_mtime > exe_mtime:
        stale = (f"stale frozen backend: {exe} was built {time.strftime('%Y-%m-%d %H:%M', time.localtime(exe_mtime))}, "
                 f"{os.path.relpath(src_path, REPO)} changed {time.strftime('%Y-%m-%d %H:%M', time.localtime(src_mtime))} - rebuild it "
                 f"(cd backend && venv/bin/python -m PyInstaller flask-backend.spec --noconfirm) or set FROZEN_BUILD=1")
if stale and os.environ.get("FROZEN_BUILD") != "1":
    print(f"SKIP (frozen): {stale}")
    exe = ""
elif stale:
    print(f"{stale}: building a fresh one")
    exe = ""
if not os.path.isfile(exe) and os.environ.get("FROZEN_BUILD") == "1":
    py = os.path.join(VENV_BIN, "python")
    if subprocess.run([py, "-m", "PyInstaller", "--version"], capture_output=True).returncode != 0:
        print("SKIP (frozen): PyInstaller is not installed in backend/venv")
    elif not os.path.isdir(os.path.join(BACKEND, "static", "vendor")):
        print("SKIP (frozen): backend/static/vendor missing (node scripts/vendor-assets.mjs)")
    else:
        built_dir = tempfile.mkdtemp(prefix="frozen-backend-")
        print(f"building the frozen backend into {built_dir} ...")
        b = subprocess.run([py, "-m", "PyInstaller", "flask-backend.spec", "--noconfirm", "--distpath", os.path.join(built_dir, "dist"),
                            "--workpath", os.path.join(built_dir, "build")], cwd=BACKEND, capture_output=True, text=True)
        check("the frozen backend builds (PyInstaller, flask-backend.spec)", b.returncode == 0, b.stderr[-1500:])
        exe = os.path.join(built_dir, "dist", "flask-backend", "flask-backend")
if os.path.isfile(exe):
    r = subprocess.run([exe, "--runtime-version"], capture_output=True, text=True, timeout=120)
    check("frozen: --runtime-version prints the frozen Python (X.Y.Z) and exits 0, nothing else", r.returncode == 0 and r.stdout.strip().count(".") == 2 and "Starting Flask" not in r.stdout, (r.returncode, r.stdout[-300:], r.stderr[-300:]))
    r = subprocess.run([exe, "--selftest-parallel"], capture_output=True, text=True, timeout=300)
    try:
        st = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        st = {}
    pool = st.get("pool") or {}
    check("frozen: --selftest-parallel runs a pool job in 3 worker processes of the frozen executable (distinct pids, not the parent's)",
          r.returncode == 0 and st.get("frozen") and pool.get("mode") == "parallel" and len(pool.get("pids") or []) >= 2 and st.get("parent_pid") not in (pool.get("pids") or []) and pool.get("results_ok"), (r.returncode, r.stdout[-600:], r.stderr[-600:]))
    check("frozen: --selftest-parallel's Histogram analysis runs in worker processes, identical to a serial run, no worker left",
          (st.get("histogram") or {}).get("mode") == "parallel" and (st.get("histogram") or {}).get("fallback") is None and st.get("identical") and st.get("alive_after") == 0, st)
    check("frozen: --selftest-parallel never starts the app (no 'Starting Flask backend' line)", "Starting Flask" not in r.stdout + r.stderr)
    run_target("frozen", [exe], WORK)
elif not stale:
    print("SKIP (frozen): no frozen backend (set FROZEN_BACKEND=<path> or FROZEN_BUILD=1 to build one)")

# ---------------------------------------------------------------- the container's gunicorn
gunicorn = os.path.join(VENV_BIN, "gunicorn")
if os.path.exists(gunicorn):
    # deploy/entrypoint.sh's command: one gthread worker, app:app from backend/
    run_target("gunicorn", [gunicorn, "--bind", "127.0.0.1:{PORT}", "--workers", "1", "--worker-class", "gthread", "--threads", "8", "--timeout", "600",
                            "--graceful-timeout", "20", "app:app"], BACKEND)
else:
    print("SKIP (gunicorn): not installed in backend/venv")

shutil.rmtree(WORK, ignore_errors=True)
if built_dir:
    shutil.rmtree(built_dir, ignore_errors=True)
print(f"\n{'FAIL' if FAILED else 'OK'}: {FAILED} failed")
sys.exit(1 if FAILED else 0)
