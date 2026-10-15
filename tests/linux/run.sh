#!/bin/bash

# tests/linux/run.sh - reproduce and check Linux-only behaviour in a container.
#
# Runs arbitrary commands, single test files and Linux-Chromium screenshots of
# the app inside the SAME image rebuild.sh uses (root Containerfile: Node 24 +
# Debian chromium), so nothing new has to be built if you already build Linux
# packages. The repo is mounted at /build; node_modules come from container-
# private named volumes (Linux binaries for esbuild/sqlite/...), never from the
# host's macOS node_modules. After the first `deps` run everything works
# offline (Chromium, fonts and node_modules all live in the image/volumes).
#
# Usage: tests/linux/run.sh [--rebuild-image] [--no-deps] <command> [args...]
#
#   deps                     install/refresh the container node_modules
#                            (root + jacarium-central + jsdom/fake-indexeddb;
#                            needs network the first time, then cached)
#   shell                    interactive bash in the container (cwd = repo)
#   exec <cmd...>            run any command in the container, e.g.
#                            tests/linux/run.sh exec npx eslint src/components
#   test <tests/file>        run one test file (.mjs -> node, .py -> python3)
#   screenshot [options]     screenshot/measure the app in Linux Chromium
#                            (options: tests/linux/run.sh screenshot --help)
#   example <name> [opts]    run tests/linux/examples/<name>.mjs
#
# Outputs land in tests/linux/out/ (git-ignored). Container runtime detection
# matches rebuild.sh: podman first, docker as fallback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="jacarium-builder"          # shared with rebuild.sh
NM_VOLUME="jacarium-linux-node_modules"
CENTRAL_NM_VOLUME="jacarium-linux-central-node_modules"
OUT_DIR="$SCRIPT_DIR/out"

detect_container_runtime() {
    if command -v podman &> /dev/null; then
        echo "podman"
    elif command -v docker &> /dev/null; then
        echo "docker"
    else
        echo ""
    fi
}
CONTAINER_RUNTIME=$(detect_container_runtime)

usage() {
    sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

FORCE_REBUILD=false
SKIP_DEPS=false
while [ $# -gt 0 ]; do
    case "$1" in
        --rebuild-image) FORCE_REBUILD=true; shift ;;
        --no-deps) SKIP_DEPS=true; shift ;;
        -h|--help) usage 0 ;;
        *) break ;;
    esac
done
[ $# -gt 0 ] || usage 1
COMMAND="$1"; shift

if [ -z "$CONTAINER_RUNTIME" ]; then
    echo "ERROR: no container runtime found - install podman (or docker)." >&2
    exit 1
fi
if [ "$CONTAINER_RUNTIME" = "podman" ] && ! podman info >/dev/null 2>&1; then
    echo "ERROR: podman cannot reach its VM/daemon. On macOS: podman machine start" >&2
    exit 1
fi

ensure_image() {
    # Same tag + Containerfile-hash label as rebuild.sh so both share one image.
    local hash existing
    hash=$(shasum -a 256 "$REPO_ROOT/Containerfile" 2>/dev/null | cut -d' ' -f1 || sha256sum "$REPO_ROOT/Containerfile" | cut -d' ' -f1)
    if [ "$FORCE_REBUILD" = true ]; then
        $CONTAINER_RUNTIME rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
    fi
    if $CONTAINER_RUNTIME image exists "$IMAGE_NAME" 2>/dev/null || $CONTAINER_RUNTIME image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        existing=$($CONTAINER_RUNTIME inspect "$IMAGE_NAME" --format '{{index .Config.Labels "containerfile.hash"}}' 2>/dev/null || echo "")
        if [ "$existing" = "$hash" ]; then
            return 0
        fi
        echo "==> Containerfile changed - rebuilding image $IMAGE_NAME"
        $CONTAINER_RUNTIME rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
    else
        echo "==> Building image $IMAGE_NAME from Containerfile (one-time, needs network)"
    fi
    (cd "$REPO_ROOT" && $CONTAINER_RUNTIME build -t "$IMAGE_NAME" --label "containerfile.hash=$hash" -f Containerfile .)
    # Remove a superseded, untagged builder image (by the project label only)
    CONTAINER_RUNTIME="$CONTAINER_RUNTIME" bash "$REPO_ROOT/deploy/prune-images.sh" --component builder
}

run_in_container() {
    # Allocate a TTY only when we have one (interactive shell); the
    # ${arr[@]+"${arr[@]}"} form keeps `set -u` happy on bash 3.2 (macOS).
    local tty=()
    [ -t 0 ] && [ -t 1 ] && tty=(-it)
    mkdir -p "$OUT_DIR"
    $CONTAINER_RUNTIME run --rm ${tty[@]+"${tty[@]}"} \
        -v "$REPO_ROOT:/build:Z" \
        -v "$NM_VOLUME:/build/node_modules" \
        -v "$CENTRAL_NM_VOLUME:/build/jacarium-central/node_modules" \
        -w /build \
        --shm-size=1g \
        -e LINUX_CONTAINER=1 \
        -e CHROME_BIN=/usr/bin/chromium \
        -e LINUX_OUT=/build/tests/linux/out \
        -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
        "$IMAGE_NAME" "$@"
}

ensure_deps() {
    # Install into the named volumes only when package-lock.json changed since
    # the last install (stamp file inside the volume). `npm install` rather
    # than `npm ci`: ci deletes node_modules/, which is a mount point here.
    run_in_container bash -c '
        set -e
        want=$(sha256sum package-lock.json | cut -d" " -f1)
        if [ ! -f node_modules/.linux-deps-stamp ] || [ "$(cat node_modules/.linux-deps-stamp)" != "$want" ]; then
            echo "==> Installing container node_modules (root)"
            npm install --no-audit --no-fund
            echo "==> Installing test-only deps (jsdom, fake-indexeddb; --no-save)"
            npm install --no-save --no-audit --no-fund jsdom fake-indexeddb
            echo "$want" > node_modules/.linux-deps-stamp
        fi
        cwant=$(sha256sum jacarium-central/package-lock.json | cut -d" " -f1)
        if [ ! -f jacarium-central/node_modules/.linux-deps-stamp ] || [ "$(cat jacarium-central/node_modules/.linux-deps-stamp)" != "$cwant" ]; then
            echo "==> Installing container node_modules (jacarium-central)"
            (cd jacarium-central && npm install --no-audit --no-fund)
            echo "$cwant" > jacarium-central/node_modules/.linux-deps-stamp
        fi
    '
}

ensure_image
case "$COMMAND" in
    deps)
        ensure_deps ;;
    shell)
        [ "$SKIP_DEPS" = true ] || ensure_deps
        run_in_container bash ;;
    exec)
        [ "$SKIP_DEPS" = true ] || ensure_deps
        run_in_container "$@" ;;
    test)
        [ $# -ge 1 ] || { echo "usage: $0 test <tests/file>" >&2; exit 1; }
        [ "$SKIP_DEPS" = true ] || ensure_deps
        FILE="${1#"$REPO_ROOT"/}"; shift
        case "$FILE" in
            *.py) run_in_container python3 "$FILE" "$@" ;;
            *) run_in_container node "$FILE" "$@" ;;
        esac ;;
    screenshot)
        [ "$SKIP_DEPS" = true ] || ensure_deps
        run_in_container node tests/linux/screenshot.mjs "$@" ;;
    example)
        [ $# -ge 1 ] || { echo "usage: $0 example <name> [options]   (see tests/linux/examples/)" >&2; exit 1; }
        NAME="$1"; shift
        [ -f "$SCRIPT_DIR/examples/$NAME.mjs" ] || { echo "no such example: tests/linux/examples/$NAME.mjs" >&2; exit 1; }
        [ "$SKIP_DEPS" = true ] || ensure_deps
        run_in_container node "tests/linux/examples/$NAME.mjs" "$@" ;;
    *)
        echo "unknown command: $COMMAND" >&2
        usage 1 ;;
esac
