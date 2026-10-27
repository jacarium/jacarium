#!/bin/bash
# Export the source for publishing: mirror a committed version of this
# repository into another directory - typically a clone of the public
# GitHub repository - adding new files, updating changed ones and deleting
# the ones that are gone. You then review, commit and push from there.
#
#   scripts/export-source.sh <dest>                 the current commit (HEAD)
#   scripts/export-source.sh <dest> --ref v3.1.7    a release tag (or any commit)
#   scripts/export-source.sh <dest> --dry-run       show what would change, change nothing
#
# Options:
#   --ref <ref>           what to export (default HEAD). Only committed files:
#                         uncommitted changes are never exported
#   --dry-run             print the summary and stop
#   --yes                 no confirmation prompt
#   --skip-privacy-scan   do not run scripts/privacy-scan.sh first (on purpose only)
#   --force               allow a git repository whose origin is not a jacarium
#                         repository, and --yes with a large deletion (on purpose only)
#   -h, --help            this text
#   --                    end of options (a destination starting with "-")
#
# What is exported: the files git tracks at <ref> (`git archive`), so
# node_modules, builds and everything .gitignore'd never leave. Dot-files
# and dot-directories are left out - except the ones building Jacarium
# needs (EXPORTED_DOTFILES below: the .gitignore files, .nvmrc, the .npmrc
# supply-chain settings, the container build's ignore files, COPR's
# .copr/Makefile), which are exported like any other file, and the whole
# of .github/ (EXPORTED_DOTDIRS: the release workflows, the pinned tools,
# the allowed signing keys, CODEOWNERS), which is mirrored - a file gone
# from .github/ here is deleted there too, so no stale workflow keeps
# running in the public repository. Every other dot-path in <dest> is never
# touched or deleted - its .git stays as it is.
#
# Files the destination's own .gitignore ignores (node_modules after an
# `npm install` there, a build) are never deleted: they cannot be committed
# there anyway.
#
# Safety: <dest> must not exist yet, be empty, or be a git repository (a
# clone) - so once it holds an export, make it a git repository (git init,
# or clone the public repository first). A git repository whose origin is
# not a jacarium repository is refused (--force), as is --yes when more
# than half of the files would be deleted. <dest> may not be this
# repository, inside it, or contain it. The privacy scan runs over <ref>
# first and stops the export on any finding. There is no rollback: an
# interrupted run (full disk) is completed by running it again.
set -euo pipefail

# The dot-files a build from the published source needs (the release
# workflow reads .nvmrc; deploy/Containerfile copies .npmrc and its build
# context honours .containerignore / .dockerignore; COPR runs .copr/Makefile
# to make the SRPM from packaging/copr), and the dot-directories mirrored
# whole (.github/: the workflows GitHub runs for the public repository);
# every other dot-path (.claude/, editor settings) stays out
EXPORTED_DOTFILES=(.gitignore .nvmrc .npmrc .containerignore .dockerignore
    backend/.gitignore jacarium-central/.gitignore jacarium-central/.npmrc
    .copr/Makefile)
EXPORTED_DOTDIRS=(.github)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

# The header comment above, up to the first line that is not a comment
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

DEST=""
REF="HEAD"
DRY_RUN=false
YES=false
PRIVACY_SCAN=true
FORCE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --ref) REF="${2:-}"; [ -n "$REF" ] || die "--ref needs a value"; shift ;;
        --dry-run) DRY_RUN=true ;;
        --yes|-y) YES=true ;;
        --skip-privacy-scan) PRIVACY_SCAN=false ;;
        --force) FORCE=true ;;
        -h|--help) usage; exit 0 ;;
        --) shift; [ $# -le 1 ] || die "only one destination after --"; [ $# -eq 0 ] || { [ -z "$DEST" ] || die "only one destination"; DEST="$1"; }; break ;;
        -*) usage; die "unknown option: $1" ;;
        *) [ -z "$DEST" ] || die "only one destination, got '$DEST' and '$1'"; DEST="$1" ;;
    esac
    shift
done
[ -n "$DEST" ] || { usage; die "no destination given"; }

# --- what to export --------------------------------------------------------
COMMIT="$(git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}")" || die "no such commit or tag: $REF"
LABEL="$(git -C "$REPO" describe --tags --always "$COMMIT")"
if [ "$COMMIT" = "$(git -C "$REPO" rev-parse HEAD)" ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    log_warning "the working tree has uncommitted changes - they are NOT exported (only the commit $LABEL is)"
fi

# --- where to: refuse anything that is not clearly an export target ---------
# Resolve the path without creating anything: a refused or dry-run
# destination is never made (its parent must exist)
if [ -L "$DEST" ] && [ ! -d "$DEST" ]; then
    die "$DEST is a symlink to something that is not a directory"
elif [ -d "$DEST" ]; then
    DEST="$(cd "$DEST" && pwd -P)"
else
    [ ! -e "$DEST" ] || die "$DEST exists and is not a directory"
    PARENT="$(dirname -- "$DEST")"
    [ -d "$PARENT" ] || die "the parent directory of $DEST does not exist"
    DEST="$(cd "$PARENT" && pwd -P)/$(basename -- "$DEST")"
fi
REPO_REAL="$(cd "$REPO" && pwd -P)"
case "$DEST" in
    /|"$HOME"|"$HOME/") die "refusing to mirror into $DEST" ;;
esac
case "$DEST/" in "$REPO_REAL/"*) die "the destination is this repository or inside it: $DEST" ;; esac
case "$REPO_REAL/" in "$DEST/"*) die "the destination contains this repository: $DEST" ;; esac
IS_GIT=false
[ -e "$DEST/.git" ] && IS_GIT=true   # a directory, or a file (a worktree / submodule)
if [ -d "$DEST" ] && ! $IS_GIT && [ -n "$(ls -A "$DEST")" ]; then
    die "$DEST is not empty and not a git repository - clone the public repository there first (git clone <url> $DEST)"
fi
if $IS_GIT; then
    ORIGIN="$(git -C "$DEST" remote get-url origin 2>/dev/null || true)"
    if [ -n "$ORIGIN" ] && ! printf '%s' "$ORIGIN" | grep -qi 'jacarium'; then
        $FORCE || die "$DEST is a clone of $ORIGIN, not of a jacarium repository - wrong folder? (--force if it is right)"
    fi
fi

# --- privacy scan over exactly what would be published ----------------------
if $PRIVACY_SCAN; then
    log_info "privacy scan of $LABEL..."
    scan=0; "$SCRIPT_DIR/privacy-scan.sh" --ref "$COMMIT" || scan=$?
    case "$scan" in
        0) ;;
        1) die "the privacy scan found something - fix it first (or pass --skip-privacy-scan on purpose)" ;;
        *) die "the privacy scan could not run (exit $scan) - see above" ;;
    esac
fi
# the maintainer's local publish hook over the same commit, when there is one
if [ -x "$REPO/.publish-hooks/check-tree" ]; then
    "$REPO/.publish-hooks/check-tree" "$REPO" "$COMMIT" || die "a local publish hook refused $LABEL (see above)"
fi

# --- stage <ref> without dot-files ------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/jacarium-export.XXXXXX")"
trap 'rm -rf "$STAGE" "$STAGE.keep"' EXIT
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$STAGE"
KEEP="$STAGE.keep"; mkdir -p "$KEEP"
for f in "${EXPORTED_DOTFILES[@]}"; do
    [ -f "$STAGE/$f" ] || continue
    mkdir -p "$KEEP/$(dirname "$f")" && cp -p "$STAGE/$f" "$KEEP/$f"
done
# the mirrored dot-directories, whole (every tracked file under them)
for d in "${EXPORTED_DOTDIRS[@]}"; do
    [ -d "$STAGE/$d" ] || continue
    (cd "$STAGE" && find "$d" -type f -print) | while IFS= read -r f; do mkdir -p "$KEEP/$(dirname "$f")" && cp -p "$STAGE/$f" "$KEEP/$f"; done
done
# (the pruned paths minus the exported dot-files and their dot-directories:
# .copr is pruned as a directory and comes back with its Makefile)
SKIPPED_DOT="$(cd "$STAGE" && find . -mindepth 1 -name '.*' -prune -print | sed 's|^\./||' | sort | { grep -vxF -f <(printf '%s\n' "${EXPORTED_DOTFILES[@]}" "${EXPORTED_DOTFILES[@]%/*}" "${EXPORTED_DOTDIRS[@]}") || true; })"
(cd "$STAGE" && find . -mindepth 1 -name '.*' -prune -exec rm -rf {} +)
# (a kept file under a dot-directory, .copr/Makefile, needs its directory back)
(cd "$KEEP" && find . -type f -print) | while IFS= read -r f; do f="${f#./}"; mkdir -p "$STAGE/$(dirname "$f")"; cp -p "$KEEP/$f" "$STAGE/$f"; done

# Regular files and symlinks, relative paths, never under a dot-path - plus
# the exported dot-files that exist there and everything under the mirrored
# dot-directories (so a file gone from .github/ here is removed there)
list_files() {
    (
        cd "$1"
        find . -mindepth 1 -name '.*' -prune -o \( -type f -o -type l \) -print | sed 's|^\./||'
        for f in "${EXPORTED_DOTFILES[@]}"; do
            if [ -f "$f" ] || [ -L "$f" ]; then echo "$f"; fi
        done
        for d in "${EXPORTED_DOTDIRS[@]}"; do
            # (an if, not `[ -d ] &&`: in a destination without the directory yet - a fresh clone - the failing
            # test would be the subshell's last command and end the pipeline under set -e)
            if [ -d "$d" ]; then find "$d" -mindepth 1 \( -type f -o -type l \) -print; fi
        done
    ) | LC_ALL=C sort
}
list_files "$STAGE" > "$STAGE.src"
if [ -d "$DEST" ]; then list_files "$DEST" > "$STAGE.dst"; else : > "$STAGE.dst"; fi
trap 'rm -rf "$STAGE" "$STAGE.src" "$STAGE.dst" "$STAGE.keep"' EXIT

ADDED="$(LC_ALL=C comm -23 "$STAGE.src" "$STAGE.dst")"
REMOVED="$(LC_ALL=C comm -13 "$STAGE.src" "$STAGE.dst")"
# Never delete what the destination's own .gitignore ignores (node_modules, builds)
if $IS_GIT && [ -n "$REMOVED" ]; then
    IGNORED="$(printf '%s\n' "$REMOVED" | git -C "$DEST" check-ignore --stdin 2>/dev/null || true)"
    if [ -n "$IGNORED" ]; then
        REMOVED="$(printf '%s\n' "$REMOVED" | LC_ALL=C grep -vxF -f <(printf '%s\n' "$IGNORED") || true)"
    fi
fi
UPDATED=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -L "$STAGE/$f" ] || [ -L "$DEST/$f" ]; then
        [ "$(readlink "$STAGE/$f" 2>/dev/null)" = "$(readlink "$DEST/$f" 2>/dev/null)" ] && [ -L "$STAGE/$f" ] && [ -L "$DEST/$f" ] || UPDATED+="$f"$'\n'
    elif ! cmp -s "$STAGE/$f" "$DEST/$f" || { [ -x "$STAGE/$f" ] && [ ! -x "$DEST/$f" ]; } || { [ ! -x "$STAGE/$f" ] && [ -x "$DEST/$f" ]; }; then
        UPDATED+="$f"$'\n'
    fi
done < <(LC_ALL=C comm -12 "$STAGE.src" "$STAGE.dst")
UPDATED="${UPDATED%$'\n'}"

# Directories with nothing in them but other such directories (never a dot-directory or anything under one)
empty_dirs() { [ -d "$DEST" ] || return 0; find "$DEST" -mindepth 1 -name '.*' -prune -o -type d -empty -print; }

count() { [ -n "$1" ] && printf '%s\n' "$1" | wc -l | tr -d ' ' || echo 0; }
show() {  # <title> <list> - at most 30 lines, then "... and N more"
    [ -n "$2" ] || return 0
    local n; n="$(count "$2")"
    echo "$1 ($n):"
    printf '%s\n' "$2" | head -30 | sed 's/^/  /'
    [ "$n" -le 30 ] || echo "  ... and $((n - 30)) more"
}

echo
log_info "export $LABEL ($(count "$(cat "$STAGE.src")") files) -> $DEST"
show "Added" "$ADDED"
show "Updated" "$UPDATED"
show "Removed" "$REMOVED"
EMPTY="$(empty_dirs)"
show "Empty directories to remove" "$EMPTY"
[ -z "$SKIPPED_DOT" ] || echo "Dot-files left out: $(count "$SKIPPED_DOT") (${SKIPPED_DOT//$'\n'/ })"
if [ -z "$ADDED$UPDATED$REMOVED$EMPTY" ]; then
    log_success "$DEST already matches $LABEL - nothing to do"
    exit 0
fi
N_SRC="$(count "$(cat "$STAGE.src")")"
N_REMOVED="$(count "$REMOVED")"
if $YES && ! $FORCE && [ "$N_REMOVED" -gt 0 ] && [ $((N_REMOVED * 2)) -gt "$N_SRC" ]; then
    die "$N_REMOVED files would be deleted (more than half of the $N_SRC exported) - run without --yes to confirm, or pass --force"
fi
if $DRY_RUN; then
    log_info "dry run - nothing changed"
    exit 0
fi
if ! $YES; then
    printf 'Apply these changes to %s? [y/N] ' "$DEST"
    read -r answer || { answer=''; echo; }
    case "$answer" in y|Y|yes|YES) ;; *) log_info "nothing changed"; exit 0 ;; esac
fi

# --- apply -------------------------------------------------------------------
mkdir -p "$DEST"
while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f "$DEST/$f"
done <<< "$REMOVED"
while IFS= read -r f; do
    [ -n "$f" ] || continue
    mkdir -p "$(dirname "$DEST/$f")"
    # A path that was a directory and is now a file: the removals above
    # emptied it of everything exported, so only leftovers (dot-files,
    # empty subdirectories) go with it
    if [ -d "$DEST/$f" ] && [ ! -L "$DEST/$f" ]; then rm -rf "${DEST:?}/${f:?}"; else rm -f "$DEST/$f"; fi
    cp -pP "$STAGE/$f" "$DEST/$f"
done <<< "$(printf '%s\n%s' "$ADDED" "$UPDATED")"
# Directories left empty, bottom-up until none is left (a parent empties
# once its last subdirectory goes); never a dot-directory
while :; do
    EMPTY="$(empty_dirs)"
    [ -n "$EMPTY" ] || break
    printf '%s\n' "$EMPTY" | while IFS= read -r d; do rmdir "$d" 2>/dev/null || true; done
    [ "$EMPTY" != "$(empty_dirs)" ] || break
done

log_success "exported $LABEL to $DEST: $(count "$ADDED") added, $(count "$UPDATED") updated, $(count "$REMOVED") removed"
if [ -d "$DEST/.git" ]; then
    echo "Next: cd \"$DEST\" && git status, then commit and push when it looks right."
fi
