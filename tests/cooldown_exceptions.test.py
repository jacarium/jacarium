"""Guards for the Python side of the dependency policy and two release-pipeline failures of v3.3.8.

1. backend/cooldown-exceptions.txt: every approved cooldown exception is pinned at the same version in
   backend/requirements.lock, and rebuild.sh installs the list before its cooldown install (pip's
   --uploaded-prior-to=P7D refuses the younger versions otherwise: ResolutionImpossible).
2. The security lane (SECURITY.md, "Dependency policy"): every exception line carries a comment that names
   the advisory it fixes (a CVE, GHSA, PYSEC, RHSA or GO id) or says "maintainer decision", plus the upload
   date and the date it was added; an advisory-backed line was at least 2 days old when it was added, and a
   younger one is only allowed as a maintainer decision. backend/lock-requirements.sh runs
   scripts/verify-pypi-release.py for a new --past-cooldown version and keeps the approved list exempt.
3. .github/scripts/fetch-tool.sh prints only the installed path on stdout (callers capture it with
   $(...)); every progress message goes to stderr.
"""
import datetime as dt
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ADVISORY = re.compile(r"\b(CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|PYSEC-\d{4}-\d+|RHSA-\d{4}:\d+|GO-\d{4}-\d+)\b", re.I)
LANE_MIN_AGE_DAYS = 2
results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + ": " + label + ("" if ok else f" | {detail}"))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def pins(text):
    out = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].split(";", 1)[0].strip()
        m = re.match(r"^([A-Za-z0-9_.\-]+)==([^\s]+)$", line)
        if m:
            out[m.group(1).lower().replace("_", "-")] = m.group(2)
    return out


def exception_lines(text):
    """(pin, comment) for every non-comment line of the exceptions list."""
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        pin, _, comment = line.partition("#")
        out.append((pin.strip(), comment.strip()))
    return out


exceptions = pins(read("backend/cooldown-exceptions.txt"))
lock = pins(read("backend/requirements.lock"))
check("the cooldown exceptions list is parseable", isinstance(exceptions, dict))
for name, ver in exceptions.items():
    check(f"exception {name}=={ver} is pinned at the same version in requirements.lock", lock.get(name) == ver, f"lock has {lock.get(name)}")

# 2. the lane: the comment, the dates, the two days
for pin, comment in exception_lines(read("backend/cooldown-exceptions.txt")):
    advisory = ADVISORY.search(comment)
    decision = "maintainer decision" in comment
    check(f"{pin}: the comment names an advisory or a maintainer decision", bool(advisory) or decision, comment or "(no comment)")
    dates = re.search(r"uploaded (\d{4}-\d{2}-\d{2}), added (\d{4}-\d{2}-\d{2})", comment)
    check(f"{pin}: the comment carries 'uploaded YYYY-MM-DD, added YYYY-MM-DD'", bool(dates), comment)
    if dates:
        uploaded, added = (dt.date.fromisoformat(d) for d in dates.groups())
        age = (added - uploaded).days
        check(f"{pin}: added {age} days after the upload - at least {LANE_MIN_AGE_DAYS} under the lane, or a maintainer decision",
              age >= LANE_MIN_AGE_DAYS or decision, f"{uploaded} -> {added}")
        check(f"{pin}: the dates are in order", age >= 0, f"{uploaded} -> {added}")

lockscript = read("backend/lock-requirements.sh")
check("lock-requirements.sh runs scripts/verify-pypi-release.py for a --past-cooldown version and stops on a red flag unless --force",
      "verify-pypi-release.py" in lockscript and "--force" in lockscript and "raised a red flag" in lockscript)
check("lock-requirements.sh keeps the approved exceptions exempt from the cutoff on every run", "cooldown-exceptions.txt" in lockscript and 'PAST_COOLDOWN+=("$line")' in lockscript)

rebuild = read("rebuild.sh")
i_exc = rebuild.find("-r cooldown-exceptions.txt")
i_main = rebuild.find('"$cooldown" -r requirements.txt -c requirements.lock')
check("rebuild.sh installs the exceptions (no dependencies, no cooldown) before the cooldown install", 0 <= i_exc < i_main and "--no-deps -r cooldown-exceptions.txt" in rebuild, f"{i_exc} {i_main}")

fetch = read(".github/scripts/fetch-tool.sh")
echoes = [line.strip() for line in fetch.splitlines() if re.search(r'\becho\s+"fetch-tool:', line)]
check("fetch-tool.sh has progress messages", len(echoes) >= 5, str(len(echoes)))
bad = [line for line in echoes if ">&2" not in line]
check("every fetch-tool.sh message goes to stderr (stdout is only the path)", not bad, " | ".join(bad))

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
