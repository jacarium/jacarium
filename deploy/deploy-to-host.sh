#!/bin/bash
#
# Deploy the browser Jacarium - one container with the console and the
# central server behind /central - to another Linux host over SSH (e.g. a
# Raspberry Pi 4/5 with rootless podman), and update it in place with the
# same command. Nothing is pushed to a registry: the image travels over the
# SSH connection (podman save | gzip | ssh | podman load), as does the
# target-side helper (deploy/remote-host.sh). A 3.1 target with the central
# server as a second container is moved to the one container by the same
# command (its state moves into the console's data dir; see remote-host.sh).
#
#   deploy/deploy-to-host.sh <user@host> [deploy] [options]   first install AND update
#   deploy/deploy-to-host.sh <user@host> status
#   deploy/deploy-to-host.sh <user@host> logs
#   deploy/deploy-to-host.sh <user@host> stop | start
#   deploy/deploy-to-host.sh <user@host> uninstall [--purge] [--yes]
#   deploy/deploy-to-host.sh <user@host> publish-desktop [--from <dir>] [--build] [--linux]
#                              (the desktop installers for the server's downloads page:
#                              takes dist-electron/ - or builds it first with --build -
#                              and copies only the files that changed to the data volume;
#                              a normal deploy never touches them)
#   deploy/deploy-to-host.sh <user@host> list-users
#   deploy/deploy-to-host.sh <user@host> reset-password <username> [--revoke-devices] [--make-admin]
#                              (forgot the admin password: prints a one-time temporary password;
#                              the user must choose a new one at the next sign-in)
#
# Options (deploy):
#   --address <ip>             the host's LAN address clients will use; the console
#                              binds to it (never 0.0.0.0) and it goes into the
#                              certificate (default: the target's first LAN IPv4,
#                              or the host part of <user@host> when that is an address)
#   --name <hostname>          the name clients use for the host (default pi.console):
#                              it goes into the certificate and into every printed
#                              URL; the sockets bind to the LAN
#                              address, so the name must resolve to it on each
#                              client (/etc/hosts or the router's local DNS -
#                              the script checks and prints the fix)
#   --public-url <url>         the console sits behind a reverse proxy on the target
#                              (e.g. a host-networked Caddy serving https://pi.console
#                              with its own certificate): the console is then published
#                              on the target's loopback only (127.0.0.1:<console-port>),
#                              the proxy is the only way in and its URL is what
#                              clients use. --no-public-url returns to publishing on
#                              the LAN address
#   --proxy-ca-from <container> the reverse proxy on the target runs in this container
#                              (e.g. caddy): its CA root certificate is read out of it
#                              (`<engine> exec <container> cat <path>`, read-only, the
#                              container is never changed) into the console's data dir,
#                              and the console serves it at /api/tls/root.crt - the
#                              desktop app pins that root when it links, so the
#                              proxy's renewed certificates (Caddy's `tls internal`
#                              renews the leaf every 12 h) pass without a prompt.
#                              Refreshed on every run; --no-proxy-ca stops that
#   --proxy-ca-path <path>     where the root is inside that container (default
#                              /data/caddy/pki/authorities/local/root.crt, Caddy's)
#   --san <name,...>           extra certificate names, e.g. raspberrypi.local
#                              (default: the target's hostname and hostname.local)
#   --console-port <n>         default 8443
#   --auth-mode accounts|none  sign-in on the console (default accounts: every user has
#                              an account and their own data on the server; the first
#                              run prints a one-time setup code - see status). "none" is
#                              the earlier open deployment: anyone who can reach the
#                              port can use everything. The central server (the team
#                              features) runs behind the console at /central: signed-in
#                              browsers and linked desktops use it with nothing to set up
#                              (an account-ticket key generated on the target); without
#                              an account there are no team features
#   --enable-linger            run `sudo loginctl enable-linger` on the target when
#                              lingering is off (needs sudo there)
#   --no-build                 deploy the image as it is on this machine (skip the build)
#   --force-transfer           send the image even when the target already has it
#   --build-on-target          build the image on the target (needs git + network
#                              there) instead of sending them; used automatically
#                              as the fallback when a cross-architecture build fails
#   --engine podman|docker     which engine to use on the target when both exist
#                              (default: podman; a target with only Docker uses Docker)
#   --instance <name>          a separate named deployment (containers, units, state
#                              and image tags suffixed with the name); for tests
#   --tag <tag>                image tag on the target (default latest)
#   --yes                      no confirmation prompts
#
# Settings persist on the target in ~/.config/jacarium/deploy-to-host.conf
# (per --instance: deploy-to-host.<name>.conf), so a later plain
# `deploy-to-host.sh <user@host>` reuses them; options given again override
# and are saved. All state stays on the target in the container's /data (the
# settings env file, certificate, reports, known_hosts, and under central/
# the central server's client registry, Yjs key and account-ticket key).
# The certificate is only regenerated when the address or the names change.
#
# Reboots: with podman the container runs as a systemd user unit (Quadlet
# when the target's podman is 4.4+, otherwise a plain `podman run --replace`
# unit), enabled in default.target; the user must be allowed to linger (`sudo
# loginctl enable-linger <user>`) or nothing starts before someone logs in.
# With Docker it runs with --restart unless-stopped and the docker service
# starts it at boot. Either way the state dir stays owned by the target user
# (podman: UserNS=keep-id; Docker: --user <uid>:0).
#
# Environment: DEPLOY_SSH_OPTS - extra ssh/scp options (tests use it for a port
# and identity file); PODMAN_MACHINE_START_TIMEOUT - seconds to wait for a
# Podman machine this script started (120); DEPLOY_HOST_OS - the host OS
# for the machine logic (uname -s; the tests force it). macOS bash 3.2
# compatible on this side.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

usage() { sed -n '2,67p' "$0" | sed 's/^# \{0,1\}//'; }

TARGET="${1:-}"
[ -n "$TARGET" ] || { usage; exit 1; }
shift
case "$TARGET" in -h|--help|help) usage; exit 0 ;; esac
ACTION="deploy"
case "${1:-}" in deploy|status|logs|stop|start|uninstall|reset-password|list-users|publish-desktop) ACTION="$1"; shift ;; esac
ACCOUNT_USERNAME=""; ACCOUNT_FLAGS=""
if [ "$ACTION" = reset-password ]; then
    ACCOUNT_USERNAME="${1:-}"
    case "$ACCOUNT_USERNAME" in ""|-*) log_error "reset-password needs a username (see: $0 $TARGET list-users)"; exit 1 ;; esac
    case "$ACCOUNT_USERNAME" in *[!a-zA-Z0-9._-]*) log_error "a username has letters, digits, . _ - only"; exit 1 ;; esac
    shift
fi

ADDRESS=""; SAN=""; SAN_SET=no; CONSOLE_PORT=""
ENABLE_LINGER=no; FORCE_TRANSFER=no; BUILD_ON_TARGET=no
INSTANCE=default; TAG=latest; YES=no; PURGE=no; ENGINE_OPT=""; NAME_OPT=""; NO_BUILD=no; PUBLIC_URL_OPT=""; AUTH_MODE_OPT=""; PROXY_CA_FROM_OPT=""; PROXY_CA_PATH_OPT=""
DESKTOP_FROM=""; DESKTOP_BUILD=no; DESKTOP_LINUX=no
while [ $# -gt 0 ]; do
    case "$1" in
        --only) log_error "--only is gone: the console and the central server are one container since 3.2"; exit 1 ;;
        --address) ADDRESS="$2"; shift ;;
        --name) NAME_OPT="$2"; shift ;;
        --public-url) PUBLIC_URL_OPT="$2"; shift ;;
        --no-public-url) PUBLIC_URL_OPT="-" ;;
        --proxy-ca-from) PROXY_CA_FROM_OPT="$2"; shift ;;
        --no-proxy-ca) PROXY_CA_FROM_OPT="-" ;;
        --proxy-ca-path) PROXY_CA_PATH_OPT="$2"; shift ;;
        --san) SAN="$2"; SAN_SET=yes; shift ;;
        --console-port) CONSOLE_PORT="$2"; shift ;;
        --auth-mode) AUTH_MODE_OPT="$2"; shift ;;
        --central|--central-port|--cors-origin) log_error "$1 is gone: the central server always runs behind the console at /central (no standalone mode since 3.2)"; exit 1 ;;
        --enable-linger) ENABLE_LINGER=yes ;;
        --force-transfer) FORCE_TRANSFER=yes ;;
        --no-build) NO_BUILD=yes ;;
        --build-on-target) BUILD_ON_TARGET=yes ;;
        --engine) ENGINE_OPT="$2"; shift ;;
        --instance) INSTANCE="$2"; shift ;;
        --tag) TAG="$2"; shift ;;
        --yes|-y) YES=yes ;;
        --purge) PURGE=yes ;;
        --revoke-devices|--make-admin) ACCOUNT_FLAGS="$ACCOUNT_FLAGS $1" ;;
        --from) DESKTOP_FROM="$2"; shift ;;
        --build) DESKTOP_BUILD=yes ;;
        --linux) DESKTOP_LINUX=yes ;;
        console|central) ;;   # the component names of 3.1's `logs`: one container now
        -h|--help) usage; exit 0 ;;
        *) log_error "unknown option: $1"; usage; exit 1 ;;
    esac
    shift
done
case "$INSTANCE" in *[!a-zA-Z0-9_-]*) log_error "--instance: letters, digits, - and _ only"; exit 1 ;; esac
case "$ENGINE_OPT" in ""|podman|docker) ;; *) log_error "--engine takes podman or docker"; exit 1 ;; esac
case "$AUTH_MODE_OPT" in ""|accounts|none) ;; *) log_error "--auth-mode takes accounts or none"; exit 1 ;; esac

# ---------------------------------------------------------------------------
# ssh plumbing
# ---------------------------------------------------------------------------
# shellcheck disable=SC2206
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 ${DEPLOY_SSH_OPTS:-})
# rssh never reads this script's stdin (ssh -n); rssh_in is for the commands
# that are fed through stdin (the helper upload, the image stream, the config).
rssh() { ssh -n "${SSH_OPTS[@]}" "$TARGET" "$@"; }
rssh_in() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
REMOTE_HELPER='$HOME/.config/jacarium/deploy/remote-host.sh'
remote() { rssh "bash $REMOTE_HELPER $1 $INSTANCE ${2:-}"; }
remote_in() { rssh_in "bash $REMOTE_HELPER $1 $INSTANCE ${2:-}"; }

if ! rssh 'echo ok' >/dev/null 2>&1; then
    log_error "cannot reach $TARGET over SSH without a password (BatchMode). Set up key authentication first:"
    echo "  ssh-copy-id $TARGET"
    exit 1
fi
rssh_in 'mkdir -p "$HOME/.config/jacarium/deploy" && cat > "$HOME/.config/jacarium/deploy/remote-host.sh"' < "$SCRIPT_DIR/remote-host.sh" \
    || { log_error "could not copy the helper to $TARGET"; exit 1; }

# ---------------------------------------------------------------------------
# the simple actions
# ---------------------------------------------------------------------------
case "$ACTION" in
    status) remote status; exit $? ;;
    logs)   remote logs; exit $? ;;
    # accounts, from the host (host access is the proof of ownership): runs
    # the backend's CLI inside the console container, no sudo
    list-users)     rssh "bash $REMOTE_HELPER account $INSTANCE list-users"; exit $? ;;
    publish-desktop)
        # The installers live on the data volume (<console data>/downloads/), never in
        # the image: the page the console serves at /api/downloads/ lists what is there.
        FROM_DIR="${DESKTOP_FROM:-$REPO_ROOT/dist-electron}"
        if [ "$DESKTOP_BUILD" = yes ]; then
            log_info "building the desktop app (macOS arm64$([ "$DESKTOP_LINUX" = yes ] && echo ', Linux AppImage arm64 + x64')) - this takes a while"
            # installers of an earlier build must not be published alongside the new ones
            rm -f "$REPO_ROOT"/dist-electron/*.dmg "$REPO_ROOT"/dist-electron/*.zip "$REPO_ROOT"/dist-electron/*.AppImage "$REPO_ROOT"/dist-electron/*.deb "$REPO_ROOT"/dist-electron/*.exe "$REPO_ROOT"/dist-electron/*.blockmap 2>/dev/null
            # shellcheck disable=SC2046  # the extra targets are deliberately word-split
            (cd "$REPO_ROOT" && npm run backend:build && npm run build && npx electron-builder --mac dmg zip --arm64 $([ "$DESKTOP_LINUX" = yes ] && echo '--linux AppImage --arm64 --x64')) \
                || { log_error "the desktop build failed"; exit 1; }
            FROM_DIR="$REPO_ROOT/dist-electron"
        fi
        [ -d "$FROM_DIR" ] || { log_error "no installers at $FROM_DIR (run with --build, or npm run electron:build:full first)"; exit 1; }
        # the source archive of this version's release tag (committed files only - nothing local)
        APP_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$REPO_ROOT/package.json")"
        rm -f "$FROM_DIR"/jacarium-*-src.tar.gz
        if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/v$APP_VERSION" >/dev/null 2>&1; then
            git -C "$REPO_ROOT" archive --format=tar.gz --prefix="jacarium-$APP_VERSION/" "v$APP_VERSION" > "$FROM_DIR/jacarium-$APP_VERSION-src.tar.gz" \
                || { log_error "could not create the source archive from tag v$APP_VERSION"; exit 1; }
            log_info "source archive: jacarium-$APP_VERSION-src.tar.gz (git archive of tag v$APP_VERSION)"
        else
            log_warning "no tag v$APP_VERSION: the source archive is not published (tag the release first)"
        fi
        MANIFEST_NOTE=(); [ "$DESKTOP_LINUX" = yes ] && MANIFEST_NOTE=(--note 'Built on macOS without the packaged Python backend: the app falls back to its Node backend (fewer features).')
        LOCAL_MANIFEST="$(node "$SCRIPT_DIR/../scripts/desktop-manifest.cjs" "$FROM_DIR" "${MANIFEST_NOTE[@]+"${MANIFEST_NOTE[@]}"}")" \
            || { log_error "could not read the installers in $FROM_DIR"; exit 1; }
        COUNT="$(printf '%s' "$LOCAL_MANIFEST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).files.length))')"
        [ "$COUNT" -gt 0 ] || { log_error "no installer (.dmg/.zip/.AppImage/.deb/.exe) in $FROM_DIR"; exit 1; }
        if [ "$INSTANCE" = default ]; then REMOTE_DL='$HOME/.config/jacarium/server/data/downloads'; else REMOTE_DL="\$HOME/.config/jacarium/instances/$INSTANCE/console-data/downloads"; fi
        rssh "mkdir -p $REMOTE_DL" || { log_error "cannot create $REMOTE_DL on $TARGET"; exit 1; }
        REMOTE_MANIFEST="$(rssh "cat $REMOTE_DL/manifest.json 2>/dev/null" || true)"
        SENT=0; KEPT=0
        while IFS=$'\t' read -r name sha; do
            [ -n "$name" ] || continue
            rsha="$(printf '%s' "$REMOTE_MANIFEST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const f=(JSON.parse(d).files||[]).find(x=>x.name===process.argv[1]);console.log(f?f.sha256:"")}catch{console.log("")}})' "$name")"
            if [ "$rsha" = "$sha" ] && rssh "test -f $REMOTE_DL/\"$name\""; then KEPT=$((KEPT+1)); continue; fi
            log_info "sending $name ($(du -h "$FROM_DIR/$name" | cut -f1 | tr -d ' '))..."
            rssh_in "cat > $REMOTE_DL/\"$name.part\" && mv -f $REMOTE_DL/\"$name.part\" $REMOTE_DL/\"$name\"" < "$FROM_DIR/$name" || { log_error "sending $name failed"; exit 1; }
            SENT=$((SENT+1))
        done < <(printf '%s' "$LOCAL_MANIFEST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const f of JSON.parse(d).files)console.log(f.name+"\t"+f.sha256)})')
        # files that are no longer published go; the manifest is written last
        KEEP_LIST="$(printf '%s' "$LOCAL_MANIFEST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).files.map(f=>f.name).join("\n")))')"
        printf '%s\n' "$KEEP_LIST" | rssh_in "cd $REMOTE_DL && keep=\$(cat) && for f in *; do [ \"\$f\" = manifest.json ] && continue; [ -f \"\$f\" ] || continue; printf '%s\n' \"\$keep\" | grep -qxF -- \"\$f\" || rm -f -- \"\$f\"; done" || true
        printf '%s\n' "$LOCAL_MANIFEST" | rssh_in "cat > $REMOTE_DL/manifest.json.tmp && mv -f $REMOTE_DL/manifest.json.tmp $REMOTE_DL/manifest.json" || { log_error "writing the manifest failed"; exit 1; }
        log_success "desktop installers published on $TARGET: $COUNT file(s), $SENT sent, $KEPT unchanged (the console serves them at /api/downloads/)"
        exit 0 ;;
    reset-password) rssh "bash $REMOTE_HELPER account $INSTANCE reset-password $ACCOUNT_USERNAME$ACCOUNT_FLAGS"; exit $? ;;
    stop|start) remote "$ACTION"; exit $? ;;
    uninstall)
        if [ "$YES" != yes ]; then
            if [ "$PURGE" = yes ]; then
                printf 'Remove the deployment AND ALL ITS STATE on %s (settings, certificate, reports, accounts, the central server state with its Yjs key)? [y/N] ' "$TARGET"
            else
                printf 'Remove the deployment on %s (its state stays)? [y/N] ' "$TARGET"
            fi
            read -r reply; case "$reply" in y|Y|yes) ;; *) log_info "cancelled"; exit 0 ;; esac
        fi
        remote uninstall "$([ "$PURGE" = yes ] && echo --purge)"; exit $? ;;
esac

# ---------------------------------------------------------------------------
# deploy: probe the target
# ---------------------------------------------------------------------------
PROBE="$(remote probe 2>/dev/null)" || { log_error "probing $TARGET failed"; exit 1; }
pv() { printf '%s\n' "$PROBE" | sed -n "s/^$1=//p" | head -1; }
# the configuration stored on the target (deploy-to-host.conf), as the probe reports it
cv() { printf '%s\n' "$PROBE" | sed -n "s/^conf_$1=//p" | head -1; }
T_ARCH="$(pv arch)"; T_OS="$(pv os_name)"; T_OSID="$(pv os_id)"; T_PODMAN="$(pv podman)"; T_QUADLET="$(pv quadlet)"
T_LINGER="$(pv linger)"; T_USER="$(pv user)"; T_HOST="$(pv hostname)"; T_DISK="$(pv disk_free_mb)"; T_MEM="$(pv mem_total_mb)"
T_IPV4="$(pv ipv4)"; T_SYSTEMD="$(pv systemd_user)"
log_info "target: $TARGET - $T_OS, $T_ARCH, podman ${T_PODMAN:-missing}, ${T_MEM:-?} MB RAM, ${T_DISK:-?} MB free"

case "$T_ARCH" in
    armv7l|armv6l|armhf|i686|i386)
        log_error "$TARGET runs a 32-bit OS ($T_ARCH). The images are built from Red Hat UBI 9, which exists for 64-bit only (aarch64 / x86_64). Install the 64-bit Raspberry Pi OS and try again."
        exit 1 ;;
    aarch64|arm64) T_PLATFORM=linux/arm64; T_IMGARCH=arm64 ;;
    x86_64|amd64)  T_PLATFORM=linux/amd64; T_IMGARCH=amd64 ;;
    *) log_error "unsupported target architecture: $T_ARCH"; exit 1 ;;
esac
T_DOCKER="$(pv docker)"; T_DOCKER_OK="$(pv docker_ok)"; T_DOCKER_ENABLED="$(pv docker_enabled)"
ENGINE="$ENGINE_OPT"
[ -z "$ENGINE" ] && ENGINE="$(cv ENGINE)"
if [ -z "$ENGINE" ]; then
    if [ -n "$T_PODMAN" ]; then ENGINE=podman; elif [ -n "$T_DOCKER" ]; then ENGINE=docker; fi
fi
if [ -z "$ENGINE" ]; then
    log_error "neither podman nor Docker is installed on $TARGET. Install one there first, e.g.:"
    case "$T_OSID$(pv os_like)" in
        *fedora*|*rhel*|*centos*) echo "  sudo dnf install -y podman" ;;
        *debian*|*raspbian*|*ubuntu*) echo "  sudo apt install -y podman uidmap slirp4netns" ;;
        *) echo "  (your distribution's podman package)" ;;
    esac
    echo "  sudo loginctl enable-linger $T_USER     # so the containers start at boot"
    exit 1
fi
if [ "$ENGINE" = podman ] && [ -z "$T_PODMAN" ]; then log_error "podman is not installed on $TARGET (Docker is: use --engine docker)"; exit 1; fi
if [ "$ENGINE" = docker ]; then
    [ -n "$T_DOCKER" ] || { log_error "Docker is not installed on $TARGET"; exit 1; }
    if [ "$T_DOCKER_OK" != yes ]; then
        log_error "$T_USER cannot talk to the Docker daemon on $TARGET without sudo. On the target, run:"
        echo "  sudo usermod -aG docker $T_USER     # then log out and in again"
        exit 1
    fi
    if [ "$T_DOCKER_ENABLED" != enabled ]; then
        log_warning "the docker service is not enabled at boot on $TARGET (${T_DOCKER_ENABLED:-unknown}); the containers will not come back after a reboot until you run there:"
        echo "  sudo systemctl enable docker"
    fi
    log_info "engine: Docker $T_DOCKER (containers restart with the docker service; ports published by Docker bypass ufw)"
else
    log_info "engine: podman $T_PODMAN"
fi
[ "$ENGINE" = docker ] || [ "$T_SYSTEMD" = running ] || log_warning "no running systemd user session on $TARGET (session: ${T_SYSTEMD:-?}); the units may not start"
if [ -n "$T_MEM" ] && [ "$T_MEM" -lt 3800 ]; then log_warning "$TARGET has ${T_MEM} MB RAM - under 4 GB the backend (RAG index, PyInstaller-free gunicorn) may be slow or get killed"; fi
if [ -n "$T_DISK" ] && [ "$T_DISK" -lt 4096 ]; then log_warning "$TARGET has ${T_DISK} MB free - the images need about 2.5 GB plus one previous version for rollback"; fi
if [ "$ENGINE" = podman ] && [ "$T_LINGER" != yes ]; then
    if [ "$ENABLE_LINGER" = yes ]; then
        if rssh "sudo -n loginctl enable-linger $T_USER" 2>/dev/null; then log_success "lingering enabled for $T_USER on $TARGET"; T_LINGER=yes; else log_warning "could not enable lingering (sudo without a password?)"; fi
    fi
    if [ "$T_LINGER" != yes ]; then
        log_warning "user $T_USER is not allowed to linger on $TARGET: the containers will NOT come back after a reboot until you run, on the target:"
        echo "  sudo loginctl enable-linger $T_USER"
        echo "  (or re-run with --enable-linger if sudo works without a password there)"
    fi
fi
if [ "$ENGINE" = podman ]; then [ "$T_QUADLET" = yes ] && log_info "systemd units: Quadlet (podman $T_PODMAN)" || log_info "systemd units: podman run --replace services (podman $T_PODMAN has no Quadlet; 4.4+ would)"; fi

# ---------------------------------------------------------------------------
# the configuration: stored on the target, overridden by the options
# ---------------------------------------------------------------------------
if [ -z "$ADDRESS" ]; then ADDRESS="$(cv ADDRESS)"; fi
if [ -z "$ADDRESS" ]; then
    host_part="${TARGET#*@}"
    case "$host_part" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) ADDRESS="$host_part" ;;
        *) ADDRESS="$T_IPV4" ;;
    esac
fi
[ -n "$ADDRESS" ] || { log_error "could not determine the target's LAN address - give --address <ip>"; exit 1; }
case "$ADDRESS" in 0.0.0.0|::|'*') log_error "--address must be one LAN address, not $ADDRESS: there is no sign-in, binding to every interface is refused"; exit 1 ;; esac
if [ "$SAN_SET" = no ]; then SAN="$(cv SAN | tr ',' '\n' | grep -v -x -e "$(cv NAME)" -e "" | paste -sd, -)"; fi
if [ "$SAN_SET" = no ] && [ -z "$(cv SAN)" ] && [ -n "$T_HOST" ]; then
    case "$T_HOST" in
        localhost*|"") ;;                      # says nothing about the machine
        *.*) SAN="$T_HOST" ;;                  # already a full name
        *) SAN="$T_HOST,$T_HOST.local" ;;      # mDNS name as well (raspberrypi.local)
    esac
fi
NAME="${NAME_OPT:-$(cv NAME)}"; NAME="${NAME:-pi.console}"
case "$NAME" in *[!a-zA-Z0-9.-]*|"") log_error "--name must be a hostname (letters, digits, dots, dashes)"; exit 1 ;; esac
CONSOLE_PORT="${CONSOLE_PORT:-$(cv CONSOLE_PORT)}"; CONSOLE_PORT="${CONSOLE_PORT:-8443}"
PUBLIC_URL="${PUBLIC_URL_OPT:-$(cv PUBLIC_URL)}"; [ "$PUBLIC_URL" = "-" ] && PUBLIC_URL=""
PROXY_CA_FROM="${PROXY_CA_FROM_OPT:-$(cv PROXY_CA_FROM)}"; [ "$PROXY_CA_FROM" = "-" ] && PROXY_CA_FROM=""
PROXY_CA_PATH="${PROXY_CA_PATH_OPT:-$(cv PROXY_CA_PATH)}"; PROXY_CA_PATH="${PROXY_CA_PATH:-/data/caddy/pki/authorities/local/root.crt}"
case "$PROXY_CA_FROM" in *[!a-zA-Z0-9_.-]*) log_error "--proxy-ca-from takes a container name"; exit 1 ;; esac
case "$PROXY_CA_PATH" in /*) ;; *) log_error "--proxy-ca-path must be an absolute path inside the container"; exit 1 ;; esac
if [ -n "$PROXY_CA_FROM" ]; then log_info "the reverse proxy's CA root is read from container $PROXY_CA_FROM ($PROXY_CA_PATH) and served at /api/tls/root.crt for the desktop app to pin"
elif [ -n "$PUBLIC_URL" ]; then log_info "behind a reverse proxy without --proxy-ca-from: the console serves no CA root, so the desktop app pins the proxy's leaf certificate and asks again when it renews (Caddy's tls internal: every 12 h) - give --proxy-ca-from <container> to fix that"; fi
# Sign-in on the console: accounts unless the target was deployed with none
# before (kept) or --auth-mode says otherwise. An upgrade from an earlier
# deployment (no AUTH_MODE stored) switches to accounts and says so.
AUTH_MODE="${AUTH_MODE_OPT:-$(cv AUTH_MODE)}"; AUTH_MODE="${AUTH_MODE:-accounts}"
if [ -z "$AUTH_MODE_OPT" ] && [ -z "$(cv AUTH_MODE)" ] && [ "$(pv conf_exists)" = yes ]; then
    log_warning "this deployment had no sign-in; it is switched to accounts now (--auth-mode none keeps the open deployment). The first run prints a one-time setup code (also in the console data dir, setup-code) to create the administrator; the data collected so far is adopted then."
fi
# The central server runs inside the console's container (/central). A
# 3.0/3.1 target still running it as a second container is migrated on this
# run: the target-side helper stops that container, MOVES its state (client
# registry, Yjs snapshots and keys) into the console's data dir, starts the
# one container and - once it is healthy - removes the old container, unit,
# network and image; if the new container does not become healthy, the
# state goes back and the two containers run again.
if [ "$(pv legacy_central)" = yes ]; then
    log_warning "the central server moves into the console's container: its state (client registry, shared documents, keys) is moved into the console data dir, then the separate jacarium-central container, its network and image are removed - after the new container is healthy (put back otherwise)"
fi
PUBLIC_ORIGIN=""
if [ -n "$PUBLIC_URL" ]; then
    case "$PUBLIC_URL" in https://*|http://*) ;; *) log_error "--public-url must start with https:// (or http://)"; exit 1 ;; esac
    PUBLIC_ORIGIN="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
    PUBLIC_HOST="$(printf '%s' "$PUBLIC_ORIGIN" | sed -E 's#^https?://##; s#:[0-9]+$##')"
fi
# every certificate name: the chosen name first, then the extra ones
ALL_SAN="$NAME"
for n in $(echo "$SAN" | tr ',' ' '); do [ -n "$n" ] && [ "$n" != "$NAME" ] && ALL_SAN="$ALL_SAN,$n"; done
CENTRAL_WHERE="central server in the same container, behind /central"
if [ -n "$PUBLIC_URL" ]; then
    log_info "console behind the target's reverse proxy at $PUBLIC_URL: published on 127.0.0.1:$CONSOLE_PORT only; $CENTRAL_WHERE"
else
    log_info "name $NAME, address $ADDRESS, extra names ${SAN:-none}, console :$CONSOLE_PORT, $CENTRAL_WHERE"
fi
# Does the name reach the target from here? (the sockets bind to the address;
# every client must resolve the name to it)
CHECK_NAME="${PUBLIC_HOST:-$NAME}"
RESOLVED=""
if command -v dscacheutil >/dev/null 2>&1; then RESOLVED="$(dscacheutil -q host -a name "$CHECK_NAME" 2>/dev/null | sed -n 's/^ip_address: //p' | head -1)"
elif command -v getent >/dev/null 2>&1; then RESOLVED="$(getent hosts "$CHECK_NAME" 2>/dev/null | awk '{print $1}' | head -1)"; fi
if [ "$RESOLVED" = "$ADDRESS" ]; then
    log_info "$CHECK_NAME resolves to $ADDRESS on this machine"
elif [ -n "$PUBLIC_URL" ]; then
    log_info "$CHECK_NAME does not resolve to $ADDRESS from here (${RESOLVED:-no answer}) - the proxy's DNS (e.g. Pi-hole) or /etc/hosts must provide it on each client: echo \"$ADDRESS $CHECK_NAME\" | sudo tee -a /etc/hosts"
else
    log_warning "$NAME does not resolve to $ADDRESS on this machine (${RESOLVED:-no answer}). On every client that should use the name, either:"
    echo "  echo \"$ADDRESS $NAME\" | sudo tee -a /etc/hosts          # macOS / Linux"
    echo "  or add $NAME -> $ADDRESS to the router's local DNS"
    echo "  (the IP URLs below work without it)"
fi
TLD="${NAME##*.}"
if [ "$TLD" != "$NAME" ] && command -v dig >/dev/null 2>&1 && [ -n "$(dig +short +time=3 +tries=1 NS "$TLD." 2>/dev/null)" ]; then
    log_warning ".$TLD is a delegated public top-level domain: a name under it may resolve to a stranger's address wherever your local entry is missing - prefer a name under a domain you control"
fi
[ "$(pv listening_$CONSOLE_PORT)" = yes ] && [ "$(pv console_container)" = "" ] && log_warning "something else already listens on port $CONSOLE_PORT on $TARGET"

# ---------------------------------------------------------------------------
# build locally (cached builds take seconds), for the target's architecture
# ---------------------------------------------------------------------------
# Podman on macOS and Windows runs in a machine (a VM) that may not be
# running - the deploy then used to fail its local build ("Cannot connect
# to Podman") and fall back to the slow build on the target. Now the
# machine is started first: the one the default connection points at
# (podman-machine-default-root -> podman-machine-default), else the default
# machine, else the first; then `podman info` is awaited (up to
# PODMAN_MACHINE_START_TIMEOUT seconds, 120 by default). A started machine
# is left running: cheap, and the next deploy is faster. A Mac without a
# machine is told how to make one and builds on the target, as before.
# Docker Desktop is not used by this script (it builds, saves and inspects
# with podman only), so a computer with Docker but no podman builds on
# the target too, with a message. Linux has no machine: an unreachable
# podman there is an error of its own.
# DEPLOY_HOST_OS: the host OS name for these decisions (uname -s; the test
# suite forces Darwin with a stubbed podman).
podman_machine_uses_vm() { case "${DEPLOY_HOST_OS:-$(uname -s)}" in Darwin|MINGW*|MSYS*|CYGWIN*|Windows_NT) return 0 ;; *) return 1 ;; esac; }
podman_machine_name() {
    local machines conn name
    machines="$(podman machine list --format '{{.Name}} {{.Default}}' 2>/dev/null)" || machines=""
    [ -n "$machines" ] || return 1
    conn="$(podman system connection list --format '{{.Name}} {{.Default}}' 2>/dev/null | awk '$2=="true"{print $1; exit}')"
    conn="${conn%-root}"
    if [ -n "$conn" ] && printf '%s\n' "$machines" | awk '{print $1}' | grep -qx -- "$conn"; then echo "$conn"; return 0; fi
    name="$(printf '%s\n' "$machines" | awk '$2=="true"{print $1; exit}')"
    [ -n "$name" ] || name="$(printf '%s\n' "$machines" | awk 'NR==1{print $1}')"
    echo "$name"
}
PODMAN_MACHINE_STARTED=""
ensure_local_podman() {
    local name running waited=0 timeout="${PODMAN_MACHINE_START_TIMEOUT:-120}"
    podman info >/dev/null 2>&1 && return 0
    if ! podman_machine_uses_vm; then log_error "podman is installed here but does not answer (podman info failed)"; return 1; fi
    if ! name="$(podman_machine_name)"; then
        log_warning "Podman has no machine on this computer (podman info failed): 'podman machine init' then 'podman machine start' makes one, and the next deploy builds here"
        return 1
    fi
    running="$(podman machine list --format '{{.Name}} {{.Running}}' 2>/dev/null | awk -v n="$name" '$1==n{print $2}')"
    if [ "$running" = true ]; then
        log_error "the Podman machine '$name' is running but podman cannot connect to it (podman info failed); 'podman machine stop $name && podman machine start $name' may help"
        return 1
    fi
    log_info "the Podman machine '$name' is not running: starting it (it is left running afterwards)..."
    if ! podman machine start "$name" >/dev/null 2>&1; then log_error "'podman machine start $name' failed"; return 1; fi
    until podman info >/dev/null 2>&1; do
        if [ "$waited" -ge "$timeout" ]; then log_error "the Podman machine '$name' was started but podman did not answer within ${timeout}s"; return 1; fi
        sleep 2; waited=$((waited + 2))
    done
    PODMAN_MACHINE_STARTED="$name"
    log_success "Podman machine '$name' started (${waited}s); it stays running"
    return 0
}
# "this machine (darwin/arm64, Podman 5.3.1 via applehv)": where the local build runs
local_build_host() {
    local os arch ver via name
    os="$(printf '%s' "${DEPLOY_HOST_OS:-$(uname -s)}" | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
    ver="$(podman version --format '{{.Client.Version}}' 2>/dev/null | head -1)"
    via=""
    if podman_machine_uses_vm && name="$(podman_machine_name 2>/dev/null)"; then via="$(podman machine inspect --format '{{.VMType}}' "$name" 2>/dev/null | head -1)"; fi
    printf 'this machine (%s/%s, Podman %s%s)' "$os" "$arch" "${ver:-?}" "${via:+ via $via}"
}
CROSS_BUILD=no
if [ "$BUILD_ON_TARGET" = no ]; then
    if ! command -v podman >/dev/null 2>&1; then
        if command -v docker >/dev/null 2>&1; then
            log_warning "podman is not installed here and this script does not build with Docker (Docker Desktop is left alone): install podman ('brew install podman && podman machine init && podman machine start' on a Mac) to build here"
        else
            log_warning "podman is not installed here"
        fi
        [ "$NO_BUILD" = no ] || { log_error "--no-build needs a local image to send, and podman to read it"; exit 1; }
        log_warning "building on $TARGET instead (as --build-on-target)"
        BUILD_ON_TARGET=yes
    elif ! ensure_local_podman; then
        [ "$NO_BUILD" = no ] || { log_error "--no-build needs a local image to send, and podman to read it"; exit 1; }
        log_warning "building on $TARGET instead (as --build-on-target)"
        BUILD_ON_TARGET=yes
    else
        [ -n "$PODMAN_MACHINE_STARTED" ] || log_info "podman is reachable here$(podman_machine_uses_vm && echo " (the machine was already running)")"
        LOCAL_ARCH="$(podman info --format '{{.Host.Arch}}' 2>/dev/null | head -1)"
        # the target's platform is always named (build_image: --platform "$T_PLATFORM"): without it a
        # digest-pinned FROM resolves to whichever architecture's copy of the base image the local store holds
        # (an earlier emulated build leaves the other one), and the deploy ships an image the target cannot
        # run; the built image is checked below before anything is sent
        if [ "$LOCAL_ARCH" != "$T_IMGARCH" ]; then
            log_warning "$(local_build_host) builds ${LOCAL_ARCH:-?} images; the target needs $T_IMGARCH: building with --platform $T_PLATFORM (emulated, slower)"
            CROSS_BUILD=yes
        fi
    fi
fi
# DEPLOY_TO_HOST_BUILD_ARGS: extra `podman build` arguments (the test suite forces a
# changed image with a label)
# shellcheck disable=SC2206
EXTRA_BUILD_ARGS=(${DEPLOY_TO_HOST_BUILD_ARGS:-})
# What the image is built from, as one hash over the tracked files it uses
# (content + path): the whole checkout minus tests and docs - the central
# server's directory included, minus its development scripts, which the
# build context leaves out (.containerignore). The image built here carries
# it as a label, and a running container with the same label is left alone -
# whatever its image id says (a rebuild after the build cache was pruned
# gives a new id for the very same inputs, and an image loaded from an
# archive gets a new id in the other engine). Untracked files do not count;
# commit or stage them to deploy them.
inputs_hash() {
    (cd "$REPO_ROOT" && git ls-files -z | grep -z -v -E '^(tests|docs)/|^jacarium-central/.*\.sh$' | sort -z | xargs -0 shasum -a 256 2>/dev/null | shasum -a 256 | cut -c1-16)
}
build_image() {
    podman build --platform "$T_PLATFORM" --format docker "${EXTRA_BUILD_ARGS[@]+"${EXTRA_BUILD_ARGS[@]}"}" --label "com.jacarium.inputs=$(inputs_hash)" -f "$SCRIPT_DIR/Containerfile" -t "localhost/jacarium:$TAG" "$REPO_ROOT" >/dev/null \
        && bash "$SCRIPT_DIR/prune-images.sh" --component deploy >/dev/null
}
# A running container built from exactly these inputs (and healthy) needs
# nothing: no build, no transfer, and the target will not restart it (same
# image) - unless the central server still runs as a second container
# (3.1): then the target must be restarted to take it in. --force-transfer /
# --no-build / --build-on-target deploy what they are told regardless.
UNCHANGED=""
unchanged() { [ "$UNCHANGED" = console ]; }
if [ "$FORCE_TRANSFER" = no ] && [ "$NO_BUILD" = no ] && [ "$BUILD_ON_TARGET" = no ] && [ -z "${DEPLOY_TO_HOST_BUILD_ARGS:-}" ]; then
    want="$(inputs_hash)"; running="$(pv console_inputs)"
    if [ -n "$running" ] && [ "$running" = "$want" ] && [ "$(pv console_container)" = healthy ]; then
        UNCHANGED=console
        log_info "console: $TARGET already has the image built from these inputs ($want) running and healthy - unchanged, nothing to build or send"
    fi
fi
if [ "$BUILD_ON_TARGET" = no ] && [ "$NO_BUILD" = no ] && ! unchanged; then
    log_info "building the image locally ($T_PLATFORM)..."
    if ! build_image; then
        if [ "$CROSS_BUILD" = yes ]; then
            log_warning "the cross-architecture build failed here - building on the target instead"
            BUILD_ON_TARGET=yes
        else
            log_error "building the image failed"; exit 1
        fi
    fi
fi
# The built image must be the target's architecture before anything is sent: a mismatch here is the
# "exec format error" the target's health check would otherwise catch after the fact.
if [ "$BUILD_ON_TARGET" = no ] && [ "$NO_BUILD" = no ] && ! unchanged; then
    BUILT_ARCH="$(podman image inspect --format '{{.Architecture}}' "localhost/jacarium:$TAG" 2>/dev/null | head -1)"
    if [ "$BUILT_ARCH" != "$T_IMGARCH" ]; then
        log_error "the image built here is ${BUILT_ARCH:-?}, the target $TARGET needs $T_IMGARCH: the build did not honour --platform $T_PLATFORM (an image of the other architecture in the local store?) - nothing is sent"
        exit 1
    fi
    log_info "built a $BUILT_ARCH image for $TARGET"
fi

# ---------------------------------------------------------------------------
# transfer: only when the target's image id differs
# ---------------------------------------------------------------------------
# Does the target already have exactly this image? An image id is only
# comparable within one engine (Docker gives a podman-saved archive a new id),
# so the id of the sending side is recorded on the target after each
# transfer and compared on the next run; the same id in both places (shared
# storage) counts too. The layer fingerprint verifies a transfer afterwards.
local_id() { podman image inspect --format '{{.Id}}' "localhost/$1:$TAG" 2>/dev/null; }
local_fp() { podman image inspect --format '{{range .RootFS.Layers}}{{.}},{{end}}' "localhost/$1:$TAG" 2>/dev/null | tr -d '\n' | shasum -a 256 | cut -c1-32; }
remote_fp() { rssh "$ENGINE image inspect --format '{{range .RootFS.Layers}}{{.}},{{end}}' localhost/$1:$TAG 2>/dev/null | tr -d '\n' | sha256sum | cut -c1-32"; }
remote_id() { rssh "$ENGINE image inspect --format '{{.Id}}' localhost/$1:$TAG 2>/dev/null" | sed 's/^sha256://'; }
if [ "$BUILD_ON_TARGET" = yes ]; then
    log_info "sending the source tree to $TARGET and building there (this needs network access on the target)..."
    (cd "$REPO_ROOT" && git archive --format=tar HEAD) | rssh_in 'rm -rf "$HOME/.config/jacarium/deploy/src" && mkdir -p "$HOME/.config/jacarium/deploy/src" && tar -x -C "$HOME/.config/jacarium/deploy/src"' \
        || { log_error "sending the source tree failed"; exit 1; }
    log_info "building the image on $TARGET..."
    rssh "cd \"\$HOME/.config/jacarium/deploy/src\" && $ENGINE build $([ "$ENGINE" = podman ] && echo --format docker) -f deploy/Containerfile -t localhost/jacarium:$TAG . >/dev/null" \
        || { log_error "building the image on the target failed"; exit 1; }
    rssh 'rm -rf "$HOME/.config/jacarium/deploy/src"'
elif ! unchanged; then
    transfer_image() {
        local c=console img=jacarium lid rid sid size lfp rfp
        lid="$(local_id "$img")"; rid="$(remote_id "$img")"; sid="$(pv "${c}_src_id")"
        [ -n "$lid" ] || { log_error "$c: no local image localhost/$img:$TAG (build it, or drop --no-build)"; exit 1; }
        if [ "$FORCE_TRANSFER" = no ] && [ -n "$rid" ] && { [ "$lid" = "$rid" ] || [ "$lid" = "$sid" ]; }; then
            log_info "$c: $TARGET already has image $(echo "$lid" | cut -c1-12) - nothing to send"
            return 0
        fi
        if [ "$FORCE_TRANSFER" = no ] && [ -n "$rid" ] && [ -z "$sid" ] && [ "$(local_fp "$img")" = "$(remote_fp "$img")" ]; then
            # no record yet (loaded before this version of the script) but the
            # same layers: adopt it instead of sending it again
            rssh "printf '%s' '$lid' > \"\$HOME/.config/jacarium/deploy/$img.$TAG.srcid\""
            log_info "$c: $TARGET already has an image with the same layers - adopted, nothing to send"
            return 0
        fi
        size="$(podman image inspect --format '{{.Size}}' "localhost/$img:$TAG" 2>/dev/null)"
        log_info "$c: sending image $(echo "$lid" | cut -c1-12) ($((size / 1048576)) MB uncompressed) to $TARGET..."
        if ! podman save --format docker-archive "localhost/$img:$TAG" | gzip -1 | rssh_in "gunzip | $ENGINE load >/dev/null"; then
            log_error "$c: transferring the image failed"; exit 1
        fi
        lfp="$(local_fp "$img")"; rfp="$(remote_fp "$img")"
        [ -n "$rfp" ] && [ "$rfp" = "$lfp" ] || { log_error "$c: the image on the target does not match after the transfer (layers ${rfp:-none} vs $lfp)"; exit 1; }
        rssh "printf '%s' '$lid' > \"\$HOME/.config/jacarium/deploy/$img.$TAG.srcid\""
        log_success "$c: image $(echo "$lid" | cut -c1-12) on $TARGET"
    }
    transfer_image
fi

# ---------------------------------------------------------------------------
# apply on the target: units, certificates, start/update, health, rollback
# ---------------------------------------------------------------------------
CONF_LINES="ENGINE=$ENGINE
ADDRESS=$ADDRESS
NAME=$NAME
PUBLIC_URL=$PUBLIC_URL
PROXY_CA_FROM=$PROXY_CA_FROM
PROXY_CA_PATH=$PROXY_CA_PATH
SAN=$ALL_SAN
CONSOLE_PORT=$CONSOLE_PORT
CONSOLE_TAG=$TAG
AUTH_MODE=$AUTH_MODE
UNCHANGED=$UNCHANGED"
log_info "applying on $TARGET..."
if printf '%s\n' "$CONF_LINES" | remote_in apply; then
    log_success "deployed to $TARGET"
    RC=0
else
    log_error "deployment on $TARGET did not succeed (see the messages above; a previous version was restored where possible)"
    RC=1
fi
echo ""
CONSOLE_URL="${PUBLIC_URL:-https://$NAME:$CONSOLE_PORT}"
if [ -n "$PUBLIC_URL" ]; then
    echo "  Jacarium: $PUBLIC_URL   (through the target's reverse proxy and its certificate; the console itself listens on 127.0.0.1:$CONSOLE_PORT there)"
else
    echo "  Jacarium: https://$NAME:$CONSOLE_PORT   (by address: https://$ADDRESS:$CONSOLE_PORT$(for n in $(echo "$SAN" | tr ',' ' '); do printf ', https://%s:%s' "$n" "$CONSOLE_PORT"; done))"
fi
echo "  Central server:  $CONSOLE_URL/central   (in the same container: same address and certificate, no port of its own)"
echo "                   the team features of signed-in browsers and linked desktops - nothing to set up; Settings > General shows the status"
echo ""
if [ "$AUTH_MODE" = accounts ]; then
    if rssh "test -s \"\$HOME/.config/jacarium/$([ "$INSTANCE" = default ] && echo server/data || echo "instances/$INSTANCE/console-data")/setup-code\"" 2>/dev/null; then
        echo "  Sign-in: no account exists yet. Open the console, choose a username and password and enter the"
        echo "  one-time setup code to create the administrator account. Read the code with:"
        echo "    ssh $TARGET cat ~/.config/jacarium/$([ "$INSTANCE" = default ] && echo server/data || echo "instances/$INSTANCE/console-data")/setup-code"
        echo "  The data the console collected before sign-in (settings, Taskwarrior, SSH host keys) is adopted"
        echo "  by that first account. Browsers are offered their pre-sign-in data at their first sign-in."
    else
        echo "  Sign-in: every user has an account (Settings > Users to add one); a VPN such as WireGuard or NetBird for"
        echo "  access from outside your network; never publish the port on the internet."
    fi
elif [ -n "$PUBLIC_URL" ]; then
    echo "  There is NO sign-in: the console is reachable only through the proxy at $PUBLIC_URL; anyone who can"
    echo "  reach that can use the app and its SSH / Taskwarrior / settings APIs."
else
    echo "  There is NO sign-in: the console is published on $ADDRESS only; anyone who can reach"
    echo "  that port can use the app and its SSH / Taskwarrior / settings APIs."
fi
if [ "$ENGINE" = podman ]; then [ "$T_LINGER" = yes ] || echo "  Reboots: NOT yet surviving - run 'sudo loginctl enable-linger $T_USER' on $TARGET."; fi
if [ "$ENGINE" = docker ]; then [ "$T_DOCKER_ENABLED" = enabled ] || echo "  Reboots: NOT yet surviving - run 'sudo systemctl enable docker' on $TARGET."; echo "  Docker publishes ports with its own iptables rules (ufw does not see them); the containers bind to $ADDRESS only."; fi
echo "  Reboot check: after 'sudo reboot' on $TARGET, run: $0 $TARGET status"
exit $RC
