#!/bin/bash
# Release to GitHub: tag the release here, export the source to the public
# clone, and push the commit and the tag that start the GitHub release
# workflow (installers, container image, draft release). Optionally deploy
# it to your own home server too (--deploy).
#
#   scripts/publish-release.sh                 the next patch (Semantic Versioning: 3.4.9 -> 3.4.10)
#   scripts/publish-release.sh --minor         the next minor (3.4.7 -> 3.5.0); --major the next major (4.0.0)
#   scripts/publish-release.sh 3.5.0           an exact version (greater than the current one)
#   scripts/publish-release.sh --dry-run       show the plan and the release notes, change nothing
#
# Options:
#   --minor, --major the part to step for the next version (the patch without them; not with an exact version)
#   --yes            no questions (also skips the pause to review the notes before tagging)
#   --dry-run        print the plan and the release notes, change nothing
#   --deploy         also deploy it to your home server (DEPLOY_TARGET)
#   --skip-checks    skip lint and the privacy scan before releasing (on purpose only)
#   --skip-public    tag here only: no export, nothing pushed to GitHub
#   --resume         publish the current version, already tagged here but not
#                    on GitHub yet (after a run that stopped), instead of a new release
#   -h, --help       this text
#
# Steps, each confirmed unless --yes:
#   1. checks      a clean working tree here; the public clone clean, on its
#                  default branch, up to date with GitHub, with its release
#                  workflow; the tag on neither side yet; lint; privacy scan
#   2. release     npm run release: writes the notes (src/whats-new, CHANGELOG.md)
#                  and bumps the version - you can edit the notes before it
#                  commits "Release vX.Y.Z" and tags vX.Y.Z here
#   3. deploy      only with --deploy: deploy/deploy-to-host.sh <DEPLOY_TARGET>
#   4. export      scripts/export-source.sh <PUBLIC_DIR> --ref vX.Y.Z
#   5. publish     in the public clone: the SIGNED commit "Jacarium X.Y.Z" and
#                  the SIGNED tag vX.Y.Z (scripts/release-sign.sh: SSH signing
#                  with the key configured in the clone, both verified against
#                  .github/allowed_signers), then push the commit and the tag -
#                  which starts the release workflow
# Then, on GitHub: approve the "quay" environment when the image job waits,
# and publish the draft release (the script prints the links).
#
# Signing: the public clone must be set up for SSH signing (gpg.format ssh,
# user.signingkey = your release signing key, whose public half is in
# .github/allowed_signers); step 1 checks it and stops with the instructions
# otherwise - there is no unsigned fallback. Anyone verifies a release with
#   git -c gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag vX.Y.Z
#
# Resuming: if a run stopped after step 2 (the version is tagged here but not
# on GitHub), run it again with --resume: it goes on with steps 3-5 for that
# tag. Without --resume it never republishes an existing version - it stops
# and says which of the two you want.
#
# The private repository is the only source: anything committed directly on
# GitHub is overwritten by the next export.
#
# Settings are personal, so they live outside the repository, in
# ~/.config/jacarium/release.env (or the file JACARIUM_RELEASE_ENV names):
#   PUBLIC_DIR=~/Documents/jacarium-public       the clone of the public repository
#   DEPLOY_TARGET=user@192.168.1.20              ssh target for --deploy (deploy-to-host.sh)
#   GITHUB_REPO=jacarium/jacarium                the public repository
#
# Commits are made with your own git identity. Nothing is
# ever force-pushed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

VERSION_ARG=""
BUMP=patch
YES=false
DRY_RUN=false
SKIP_CHECKS=false
DEPLOY=false
SKIP_PUBLIC=false
RESUME_ARG=false
while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) YES=true ;;
        --minor) BUMP=minor ;;
        --major) BUMP=major ;;
        --patch) BUMP=patch ;;
        --dry-run) DRY_RUN=true ;;
        --skip-checks) SKIP_CHECKS=true ;;
        --deploy) DEPLOY=true ;;
        --skip-public) SKIP_PUBLIC=true ;;
        --resume) RESUME_ARG=true ;;
        -h|--help) usage; exit 0 ;;
        [0-9]*.[0-9]*.[0-9]*) [ -z "$VERSION_ARG" ] || die "only one version"; VERSION_ARG="$1" ;;
        *) usage; die "unknown argument: $1" ;;
    esac
    shift
done

# --- settings ----------------------------------------------------------------
CONFIG="${JACARIUM_RELEASE_ENV:-$HOME/.config/jacarium/release.env}"
PUBLIC_DIR=""; DEPLOY_TARGET=""; GITHUB_REPO="jacarium/jacarium"
if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
fi
PUBLIC_DIR="${PUBLIC_DIR/#\~/$HOME}"
if ! $SKIP_PUBLIC && [ -z "$PUBLIC_DIR" ]; then
    die "PUBLIC_DIR is not set in $CONFIG (see --help), or pass --skip-public to tag here only"
fi
if $DEPLOY && [ -z "$DEPLOY_TARGET" ]; then die "--deploy needs DEPLOY_TARGET in $CONFIG"; fi
if $RESUME_ARG && { $SKIP_PUBLIC || [ -n "$VERSION_ARG" ]; }; then die "--resume publishes the current version: no version argument, no --skip-public"; fi
if [ -n "$VERSION_ARG" ] && [ "$BUMP" != patch ]; then die "give either an exact version or --$BUMP, not both"; fi
if $RESUME_ARG && [ "$BUMP" != patch ]; then die "--resume publishes the current version: no --$BUMP"; fi

confirm() {  # <question> - true to go on
    $YES && return 0
    local answer
    printf '%s [y/N] ' "$1"
    read -r answer || { echo; return 1; }
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
step() { echo; log_info "== $* =="; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jacarium-publish.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Exact commands for what is left after a stop (the tag exists here by then)
remaining_publish() {
    echo
    log_warning "stopped before the release reached GitHub. When the cause is fixed, either run"
    echo "    scripts/publish-release.sh --resume   (goes on with $TAG)"
    echo "  or by hand:"
    echo "    scripts/export-source.sh \"$PUBLIC_DIR\" --ref $TAG"
    echo "    scripts/release-sign.sh \"$PUBLIC_DIR\" $VERSION      # the signed commit and tag, verified"
    echo "    git -C \"$PUBLIC_DIR\" push origin $BRANCH && git -C \"$PUBLIC_DIR\" push origin $TAG"
    echo "  (by hand without the script: git -C \"$PUBLIC_DIR\" add -A && git -C \"$PUBLIC_DIR\" commit -S -m \"Jacarium $VERSION\","
    echo "   git -C \"$PUBLIC_DIR\" tag -s $TAG -m \"Jacarium $VERSION\", then verify-commit HEAD and verify-tag $TAG"
    echo "   with -c gpg.ssh.allowedSignersFile=.github/allowed_signers before pushing)"
}

remote_tag_state() {  # prints present / absent, dies when GitHub can't be asked
    local status=0
    git -C "$PUBLIC_DIR" ls-remote --exit-code --tags origin "refs/tags/$1" >/dev/null 2>&1 || status=$?
    case "$status" in
        0) echo present ;;
        2) echo absent ;;
        *) die "cannot reach the public repository's origin (git ls-remote exit $status) - check the network and $PUBLIC_DIR's remote" ;;
    esac
}

# --- 1. checks -----------------------------------------------------------------
step "1. checks"
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "this repository has uncommitted changes - commit them first"
CURRENT="$(node -p "require('$REPO/package.json').version")"
log_info "current version $CURRENT"

BRANCH=""; AHEAD=0; PUBLIC_DIRTY=false
if ! $SKIP_PUBLIC; then
    [ -d "$PUBLIC_DIR/.git" ] || die "PUBLIC_DIR=$PUBLIC_DIR is not a git clone"
    ORIGIN="$(git -C "$PUBLIC_DIR" remote get-url origin 2>/dev/null || true)"
    case "$ORIGIN" in *"$GITHUB_REPO"*) ;; *) die "$PUBLIC_DIR's origin is '$ORIGIN', not $GITHUB_REPO" ;; esac
    PUBLIC_DIRTY=false; [ -z "$(git -C "$PUBLIC_DIR" status --porcelain)" ] || PUBLIC_DIRTY=true
    BRANCH="$(git -C "$PUBLIC_DIR" symbolic-ref --short -q HEAD || true)"
    [ -n "$BRANCH" ] || die "the public clone is on a detached HEAD - check out its default branch first (git -C \"$PUBLIC_DIR\" switch main)"
    git -C "$PUBLIC_DIR" fetch -q origin || die "cannot fetch from the public repository's origin - check the network"
    DEFAULT="$(git -C "$PUBLIC_DIR" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null || true)"
    DEFAULT="${DEFAULT#origin/}"; [ -n "$DEFAULT" ] || DEFAULT=main
    [ "$BRANCH" = "$DEFAULT" ] || die "the public clone is on branch '$BRANCH', not '$DEFAULT' - switch to it first"
    if git -C "$PUBLIC_DIR" rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
        BEHIND="$(git -C "$PUBLIC_DIR" rev-list --count "HEAD..origin/$BRANCH")"
        AHEAD="$(git -C "$PUBLIC_DIR" rev-list --count "origin/$BRANCH..HEAD")"
        [ "$BEHIND" = 0 ] || die "GitHub has $BEHIND commit(s) the public clone doesn't - nothing should be committed there directly; pull them (git -C \"$PUBLIC_DIR\" pull) and move any change into this repository"
        # (unpushed commits are checked below, once it is known whether this run resumes)
    fi
    # the release workflow is exported from this repository's .github/ (export-source.sh); a clone without it has
    # never had an export, and a tag there would build nothing
    [ -f "$PUBLIC_DIR/.github/workflows/release.yml" ] || [ -f "$REPO/.github/workflows/release.yml" ] || die "no release workflow: neither $PUBLIC_DIR/.github/workflows/release.yml nor $REPO/.github/workflows/release.yml exists - a tag without it builds nothing"
    # the signed commit and tag need the clone's SSH signing set-up; found out now, before anything is tagged here
    "$REPO/scripts/release-sign.sh" --check "$PUBLIC_DIR" || die "set the public clone up for SSH signing first (see above)"
    log_info "public clone $PUBLIC_DIR ($ORIGIN, $BRANCH)"
fi
if $DEPLOY; then log_info "home server $DEPLOY_TARGET"; fi

# Resume: only on request (--resume). The current version tagged here but
# absent on GitHub is otherwise reported, never republished silently.
RESUME=false
UNPUBLISHED=false
if ! $SKIP_PUBLIC && git -C "$REPO" rev-parse -q --verify "refs/tags/v$CURRENT" >/dev/null \
   && [ "$(remote_tag_state "v$CURRENT")" = absent ]; then
    UNPUBLISHED=true
fi
if $RESUME_ARG; then
    git -C "$REPO" rev-parse -q --verify "refs/tags/v$CURRENT" >/dev/null || die "--resume: v$CURRENT is not tagged here"
    $UNPUBLISHED || die "--resume: v$CURRENT is already on GitHub - nothing to resume"
    RESUME=true
    VERSION="$CURRENT"
    log_info "resuming: export and publish the existing v$CURRENT (no new release)"
else
    if $UNPUBLISHED && [ -z "$VERSION_ARG" ]; then
        die "v$CURRENT is tagged here but not on GitHub. Choose: 'scripts/publish-release.sh --resume' publishes v$CURRENT, or 'scripts/publish-release.sh $(node -e "console.log(require(process.argv[1]).nextVersion(process.argv[2], null))" "$REPO/scripts/release.cjs" "$CURRENT" 2>/dev/null || echo X.Y.Z)' releases the next version (v$CURRENT then stays unpublished)"
    fi
    $UNPUBLISHED && log_warning "v$CURRENT is tagged here but not on GitHub; releasing $VERSION_ARG anyway (v$CURRENT stays unpublished)"
    VERSION="$(node -e "const r=require(process.argv[1]); console.log(r.nextVersion(process.argv[2], process.argv[3] || null, process.argv[4]))" \
        "$REPO/scripts/release.cjs" "$CURRENT" "$VERSION_ARG" "$BUMP" 2>"$TMP/version.err")" || die "$(sed -n 's/^Error: //p' "$TMP/version.err" | head -1 | grep . || head -1 "$TMP/version.err")"
fi
TAG="v$VERSION"

# Uncommitted changes in the public clone: only a resumed release's own,
# not yet committed export may be there (it is exported again anyway)
if $PUBLIC_DIRTY; then
    $RESUME || die "the public clone $PUBLIC_DIR has uncommitted changes - commit or discard them first"
    log_info "the public clone holds an uncommitted export - it is refreshed from $TAG"
fi

# Unpushed commits in the public clone: only this release's own "Jacarium X"
# commit from a stopped run may be there, and only when resuming it
if ! $SKIP_PUBLIC && [ "$AHEAD" != 0 ]; then
    LAST_SUBJECT="$(git -C "$PUBLIC_DIR" log -1 --format=%s)"
    if ! $RESUME || [ "$AHEAD" != 1 ] || [ "$LAST_SUBJECT" != "Jacarium $VERSION" ]; then
        die "the public clone has $AHEAD unpushed commit(s) (last: \"$LAST_SUBJECT\") - push or drop them first"
    fi
    log_info "the public clone holds this release's unpushed commit \"Jacarium $VERSION\" - it will be pushed"
fi

if ! $RESUME; then
    git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG already exists in this repository"
    if ! $SKIP_PUBLIC && [ "$(remote_tag_state "$TAG")" = present ]; then die "$TAG already exists on GitHub - pick another version"; fi
    # The notes the release would write (stdout) and its commit list (stderr)
    release_args=(); [ -n "$VERSION_ARG" ] && release_args+=("$VERSION_ARG"); [ "$BUMP" = patch ] || release_args+=("--$BUMP")
    node "$REPO/scripts/release.cjs" "${release_args[@]+"${release_args[@]}"}" --dry-run >"$TMP/notes.js" 2>"$TMP/plan.txt" \
        || { cat "$TMP/plan.txt"; die "the release command refused (see above)"; }
    { grep -vE '^[[:space:]]*$' "$TMP/plan.txt" || true; } | sed -n '1,40p'
fi

echo
if $RESUME; then
    log_info "plan: publish the existing $TAG"
else
    log_info "plan: release $CURRENT -> $VERSION ($TAG)"
    echo "  2. release here (notes, version bump, commit + tag $TAG)"
fi
$DEPLOY && echo "  3. deploy to $DEPLOY_TARGET" || echo "  3. deploy: not requested (--deploy)"
$SKIP_PUBLIC && echo "  4-5. public: skipped (--skip-public)" || echo "  4. export $TAG to $PUBLIC_DIR   5. commit, push to $BRANCH, tag $TAG, push the tag"
if $DRY_RUN; then
    if ! $RESUME; then
        echo; log_info "the release notes it would write (src/whats-new/versions/$TAG.js):"
        sed -n '1,80p' "$TMP/notes.js"
    fi
    log_info "dry run - nothing changed"; exit 0
fi

if ! $SKIP_CHECKS && ! $RESUME; then
    log_info "lint"
    if ! npm --prefix "$REPO" run --silent lint >"$TMP/lint.txt" 2>&1; then
        tail -20 "$TMP/lint.txt" || true
        die "lint failed"
    fi
    log_info "privacy scan"
    "$REPO/scripts/privacy-scan.sh" >"$TMP/privacy.txt" 2>&1 || { cat "$TMP/privacy.txt"; die "the privacy scan found something (or could not run) - fix it before releasing"; }
fi

# --- 2. release ------------------------------------------------------------------
if ! $RESUME; then
    confirm "Release $VERSION now?" || { log_info "nothing changed"; exit 0; }
    step "2. release $VERSION"
    undo_hint() {
        log_warning "to undo the prepared release: git -C \"$REPO\" checkout -- . && rm -f \"$REPO/src/whats-new/versions/$TAG.js\""
    }
    if $YES; then
        node "$REPO/scripts/release.cjs" "${release_args[@]+"${release_args[@]}"}" --yes || { undo_hint; die "the release command failed"; }
    else
        # prepare, let the notes be reviewed, then tag
        if ! echo n | node "$REPO/scripts/release.cjs" "${release_args[@]+"${release_args[@]}"}" >/dev/null 2>"$TMP/prepare.txt"; then
            grep -v 'now? \[y/N\]' "$TMP/prepare.txt" || true; undo_hint; die "preparing the release failed"
        fi
        log_info "prepared: review or edit src/whats-new/versions/$TAG.js (and CHANGELOG.md, changelog.json to match)"
        if ! confirm "Tag $TAG with these notes?"; then
            log_info "not tagged. To finish later: edit the notes, then 'npm run release:tag', then 'scripts/publish-release.sh --resume'"
            undo_hint; exit 0
        fi
        node "$REPO/scripts/release.cjs" tag --yes || { undo_hint; die "tagging failed"; }
    fi
    git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "the release command did not create $TAG"
    [ "$(node -p "require('$REPO/package.json').version")" = "$VERSION" ] || die "package.json is not at $VERSION after the release"
    log_success "released $TAG here"
fi

# --- 3. deploy ---------------------------------------------------------------------
if $DEPLOY; then
    step "3. deploy $TAG to $DEPLOY_TARGET"
    if [ "$(git -C "$REPO" rev-parse HEAD)" != "$(git -C "$REPO" rev-parse "$TAG^{commit}")" ]; then
        log_warning "this repository is past $TAG - the deploy builds the current working tree, not exactly $TAG"
    fi
    if confirm "Deploy to $DEPLOY_TARGET?"; then
        if ! "$REPO/deploy/deploy-to-host.sh" "$DEPLOY_TARGET" --yes; then
            $SKIP_PUBLIC || remaining_publish
            die "the deploy failed (run deploy/deploy-to-host.sh $DEPLOY_TARGET again when fixed)"
        fi
        log_success "deployed"
    else
        log_info "deploy skipped"
    fi
fi

# --- 4. export, 5. publish --------------------------------------------------------
if ! $SKIP_PUBLIC; then
    step "4. export $TAG to $PUBLIC_DIR"
    confirm "Export $TAG to the public clone?" || { remaining_publish; exit 0; }
    "$REPO/scripts/export-source.sh" "$PUBLIC_DIR" --ref "$TAG" --yes || { remaining_publish; exit 1; }
    EXPORTED="$(node -p "require('$PUBLIC_DIR/package.json').version" 2>/dev/null || echo '?')"
    [ "$EXPORTED" = "$VERSION" ] || { remaining_publish; die "the public clone's package.json says $EXPORTED after the export, not $VERSION"; }

    step "5. publish: signed commit and tag $TAG, push"
    if [ -z "$(git -C "$PUBLIC_DIR" status --porcelain)" ]; then
        log_warning "the export changed nothing in the public clone (it already holds $TAG's files)"
    else
        git -C "$PUBLIC_DIR" status --short | sed -n '1,30p'
    fi
    confirm "Sign and commit, tag $TAG, and push both to GitHub (this starts the release workflow)?" || { remaining_publish; exit 0; }
    # the signed commit and the signed tag, each verified against the exported .github/allowed_signers; nothing
    # is pushed unless both verify (scripts/release-sign.sh says what failed and how to fix it)
    "$REPO/scripts/release-sign.sh" "$PUBLIC_DIR" "$VERSION" || { remaining_publish; die "the signed commit / tag did not go through - nothing was pushed"; }
    git -C "$PUBLIC_DIR" push -q origin "$BRANCH" || { remaining_publish; die "the push to $BRANCH was rejected - nothing was tagged on GitHub"; }
    git -C "$PUBLIC_DIR" push -q origin "$TAG" || { remaining_publish; die "pushing the tag failed"; }
    log_success "pushed the signed $TAG - the release workflow is starting"
fi

echo
log_success "release $VERSION done"
if ! $SKIP_PUBLIC; then
    cat <<EOF
On GitHub:
  1. https://github.com/$GITHUB_REPO/actions - when "Publish the image to Quay" waits:
     Review deployments > quay > Approve and deploy
  2. https://github.com/$GITHUB_REPO/releases - check the draft "Jacarium $VERSION"
     (the installers, their SBOMs and SHA256SUMS.txt; the workflow verified every
     attestation before creating it), then Edit > Publish release
EOF
fi
