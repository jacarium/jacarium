#!/bin/bash
# Fetch one of the pinned third-party tools (.github/tools.env) from its GitHub release and verify it before anyone
# runs it: the sha256 recorded in tools.env first, then the project's own signature - cosign's Sigstore bundle for
# syft, grype and cosign itself, SLSA provenance checked with slsa-verifier for scorecard and osv-scanner. Only
# cosign and slsa-verifier rest on their recorded sha256 alone (the trust roots; cosign also checks its own bundle
# once it is on disk). Nothing is piped into a shell and nothing runs before its checks pass.
#
#   .github/scripts/fetch-tool.sh <syft|grype|cosign|scorecard|osv-scanner|slsa-verifier> [<dir>]
#
# Installs <dir>/<tool> (default $RUNNER_TEMP/jacarium-tools, or /tmp/jacarium-tools), prints the path, and adds
# <dir> to GITHUB_PATH when running in GitHub Actions. Linux amd64/arm64 and macOS; curl and sha256sum / shasum.
set -euo pipefail

TOOL="${1:?tool name}"
DIR="${2:-${RUNNER_TEMP:-/tmp}/jacarium-tools}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../tools.env
. "$HERE/../tools.env"

die() { echo "fetch-tool: $*" >&2; exit 1; }
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in linux|darwin) ;; *) die "unsupported OS $os" ;; esac
arch="$(uname -m)"
case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported architecture $arch" ;; esac
key="$(printf '%s' "$TOOL" | tr '[:lower:]-' '[:upper:]_')"
version="$(eval "printf '%s' \"\${${key}_VERSION:-}\"")"
expected="$(eval "printf '%s' \"\${${key}_SHA256_$(printf '%s_%s' "$os" "$arch" | tr '[:lower:]' '[:upper:]'):-}\"")"
[ -n "$version" ] || die "unknown tool $TOOL (no ${key}_VERSION in tools.env)"
[ -n "$expected" ] || die "no sha256 for $TOOL on $os/$arch in tools.env"

mkdir -p "$DIR"
if [ -x "$DIR/$TOOL" ] && [ -f "$DIR/$TOOL.version" ] && [ "$(cat "$DIR/$TOOL.version")" = "$version" ]; then
    printf '%s\n' "$DIR/$TOOL"; exit 0
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fetch-tool.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fetch() {  # <url> <file>
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$WORK/$2" "$1" || die "download failed: $1"
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
check_sha() {  # <file> <expected> <what>
    local got; got="$(sha256_of "$1")"
    [ "$got" = "$2" ] || die "$3: sha256 $got, expected $2"
    echo "fetch-tool: $3 sha256 ok"
}
# the line for <file> in a checksums file must name <expected>
check_in_list() {  # <checksums file> <file name> <file>
    local want; want="$(grep -E "[[:space:]]\*?$2\$" "$1" | awk '{print $1}' | head -1)"
    [ -n "$want" ] || die "$2 is not in $(basename "$1")"
    check_sha "$3" "$want" "$2 against the signed checksums"
}
cosign_bin() { "$HERE/fetch-tool.sh" cosign "$DIR"; }
slsa_verifier_bin() { "$HERE/fetch-tool.sh" slsa-verifier "$DIR"; }
install_bin() {  # <file>
    chmod 0755 "$1"; mv "$1" "$DIR/$TOOL"; printf '%s\n' "$version" > "$DIR/$TOOL.version"
}
GH="https://github.com"

case "$TOOL" in
    cosign)
        base="$GH/sigstore/cosign/releases/download/v$version"
        fetch "$base/cosign-$os-$arch" cosign
        check_sha "$WORK/cosign" "$expected" "cosign-$os-$arch"
        # cosign's own release signature (keyless, Sigstore's release identity) - checked by the binary the
        # sha256 just vouched for
        fetch "$base/cosign-$os-$arch.sigstore.json" cosign.sigstore.json
        chmod 0755 "$WORK/cosign"
        "$WORK/cosign" verify-blob --bundle "$WORK/cosign.sigstore.json" \
            --certificate-identity keyless@projectsigstore.iam.gserviceaccount.com \
            --certificate-oidc-issuer https://accounts.google.com "$WORK/cosign" >/dev/null \
            || die "cosign's own release signature did not verify"
        echo "fetch-tool: cosign release signature ok"
        install_bin "$WORK/cosign"
        ;;
    syft|grype)
        base="$GH/anchore/$TOOL/releases/download/v$version"
        archive="${TOOL}_${version}_${os}_${arch}.tar.gz"
        fetch "$base/$archive" "$archive"
        check_sha "$WORK/$archive" "$expected" "$archive"
        # Anchore signs the checksums file with its release workflow's identity
        fetch "$base/${TOOL}_${version}_checksums.txt" checksums.txt
        fetch "$base/${TOOL}_${version}_checksums.txt.sigstore.json" checksums.sigstore.json
        cosign="$(cosign_bin)"
        "$cosign" verify-blob --bundle "$WORK/checksums.sigstore.json" \
            --certificate-identity "https://github.com/anchore/$TOOL/.github/workflows/release.yaml@refs/heads/main" \
            --certificate-oidc-issuer https://token.actions.githubusercontent.com "$WORK/checksums.txt" >/dev/null \
            || die "$TOOL: the checksums file's signature did not verify"
        echo "fetch-tool: $TOOL checksums signature ok"
        check_in_list "$WORK/checksums.txt" "$archive" "$WORK/$archive"
        tar -xzf "$WORK/$archive" -C "$WORK" "$TOOL"
        install_bin "$WORK/$TOOL"
        ;;
    scorecard)
        base="$GH/ossf/scorecard/releases/download/v$version"
        archive="scorecard_${version}_${os}_${arch}.tar.gz"
        fetch "$base/$archive" "$archive"
        check_sha "$WORK/$archive" "$expected" "$archive"
        fetch "$base/scorecard_checksums.txt" checksums.txt
        check_in_list "$WORK/checksums.txt" "$archive" "$WORK/$archive"
        # the release's SLSA provenance names the archive; slsa-verifier checks the builder and the source
        fetch "$base/multiple.intoto.jsonl" multiple.intoto.jsonl
        verifier="$(slsa_verifier_bin)"
        "$verifier" verify-artifact "$WORK/$archive" --provenance-path "$WORK/multiple.intoto.jsonl" \
            --source-uri github.com/ossf/scorecard --source-tag "v$version" >/dev/null \
            || die "scorecard: the SLSA provenance did not verify"
        echo "fetch-tool: scorecard SLSA provenance ok"
        tar -xzf "$WORK/$archive" -C "$WORK" "scorecard-$os-$arch"
        install_bin "$WORK/scorecard-$os-$arch"
        ;;
    osv-scanner)
        base="$GH/google/osv-scanner/releases/download/v$version"
        bin="osv-scanner_${os}_${arch}"
        fetch "$base/$bin" "$bin"
        check_sha "$WORK/$bin" "$expected" "$bin"
        fetch "$base/multiple.intoto.jsonl" multiple.intoto.jsonl
        verifier="$(slsa_verifier_bin)"
        "$verifier" verify-artifact "$WORK/$bin" --provenance-path "$WORK/multiple.intoto.jsonl" \
            --source-uri github.com/google/osv-scanner --source-tag "v$version" >/dev/null \
            || die "osv-scanner: the SLSA provenance did not verify"
        echo "fetch-tool: osv-scanner SLSA provenance ok"
        install_bin "$WORK/$bin"
        ;;
    slsa-verifier)
        # the second trust root: its recorded sha256 (from the project's SHA256SUM.md at the release)
        bin="slsa-verifier-$os-$arch"
        fetch "$GH/slsa-framework/slsa-verifier/releases/download/v$version/$bin" "$bin"
        check_sha "$WORK/$bin" "$expected" "$bin"
        install_bin "$WORK/$bin"
        ;;
    *) die "unknown tool $TOOL" ;;
esac

if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$DIR" >> "$GITHUB_PATH"; fi
printf '%s\n' "$DIR/$TOOL"
