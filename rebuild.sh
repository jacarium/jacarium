#!/bin/bash
# Jacarium - build the desktop app (backend + UI + Electron packages).
#
#   ./rebuild.sh                       Linux AppImage, built in a container (podman or docker)
#   ./rebuild.sh --format deb          another package format
#   ./rebuild.sh --no-container --platform mac   macOS dmg, built on this Mac (--format zip, "dmg zip" or all for more)
#   ./rebuild.sh --testing             a TESTING build (see below)
#
# Options:
#   -p, --platform PLATFORM   linux (default), mac, windows, all
#   -f, --format FORMAT       the package format(s) for the platform; without it the
#                             platform's default is built:
#                               Linux:   AppImage (default), deb, rpm, tar.gz, dir
#                               macOS:   dmg (default), zip, pkg, mas, dir
#                               Windows: nsis (default), portable, msi, zip, dir
#                             'all' builds every format of the platform; a format that
#                             the platform has no target for is refused before the build
#   --print-targets           print the electron-builder target arguments and exit
#                             (what the options above resolve to; nothing is built)
#   --no-container            build directly on this host (Node.js per .nvmrc, Python 3.14
#                             with venv - requirements.lock is resolved for 3.14 - and
#                             what electron-builder needs for the target)
#   --rebuild-container       force a rebuild of the builder image (root Containerfile)
#   --testing                 testing build: unminified UI with source maps, DevTools open,
#                             the MACHINE_ID environment variable is honoured (several
#                             identities on one machine, see ./run.sh --help). Never ship
#                             it. build-mode.cjs is restored to production afterwards.
#   -h, --help                this text
#
# The container build uses the image jacarium-builder (built from the
# root Containerfile when missing or changed; tests/linux/run.sh shares it) and
# produces Linux packages; macOS and Windows packages are built on their own
# platform with --no-container. Output: dist-electron/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/scripts/lib.sh"

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }

PLATFORM="linux"
FORMAT=""               # empty = the platform's default (see default_format)
PRINT_TARGETS=false
USE_CONTAINER=true
FORCE_REBUILD_CONTAINER=false
TESTING=false
IN_CONTAINER=false      # set by the container run below: this script, inside the builder image
IMAGE_NAME="jacarium-builder"

while [ $# -gt 0 ]; do
    case "$1" in
        -p|--platform) PLATFORM="${2:-}"; shift ;;
        -f|--format) FORMAT="${2:-}"; shift ;;
        --print-targets) PRINT_TARGETS=true ;;
        --no-container) USE_CONTAINER=false ;;
        --rebuild-container) FORCE_REBUILD_CONTAINER=true ;;
        --testing) TESTING=true ;;
        --in-container) IN_CONTAINER=true; USE_CONTAINER=false ;;
        -h|--help) usage; exit 0 ;;
        *) log_error "unknown option: $1"; echo "Use --help for usage information"; exit 1 ;;
    esac
    shift
done
case "$PLATFORM" in
    linux|mac|windows|all) ;;
    *) die "invalid platform '$PLATFORM' - must be linux, mac, windows or all" ;;
esac
# The package formats electron-builder knows per platform, and each platform's
# default when --format is not given (several formats may be listed, space
# separated, e.g. --format "dmg zip").
formats_for() {
    case "$1" in
        linux) echo "AppImage deb rpm tar.gz dir" ;;
        mac) echo "dmg zip pkg mas dir" ;;
        windows) echo "nsis portable msi zip dir" ;;
    esac
}
default_format() {
    case "$1" in
        linux) echo "AppImage" ;;
        mac) echo "dmg" ;;
        windows) echo "nsis" ;;
    esac
}
validate_format() {   # $1 platform, $2 format list - every entry must be a target of the platform
    local f known
    known=" $(formats_for "$1") "
    for f in $2; do
        case "$known" in *" $f "*) ;; *) die "--format $f: not a $1 package format (choose from:$known'all' for every one)" ;; esac
    done
}
if [ "$PLATFORM" = all ]; then
    case "$FORMAT" in ""|all) ;; *) die "--platform all takes no --format other than 'all' (each platform builds its default: AppImage, dmg, nsis)" ;; esac
else
    if [ -z "$FORMAT" ]; then FORMAT="$(default_format "$PLATFORM")"; fi
    [ "$FORMAT" = all ] || validate_format "$PLATFORM" "$FORMAT"
fi

CONTAINER_RUNTIME="$(detect_container_runtime)"
BUILD_MODE_LABEL=PRODUCTION; [ "$TESTING" = true ] && BUILD_MODE_LABEL=TESTING
UI_BUILD_ARGS=(); [ "$TESTING" = true ] && UI_BUILD_ARGS=(--testing)

echo "========================================="
echo "Jacarium - Complete Rebuild"
echo "BUILD MODE: $BUILD_MODE_LABEL"
echo "Platform: $PLATFORM"
echo "Format: $FORMAT"
if [ "$IN_CONTAINER" = true ]; then
    echo "Container: inside $IMAGE_NAME"
else
    echo "Container: $USE_CONTAINER"
    [ "$USE_CONTAINER" = true ] && echo "Runtime: ${CONTAINER_RUNTIME:-none}"
fi
echo "========================================="
echo ""

# A testing build rewrites the tracked build-mode.cjs; put it back whatever
# happens, once packaging is over (electron-builder reads it before that).
restore_build_mode() {
    [ "$TESTING" = true ] || return 0
    bash scripts/build-ui.sh --reset >/dev/null 2>&1 || true
}
trap restore_build_mode EXIT

# electron-builder targets for the platform / format (the container builds
# Linux reliably; macOS code signing / DMG and Windows MSI need their own OS)
electron_targets() {
    case "$PLATFORM" in
        linux)
            if [ "$FORMAT" = all ]; then echo "--linux AppImage deb rpm tar.gz"; else echo "--linux $FORMAT"; fi ;;
        mac)
            if [ "$FORMAT" = all ]; then
                if [ "$IN_CONTAINER" = true ]; then echo "--mac zip"; else echo "--mac dmg zip"; fi
            else echo "--mac $FORMAT"; fi ;;
        windows)
            if [ "$FORMAT" = all ]; then
                if [ "$IN_CONTAINER" = true ]; then echo "--win nsis portable zip"; else echo "--win nsis portable msi zip"; fi
            else echo "--win $FORMAT"; fi ;;
        all)
            if [ "$IN_CONTAINER" = true ]; then echo "--linux AppImage deb rpm tar.gz"
            elif [ "$FORMAT" = all ]; then echo "--linux AppImage deb rpm tar.gz --mac dmg zip --win nsis portable msi zip"
            else echo "--linux AppImage --mac dmg --win nsis"; fi ;;
    esac
}
if [ "$PRINT_TARGETS" = true ]; then
    electron_targets
    trap - EXIT
    exit 0
fi

# ---------------------------------------------------------------------------
# container build: the builder image runs this very script with --in-container
# ---------------------------------------------------------------------------
build_in_container() {
    if [ -z "$CONTAINER_RUNTIME" ]; then
        log_error "no container runtime found"
        echo "Install podman: sudo dnf install podman   (or docker: https://docs.docker.com/engine/install/)"
        echo "Alternatively, use --no-container to build on this host"
        exit 1
    fi
    local hash existing rebuild=false
    hash="$(shasum -a 256 Containerfile 2>/dev/null | cut -d' ' -f1 || sha256sum Containerfile | cut -d' ' -f1)"
    if [ "$FORCE_REBUILD_CONTAINER" = true ]; then
        log_info "force rebuild requested - removing the old image"
        "$CONTAINER_RUNTIME" rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
        rebuild=true
    elif ! "$CONTAINER_RUNTIME" image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        log_info "builder image not found - building it"
        rebuild=true
    else
        existing="$("$CONTAINER_RUNTIME" inspect "$IMAGE_NAME" --format '{{index .Config.Labels "containerfile.hash"}}' 2>/dev/null || echo "")"
        if [ "$hash" != "$existing" ]; then
            log_warning "Containerfile changed - rebuilding the builder image"
            "$CONTAINER_RUNTIME" rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
            rebuild=true
        else
            log_info "using the existing builder image $IMAGE_NAME"
        fi
    fi
    if [ "$rebuild" = true ]; then
        # this machine's platform, named explicitly (scripts/lib.sh: a digest-pinned FROM otherwise resolves to
        # whichever architecture's copy the local store holds), and the result checked
        "$CONTAINER_RUNTIME" build --platform "$(host_image_platform)" -t "$IMAGE_NAME" --label "containerfile.hash=$hash" -f Containerfile .
        check_image_arch "$CONTAINER_RUNTIME" "$IMAGE_NAME" "$(host_image_platform)" || exit 1
        log_success "builder image built"
        # a superseded builder image is left untagged; remove what this project
        # no longer needs, by its label only
        CONTAINER_RUNTIME="$CONTAINER_RUNTIME" bash deploy/prune-images.sh --component builder
    fi

    log_info "cleaning previous builds"
    rm -rf dist/ dist-electron/

    if [ "$PLATFORM" = mac ] || [ "$PLATFORM" = windows ]; then
        log_warning "macOS / Windows packages built in a Linux container have limitations (no signing, no DMG licensing);"
        log_warning "for best results run ./rebuild.sh --no-container --platform $PLATFORM on that platform"
    fi
    [ "$PLATFORM" = all ] && log_warning "container builds only support Linux packages reliably - building Linux packages only"

    log_info "running the build in the container"
    local inner=(bash ./rebuild.sh --in-container --platform "$PLATFORM" --format "$FORMAT")
    [ "$TESTING" = true ] && inner+=(--testing)
    # The container's own node_modules and Python venv live in named volumes
    # over the checkout's, so a Linux build never replaces this host's
    # (macOS) node_modules or backend/venv - and they are reused between
    # container builds. `podman volume rm jacarium-builder-node-modules ...`
    # starts them afresh.
    "$CONTAINER_RUNTIME" run --rm -v "$SCRIPT_DIR:/build:Z" \
        -v jacarium-builder-node-modules:/build/node_modules \
        -v jacarium-builder-central-node-modules:/build/jacarium-central/node_modules \
        -v jacarium-builder-venv:/build/backend/venv \
        -w /build "$IMAGE_NAME" "${inner[@]}"
    log_success "container build completed"
}

# ---------------------------------------------------------------------------
# the build itself (on this host, or inside the builder image)
# ---------------------------------------------------------------------------
load_nvm() {
    [ -f "$HOME/.nvm/nvm.sh" ] || return 0
    log_info "loading nvm"
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    if [ -f .nvmrc ]; then
        local want; want="$(cat .nvmrc)"
        if ! nvm ls "$want" >/dev/null 2>&1; then
            log_info "installing Node.js $want via nvm"
            nvm install "$want"
        fi
        nvm use "$want" >/dev/null
    elif ! command -v node >/dev/null 2>&1; then
        log_warning "Node.js not found - installing the LTS version via nvm"
        nvm install --lts && nvm use --lts >/dev/null
    fi
}

# The Python the backend venv is made with. Pinned to 3.14: requirements.lock
# is resolved for 3.14, the version the container (ubi9/python-314) runs too.
# Homebrew's unversioned python3 tracks whatever `brew upgrade` last made
# current, so the versioned formula is resolved explicitly (brew install
# python@3.14).
find_python() {
    local p
    # A python3.14 on the PATH first: Homebrew's own here, the one
    # actions/setup-python installs on a CI runner
    command -v python3.14 && return 0
    if [ "$(uname -s)" = Darwin ]; then
        for p in /opt/homebrew/opt/python@3.14/bin/python3.14 /usr/local/opt/python@3.14/bin/python3.14; do
            [ -x "$p" ] && { echo "$p"; return 0; }
        done
        for p in /opt/homebrew/bin/python3 /usr/local/bin/python3; do
            [ -x "$p" ] && { log_warning "python@3.14 not found via Homebrew - falling back to $p"; echo "$p"; return 0; }
        done
    fi
    command -v python3.14 || command -v python3 || true
}

build_backend() {
    local system_python
    system_python="$(find_python)"
    if [ -z "$system_python" ]; then
        log_warning "Python 3 not found - skipping the backend build (the app falls back to its Node backend, fewer features)"
        return 0
    fi
    log_info "Python: $system_python ($("$system_python" --version))"
    (
        cd backend
        # Empty the venv rather than deleting it: in the container it is a
        # named volume (a mount point cannot be removed, only emptied)
        reset_venv() { [ -d venv ] && find venv -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; return 0; }
        if [ -d venv ]; then
            local venv_version system_version
            venv_version="$(venv/bin/python3 --version 2>/dev/null || echo unknown)"
            system_version="$("$system_python" --version)"
            if [ "$venv_version" != "$system_version" ]; then
                log_warning "venv Python ($venv_version) differs from $system_version - recreating the venv"
                reset_venv
            fi
        fi
        if [ ! -x venv/bin/python3 ]; then     # missing, or emptied above (a volume stays as an empty directory)
            log_info "creating the Python virtual environment"
            "$system_python" -m venv venv
        fi
        local python_bin="$PWD/venv/bin/python3"
        rm -rf build/ dist/

        # Supply-chain cooldown for every pip install (pip counterpart of .npmrc
        # min-release-age=7): only versions uploaded to PyPI at least 7 days ago.
        # Needs pip >= 26.1; a bootstrapped pip older than that cannot express the
        # cooldown for its own upgrade, so probe for the option offline first.
        local cooldown="--uploaded-prior-to=P7D"
        if "$python_bin" -m pip install "$cooldown" --help >/dev/null 2>&1; then
            "$python_bin" -m pip install -q "$cooldown" --upgrade pip
        else
            echo "Bootstrapped pip predates 26.1 - upgrading it without the release cooldown"
            "$python_bin" -m pip install -q --upgrade pip
        fi
        # Versions locked past the cooldown on the maintainer's request (cooldown-exceptions.txt):
        # installed first at exactly those versions, so the cooldown install below keeps them.
        if grep -qvE '^[[:space:]]*(#|$)' cooldown-exceptions.txt 2>/dev/null; then
            log_info "installing the approved cooldown exceptions: $(grep -vE '^[[:space:]]*(#|$)' cooldown-exceptions.txt | tr '\n' ' ')"
            "$python_bin" -m pip install -q --disable-pip-version-check --no-deps -r cooldown-exceptions.txt -c requirements.lock
        fi
        "$python_bin" -m pip install -q --disable-pip-version-check "$cooldown" -r requirements.txt -c requirements.lock
        "$python_bin" -m pip install -q --disable-pip-version-check "$cooldown" pyinstaller

        # the pages this backend serves itself need their vendored assets
        # (PyInstaller packages backend/static)
        node ../scripts/vendor-assets.mjs --strict

        echo "Building Flask backend for platform: $(uname -s)"
        echo "Running PyInstaller with spec file (excludes system libraries)..."
        "$python_bin" -m PyInstaller flask-backend.spec

        # onedir build: dist/flask-backend/ holds the launcher plus _internal/
        [ -f dist/flask-backend/flask-backend ] || die "backend build failed"
        log_success "backend built ($(du -sh dist/flask-backend | cut -f1)) - backend/dist/flask-backend/flask-backend"
    )
}

build_here() {
    [ "$IN_CONTAINER" = true ] || load_nvm
    need_cmd node "install Node.js (see .nvmrc), or install nvm: https://github.com/nvm-sh/nvm"
    need_cmd npm
    log_info "Node.js $(node --version), npm $(npm --version)"

    log_info "configuring npm timeouts for electron-builder"
    npm config set fetch-timeout 600000
    npm config set fetch-retry-mintimeout 20000
    npm config set fetch-retry-maxtimeout 120000
    log_info "clearing the electron-builder cache"
    rm -rf ~/.cache/electron-builder/

    log_info "cleaning previous builds"
    rm -rf dist/ dist-electron/

    log_info "installing npm dependencies"
    npm install
    if [ "$IN_CONTAINER" = true ]; then
        log_info "installing native dependencies for the container"
        npx electron-builder install-app-deps
    fi

    log_info "building the Python backend"
    build_backend

    log_info "building the UI ($BUILD_MODE_LABEL)"
    bash scripts/build-ui.sh "${UI_BUILD_ARGS[@]+"${UI_BUILD_ARGS[@]}"}"
    [ -f dist/index.html ] || die "frontend build failed"
    log_success "frontend built ($(du -sh dist | cut -f1))"

    log_info "packaging the Electron application"
    # --publish never: this script only builds. On a CI runner electron-builder
    # would otherwise try to upload to GitHub on its own when it sees a tag; the
    # release workflow publishes the files itself, after checking them.
    # shellcheck disable=SC2046  # the target list is deliberately word-split
    npx electron-builder $(electron_targets) --publish never
    [ -d dist-electron ] || die "Electron packaging failed"
    log_success "Electron packaging complete"
}

if [ "$USE_CONTAINER" = true ]; then
    build_in_container
else
    [ "$IN_CONTAINER" = true ] || log_warning "building on this host (dependencies must be installed)"
    build_here
fi

[ "$IN_CONTAINER" = true ] && exit 0

echo ""
echo "========================================="
log_success "Build complete!"
echo "========================================="
echo ""
echo "Packages in dist-electron/:"
found=false
for f in dist-electron/*; do
    [ -f "$f" ] || continue
    case "$f" in *.yml|*.yaml|*.blockmap) continue ;; esac
    ls -lh "$f"; found=true
done
[ "$found" = true ] || echo "No files found"
echo ""
echo "Build mode: $BUILD_MODE_LABEL  (platform: $PLATFORM, format: $FORMAT$([ "$USE_CONTAINER" = true ] && echo ", built in $CONTAINER_RUNTIME"))"
if [ "$TESTING" = true ]; then
    echo "  - MACHINE_ID override: ENABLED - this is a TESTING build, do not ship it"
    echo "  - run it:   ./run.sh --packaged --profile alice --port 8080 --machine-id alice@test"
    echo "              ./run.sh --packaged --profile bob   --port 8081 --machine-id bob@test"
    echo "  - build-mode.cjs was restored to production (git status is clean again)"
else
    echo "  - MACHINE_ID override: DISABLED (secure)"
    echo "  - testing builds: ./rebuild.sh --testing"
fi
echo ""
