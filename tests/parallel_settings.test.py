#!/usr/bin/env python3
"""Settings > General > Performance: the worker count of the backend's parallel work (backend/parallel_settings.py,
backend/parsers/parallel.py).

  - GET /api/settings/parallel: the BACKEND machine's cores, what Auto means there, the stored choice, the count in
    effect, the JACARIUM_WORKERS override, whether this user may change it;
  - Auto: the cores less one, at most 8 - 1 on a 1- or 2-core machine (simulated), 8 on 16 cores;
  - PUT {"workers": "auto" | n}: n from 1 to the cores; 0, negative, above the cores, a string, a fraction, a
    boolean, null or nothing are refused (400) and change nothing; stored per installation, applied to the next run;
  - the pool takes it: 1 -> serial, n -> n worker processes (parallel.run and the Histogram engine);
  - JACARIUM_WORKERS wins: GET shows it, PUT is refused (409);
  - the role rule: the desktop / a single-user container (app-token, no auth) may change it; on a server with
    accounts only an administrator may (a user: 403, still reads it), over a linked device with the step-up.
Run with the backend venv's Python: backend/venv/bin/python tests/parallel_settings.test.py
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(REPO, "backend"))
sys.path.insert(0, os.path.join(HERE, "helpers"))

WORK = tempfile.mkdtemp(prefix="parallel-settings-")
os.environ["JACARIUM_PARALLEL_SETTINGS"] = os.path.join(WORK, "workers.json")
os.environ.pop("JACARIUM_WORKERS", None)
os.environ.pop("JACARIUM_AUTH_MODE", None)

from flask import Flask, g  # noqa: E402
from parsers import parallel  # noqa: E402
import parallel_jobs as jobs  # noqa: E402
import parallel_settings  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:600]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


CORES = {"n": 12}
parallel.cpu_count = lambda: CORES["n"]   # a simulated machine
USER = {"u": None}
app = Flask(__name__)
app.register_blueprint(parallel_settings.parallel_settings_api)


@app.before_request
def _user():
    g.user = USER["u"]


c = app.test_client()


def get():
    return c.get("/api/settings/parallel").get_json()


def put(value, raw=None):
    r = c.put("/api/settings/parallel", data=raw if raw is not None else json.dumps({"workers": value}), content_type="application/json")
    return r.status_code, r.get_json()


if __name__ == "__main__":
    v = get()
    check("GET: the machine's cores, Auto there, the stored choice (auto by default), the count in effect, no override, changeable on the desktop", v == {"cores": 12, "auto": 8, "value": "auto", "effective": 8, "override": None, "max": 12, "canChange": True, "reason": None}, v)
    for cores, auto in ((1, 1), (2, 1), (3, 2), (4, 3), (8, 7), (9, 8), (16, 8), (64, 8)):
        CORES["n"] = cores
        check(f"Auto on {cores} cores uses {auto} (the cores less one, at least 1, at most 8)", get()["auto"] == auto and parallel.default_workers() == auto and parallel.auto_workers(cores) == auto, get())
    CORES["n"] = 2
    info = {}
    parallel.run(jobs.square, list(range(6)), info=info)
    check("on a simulated 2-core machine Auto reads serially (one process)", info.get("mode") == "serial", info)
    CORES["n"] = 12

    # ---- validation
    for value, raw, label in ((0, None, "0"), (-3, None, "a negative number"), (13, None, "above the cores (13 of 12)"), ("4", None, "a string"), (2.5, None, "a fraction"),
                              (True, None, "a boolean"), (None, None, "null"), (None, "{}", "no workers"), (None, "not json", "not JSON"), (None, "[4]", "a list")):
        code, body = put(value, raw)
        check(f"PUT {label} is refused (400) and changes nothing", code == 400 and get()["value"] == "auto", (code, body))
    code, body = put(1)
    check("PUT 1 (off): stored, in effect at once", code == 200 and body["value"] == 1 and body["effective"] == 1 and parallel.default_workers() == 1, (code, body))
    info = {}
    res = parallel.run(jobs.square, list(range(8)), info=info)
    check("... the pool reads serially (1 -> one process)", info.get("mode") == "serial" and [r["square"] for r in res] == [x * x for x in range(8)], info)
    code, body = put(3)
    info = {}
    parallel.run(jobs.square, list(range(8)), info=info)
    check("PUT 3: the next run uses 3 worker processes", code == 200 and body["effective"] == 3 and info.get("mode") == "parallel" and info.get("workers") == 3, (code, body, info))
    from parsers import log_histogram as eng
    code, body = put(12)
    check("PUT the core count itself (12) is accepted", code == 200 and body["value"] == 12)
    code, body = put(2)
    sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))
    import mock_log_anomalies as mla  # noqa: E402 - tests/fixtures/diagnostics-mock
    root, _ = mla.planted_sosreport(WORK)
    journal = os.path.join(root, "sos_commands", "logs", "journalctl_--no-pager")
    src = [{"path": journal, "size": os.path.getsize(journal), "kind": "auto", "prefix": "", "label": "j", "link": "j", "year": 2026, "ref": None}]
    saved = eng.LIMITS["parallel_min_bytes"]
    eng.LIMITS["parallel_min_bytes"] = 0
    try:
        r = eng.analyse(eng.plan_items(src))
    finally:
        eng.LIMITS["parallel_min_bytes"] = saved
    check("... and the Histogram's next analysis takes the setting (2 -> 2 worker processes)", r["stats"]["run"].get("workers") == 2 and r["stats"]["run"].get("mode") == "parallel", r["stats"]["run"])
    with open(os.environ["JACARIUM_PARALLEL_SETTINGS"]) as f:
        stored = json.load(f)
    check("stored per installation in the setting file, as {\"workers\": n}", stored == {"workers": 2}, stored)
    code, body = put("auto")
    check("PUT \"auto\" goes back to Auto", code == 200 and body["value"] == "auto" and body["effective"] == 8)
    CORES["n"] = 4
    put(4)
    CORES["n"] = 2
    check("a stored number above a smaller machine's cores is used as the cores allow (4 stored, 2 cores -> 2)", parallel.default_workers() == 2 and get()["value"] == 4, get())
    CORES["n"] = 12
    put("auto")
    with open(os.environ["JACARIUM_PARALLEL_SETTINGS"], "w") as f:
        f.write("{not json")
    check("an unreadable setting file counts as Auto", parallel.default_workers() == 8 and get()["value"] == "auto")
    put("auto")

    # ---- the environment override
    os.environ["JACARIUM_WORKERS"] = "5"
    v = get()
    code, body = put(3)
    check("JACARIUM_WORKERS wins: GET shows it as the override (5 in effect, not changeable, the reason says so), PUT is refused (409)",
          v["override"] == 5 and v["effective"] == 5 and not v["canChange"] and "JACARIUM_WORKERS" in (v["reason"] or "") and code == 409 and parallel.default_workers() == 5, (v, code, body))
    del os.environ["JACARIUM_WORKERS"]

    # ---- who may change it
    os.environ["JACARIUM_AUTH_MODE"] = "accounts"
    USER["u"] = {"id": 2, "username": "user1", "role": "user"}
    v = get()
    code, body = put(2)
    check("a server with accounts: a user reads it (not changeable, the reason names administrators), a change is refused (403)", not v["canChange"] and "administrator" in (v["reason"] or "") and code == 403 and get()["value"] == "auto", (v, code, body))
    USER["u"] = {"id": 1, "username": "admin", "role": "admin"}
    v = get()
    code, body = put(2)
    check("... an administrator may change it", v["canChange"] and code == 200 and body["value"] == 2, (v, code, body))
    USER["u"] = None
    code, _ = put(3)
    check("... nobody signed in: refused (401)", code == 401, code)
    os.environ.pop("JACARIUM_AUTH_MODE", None)

    shutil.rmtree(WORK, ignore_errors=True)
    print(f"\n{'FAIL' if FAILED else 'OK'}: {FAILED} failed")
    sys.exit(1 if FAILED else 0)
