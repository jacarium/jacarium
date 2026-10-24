#!/usr/bin/env python3
"""The must-gather Audit tabs: the audit-log scan
(backend/parsers/mustgather/audit_logs.py), the three tab modules and
their templates through the Flask test client, the registry.

The synthetic must-gather's audit logs come from
tests/fixtures/diagnostics-mock/mock_audit_logs.py, which returns the
events it wrote, so every expectation below is computed from that plan
and compared with the parser: exact totals, per apiserver and node,
status codes, verbs, users, the forbidden / throttled / sensitive-delete
/ RBAC / secret-read / impersonation lists, the slowest requests, the
timeline spike, rotation and gzip plus a plain audit.log, the malformed
lines, the sample caps, empty and missing audit_logs/, hostile strings
escaped in the pages, the empty states, the group's place in the sidebar.
Run with the backend venv's Python: backend/venv/bin/python tests/mustgather_audit_logs.test.py
"""
import gzip
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

from flask import Flask  # noqa: E402
import log_viewer as lv  # noqa: E402
import mock_audit_logs  # noqa: E402
from parsers.mustgather import audit_logs, audit, audit_profile, audit_search  # noqa: E402

FAILED = 0
WORKDIR = tempfile.mkdtemp(prefix="mg-audit-")
IMAGE = "quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-" + "0b" * 32


def check(label, ok, detail=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {label}" + (f" | {str(detail)[:500]}" if not ok and detail else ""))
    if not ok:
        FAILED += 1


class Tree:
    def __init__(self, base):
        self.base = base

    def write_bytes(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)


def tree(name, lines=None, gz=True, image=True, apiserver="kube-apiserver", node="master-0"):
    root = os.path.join(WORKDIR, name)
    base = os.path.join(root, IMAGE) if image else root
    os.makedirs(os.path.join(base, "namespaces"), exist_ok=True)
    if lines is not None:
        path = os.path.join(base, "audit_logs", apiserver, f"{node}-audit.log" + (".gz" if gz else ""))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        text = "\n".join(lines) + "\n"
        if gz:
            with gzip.open(path, "wt") as f:
                f.write(text)
        else:
            with open(path, "w") as f:
                f.write(text)
    return root


def ev(**kw):
    e = {"kind": "Event", "apiVersion": "audit.k8s.io/v1", "level": "Metadata", "auditID": "00000000-0000-4000-8000-000000000001", "stage": "ResponseComplete",
         "requestURI": "/api/v1/namespaces/demo/pods", "verb": "list", "user": {"username": "alice", "groups": []}, "sourceIPs": ["192.0.2.9"], "userAgent": "kubectl/v1.29.4",
         "objectRef": {"resource": "pods", "namespace": "demo", "apiVersion": "v1"}, "responseStatus": {"metadata": {}, "code": 200},
         "requestReceivedTimestamp": "2026-10-12T12:00:00.000000Z", "stageTimestamp": "2026-10-12T12:00:00.050000Z", "annotations": {"authorization.k8s.io/decision": "allow", "authorization.k8s.io/reason": ""}}
    for k, v in kw.items():
        if isinstance(v, dict) and isinstance(e.get(k), dict):
            e[k].update(v)
        else:
            e[k] = v
    return e


def main():
    print("--- 1. the synthetic audit logs against the generator's plan ---")
    root = os.path.join(WORKDIR, "mock")
    base = os.path.join(root, IMAGE)
    os.makedirs(os.path.join(base, "namespaces"))
    # the diagnostics mock's shape: "Mixed" (master-2 records write bodies) and the APIServer config with a custom rule
    plan = mock_audit_logs.write(Tree(base), profile="Mixed")
    cfg_dir = os.path.join(base, "cluster-scoped-resources", "config.openshift.io", "apiservers")
    os.makedirs(cfg_dir)
    with open(os.path.join(cfg_dir, "cluster.yaml"), "w") as f:
        f.write("apiVersion: config.openshift.io/v1\nkind: APIServer\nmetadata:\n  name: cluster\nspec:\n  audit:\n    profile: Default\n    customRules:\n    - group: system:authenticated:oauth\n      profile: WriteRequestBodies\n")
    events = plan["events"]
    done = [e for e in events if e["stage"] == "ResponseComplete"]
    a = audit_logs.parse(root)["audit_logs"]
    t = a["totals"]
    check("the image directory is unwrapped and every file found (the rotated kube-apiserver files, the gzip ones, the plain monitoring audit.log, not the termination logs or listings)",
          a["image_dir"] == IMAGE and t["files"] == 16 and sum(1 for f in a["files"] if f["rotated"]) == 3 and sum(1 for f in a["files"] if not f["gz"]) == 1 and not any("termination" in f["name"] or "listing" in f["name"] for f in a["files"]), str([(f["apiserver"], f["name"]) for f in a["files"]]))
    check(f"every ResponseComplete event is counted once ({len(done)} + the 12 monitoring ones), the ResponseStarted watches apart, nothing received-only",
          t["events"] == len(done) + plan["monitoring_events"] and t["started"] == sum(1 for e in events if e["stage"] == "ResponseStarted") and t["received_only"] == 0, str((t["events"], len(done), t["started"])))
    check(f"the malformed lines are counted ({plan['malformed']}: a truncated object, text, a list, a non-Event object; the empty line skipped) and the line total adds up",
          t["malformed"] == plan["malformed"] and t["lines"] == len(events) + plan["monitoring_events"] + plan["malformed"] + 3, str((t["malformed"], t["lines"], len(events))))
    per_api = {s["name"]: s for s in a["apiservers"]}
    exp_api = Counter(e["_apiserver"] for e in done)
    check("per apiserver: the events, errors, watches and nodes match the plan (kube-apiserver on three masters, monitoring from the plain file)",
          all(per_api[k]["events"] == v for k, v in exp_api.items()) and per_api["monitoring"]["events"] == 12
          and per_api["kube-apiserver"]["errors"] == sum(1 for e in done if e["_apiserver"] == "kube-apiserver" and e["responseStatus"]["code"] >= 400)
          and per_api["kube-apiserver"]["watches"] == sum(1 for e in events if e["_apiserver"] == "kube-apiserver" and e["stage"] == "ResponseStarted")
          and sorted(n["name"] for n in per_api["kube-apiserver"]["nodes"]) == ["master-0", "master-1", "master-2"], str({k: (v["events"], v["errors"], v["watches"]) for k, v in per_api.items()}))
    exp_codes = Counter(e["responseStatus"]["code"] for e in done); exp_codes[200] += 12
    check("the status-code distribution is exact", {c["code"]: c["count"] for c in a["codes"]} == dict(exp_codes), str((a["codes"], dict(exp_codes))))
    exp_verbs = Counter(e["verb"] for e in done); exp_verbs["get"] += 12
    check("the verb distribution is exact and carries the error counts", {v["name"]: v["count"] for v in a["verbs"]} == dict(exp_verbs) and next(v for v in a["verbs"] if v["name"] == "list")["errors"] == sum(1 for e in done if e["verb"] == "list" and e["responseStatus"]["code"] >= 400), str(a["verbs"]))
    exp_users = Counter(e["user"]["username"] for e in done); exp_users[mock_audit_logs.SERVICE_ACCOUNTS[0][0]] += 12
    users = {u["name"]: u for u in a["users"]}
    check("the top users match with their kinds (service accounts, nodes, humans) and errors", all(users[u]["count"] == c for u, c in exp_users.most_common(10)) and users["alice"]["kind"] == "user"
          and users["system:node:master-0"]["kind"] == "node" and users[mock_audit_logs.SERVICE_ACCOUNTS[0][0]]["kind"] == "serviceaccount"
          and users["alice"]["errors"] == sum(1 for e in done if e["user"]["username"] == "alice" and e["responseStatus"]["code"] >= 400), str(a["users"][:5]))
    check("agents, IPs, namespaces and resources are counted (the noisy scanner agent, the documentation IPs, group/resource keys)",
          {x["name"]: x["count"] for x in a["agents"]}[mock_audit_logs.NOISY[1]] == 400 and {x["name"]: x["count"] for x in a["ips"]}[mock_audit_logs.NOISY[2]] == 400
          and {x["name"]: x["count"] for x in a["namespaces"]}["demo-app"] == sum(1 for e in done if e["objectRef"].get("namespace") == "demo-app")
          and {x["name"]: x["count"] for x in a["resources"]}["rbac.authorization.k8s.io/rolebindings"] == sum(1 for e in done if e["objectRef"].get("resource") == "rolebindings"), str(a["resources"][:5]))
    exp_forbidden = sum(1 for e in done if e["responseStatus"]["code"] == 403)
    exp_rbac_reason = sum(1 for e in done if e["responseStatus"]["code"] == 403 and e["annotations"]["authorization.k8s.io/reason"] == "RBAC: no RBAC policy matched")
    check(f"forbidden: {exp_forbidden} decisions, the reason ({exp_rbac_reason} x 'no RBAC policy matched', the rest from the status message) and the users counted, the first {audit_logs.SAMPLE} kept as events with the raw JSON",
          a["forbidden"]["count"] == exp_forbidden == t["forbidden"] and a["forbidden"]["reasons"][0] == {"name": "RBAC: no RBAC policy matched", "count": exp_rbac_reason} and sum(r["count"] for r in a["forbidden"]["reasons"]) == exp_forbidden
          and a["forbidden"]["users"][0]["name"] == mock_audit_logs.NOISY[0] and a["forbidden"]["users"][0]["count"] == 400 and len(a["forbidden"]["events"]) == audit_logs.SAMPLE
          and all(e["code"] == 403 and '"auditID"' in e["raw"] for e in a["forbidden"]["events"]), str((a["forbidden"]["count"], a["forbidden"]["reasons"][:2], len(a["forbidden"]["events"]))))
    check("throttled: the 20 Prometheus 429s", a["throttled"]["count"] == 20 and a["throttled"]["users"] == [{"name": mock_audit_logs.SERVICE_ACCOUNTS[0][0], "count": 20, "kind": "serviceaccount"}] and len(a["throttled"]["events"]) == 20, str(a["throttled"]["users"]))
    exp_sens = [e for e in done if e["verb"] in ("delete", "deletecollection") and e["objectRef"].get("resource") in audit_logs.SENSITIVE_RESOURCES]
    sens = a["sensitive_deletes"]
    check(f"sensitive deletes: {len(exp_sens)} (the routine deletes of configmaps/secrets/namespaces/rolebindings/CRDs plus the planted ones), the planted namespace delete by bob-admin among them with who/what/when/from",
          sens["count"] == len(exp_sens) and any(e["user"] == "bob-admin" and e["verb"] == "delete" and e["resource"] == "namespaces" and e["name"] == "payments-demo-old" and e["ip"] == "198.51.100.24" and e["code"] == 200 for e in sens["events"])
          and any(e["resource"] == "apiextensions.k8s.io/customresourcedefinitions" and e["user"] == "svc-deployer" for e in sens["events"]), str((sens["count"], len(exp_sens))))
    exp_rbac = sum(1 for e in done if e["objectRef"].get("resource") in audit_logs.RBAC_RESOURCES and e["verb"] in audit_logs.WRITE_VERBS)
    check(f"RBAC changes: {exp_rbac}, incl. the planted rolebinding create, clusterrole patch, role update and clusterrolebinding delete",
          a["rbac_changes"]["count"] == exp_rbac and {(e["verb"], e["resource"].split("/")[-1]) for e in a["rbac_changes"]["events"]} >= {("create", "rolebindings"), ("patch", "clusterroles"), ("update", "roles"), ("delete", "clusterrolebindings")}, str(a["rbac_changes"]["count"]))
    exp_reads = [e for e in done if e["objectRef"].get("resource") == "secrets" and e["verb"] in ("get", "list", "watch") and e["responseStatus"]["code"] < 400 and not e["user"]["username"].startswith("system:")]
    check(f"secret reads by non-system users: {len(exp_reads)} allowed reads by the oauth users incl. alice's three planted gets of demo-app/db-credentials (the 403s and the scanner's denied lists are not reads)",
          a["secret_reads"]["count"] == len(exp_reads) and {u["name"] for u in a["secret_reads"]["users"]} == {e["user"]["username"] for e in exp_reads}
          and sum(1 for e in a["secret_reads"]["events"] if e["user"] == "alice" and e["namespace"] == "demo-app" and e["name"] == "db-credentials") == 3, str(a["secret_reads"]["users"]))
    check("impersonation: bob-admin as the demo-app service account, 4 times", a["impersonation"]["count"] == 4 and a["impersonation"]["pairs"] == [{"user": "bob-admin", "as": "system:serviceaccount:demo-app:default", "count": 4}] and a["impersonation"]["events"][0]["impersonated"] == "system:serviceaccount:demo-app:default", str(a["impersonation"]["pairs"]))
    check("the slowest requests: the planted 8.5 s list first, then 6.2 s, 3.2 s, 2.9 s, 2.1 s; watches excluded; latency text",
          [s["latency_ms"] for s in a["slowest"][:5]] == [8500.0, 6200.0, 3200.0, 2900.0, 2100.0] and a["slowest"][0]["latency"] == "8.5 s" and all(s["verb"] != "watch" for s in a["slowest"]) and len(a["slowest"]) == audit_logs.SLOWEST, str([(s["latency_ms"], s["verb"]) for s in a["slowest"][:6]]))
    tl = a["timeline"]
    spike_bucket = next(b for b in tl["buckets"] if b["t"][:16] == plan["spike_minute"])
    check("the timeline: one-minute buckets over the two hours, the spike minute detected (400 denied lists + 20 throttles on top of the routine), errors per bucket, per apiserver",
          tl["step_minutes"] == 1 and len(tl["spikes"]) == 1 and tl["buckets"][tl["spikes"][0]]["t"][:16] == plan["spike_minute"] and spike_bucket["total"] >= 420 and spike_bucket["errors"] >= 420 and spike_bucket["per"]["kube-apiserver"] >= 420 and set(tl["apiservers"]) == set(per_api), str((tl["step_minutes"], tl["spikes"], spike_bucket)))
    first = min(e["requestReceivedTimestamp"] for e in done)
    check("the time range comes from the events", a["time"]["first"] == first[:19].replace("T", " ") and a["time"]["span_seconds"] > 6000, str(a["time"]))
    check("the group/resource keys use the apiGroup, subresources appended; deprecated API calls counted", any(r["name"].startswith("coordination.k8s.io/leases") for r in a["resources"]) and t["deprecated"] == sum(1 for e in done if "k8s.io/deprecated" in e["annotations"]), str(t["deprecated"]))
    check("the scan is cached and shared by the page module and the search", audit_logs.scan(root) is audit_logs.scan(root) and audit.parse(root)["audit"]["totals"] == t)

    print("\n--- 2. edge cases ---")
    e = ev()
    r = audit_logs.parse(tree("plain", [json.dumps(e)] * 3, gz=False))["audit_logs"]
    check("a plain .log (not gzipped) is read", r["totals"]["events"] == 3 and r["files"][0]["gz"] is False)
    r = audit_logs.parse(tree("stages", [json.dumps(ev(stage="RequestReceived")), json.dumps(ev(stage="ResponseStarted", verb="watch")), json.dumps(ev(stage="Panic", responseStatus={"code": 500})), json.dumps(e)]))["audit_logs"]
    check("stages: RequestReceived counted apart, ResponseStarted as a watch, Panic as an event and a server error", r["totals"]["events"] == 2 and r["totals"]["received_only"] == 1 and r["totals"]["started"] == 1 and r["totals"]["panics"] == 1 and r["totals"]["server_errors"] == 1, str(r["totals"]))
    r = audit_logs.parse(tree("bad", ["{", "", "null", "42", '{"kind":"Event"}', '{"kind":"Event","verb":"get","user":"notadict","objectRef":"x","responseStatus":5,"sourceIPs":"x","annotations":[]}', json.dumps(e)]))["audit_logs"]
    check("malformed lines never raise: a broken object, null, a number, an Event without a verb, odd types inside an Event (counted as one event with defaults)",
          r["totals"]["events"] == 2 and r["totals"]["malformed"] == 4 and r["users"][0]["name"] in ("alice", "anonymous"), str(r["totals"]))
    r = audit_logs.parse(tree("empty-dir"))["audit_logs"]
    os.makedirs(os.path.join(WORKDIR, "empty-dir", IMAGE, "audit_logs", "kube-apiserver"))
    r = audit_logs.parse(tree("empty-dir"))["audit_logs"]
    check("an empty audit_logs/: not available, no exception", not r["available"] and r["totals"]["events"] == 0)
    r = audit_logs.parse(tree("missing"))["audit_logs"]
    check("no audit_logs/ at all: not available with a reason", not r["available"] and "audit_logs" in r["reason"], r["reason"])
    check("a missing directory never raises", not audit_logs.parse(os.path.join(WORKDIR, "nope"))["audit_logs"]["available"])
    many = [json.dumps(ev(responseStatus={"code": 403}, auditID=f"00000000-0000-4000-8000-{i:012x}")) for i in range(audit_logs.SAMPLE + 50)]
    r = audit_logs.parse(tree("cap", many))["audit_logs"]
    check(f"the sample cap: {audit_logs.SAMPLE + 50} forbidden events counted, {audit_logs.SAMPLE} kept", r["forbidden"]["count"] == audit_logs.SAMPLE + 50 and len(r["forbidden"]["events"]) == audit_logs.SAMPLE)
    saved = audit_logs.MAX_LINES_PER_FILE
    audit_logs.MAX_LINES_PER_FILE = 5
    try:
        audit_logs._cache.clear()
        r = audit_logs.parse(tree("linecap", [json.dumps(e)] * 20))["audit_logs"]
        check("the per-file line cap stops the read", r["totals"]["events"] == 5)
    finally:
        audit_logs.MAX_LINES_PER_FILE = saved
    check("parse_ts and user_kind helpers", audit_logs.parse_ts("2026-10-12T12:00:00.123456Z") == datetime(2026, 10, 12, 12, 0, 0, 123456) and audit_logs.parse_ts("junk") is None and audit_logs.parse_ts(None) is None
          and audit_logs.user_kind("system:serviceaccount:a:b") == "serviceaccount" and audit_logs.user_kind("system:node:x") == "node" and audit_logs.user_kind("system:kube-controller-manager") == "system" and audit_logs.user_kind("alice") == "user" and audit_logs.user_kind("") == "anonymous")

    print("\n--- 3. the registry and the Flask renders ---")
    mg = lv.PARSERS["mustgather"]
    keys = list(mg)
    check("Audit is one entry right before Log Collection (last), no sub-tabs", keys[-2:] == ["audit", "log_collection"] and "sub_tabs" not in mg["audit"]
          and mg["audit"]["module"] == "parsers.mustgather.audit" and mg["audit"]["label"] == "Audit", str(keys))
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "mg-audit-test"
    client = app.test_client()

    def tab(directory, tab_name, sub_tab=None):
        payload = {"report_type": "mustgather", "directory": directory, "tab": tab_name, "sub_tab": sub_tab}
        return client.post("/get_tab_data", json=payload), client.post("/load_tab", json=payload)
    pages = {}
    for key, sub in (("audit", None),):
        d, h = tab(root, key, sub)
        html = (h.get_json() or {}).get("html", "")
        pages[sub or key] = html
        check(f"{sub or key}: /get_tab_data and /load_tab answer 200 with a page", d.status_code == 200 and h.status_code == 200 and len(html) > 5000, f"{d.status_code}/{h.status_code} {html[:200]}")
    html = pages["audit"]
    check("the Audit page: no heading of its own (the app titles the tab), the content card first; the filter bar (search, user, verb, resource, namespace, name, status, category, time range), more filters (IP, agent, apiserver, node, URI, limit, stage, the body filters), the status line, the visuals (histogram, status codes, verbs), the list; no profile / strip / tables / presets / From-To; the Changes category live on this bodies fixture",
          "<h2>" not in html and re.search(r'</style>\s*<div class="ae-main"', html)
          and all(s in html for s in ('id="ae-q"', 'id="ae-user"', 'id="ae-verb"', 'id="ae-resource"', 'id="ae-namespace"', 'id="ae-name"', 'id="ae-status"', 'id="ae-category"', 'id="ae-range"', 'id="ae-ip"', 'id="ae-agent"', 'id="ae-apiserver"', 'id="ae-node"', 'id="ae-text"', 'id="ae-limit"', 'id="ae-stage"', 'id="ae-hasbody"', 'id="ae-field"', 'id="ae-ctype"', 'id="audit-events-status"', 'id="audit-events-hist"', 'id="audit-events-codes"', 'id="audit-events-verbs"', 'id="audit-events-list"', 'id="audit-events-more"'))
          and 'id="ae-group"' not in html and 'audit-events-advanced' not in html and 'More filters' not in html
          and not any(s in html for s in ('id="audit-profile"', 'id="audit-strip"', 'class="au-table"', 'au-break', 'data-preset=', 'au-f-from', 'placeholder="HH:MM"', 'id="audit-apiservers"', 'id="audit-files"'))
          and '<option value="changes">Changes (writes with bodies)</option>' in html and 'innerHTML' not in html, html[:300])
    hostile = [json.dumps(ev(user={"username": "<script>alert(1)</script>"}, userAgent="<img src=x onerror=alert(2)>", objectRef={"resource": "secrets", "namespace": "</pre><b>ns</b>", "name": "\"><svg onload=alert(3)>"},
                            verb="delete", responseStatus={"code": 403}, annotations={"authorization.k8s.io/reason": "<i>reason</i>"}, sourceIPs=["<b>ip</b>"]))] * 2
    hroot = tree("hostile", hostile)
    for key, sub in (("audit", None),):
        d, h = tab(hroot, key, sub)
        html = (h.get_json() or {}).get("html", "")
        check(f"{sub or key}: hostile user, agent, namespace, name, reason and IP are escaped (the datalists, the chart data)",
              h.status_code == 200 and "<script>alert(1)" not in html and "<img src=x" not in html and "</pre><b>ns</b>" not in html and "<svg onload" not in html and "<i>reason</i>" not in html and "<b>ip</b>" not in html and ("&lt;script&gt;" in html or sub is None), html[:300])
    d, h = tab(tree("none"), "audit")
    html = (h.get_json() or {}).get("html", "")
    check("without audit logs the Findings say so and there is no form", h.status_code == 200 and "No audit log in this must-gather" in html and 'id="audit-events-form"' not in html)
    for name in ("_audit.html", "mustgather_audit.html"):
        src = open(os.path.join(BACKEND, "templates", "tabs", name)).read()
        check(f"{name}: no marked-safe output, no Font Awesome, no &nbsp;, no utility grid/colour classes, no innerHTML",
              "|safe" not in src and 'class="fas' not in src and "&nbsp;" not in src and not any(c in src for c in ("grid-cols-", "col-span-", "bg-gray-", "text-gray-", "md:", "space-y-")) and "innerHTML" not in src and "insertAdjacentHTML" not in src)


    print("\n--- 4. the audit profile: config, inference, custom rules, mismatch, exclusions ---")
    p = a["profile"]
    check("the mock: the profile comes from the APIServer config (Default) with its custom rule listed; the events show bodies on one master (Default (partly)); no mismatch",
          p["profile"] == "Default" and p["source"] == "APIServer config" and p["config_path"].endswith("apiservers/cluster.yaml") and p["custom_rules"] == [{"group": "system:authenticated:oauth", "profile": "WriteRequestBodies"}]
          and p["inferred"].startswith("Default (partly)") and "non-sensitive write events" in p["evidence"] and not p["mismatch"] and p["bodies"], str({k: p[k] for k in ("profile", "source", "inferred", "evidence", "mismatch")}))
    check("the commands offered exclude the active profile (Default): WriteRequestBodies first, then AllRequestBodies; the custom-rules, verify and gather commands and the caveat are there",
          [c["profile"] for c in p["commands"]] == ["WriteRequestBodies", "AllRequestBodies"] and all(c["command"].startswith("oc patch apiserver cluster --type=merge -p ") for c in p["commands"])
          and "customRules" in p["custom_rules_command"] and p["verify_command"].startswith("oc get apiserver cluster") and "gather_audit_logs" in p["gather_command"] and "oc get co kube-apiserver" in p["caveat"], str(p["commands"]))
    check("the per-apiserver inference: kube-apiserver and openshift-apiserver partly, oauth-apiserver Default (no non-sensitive writes with bodies)",
          {x["name"]: x["profile"].split(" ")[0] for x in p["per_apiserver"]}["kube-apiserver"] == "Default" and any(x["name"] == "kube-apiserver" and "partly" in x["profile"] for x in p["per_apiserver"]), str(p["per_apiserver"]))

    def variant(name, profile, config=None, image=True):
        root = os.path.join(WORKDIR, name)
        base = os.path.join(root, IMAGE) if image else root
        os.makedirs(os.path.join(base, "namespaces"), exist_ok=True)
        plan = mock_audit_logs.write(Tree(base), profile=profile)
        if config is not None:
            cfg = os.path.join(base, "cluster-scoped-resources", "config.openshift.io", "apiservers")
            os.makedirs(cfg, exist_ok=True)
            with open(os.path.join(cfg, "cluster.yaml"), "w") as f:
                f.write(config)
        return root, plan
    wroot, wplan = variant("write-bodies", "WriteRequestBodies")
    wp = audit_logs.scan(wroot)["profile"]
    check("inferred WriteRequestBodies without a config: every master's non-sensitive writes at RequestResponse, reads at Metadata; the Default and AllRequestBodies commands offered, Default first",
          wp["profile"] == "WriteRequestBodies" and wp["source"] == "inferred from the events" and not wp["config_profile"] and re.match(r"RequestResponse on 9\d% of non-sensitive write events, 0% of reads", wp["evidence"])
          and [c["profile"] for c in wp["commands"]] == ["Default", "AllRequestBodies"] and not wp["differs_by_apiserver"] and not wp["differs_by_window"], str({k: wp[k] for k in ("profile", "evidence", "differs_by_apiserver", "differs_by_window")}))
    aroot, aplan = variant("all-bodies", "AllRequestBodies")
    ap = audit_logs.scan(aroot)["profile"]
    check("inferred AllRequestBodies: reads carry bodies too", ap["profile"] == "AllRequestBodies" and "0% of reads" not in ap["evidence"], ap["evidence"])
    droot, dplan = variant("default-cfg", "Default", config="apiVersion: config.openshift.io/v1\nkind: APIServer\nmetadata:\n  name: cluster\nspec:\n  audit:\n    profile: Default\n")
    dp = audit_logs.scan(droot)["profile"]
    check("Default from the config and the events agree: metadata only, no bodies", dp["profile"] == "Default" and dp["inferred"] == "Default" and not dp["mismatch"] and not dp["bodies"] and audit_search.search(droot, audit_search.validate({"preset": "changes"})[0])["total"] == 0, str({k: dp[k] for k in ("profile", "inferred", "mismatch")}))
    mroot, mplan = variant("mismatch", "Default", config="apiVersion: config.openshift.io/v1\nkind: APIServer\nmetadata:\n  name: cluster\nspec:\n  audit:\n    profile: AllRequestBodies\n")
    mp = audit_logs.scan(mroot)["profile"]
    check("config AllRequestBodies but Metadata-only events: both shown, the mismatch flagged, the commands exclude the configured profile",
          mp["profile"] == "AllRequestBodies" and mp["inferred"] == "Default" and mp["mismatch"] and [c["profile"] for c in mp["commands"]] == ["Default", "WriteRequestBodies"], str({k: mp[k] for k in ("profile", "inferred", "mismatch", "commands")}))
    xroot, _ = variant("mixed-window", "Mixed")
    xp = audit_logs.scan(xroot)["profile"]
    check("Mixed (one master records bodies) without a config: Default (partly), the evidence a third of the writes, the monitoring apiserver (no writes) ignored for the per-apiserver comparison",
          xp["profile"].startswith("Default (partly)") and re.search(r"on [23]\d% of non-sensitive write events", xp["evidence"]) and not xp["differs_by_apiserver"], str(xp["per_apiserver"]))
    # per-apiserver difference: kube-apiserver writes with bodies, openshift-apiserver writes without
    kube = [json.dumps(ev(verb="update", level="RequestResponse", requestObject={"kind": "ConfigMap", "data": {"a": "1"}}, responseObject={"kind": "ConfigMap", "data": {"a": "1"}}, auditID=f"00000000-0000-4000-8000-{i:012x}")) for i in range(10)]
    osa = [json.dumps(ev(verb="update", objectRef={"resource": "routes", "namespace": "demo"}, auditID=f"00000000-0000-4000-8000-{50 + i:012x}")) for i in range(10)] + [json.dumps(ev(verb="create", objectRef={"resource": "builds", "namespace": "demo"}, auditID=f"00000000-0000-4000-8000-{70 + i:012x}")) for i in range(10)]
    proot = tree("per-api", kube)
    path = os.path.join(proot, IMAGE, "audit_logs", "openshift-apiserver", "master-0-audit.log.gz")
    os.makedirs(os.path.dirname(path))
    with gzip.open(path, "wt") as f:
        f.write("\n".join(osa) + "\n")
    pp = audit_logs.scan(proot)["profile"]
    check("differs per apiserver: kube-apiserver WriteRequestBodies, openshift-apiserver Default (its routes excluded, its builds without bodies) -> flagged",
          pp["differs_by_apiserver"] and {x["name"]: x["profile"] for x in pp["per_apiserver"]} == {"kube-apiserver": "WriteRequestBodies", "openshift-apiserver": "Default"}, str(pp["per_apiserver"]))
    # the sensitive-resource exclusion: Secrets at RequestResponse must not make it WriteRequestBodies
    sec_lines = [json.dumps(ev(verb="update", level="RequestResponse", objectRef={"resource": "secrets", "namespace": "demo", "name": "s"}, requestObject={"kind": "Secret", "data": {"k": "dg=="}}, responseObject={"kind": "Secret", "data": {"k": "dg=="}}, auditID=f"00000000-0000-4000-8000-{i:012x}")) for i in range(20)]
    sec_lines += [json.dumps(ev(verb="update", objectRef={"resource": "configmaps", "namespace": "demo", "name": "c"}, auditID=f"00000000-0000-4000-8000-{100 + i:012x}")) for i in range(20)]
    sp = audit_logs.scan(tree("secrets-only", sec_lines))["profile"]
    check("the inference ignores Secrets (OpenShift logs them at Metadata in every profile): 20 secret updates with bodies + 20 configmap updates without -> Default", sp["profile"] == "Default" and "0% of non-sensitive write events" in sp["evidence"], sp["evidence"])
    check("no events at all -> None", audit_logs.scan(tree("no-events", []))["profile"]["profile"] == "None")
    check("infer() directly: thresholds and the evidence text", audit_profile.infer({"write": 100, "write_bodies": 92, "read": 300, "read_bodies": 0}) == ("WriteRequestBodies", "RequestResponse on 92% of non-sensitive write events, 0% of reads")
          and audit_profile.infer({"write": 10, "write_bodies": 10, "read": 10, "read_bodies": 6})[0] == "AllRequestBodies" and audit_profile.infer({"write": 10, "write_bodies": 2, "read": 10, "read_bodies": 0})[0] == "Default (partly)" and audit_profile.infer({})[0] == "None")

    print("\n--- 5. request bodies: masking on every page, the profile note on the mismatch fixture ---")
    placeholders = [mock_audit_logs._placeholder("secret-password", 1), mock_audit_logs._placeholder("secret-password", 2), mock_audit_logs._placeholder("secret-token", 1), mock_audit_logs._placeholder("db-password", 1), mock_audit_logs._placeholder("cm-db-password", 2), "placeholder-"]
    out = audit_logs.scan(wroot)
    blob = json.dumps({k: v for k, v in out.items() if k != "_bodies"}, ensure_ascii=False)
    check("no credential value in the parser's output (Secret data, the credential-like ConfigMap key, the DB_PASSWORD env value); the user names stay", not any(s in blob for s in placeholders) and "username" in blob, str([s[:12] for s in placeholders if s in blob]))
    for key, sub in (("audit", None),):
        d, h = tab(wroot, key, sub)
        html = (h.get_json() or {}).get("html", "")
        check(f"{sub or key}: no credential value in the page (200 OK)", h.status_code == 200 and not any(s in html for s in placeholders), f"{h.status_code} " + str([s[:12] for s in placeholders if s in html]))
    mhtml = (tab(mroot, "audit")[1].get_json() or {}).get("html", "")
    check("no profile UI on the page (the detection only drives the body filters): no note, no commands, the body filters disabled when the events carry no bodies", 'id="audit-profile"' not in mhtml and "oc patch apiserver" not in mhtml and 'id="ae-hasbody" disabled' in mhtml and "No request bodies recorded in these audit logs" in mhtml)
    slow = next((e for e in out["slowest"] if e.get("has_request_body")), None)
    r = client.post("/audit_event_body", json={"directory": wroot, "audit_id": slow["audit_id"], "part": "request"}) if slow else None
    check("/audit_event_body serves a sampled event's unmasked body from the scan's store (the placeholder appears only here); an unknown event is 404, a bad part 400",
          (slow is None or (r.status_code == 200 and "••••" not in (r.get_json() or {}).get("body", "") and '"kind"' in (r.get_json() or {}).get("body", "")))
          and client.post("/audit_event_body", json={"directory": wroot, "audit_id": "nope", "part": "request"}).status_code == 404 and client.post("/audit_event_body", json={"directory": wroot, "audit_id": "x", "part": "x"}).status_code == 400, f"{slow and r.status_code}")

    print(f"\n{'All checks passed' if not FAILED else str(FAILED) + ' check(s) failed'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(code)
