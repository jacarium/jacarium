import os
import yaml
import glob

from parsers.mustgather._common import resolve_data_dir

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
                docs = yaml.safe_load_all(f)

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

    return result


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
