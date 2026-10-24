import os
import yaml
import glob

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all

def parse(directory):
    result = []

    directory = resolve_data_dir(directory)

    # Look for cluster-scoped-resources/certificates.k8s.io/certificatesigningrequests/*.yaml
    csr_path = os.path.join(directory, "cluster-scoped-resources", "certificates.k8s.io", "certificatesigningrequests")

    if not os.path.exists(csr_path):
        return result

    # Find all YAML files in the certificatesigningrequests directory
    yaml_files = glob.glob(os.path.join(csr_path, "*.yaml"))

    for filepath in yaml_files:
        try:
            with open(filepath, "r") as f:
                # YAML files may contain multiple documents (separated by ---)
                docs = safe_load_all(f)

                for doc in docs:
                    if not doc:
                        continue

                    # Handle both single CSR and CertificateSigningRequestList
                    if doc.get("kind") == "CertificateSigningRequestList" and "items" in doc:
                        for item in doc["items"]:
                            if item.get("kind") == "CertificateSigningRequest":
                                result.append(parse_csr(item))
                    elif doc.get("kind") == "CertificateSigningRequest":
                        result.append(parse_csr(doc))

        except Exception as e:
            result.append({"error": str(e), "file": filepath})

    # the ones that need a hand first: Pending, then Denied / Failed, then Approved, newest first
    result.sort(key=lambda c: ({'Pending': 0, 'Denied': 1, 'Failed': 1}.get(c.get('status'), 2), c.get('created') or ''))
    remember(('csr', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('csr', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No CertificateSigningRequests in this must-gather', ['cluster-scoped-resources/certificates.k8s.io/certificatesigningrequests'], 'trimmed gather')]


def parse_csr(csr):
    """Parse a single CertificateSigningRequest object"""
    metadata = csr.get("metadata", {})
    spec = csr.get("spec", {})
    status = csr.get("status", {})

    name = metadata.get("name", "")
    created = metadata.get("creationTimestamp", "")

    # Extract spec fields
    signer_name = spec.get("signerName", "")
    username = spec.get("username", "")
    groups = spec.get("groups", [])
    usages = spec.get("usages", [])
    expiration_seconds = spec.get("expirationSeconds", 0)

    # Extract status
    conditions = status.get("conditions", [])
    certificate = status.get("certificate", "")

    # Determine overall status from conditions
    csr_status = "Pending"
    status_reason = ""
    status_message = ""

    for cond in conditions:
        cond_type = cond.get("type", "")
        cond_status = cond.get("status", "")

        if cond_type == "Approved" and cond_status == "True":
            csr_status = "Approved"
            status_reason = cond.get("reason", "")
            status_message = cond.get("message", "")
        elif cond_type == "Denied" and cond_status == "True":
            csr_status = "Denied"
            status_reason = cond.get("reason", "")
            status_message = cond.get("message", "")
            break  # Denied takes precedence
        elif cond_type == "Failed" and cond_status == "True":
            csr_status = "Failed"
            status_reason = cond.get("reason", "")
            status_message = cond.get("message", "")
            break

    # Check if certificate was issued
    has_certificate = bool(certificate)

    return {
        "name": name,
        "signer_name": signer_name,
        "username": username,
        "groups": groups,
        "usages": usages,
        "expiration_seconds": expiration_seconds,
        "status": csr_status,
        "status_reason": status_reason,
        "status_message": status_message,
        "has_certificate": has_certificate,
        "created": created,
        "conditions": conditions,
        "raw": csr
    }

def findings_for(csrs):
    """The Findings strip: pending CSRs (warn: a node's kubelet waits for its certificate), denied or failed ones
    (warn), the counts."""
    out = []
    pending = [c for c in csrs if c.get('status') == 'Pending']
    if pending:
        out.append(finding('warn', f"{len(pending)} CSR{'s' if len(pending) != 1 else ''} pending", ', '.join(f"{c['name']} ({c.get('username') or c.get('signer_name', '')})" for c in pending[:5]) + (' …' if len(pending) > 5 else '') + "; a kubelet's serving or client certificate waits for approval (oc adm certificate approve)", count=len(pending)))
    bad = [c for c in csrs if c.get('status') in ('Denied', 'Failed')]
    if bad:
        out.append(finding('warn', f"{len(bad)} CSR{'s' if len(bad) != 1 else ''} denied or failed", ', '.join(f"{c['name']}: {c.get('status_reason') or c.get('status')}" for c in bad[:5]), count=len(bad)))
    errors = [c for c in csrs if c.get('error')]
    if errors:
        out.append(finding('warn', f"{len(errors)} CSR file{'s' if len(errors) != 1 else ''} could not be read", str(errors[0].get('error'))[:200]))
    if not csrs:
        out.append(finding('info', 'No CSRs in this must-gather'))
    elif not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{len(csrs)} CSRs, all approved"))
    return sort_findings(out)
