#!/usr/bin/env python3
"""
The must-gather list files that are empty or odd (the real-gather bug: a
SecretList with `items: null` made the TLS page say "'NoneType' object is
not iterable" under "Files that could not be read"):

 1. _common.list_items: a List with items null / [] / missing, a None
    document, a non-mapping, a single object without a List kind, a stray
    item of another kind, and a kind filter.
 2. TLS secrets: secrets.yaml with items null, items [], an empty file, a
    `null` document, a single Secret without a List, a malformed file and
    a valid TLS secret next to them: the valid one is parsed with its
    expiry, the empty ones are empty namespaces (no error entry), the
    malformed one is the one error, with a readable reason (not the raw
    Python message), and the Findings carry one WARN naming the file.
 3. The same null / empty / single-object / malformed cases through the
    other list parsers: pods (a pod file), events, deployments,
    daemonsets, replicasets, statefulsets, PDBs, nodes, CSRs, MCPs.
 4. No parser lets a raw Python exception message ("NoneType", "object is
    not", "Traceback", "line 1, column") reach its data or its Findings.

Needs the backend venv (PyYAML); run-all.sh picks it up as a .test.py.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(REPO, "backend"))

from parsers.mustgather import _common, csr, daemonset, deployment, events, mcp, nodes, pdb, pod, replicaset, statefulset, tls_secrets  # noqa: E402

WORK = tempfile.mkdtemp(prefix="mg-list-items-")
results = []
RAW = ("NoneType", "object is not", "Traceback", "object has no attribute", "line 1, column", "KeyError", "TypeError")


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("PASS: " if ok else "FAIL: ") + label + (f" | {str(detail)[:400]}" if detail and not ok else ""))


def gather(name):
    root = os.path.join(WORK, name)
    os.makedirs(os.path.join(root, "namespaces"), exist_ok=True)
    os.makedirs(os.path.join(root, "cluster-scoped-resources"), exist_ok=True)
    with open(os.path.join(root, "timestamp"), "w") as f:
        f.write("2026-10-12 14:36:49.000000000 +0000 UTC m=+0.1\n")
    return root


def put(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def raw_text(obj):
    s = repr(obj)
    return next((r for r in RAW if r in s), None)


# ---- 1. list_items ----
check("list_items: items null -> []", _common.list_items({"kind": "SecretList", "items": None}) == [])
check("list_items: items [] -> []", _common.list_items({"kind": "SecretList", "items": []}) == [])
check("list_items: a List without items -> []", _common.list_items({"kind": "SecretList"}) == [])
check("list_items: None -> []", _common.list_items(None) == [])
check("list_items: a non-mapping -> []", _common.list_items("text") == [] and _common.list_items([1, 2]) == [])
check("list_items: a single object -> one item", _common.list_items({"kind": "Secret", "metadata": {"name": "a"}}) == [{"kind": "Secret", "metadata": {"name": "a"}}])
check("list_items: non-dict items are dropped, a stray kind filtered", _common.list_items({"kind": "SecretList", "items": [None, "x", {"kind": "ConfigMap"}, {"kind": "Secret", "metadata": {"name": "b"}}]}, "Secret") == [{"kind": "Secret", "metadata": {"name": "b"}}])
check("reason_of: a YAML error is 'not valid YAML (line N)'", _common.reason_of(__import__("yaml").YAMLError("x")).startswith("not valid YAML"))
check("reason_of: a TypeError is the document shape, not the Python text", _common.reason_of(TypeError("'NoneType' object is not iterable")) == "not the expected document shape")

# ---- 2. TLS secrets ----
root = gather("tls")
VALID = """apiVersion: v1
kind: SecretList
items:
- apiVersion: v1
  kind: Secret
  type: kubernetes.io/tls
  metadata:
    name: router-certs
    namespace: good
    creationTimestamp: "2026-01-01T00:00:00Z"
    annotations:
      auth.openshift.io/certificate-not-after: "2026-11-20T00:00:00Z"
  data: {}
"""
put(root, "namespaces/good/core/secrets.yaml", VALID)
put(root, "namespaces/nullitems/core/secrets.yaml", "apiVersion: v1\nkind: SecretList\nitems: null\n")
put(root, "namespaces/emptyitems/core/secrets.yaml", "apiVersion: v1\nkind: SecretList\nitems: []\n")
put(root, "namespaces/emptyfile/core/secrets.yaml", "")
put(root, "namespaces/nulldoc/core/secrets.yaml", "null\n")
put(root, "namespaces/single/core/secrets.yaml", """apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata:
  name: single-cert
  namespace: single
  creationTimestamp: "2026-01-01T00:00:00Z"
  annotations:
    auth.openshift.io/certificate-not-after: "2027-01-01T00:00:00Z"
data: {}
""")
put(root, "namespaces/broken/core/secrets.yaml", "kind: SecretList\nitems:\n  - this: [is not closed\n")
out = tls_secrets.parse(root)
parsed = [t for t in out if t.get("status")]
errors = [t for t in out if t.get("file") and not t.get("status")]
check("tls: the valid secret is parsed with its expiry (39 days: Expiring Soon)", any(t["name"] == "router-certs" and t["status"] == "Expiring Soon" and 38 <= t["days_left"] <= 40 for t in parsed), [(t.get("name"), t.get("status"), t.get("days_left")) for t in parsed])
check("tls: the single Secret without a List is parsed too", any(t["name"] == "single-cert" for t in parsed), [t.get("name") for t in parsed])
check("tls: items null / [] / an empty file / a null document are empty namespaces, not errors", len(errors) == 1 and "broken" in errors[0]["file"], errors)
check("tls: the malformed file carries a readable reason, not the raw exception", errors and errors[0]["reason"].startswith("not valid YAML") and not raw_text(errors[0]), errors)
f = tls_secrets.findings(root)
w = [x for x in f if x["severity"] == "warn" and "could not be read" in x["title"]]
check("tls: the Findings carry one WARN naming the broken file and its reason", len(w) == 1 and "broken/core/secrets.yaml" in w[0]["detail"] and "not valid YAML" in w[0]["detail"] and not raw_text(w[0]), f)
check("tls: the strip still speaks of the parsed certificates", any("expire" in x["title"] for x in f), [x["title"] for x in f])

# ---- 3. the other list parsers ----
def list_file(kind_list, kind, name, ns=None, extra=""):
    meta = f"    name: {name}\n" + (f"    namespace: {ns}\n" if ns else "")
    return f"apiVersion: v1\nkind: {kind_list}\nitems:\n- kind: {kind}\n  metadata:\n{meta}{extra}"


CASES = [
    ("events", "namespaces/{ns}/core/events.yaml", "EventList", "Event", events, lambda r: sum(len([e for e in v if e.get('kind') != 'Error']) for v in r.values())),
    ("deployments", "namespaces/{ns}/apps/deployments.yaml", "DeploymentList", "Deployment", deployment, lambda r: sum(len([k for k in v if not k.startswith('_')]) for v in r.values() if isinstance(v, dict))),
    ("daemonsets", "namespaces/{ns}/apps/daemonsets.yaml", "DaemonSetList", "DaemonSet", daemonset, lambda r: sum(len([k for k in v if not k.startswith('_')]) for v in r.values() if isinstance(v, dict))),
    ("replicasets", "namespaces/{ns}/apps/replicasets.yaml", "ReplicaSetList", "ReplicaSet", replicaset, lambda r: sum(len([k for k in v if not k.startswith('_')]) for v in r.values() if isinstance(v, dict))),
    ("statefulsets", "namespaces/{ns}/apps/statefulsets.yaml", "StatefulSetList", "StatefulSet", statefulset, lambda r: sum(len([k for k in v if not k.startswith('_')]) for v in r.values() if isinstance(v, dict))),
    ("pdbs", "namespaces/{ns}/policy/poddisruptionbudgets.yaml", "PodDisruptionBudgetList", "PodDisruptionBudget", pdb, lambda r: sum(len([k for k in v if not k.startswith('_')]) for v in r.values() if isinstance(v, dict))),
]
for label, rel, kind_list, kind, mod, count in CASES:
    root = gather("list-" + label)
    put(root, rel.format(ns="ok"), list_file(kind_list, kind, "one", "ok", "  spec: {}\n  status: {}\n"))
    put(root, rel.format(ns="nullitems"), f"kind: {kind_list}\nitems: null\n")
    put(root, rel.format(ns="emptyitems"), f"kind: {kind_list}\nitems: []\n")
    put(root, rel.format(ns="emptyfile"), "")
    put(root, rel.format(ns="nulldoc"), "null\n")
    put(root, rel.format(ns="single"), f"kind: {kind}\nmetadata:\n  name: alone\n  namespace: single\nspec: {{}}\nstatus: {{}}\n")
    put(root, rel.format(ns="broken"), f"kind: {kind_list}\nitems:\n  - this: [is not closed\n")
    try:
        r = mod.parse(root)
        n = count(r)
        fs = mod.findings(root)
        check(f"{label}: items null / [] / empty file / null document parse as empty namespaces; the one and the single object are listed ({n})", n == 2, repr(r)[:300])
        check(f"{label}: no raw exception text in the data or the Findings", not raw_text(r) and not raw_text(fs), (raw_text(r), raw_text(fs)))
        check(f"{label}: the malformed file is one readable WARN in the Findings", any(x["severity"] == "warn" and "could not be read" in x["title"] and "broken" in x["detail"] and "not valid YAML" in x["detail"] for x in fs), [(x["severity"], x["title"], x["detail"][:80]) for x in fs])
    except Exception as e:  # noqa: BLE001
        check(f"{label}: the parser survives the odd files", False, repr(e))

# pods: one file per pod
root = gather("pods")
put(root, "namespaces/ok/pods/web/web.yaml", "kind: Pod\nmetadata:\n  name: web\n  namespace: ok\nspec:\n  containers: []\nstatus:\n  phase: Running\n")
put(root, "namespaces/ok/pods/empty/empty.yaml", "")
put(root, "namespaces/ok/pods/nulldoc/nulldoc.yaml", "null\n")
put(root, "namespaces/ok/pods/broken/broken.yaml", "kind: Pod\nmetadata: [unclosed\n")
r = pod.parse(root)
fs = pod.findings(root)
ok_ns = r.get("ok") or {}
check("pods: the good pod is listed, the broken one carries a readable reason", "web" in ok_ns and ok_ns.get("broken", {}).get("error", "").startswith("not valid YAML") and not raw_text(r), {k: (v.get('error') if isinstance(v, dict) else v) for k, v in ok_ns.items()})
check("pods: an empty file / a null document is a pod that could not be read, with a readable reason", all(ok_ns.get(k, {}).get("error") for k in ("empty", "nulldoc")) and not raw_text(ok_ns), ok_ns.get("empty"))
check("pods: one WARN names the pod files that could not be read", any(x["severity"] == "warn" and "could not be read" in x["title"] and not raw_text(x) for x in fs), [x["title"] for x in fs])

# nodes: one file per node
root = gather("nodes")
put(root, "cluster-scoped-resources/core/nodes/good.yaml", "kind: Node\nmetadata:\n  name: good\nstatus:\n  conditions:\n  - type: Ready\n    status: 'True'\n")
put(root, "cluster-scoped-resources/core/nodes/empty.yaml", "")
put(root, "cluster-scoped-resources/core/nodes/broken.yaml", "kind: Node\nmetadata: [unclosed\n")
r = nodes.parse(root)
fs = nodes.findings(root)
check("nodes: the good node is listed, the empty file skipped, the broken one a readable error", "good" in r and "empty.yaml" not in r and r.get("broken.yaml", {}).get("message", "").startswith("not valid YAML") and not raw_text(r), r.get("broken.yaml"))
check("nodes: one WARN names the node file that could not be read", any(x["severity"] == "warn" and "could not be read" in x["title"] and "broken.yaml" in x["detail"] for x in fs), [x["title"] for x in fs])

# CSRs and MCPs: multi-document files
for label, rel, kind_list, kind, mod in (("csr", "cluster-scoped-resources/certificates.k8s.io/certificatesigningrequests/{n}.yaml", "CertificateSigningRequestList", "CertificateSigningRequest", csr),
                                         ("mcp", "cluster-scoped-resources/machineconfiguration.openshift.io/machineconfigpools/{n}.yaml", "MachineConfigPoolList", "MachineConfigPool", mcp)):
    root = gather("multi-" + label)
    put(root, rel.format(n="one"), f"kind: {kind_list}\nitems:\n- kind: {kind}\n  metadata:\n    name: one\n  spec: {{}}\n  status: {{}}\n")
    put(root, rel.format(n="nullitems"), f"kind: {kind_list}\nitems: null\n")
    put(root, rel.format(n="emptyitems"), f"kind: {kind_list}\nitems: []\n")
    put(root, rel.format(n="emptyfile"), "")
    put(root, rel.format(n="single"), f"kind: {kind}\nmetadata:\n  name: alone\nspec: {{}}\nstatus: {{}}\n")
    put(root, rel.format(n="broken"), f"kind: {kind_list}\nitems:\n  - this: [is not closed\n")
    try:
        r = mod.parse(root)
        fs = mod.findings(root)
        good = [x for x in r if not x.get("error")]
        bad = [x for x in r if x.get("error")]
        check(f"{label}: the one and the single object are listed, the null / empty files are nothing, the broken one a readable error", len(good) == 2 and len(bad) == 1 and bad[0]["reason"].startswith("not valid YAML") and not raw_text(r), (len(good), bad))
        check(f"{label}: one WARN names the broken file", any(x["severity"] == "warn" and "could not be read" in x["title"] and "broken" in x["detail"] and not raw_text(x) for x in fs), [x["title"] for x in fs])
    except Exception as e:  # noqa: BLE001
        check(f"{label}: the parser survives the odd files", False, repr(e))

shutil.rmtree(WORK, ignore_errors=True)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
