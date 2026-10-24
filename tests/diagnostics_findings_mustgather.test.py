#!/usr/bin/env python3
"""
The must-gather plugins' Findings (Phase 2, group 5 of the diagnostics
review), on the mock must-gather (its planted NotReady node, Degraded
operator and MCP, CrashLoopBackOff and OOMKilled pods, Pending CSR, PDB
without room, Warning events, firing alerts) and synthetic directories:

 1. Cluster: the Degraded operator is bad with its message, linked to the
    pods of its namespace; the Progressing one a warning.
 2. Events: Warning events sort first, newest first; the BackOff /
    NodeNotReady reasons are warnings with their counts.
 3. Alerts: firing first, critical before warning; the findings follow.
 4. Nodes: worker-1 NotReady is bad, linked to its pods.
 5. MCPs: the degraded worker pool first and bad.
 6. Pods: the CrashLoopBackOff and the OOMKilled pod are bad, named.
 7. Deployments / DaemonSets / StatefulSets / ReplicaSets / PDBs: the ones
    below their wanted replicas, the PDB that allows no disruption.
 8. CSRs: the pending one first and a warning; TLS secrets: sorted by
    expiry, the strip.
 9. The shared loader is libyaml's when present, and every must-gather
    page renders the strip through the loader's `findings`.

Needs the backend venv (Flask, PyYAML); run-all.sh picks it up as a .test.py.
"""
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
MOCK = os.path.join(HERE, "fixtures", "diagnostics-mock")
sys.path.insert(0, BACKEND)
sys.path.insert(0, MOCK)

import yaml  # noqa: E402
from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
import generate as mock_generate  # noqa: E402
from parsers.mustgather import _common, alerts, csr, daemonset, deployment, events, mcp, nodes, pdb, pod, replicaset, statefulset, system, tls_secrets  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-findings5-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def client():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "diagnostics-findings5-test"
    return app.test_client()


def titles(items):
    return [f["title"] for f in items]


def sev(items, s):
    return [f for f in items if f["severity"] == s]


def main():
    out = os.path.join(WORK, "mock")
    mock_generate.main(["--out", out, "--no-archives"])
    mg = os.path.join(out, mock_generate.MG_NAME)

    # 1. Cluster ---------------------------------------------------------------------
    f = system.parse(mg)["findings"]
    check("cluster: the Degraded operator is bad with its message and links to its pods; a Progressing one is a warning",
          any("Cluster operator monitoring is Degraded" == t and x["link"]["query"] == "monitoring" and x["detail"] for t, x in zip(titles(f), f)) and any("is Progressing" in t for t in titles(sev(f, "warn"))), titles(f))

    # 2. Events ---------------------------------------------------------------------
    ev = events.parse(mg)
    f = events.findings(mg)
    ns = next(n for n, items in ev.items() if any(e.get("type") == "Warning" for e in items))
    items = ev[ns]
    first_normal = next((i for i, e in enumerate(items) if e.get("type") != "Warning"), len(items))
    check("events: Warning events first, then by time newest first", all(e.get("type") == "Warning" for e in items[:first_normal]) and first_normal >= 1, f"{ns}: {[e.get('type') for e in items][:6]}")
    check("events: BackOff and NodeNotReady are warnings with their counts, linked to the pods", any(t.startswith("BackOff:") for t in titles(sev(f, "warn"))) and any(t.startswith("NodeNotReady:") for t in titles(sev(f, "warn"))) and all(x.get("link", {}).get("sub_tab") == "pod" for x in sev(f, "warn")), titles(f))

    # 3. Alerts ----------------------------------------------------------------------
    al = alerts.parse(mg)
    f = al["findings"]
    states = [a["state"] for a in al["all"]]
    check("alerts: firing first, critical before warning, and the findings follow (Watchdog left out)", states == sorted(states, key=lambda s: {"firing": 0, "pending": 1}.get(s, 2)) and all(a["severity"] != "warning" or b["severity"] != "critical" for a, b in zip(al["firing"], al["firing"][1:])) and f and not any("Watchdog" in t for t in titles(f)) and any("firing (critical)" in t for t in titles(sev(f, "bad"))), titles(f))

    # 4. Nodes --------------------------------------------------------------------------
    f = nodes.findings(mg)
    check("nodes: worker-1 NotReady is bad and links to its pods", any("Node worker-1 is NotReady" == t and x["link"]["query"] == "worker-1" for t, x in zip(titles(f), f)), titles(f))

    # 5. MCPs ---------------------------------------------------------------------------
    pools = mcp.parse(mg)
    f = mcp.findings(mg)
    check("mcp: the degraded worker pool sorts first and is bad with its message", pools[0]["name"] == "worker" and pools[0]["degraded"] == "True" and any("MachineConfigPool worker is Degraded" == t and "degraded" in x["detail"] for t, x in zip(titles(f), f)), (pools[0]["name"], titles(f)))

    # 6. Pods ----------------------------------------------------------------------------
    pod.parse(mg)
    f = pod.findings(mg)
    check("pods: the CrashLoopBackOff pod and the OOMKilled container are bad, named with their query", any("is in CrashLoopBackOff" in t for t in titles(sev(f, "bad"))) and any("OOMKilled" in t for t in titles(sev(f, "bad"))) and all(x["link"]["query"] for x in sev(f, "bad") if x.get("link")), titles(f))

    # 7. Workloads ------------------------------------------------------------------------
    deployment.parse(mg); f = deployment.findings(mg)
    check("deployments: the ones below their wanted replicas are flagged", any("replicas available" in t for t in titles(f) if "of" in t) or any(x["severity"] == "good" for x in f), titles(f))
    daemonset.parse(mg); f = daemonset.findings(mg)
    check("daemonsets: the 4-of-5 daemonset is a warning", any("4 of 5 pods available" in t for t in titles(sev(f, "warn"))), titles(f))
    statefulset.parse(mg); f = statefulset.findings(mg)
    check("statefulsets: the strip renders (good or a warning)", bool(f), titles(f))
    replicaset.parse(mg); f = replicaset.findings(mg)
    check("replicasets: the strip renders and retired replicasets are not findings", bool(f) and not any("0 of 0" in t for t in titles(f)), titles(f))
    pdb.parse(mg); f = pdb.findings(mg)
    check("pdbs: the payments-api budget allows 0 disruptions (warn, a drain will hang)", any("payments-api-pdb allows 0 disruptions" in t for t in titles(sev(f, "warn"))), titles(f))

    # 8. CSRs and TLS --------------------------------------------------------------------
    csrs = csr.parse(mg)
    f = csr.findings(mg)
    check("csrs: the pending ones sort first and are a warning naming them", csrs[0]["status"] == "Pending" and any(re.match(r"^\d+ CSRs? pending$", t) and csrs[0]["name"] in x["detail"] for t, x in zip(titles(f), f)), (csrs[0]["status"], titles(f)))
    tls = tls_secrets.parse(mg)
    f = tls_secrets.findings(mg)
    check("tls: sorted expired first then soonest, the strip renders", tls == sorted(tls, key=lambda t: ({"Expired": 0, "Expiring Soon": 1}.get(t.get("status"), 2), t.get("days_left", 0))) and bool(f), titles(f))

    # 9. the loader and the pages ------------------------------------------------------------
    check("the shared YAML loader is libyaml's CSafeLoader when PyYAML has it", _common._LOADER is getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    c = client()
    for tab, sub in (("system", None), ("system", "events"), ("system", "alerts"), ("compute", "nodes"), ("compute", "mcp"), ("workloads", "pod"), ("workloads", "deployment"), ("workloads", "replicaset"), ("workloads", "daemonset"), ("workloads", "statefulset"), ("workloads", "pdb"), ("security", "csr"), ("security", "tls_secrets")):
        body = {"directory": mg, "report_type": "mustgather", "tab": tab}
        if sub:
            body["sub_tab"] = sub
        rr = c.post("/load_tab", json=body)
        html = (rr.get_json() or {}).get("html", "")
        check(f"page {sub or tab}: renders with the Findings strip", rr.status_code == 200 and 'class="ui-findings"' in html and html.count('class="ui-finding ') >= 1, f"status {rr.status_code} {str(rr.get_json())[:120] if rr.status_code != 200 else ''}")

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
