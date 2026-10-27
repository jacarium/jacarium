#!/bin/bash
# Attach the attestation bundles to releases published before release.yml attached them (3.4.8). For each
# tag: download the release's files, fetch every file's Sigstore bundles from GitHub's attestation store
# (gh attestation download), verify each bundle from disk the way release.yml does, and upload the bundles
# beside the files as <file>.intoto.jsonl - the material for offline verification, and the asset names the
# OpenSSF Scorecard's Signed-Releases check reads (it looks at the last releases, so the recent ones need
# this once).
#
#   scripts/backfill-release-bundles.sh vX.Y.Z [vX.Y.Z ...]   dry run: download, verify, say what would be uploaded
#   scripts/backfill-release-bundles.sh --yes vX.Y.Z ...       upload too
#
#   --clobber        replace bundle assets the release already has (otherwise such a release is skipped)
#   --repo <o/r>     the repository (default: GITHUB_REPO of ~/.config/jacarium/release.env, else jacarium/jacarium)
#   --keep           keep the working directory (its path is printed) instead of removing it
#
# Needs the GitHub CLI signed in (gh auth status); --yes needs write access to the releases. Provenance must
# verify for every file or nothing is uploaded; the SBOM and VEX attestations of an installer are verified when
# the release has them (older releases may not) and reported either way. SHA256SUMS.txt of an existing release
# is left as it is - it predates the bundles; their checksums are printed instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

CONFIG="${JACARIUM_RELEASE_ENV:-$HOME/.config/jacarium/release.env}"
GITHUB_REPO=""
if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
fi
REPO_SLUG="${GITHUB_REPO:-jacarium/jacarium}"

YES=false; CLOBBER=false; KEEP=false; TAGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) YES=true ;;
        --clobber) CLOBBER=true ;;
        --keep) KEEP=true ;;
        --repo) REPO_SLUG="${2:-}"; [ -n "$REPO_SLUG" ] || die "--repo needs a value"; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) usage; die "unknown option: $1" ;;
        *) [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a release tag: $1 (vX.Y.Z)"; TAGS+=("$1") ;;
    esac
    shift
done
[ "${#TAGS[@]}" -gt 0 ] || { usage; die "which release? name its tag(s): vX.Y.Z"; }
[[ "$REPO_SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "not an owner/repo: $REPO_SLUG"

need_cmd gh
gh auth status > /dev/null 2>&1 || die "the GitHub CLI is not signed in (gh auth login)"
SIGNER="$REPO_SLUG/.github/workflows/build.yml"
VERIFY=(gh attestation verify --repo "$REPO_SLUG" --signer-workflow "$SIGNER" --deny-self-hosted-runners)

sha256_of() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/jacarium-bundles.XXXXXX")"
if $KEEP; then log_info "working directory: $WORK (kept)"; else trap 'rm -rf "$WORK"' EXIT; fi
$YES || log_info "dry run: nothing is uploaded without --yes"

done_tags=0
for tag in "${TAGS[@]}"; do
    echo; log_info "== $tag =="
    assets="$(gh release view "$tag" --repo "$REPO_SLUG" --json assets --jq '.assets[].name')" || die "no release $tag in $REPO_SLUG"
    have="$(printf '%s\n' "$assets" | grep -c '\.intoto\.jsonl$' || true)"
    if [ "$have" != 0 ] && ! $CLOBBER; then
        log_warning "$tag has $have bundle asset(s) already - skipped (--clobber replaces them)"
        continue
    fi
    dir="$WORK/$tag"; mkdir -p "$dir/files" "$dir/bundles"
    gh release download "$tag" --repo "$REPO_SLUG" --dir "$dir/files" || die "the download of $tag failed"
    n=0
    for f in "$dir"/files/*; do
        name="$(basename "$f")"
        case "$name" in SHA256SUMS.txt|*.intoto.jsonl|*.sigstore.json) continue ;; esac
        bundle="$dir/bundles/${name}.intoto.jsonl"
        ( cd "$dir/bundles" && gh attestation download "$f" --repo "$REPO_SLUG" > /dev/null ) \
            || die "no attestations for $name in GitHub's store ($tag)"
        digest="$(sha256_of "$f")"
        # named sha256:<digest>.jsonl; a dash instead of the colon on Windows
        if [ -f "$dir/bundles/sha256:${digest}.jsonl" ]; then mv "$dir/bundles/sha256:${digest}.jsonl" "$bundle"
        elif [ -f "$dir/bundles/sha256-${digest}.jsonl" ]; then mv "$dir/bundles/sha256-${digest}.jsonl" "$bundle"
        else die "gh attestation download wrote no sha256:${digest}.jsonl for $name"; fi
        "${VERIFY[@]}" "$f" --bundle "$bundle" > /dev/null || die "the provenance of $name does not verify from its bundle - nothing uploaded"
        extra=""
        case "$name" in
            *.AppImage|*.deb|*.rpm|*.dmg)
                if "${VERIFY[@]}" "$f" --bundle "$bundle" --predicate-type https://spdx.dev/Document/v2.3 > /dev/null 2>&1; then extra="$extra, SBOM ok"; else extra="$extra, no SBOM attestation"; fi
                if "${VERIFY[@]}" "$f" --bundle "$bundle" --predicate-type https://openvex.dev/ns/v0.2.0 > /dev/null 2>&1; then extra="$extra, VEX ok"; else extra="$extra, no VEX attestation"; fi ;;
        esac
        log_info "$(basename "$bundle"): $(grep -c '' "$bundle") attestation(s), provenance ok${extra}"
        n=$((n + 1))
    done
    [ "$n" -gt 0 ] || die "$tag: no attested file among its assets"
    log_info "$n bundle(s) for $tag, sha256:"
    ( cd "$dir/bundles" && for b in *.intoto.jsonl; do printf '  %s  %s\n' "$(sha256_of "$b")" "$b"; done )
    if ! $YES; then
        log_info "dry run: $n bundle(s) would be uploaded to $tag$( $CLOBBER && printf ' (replacing existing ones)')"
        continue
    fi
    if $CLOBBER; then
        gh release upload "$tag" "$dir"/bundles/*.intoto.jsonl --repo "$REPO_SLUG" --clobber || die "the upload to $tag failed"
    else
        gh release upload "$tag" "$dir"/bundles/*.intoto.jsonl --repo "$REPO_SLUG" || die "the upload to $tag failed (an asset of that name exists? --clobber replaces)"
    fi
    log_success "$n bundle(s) attached to $tag"
    done_tags=$((done_tags + 1))
done
echo
if $YES; then log_success "$done_tags release(s) updated"; else log_info "dry run over: run again with --yes to upload"; fi
