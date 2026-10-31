"""scripts/verify-rpm-update.sh against a fake Red Hat security data API served locally and a `podman` shim on
PATH (no network, no container; the shim records the engine command and prints a canned `rpm -q` line).

Checks: a CVE whose erratum for the product is 4 days old, whose fixed list carries the requested
version-release, and whose RPM the "upgrade" leaves installed at that version with Red Hat's release key
passes; the report names the erratum, its date, age, severity, the fixed architectures and the signature;
the engine is called with the base image from deploy/Containerfile (or --image) and microdnf upgrade of the
package names; the red flags: an erratum younger than 2 days, a package missing from the erratum's fixed list,
no erratum for the product, the repositories carrying an older build, a signature by another key (and none),
another vendor; --no-container skips the engine; --help exits 0; a bad argument exits 2.
Run: backend/venv/bin/python tests/verify_rpm_update.test.py
"""
import http.server
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT = os.path.join(REPO, "scripts", "verify-rpm-update.sh")
NOW = "2026-10-31T12:00:00Z"
results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + ": " + label + ("" if ok else f" | {str(detail)[:700]}"))


def cve_doc(advisory="RHSA-2026:12345", release="2026-10-27T00:00:00Z", package="curl-0:7.76.1-40.el9_8.9"):
    return {"threat_severity": "Moderate", "public_date": "2026-07-03T06:16:30Z",
            "affected_release": [{"product_name": "Red Hat Enterprise Linux 8", "release_date": "2026-10-29T00:00:00Z", "advisory": "RHSA-2026:99999", "package": "curl-0:7.61.1-34.el8_10.18"},
                                 {"product_name": "Red Hat Enterprise Linux 9", "release_date": release, "advisory": advisory, "package": package}]}


def csaf_doc(first="2026-10-27T01:23:52+00:00", fixed=("curl-minimal-0:7.76.1-40.el9_8.9.aarch64", "curl-minimal-0:7.76.1-40.el9_8.9.x86_64", "libcurl-minimal-0:7.76.1-40.el9_8.9.aarch64")):
    return {"document": {"title": "Red Hat Security Advisory: curl security update", "tracking": {"id": "RHSA-2026:12345", "initial_release_date": first, "current_release_date": first},
                         "aggregate_severity": {"text": "Moderate"}},
            "vulnerabilities": [{"cve": "CVE-2026-8932", "product_status": {"fixed": [f"BaseOS-9.8.0.Z.MAIN.EUS:{p}" for p in fixed]}}]}


routes = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in routes:
            body = json.dumps(routes[self.path]).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
API = f"http://127.0.0.1:{srv.server_address[1]}"

SHIM_DIR = tempfile.mkdtemp(prefix="verify-rpm-shim-")
LOG = os.path.join(SHIM_DIR, "calls.log")
RPM_OUT = os.path.join(SHIM_DIR, "rpm.out")
with open(os.path.join(SHIM_DIR, "podman"), "w") as fh:
    fh.write('#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$VERIFY_RPM_LOG"\ncat "$VERIFY_RPM_OUT"\n')
os.chmod(os.path.join(SHIM_DIR, "podman"), stat.S_IRWXU)
GOOD = ("curl-minimal-7.76.1-40.el9_8.9.aarch64|RSA/SHA256, Fri Sep 25 21:24:58 2026, Key ID 199e2f91fd431d51|Red Hat, Inc.|Thu Sep 24 11:50:41 2026|curl-7.76.1-40.el9_8.9.src.rpm\n"
        "libcurl-minimal-7.76.1-40.el9_8.9.aarch64|RSA/SHA256, Fri Sep 25 21:24:58 2026, Key ID 199e2f91fd431d51|Red Hat, Inc.|Thu Sep 24 11:50:41 2026|curl-7.76.1-40.el9_8.9.src.rpm\n")


def run(*args, rpm_out=GOOD, cve=None, csaf=None):
    routes.clear()
    routes["/cve/CVE-2026-8932.json"] = cve if cve is not None else cve_doc()
    routes["/csaf/RHSA-2026:12345.json"] = csaf if csaf is not None else csaf_doc()
    with open(RPM_OUT, "w") as fh:
        fh.write(rpm_out)
    if os.path.exists(LOG):
        os.remove(LOG)
    env = dict(os.environ, PATH=SHIM_DIR + os.pathsep + os.environ.get("PATH", ""), VERIFY_RPM_LOG=LOG, VERIFY_RPM_OUT=RPM_OUT)
    r = subprocess.run(["bash", SCRIPT, *args, "--api-url", API, "--now", NOW], capture_output=True, text=True, timeout=60, env=env, cwd=REPO)
    calls = open(LOG).read() if os.path.exists(LOG) else ""
    return r.returncode, r.stdout + r.stderr, calls


PKGS = ["curl-minimal-7.76.1-40.el9_8.9", "libcurl-minimal-7.76.1-40.el9_8.9"]
code, out, calls = run("--cve", "CVE-2026-8932", *PKGS)
check("a fixed, signed package from a 4-day-old erratum passes with no red flag", code == 0 and "no red flag" in out, out)
check("the report names the erratum, its release date, age, severity and CVE", "Red Hat Enterprise Linux 9: RHSA-2026:12345 2026-10-27T00:00:00Z curl-0:7.76.1-40.el9_8.9" in out
      and "released 2026-10-27T01:23:52+00:00 severity Moderate cves CVE-2026-8932" in out and "age 4.4 days" in out, out)
check("the report lists the fixed architectures per package", "fixed: curl-minimal-7.76.1-40.el9_8.9: aarch64, x86_64" in out and "fixed: libcurl-minimal-7.76.1-40.el9_8.9: aarch64" in out, out)
check("the report shows the installed package, its signature, vendor, build time and source RPM",
      "curl-minimal-7.76.1-40.el9_8.9.aarch64: signature RSA/SHA256, Fri Sep 25 21:24:58 2026, Key ID 199e2f91fd431d51" in out and "vendor Red Hat, Inc., built Thu Sep 24 11:50:41 2026, source curl-7.76.1-40.el9_8.9.src.rpm" in out, out)
base_image = [l.split()[1] for l in open(os.path.join(REPO, "deploy", "Containerfile")) if l.startswith("FROM ")][-1]
check("the engine runs a throwaway container from the Containerfile's runtime base image with microdnf upgrade of the package names and rpm -q",
      calls.startswith(f"run --rm {base_image} sh -c microdnf -y --setopt=install_weak_deps=0 --nodocs upgrade curl-minimal libcurl-minimal") and "rpm -q --qf" in calls and "RSAHEADER" in calls, calls)
code, out, calls = run("--cve", "CVE-2026-8932", "--image", "example.test/base:1", *PKGS)
check("--image picks another base image", code == 0 and calls.startswith("run --rm example.test/base:1 "), calls)
code, out, calls = run("--advisory", "RHSA-2026:12345", *PKGS)
check("--advisory skips the CVE lookup and reads the erratum directly", code == 0 and "== RHSA-2026:12345:" in out and "== CVE" not in out, out)
code, out, calls = run("--cve", "CVE-2026-8932", "--no-container", *PKGS)
check("--no-container does the advisory checks only (no engine call)", code == 0 and calls == "" and "microdnf" not in out, out + calls)

# the red flags
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, csaf=csaf_doc(first="2026-10-30T01:23:52+00:00"))
check("an erratum younger than 2 days is a red flag", code == 1 and "RED FLAG: RHSA-2026:12345 is 1.4 days old, younger than the lane's 2 days" in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, csaf=csaf_doc(fixed=("curl-minimal-0:7.76.1-40.el9_8.9.aarch64",)))
check("a package missing from the erratum's fixed list is a red flag", code == 1 and "RED FLAG: libcurl-minimal-7.76.1-40.el9_8.9 is not among the erratum's fixed packages" in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, cve=cve_doc(package="curl-0:7.76.1-40.el9_8.8"))
check("no erratum for the product carrying the version-release is a red flag", code == 1 and "RED FLAG: CVE-2026-8932: no erratum for Red Hat Enterprise Linux 9 carries 7.76.1-40.el9_8.9 yet" in out, out)
older = GOOD.replace("curl-minimal-7.76.1-40.el9_8.9.aarch64", "curl-minimal-7.76.1-40.el9_8.8.aarch64", 1)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, rpm_out=older)
check("the repositories still carrying the older build is a red flag", code == 1 and "RED FLAG: curl-minimal: the repositories carry curl-minimal-7.76.1-40.el9_8.8.aarch64, not curl-minimal-7.76.1-40.el9_8.9" in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, rpm_out=GOOD.replace("Key ID 199e2f91fd431d51", "Key ID 0123456789abcdef", 1))
check("a signature by another key is a red flag", code == 1 and "RED FLAG: curl-minimal: signed with key 0123456789abcdef, not one of 199e2f91fd431d51" in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", "--key", "0123456789ABCDEF", *PKGS, rpm_out=GOOD.replace("Key ID 199e2f91fd431d51", "Key ID 0123456789abcdef", 1))
check("--key accepts another key id (case does not matter) next to the default", code == 0, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, rpm_out=GOOD.replace("RSA/SHA256, Fri Sep 25 21:24:58 2026, Key ID 199e2f91fd431d51", "(none)", 1))
check("an unsigned package is a red flag", code == 1 and "RED FLAG: curl-minimal: signed with key none" in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, rpm_out=GOOD.replace("Red Hat, Inc.", "Someone Else", 1))
check("another vendor is a red flag", code == 1 and "RED FLAG: curl-minimal: vendor is 'Someone Else', not Red Hat, Inc." in out, out)
code, out, _ = run("--cve", "CVE-2026-8932", *PKGS, rpm_out="")
check("rpm -q giving nothing is a red flag", code == 1 and "RED FLAG: curl-minimal: rpm -q gave nothing after the upgrade" in out, out)

r = subprocess.run(["bash", SCRIPT, "--help"], capture_output=True, text=True)
check("--help exits 0 with the usage", r.returncode == 0 and "scripts/verify-rpm-update.sh --cve CVE-2026-8932" in r.stdout, r.stdout)
code, out, _ = run("--cve", "CVE-2026-8932", "curl-minimal")
check("a package that is not NAME-VERSION-RELEASE exits 2", code == 2 and "is not NAME-VERSION-RELEASE" in out, out)
code, out, _ = run(*PKGS)
check("without --cve or --advisory it exits 2", code == 2, out)
srv.shutdown()

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
