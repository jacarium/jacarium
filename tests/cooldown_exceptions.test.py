"""Guards for two release-pipeline failures of v3.3.8.

1. backend/cooldown-exceptions.txt: every approved cooldown exception is pinned at the same version in
   backend/requirements.lock, and rebuild.sh installs the list before its cooldown install (pip's
   --uploaded-prior-to=P7D refuses the younger versions otherwise: ResolutionImpossible).
2. .github/scripts/fetch-tool.sh prints only the installed path on stdout (callers capture it with
   $(...)); every progress message goes to stderr.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
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


exceptions = pins(read("backend/cooldown-exceptions.txt"))
lock = pins(read("backend/requirements.lock"))
check("the cooldown exceptions list is parseable", isinstance(exceptions, dict))
for name, ver in exceptions.items():
    check(f"exception {name}=={ver} is pinned at the same version in requirements.lock", lock.get(name) == ver, f"lock has {lock.get(name)}")

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
