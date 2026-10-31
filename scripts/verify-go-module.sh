#!/bin/bash
# The checks the security lane asks for before a Go module version is raised in deploy/Containerfile's Caddy
# build (XNET_VERSION, CHI_VERSION, GOJOSE_VERSION ...; SECURITY.md, "Dependency policy"): the Go counterpart of
# scripts/urgent-dep-update.cjs. Nothing is downloaded but two small records; the report is what goes into
# docs/security/urgent-updates.md.
#
#   scripts/verify-go-module.sh golang.org/x/net v0.62.0
#   scripts/verify-go-module.sh github.com/go-jose/go-jose/v4 v4.1.6 --expect-sum h1:...
#
# Options:
#   --expect-sum H1       the module hash the build is expected to record (a mismatch is a red flag)
#   --expect-mod H1       the same for the go.mod hash
#   --go-sum FILE         a go.sum to check the two lines against instead
#   --min-age-days N      the lane's floor (default 2)
#   --sumdb-url URL       the checksum database (default https://sum.golang.org; for the test)
#   --proxy-url URL       the module proxy (default https://proxy.golang.org; for the test)
#   --now ISO-8601        the clock (for the test)
#
# What it reports, and flags in red:
#   - the checksum database record (sum.golang.org/lookup): its id, the module hash and the go.mod hash - a
#     version the database does not know is a red flag (GOSUMDB would refuse it in the build anyway), and so is
#     a hash that differs from --expect-sum / --expect-mod / the go.sum line;
#   - the proxy's .info record: the version's time and its age (younger than --min-age-days is a red flag:
#     under that only on the maintainer's explicit decision, which this script does not take), and the origin
#     the proxy recorded (the VCS URL, tag and commit the version was fetched from - compare with the project's
#     own tag).
#
# Exit 0 with "no red flag", 1 when there is one (each printed as RED FLAG: ...), 2 on a usage or network
# error. Needs curl and python3 (standard library).
set -euo pipefail

SUMDB="https://sum.golang.org"
PROXY="https://proxy.golang.org"
MIN_AGE="2"
NOW=""
EXPECT_SUM=""
EXPECT_MOD=""
GO_SUM=""
MODULE=""
VERSION=""

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --expect-sum) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; EXPECT_SUM="$2"; shift ;;
        --expect-mod) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; EXPECT_MOD="$2"; shift ;;
        --go-sum) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; GO_SUM="$2"; shift ;;
        --min-age-days) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; MIN_AGE="$2"; shift ;;
        --sumdb-url) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; SUMDB="${2%/}"; shift ;;
        --proxy-url) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; PROXY="${2%/}"; shift ;;
        --now) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; NOW="$2"; shift ;;
        -*) echo "error: unknown option $1 (see --help)" >&2; exit 2 ;;
        *)
            if [ -z "$MODULE" ]; then MODULE="$1"
            elif [ -z "$VERSION" ]; then VERSION="$1"
            else echo "error: unexpected argument $1 (see --help)" >&2; exit 2
            fi ;;
    esac
    shift
done
[ -n "$MODULE" ] && [ -n "$VERSION" ] || { echo "error: MODULE and VERSION are required (see --help)" >&2; exit 2; }
case "$VERSION" in
    v[0-9]*) ;;
    *) echo "error: VERSION must be a tagged version like v1.2.3, got $VERSION" >&2; exit 2 ;;
esac

FLAGS=()
flag() { FLAGS+=("$1"); }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-go.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# the module proxy's escaping: an upper-case letter becomes "!" + the lower-case letter
escape() {
    local s="$1" out="" c i
    for ((i = 0; i < ${#s}; i++)); do
        c="${s:i:1}"
        case "$c" in
            [[:upper:]]) out+="!$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')" ;;
            *) out+="$c" ;;
        esac
    done
    printf '%s' "$out"
}
ESC_MODULE="$(escape "$MODULE")"
ESC_VERSION="$(escape "$VERSION")"

# ---------------------------------------------------------------- the checksum database
echo "== $MODULE $VERSION"
set +e
lookup="$(curl -fsSL --proto '=https,http' --retry 2 "$SUMDB/lookup/$ESC_MODULE@$ESC_VERSION" 2>"$WORK/lookup.err")"
status=$?
set -e
if [ "$status" != "0" ]; then
    flag "not in the checksum database ($SUMDB/lookup/$ESC_MODULE@$ESC_VERSION: $(tail -1 "$WORK/lookup.err" 2>/dev/null || echo "curl $status"))"
    sum_line=""; mod_line=""
else
    record="$(printf '%s\n' "$lookup" | sed -n '1p')"
    sum_line="$(printf '%s\n' "$lookup" | awk -v m="$MODULE" -v v="$VERSION" '$1 == m && $2 == v {print $3}' | head -1)"
    mod_line="$(printf '%s\n' "$lookup" | awk -v m="$MODULE" -v v="$VERSION/go.mod" '$1 == m && $2 == v {print $3}' | head -1)"
    echo "   checksum database record $record"
    echo "   $MODULE $VERSION ${sum_line:-?}"
    echo "   $MODULE $VERSION/go.mod ${mod_line:-?}"
    [ -n "$sum_line" ] || flag "the checksum database record carries no module hash for $VERSION"
    if [ -n "$EXPECT_SUM" ] && [ "$EXPECT_SUM" != "$sum_line" ]; then
        flag "module hash $sum_line differs from the expected $EXPECT_SUM"
    fi
    if [ -n "$EXPECT_MOD" ] && [ "$EXPECT_MOD" != "$mod_line" ]; then
        flag "go.mod hash $mod_line differs from the expected $EXPECT_MOD"
    fi
    if [ -n "$GO_SUM" ]; then
        [ -f "$GO_SUM" ] || { echo "error: $GO_SUM does not exist" >&2; exit 2; }
        have_sum="$(awk -v m="$MODULE" -v v="$VERSION" '$1 == m && $2 == v {print $3}' "$GO_SUM" | head -1)"
        have_mod="$(awk -v m="$MODULE" -v v="$VERSION/go.mod" '$1 == m && $2 == v {print $3}' "$GO_SUM" | head -1)"
        if [ -z "$have_sum" ] && [ -z "$have_mod" ]; then
            flag "$GO_SUM has no line for $MODULE $VERSION"
        else
            [ -z "$have_sum" ] || [ "$have_sum" = "$sum_line" ] || flag "$GO_SUM records module hash $have_sum, the database $sum_line"
            [ -z "$have_mod" ] || [ "$have_mod" = "$mod_line" ] || flag "$GO_SUM records go.mod hash $have_mod, the database $mod_line"
            echo "   $GO_SUM: $([ -n "$have_sum" ] && echo "module hash" ) $([ -n "$have_mod" ] && echo "go.mod hash") present$([ "${have_sum:-$sum_line}" = "$sum_line" ] && [ "${have_mod:-$mod_line}" = "$mod_line" ] && echo " and equal")"
        fi
    fi
fi

# ---------------------------------------------------------------- the proxy's record
set +e
info="$(curl -fsSL --proto '=https,http' --retry 2 "$PROXY/$ESC_MODULE/@v/$ESC_VERSION.info" 2>"$WORK/info.err")"
status=$?
set -e
if [ "$status" != "0" ]; then
    flag "the module proxy has no record of $VERSION ($PROXY/$ESC_MODULE/@v/$ESC_VERSION.info)"
else
    printf '%s' "$info" > "$WORK/info.json"
    parsed="$(python3 -I - "$WORK/info.json" "$MIN_AGE" "$NOW" <<'EOF'
import datetime as dt, json, sys
doc = json.load(open(sys.argv[1]))
min_age = float(sys.argv[2])
now = dt.datetime.fromisoformat(sys.argv[3].replace("Z", "+00:00")) if sys.argv[3] else dt.datetime.now(dt.timezone.utc)
t = doc.get("Time", "")
age = round((now - dt.datetime.fromisoformat(t.replace("Z", "+00:00"))).total_seconds() / 86400, 1) if t else None
print(f"time {t or '?'} age {age if age is not None else '?'}")
o = doc.get("Origin") or {}
print(f"origin {o.get('VCS', '?')} {o.get('URL', '?')} ref {o.get('Ref', '?')} hash {o.get('Hash', '?')}")
if age is None:
    print("FLAG the proxy record carries no Time: the age cannot be checked")
elif age < min_age:
    print(f"FLAG {age} days old, younger than the lane's {min_age:g} days (under that only on the maintainer's explicit decision)")
EOF
)"
    printf '%s\n' "$parsed" | sed -n 's/^time /   time /p'
    printf '%s\n' "$parsed" | sed -n 's/^origin /   origin /p'
    while IFS= read -r line; do
        [ -n "$line" ] && flag "$line"
    done < <(printf '%s\n' "$parsed" | sed -n 's/^FLAG //p')
fi

echo
if [ ${#FLAGS[@]} -gt 0 ]; then
    for f in "${FLAGS[@]}"; do echo "RED FLAG: $f"; done
    echo "${#FLAGS[@]} red flag(s): read them before raising $MODULE in deploy/Containerfile"
    exit 1
fi
echo "no red flag"
