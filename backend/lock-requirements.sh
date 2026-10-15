#!/bin/bash
# Resolve backend/requirements.txt (the direct dependencies) into
# backend/requirements.lock: every package the backend ends up with, pinned
# to one version, for Python 3.14 (the desktop venv and the container run
# the same minor version) on Linux, macOS and Windows. The desktop venv
# (start-backend.sh, build_backend.sh, rebuild.sh), the PyInstaller build and the
# container (deploy/Containerfile) all install with
#
#   pip install -r requirements.txt -c requirements.lock
#
# so they get the same versions; pip refuses to install when the lock no
# longer satisfies requirements.txt (regenerate it here).
#
# Usage, from anywhere:
#   backend/lock-requirements.sh                       after editing requirements.txt:
#                                                      keeps every version already in the
#                                                      lock that still fits, moves the rest
#   backend/lock-requirements.sh --upgrade-package X   let X (and what it needs) move
#                                                      (repeatable)
#   backend/lock-requirements.sh --upgrade             re-resolve everything to the newest
#                                                      allowed versions
#
# Supply-chain cooldown: like .npmrc's min-release-age=7 and the pip
# --uploaded-prior-to=P7D in the build scripts, only releases uploaded to
# PyPI at least 7 days ago are considered.
#
# Needs python3 and network access. Uses `uv` from PATH when present,
# otherwise installs it into a temporary venv for the duration of the run
# (nothing is left behind). The resolution runs in a temporary project
# (pyproject.toml generated from requirements.txt, with the previous lock as
# constraints) because `uv pip compile` cannot bound the Python version from
# above and would also resolve for versions nothing here runs. Afterwards run
# tests/requirements_lock_consistency.test.py and install the result:
#   backend/venv/bin/pip install -r backend/requirements.txt -c backend/requirements.lock
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

UPGRADE_ALL=0
UPGRADE_PACKAGES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --upgrade|-U) UPGRADE_ALL=1 ;;
        --upgrade-package|-P)
            [ $# -ge 2 ] || { echo "error: $1 needs a package name" >&2; exit 2; }
            UPGRADE_PACKAGES+=("$2"); shift ;;
        --upgrade-package=*) UPGRADE_PACKAGES+=("${1#*=}") ;;
        -h|--help) sed -n '2,34p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "error: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

CUTOFF="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z"))')"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v uv >/dev/null 2>&1; then
    UV="uv"
else
    python3 -m venv "$TMP/venv"
    if "$TMP/venv/bin/python" -m pip install --uploaded-prior-to=P7D --help >/dev/null 2>&1; then
        "$TMP/venv/bin/python" -m pip install -q --disable-pip-version-check --uploaded-prior-to=P7D uv
    else
        echo "Bootstrapped pip predates 26.1 - installing uv without the release cooldown"
        "$TMP/venv/bin/python" -m pip install -q --disable-pip-version-check uv
    fi
    UV="$TMP/venv/bin/uv"
fi

# The throwaway project: requirements.txt as dependencies, the previous lock
# (minus whatever may move) as constraints.
PREVIOUS_LOCK=""
if [ "$UPGRADE_ALL" = "0" ] && [ -f requirements.lock ]; then
    PREVIOUS_LOCK="$PWD/requirements.lock"
fi
python3 - "$TMP/project/pyproject.toml" "$PREVIOUS_LOCK" "${UPGRADE_PACKAGES[@]+"${UPGRADE_PACKAGES[@]}"}" <<'EOF'
import os, re, sys

out, previous, *moving = sys.argv[1:]
moving = {m.lower().replace("_", "-") for m in moving}

def entries(path):
    for line in open(path, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith("-"):
            yield line

def name_of(line):
    return re.split(r"[=<>!~;\[ ]", line, maxsplit=1)[0].lower().replace("_", "-")

deps = list(entries("requirements.txt"))
# requirements.txt always wins for the packages it names; the previous lock
# only holds the indirect ones in place.
moving |= {name_of(d) for d in deps}
constraints = []
if previous:
    for line in entries(previous):
        if name_of(line) not in moving:
            constraints.append(line)

def toml_list(items):
    return "[\n" + "".join(f'    "{i}",\n' for i in items) + "]"

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    f.write('[project]\nname = "jacarium-backend"\nversion = "0"\n')
    f.write('requires-python = ">=3.14,<3.15"\n')
    f.write(f"dependencies = {toml_list(deps)}\n\n")
    f.write("[tool.uv]\npackage = false\n")
    f.write(f"constraint-dependencies = {toml_list(constraints)}\n")
print(f"{len(deps)} direct dependencies, {len(constraints)} versions kept from the previous lock")
EOF

# --python: any installed 3.14 (uv downloads one only when there is none);
# the unversioned python3 may be another version than the lock's.
echo "Resolving requirements.txt -> requirements.lock (releases up to $CUTOFF)"
"$UV" lock --quiet --project "$TMP/project" --python ">=3.14,<3.15" --exclude-newer "$CUTOFF" \
    || { echo "error: no resolution - a kept version blocks the change; retry with --upgrade-package <name> or --upgrade" >&2; exit 1; }
"$UV" export --quiet --project "$TMP/project" --frozen --format requirements.txt \
    --no-hashes --no-emit-project --no-header --no-annotate -o "$TMP/export.txt"

{
    echo "# Generated by backend/lock-requirements.sh - do not edit by hand."
    echo "# Every package backend/requirements.txt resolves to, pinned for Python 3.14;"
    echo "# releases up to $CUTOFF (7-day cooldown). Install with"
    echo "#   pip install -r requirements.txt -c requirements.lock"
    grep -v '^\s*$' "$TMP/export.txt"
} > requirements.lock

echo "Wrote $(grep -c '==' requirements.lock) pins to backend/requirements.lock"
