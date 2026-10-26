#!/usr/bin/env python3
"""The package-level copy of an SPDX 2.3 SBOM, small enough to attest.

actions/attest refuses an SBOM over 16 MiB, and Syft's SPDX of the image is
about 18 MB: most of it is the 21 000 file entries and their CONTAINS
relationships. This copy keeps every package, its licences, PURLs, CPEs and
the package-to-package relationships, and leaves out the files (the full
SPDX and CycloneDX documents are still attached to the release).

    sbom-packages.py <full.spdx.json> <out.spdx.json>

Exits 1 when the result is still over the limit.
"""
import json
import sys

LIMIT = 16 * 1024 * 1024  # actions/attest's maximum SBOM size


def packages_only(doc):
    files = {f["SPDXID"] for f in doc.get("files", [])}
    doc.pop("files", None)
    doc["relationships"] = [
        r for r in doc.get("relationships", [])
        if r.get("spdxElementId") not in files and r.get("relatedSpdxElement") not in files
    ]
    for p in doc.get("packages", []):
        # no files listed: the package's files were not analysed in this document
        p["filesAnalyzed"] = False
        p.pop("packageVerificationCode", None)
        p.pop("hasFiles", None)
    doc["documentNamespace"] = doc["documentNamespace"].rstrip("/") + "/packages"
    info = doc.setdefault("creationInfo", {})
    info["comment"] = "Package-level copy of the full Syft SBOM (files left out to fit the 16 MiB attestation limit); the full SPDX and CycloneDX documents are attached to the release."
    return doc


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        doc = packages_only(json.load(fh))
    data = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    with open(argv[2], "wb") as fh:
        fh.write(data)
    print(f"sbom-packages: {argv[2]}: {len(doc.get('packages', []))} packages, {len(doc['relationships'])} relationships, {len(data)} bytes", file=sys.stderr)
    if len(data) > LIMIT:
        print(f"sbom-packages: {argv[2]} is {len(data)} bytes, over the {LIMIT}-byte attestation limit", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
