#!/bin/bash
# The signed release commit and tag in the public clone, verified before anything is pushed. Called by
# scripts/publish-release.sh (step 5) once the export is in the clone's working tree; usable by hand after a stop.
#
#   scripts/release-sign.sh <public clone> <version> [<allowed_signers>]
#   scripts/release-sign.sh --check <public clone>          only the signing configuration
#
# What it does, in the clone:
#   1. refuses unless the clone is set up for SSH signing: gpg.format = ssh and user.signingkey (the user
#      configures them there once - the instructions are printed); no unsigned fallback;
#   2. commits the exported tree as "Jacarium <version>" with `git commit -S` (when there is something to commit);
#   3. creates the annotated tag v<version> with `git tag -s` (an existing local tag on the same commit is kept,
#      on another commit it is an error);
#   4. verifies the commit it made and the tag with `git verify-commit` / `git verify-tag` against the
#      allowed_signers file (default: the clone's exported .github/allowed_signers), with
#      gpg.ssh.allowedSignersFile set for the command only - the user's global settings are not touched.
# Exit 0 only when every step passed; nothing here pushes.
set -euo pipefail

CHECK_ONLY=false
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=true; shift; fi
DIR="${1:?the public clone}"
VERSION="${2:-}"
SIGNERS="${3:-$DIR/.github/allowed_signers}"
$CHECK_ONLY || [ -n "$VERSION" ] || { echo "release-sign: a version is needed" >&2; exit 2; }
TAG="v$VERSION"

die() { echo "release-sign: $*" >&2; exit 1; }
g() { git -C "$DIR" "$@"; }

setup_hint() {
    cat >&2 <<EOF
release-sign: $DIR is not set up to sign with SSH. Once, in that clone (a dedicated signing key, its public half
in this repository's .github/allowed_signers under the principal jacarium-release):
    git -C "$DIR" config gpg.format ssh
    git -C "$DIR" config user.signingkey ~/.ssh/jacarium_signing.pub
    git -C "$DIR" config gpg.ssh.allowedSignersFile .github/allowed_signers     # for your own git verify-tag
Then run the release again. Nothing was committed or tagged.
EOF
}

format="$(g config --get gpg.format 2>/dev/null || true)"
key="$(g config --get user.signingkey 2>/dev/null || true)"
if [ "$format" != "ssh" ] || [ -z "$key" ]; then setup_hint; exit 3; fi
case "$key" in
    key::*) ;;   # a literal public key
    ~*|/*|./*|*/*) [ -f "${key/#\~/$HOME}" ] || { echo "release-sign: user.signingkey names $key, which does not exist" >&2; setup_hint; exit 3; } ;;
esac
$CHECK_ONLY && { echo "release-sign: $DIR signs with SSH ($key)"; exit 0; }
[ -f "$SIGNERS" ] || die "no allowed_signers file at $SIGNERS (the export writes .github/allowed_signers into the clone)"
grep -Eq '^[^#[:space:]]+[[:space:]]+ssh-' "$SIGNERS" || die "$SIGNERS holds no key line"

verify_commit() { g -c "gpg.ssh.allowedSignersFile=$SIGNERS" verify-commit "$1" >/dev/null 2>&1; }
verify_tag() { g -c "gpg.ssh.allowedSignersFile=$SIGNERS" verify-tag "$1" >/dev/null 2>&1; }

if [ -n "$(g status --porcelain)" ]; then
    g add -A
    g commit -q -S -m "Jacarium $VERSION" || die "the signed commit failed (is the key loaded / unlocked?)"
    verify_commit HEAD || die "the release commit's signature does not verify against $SIGNERS - is the signing key's public half in it, under a principal?"
    echo "release-sign: committed and verified $(g rev-parse --short HEAD) (Jacarium $VERSION)"
else
    echo "release-sign: nothing to commit (the clone already holds the export)"
fi
if g rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$(g rev-parse "$TAG^{commit}")" = "$(g rev-parse HEAD)" ] \
        || die "the clone already has a local tag $TAG on another commit - delete it (git -C \"$DIR\" tag -d $TAG) and run again"
    verify_tag "$TAG" || die "the existing local tag $TAG is not signed by a key in $SIGNERS - delete it (git -C \"$DIR\" tag -d $TAG) and run again"
    echo "release-sign: the signed tag $TAG exists on HEAD"
else
    g tag -s "$TAG" -m "Jacarium $VERSION" || die "the signed tag failed (is the key loaded / unlocked?)"
    verify_tag "$TAG" || die "the tag's signature does not verify against $SIGNERS"
    echo "release-sign: tagged and verified $TAG"
fi
