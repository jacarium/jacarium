#!/bin/bash
# Build the renderer (Vite) - the one UI build script, used by `npm run build`,
# rebuild.sh, deploy/Containerfile and deploy-to-host.sh publish-desktop.
#
#   scripts/build-ui.sh              production build
#   scripts/build-ui.sh --testing    testing build: unminified, source maps,
#                                    DevTools open, MACHINE_ID override allowed
#                                    (./rebuild.sh --testing packages it)
#   scripts/build-ui.sh --reset      only put build-mode.cjs back to production
#
# Steps: copy the third-party assets the Flask-served pages need into
# backend/static/vendor (scripts/vendor-assets.mjs --strict: no CDN, the app
# must work without internet access), write build-mode.cjs (read by the packaged
# Electron main process), then `vite build` with BUILD_MODE in the environment.
#
# build-mode.cjs is a tracked file whose committed content is always the
# production mode. --testing rewrites it, and ./rebuild.sh --testing restores
# it after packaging; a leftover shows up as a modified tracked file, which
# `npm run release` refuses and tests/scripts.test.mjs reports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

write_build_mode() {
    cat > "$REPO_ROOT/build-mode.cjs" <<EOF
// This file is auto-generated during build
// DO NOT EDIT MANUALLY
module.exports = {
  buildMode: '$1'
};
EOF
}

BUILD_MODE=production
RESET_ONLY=false
while [ $# -gt 0 ]; do
    case "$1" in
        --testing) BUILD_MODE=testing ;;
        --production) BUILD_MODE=production ;;
        --reset) RESET_ONLY=true ;;
        -h|--help) usage; exit 0 ;;
        *) log_error "unknown option: $1"; usage; exit 1 ;;
    esac
    shift
done
export BUILD_MODE

if [ "$RESET_ONLY" = true ]; then
    write_build_mode production
    log_info "build-mode.cjs: production"
    exit 0
fi

cd "$REPO_ROOT"
need_cmd node "install Node.js (see .nvmrc)"

log_info "vendoring third-party assets for the backend's own pages (no CDN)"
node scripts/vendor-assets.mjs --strict

write_build_mode "$BUILD_MODE"
log_info "build mode: $BUILD_MODE"
[ "$BUILD_MODE" = production ] || log_warning "build-mode.cjs now says '$BUILD_MODE' - ./rebuild.sh --testing restores it; by hand: scripts/build-ui.sh --production, or git checkout build-mode.cjs"

log_info "vite build"
npx vite build
log_success "UI built into dist/ ($BUILD_MODE)"
