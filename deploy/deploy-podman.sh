#!/bin/bash
#
# Jacarium - build and run the browser deployment with Podman: one container
# with the console and, behind /central, the central server (team features).
#
#   deploy/deploy-podman.sh               build the image and start it
#   deploy/deploy-podman.sh build|start|stop|restart|status|logs|clean
#
# Settings (environment variables):
#   BIND_ADDRESS   host address to publish on   (default 127.0.0.1 - this
#                  machine only; set your LAN IP to share it, e.g.
#                  BIND_ADDRESS=192.168.1.20; 0.0.0.0 needs ALLOW_ANY_ADDRESS=1)
#   PORT           host port                     (default 8443)
#   DATA_DIR       the /data volume on the host   (default
#                  ~/.config/jacarium/server/data)
#   TLS_SAN        extra names for the generated certificate, e.g.
#                  "DNS:console.example.internal,IP:192.168.1.20"
#   AUTH_MODE      accounts (default: sign-in required; the first start prints a
#                  one-time setup code, also in DATA_DIR/setup-code, to create
#                  the administrator) or none (the earlier open deployment)
#   CENTRAL        on (default): the central server runs in the container, its
#                  state under DATA_DIR/central (keys generated on first start);
#                  off: no central server, no /central route, no team features
#   IMAGE_NAME     (default jacarium:latest)
#   CONTAINER_NAME (default jacarium)
#
# Images: after a successful build, deploy/prune-images.sh removes what the
# build superseded (the previous image, older stage results) by this
# project's label only, keeping the newest ui / taskwarrior stage images as
# build cache; `clean` removes every image of the deployment (and keeps
# DATA_DIR). Nothing else on the machine is ever touched.
#
# With AUTH_MODE=none THERE IS NO SIGN-IN: anyone who can open the port can
# use the app and its SSH / Taskwarrior / settings APIs with this
# container's credentials. Publish it on 127.0.0.1 (then use an SSH tunnel)
# or on a trusted network only. Either way treat DATA_DIR like a password
# store (it holds the API keys).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$REPO_ROOT/scripts/lib.sh"

CONTAINER_NAME="${CONTAINER_NAME:-jacarium}"
IMAGE_NAME="${IMAGE_NAME:-jacarium:latest}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
PORT="${PORT:-8443}"
DATA_DIR="${DATA_DIR:-$HOME/.config/jacarium/server/data}"
TLS_SAN="${TLS_SAN:-}"
AUTH_MODE="${AUTH_MODE:-accounts}"
case "$AUTH_MODE" in accounts|none) ;; *) echo "AUTH_MODE must be accounts or none"; exit 1 ;; esac
CENTRAL="${CENTRAL:-on}"
case "$CENTRAL" in on|off) ;; *) echo "CENTRAL must be on or off"; exit 1 ;; esac

usage() { sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; }

check_podman() {
    if ! command -v podman >/dev/null 2>&1; then
        log_error "podman is not installed (https://podman.io/docs/installation)"
        exit 1
    fi
    if ! podman info >/dev/null 2>&1; then
        log_error "podman cannot reach its machine/daemon (on macOS: podman machine start)"
        exit 1
    fi
}

check_bind_address() {
    [ "$AUTH_MODE" = none ] || return 0
    case "$BIND_ADDRESS" in
        127.0.0.1|localhost|::1)
            ;;
        0.0.0.0|::|'*')
            if [ "${ALLOW_ANY_ADDRESS:-0}" != "1" ]; then
                log_error "BIND_ADDRESS=$BIND_ADDRESS would publish the app, with no sign-in, on every interface."
                log_error "Set BIND_ADDRESS to one trusted address (your LAN IP), or ALLOW_ANY_ADDRESS=1 if you really mean it."
                exit 1
            fi
            log_warning "Publishing on ALL interfaces ($BIND_ADDRESS) with no sign-in - make sure a firewall limits who can reach port $PORT."
            ;;
        *)
            log_warning "Publishing on $BIND_ADDRESS:$PORT with no sign-in: everyone who can reach that address can use the app."
            ;;
    esac
}

build_image() {
    log_info "Building $IMAGE_NAME from deploy/Containerfile..."
    # --format docker: the OCI image format has no HEALTHCHECK, so podman
    # would drop the Containerfile's and `status` would show "n/a".
    # --timestamp: the layers' and the image's time is the commit's, not the build's, so two builds of one
    # commit match (docs/security/reproducible-builds.md); outside a git checkout the build's time is used
    epoch="$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || date +%s)"
    podman build --format docker --timestamp "$epoch" -f "$SCRIPT_DIR/Containerfile" -t "$IMAGE_NAME" "$REPO_ROOT"
    log_success "Image built"
    # The build superseded the previous image (the tag moved on) and possibly
    # the untagged results of the ui / taskwarrior stages; remove what this
    # project no longer needs, keeping the newest stage images as build cache.
    # Only images labelled as ours, never one a container uses.
    bash "$SCRIPT_DIR/prune-images.sh" --component deploy
}

stop_container() {
    if podman ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        log_info "Stopping $CONTAINER_NAME..."
        podman stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
        podman rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
        log_success "Stopped"
    fi
}

start_container() {
    check_bind_address
    mkdir -p "$DATA_DIR/reports" "$DATA_DIR/certs"
    log_info "Data volume: $DATA_DIR"
    log_info "  settings:   $DATA_DIR/.jacarium.env   (API keys - keep private)"
    log_info "  reports:    $DATA_DIR/reports                (copy sosreports / must-gathers here)"
    log_info "  certs:      $DATA_DIR/certs/{cert,key}.pem    (self-signed on first start; replace with your own)"
    [ "$CENTRAL" = on ] && log_info "  central:    $DATA_DIR/central/{data,keys}      (the central server's state; back up keys/yjs-encryption.key)"

    if ! podman image exists "$IMAGE_NAME"; then
        log_error "Image $IMAGE_NAME is not built - run 'deploy/deploy-podman.sh build' (or deploy-podman.sh with no arguments) first"
        exit 1
    fi

    stop_container

    local args=(
        -d --name "$CONTAINER_NAME"
        # the image is built locally; never let podman look for it in a registry
        --pull=never
        # The hostname becomes the host part of each browser's cloud-sync
        # identity (browser-xxxxxxxx@<hostname>); without it podman uses the
        # container id.
        --hostname "$CONTAINER_NAME"
        --restart unless-stopped
        -p "${BIND_ADDRESS}:${PORT}:8443"
        -v "${DATA_DIR}:/data:Z,U"
        -e "JACARIUM_AUTH_MODE=$AUTH_MODE"
    )
    if [ -n "$TLS_SAN" ]; then
        args+=(-e "TLS_SAN=$TLS_SAN")
    fi
    if [ "$CENTRAL" = off ]; then
        args+=(-e JACARIUM_CENTRAL=off)
        log_warning "Central server: off (no /central route: no shared documents, chat or games)"
    fi

    log_info "Starting $CONTAINER_NAME on https://${BIND_ADDRESS}:${PORT} ..."
    podman run "${args[@]}" "$IMAGE_NAME" >/dev/null
    log_success "Started"
    echo ""
    echo "  Open:   https://${BIND_ADDRESS}:${PORT}"
    [ "$CENTRAL" = on ] && echo "  Central server: https://${BIND_ADDRESS}:${PORT}/central (in the same container; the team features of signed-in users, Settings > General shows the status)"
    if [ "$AUTH_MODE" = accounts ]; then
        echo "  Sign-in: on. First run: create the administrator with the one-time setup code"
        echo "           (printed in the logs, also in $DATA_DIR/setup-code)."
    else
        echo "  Sign-in: OFF (AUTH_MODE=none) - anyone who can reach the port can use everything."
    fi
    echo "  Certificate: self-signed unless you supplied one - accept it in the browser"
    echo "  (or import $DATA_DIR/certs/cert.pem as trusted)."
    echo "  Logs:   $0 logs"
    echo ""
}

show_status() {
    if podman ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        log_success "$CONTAINER_NAME is running"
        podman ps --filter "name=^${CONTAINER_NAME}$" --format 'table {{.Status}}\t{{.Ports}}\t{{.Image}}'
        local health
        health="$(podman inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
        echo "Health: ${health:-n/a}"
    else
        log_warning "$CONTAINER_NAME is not running"
        return 1
    fi
}

show_logs() {
    podman logs -f "$CONTAINER_NAME"
}

clean_all() {
    stop_container
    if podman image exists "$IMAGE_NAME"; then
        podman rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
        log_success "Image removed"
    fi
    # Every image of the browser deployment this project built - earlier
    # tags, the ui / taskwarrior stage images that serve as build cache -
    # identified by the project label; nothing else on the machine.
    bash "$SCRIPT_DIR/prune-images.sh" --component deploy --all
    log_info "The data volume at $DATA_DIR was left in place."
}

main() {
    case "${1:-}" in -h|--help) usage; exit 0 ;; esac
    check_podman
    case "${1:-deploy}" in
        deploy)  build_image; start_container ;;
        build)   build_image ;;
        start)   start_container ;;
        stop)    stop_container ;;
        restart) stop_container; start_container ;;
        status)  show_status ;;
        logs)    show_logs ;;
        clean)   clean_all ;;
        # accounts from the host (host access is the proof of ownership)
        list-users)     podman exec -w /app/backend "$CONTAINER_NAME" python -m accounts list-users ;;
        reset-password) shift; podman exec -w /app/backend "$CONTAINER_NAME" python -m accounts reset-password "$@" ;;
        *)
            echo "Usage: $0 [deploy|build|start|stop|restart|status|logs|clean|list-users|reset-password <username> [--revoke-devices] [--make-admin]]"
            echo "       $0 --help     the settings (environment variables) and what each command does"
            exit 1
            ;;
    esac
}

main "$@"
