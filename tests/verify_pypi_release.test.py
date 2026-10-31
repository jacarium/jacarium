"""scripts/verify-pypi-release.py against a fake index served locally (no network, nothing installed).

The fixtures are built here: two releases of a package (an sdist and a pure wheel each), their JSON records,
PEP 740 provenance documents and a "git tag" archive. The script is run as a subprocess with --pypi-url pointing
at the local server and --now fixed, and the test checks:
  - a clean fix (3 days old, same Trusted Publisher, one module changed) passes with "no red flag" and the
    report names the age, the publisher, the digests and the changed files; --diff prints the unified diff;
  - the red flags, each stopping the run (exit 1): younger than 2 days, provenance lost, a different Trusted
    Publisher, a changed metadata maintainer, a new dependency, new subprocess / network / eval use in a changed
    module (a test file is not counted), setup.py added, a digest that differs from the index;
  - --compare-tag: identical to the tag passes, a differing module is a red flag;
  - --help exits 0; an unknown version exits 2; nothing is left outside the temporary directory.
Run: backend/venv/bin/python tests/verify_pypi_release.test.py
"""
import base64
import hashlib
import http.server
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT = os.path.join(REPO, "scripts", "verify-pypi-release.py")
NOW = "2026-10-31T12:00:00Z"
results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + ": " + label + ("" if ok else f" | {str(detail)[:600]}"))


# ----------------------------------------------------------------- fixtures
OLD_CORE = "import re\n\ndef parse(s):\n    return re.sub(r'\\s+', ' ', s)\n"
NEW_CORE = "import re\n\ndef parse(s):\n    if len(s) > 1_000_000:\n        raise ValueError('too long')\n    return re.sub(r'\\s+', ' ', s)\n"
PYPROJECT = '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "pkg"\n'


def sdist(version, core, extra=None, pyproject=PYPROJECT):
    files = {"pyproject.toml": pyproject, "PKG-INFO": f"Name: pkg\nVersion: {version}\n", "pkg/__init__.py": f"__version__ = '{version}'\n",
             "pkg/core.py": core, "tests/test_core.py": "import subprocess\n"}
    files.update(extra or {})
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for rel, body in files.items():
            data = body.encode()
            info = tarfile.TarInfo(f"pkg-{version}/{rel}")
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def wheel(version, core, extra=None):
    files = {"pkg/__init__.py": f"__version__ = '{version}'\n", "pkg/core.py": core,
             f"pkg-{version}.dist-info/METADATA": f"Name: pkg\nVersion: {version}\n", f"pkg-{version}.dist-info/WHEEL": "Wheel-Version: 1.0\n",
             f"pkg-{version}.dist-info/top_level.txt": "pkg\n", f"pkg-{version}.dist-info/RECORD": ""}
    files.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for rel, body in files.items():
            z.writestr(rel, body)
    return buf.getvalue()


def tag_archive(core):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for rel, body in {"pkg-1.0.1/pkg/__init__.py": "__version__ = '1.0.1'\n", "pkg-1.0.1/pkg/core.py": core, "pkg-1.0.1/README.md": "# pkg\n"}.items():
            data = body.encode()
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def provenance_doc(repository="example/pkg", workflow="release.yml"):
    return {"version": 1, "attestation_bundles": [{"publisher": {"kind": "GitHub", "repository": repository, "workflow": workflow, "environment": "release"},
                                                    "attestations": [{"version": 1, "verification_material": {}, "envelope": {"statement": base64.b64encode(b"{}").decode(), "signature": ""}}]}]}


class Index:
    """A fake PyPI: /pypi/<name>/<ver>/json, /integrity/<name>/<ver>/<file>/provenance, the files, a tag archive."""

    def __init__(self):
        self.routes = {}

    def add_release(self, name, version, uploaded, sdist_bytes, wheel_bytes, requires_dist=None, maintainer="Pkg Maintainers", provenance=None, bad_digest=False, yanked=False):
        urls = []
        for filename, data, ptype in ((f"{name}-{version}.tar.gz", sdist_bytes, "sdist"), (f"{name}-{version}-py3-none-any.whl", wheel_bytes, "bdist_wheel")):
            path = f"/files/{filename}"
            self.routes[path] = ("application/octet-stream", data)
            digest = hashlib.sha256(data).hexdigest()
            if bad_digest:
                digest = "0" * 64
            urls.append({"filename": filename, "url": "{base}" + path, "packagetype": ptype, "upload_time_iso_8601": uploaded, "digests": {"sha256": digest}, "yanked": yanked})
            if provenance is not None:
                self.routes[f"/integrity/{name}/{version}/{filename}/provenance"] = ("application/vnd.pypi.integrity.v1+json", json.dumps(provenance).encode())
        info = {"name": name, "version": version, "author": "Someone", "author_email": "someone@example.test", "maintainer": maintainer, "maintainer_email": "maint@example.test",
                "requires_dist": requires_dist, "requires_python": ">=3.9"}
        self.routes[f"/pypi/{name}/{version}/json"] = ("application/json", json.dumps({"info": info, "urls": urls}).encode())

    def add_page(self, name, maintainers):
        html = "".join(f'<a class="sidebar-section__maintainer"\n     href="/user/{m}/"\n     aria-label="{m}"><span>{m}</span></a>' for m in maintainers)
        self.routes[f"/project/{name}/"] = ("text/html", html.encode())

    def serve(self):
        routes = self.routes
        base_holder = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path in routes:
                    ctype, body = routes[self.path]
                    if ctype == "application/json":
                        body = body.replace(b"{base}", base_holder["base"].encode())
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
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
        base_holder["base"] = f"http://127.0.0.1:{srv.server_address[1]}"
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv, base_holder["base"]


def run(base, *args):
    r = subprocess.run([sys.executable, "-I", SCRIPT, "pkg", "1.0.0", "1.0.1", "--pypi-url", base, "--now", NOW, *args], capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def scenario(**new):
    """An index with the old release (40 days, provenance) and a new one built from the keyword overrides."""
    idx = Index()
    idx.add_release("pkg", "1.0.0", "2026-09-21T12:00:00Z", sdist("1.0.0", OLD_CORE), wheel("1.0.0", OLD_CORE), provenance=provenance_doc())
    opts = {"uploaded": "2026-10-28T12:00:00Z", "sdist_bytes": sdist("1.0.1", NEW_CORE), "wheel_bytes": wheel("1.0.1", NEW_CORE), "provenance": provenance_doc()}
    opts.update(new)
    idx.add_release("pkg", "1.0.1", **opts)
    idx.add_page("pkg", ["alice", "bob"])
    return idx


# ----------------------------------------------------------------- the clean fix
idx = scenario()
srv, base = idx.serve()
code, out = run(base)
check("a clean fix passes: exit 0, no red flag", code == 0 and "no red flag" in out, out)
check("the report names the age and that it is within the lane", "3.0 days old, younger than the 7-day cooldown: within the security lane" in out, out)
check("the report names both versions' Trusted Publisher", out.count("GitHub example/pkg release.yml environment release (1 attestation(s))") == 4, out)
check("the report checks the four digests against the index", out.count("= index") == 4, out)
check("the report lists the changed files of the sdist and the wheel", "sdist: 5 -> 5 files, 3 changed, 0 added, 0 removed" in out and "~ pkg/core.py" in out and "wheel: 6 -> 6 files, 3 changed" in out, out)
check("without --diff no unified diff is printed", "--- diff" not in out)
code, out = run(base, "--diff")
check("--diff prints the unified diff of the changed module", "--- diff sdist pkg/core.py" in out and "+    if len(s) > 1_000_000:" in out, out)
check("--help exits 0 with the usage", subprocess.run([sys.executable, "-I", SCRIPT, "--help"], capture_output=True, text=True).returncode == 0)
r = subprocess.run([sys.executable, "-I", SCRIPT, "pkg", "1.0.0", "9.9.9", "--pypi-url", base], capture_output=True, text=True)
check("an unknown version exits 2 with an error", r.returncode == 2 and "is not on the index" in r.stdout, r.stdout + r.stderr)
before = set(os.listdir(tempfile.gettempdir()))
run(base)
leftovers = [d for d in set(os.listdir(tempfile.gettempdir())) - before if d.startswith("verify-pypi-")]
check("the temporary directory is removed afterwards (nothing kept unless --keep)", not leftovers, leftovers)
with tempfile.TemporaryDirectory() as keep:
    run(base, "--keep", keep)
    check("--keep leaves the downloaded files in the given directory", os.path.exists(os.path.join(keep, "pkg-1.0.1.tar.gz")) and os.path.exists(os.path.join(keep, "pkg-1.0.0-py3-none-any.whl")), os.listdir(keep))
srv.shutdown()

# ----------------------------------------------------------------- the red flags
cases = [
    ("younger than 2 days", dict(uploaded="2026-10-30T00:00:00Z"), "1.5 days old, younger than the lane's 2 days"),
    ("exactly 2 days old is within the lane (no age flag)", dict(uploaded="2026-10-29T12:00:00Z"), None),
    ("provenance lost where the old version had it", dict(provenance=None), "no PEP 740 provenance where 1.0.0 had it"),
    ("a different Trusted Publisher", dict(provenance=provenance_doc(repository="someone/fork")), "the Trusted Publisher changed"),
    ("a changed metadata maintainer", dict(maintainer="Somebody Else"), "the release metadata's maintainer changed"),
    ("a new dependency", dict(requires_dist=["left-pad>=1"]), "dependency added or changed: left-pad>=1"),
    ("new subprocess use in a changed module", dict(sdist_bytes=sdist("1.0.1", NEW_CORE + "import subprocess\n"), wheel_bytes=wheel("1.0.1", NEW_CORE + "import subprocess\n")), "RED FLAG: sdist: new pkg/core.py: subprocess usage 0 -> 1"),
    ("new network use in an added module", dict(sdist_bytes=sdist("1.0.1", NEW_CORE, {"pkg/net.py": "import urllib.request\n"}), wheel_bytes=wheel("1.0.1", NEW_CORE, {"pkg/net.py": "import urllib.request\n"})), "RED FLAG: wheel: new pkg/net.py: network usage 0 -> 1"),
    ("new eval use", dict(sdist_bytes=sdist("1.0.1", NEW_CORE + "x = eval('1')\n")), "RED FLAG: sdist: new pkg/core.py: eval usage 0 -> 1"),
    ("setup.py added", dict(sdist_bytes=sdist("1.0.1", NEW_CORE, {"setup.py": "from setuptools import setup\nsetup()\n"})), "RED FLAG: setup.py added"),
    ("a changed build backend", dict(sdist_bytes=sdist("1.0.1", NEW_CORE, pyproject=PYPROJECT.replace("setuptools.build_meta", "hatchling.build"))), "RED FLAG: the build backend changed: setuptools.build_meta -> hatchling.build"),
    ("a digest that differs from the index", dict(bad_digest=True), "RED FLAG: pkg-1.0.1.tar.gz: sha256 "),
    ("a yanked release", dict(yanked=True), "RED FLAG: the release is yanked"),
]
for label, overrides, expected in cases:
    idx = scenario(**overrides)
    srv, base = idx.serve()
    code, out = run(base)
    srv.shutdown()
    if expected is None:
        check(label, code == 0 and "RED FLAG" not in out, out)
    else:
        check(f"{label} is a red flag (exit 1)", code == 1 and expected in out and ("differs from the index" in out if "sha256" in expected else True), out)
# a test file's subprocess import is not counted
idx = scenario(sdist_bytes=sdist("1.0.1", NEW_CORE, {"tests/test_more.py": "import subprocess, socket\n"}))
srv, base = idx.serve()
code, out = run(base)
srv.shutdown()
check("subprocess / socket use in an added test file is not a red flag", code == 0 and "RED FLAG" not in out, out)

# ----------------------------------------------------------------- the project page, when there is no provenance
idx = Index()
idx.add_release("pkg", "1.0.0", "2026-09-21T12:00:00Z", sdist("1.0.0", OLD_CORE), wheel("1.0.0", OLD_CORE))
idx.add_release("pkg", "1.0.1", "2026-10-28T12:00:00Z", sdist("1.0.1", NEW_CORE), wheel("1.0.1", NEW_CORE))
idx.add_page("pkg", ["alice", "bob"])
srv, base = idx.serve()
code, out = run(base)
check("without provenance on either side the run passes and the project page's maintainers are reported", code == 0 and "provenance pkg-1.0.1.tar.gz: none" in out and "project page maintainers: alice, bob" in out, out)
# --compare-tag
idx.routes["/tag.tar.gz"] = ("application/octet-stream", tag_archive(NEW_CORE))
idx.routes["/tag-other.tar.gz"] = ("application/octet-stream", tag_archive(NEW_CORE + "# not what was published\n"))
code, out = run(base, "--compare-tag", f"{base}/tag.tar.gz")
check("--compare-tag: the sdist's and the wheel's import package identical to the tag", code == 0 and "sdist: pkg/ (2 modules) identical to the tag" in out and "wheel: pkg/ (2 modules) identical to the tag" in out, out)
code, out = run(base, "--compare-tag", f"{base}/tag-other.tar.gz")
check("--compare-tag: a module that differs from the tag is a red flag", code == 1 and "RED FLAG: sdist: pkg/ differs from the tag (0 added, 0 missing, 1 changed: pkg/core.py)" in out, out)
code, out = run(base, "--compare-tag", "not-a-spec")
check("--compare-tag refuses a malformed spec", code == 2 and "OWNER/REPO@TAG" in out, out)
srv.shutdown()

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
