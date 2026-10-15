#!/bin/bash
# Shared helpers for the repository's shell scripts (run.sh, rebuild.sh,
# start-backend.sh, scripts/build-ui.sh, deploy/deploy-podman.sh and the
# jacarium-central scripts). Source it, never run it:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/scripts/lib.sh"
#
# deploy/deploy-to-host.sh and deploy/remote-host.sh stay self-contained on
# purpose (the latter is copied alone to the target). bash 3.2 (macOS) safe.
#
#   log_info / log_success / log_warning / log_error   one coloured line each
#   die <message>                                      log_error, exit 1
#   need_cmd <command> [hint]                          die when it is missing
#   detect_container_runtime                           prints podman, docker or ""
#   repo_root                                          the checkout this file lives in

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    SC_BLUE='\033[0;34m'; SC_GREEN='\033[0;32m'; SC_YELLOW='\033[1;33m'; SC_RED='\033[0;31m'; SC_NC='\033[0m'
else
    SC_BLUE=''; SC_GREEN=''; SC_YELLOW=''; SC_RED=''; SC_NC=''
fi

log_info()    { printf '%b[INFO]%b %s\n' "$SC_BLUE" "$SC_NC" "$*"; }
log_success() { printf '%b[OK]%b %s\n' "$SC_GREEN" "$SC_NC" "$*"; }
log_warning() { printf '%b[WARN]%b %s\n' "$SC_YELLOW" "$SC_NC" "$*" >&2; }
log_error()   { printf '%b[ERROR]%b %s\n' "$SC_RED" "$SC_NC" "$*" >&2; }
die()         { log_error "$@"; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 && return 0
    die "$1 is required${2:+ - $2}"
}

# podman first, docker as the fallback (the same order everywhere)
detect_container_runtime() {
    if command -v podman >/dev/null 2>&1; then echo podman
    elif command -v docker >/dev/null 2>&1; then echo docker
    else echo ""
    fi
}

repo_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }
