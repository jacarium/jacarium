"""scripts/verify-go-module.sh against a fake checksum database and module proxy served locally (no network).

Checks: a version the database knows, 3 days old, passes and the report carries the record id, both hashes, the
time, the age and the origin; the module path is escaped the way the proxy wants (an upper-case letter becomes
"!" + the letter); --expect-sum / --expect-mod and --go-sum compare the hashes (a mismatch is a red flag, a
missing go.sum line too); a version the database does not know and one younger than 2 days are red flags;
--help exits 0; a version that is not a tag exits 2.
Run: backend/venv/bin/python tests/verify_go_module.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT = os.path.join(REPO, "scripts", "verify-go-module.sh")
NOW = "2026-10-31T12:00:00Z"
results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + ": " + label + ("" if ok else f" | {str(detail)[:600]}"))


SUM = "h1:18ELalfM5+XNRwzM2nYqXsZQ9ByS1uhj2O/U7+5jqRY="
MOD = "h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI="
routes = {
    "/lookup/example.com/!some!org/lib@v1.2.3": f"123456\nexample.com/SomeOrg/lib v1.2.3 {SUM}\nexample.com/SomeOrg/lib v1.2.3/go.mod {MOD}\n\ngo.sum database tree\n123457\nabc=\n",
    "/example.com/!some!org/lib/@v/v1.2.3.info": json.dumps({"Version": "v1.2.3", "Time": "2026-10-28T12:00:00Z", "Origin": {"VCS": "git", "URL": "https://example.com/SomeOrg/lib", "Ref": "refs/tags/v1.2.3", "Hash": "abc123"}}),
    "/lookup/example.com/!some!org/lib@v1.2.4": f"123460\nexample.com/SomeOrg/lib v1.2.4 {SUM}\nexample.com/SomeOrg/lib v1.2.4/go.mod {MOD}\n",
    "/example.com/!some!org/lib/@v/v1.2.4.info": json.dumps({"Version": "v1.2.4", "Time": "2026-10-30T06:00:00Z"}),
}
seen = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append(self.path)
        if self.path in routes:
            body = routes[self.path].encode()
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
BASE = f"http://127.0.0.1:{srv.server_address[1]}"


def run(*args):
    r = subprocess.run(["bash", SCRIPT, *args, "--sumdb-url", BASE, "--proxy-url", BASE, "--now", NOW], capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout + r.stderr


code, out = run("example.com/SomeOrg/lib", "v1.2.3")
check("a known version, 3 days old, passes with no red flag", code == 0 and "no red flag" in out, out)
check("the report carries the record id, both hashes, the time, the age and the origin",
      "checksum database record 123456" in out and f"example.com/SomeOrg/lib v1.2.3 {SUM}" in out and f"v1.2.3/go.mod {MOD}" in out
      and "time 2026-10-28T12:00:00Z age 3.0" in out and "origin git https://example.com/SomeOrg/lib ref refs/tags/v1.2.3 hash abc123" in out, out)
check("the module path is escaped for the proxy (upper-case letters as !letter)", "/lookup/example.com/!some!org/lib@v1.2.3" in seen and "/example.com/!some!org/lib/@v/v1.2.3.info" in seen, seen)

code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--expect-sum", SUM, "--expect-mod", MOD)
check("--expect-sum / --expect-mod equal to the database pass", code == 0, out)
code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--expect-sum", "h1:other=")
check("a module hash that differs from --expect-sum is a red flag", code == 1 and f"RED FLAG: module hash {SUM} differs from the expected h1:other=" in out, out)
code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--expect-mod", "h1:other=")
check("a go.mod hash that differs from --expect-mod is a red flag", code == 1 and "RED FLAG: go.mod hash" in out, out)

with tempfile.TemporaryDirectory() as d:
    gosum = os.path.join(d, "go.sum")
    with open(gosum, "w") as fh:
        fh.write(f"example.com/SomeOrg/lib v1.2.3 {SUM}\nexample.com/SomeOrg/lib v1.2.3/go.mod {MOD}\nother.example/x v0.1.0 h1:x=\n")
    code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--go-sum", gosum)
    check("--go-sum with matching lines passes and says so", code == 0 and "present and equal" in out, out)
    with open(gosum, "w") as fh:
        fh.write(f"example.com/SomeOrg/lib v1.2.3 h1:tampered=\nexample.com/SomeOrg/lib v1.2.3/go.mod {MOD}\n")
    code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--go-sum", gosum)
    check("a go.sum line that differs from the database is a red flag", code == 1 and "records module hash h1:tampered=, the database" in out, out)
    with open(gosum, "w") as fh:
        fh.write("other.example/x v0.1.0 h1:x=\n")
    code, out = run("example.com/SomeOrg/lib", "v1.2.3", "--go-sum", gosum)
    check("a go.sum without the module's line is a red flag", code == 1 and "has no line for example.com/SomeOrg/lib v1.2.3" in out, out)

code, out = run("example.com/SomeOrg/lib", "v1.2.4")
check("a version 1.25 days old is a red flag (the lane's 2 days)", code == 1 and "RED FLAG: 1.2 days old, younger than the lane's 2 days" in out, out)
code, out = run("example.com/SomeOrg/lib", "v9.9.9")
check("a version the checksum database does not know is a red flag, and so is a missing proxy record", code == 1 and "RED FLAG: not in the checksum database" in out and "RED FLAG: the module proxy has no record of v9.9.9" in out, out)

r = subprocess.run(["bash", SCRIPT, "--help"], capture_output=True, text=True)
check("--help exits 0 with the usage", r.returncode == 0 and "scripts/verify-go-module.sh golang.org/x/net" in r.stdout, r.stdout)
code, out = run("example.com/SomeOrg/lib", "latest")
check("a version that is not a tag exits 2", code == 2 and "must be a tagged version" in out, out)
code, out = run("example.com/SomeOrg/lib")
check("a missing version exits 2", code == 2, out)
srv.shutdown()

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
