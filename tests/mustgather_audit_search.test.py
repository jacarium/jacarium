#!/usr/bin/env python3
"""Audit > Events: the on-demand search over the audit files
(backend/parsers/mustgather/audit_search.py, the /audit_events_search
route, the page module).

Over the synthetic must-gather (tests/fixtures/diagnostics-mock/
mock_audit_logs.py, which returns the events it wrote), every expectation
is computed from that plan: exact totals with no filter and per filter
(user, groups, verbs, resource, subresource, namespace, name, status
class, exact code, time range in both notations, IP, agent, apiserver,
node, stage, URI text, the one search box incl. time text, the Security
presets), successes present, newest first, pagination without gaps or
duplicates, files skipped by the time range, the time budget / partial
flag and count_all, the aggregates, masking (the fake secret never in the
JSON) with Reveal through the body store, hostile strings, validation
(400), containment, cancellation, the registry.
Run with the backend venv's Python: backend/venv/bin/python tests/mustgather_audit_search.test.py
"""
import json
import os
import re
import sys
import tempfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

from flask import Flask  # noqa: E402
import log_viewer as lv  # noqa: E402
import mock_audit_logs  # noqa: E402
from parsers.mustgather import audit_logs, audit_search, audit  # noqa: E402

FAILED = 0
WORKDIR = tempfile.mkdtemp(prefix="mg-audit-search-")
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


def fixture(name, profile="Mixed"):
    root = os.path.join(WORKDIR, name)
    base = os.path.join(root, IMAGE)
    os.makedirs(os.path.join(base, "namespaces"), exist_ok=True)
    plan = mock_audit_logs.write(Tree(base), profile=profile)
    return root, plan


def search(root, raw, **kw):
    base_day, first = audit_search.capture_bounds(root)
    q, err = audit_search.validate(raw, base_day, first)
    assert err is None, (raw, err)
    return audit_search.search(root, q, **kw)


root, plan = fixture("mixed")
events = plan["events"]
complete = [e for e in events if e["stage"] == "ResponseComplete"]   # the plan's ResponseComplete events; the monitoring audit.log adds 12 more
MON = plan["monitoring_events"]
ALL = len(complete) + MON


def expect(pred, extra=0):
    return sum(1 for e in complete if pred(e)) + extra


def ts_text(e):
    return e["requestReceivedTimestamp"][:19].replace("T", " ")


def res_key(e):
    r = e["objectRef"]
    return (r.get("apiGroup", "") + "/" + r["resource"] if r.get("apiGroup") else r["resource"]) + ("/" + r["subresource"] if r.get("subresource") else "")


# ---- the whole capture, newest first, successes included ----
r = search(root, {})
check(f"no filter: the total is every ResponseComplete event ({ALL:,}), the newest 200 returned, more to load, the scan covered every file",
      r["ok"] and r["total"] == ALL and r["returned"] == 200 and r["has_more"] and r["scanned_files"] == r["files"] == 16 and not r["partial"], str({k: r[k] for k in ("total", "returned", "has_more", "scanned_files", "files", "partial")}))
check("newest first: the timestamps descend, the first event is the capture's last",
      all(r["events"][i]["ts_sort"] >= r["events"][i + 1]["ts_sort"] for i in range(199)) and r["events"][0]["ts"] == max(ts_text(e) for e in complete), r["events"][0]["ts"])
check("successes are there: 2xx events among the results, with user, verb, resource, namespace, code, ip, agent, apiserver, node, latency, uri, the masked raw JSON",
      sum(1 for e in r["events"] if 200 <= e["code"] < 300) > 100 and all(k in r["events"][0] for k in ("user", "verb", "resource", "namespace", "code", "ip", "agent", "apiserver", "node", "latency", "uri", "raw", "audit_id", "stage", "level")))
check("the histogram's buckets add up to the total and the status line facts are there (seconds, lines, budget)",
      sum(b["n"] for b in r["histogram"]["buckets"]) == ALL and r["lines"] > ALL and r["budget_seconds"] == audit_search.BUDGET_SECONDS and isinstance(r["seconds"], float), str(sum(b["n"] for b in r["histogram"]["buckets"])))

# ---- every filter, exact against the plan ----
cases = [
    ("status 2xx", {"status": "2xx"}, lambda e: 200 <= e["responseStatus"]["code"] < 300, MON),
    ("status ok (< 400)", {"status": "ok"}, lambda e: e["responseStatus"]["code"] < 400, MON),
    ("status error", {"status": "error"}, lambda e: e["responseStatus"]["code"] >= 400, 0),
    ("status 4xx", {"status": "4xx"}, lambda e: 400 <= e["responseStatus"]["code"] < 500, 0),
    ("status 5xx", {"status": "5xx"}, lambda e: e["responseStatus"]["code"] >= 500, 0),
    ("exact code 403", {"status": "403"}, lambda e: e["responseStatus"]["code"] == 403, 0),
    ("user substring (alice: the username, no group or impersonation holds it)", {"user": "alice"}, lambda e: "alice" in e["user"]["username"], 0),
    ("user case-insensitive (ALICE)", {"user": "ALICE"}, lambda e: "alice" in e["user"]["username"], 0),
    ("user always matches the groups too (system:nodes: the node users' group)", {"user": "system:nodes"}, lambda e: "system:nodes" in e["user"]["username"] or any("system:nodes" in g for g in e["user"].get("groups", [])), 0),
    ("user always matches the impersonated identity (demo-app:default: the service account and the 4 impersonations)", {"user": "demo-app:default"}, lambda e: "demo-app:default" in e["user"]["username"] or "demo-app:default" in (e.get("impersonatedUser") or {}).get("username", ""), 0),
    ("user matches the impersonated identity's groups too (system:serviceaccounts: every service account, plus bob-admin's impersonations)", {"user": "system:serviceaccounts"}, lambda e: "system:serviceaccounts" in e["user"]["username"] or any("system:serviceaccounts" in g for g in e["user"].get("groups", [])) or any("system:serviceaccounts" in g for g in (e.get("impersonatedUser") or {}).get("groups", [])), MON),
    ("one verb (delete)", {"verbs": ["delete"]}, lambda e: e["verb"] == "delete", 0),
    ("several verbs (delete, deletecollection)", {"verbs": ["delete", "deletecollection"]}, lambda e: e["verb"] in ("delete", "deletecollection"), 0),
    ("verbs as a comma list (writes)", {"verbs": "create,update,patch,delete,deletecollection"}, lambda e: e["verb"] in ("create", "update", "patch", "delete", "deletecollection"), 0),
    ("resource (secrets)", {"resource": "secrets"}, lambda e: "secrets" in res_key(e), 0),
    ("resource with group (rbac.authorization.k8s.io/clusterrolebindings)", {"resource": "rbac.authorization.k8s.io/clusterrolebindings"}, lambda e: "rbac.authorization.k8s.io/clusterrolebindings" in res_key(e), 0),
    ("subresource (deployments/scale)", {"resource": "deployments/scale"}, lambda e: "deployments/scale" in res_key(e), 0),
    ("namespace (demo-app)", {"namespace": "demo-app"}, lambda e: "demo-app" in e["objectRef"].get("namespace", ""), 0),
    ("name (pull-secret)", {"name": "pull-secret"}, lambda e: "pull-secret" in e["objectRef"].get("name", ""), 0),
    ("source IP (198.51.100.23)", {"ip": "198.51.100.23"}, lambda e: "198.51.100.23" in e["sourceIPs"][0], 0),
    ("user agent (kubectl)", {"agent": "kubectl"}, lambda e: "kubectl" in e["userAgent"], 0),
    ("apiserver (openshift-apiserver)", {"apiserver": "openshift-apiserver"}, lambda e: e["_apiserver"] == "openshift-apiserver", 0),
    ("node (master-2)", {"node": "master-2"}, lambda e: e["_node"] == "master-2", 0),
    ("URI text (watch=true)", {"text": "watch=true"}, lambda e: "watch=true" in e["requestURI"], 0),
    ("the one box: a user (bob-admin)", {"q": "bob-admin"}, lambda e: "bob-admin" in e["user"]["username"] or "bob-admin" in e["requestURI"], 0),
    ("the one box: a time (13:4)", {"q": "13:4"}, lambda e: "13:4" in ts_text(e) or "13:4" in e["requestURI"], 0),
    ("the one box: a reason (no RBAC policy)", {"q": "no rbac policy"}, lambda e: "no rbac policy" in (e["annotations"].get("authorization.k8s.io/reason", "") + " " + e["responseStatus"].get("message", "")).lower(), 0),
    ("the one box: a status code (429)", {"q": "429"}, lambda e: "429" in (ts_text(e) + " " + e["user"]["username"] + " " + e["requestURI"] + " " + str(e["responseStatus"]["code"]) + " " + e["sourceIPs"][0] + " " + e["userAgent"] + " " + e["objectRef"].get("name", "")), 0),
    ("combined: alice + secrets + 403", {"user": "alice", "resource": "secrets", "status": "403"}, lambda e: "alice" in e["user"]["username"] and "secrets" in res_key(e) and e["responseStatus"]["code"] == 403, 0),
    ("preset forbidden", {"preset": "forbidden"}, lambda e: e["responseStatus"]["code"] == 403 or e["annotations"].get("authorization.k8s.io/decision") == "forbid", 0),
    ("preset throttled", {"preset": "throttled"}, lambda e: e["responseStatus"]["code"] == 429, 0),
    ("preset sensitive_deletes", {"preset": "sensitive_deletes"}, lambda e: e["verb"] in audit_logs.DELETE_VERBS and e["objectRef"]["resource"] in audit_logs.SENSITIVE_RESOURCES, 0),
    ("preset rbac_changes", {"preset": "rbac_changes"}, lambda e: e["objectRef"]["resource"] in audit_logs.RBAC_RESOURCES and e["verb"] in audit_logs.WRITE_VERBS, 0),
    ("preset secret_reads", {"preset": "secret_reads"}, lambda e: e["objectRef"]["resource"] == "secrets" and e["verb"] in audit_logs.READ_VERBS and not e["user"]["username"].startswith("system:") and e["responseStatus"]["code"] < 400, 0),
    ("preset impersonation", {"preset": "impersonation"}, lambda e: bool((e.get("impersonatedUser") or {}).get("username")), 0),
    ("preset deprecated", {"preset": "deprecated"}, lambda e: "k8s.io/deprecated" in e["annotations"], 0),
    ("preset forbidden + the one box (the old registry secret, outside the scan's sample)", {"preset": "forbidden", "q": "registry-creds-old"}, lambda e: e["responseStatus"]["code"] == 403 and "registry-creds-old" in e["objectRef"].get("name", ""), 0),
]
for label, raw, pred, extra in cases:
    want = expect(pred, extra)
    got = search(root, raw)
    ok_rows = all(pred(next(pe for pe in events if pe["auditID"] == e["audit_id"])) for e in got["events"] if any(pe["auditID"] == e["audit_id"] for pe in events))
    check(f"filter {label}: {want:,} matches, every returned event matches", got["total"] == want and got["returned"] == min(want, 200) and ok_rows, f"total={got['total']} want={want} returned={got['returned']}")
scan = audit_logs.scan(root)
check("the presets agree with the scan's own totals (forbidden, throttled, sensitive deletes, RBAC changes, secret reads, impersonation)",
      [search(root, {"preset": p})["total"] for p in ("forbidden", "throttled", "sensitive_deletes", "rbac_changes", "secret_reads", "impersonation")]
      == [scan["totals"][k] for k in ("forbidden", "throttled", "sensitive", "rbac", "secret_reads", "impersonation")])
check("the planted old forbidden event is not in the Security page's 100-event sample but the search finds it",
      not any(e["name"] == "registry-creds-old" for e in scan["forbidden"]["events"]) and search(root, {"preset": "forbidden", "q": "registry-creds-old"})["total"] == 1)
r_all = search(root, {"stage": "all"})
started = sum(1 for e in events if e["stage"] == "ResponseStarted")
check(f"stage all: the {started} ResponseStarted lines (running watches) count too", r_all["total"] == ALL + started, f"{r_all['total']} vs {ALL + started}")

# ---- the time range: both notations, files outside it skipped ----
base_day, first_ts = audit_search.capture_bounds(root)
lo, hi = "2026-10-12 14:00:00", "2026-10-12 14:15:00"
want = expect(lambda e: lo <= ts_text(e) <= hi) + sum(1 for i in range(MON) if lo <= (plan["start"].replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")) <= hi and False)
r1 = search(root, {"from": lo, "to": hi})
r2 = search(root, {"from": "14:00", "to": "14:14"})
check(f"time range 14:00-14:15 as full stamps: {want:,} matches, the rotated files (all before 13:50) skipped unread",
      r1["total"] == want and r1["skipped_files"] >= 3 and r1["scanned_files"] + r1["skipped_files"] == r1["files"], f"total={r1['total']} want={want} skipped={r1['skipped_files']}")
check("the same range as HH:MM (to = the whole minute) gives the same count, from/to echoed", r2["total"] == r1["total"] and r2["from"] == lo and r2["to"].startswith("2026-10-12 14:14:59"), f"{r2['total']} {r2['from']} {r2['to']}")
check("capture bounds: the first day and the first timestamp come from the per-file time index", base_day is not None and base_day.strftime("%H:%M") == "00:00" and first_ts.strftime("%Y-%m-%d %H:%M") == "2026-10-12 12:40")
r3 = search(root, {"from": "14:30"})
check("from only: the open end reaches the capture's last event", r3["total"] == expect(lambda e: ts_text(e) >= "2026-10-12 14:30:00") and r3["events"][0]["ts"] == max(ts_text(e) for e in complete))

# ---- pagination: Load older walks the whole set without gaps or duplicates ----
seen, keys, cursor, pages = [], [], "", 0
while True:
    page = search(root, {"limit": 500, "cursor": cursor})
    pages += 1
    seen += [e["audit_id"] for e in page["events"]]
    keys += [(e["ts_sort"], e["audit_id"]) for e in page["events"]]
    if not page["has_more"] or not page["events"] or pages > 20:
        break
    cursor = page["cursor"]
check(f"pagination: {pages} pages of 500 cover all {ALL:,} events once, strictly descending, pages after the first skip the count",
      len(seen) == ALL and len(set(seen)) == ALL and all(keys[i] > keys[i + 1] for i in range(len(keys) - 1)) and pages == (ALL + 499) // 500 and not page["counted"], f"{len(seen)} {len(set(seen))} pages={pages}")
p2 = search(root, {"user": "alice", "limit": 5})
p3 = search(root, {"user": "alice", "limit": 5, "cursor": p2["cursor"]})
check("pagination keeps the filters: the second page of alice's events continues right after the first, all alice",
      p2["has_more"] and all("alice" in e["user"] for e in p3["events"]) and p3["events"][0]["ts_sort"] <= p2["events"][-1]["ts_sort"] and not set(e["audit_id"] for e in p3["events"]) & set(e["audit_id"] for e in p2["events"]))

# ---- the time budget, partial counts, count_all ----
saved = audit_search.BUDGET_SECONDS
audit_search.BUDGET_SECONDS = 0.0
rb = search(root, {"status": "2xx"})
audit_search.BUDGET_SECONDS = saved
rc = search(root, {"status": "2xx", "count_all": True})
check("a spent budget: partial, fewer files scanned than exist, the count a lower bound, more to load; count_all ignores the budget and gives the exact total",
      rb["partial"] and rb["scanned_files"] < rb["files"] and rb["total"] <= rc["total"] and rb["has_more"] and not rc["partial"] and rc["total"] == expect(lambda e: 200 <= e["responseStatus"]["code"] < 300, MON) and rc["budget_seconds"] == audit_search.COUNT_ALL_SECONDS,
      str({k: rb[k] for k in ("partial", "scanned_files", "files", "total", "has_more")}))

# ---- the status codes and verbs of the matches (the page's bars), the histogram's errors ----
rf = search(root, {"preset": "forbidden"})
check("the matches' status codes and verbs come with every answer (counted over ALL matches, not the returned page); forbidden = 403 only", rf["codes"] == [{"name": "403", "count": rf["total"]}] and sum(v["count"] for v in rf["verbs"]) == rf["total"] and all(v["errors"] == v["count"] for v in rf["verbs"]))
r2x = search(root, {"status": "2xx"})
check("2xx: no errors in the verbs, the histogram's error buckets all zero", all(v["errors"] == 0 for v in r2x["verbs"]) and all(not b["errors"] for b in r2x["histogram"]["buckets"] if not b["gap"]) and sum(b["n"] for b in r2x["histogram"]["buckets"] if not b["gap"]) == r2x["total"])
rall = search(root, {})
check("every event: the histogram's errors add up to the 4xx/5xx count, the codes to the total", sum(b["errors"] for b in rall["histogram"]["buckets"] if not b["gap"]) == expect(lambda e: e["responseStatus"]["code"] >= 400) and sum(c["count"] for c in rall["codes"]) == ALL)
check("no breakdown payload in the answer (users / reasons / pairs...)", "aggregates" not in rall and "users" not in rall)
rv = search(root, {"user": "system:nodes"})
check("a row says how the user filter matched: system:nodes is nobody's username, every match came through the group ('group system:nodes'); 'username' for a plain user", rv["total"] > 0 and all(e["matched_via"] == "group system:nodes" for e in rv["events"]) and all(e["matched_via"] == "username" for e in search(root, {"user": "alice"})["events"]))
ri = search(root, {"user": "demo-app:default", "q": "bob-admin"})
check("'impersonated <name>' when the match came through impersonatedUser; no via text without a user filter", ri["total"] == 4 and all(e["matched_via"] == "impersonated system:serviceaccount:demo-app:default" and e["user"] == "bob-admin" for e in ri["events"]) and all(e["matched_via"] == "" for e in search(root, {"verbs": ["delete"]})["events"]))
check("the user_groups parameter is gone (always on): sending it changes nothing", search(root, {"user": "system:nodes", "user_groups": False})["total"] == rv["total"])
check("the raw event keeps the apiserver's authorization decision and reason readable (the credential masking skips the authorization.k8s.io annotations)", '"authorization.k8s.io/decision": "allow"' in rall["events"][0]["raw"] and "••••" not in rall["events"][0]["raw"].split('"annotations"')[1].split("}")[0])

# ---- masking: the fake secret never leaves the backend in a search; Reveal serves it on demand ----
wroot, wplan = fixture("write-bodies", "WriteRequestBodies")
placeholders = [mock_audit_logs._placeholder("secret-password", 1), mock_audit_logs._placeholder("secret-password", 2), mock_audit_logs._placeholder("secret-token", 1), mock_audit_logs._placeholder("db-password", 1), "placeholder-"]
rs = search(wroot, {"resource": "secrets", "verbs": ["create", "update", "patch"], "status": "2xx"})
blob = json.dumps(rs, ensure_ascii=False)
check("a search over the Secret writes: bodies present and masked (bullets + byte count) in the body texts and the raw JSON, no placeholder value anywhere in the answer",
      rs["total"] > 0 and any(e["has_request_body"] for e in rs["events"]) and "•••• (" in blob and not any(p in blob for p in placeholders), str([p[:12] for p in placeholders if p in blob]))
sec = next(e for e in rs["events"] if e["has_request_body"])
check("Reveal: the search's body store serves the unmasked request body of a returned event (and only request / response)",
      mock_audit_logs._placeholder("secret-token", 1) in (audit_search.stored_body(wroot, sec["audit_id"], "request") or "") + (audit_logs.body(wroot, sec["audit_id"], "request") or "") or any(mock_audit_logs._placeholder(k, n) in (audit_logs.body(wroot, e["audit_id"], "request") or "") for e in rs["events"] if e["has_request_body"] for k in ("secret-password", "secret-token", "db-password") for n in (1, 2))
      and audit_search.stored_body(wroot, sec["audit_id"], "nope") is None and audit_search.stored_body(wroot, "missing", "request") is None)
cm = search(wroot, {"resource": "configmaps", "verbs": ["update", "patch"], "status": "2xx"})
check("ConfigMap writes: a credential-like key's value masked in the bodies, the others readable", "•••• (" in json.dumps(cm, ensure_ascii=False) and "feature" in json.dumps(cm, ensure_ascii=False).lower())

# ---- hostile strings travel as data ----
hostile_root = os.path.join(WORKDIR, "hostile")
hbase = os.path.join(hostile_root, IMAGE)
os.makedirs(os.path.join(hbase, "namespaces"), exist_ok=True)
import gzip  # noqa: E402
bad_user = "<script>alert(1)</script>\"; DROP TABLE users; --"
bad_lines = []
for i in range(3):
    bad_lines.append(json.dumps({"kind": "Event", "apiVersion": "audit.k8s.io/v1", "level": "Metadata", "auditID": f"h{i}", "stage": "ResponseComplete", "requestURI": f"/api/v1/namespaces/<img src=x onerror=alert(1)>/pods?x={i}",
                                 "verb": "list", "user": {"username": bad_user, "groups": ["</pre><b>x</b>"]}, "sourceIPs": ["192.0.2.1"], "userAgent": "{{ 7*7 }} ${jndi:ldap://x} </script>",
                                 "objectRef": {"resource": "pods", "namespace": "<img src=x onerror=alert(1)>", "name": "p{% if %}"}, "responseStatus": {"code": 200},
                                 "requestReceivedTimestamp": f"2026-10-12T12:0{i}:00.000000Z", "stageTimestamp": f"2026-10-12T12:0{i}:00.100000Z", "annotations": {"authorization.k8s.io/reason": "<b>bold</b>"}}))
os.makedirs(os.path.join(hbase, "audit_logs", "kube-apiserver"), exist_ok=True)
with gzip.open(os.path.join(hbase, "audit_logs", "kube-apiserver", "master-0-audit.log.gz"), "wt") as f:
    f.write("\n".join(bad_lines) + "\n")
rh = search(hostile_root, {"user": "<script>", "q": "onerror"})
check("hostile strings: matched as plain substrings (no regex, no template), returned verbatim as JSON data", rh["total"] == 3 and rh["events"][0]["user"] == bad_user and rh["events"][0]["namespace"] == "<img src=x onerror=alert(1)>")
check("a regex-looking filter is a plain substring (no match, no error)", search(hostile_root, {"user": ".*"})["total"] == 0 and search(hostile_root, {"q": "(a|b)+"})["total"] == 0)

# ---- validation ----
bad = [({"verbs": ["nope"]}, "verb"), ({"limit": 5000}, "limit"), ({"limit": 0}, "limit"), ({"status": "7xx"}, "status"), ({"status": "<b>"}, "status"), ({"from": "yesterday"}, "from"), ({"to": "25:00"}, "valid time"),
       ({"from": "14:00", "to": "13:00"}, "after"), ({"cursor": "garbage"}, "cursor"), ({"user": "x" * 301}, "300"), ({"user": "a\x00b"}, "control"), ({"user": 5}, "text"), ({"stage": "weird"}, "stage"), ({"preset": "evil"}, "preset"),
       ({"user": [f"u{i}" for i in range(21)]}, "20"), ({"user": ",".join(f"v{i}" for i in range(21))}, "20"), ({"q": "x" * 301}, "300"), ("not a dict", "object")]
problems = []
for raw, word in bad:
    q, err = audit_search.validate(raw, base_day, first_ts)
    if q is not None or not err or word not in err:
        problems.append((raw, err))
check("validation refuses bad verbs, limits, status, times, cursors, lengths, control characters, types, stages, presets, booleans, too many verbs, non-objects (with the reason)", not problems, str(problems)[:300])
check("an HH:MM time needs the capture's day: refused without it, resolved with it", "full date" in (audit_search.validate({"from": "13:00"})[1] or "") and audit_search.validate({"from": "13:00"}, base_day, first_ts)[0]["from"].strftime("%Y-%m-%d %H:%M") == "2026-10-12 13:00")
cur = audit_search._encode_cursor({"sort": "time", "sort_asc": False}, ("2026-10-12T14:00:00.000000", "abc-123"))
q, err = audit_search.validate({"user": " Alice ", "verbs": "Get, LIST", "status": "4XX", "limit": "50", "cursor": cur}, base_day, first_ts)
check("validation normalises: trimmed lowercase values, verbs as a set, the status classes, a numeric string limit, a cursor's key; a cursor turns the count off",
      err is None and q["user"] == ["alice"] and q["verbs"] == {"get", "list"} and q["status"] == ["4xx"] and q["limit"] == 50 and q["cursor"] == ("2026-10-12T14:00:00.000000", "abc-123") and not q["count"], str((q, err)))
check("a cursor from another sort is refused; so is a mangled one", "cursor" in (audit_search.validate({"cursor": cur, "sort": "latency"})[1] or "") and "cursor" in (audit_search.validate({"cursor": "zz" + cur[2:]})[1] or "") and "sort" in (audit_search.validate({"sort": "bogus"})[1] or ""))

# ---- server-side sorting over ALL matches ----
rl = search(root, {"sort": "latency"})
slowest = scan["slowest"]
check("sort=latency: the slowest requests of the WHOLE capture come first (the scan's slowest list agrees: the planted 8.5 s list, 6.2 s, 3.2 s ...), newest-first is not the order any more",
      rl["sort"] == "latency_desc" and rl["sort_text"] == "sorted by latency, slowest first" and [e["latency"] for e in rl["events"][:3]] == [slowest[0]["latency"], slowest[1]["latency"], slowest[2]["latency"]] and rl["events"][0]["latency"] == "8.5 s"
      and all((rl["events"][i]["latency_ms"] or 0) >= (rl["events"][i + 1]["latency_ms"] or 0) for i in range(len(rl["events"]) - 1)), str([e["latency"] for e in rl["events"][:4]]))
ra = search(root, {"sort": "latency_asc"})
check("sort=latency_asc: the fastest first, every row with a latency", ra["sort_text"] == "sorted by latency, fastest first" and all(ra["events"][i]["latency_ms"] <= ra["events"][i + 1]["latency_ms"] for i in range(len(ra["events"]) - 1)) and all(e["latency_ms"] is not None for e in ra["events"]))
rw = search(root, {"sort": "latency", "limit": 1000, "stage": "all"})
first_watch = next((i for i, e in enumerate(rw["events"]) if e["verb"] == "watch"), None)
check("watches sort last under the latency sort (their minutes-long latency is the watch itself): no watch among the rows with a latency, the first 1000 rows hold none",
      first_watch is None and all(e["verb"] != "watch" for e in rl["events"]), str(first_watch))
for sort_, keyf, asc in (("status", lambda e: e["code"], False), ("status_asc", lambda e: e["code"], True), ("user", lambda e: e["user"].lower(), True), ("user_desc", lambda e: e["user"].lower(), False), ("verb", lambda e: e["verb"], True),
                         ("object", lambda e: (e["resource"] + "/" + e["namespace"] + "/" + e["name"]).lower(), True), ("time_asc", lambda e: e["ts_sort"], True)):
    rs = search(root, {"sort": sort_})
    ks = [keyf(e) for e in rs["events"]]
    check(f"sort={sort_}: the page is ordered ({rs['sort_text']})", len(ks) == 200 and all((ks[i] <= ks[i + 1]) if asc else (ks[i] >= ks[i + 1]) for i in range(len(ks) - 1)), str(ks[:5]))
check("sort=time_asc: the oldest event of the capture comes first", search(root, {"sort": "time_asc"})["events"][0]["ts"] == min(ts_text(e) for e in complete))
for sort_ in ("latency", "user", "status_asc", "object_desc"):
    seen, keys, cursor, pages = [], [], "", 0
    while True:
        page = search(root, {"sort": sort_, "limit": 500, "cursor": cursor})
        pages += 1
        seen += [e["audit_id"] for e in page["events"]]
        if not page["has_more"] or not page["events"] or pages > 20:
            break
        cursor = page["cursor"]
    check(f"pagination under sort={sort_}: every event once over {pages} pages, no duplicates, no gaps", len(seen) == ALL and len(set(seen)) == ALL, f"{len(seen)} {len(set(seen))}")
rp = search(root, {"sort": "latency", "limit": 3})
rp2 = search(root, {"sort": "latency", "limit": 3, "cursor": rp["cursor"]})
check("the second latency page continues right after the first (the 4th slowest first)", [e["latency"] for e in rp2["events"]][0] == slowest[3]["latency"] and not set(e["audit_id"] for e in rp["events"]) & set(e["audit_id"] for e in rp2["events"]))
nr = search(root, {"q": "/metrics"})
check("non-resource requests (the monitoring pod's /metrics, /healthz ...) come back with an empty resource and their URI", nr["total"] == 3 and all(e["resource"] == "" and e["uri"].startswith("/metrics") for e in nr["events"]) and search(root, {"q": "/healthz"})["total"] == 3)

# ---- the histogram's buckets follow the matches' span ----
h3 = search(root, {"user": "demo-app:default", "q": "bob-admin"})["histogram"]
check("a 3-minute span draws per 5 s: 37 buckets of one window, no gap, the first and last labelled with seconds", h3["step_seconds"] == 5 and h3["step_text"] == "5 s" and len(h3["buckets"]) == 37 and h3["gaps"] == [] and h3["buckets"][0]["label"].count(":") == 2 and sum(b["n"] for b in h3["buckets"]) == 4, str({k: h3[k] for k in ("step_seconds", "step_text")}) + str(len(h3["buckets"])))
h60 = search(root, {"from": "2026-10-12 13:00:00", "to": "2026-10-12 13:59:59"})["histogram"]
check("an hour draws per 1 min: 60 buckets", h60["step_seconds"] == 60 and h60["step_text"] == "1 min" and len(h60["buckets"]) == 60)
hall = search(root, {})["histogram"]
check("the whole capture (117 min) draws per 2 min: at most 60 buckets", hall["step_seconds"] == 120 and 55 <= len(hall["buckets"]) <= 60)

# ---- several values per filter: OR within a field, AND across fields; the quoting ----
check("split_values: commas outside quotes split, quotes keep spaces and commas, \\\" stays a quote, empties and duplicates go",
      audit_search.split_values("create,delete") == ["create", "delete"] and audit_search.split_values('"system:serviceaccount:a b","cannot, list", plain ,,') == ["system:serviceaccount:a b", "cannot, list", "plain"]
      and audit_search.split_values('"say \\"hi\\"",x,x') == ['say "hi"', "x"] and audit_search.split_values("") == [] and audit_search.split_values('"unterminated, still one') == ["unterminated, still one"])
try:
    audit_search.split_values(",".join(f"v{i}" for i in range(21))); capped = False
except ValueError:
    capped = True
check("split_values caps at 20 values (ValueError beyond)", capped)
vc, vd = search(root, {"verbs": ["create"]})["total"], search(root, {"verbs": ["delete"]})["total"]
check("verbs create,delete = create OR delete (exact: the two counts add up)", search(root, {"verbs": "create,delete"})["total"] == vc + vd and search(root, {"verbs": ["create", "delete"]})["total"] == vc + vd and vc > 0 and vd > 0)
ua, ub = search(root, {"user": "alice"})["total"], search(root, {"user": "bob-admin"})["total"]
check("user alice,bob-admin = OR of the two (exact); as a JSON list too; AND with a verb narrows it", search(root, {"user": "alice,bob-admin"})["total"] == ua + ub and search(root, {"user": ["alice", "bob-admin"]})["total"] == ua + ub
      and search(root, {"user": "alice,bob-admin", "verbs": ["delete"]})["total"] == expect(lambda e: e["user"]["username"] in ("alice", "bob-admin") and e["verb"] == "delete"))
s403, s429 = search(root, {"status": "403"})["total"], search(root, {"status": "429"})["total"]
check("status 403,429 (classes and codes alike) = OR; 4xx,5xx = error", search(root, {"status": ["403", "429"]})["total"] == s403 + s429 and search(root, {"status": "4xx,5xx"})["total"] == search(root, {"status": "error"})["total"])
ci, cs = search(root, {"category": "impersonation"})["total"], search(root, {"category": "secret_reads"})["total"]
check("category impersonation,secret_reads = OR (exact, the two are disjoint on the fixture)", search(root, {"category": "impersonation,secret_reads"})["total"] == ci + cs and search(root, {"category": ["impersonation", "secret_reads"]})["total"] == ci + cs)
ao, au_ = search(root, {"apiserver": "openshift-apiserver"})["total"], search(root, {"apiserver": "oauth-server"})["total"]
check("apiserver and node take several values (any of them)", search(root, {"apiserver": ["openshift-apiserver", "oauth-server"]})["total"] == ao + au_ and search(root, {"node": "master-0,master-1"})["total"] == search(root, {"node": "master-0"})["total"] + search(root, {"node": "master-1"})["total"])
qa = search(root, {"q": "create,delete"})
check("the search box: create,delete matches an event holding either string in ANY searched field (the verb, a name, a URI...), OR across the values, no verb filter",
      qa["total"] == expect(lambda e: any(v in (ts_text(e) + " " + e["user"]["username"] + " " + e["verb"] + " " + res_key(e) + " " + e["objectRef"].get("namespace", "") + " " + e["objectRef"].get("name", "") + " " + e["sourceIPs"][0] + " " + e["userAgent"] + " " + e["annotations"].get("authorization.k8s.io/reason", "") + " " + e["responseStatus"].get("message", "") + " " + e["requestURI"] + " " + str(e["responseStatus"]["code"])).lower() for v in ("create", "delete"))) and qa["total"] > vc + vd)
check("quoted search values with spaces: \"no rbac policy\",\"cannot list\" = OR of the two reasons; search AND a verb tag", search(root, {"q": '"no rbac policy","cannot list"'})["total"] == expect(lambda e: any(v in (e["annotations"].get("authorization.k8s.io/reason", "") + " " + e["responseStatus"].get("message", "")).lower() for v in ("no rbac policy", "cannot list")))
      and search(root, {"q": "create,delete", "verbs": ["delete"]})["total"] == expect(lambda e: e["verb"] == "delete" and any(v in (e["user"]["username"] + " " + e["verb"] + " " + res_key(e) + " " + e["objectRef"].get("name", "") + " " + e["requestURI"]).lower() for v in ("create", "delete"))))
rm = search(root, {"from": "13:51", "to": "13:51"})
check("a one-minute range draws per second: the histogram holds second buckets of one window, no gap, every bucket in between", rm["histogram"].get("step_seconds") == 1 and rm["histogram"]["gaps"] == [] and len(rm["histogram"]["windows"]) == 1 and 2 <= len(rm["histogram"]["buckets"]) <= 60 and sum(b["n"] for b in rm["histogram"]["buckets"]) == rm["total"] and rm["histogram"]["buckets"][0]["label"].count(":") == 2, str(rm["histogram"])[:200])
r1 = search(root, {"from": "2026-10-12 13:51:05", "to": "2026-10-12 13:51:05"})
check("a single-second range still answers a histogram with one bucket", r1["total"] >= 0 and len(r1["histogram"]["buckets"]) == (1 if r1["total"] else 0))

# ---- the route: containment, 400s, the answer, Reveal; the tab modules; the registry ----
app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
app.register_blueprint(lv.log_viewer)
app.secret_key = "mg-audit-search-test"
client = app.test_client()
res = client.post("/audit_events_search", json={"directory": root, "query": {"user": "alice", "limit": 10}})
flat = client.post("/audit_events_search", json={"directory": root, "user": "alice", "limit": 10})
check("/audit_events_search answers the query (nested or flat) with the masked events, the total and the cursor", res.status_code == 200 and res.get_json()["total"] == by_user_total if (by_user_total := expect(lambda e: "alice" in e["user"]["username"])) else False, f"{res.status_code} {str(res.get_json())[:200]}")
check("the flat form gives the same answer", flat.status_code == 200 and flat.get_json()["total"] == res.get_json()["total"] and flat.get_json()["cursor"] == res.get_json()["cursor"])
check("a bad query is a 400 with the reason", client.post("/audit_events_search", json={"directory": root, "query": {"limit": 9999}}).status_code == 400 and "limit" in client.post("/audit_events_search", json={"directory": root, "query": {"limit": 9999}}).get_json()["error"])
check("containment: a missing or non-directory path is refused like the tabs (400), nothing is searched",
      client.post("/audit_events_search", json={"directory": os.path.join(WORKDIR, "nope"), "query": {}}).status_code == 400 and client.post("/audit_events_search", json={"query": {}}).status_code == 400 and client.post("/audit_events_search", json={"directory": 12}).status_code == 400)
# the page's Cancel button: /audit_events_cancel stops the directory's running search (the same containment as the search)
cancel_state = {"n": 0, "res": None}


def cancel_after_file(path):
    cancel_state["n"] += 1
    if cancel_state["n"] == 2:
        cancel_state["res"] = client.post("/audit_events_cancel", json={"directory": root})


q_c, _ = audit_search.validate({}, base_day, first_ts)
r_c = audit_search.search(root, q_c, _after_file=cancel_after_file)
check("/audit_events_cancel answers ok and the directory's running search stops with 'cancelled'; a missing directory is refused (400) and cancels nothing",
      cancel_state["res"] is not None and cancel_state["res"].status_code == 200 and cancel_state["res"].get_json() == {"ok": True} and r_c.get("cancelled") and not r_c.get("ok")
      and client.post("/audit_events_cancel", json={"directory": os.path.join(WORKDIR, "nope")}).status_code == 400 and client.post("/audit_events_cancel", json={}).status_code == 400,
      f"{cancel_state} {str(r_c)[:120]}")
bridge = open(os.path.join(REPO, "src", "components", "DiagnosticsPage.jsx"), encoding="utf-8").read()
check("the frame bridge allow-lists /audit_events_cancel next to the search, and nothing else new", "'/audit_events_search', '/audit_events_cancel']" in bridge)
os.environ["JACARIUM_REPORTS_ROOT"] = WORKDIR
try:
    import reports_root  # noqa: E402
    outside = client.post("/audit_events_search", json={"directory": "/etc", "query": {}})
    check("containment with a reports root: a path outside it is a 403", outside.status_code == 403, f"{outside.status_code} {str(outside.get_json())[:100]} roots={reports_root.allowed_roots()}")
finally:
    del os.environ["JACARIUM_REPORTS_ROOT"]
rs2 = client.post("/audit_events_search", json={"directory": wroot, "query": {"resource": "secrets", "verbs": ["create", "update"], "status": "2xx"}}).get_json()
ev_b = next(e for e in rs2["events"] if e["has_request_body"])
body = client.post("/audit_event_body", json={"directory": wroot, "audit_id": ev_b["audit_id"], "part": "request"})
check("/audit_event_body reveals a searched event's body (the search's store), 404 for an unknown id",
      body.status_code == 200 and "••••" not in body.get_json()["body"] and '"data"' in body.get_json()["body"] and client.post("/audit_event_body", json={"directory": wroot, "audit_id": "zzz", "part": "request"}).status_code == 404, f"{body.status_code} {str(body.get_json())[:120]}")
d = audit.parse(root)["audit"]
check("the page module: the vocabulary for the filter bar (verbs, apiservers, nodes, users, resources, namespaces, agents), the time range, the limits, the whole capture's codes and verbs for the bars, whether bodies are recorded",
      d["available"] and "get" in d["verbs"] and "kube-apiserver" in d["apiservers"] and "master-0" in d["nodes"] and len(d["users"]) >= 10 and d["limit"] == 200 and d["limit_max"] == 1000 and d["time"]["first"]
      and sum(c["count"] for c in d["scan"]["codes"]) == ALL and sum(v["count"] for v in d["scan"]["verbs"]) == ALL and d["bodies"] is True)
pages = {}
html = (client.post("/load_tab", json={"report_type": "mustgather", "directory": root, "tab": "audit"}).get_json() or {}).get("html", "")
check("the Audit page: the filter bar with the Category select (sensitive deletes, RBAC changes, secret reads, impersonation, deprecated, changes), no From/To, no presets, no breakdowns, no profile, no innerHTML",
      all(s in html for s in ('id="ae-q"', 'id="ae-category"', '<option value="sensitive_deletes">', '<option value="rbac_changes">', '<option value="secret_reads">', '<option value="impersonation">', '<option value="deprecated">', '<option value="changes">', 'id="audit-events-status"', 'id="audit-events-hist"', 'id="audit-events-codes"', 'id="audit-events-verbs"', 'id="audit-events-list"', 'id="audit-events-more"'))
      and not any(s in html for s in ("au-f-from", 'placeholder="HH:MM"', "data-preset=", "au-break", 'id="audit-profile"', "innerHTML")), html[:200])
ca = search(root, {"category": "forbidden"})
check("`category` is the preset's alias for the Category select", ca["total"] == scan["totals"]["forbidden"] and ca["preset"] == "forbidden")
hostile_html = (client.post("/load_tab", json={"report_type": "mustgather", "directory": hostile_root, "tab": "audit"}).get_json() or {}).get("html", "")
check("the Events page escapes the vocabulary (a hostile username in the datalist)", "<script>alert(1)</script>" not in hostile_html and "&lt;script&gt;alert(1)&lt;/script&gt;" in hostile_html)
mg = lv.PARSERS["mustgather"]
check("the registry: one Audit entry, no sub-tabs, its module the page's", "sub_tabs" not in mg["audit"] and mg["audit"]["module"] == "parsers.mustgather.audit" and mg["audit"]["label"] == "Audit")
for name in ("mustgather_audit.html", "_audit.html"):
    src = open(os.path.join(BACKEND, "templates", "tabs", name), encoding="utf-8").read()
    check(f"{name}: no marked-safe output, no innerHTML, no From/To filter inputs", not re.search(r"\|\s*safe", src) and "innerHTML" not in src and "au-f-from" not in src)

# ---- cancellation: a newer search stops the running one ----
state = {"n": 0}


def after_file(path):
    state["n"] += 1
    if state["n"] == 2:
        audit_search.cancel(root)   # what a newer search for the same directory does


q, _ = audit_search.validate({}, base_day, first_ts)
rcan = audit_search.search(root, q, _after_file=after_file)
check("cancellation: a newer search for the same directory cancels the running one, which answers cancelled instead of a result", rcan.get("cancelled") and not rcan.get("ok") and "events" not in rcan and search(root, {})["ok"], str(rcan)[:200])
slots = audit_search._slots
for _ in range(audit_search.MAX_SLOTS):
    slots.acquire(blocking=False)
busy = search(root, {})
for _ in range(audit_search.MAX_SLOTS):
    slots.release()
check("concurrency: with every slot taken a search answers busy (the route turns it into a 429) and frees nothing it did not take", busy.get("error") == "busy" and search(root, {})["ok"])

print(f"\n{'All checks passed' if not FAILED else str(FAILED) + ' check(s) failed'}")
sys.exit(1 if FAILED else 0)
