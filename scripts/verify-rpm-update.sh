#!/bin/bash
# The checks the security lane asks for before one Red Hat RPM is raised past the pinned base image in
# deploy/Containerfile (the `microdnf ... upgrade <name>` line; SECURITY.md, "Dependency policy"): the RPM
# counterpart of scripts/urgent-dep-update.cjs. Nothing on this machine changes: the package is upgraded inside
# a throwaway container from the base image, and the report is what goes into docs/security/urgent-updates.md.
#
#   scripts/verify-rpm-update.sh --cve CVE-2026-8932 curl-minimal-7.76.1-40.el9_8.9 libcurl-minimal-7.76.1-40.el9_8.9
#   scripts/verify-rpm-update.sh --advisory RHSA-2026:89749 xz-libs-5.2.5-8.el9_8.1
#
# Options:
#   --cve CVE-YYYY-N        the advisory is looked up in Red Hat's security data for this CVE (repeatable; the
#                           entry for --product whose package carries the requested version-release)
#   --advisory RHSA-YYYY:N  the erratum itself, when known
#   --product NAME          the product line in the CVE record (default "Red Hat Enterprise Linux 9")
#   --image REF             the base image to upgrade in (default: the runtime stage's FROM in deploy/Containerfile)
#   --engine podman|docker  the container engine (default podman)
#   --key KEYID             another signing key id to accept, hex (repeatable), next to Red Hat's release key 2
#                           (199e2f91fd431d51), which is always accepted
#   --min-age-days N        the lane's floor (default 2)
#   --no-container          only the advisory checks (no engine needed)
#   --api-url URL           Red Hat's security data API (for the test)
#   --now ISO-8601          the clock (for the test)
#
# What it reports, and flags in red:
#   - the erratum: its id, severity, CVEs and first release date from the CSAF document, its age (younger than
#     --min-age-days is a red flag: under that only on the maintainer's explicit decision, which this script
#     does not take), and that every requested package-version-release is among the erratum's fixed packages;
#   - the RPM: upgraded with microdnf inside the base image (gpgcheck is on in the UBI repositories, so an
#     unsigned or foreign package never installs), then `rpm -q`: the installed version-release equals the
#     requested one (else the repositories do not carry it yet: a red flag), the signature's key id is one of
#     --key (a red flag otherwise), the vendor, build time and source RPM.
#
# Exit 0 with "no red flag", 1 when there is one (each printed as RED FLAG: ...), 2 on a usage or network
# error. Needs curl, python3 (standard library) and the container engine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
API="https://access.redhat.com/hydra/rest/securitydata"
PRODUCT="Red Hat Enterprise Linux 9"
ENGINE="podman"
IMAGE=""
MIN_AGE="2"
NOW=""
CONTAINER=1
ADVISORY=""
CVES=()
KEYS=("199e2f91fd431d51")
PACKAGES=()

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --cve) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; CVES+=("$2"); shift ;;
        --advisory) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; ADVISORY="$2"; shift ;;
        --product) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; PRODUCT="$2"; shift ;;
        --image) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; IMAGE="$2"; shift ;;
        --engine) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; ENGINE="$2"; shift ;;
        --key) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; KEYS+=("$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"); shift ;;
        --min-age-days) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; MIN_AGE="$2"; shift ;;
        --no-container) CONTAINER=0 ;;
        --api-url) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; API="${2%/}"; shift ;;
        --now) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; NOW="$2"; shift ;;
        -*) echo "error: unknown option $1 (see --help)" >&2; exit 2 ;;
        *) PACKAGES+=("$1") ;;
    esac
    shift
done
[ ${#PACKAGES[@]} -gt 0 ] || { echo "error: at least one NAME-VERSION-RELEASE is required (see --help)" >&2; exit 2; }
[ -n "$ADVISORY" ] || [ ${#CVES[@]} -gt 0 ] || { echo "error: --cve or --advisory is required (see --help)" >&2; exit 2; }
for p in "${PACKAGES[@]}"; do
    case "$p" in
        *-*-*) ;;
        *) echo "error: $p is not NAME-VERSION-RELEASE" >&2; exit 2 ;;
    esac
done

FLAGS=()
flag() { FLAGS+=("$1"); }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-rpm.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fetch() {  # <url> <file>
    curl -fsSL --proto '=https,http' --retry 2 -o "$2" "$1" || { echo "error: could not fetch $1" >&2; exit 2; }
}

# name-version-release -> "version-release" (the last two dash-separated fields)
vr_of() { local n="$1"; local rel="${n##*-}"; n="${n%-*}"; local ver="${n##*-}"; printf '%s-%s' "$ver" "$rel"; }
name_of() { local n="$1"; n="${n%-*}"; printf '%s' "${n%-*}"; }

# ---------------------------------------------------------------- the erratum
if [ -z "$ADVISORY" ]; then
    for cve in "${CVES[@]}"; do
        fetch "$API/cve/$cve.json" "$WORK/$cve.json"
        found="$(python3 -I - "$WORK/$cve.json" "$PRODUCT" "$(vr_of "${PACKAGES[0]}")" <<'EOF'
import json, sys
doc = json.load(open(sys.argv[1]))
product, vr = sys.argv[2], sys.argv[3]
print(f"public {doc.get('public_date', '?')} severity {doc.get('threat_severity', '?')}")
for r in doc.get("affected_release") or []:
    if r.get("product_name") == product and str(r.get("package", "")).endswith(vr):
        print(f"advisory {r.get('advisory')} {r.get('release_date')} {r.get('package')}")
        break
else:
    print("advisory none")
EOF
)"
        echo "== $cve: $(printf '%s\n' "$found" | head -1)"
        adv_line="$(printf '%s\n' "$found" | sed -n 's/^advisory //p')"
        if [ "$adv_line" = "none" ]; then
            flag "$cve: no erratum for $PRODUCT carries $(vr_of "${PACKAGES[0]}") yet (not fixed, or fixed in another build)"
        else
            adv="${adv_line%% *}"
            echo "   $PRODUCT: $adv_line"
            if [ -n "$ADVISORY" ] && [ "$ADVISORY" != "$adv" ]; then
                flag "$cve is fixed by $adv, not the same erratum as the other CVEs ($ADVISORY)"
            fi
            ADVISORY="$adv"
        fi
    done
fi

if [ -n "$ADVISORY" ]; then
    fetch "$API/csaf/$ADVISORY.json" "$WORK/csaf.json"
    csaf="$(python3 -I - "$WORK/csaf.json" "$MIN_AGE" "$NOW" "${PACKAGES[@]}" <<'EOF'
import datetime as dt, json, sys
doc = json.load(open(sys.argv[1]))
min_age = float(sys.argv[2])
now = dt.datetime.fromisoformat(sys.argv[3].replace("Z", "+00:00")) if sys.argv[3] else dt.datetime.now(dt.timezone.utc)
packages = sys.argv[4:]
d = doc.get("document", {})
tracking = d.get("tracking", {})
first = tracking.get("initial_release_date", "")
sev = (d.get("aggregate_severity") or {}).get("text", "?")
cves = sorted({v.get("cve", "?") for v in doc.get("vulnerabilities") or []})
age = None
if first:
    age = round((now - dt.datetime.fromisoformat(first.replace("Z", "+00:00"))).total_seconds() / 86400, 1)
print(f"title {d.get('title', '?')}")
print(f"released {first or '?'} severity {sev} cves {','.join(cves)}")
print(f"age {age if age is not None else '?'}")
if age is None:
    print("FLAG the CSAF document carries no initial_release_date: the age cannot be checked")
elif age < min_age:
    print(f"FLAG {tracking.get('id', '?')} is {age} days old, younger than the lane's {min_age:g} days (under that only on the maintainer's explicit decision)")
fixed = set()
for v in doc.get("vulnerabilities") or []:
    for p in (v.get("product_status") or {}).get("fixed") or []:
        fixed.add(p.split(":", 1)[1] if ":" in p else p)   # strip the product branch
for nvr in packages:
    name, rest = nvr.rsplit("-", 2)[0], "-".join(nvr.rsplit("-", 2)[1:])
    hits = sorted(f for f in fixed if f.startswith(f"{name}-0:{rest}.") or f.startswith(f"{name}-{rest}."))
    if hits:
        print(f"fixed {nvr}: {', '.join(sorted({h.rsplit('.', 1)[1] for h in hits}))}")
    else:
        print(f"FLAG {nvr} is not among the erratum's fixed packages")
EOF
)"
    echo "== $ADVISORY: $(printf '%s\n' "$csaf" | sed -n 's/^title //p')"
    printf '%s\n' "$csaf" | sed -n 's/^released /   released /p'
    printf '%s\n' "$csaf" | sed -n 's/^age \(.*\)$/   age \1 days/p'
    printf '%s\n' "$csaf" | sed -n 's/^fixed /   fixed: /p'
    while IFS= read -r line; do
        [ -n "$line" ] && flag "$line"
    done < <(printf '%s\n' "$csaf" | sed -n 's/^FLAG //p')
fi

# ---------------------------------------------------------------- the RPM, inside the base image
if [ "$CONTAINER" = "1" ]; then
    if [ -z "$IMAGE" ]; then
        IMAGE="$(grep -E '^FROM ' "$REPO/deploy/Containerfile" | tail -1 | awk '{print $2}')"
    fi
    names=()
    for p in "${PACKAGES[@]}"; do names+=("$(name_of "$p")"); done
    echo "== $IMAGE: microdnf upgrade ${names[*]}"
    # the signature: RHEL 9 signs the header (RSAHEADER); older packages carried SIGPGP
    qf='%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}|%|RSAHEADER?{%{RSAHEADER:pgpsig}}:{%{SIGPGP:pgpsig}}||%{VENDOR}|%{BUILDTIME:date}|%{SOURCERPM}\n'
    set +e
    out="$("$ENGINE" run --rm "$IMAGE" sh -c "microdnf -y --setopt=install_weak_deps=0 --nodocs upgrade ${names[*]} >/dev/null 2>&1; rpm -q --qf '$qf' ${names[*]}" 2>&1)"
    status=$?
    set -e
    if [ "$status" != "0" ]; then
        echo "error: the engine run failed ($status): $(printf '%s\n' "$out" | tail -3)" >&2
        exit 2
    fi
    for p in "${PACKAGES[@]}"; do
        n="$(name_of "$p")"
        line="$(printf '%s\n' "$out" | grep -E "^$n-[^|]*\|" | head -1 || true)"
        if [ -z "$line" ]; then
            flag "$n: rpm -q gave nothing after the upgrade"
            continue
        fi
        installed="${line%%|*}"; rest="${line#*|}"
        sig="${rest%%|*}"; rest="${rest#*|}"
        vendor="${rest%%|*}"; rest="${rest#*|}"
        built="${rest%%|*}"; srpm="${rest#*|}"
        echo "   $installed: signature $sig"
        echo "   vendor $vendor, built $built, source $srpm"
        case "$installed" in
            "$p".*) ;;
            *) flag "$n: the repositories carry $installed, not $p" ;;
        esac
        keyid="$(printf '%s' "$sig" | sed -n 's/.*[Kk]ey ID \([0-9a-fA-F]*\).*/\1/p' | tr '[:upper:]' '[:lower:]')"
        ok=0
        for k in "${KEYS[@]}"; do [ "$keyid" = "$k" ] && ok=1; done
        if [ "$ok" != "1" ]; then
            flag "$n: signed with key ${keyid:-none}, not one of ${KEYS[*]}"
        fi
        case "$vendor" in
            "Red Hat, Inc.") ;;
            *) flag "$n: vendor is '$vendor', not Red Hat, Inc." ;;
        esac
    done
fi

echo
if [ ${#FLAGS[@]} -gt 0 ]; then
    for f in "${FLAGS[@]}"; do echo "RED FLAG: $f"; done
    echo "${#FLAGS[@]} red flag(s): read them before raising the package in deploy/Containerfile"
    exit 1
fi
echo "no red flag"
