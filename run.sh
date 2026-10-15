#!/bin/bash
# Jacarium - run the desktop app.
#
#   ./run.sh                       development: Vite dev server + Electron (hot reload)
#   ./run.sh --packaged            the app built by ./rebuild.sh (dist-electron/)
#
# Options (both modes):
#   --profile <name>     open this desktop profile (its own data, settings and cloud
#                        identity; created if missing). Several profiles can run at
#                        the same time - give each its own --port
#   --port <n>           the local backend's port (default 8080; the next free one is
#                        used when a second profile already has it)
#   --machine-id <id>    cloud identity override, e.g. alice@test - honoured in
#                        development and in a ./rebuild.sh --testing build only
#   --testing            development only: BUILD_MODE=testing (DevTools open, the
#                        MACHINE_ID override allowed)
#   -h, --help           this text
#
# Two identities on one machine (the old two-script demo, now profiles):
#   ./run.sh --profile alice --port 8080 --machine-id alice@test
#   ./run.sh --profile bob   --port 8081 --machine-id bob@test
#
# The team features (shared documents, chat, games) come with a home server:
# link the profile in Settings > General, which also shows the open profile.
# The backend's port must be free: the script says who holds it otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/scripts/lib.sh"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=dev
PROFILE=""
PORT="${PORT:-8080}"
MACHINE_ID_OPT="${MACHINE_ID:-}"
TESTING=false
while [ $# -gt 0 ]; do
    case "$1" in
        --packaged) MODE=packaged ;;
        --dev) MODE=dev ;;
        --profile) PROFILE="${2:-}"; shift ;;
        --profile=*) PROFILE="${1#*=}" ;;
        --port) PORT="${2:-}"; shift ;;
        --port=*) PORT="${1#*=}" ;;
        --machine-id) MACHINE_ID_OPT="${2:-}"; shift ;;
        --machine-id=*) MACHINE_ID_OPT="${1#*=}" ;;
        --testing) TESTING=true ;;
        -h|--help) usage; exit 0 ;;
        *) log_error "unknown option: $1"; usage; exit 1 ;;
    esac
    shift
done
case "$PORT" in ''|*[!0-9]*) die "--port needs a number" ;; esac
case "$PROFILE" in *[!a-zA-Z0-9_-]*) die "--profile: letters, digits, - and _ only" ;; esac

# the port the backend will take: say who holds it instead of failing later
find_port_pid() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
    elif command -v fuser >/dev/null 2>&1; then
        fuser "$1"/tcp 2>/dev/null | awk '{print $1}'
    fi
}
existing="$(find_port_pid "$PORT" || true)"
if [ -n "$existing" ]; then
    log_error "port $PORT is already in use (PID $existing, $(ps -p "$existing" -o comm= 2>/dev/null || echo unknown)) - stop it, or run with --port <another port>"
    exit 1
fi

# Older PyInstaller onefile builds extracted themselves to _MEI<random> dirs
# under $TMPDIR and only removed them on a clean exit; sweep leftovers older
# than 10 minutes (anything a still-running old build might be mid-extracting
# is left alone).
find "${TMPDIR:-/tmp}" -maxdepth 1 -name '_MEI*' -type d -mmin +10 -print0 2>/dev/null |
    while IFS= read -r -d '' stale_dir; do rm -rf "$stale_dir"; done

export PORT
[ -n "$MACHINE_ID_OPT" ] && export MACHINE_ID="$MACHINE_ID_OPT"
PROFILE_ARGS=(); [ -n "$PROFILE" ] && PROFILE_ARGS=(--profile "$PROFILE")

echo "========================================="
echo "  Jacarium - $([ "$MODE" = dev ] && echo development || echo packaged app)"
echo "========================================="
echo "  Backend port: $PORT"
echo "  Profile:      ${PROFILE:-default}"
echo "  Machine ID:   ${MACHINE_ID_OPT:-username@hostname (auto-detected)}"
[ "$TESTING" = true ] && echo "  Build mode:   testing"
echo ""

if [ "$MODE" = dev ]; then
    need_cmd npm "install Node.js (see .nvmrc)"
    [ -d node_modules ] || { log_info "node_modules missing - running npm install"; npm install; }
    [ "$TESTING" = true ] && export BUILD_MODE=testing
    log_info "starting the Vite dev server and Electron (Ctrl+C stops both)"
    # the same as `npm run electron:dev`, with the profile handed to Electron
    exec npx concurrently -k "npm run dev" "npx wait-on http://localhost:5173 && npx electron . ${PROFILE_ARGS[*]+"${PROFILE_ARGS[*]}"}"
fi

[ "$TESTING" = true ] && log_warning "--testing has no effect on a packaged app: build one with ./rebuild.sh --testing"
if [ "$(uname)" = Darwin ]; then
    APP="$(find dist-electron -path '*/Jacarium.app/Contents/MacOS/Jacarium' -type f 2>/dev/null | head -n 1)"
    [ -n "$APP" ] || die "no Jacarium.app in dist-electron/ - build it first: ./rebuild.sh --no-container --platform mac"
else
    APP="$(find dist-electron -name 'Jacarium-*.AppImage' -type f 2>/dev/null | head -n 1)"
    [ -n "$APP" ] || die "no AppImage in dist-electron/ - build it first: ./rebuild.sh"
fi
log_info "starting $APP"
exec "$APP" "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}"
