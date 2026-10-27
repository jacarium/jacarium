#!/bin/bash
# An interim development snapshot of main to the public repository: the OpenSSF Best Practices criterion
# repo_interim ("the project's source repository MUST include interim versions for review between releases; it
# MUST NOT include only final releases"). publish-release.sh exports only at a release, one signed commit
# "Jacarium X.Y.Z" plus the tag; this exports the current main between releases, as one signed commit, no tag.
#
#   scripts/publish-snapshot.sh                 export HEAD of main, commit, ask, push
#   scripts/publish-snapshot.sh --yes           no questions
#   scripts/publish-snapshot.sh --dry-run       show what it would commit (the message included), change nothing
#
# Steps:
#   1. checks      a clean working tree on main here; the public clone clean, on its default branch, up to date
#                  with GitHub, set up for SSH signing (scripts/release-sign.sh --check)
#   2. export      scripts/export-source.sh <PUBLIC_DIR> --ref HEAD --yes (the privacy scan runs there first);
#                  stops when the exported tree equals the clone's HEAD - no empty snapshot
#   3. commit      ONE signed commit through scripts/release-sign.sh --snapshot, verified against the exported
#                  .github/allowed_signers: "Development snapshot: main @ <short sha> (after vX.Y.Z)", the body
#                  listing the commit subjects here since the last export (merges and the release / bump
#                  commits left out, like the What's New generator). Your own git identity.
#   4. push        the clone's default branch to origin, after a confirmation unless --yes
# No tag, no version bump, no deploy, no release notes, no GitHub release. A push to the public main runs the
# CodeQL, Scan and Scorecard workflows; release.yml (tags only), the image publishing and COPR do not start.
#
# Settings: the same ~/.config/jacarium/release.env as publish-release.sh (PUBLIC_DIR, GITHUB_REPO), or
#   --public-dir <dir>       the public clone (tests)
#   --allow-any-branch       snapshot the current branch instead of refusing a branch other than main (tests)
#   --skip-checks            skip the branch check and the lint (the privacy scan always runs)
#   ALLOWED_SIGNERS_FILE     the signers file the commit's signature is verified against (tests, with a throwaway
#                            key; the default is the exported .github/allowed_signers)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

YES=false; DRY_RUN=false; ANY_BRANCH=false; SKIP_CHECKS=false; PUBLIC_DIR_ARG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) YES=true ;;
        --dry-run) DRY_RUN=true ;;
        --allow-any-branch) ANY_BRANCH=true ;;
        --skip-checks) SKIP_CHECKS=true ;;
        --public-dir) PUBLIC_DIR_ARG="${2:-}"; [ -n "$PUBLIC_DIR_ARG" ] || die "--public-dir needs a value"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
    shift
done

# --- settings ----------------------------------------------------------------
CONFIG="${JACARIUM_RELEASE_ENV:-$HOME/.config/jacarium/release.env}"
PUBLIC_DIR=""; GITHUB_REPO="jacarium/jacarium"
if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
fi
[ -z "$PUBLIC_DIR_ARG" ] || PUBLIC_DIR="$PUBLIC_DIR_ARG"
PUBLIC_DIR="${PUBLIC_DIR/#\~/$HOME}"
[ -n "$PUBLIC_DIR" ] || die "PUBLIC_DIR is not set in $CONFIG (see --help)"

confirm() {
    $YES && return 0
    local answer
    printf '%s [y/N] ' "$1"
    read -r answer || { echo; return 1; }
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
step() { echo; log_info "== $* =="; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jacarium-snapshot.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- 1. checks -----------------------------------------------------------------
step "1. checks"
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "this repository has uncommitted changes - commit or stash them first"
HERE_BRANCH="$(git -C "$REPO" symbolic-ref --short -q HEAD || true)"
if ! $ANY_BRANCH && ! $SKIP_CHECKS; then
    [ "$HERE_BRANCH" = main ] || die "snapshots are taken from main; this is '${HERE_BRANCH:-a detached HEAD}' (--allow-any-branch to snapshot it anyway)"
fi
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"; HEAD_SHORT="$(git -C "$REPO" rev-parse --short HEAD)"
LAST_TAG="$(git -C "$REPO" describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
log_info "here: ${HERE_BRANCH:-detached} @ $HEAD_SHORT${LAST_TAG:+ (after $LAST_TAG)}"

[ -d "$PUBLIC_DIR/.git" ] || die "PUBLIC_DIR=$PUBLIC_DIR is not a git clone"
ORIGIN="$(git -C "$PUBLIC_DIR" remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in *jacarium*) ;; *) die "$PUBLIC_DIR's origin is '$ORIGIN', not a jacarium repository" ;; esac
[ -z "$(git -C "$PUBLIC_DIR" status --porcelain)" ] || die "the public clone has uncommitted changes - clean it first (git -C \"$PUBLIC_DIR\" status)"
BRANCH="$(git -C "$PUBLIC_DIR" symbolic-ref --short -q HEAD || true)"
[ -n "$BRANCH" ] || die "the public clone is on a detached HEAD - check out its default branch first"
git -C "$PUBLIC_DIR" fetch -q origin || die "cannot fetch from the public repository's origin - check the network"
DEFAULT="$(git -C "$PUBLIC_DIR" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null || true)"
DEFAULT="${DEFAULT#origin/}"; [ -n "$DEFAULT" ] || DEFAULT="$BRANCH"
[ "$BRANCH" = "$DEFAULT" ] || die "the public clone is on branch '$BRANCH', not '$DEFAULT' - switch to it first"
if git -C "$PUBLIC_DIR" rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
    BEHIND="$(git -C "$PUBLIC_DIR" rev-list --count "HEAD..origin/$BRANCH")"
    AHEAD="$(git -C "$PUBLIC_DIR" rev-list --count "origin/$BRANCH..HEAD")"
    [ "$BEHIND" = 0 ] || die "GitHub has $BEHIND commit(s) the public clone doesn't - pull them first (git -C \"$PUBLIC_DIR\" pull)"
    [ "$AHEAD" = 0 ] || die "the public clone has $AHEAD unpushed commit(s) - push or drop them first"
fi
"$REPO/scripts/release-sign.sh" --check "$PUBLIC_DIR" || die "set the public clone up for SSH signing first (see above)"
log_info "public clone $PUBLIC_DIR ($ORIGIN, $BRANCH)"

# Where the last export came from: a snapshot names its source commit ("main @ <sha>"), a release its version
# ("Jacarium X.Y.Z" = the tag vX.Y.Z here); the subjects since then make the body.
SINCE=""
while IFS= read -r subject; do
    case "$subject" in
        "Development snapshot: "*"@ "*)
            sha="$(printf '%s' "$subject" | sed -E 's/^Development snapshot: [^@]*@ ([0-9a-f]+).*/\1/')"
            if git -C "$REPO" rev-parse -q --verify "$sha^{commit}" >/dev/null 2>&1; then SINCE="$sha"; break; fi ;;
        "Jacarium "[0-9]*)
            v="${subject#Jacarium }"
            if git -C "$REPO" rev-parse -q --verify "refs/tags/v$v" >/dev/null 2>&1; then SINCE="v$v"; break; fi ;;
    esac
done < <(git -C "$PUBLIC_DIR" log --format=%s -n 100 2>/dev/null)
if [ -n "$SINCE" ] && [ "$(git -C "$REPO" rev-parse "$SINCE^{commit}")" = "$HEAD_SHA" ]; then
    die "nothing to snapshot: the public clone already holds main @ $HEAD_SHORT (its last export came from this commit)"
fi
# the same subjects the What's New generator keeps: no merges, no version-bump / release / baseline commits
SKIP_RE='^(Bump version\b|Release v?[0-9]|Baseline snapshot\b)'
if [ -n "$SINCE" ]; then
    SUBJECTS="$(git -C "$REPO" log --no-merges --format=%s "$SINCE..HEAD" | grep -Ev "$SKIP_RE" || true)"
    N_COMMITS="$(git -C "$REPO" rev-list --count "$SINCE..HEAD")"
    log_info "last export: $SINCE; $N_COMMITS commit(s) since"
else
    SUBJECTS="$(git -C "$REPO" log --no-merges --format=%s -n 30 | grep -Ev "$SKIP_RE" || true)"
    log_warning "the public clone's history names no export this repository knows; the body lists the last 30 subjects"
fi

if ! $SKIP_CHECKS && ! $DRY_RUN; then
    log_info "lint"
    npm --prefix "$REPO" run --silent lint >"$TMP/lint.txt" 2>&1 || { tail -20 "$TMP/lint.txt" || true; die "lint failed"; }
fi

{
    printf 'Development snapshot: main @ %s%s\n\n' "$HEAD_SHORT" "${LAST_TAG:+ (after $LAST_TAG)}"
    printf 'The development state between releases, for review (an interim version, not a release:\nno tag, no installers, no image). Changes since the last export:\n\n'
    if [ -n "$SUBJECTS" ]; then printf '%s\n' "$SUBJECTS" | sed 's/^/- /'; else printf -- '- (no commit subjects to list)\n'; fi
} > "$TMP/message.txt"

# The message is public text too: the privacy scan over it like over the exported files, and the
# maintainer's local publish hook when there is one
if [ -x "$REPO/.publish-hooks/check-message" ]; then
    "$REPO/.publish-hooks/check-message" "$TMP/message.txt" || die "a local publish hook refused the snapshot message (see above)"
fi
mkdir -p "$TMP/message-scan" && cp "$TMP/message.txt" "$TMP/message-scan/message.txt"
"$REPO/scripts/privacy-scan.sh" --dir "$TMP/message-scan" >"$TMP/message-scan.log" 2>&1 \
    || { cat "$TMP/message-scan.log"; die "the privacy scan flagged the snapshot message (the commit subjects listed in it) - reword those commits' subjects or leave them out"; }

echo
log_info "plan: export main @ $HEAD_SHORT to $PUBLIC_DIR, one signed commit, push to $BRANCH"
echo; cat "$TMP/message.txt"; echo
if $DRY_RUN; then log_info "dry run - nothing changed"; exit 0; fi

# --- 2. export ---------------------------------------------------------------------
step "2. export main @ $HEAD_SHORT to $PUBLIC_DIR"
confirm "Export and commit the snapshot?" || { log_info "not confirmed - nothing exported or committed (no answer counts as no; --yes answers for you)"; exit 0; }
"$REPO/scripts/export-source.sh" "$PUBLIC_DIR" --ref "$HEAD_SHA" --yes
if [ -z "$(git -C "$PUBLIC_DIR" status --porcelain)" ]; then
    die "nothing changed since the last export: the public clone already holds exactly this tree (no empty snapshot)"
fi

# --- 3. commit, 4. push -------------------------------------------------------------
step "3. signed commit"
# (ALLOWED_SIGNERS_FILE: the file the commit's signature is verified against - the exported
# .github/allowed_signers unless the tests, signing with a throwaway key, name their own)
"$REPO/scripts/release-sign.sh" --snapshot "$TMP/message.txt" "$PUBLIC_DIR" "" "${ALLOWED_SIGNERS_FILE:-$PUBLIC_DIR/.github/allowed_signers}" \
    || die "the signed snapshot commit did not go through - nothing was pushed (the clone holds the uncommitted export: git -C \"$PUBLIC_DIR\" status)"
step "4. push to $BRANCH"
confirm "Push the snapshot to GitHub ($ORIGIN, $BRANCH)?" || { log_warning "not pushed: the snapshot commit sits in $PUBLIC_DIR - push it with: git -C \"$PUBLIC_DIR\" push origin $BRANCH"; exit 0; }
git -C "$PUBLIC_DIR" push -q origin "$BRANCH" || die "the push to $BRANCH was rejected (the snapshot commit stays in $PUBLIC_DIR)"
log_success "snapshot pushed: $(git -C "$PUBLIC_DIR" log -1 --format='%h %s')"
