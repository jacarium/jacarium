"""Synthetic API audit logs for the must-gather mock (audit_logs/), in the
layout a real must-gather uses and the audit.k8s.io/v1 Event schema:

    audit_logs/<apiserver>.audit_logs_listing            "<node> <file>" per line
    audit_logs/kube-apiserver/<node>-audit.log.gz        the current file
    audit_logs/kube-apiserver/<node>-audit-<stamp>.log.gz  a rotated one
    audit_logs/kube-apiserver/<node>-termination.log.gz  klog text, not audit
    audit_logs/openshift-apiserver/<node>-audit.log.gz
    audit_logs/oauth-apiserver/<node>-audit.log.gz
    audit_logs/oauth-server/<node>-audit.log.gz          level RequestResponse

Everything is made up by a seeded RNG: example.test names, documentation
addresses (192.0.2.x, 198.51.100.x), users "alice" / "bob-admin" (oauth
groups, no e-mail-shaped names) and service accounts of the demo
namespaces, a spike of denied secret lists from a noisy scanner agent,
throttled (429) requests, sensitive deletes, RBAC changes, secret reads
by a human user, impersonation, slow requests, long-running watches and
a few malformed lines. generate() returns the events it wrote (the
tests compute their expectations from them) next to the file contents.
"""
import base64
import gzip
import io
import json
import random
import uuid
from datetime import datetime, timedelta, timezone

MASTERS = ["master-0", "master-1", "master-2"]
APISERVERS = ["kube-apiserver", "openshift-apiserver", "oauth-apiserver", "oauth-server"]
SENSITIVE = ("namespaces", "secrets", "configmaps", "customresourcedefinitions", "roles", "rolebindings", "clusterroles", "clusterrolebindings")

SERVICE_ACCOUNTS = [
    ("system:serviceaccount:openshift-monitoring:prometheus-k8s", "Prometheus/2.52.0", "192.0.2.21"),
    ("system:serviceaccount:kube-system:generic-garbage-collector", "kube-controller-manager/v1.29.4 (linux/amd64) kubernetes/0a1b2c3/system:serviceaccount:kube-system:generic-garbage-collector", "192.0.2.11"),
    ("system:serviceaccount:demo-app:default", "Go-http-client/2.0", "192.0.2.41"),
    ("system:serviceaccount:openshift-machine-config-operator:machine-config-daemon", "machine-config-daemon/v4.16.0 (linux/amd64)", "192.0.2.12"),
    ("system:serviceaccount:payments-demo:payments-api", "payments-api/1.4.2", "192.0.2.42"),
]
HUMANS = [
    ("alice", ["system:authenticated:oauth", "developers"], "kubectl/v1.29.4 (darwin/arm64) kubernetes/0a1b2c3", "198.51.100.23"),
    ("bob-admin", ["system:authenticated:oauth", "system:cluster-admins"], "oc/4.16.0 (linux/amd64) kubernetes/1d2e3f4", "198.51.100.24"),
    ("svc-deployer", ["system:authenticated:oauth", "deployers"], "argocd-application-controller/v2.11.3", "198.51.100.25"),
]
NODE_USERS = [(f"system:node:{m}", "kubelet/v1.29.4 (linux/amd64) kubernetes/0a1b2c3", f"192.0.2.{101 + i}") for i, m in enumerate(MASTERS)]
NOISY = ("system:serviceaccount:demo-app:example-scanner", "example-scanner/0.1 (burst)", "192.0.2.77")

RESOURCES = [  # (apiGroup, resource, namespace or None, name prefix, weight)
    ("", "pods", "demo-app", "demo-web-", 30), ("", "pods", "payments-demo", "payments-api-", 20), ("", "configmaps", "openshift-monitoring", "prometheus-", 12),
    ("", "endpoints", "kube-system", "kube-controller-manager", 10), ("", "nodes", None, "master-", 8), ("", "secrets", "openshift-monitoring", "prometheus-tls-", 6),
    ("apps", "deployments", "demo-app", "demo-web", 8), ("apps", "replicasets", "payments-demo", "payments-api-", 6), ("", "events", "demo-app", "demo-web-", 10),
    ("coordination.k8s.io", "leases", "kube-node-lease", "master-", 25), ("", "serviceaccounts", "demo-app", "default", 4), ("", "namespaces", None, "demo-app", 5),
    ("rbac.authorization.k8s.io", "rolebindings", "demo-app", "team-binding-", 2), ("config.openshift.io", "clusterversions", None, "version", 3),
    ("machineconfiguration.openshift.io", "machineconfigs", None, "rendered-master-", 2), ("route.openshift.io", "routes", "demo-app", "demo-web", 4),
    ("", "persistentvolumeclaims", "payments-demo", "payments-db-", 2), ("apiextensions.k8s.io", "customresourcedefinitions", None, "example", 2),
]
VERBS = [("get", 40), ("list", 18), ("watch", 10), ("create", 8), ("update", 9), ("patch", 9), ("delete", 4), ("deletecollection", 1)]


def _ts(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _weighted(rnd, items):
    total = sum(w for *_, w in items)
    x = rnd.uniform(0, total)
    for item in items:
        x -= item[-1]
        if x <= 0:
            return item
    return items[-1]


def event(rnd, at, user, groups, agent, ip, verb, api_group, resource, namespace, name, code, apiserver, *, subresource=None, reason=None,
          decision=None, impersonated=None, latency_ms=None, stage="ResponseComplete", level="Metadata", retry_after=None, deprecated=False, extra=None):
    received = at
    done = at + timedelta(milliseconds=latency_ms if latency_ms is not None else rnd.uniform(2, 180))
    if namespace:
        uri = f"/api/v1/namespaces/{namespace}/{resource}" if not api_group else f"/apis/{api_group}/v1/namespaces/{namespace}/{resource}"
    else:
        uri = f"/api/v1/{resource}" if not api_group else f"/apis/{api_group}/v1/{resource}"
    if name and verb not in ("list", "watch", "create", "deletecollection"):
        uri += f"/{name}"
    if subresource:
        uri += f"/{subresource}"
    if verb == "watch":
        uri += "?watch=true&resourceVersion=48123456&timeoutSeconds=1800"
    elif verb == "list":
        uri += "?limit=500"
    ev = {
        "kind": "Event", "apiVersion": "audit.k8s.io/v1", "level": level,
        "auditID": str(uuid.UUID(int=rnd.getrandbits(128))), "stage": stage, "requestURI": uri, "verb": verb,
        "user": {"username": user, "groups": groups}, "sourceIPs": [ip], "userAgent": agent,
        "objectRef": {"resource": resource, "apiVersion": "v1"},
        "responseStatus": {"metadata": {}, "code": code},
        "requestReceivedTimestamp": _ts(received), "stageTimestamp": _ts(done),
        "annotations": {"authorization.k8s.io/decision": decision or ("forbid" if code == 403 else "allow"),
                        "authorization.k8s.io/reason": reason or ("RBAC: allowed by ClusterRoleBinding \"cluster-admin\" of ClusterRole \"cluster-admin\" to Group \"system:masters\"" if code != 403 else "")},
    }
    if api_group:
        ev["objectRef"]["apiGroup"] = api_group
    if namespace:
        ev["objectRef"]["namespace"] = namespace
    if name and verb not in ("list", "watch", "deletecollection"):
        ev["objectRef"]["name"] = name
    if subresource:
        ev["objectRef"]["subresource"] = subresource
    if user.startswith("system:serviceaccount:"):
        ns, sa = user.split(":")[2:4]
        ev["user"]["uid"] = str(uuid.UUID(int=rnd.getrandbits(128)))
        ev["user"]["groups"] = ["system:serviceaccounts", f"system:serviceaccounts:{ns}", "system:authenticated"]
        ev["user"]["extra"] = {"authentication.kubernetes.io/pod-name": [f"{sa}-{rnd.randint(0, 9)}"], "authentication.kubernetes.io/pod-uid": [str(uuid.UUID(int=rnd.getrandbits(128)))]}
    if impersonated:
        ev["impersonatedUser"] = {"username": impersonated, "groups": ["system:serviceaccounts", "system:authenticated"]}
    if code >= 400:
        ev["responseStatus"].update({"status": "Failure", "reason": {403: "Forbidden", 404: "NotFound", 409: "Conflict", 422: "Invalid", 429: "TooManyRequests", 500: "InternalError", 503: "ServiceUnavailable"}.get(code, "Failure"),
                                     "message": {403: f"{resource} is forbidden: User \"{user}\" cannot {verb} resource \"{resource}\" in API group \"{api_group}\"" + (f" in the namespace \"{namespace}\"" if namespace else ""),
                                                 429: "Too many requests, please try again later.", 500: "etcdserver: request timed out", 404: f"{resource} \"{name}\" not found"}.get(code, "")})
    if retry_after:
        ev["responseStatus"]["details"] = {"retryAfterSeconds": retry_after}
    if deprecated:
        ev["annotations"]["k8s.io/deprecated"] = "true"
        ev["annotations"]["k8s.io/removed-release"] = "1.32"
    if extra:
        ev.update(extra)
    ev["_apiserver"] = apiserver  # stripped before writing; the tests read it
    return ev


def generate(rnd_seed=20261013, collected=None, kube_events_per_master=700, profile="Default", extra_window=None):
    """profile: "Default" (metadata only), "WriteRequestBodies" (every master
    records write bodies), "AllRequestBodies" (reads too) or "Mixed"
    (master-2 records write bodies, the other masters do not: a profile
    change during the capture, or a custom rule). The body story (image
    bump, scale, RBAC grant and revoke, ConfigMap and Secret key edits, a
    node cordon, CRD / webhook / SCC changes, deleteOptions) is written on
    master-2 whenever bodies are recorded.
    extra_window=(hours_after_collection, minutes, events_per_master): a second
    capture window (routine kube-apiserver traffic on every master) that
    long after the first one, like a lab powered off in between; the plan's
    'collected' moves to its end.
    -> {'events': [...], 'files': {relpath: bytes}, 'malformed': n, 'spike_minute': iso, 'body_events': [...], 'body_nodes': [...]}"""
    rnd = random.Random(rnd_seed)
    collected = collected or datetime(2026, 10, 12, 14, 40, 12, tzinfo=timezone.utc)
    start = collected - timedelta(hours=2)
    rotate_at = collected - timedelta(minutes=50)
    events = []
    body_nodes = {"Default": [], "WriteRequestBodies": list(MASTERS), "AllRequestBodies": list(MASTERS), "Mixed": ["master-2"]}[profile]
    read_bodies = profile == "AllRequestBodies"
    rv_counter = [10_000]

    def add(ev, node):
        ev["_node"] = node
        # the profile: routine writes on a body node carry request / response objects (never for Secrets or other
        # sensitive resources: OpenShift keeps those at Metadata in every profile)
        ref = ev.get("objectRef") or {}
        resource = ref.get("resource", "")
        if node in body_nodes and ev["stage"] == "ResponseComplete" and ev["level"] == "Metadata" and resource not in ("secrets", "routes", "oauthclients", "oauthaccesstokens", "useroauthaccesstokens", "oauth/authorize") and ev["_apiserver"] in ("kube-apiserver", "openshift-apiserver", "oauth-apiserver"):
            is_write = ev["verb"] in ("create", "update", "patch", "delete", "deletecollection")
            if is_write and ev["responseStatus"]["code"] < 400:
                rv_counter[0] += 1
                req, resp = _generic_body(ev["verb"], ref.get("apiGroup", ""), resource, ref.get("namespace"), ref.get("name", resource), rv_counter[0])
                ev["level"] = "RequestResponse"; ev["requestObject"] = req; ev["responseObject"] = resp
            elif read_bodies and not is_write and ev["verb"] in ("get", "list") and ev["responseStatus"]["code"] < 400:
                rv_counter[0] += 1
                ev["level"] = "RequestResponse"; ev["responseObject"] = _generic_body("get", ref.get("apiGroup", ""), resource, ref.get("namespace"), ref.get("name", resource), rv_counter[0])[1]
        events.append(ev)
        return ev

    # routine traffic on every master's kube-apiserver
    for node in MASTERS:
        for _ in range(kube_events_per_master):
            at = start + timedelta(seconds=rnd.uniform(0, 7000))
            who = rnd.random()
            if who < 0.55:
                user, agent, ip = rnd.choice(SERVICE_ACCOUNTS); groups = []
            elif who < 0.8:
                user, agent, ip = rnd.choice(NODE_USERS); groups = ["system:nodes", "system:authenticated"]
            else:
                user, groups, agent, ip = rnd.choice(HUMANS)
            group, resource, ns, prefix, _ = _weighted(rnd, RESOURCES)
            verb = _weighted(rnd, VERBS)[0]
            name = prefix + (f"{rnd.randint(0, 99):02d}" if prefix.endswith("-") else "")
            code = rnd.choices([200, 201, 404, 409, 422, 500, 503], weights=[86, 6, 4, 1.5, 1, 1, 0.5])[0]
            if verb == "create":
                code = 201 if code == 200 else code
            if verb == "watch":
                add(event(rnd, at, user, groups, agent, ip, verb, group, resource, ns, None, 200, "kube-apiserver", stage="ResponseStarted", latency_ms=rnd.uniform(1, 5)), node)
                add(event(rnd, at, user, groups, agent, ip, verb, group, resource, ns, None, 200, "kube-apiserver", latency_ms=rnd.uniform(60_000, 1_800_000)), node)
                continue
            add(event(rnd, at, user, groups, agent, ip, verb, group, resource, ns, name, code, "kube-apiserver", deprecated=(resource == "endpoints" and rnd.random() < 0.3)), node)
    # the spike: the scanner lists secrets in every namespace, denied, 400 times within one minute (one master)
    spike = (start + timedelta(minutes=71)).replace(second=0, microsecond=0)
    for i in range(400):
        add(event(rnd, spike + timedelta(seconds=rnd.uniform(0, 59)), NOISY[0], [], NOISY[1], NOISY[2], "list", "", "secrets", rnd.choice(["openshift-config", "kube-system", "demo-app", "payments-demo"]), None, 403, "kube-apiserver",
                  reason="RBAC: no RBAC policy matched", latency_ms=rnd.uniform(1, 4)), "master-1")
    # alice denied on openshift-config secrets (5x), then reads demo-app secrets (allowed, 3x): secret reads by a human
    for i in range(5):
        add(event(rnd, start + timedelta(minutes=30 + i), HUMANS[0][0], HUMANS[0][1], HUMANS[0][2], HUMANS[0][3], "get", "", "secrets", "openshift-config", "pull-secret", 403, "kube-apiserver",
                  reason="RBAC: no RBAC policy matched"), "master-0")
    for i in range(3):
        add(event(rnd, start + timedelta(minutes=40 + i), HUMANS[0][0], HUMANS[0][1], HUMANS[0][2], HUMANS[0][3], "get", "", "secrets", "demo-app", "db-credentials", 200, "kube-apiserver"), "master-0")
    # bob-admin impersonates the demo-app service account to list pods (4x) and a deploy
    for i in range(4):
        add(event(rnd, start + timedelta(minutes=50 + i), HUMANS[1][0], HUMANS[1][1], HUMANS[1][2], HUMANS[1][3], "list", "", "pods", "demo-app", None, 200, "kube-apiserver",
                  impersonated="system:serviceaccount:demo-app:default"), "master-2")
    # sensitive deletes and RBAC changes
    sens = [
        (HUMANS[1], "delete", "", "namespaces", None, "payments-demo-old", 200, 95),
        (HUMANS[1], "delete", "", "secrets", "demo-app", "db-credentials-old", 200, 96),
        (HUMANS[0], "delete", "", "configmaps", "demo-app", "feature-flags", 200, 97),
        (HUMANS[1], "delete", "rbac.authorization.k8s.io", "clusterrolebindings", None, "legacy-admins", 200, 98),
        (HUMANS[2], "delete", "apiextensions.k8s.io", "customresourcedefinitions", None, "widgets.example.test", 200, 99),
        (HUMANS[0], "delete", "", "secrets", "openshift-config", "pull-secret", 403, 100),
        (HUMANS[1], "create", "rbac.authorization.k8s.io", "rolebindings", "demo-app", "developers-edit", 201, 101),
        (HUMANS[1], "patch", "rbac.authorization.k8s.io", "clusterroles", None, "developers-view", 200, 102),
        (HUMANS[2], "update", "rbac.authorization.k8s.io", "roles", "payments-demo", "deployer", 200, 103),
        (HUMANS[1], "deletecollection", "", "configmaps", "payments-demo", None, 200, 104),
    ]
    for (user, groups, agent, ip), verb, group, resource, ns, name, code, minute in sens:
        add(event(rnd, start + timedelta(minutes=minute), user, groups, agent, ip, verb, group, resource, ns, name, code, "kube-apiserver",
                  reason="RBAC: no RBAC policy matched" if code == 403 else None), "master-0")
    # svc-deployer denied on an old registry secret, early in the capture, on master-2: the Security page's sample (the first
    # 100 forbidden events in file order) never holds it, so only a search over every event finds it
    add(event(rnd, start + timedelta(minutes=9), HUMANS[2][0], HUMANS[2][1], HUMANS[2][2], HUMANS[2][3], "get", "", "secrets", "payments-demo", "registry-creds-old", 403, "kube-apiserver",
              reason="RBAC: no RBAC policy matched"), "master-2")
    # throttling: Prometheus gets 429s (20x) with Retry-After
    for i in range(20):
        add(event(rnd, spike + timedelta(seconds=i * 2), SERVICE_ACCOUNTS[0][0], [], SERVICE_ACCOUNTS[0][1], SERVICE_ACCOUNTS[0][2], "list", "", "pods", None, None, 429, "kube-apiserver",
                  retry_after=1, latency_ms=rnd.uniform(1, 3)), "master-1")
    # slow requests (not watches)
    slow = [("list", "", "pods", None, None, 8500, SERVICE_ACCOUNTS[0]), ("list", "", "events", None, None, 6200, SERVICE_ACCOUNTS[2]), ("get", "", "configmaps", "openshift-monitoring", "prometheus-k8s-rulefiles-0", 3200, SERVICE_ACCOUNTS[0]),
            ("create", "apps", "deployments", "demo-app", "demo-web", 2900, HUMANS[2]), ("list", "", "secrets", None, None, 2100, SERVICE_ACCOUNTS[3])]
    for i, (verb, group, resource, ns, name, ms, who) in enumerate(slow):
        user, agent, ip = who[0], who[-2], who[-1]
        groups = who[1] if len(who) == 4 else []
        add(event(rnd, start + timedelta(minutes=20 + i * 7), user, groups, agent, ip, verb, group, resource, ns, name, 200 if verb != "create" else 201, "kube-apiserver", latency_ms=ms), "master-2")
    # openshift-apiserver: routes, projects, builds
    for node in MASTERS:
        for _ in range(110):
            at = start + timedelta(seconds=rnd.uniform(0, 7000))
            user, groups, agent, ip = rnd.choice(HUMANS) if rnd.random() < 0.4 else (SERVICE_ACCOUNTS[2][0], [], SERVICE_ACCOUNTS[2][1], SERVICE_ACCOUNTS[2][2])
            group, resource, ns = rnd.choice([("route.openshift.io", "routes", "demo-app"), ("project.openshift.io", "projects", None), ("build.openshift.io", "builds", "demo-app"), ("image.openshift.io", "imagestreams", "demo-app")])
            add(event(rnd, at, user, groups, agent, ip, rnd.choice(["get", "list", "get", "watch", "create"]), group, resource, ns, "demo-web", rnd.choices([200, 201, 404, 403], weights=[90, 4, 4, 2])[0], "openshift-apiserver"), node)
    # oauth-apiserver: tokens and identities
    for node in MASTERS:
        for _ in range(35):
            at = start + timedelta(seconds=rnd.uniform(0, 7000))
            user, groups, agent, ip = rnd.choice(HUMANS)
            add(event(rnd, at, user, groups, agent, ip, rnd.choice(["get", "create", "list"]), "oauth.openshift.io", rnd.choice(["oauthaccesstokens", "useroauthaccesstokens", "identities"]), None, "sha256~example", rnd.choice([200, 201, 200, 401]), "oauth-apiserver"), node)
    # oauth-server: the login flow at RequestResponse level (the real one carries requestObject/responseObject)
    for node in MASTERS:
        for i in range(10):
            at = start + timedelta(minutes=rnd.randint(1, 118))
            user, groups, agent, ip = rnd.choice(HUMANS)
            add(event(rnd, at, user, groups, "Mozilla/5.0 (X11; Linux x86_64) example-browser/1.0", ip, "post", "", "oauth/authorize", None, None, 302, "oauth-server", level="RequestResponse",
                      extra={"requestObject": {"apiVersion": "oauth.openshift.io/v1", "kind": "OAuthAuthorizeToken", "clientName": "openshift-browser-client", "scopes": ["user:full"]},
                             "responseObject": {"apiVersion": "oauth.openshift.io/v1", "kind": "OAuthAuthorizeToken", "clientName": "openshift-browser-client", "scopes": ["user:full"]}}), node)

    body_events = body_story(rnd, start, "master-2", add) if body_nodes else []

    # the second capture window: the same routine traffic, hours later, nothing in between
    second = None
    if extra_window:
        hours, minutes, per_master = extra_window
        second = (collected + timedelta(hours=hours), collected + timedelta(hours=hours, minutes=minutes))
        for node in MASTERS:
            for _ in range(per_master):
                at = second[0] + timedelta(seconds=rnd.uniform(0, minutes * 60))
                user, agent, ip = rnd.choice(SERVICE_ACCOUNTS)
                group, resource, ns, prefix, _ = _weighted(rnd, RESOURCES)
                verb = _weighted(rnd, VERBS)[0]
                if verb == "watch":
                    verb = "list"
                name = prefix + (f"{rnd.randint(0, 99):02d}" if prefix.endswith("-") else "")
                add(event(rnd, at, user, [], agent, ip, verb, group, resource, ns, name, rnd.choices([200, 201, 404], weights=[90, 6, 4])[0], "kube-apiserver"), node)
        collected = second[1]

    # files: per apiserver and node, the rotated file holds the older events; a few malformed lines in the current kube-apiserver files
    files = {}
    malformed_lines = ['{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"Metadata","auditID":"truncated', "garbage line, not JSON", "", "[]", '{"kind":"NotAnEvent"}']
    malformed = 0
    for apiserver in APISERVERS:
        listing = []
        for node in MASTERS:
            mine = sorted((e for e in events if e["_apiserver"] == apiserver and e["_node"] == node), key=lambda e: e["requestReceivedTimestamp"])
            if not mine:
                continue
            current = [e for e in mine if e["requestReceivedTimestamp"] >= _ts(rotate_at)] if apiserver == "kube-apiserver" else mine
            rotated = [e for e in mine if e["requestReceivedTimestamp"] < _ts(rotate_at)] if apiserver == "kube-apiserver" else []
            cur_lines = [json.dumps({k: v for k, v in e.items() if not k.startswith("_")}, separators=(",", ":")) for e in current]
            if apiserver == "kube-apiserver":
                for i, bad in enumerate(malformed_lines):
                    cur_lines.insert(min(len(cur_lines), 10 * (i + 1)), bad)
                    malformed += 1 if bad.strip() else 0  # an empty line is skipped silently, not counted
            files[f"audit_logs/{apiserver}/{node}-audit.log.gz"] = _gz("\n".join(cur_lines) + "\n")
            listing += [f"{node} audit.log", f"{node} .lock"]
            if rotated:
                stamp = rotate_at.strftime("%Y-%m-%dT%H-%M-%S.000")
                files[f"audit_logs/{apiserver}/{node}-audit-{stamp}.log.gz"] = _gz("\n".join(json.dumps({k: v for k, v in e.items() if not k.startswith("_")}, separators=(",", ":")) for e in rotated) + "\n")
                listing.append(f"{node} audit-{stamp}.log")
            if apiserver == "kube-apiserver":
                files[f"audit_logs/{apiserver}/{node}-termination.log.gz"] = _gz(f"I1012 12:40:01.000001       1 main.go:213] Received signal terminated. Forwarding to sub-process \"hyperkube\".\nI1012 12:40:01.000400      12 genericapiserver.go:566] \"[graceful-termination] shutdown event\" name=\"ShutdownInitiated\"\n")
                listing.append(f"{node} termination.log")
        files[f"audit_logs/{apiserver}.audit_logs_listing"] = ("\n".join(listing) + "\n").encode()
    files["audit_logs/etcd.audit_logs_listing"] = b""
    # one plain (not gzipped) audit.log, like the monitoring metrics-server pods carry: non-resource requests (no objectRef, a plain URI path)
    def non_resource(i):
        e = event(rnd, start + timedelta(minutes=5 + i), SERVICE_ACCOUNTS[0][0], [], SERVICE_ACCOUNTS[0][1], SERVICE_ACCOUNTS[0][2], "get", "", "", None, None, 200, "monitoring")
        e.pop("objectRef", None)
        e["requestURI"] = ["/metrics", "/healthz", "/readyz", "/livez"][i % 4] + ("?verbose=1" if i % 4 else "")
        return e
    files["audit_logs/monitoring/metrics-server-5d6f7a8b9c-aaaaa/audit.log"] = ("\n".join(
        json.dumps({k: v for k, v in e.items() if not k.startswith("_")}, separators=(",", ":")) for e in (non_resource(i) for i in range(12))) + "\n").encode()
    return {"events": events, "files": files, "malformed": malformed, "spike_minute": spike.strftime("%Y-%m-%dT%H:%M"), "start": start, "collected": collected,
            "monitoring_events": 12, "body_events": body_events, "body_nodes": body_nodes, "profile": profile, "second_window": second}


# ---------------------------------------------------------------------------
# Request bodies (the WriteRequestBodies / AllRequestBodies profiles)
# ---------------------------------------------------------------------------
def _placeholder(key, n):
    """An obviously fake credential value, built at run time (base64 of a
    placeholder string) so no secret-shaped literal sits in this file."""
    return base64.b64encode(f"placeholder-{key}-v{n}-not-a-real-value".encode()).decode()


def _obj(kind, api, name, ns, rv, spec=None, extra=None, labels=None):
    o = {"apiVersion": api, "kind": kind, "metadata": {"name": name, "resourceVersion": str(rv), "uid": f"00000000-0000-4000-8000-{rv:012x}", "creationTimestamp": "2026-10-01T08:00:00Z",
                                                       "labels": labels or {"app": name}, "managedFields": [{"manager": "kubectl", "operation": "Update", "apiVersion": api}]}}
    if ns:
        o["metadata"]["namespace"] = ns
    if spec is not None:
        o["spec"] = spec
    if extra:
        o.update(extra)
    return o


STORY_DEPLOYMENT = "demo-web-blue"   # its own name, so the routine traffic's generic bodies do not overwrite its state


def _deployment(rv, image="quay.io/example-org/demo-web:1.4.0", replicas=3, cpu_limit="500m", env=None, labels=None):
    env = env if env is not None else [{"name": "DB_HOST", "value": "db.demo-app.svc"}, {"name": "DB_PASSWORD", "value": _placeholder("db-password", 1)}]
    return _obj("Deployment", "apps/v1", STORY_DEPLOYMENT, "demo-app", rv, labels=labels, spec={
        "replicas": replicas, "selector": {"matchLabels": {"app": "demo-web"}},
        "template": {"metadata": {"labels": {"app": "demo-web"}}, "spec": {"containers": [{"name": "web", "image": image, "env": env,
                                                                                            "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": cpu_limit, "memory": "512Mi"}}}]}}},
        extra={"status": {"replicas": replicas, "observedGeneration": rv % 10}})


def body_story(rnd, start, node, add):
    """The planted write events with bodies (level RequestResponse): a
    deployment's life (image bump, scale, resources and env, labels, a
    delete with deleteOptions), an RBAC grant then revoke, a clusterrole
    rule added, a ConfigMap key edit (one credential-like key), a Secret
    key rotation with placeholder values (OpenShift logs Secrets at
    Metadata in every profile; this one exists to prove the masking), a
    node cordon and taint, a CRD, a webhook and an SCC change."""
    who = HUMANS[1]  # bob-admin
    user, groups, agent, ip = who
    svc = HUMANS[2]

    def body_event(minute, verb, group, resource, ns, name, code, req, resp, sub=None, actor=None):
        a_user, a_groups, a_agent, a_ip = actor or who
        return add(event(rnd, start + timedelta(minutes=minute), a_user, a_groups, a_agent, a_ip, verb, group, resource, ns, name, code, "kube-apiserver",
                         subresource=sub, level="RequestResponse", extra={"requestObject": req, "responseObject": resp}), node)
    out = []
    # the deployment
    out.append(body_event(10, "create", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 201, _deployment(1000), _deployment(1000)))
    d = _deployment(1001, image="quay.io/example-org/demo-web:1.5.0")
    out.append(body_event(25, "update", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 200, d, d))
    out.append(body_event(32, "patch", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 200, [{"op": "replace", "path": "/spec/replicas", "value": 5}], _deployment(1002, image="quay.io/example-org/demo-web:1.5.0", replicas=5)))
    env2 = [{"name": "DB_PASSWORD", "value": _placeholder("db-password", 1)}, {"name": "FEATURE_X", "value": "on"}]
    d = _deployment(1003, image="quay.io/example-org/demo-web:1.5.0", replicas=5, cpu_limit="1", env=env2, labels={"app": "demo-web", "tier": "frontend"})
    d["metadata"]["annotations"] = {"example.test/owner": "payments-team"}
    out.append(body_event(44, "update", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 200, d, d, actor=svc))
    out.append(body_event(47, "update", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 200, {"apiVersion": "autoscaling/v1", "kind": "Scale", "metadata": {"name": STORY_DEPLOYMENT, "namespace": "demo-app"}, "spec": {"replicas": 2}},
                          {"apiVersion": "autoscaling/v1", "kind": "Scale", "metadata": {"name": STORY_DEPLOYMENT, "namespace": "demo-app", "resourceVersion": "1004"}, "spec": {"replicas": 2}, "status": {"replicas": 5}}, sub="scale"))
    # RBAC: grant alice, add bob, then revoke
    rb = _obj("RoleBinding", "rbac.authorization.k8s.io/v1", "developers-edit", "demo-app", 2000, extra={"subjects": [{"kind": "User", "name": "alice", "apiGroup": "rbac.authorization.k8s.io"}], "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "edit"}})
    out.append(body_event(60, "create", "rbac.authorization.k8s.io", "rolebindings", "demo-app", "developers-edit", 201, rb, rb))
    rb2 = json.loads(json.dumps(rb)); rb2["subjects"].append({"kind": "User", "name": "bob-admin", "apiGroup": "rbac.authorization.k8s.io"}); rb2["metadata"]["resourceVersion"] = "2001"
    out.append(body_event(66, "patch", "rbac.authorization.k8s.io", "rolebindings", "demo-app", "developers-edit", 200, {"subjects": rb2["subjects"]}, rb2))
    out.append(body_event(90, "delete", "rbac.authorization.k8s.io", "rolebindings", "demo-app", "developers-edit", 200, {"apiVersion": "meta.k8s.io/v1", "kind": "DeleteOptions", "propagationPolicy": "Background", "gracePeriodSeconds": 30}, {"apiVersion": "v1", "kind": "Status", "status": "Success"}))
    cr = _obj("ClusterRole", "rbac.authorization.k8s.io/v1", "developers-view", None, 2100, extra={"rules": [{"apiGroups": [""], "resources": ["pods", "configmaps"], "verbs": ["get", "list", "watch"]}]})
    out.append(body_event(70, "update", "rbac.authorization.k8s.io", "clusterroles", None, "developers-view", 200, cr, cr))
    cr2 = json.loads(json.dumps(cr)); cr2["rules"].append({"apiGroups": [""], "resources": ["secrets"], "verbs": ["get", "list"]}); cr2["metadata"]["resourceVersion"] = "2101"
    out.append(body_event(72, "update", "rbac.authorization.k8s.io", "clusterroles", None, "developers-view", 200, cr2, cr2))
    # ConfigMap: a key edited, a credential-like key (masked), a key added
    cm = _obj("ConfigMap", "v1", "feature-flags", "demo-app", 3000, extra={"data": {"log_level": "info", "db_password": _placeholder("cm-db-password", 1), "theme": "light"}})
    out.append(body_event(50, "update", "", "configmaps", "demo-app", "feature-flags", 200, cm, cm))
    cm2 = json.loads(json.dumps(cm)); cm2["data"]["log_level"] = "debug"; cm2["data"]["db_password"] = _placeholder("cm-db-password", 2); cm2["data"]["new_flag"] = "true"; del cm2["data"]["theme"]; cm2["metadata"]["resourceVersion"] = "3001"
    out.append(body_event(55, "update", "", "configmaps", "demo-app", "feature-flags", 200, cm2, cm2))
    # Secret: keys rotated (values are placeholders; the pages must never show them)
    sec = _obj("Secret", "v1", "db-credentials", "demo-app", 3100, extra={"type": "Opaque", "data": {"username": base64.b64encode(b"demo").decode(), "password": _placeholder("secret-password", 1)}})
    out.append(body_event(58, "update", "", "secrets", "demo-app", "db-credentials", 200, sec, sec))
    sec2 = json.loads(json.dumps(sec)); sec2["data"]["password"] = _placeholder("secret-password", 2); sec2["data"]["token"] = _placeholder("secret-token", 1); sec2["metadata"]["resourceVersion"] = "3101"
    out.append(body_event(59, "update", "", "secrets", "demo-app", "db-credentials", 200, sec2, sec2))
    # the node: cordon + taint (JSON patch)
    nd = _obj("Node", "v1", "worker-1", None, 4000, spec={"podCIDR": "10.128.2.0/23", "taints": []}, labels={"node-role.kubernetes.io/worker": ""})
    out.append(body_event(80, "update", "", "nodes", None, "worker-1", 200, nd, nd))
    nd2 = json.loads(json.dumps(nd)); nd2["spec"]["unschedulable"] = True; nd2["spec"]["taints"] = [{"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"}]; nd2["metadata"]["resourceVersion"] = "4001"
    out.append(body_event(81, "patch", "", "nodes", None, "worker-1", 200, [{"op": "add", "path": "/spec/unschedulable", "value": True}, {"op": "add", "path": "/spec/taints", "value": [{"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"}]}], nd2))
    # CRD, webhook, SCC
    crd = _obj("CustomResourceDefinition", "apiextensions.k8s.io/v1", "widgets.example.test", None, 5000, spec={"group": "example.test", "names": {"kind": "Widget", "plural": "widgets"}, "scope": "Namespaced", "versions": [{"name": "v1", "served": True, "storage": True}]})
    out.append(body_event(85, "update", "apiextensions.k8s.io", "customresourcedefinitions", None, "widgets.example.test", 200, crd, crd))
    crd2 = json.loads(json.dumps(crd)); crd2["spec"]["versions"].append({"name": "v2", "served": True, "storage": False}); crd2["metadata"]["resourceVersion"] = "5001"
    out.append(body_event(86, "update", "apiextensions.k8s.io", "customresourcedefinitions", None, "widgets.example.test", 200, crd2, crd2))
    wh = _obj("ValidatingWebhookConfiguration", "admissionregistration.k8s.io/v1", "example-policy", None, 5100, extra={"webhooks": [{"name": "policy.example.test", "failurePolicy": "Ignore", "sideEffects": "None"}]})
    out.append(body_event(87, "update", "admissionregistration.k8s.io", "validatingwebhookconfigurations", None, "example-policy", 200, wh, wh))
    wh2 = json.loads(json.dumps(wh)); wh2["webhooks"][0]["failurePolicy"] = "Fail"; wh2["metadata"]["resourceVersion"] = "5101"
    out.append(body_event(88, "update", "admissionregistration.k8s.io", "validatingwebhookconfigurations", None, "example-policy", 200, wh2, wh2))
    scc = _obj("SecurityContextConstraints", "security.openshift.io/v1", "example-restricted", None, 5200, extra={"allowPrivilegedContainer": False, "runAsUser": {"type": "MustRunAsRange"}})
    out.append(body_event(89, "update", "security.openshift.io", "securitycontextconstraints", None, "example-restricted", 200, scc, scc))
    scc2 = json.loads(json.dumps(scc)); scc2["allowPrivilegedContainer"] = True; scc2["metadata"]["resourceVersion"] = "5201"
    out.append(body_event(91, "update", "security.openshift.io", "securitycontextconstraints", None, "example-restricted", 200, scc2, scc2))
    # the deployment goes at the end, with deleteOptions
    out.append(body_event(110, "delete", "apps", "deployments", "demo-app", STORY_DEPLOYMENT, 200, {"apiVersion": "meta.k8s.io/v1", "kind": "DeleteOptions", "propagationPolicy": "Foreground", "gracePeriodSeconds": 0}, {"apiVersion": "v1", "kind": "Status", "status": "Success"}))
    return out


def _generic_body(verb, group, resource, ns, name, rv):
    """A small plausible object for a routine write at RequestResponse level."""
    kind = {"pods": "Pod", "configmaps": "ConfigMap", "deployments": "Deployment", "replicasets": "ReplicaSet", "events": "Event", "leases": "Lease", "serviceaccounts": "ServiceAccount",
            "namespaces": "Namespace", "rolebindings": "RoleBinding", "routes": "Route", "persistentvolumeclaims": "PersistentVolumeClaim", "machineconfigs": "MachineConfig", "nodes": "Node"}.get(resource, resource.capitalize())
    api = f"{group}/v1" if group else "v1"
    if verb == "delete":
        return {"apiVersion": "meta.k8s.io/v1", "kind": "DeleteOptions", "propagationPolicy": "Background"}, {"apiVersion": "v1", "kind": "Status", "status": "Success"}
    if verb == "patch":
        return {"metadata": {"labels": {"touched": "true"}}}, _obj(kind, api, name, ns, rv, labels={"app": name, "touched": "true"})
    o = _obj(kind, api, name, ns, rv, spec={"holderIdentity": name} if resource == "leases" else {"example": True})
    return o, o


def _gz(text):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as f:
        f.write(text.encode("utf-8"))
    return buf.getvalue()


def write(t, rnd_seed=20261013, collected=None, profile="Default", extra_window=None):
    """Write the files under the Tree t (the must-gather image directory); returns generate()'s plan."""
    plan = generate(rnd_seed, collected, profile=profile, extra_window=extra_window)
    for rel, data in plan["files"].items():
        t.write_bytes(rel, data)
    return plan
