"""Overview for the "Security & Certificates" tab of a must-gather.

The tab itself has two sub-tabs (Certificate Signing Requests, TLS Secret
Expiration). Clicking the parent header loads this summary, which aggregates
both sub-parsers: certificate counts by status, the certificates that need
attention and the pending CSRs, with links to the detailed sub-tabs.
"""
from parsers.findings import sort_findings
from parsers.mustgather import csr as csr_parser
from parsers.mustgather import tls_secrets as tls_parser

TLS_STATUSES = ("Expired", "Expiring Soon", "Valid")
CSR_STATUSES = ("Pending", "Approved", "Denied", "Failed")


def _summarise_tls(secrets):
    counts = {status: 0 for status in TLS_STATUSES}
    attention = []
    errors = []
    for secret in secrets:
        if "error" in secret and "status" not in secret:
            errors.append({"file": secret.get("file", ""), "error": secret["error"]})
            continue
        status = secret.get("status", "")
        counts[status] = counts.get(status, 0) + 1
        if status in ("Expired", "Expiring Soon"):
            attention.append({
                "namespace": secret.get("namespace", ""),
                "name": secret.get("name", ""),
                "status": status,
                "days_left": secret.get("days_left", 0),
                "days_display": secret.get("days_display", ""),
                "expiry": secret.get("expiry", ""),
            })
    attention.sort(key=lambda s: s["days_left"])
    return {
        "total": sum(counts.values()),
        "counts": counts,
        "attention": attention,
        "errors": errors,
    }


def _summarise_csr(requests):
    counts = {status: 0 for status in CSR_STATUSES}
    pending = []
    errors = []
    for req in requests:
        if "error" in req and "status" not in req:
            errors.append({"file": req.get("file", ""), "error": req["error"]})
            continue
        status = req.get("status", "")
        counts[status] = counts.get(status, 0) + 1
        if status == "Pending":
            pending.append({
                "name": req.get("name", ""),
                "username": req.get("username", ""),
                "signer_name": req.get("signer_name", ""),
            })
    pending.sort(key=lambda r: r["name"])
    return {
        "total": sum(counts.values()),
        "counts": counts,
        "pending": pending,
        "errors": errors,
    }


def parse(directory):
    tls = _summarise_tls(tls_parser.parse(directory) or [])
    csrs = _summarise_csr(csr_parser.parse(directory) or [])
    findings = []
    for mod in (tls_parser, csr_parser):
        for f in (mod.findings(directory) if hasattr(mod, 'findings') else []):
            f = dict(f)
            f['title'] = ('TLS: ' if mod is tls_parser else 'CSR: ') + f['title']
            if f.get('severity') in ('bad', 'warn') and not f.get('link'):
                f['link'] = {'tab': 'security', 'sub_tab': 'tls_secrets' if mod is tls_parser else 'csr', 'query': ''}
            findings.append(f)
    return {
        "findings": sort_findings(findings),
        "tls": tls,
        "csr": csrs,
        "needs_attention": (
            tls["counts"]["Expired"] + tls["counts"]["Expiring Soon"] + csrs["counts"]["Pending"]
        ),
    }
