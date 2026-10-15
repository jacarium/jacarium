#!/usr/bin/env python3
"""backend/requirements.lock is the one set of Python package versions the
desktop venv, the PyInstaller build and the container install
(``pip install -r requirements.txt -c requirements.lock``). This checks it
is coherent with its inputs and with the interpreter running the test:

 1. every ``name==version`` in requirements.txt appears in the lock with
    the same version (a bumped direct pin without re-running
    backend/lock-requirements.sh would otherwise fail every install);
 2. the lock pins exact versions only, one unconditional pin per package
    (a package listed twice without markers could never be installed);
 3. every lock entry whose marker applies to this interpreter is installed
    at exactly that version. tests/run-all.sh runs this with
    backend/venv/bin/python, so this is the drift check for the venv; in the
    container it checks the image. SKIPs when the interpreter has none of
    the backend's packages (plain python3 fallback, no venv).

Run: backend/venv/bin/python tests/requirements_lock_consistency.test.py
"""
import os
import re
import sys
from importlib import metadata

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REQUIREMENTS = os.path.join(REPO, "backend", "requirements.txt")
LOCK = os.path.join(REPO, "backend", "requirements.lock")

PIN_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==([^\s;]+)\s*(?:;\s*(.*))?$")


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def entries(path):
    """(name, version, marker) for every pin in a requirements-style file."""
    out = []
    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.split("#", 1)[0].strip()
            if not line or line.startswith("-"):
                continue
            match = PIN_RE.match(line)
            if not match:
                raise AssertionError(f"{os.path.relpath(path, REPO)}:{lineno}: not an exact pin: {line!r}")
            out.append((canonical(match.group(1)), match.group(3), (match.group(4) or "").strip()))
    return out


def marker_applies(marker):
    if not marker:
        return True
    try:
        from packaging.markers import Marker
    except ImportError:
        return None  # cannot tell; skip conditional entries
    return Marker(marker).evaluate()


failures = []

direct = entries(REQUIREMENTS)
locked = entries(LOCK)
lock_versions = {}
for name, version, marker in locked:
    lock_versions.setdefault(name, []).append((version, marker))

# 1. direct pins are in the lock, same version
for name, version, _ in direct:
    versions = {v for v, _ in lock_versions.get(name, [])}
    if not versions:
        failures.append(f"{name}=={version} is in requirements.txt but missing from requirements.lock")
    elif versions != {version}:
        failures.append(f"{name}: requirements.txt pins {version}, requirements.lock has {sorted(versions)}")

# 2. one unconditional pin per package
for name, pins in lock_versions.items():
    unconditional = [v for v, m in pins if not m]
    if len(unconditional) > 1:
        failures.append(f"{name} is pinned more than once without a marker: {unconditional}")

# 3. the running interpreter matches the lock
installed = {canonical(d.metadata["Name"]): d.version for d in metadata.distributions() if d.metadata["Name"]}
present = sum(1 for name, _, _ in direct if name in installed)
if present < len(direct) // 2:
    print(f"SKIP: this interpreter ({sys.executable}) has {present}/{len(direct)} of the backend's "
          f"direct dependencies - not the backend venv, drift check skipped")
    drift_checked = False
else:
    drift_checked = True
    for name, version, marker in locked:
        applies = marker_applies(marker)
        if applies is False or applies is None:
            continue
        have = installed.get(name)
        if have is None:
            failures.append(f"{name}=={version} is in the lock but not installed")
        elif have != version:
            failures.append(f"{name}: lock pins {version}, installed {have}")

if failures:
    print("FAIL: requirements.lock is out of step:")
    for f in failures:
        print("  -", f)
    sys.exit(1)

print(f"PASS: {len(direct)} direct pins present in the {len(locked)}-entry lock"
      + (f"; {sys.executable} matches the lock" if drift_checked else ""))
