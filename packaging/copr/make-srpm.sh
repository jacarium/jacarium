#!/bin/bash
# Build the SRPM for COPR (packaging/copr/jacarium.spec) - what the COPR
# "make_srpm" source method runs through .copr/Makefile, and what a release
# can run by hand.
#
#   packaging/copr/make-srpm.sh [--outdir DIR] [--version X.Y.Z]
#
# The version is the git tag of the checkout COPR made (v3.2.9 -> 3.2.9;
# `git describe` of the exact commit), unless --version says otherwise or
# the checkout has no tag (then the spec's own fallback applies). The spec
# downloads the release assets itself at build time, so the SRPM holds the
# spec, the metainfo and the LICENSE and nothing else: this script must stay
# cheap and offline (COPR runs it in a minimal container before the real
# build).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUTDIR="$PWD"
VERSION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --outdir) OUTDIR="$2"; shift ;;
        --version) VERSION="$2"; shift ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
mkdir -p "$OUTDIR"

if [ -z "$VERSION" ]; then
    # the tag on this exact commit (COPR checks out the committish the build names)
    tag="$(git -C "$REPO" describe --tags --exact-match 2>/dev/null || true)"
    if [ -z "$tag" ]; then
        # not on a tag: the newest tag reachable (a rebuild of the last release)
        tag="$(git -C "$REPO" describe --tags --abbrev=0 2>/dev/null || true)"
    fi
    VERSION="${tag#v}"
fi
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "no release tag on this checkout (got '$VERSION'); the spec's fallback version will be used" >&2; VERSION="" ;;
esac

TOPDIR="$(mktemp -d)"
trap 'rm -rf "$TOPDIR"' EXIT
mkdir -p "$TOPDIR/SOURCES" "$TOPDIR/SRPMS" "$TOPDIR/SPECS"
cp "$REPO/com.jacarium.app.metainfo.xml" "$REPO/LICENSE" "$TOPDIR/SOURCES/"
if [ -n "$VERSION" ]; then
    # the version baked into the spec, so the SRPM says what it builds
    sed "s/^%{!?jacarium_version: %global jacarium_version .*}$/%{!?jacarium_version: %global jacarium_version $VERSION}/" "$HERE/jacarium.spec" > "$TOPDIR/SPECS/jacarium.spec"
else
    cp "$HERE/jacarium.spec" "$TOPDIR/SPECS/jacarium.spec"
fi
# The release assets are fetched by the real build's %prep (COPR allows
# network), so the SRPM holds the spec and the metainfo only.
rpmbuild --define "_topdir $TOPDIR" --define "_sourcedir $TOPDIR/SOURCES" --define "_srcrpmdir $OUTDIR" -bs "$TOPDIR/SPECS/jacarium.spec"
ls -1 "$OUTDIR"/jacarium-*.src.rpm
