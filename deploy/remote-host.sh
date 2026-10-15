#!/bin/bash
# The target-side half of deploy/deploy-to-host.sh. deploy-to-host.sh copies
# this file to the target over SSH on every run and calls it there; nothing
# here is meant to be run by hand (status/logs/stop/uninstall are reached
# through deploy-to-host.sh). Linux bash 4+, with either rootless podman and
# a systemd user session, or Docker (the user in the docker group).
#
#   remote-host.sh probe                      print KEY=VALUE facts about this host
#   remote-host.sh apply <instance>           read the instance config from stdin,
#                                             start or update the container,
#                                             health-check, roll back on failure, prune
#   remote-host.sh status|logs|stop|start|uninstall <instance> [args]
#
# One container, `jacarium`, runs everything (deploy/Containerfile): the
# console and, behind /central, the central server. Everything of an
# instance lives under one state dir, the container's /data:
#   default instance:   ~/.config/jacarium/server/data   (the same place
#                       deploy/deploy-podman.sh uses)
#   named instance X:   ~/.config/jacarium/instances/X/console-data
#   config:             ~/.config/jacarium/deploy-to-host[.X].conf
# The central server's state is <data>/central/{data,keys}. A 3.1 target
# ran it as a second container (jacarium-central, a shared network, its
# state in ~/.config/jacarium/central or instances/X/central): the first
# apply MOVES that state under the console's data dir, stops and removes the
# old container, unit, network and images - after the new container is
# healthy, and with everything put back if it is not (see migrate_central).
#
# How the container runs (ENGINE in the config, chosen by deploy-to-host.sh):
#   podman  as a systemd user unit: ~/.config/containers/systemd/<name>.container
#           (Quadlet, podman >= 4.4) or ~/.config/systemd/user/<name>.service
#           (`podman run --replace`), enabled in default.target. The user
#           must linger for it to start at boot. The container's user 1001
#           is mapped to the host user (UserNS=keep-id), so the state dir
#           stays owned by - and editable for - the host user.
#   docker  a plain container with --restart unless-stopped (the docker service
#           starts it at boot), run as --user <host uid>:0 for the same
#           reason: the state dir stays the host user's, nothing is made
#           world-writable. Docker publishes ports through its own iptables
#           rules, which bypass ufw - the container binds to the one LAN
#           address only.
set -uo pipefail

CMD="${1:-}"; shift || true
INSTANCE="${1:-}"; [ $# -gt 0 ] && shift

BASE="$HOME/.config/jacarium"
if [ -z "$INSTANCE" ] || [ "$INSTANCE" = "default" ]; then
    INSTANCE=default
    CONSOLE_DATA="$BASE/server/data"
    LEGACY_CENTRAL="$BASE/central"
    CONF="$BASE/deploy-to-host.conf"
    CONSOLE_NAME="jacarium"
    CENTRAL_NAME="jacarium-central"
else
    CONSOLE_DATA="$BASE/instances/$INSTANCE/console-data"
    LEGACY_CENTRAL="$BASE/instances/$INSTANCE/central"
    CONF="$BASE/deploy-to-host.$INSTANCE.conf"
    CONSOLE_NAME="jacarium-$INSTANCE"
    CENTRAL_NAME="jacarium-central-$INSTANCE"
fi
# the central server's state inside the console's data dir (/data/central)
CENTRAL_STATE="$CONSOLE_DATA/central"
# the container network of the 3.1 two-container shape (removed by the migration)
NET_NAME="jacarium"; [ "$INSTANCE" != default ] && NET_NAME="jacarium-$INSTANCE"
QUADLET_DIR="$HOME/.config/containers/systemd"
UNIT_DIR="$HOME/.config/systemd/user"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

say()  { echo "[remote] $*"; }
warn() { echo "[remote] WARNING: $*" >&2; }
die()  { echo "[remote] ERROR: $*" >&2; exit 1; }

podman_version() { command -v podman >/dev/null 2>&1 && podman --version 2>/dev/null | sed -n 's/^podman version \([0-9.]*\).*/\1/p'; }
# a real Docker daemon this user may talk to (not podman's docker alias)
docker_version() {
    command -v docker >/dev/null 2>&1 || return 0
    docker --version 2>/dev/null | grep -qi podman && return 0
    docker version --format '{{.Server.Version}}' 2>/dev/null
}
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
quadlet_supported() {
    local v; v="$(podman_version)"; [ -n "$v" ] || return 1
    version_ge "$v" 4.4 && { [ -x /usr/libexec/podman/quadlet ] || [ -x /usr/lib/podman/quadlet ] || [ -x /usr/lib/systemd/user-generators/podman-user-generator ]; }
}

load_conf() {
    # shellcheck disable=SC1090
    [ -f "$CONF" ] && . "$CONF"
    CONSOLE_PORT="${CONSOLE_PORT:-8443}"
    CONSOLE_TAG="${CONSOLE_TAG:-latest}"
    CENTRAL_TAG="${CENTRAL_TAG:-latest}"     # the 3.1 central image's tag, for the migration's cleanup
    ADDRESS="${ADDRESS:-}"
    NAME="${NAME:-}"
    PUBLIC_URL="${PUBLIC_URL:-}"
    PROXY_CA_FROM="${PROXY_CA_FROM:-}"
    PROXY_CA_PATH="${PROXY_CA_PATH:-/data/caddy/pki/authorities/local/root.crt}"
    SAN="${SAN:-}"
    CERT_SAN="${CERT_SAN:-}"
    MODE="${MODE:-}"
    AUTH_MODE="${AUTH_MODE:-accounts}"
    ENGINE="${ENGINE:-}"
    if [ -z "$ENGINE" ]; then
        if [ -n "$(podman_version)" ]; then ENGINE=podman; elif [ -n "$(docker_version)" ]; then ENGINE=docker; else ENGINE=podman; fi
    fi
    E="$ENGINE"
}

# engine-neutral helpers (E = podman|docker); ids without the sha256: prefix
image_id() { "$E" image inspect --format '{{.Id}}' "$1" 2>/dev/null | sed 's/^sha256://'; }
# A fingerprint that survives a docker-archive transfer between engines
# (image ids do not: each engine hashes its own config blob): the layer
# diff-ids, which are content hashes of the uncompressed layers.
image_fingerprint() {
    local layers; layers="$("$E" image inspect --format '{{range .RootFS.Layers}}{{.}},{{end}}' "$1" 2>/dev/null)"
    [ -n "$layers" ] && printf '%s' "$layers" | sha256sum | cut -c1-32
}
image_exists() { "$E" image inspect "$1" >/dev/null 2>&1; }
container_image_id() { "$E" inspect --format '{{.Image}}' "$1" 2>/dev/null | sed 's/^sha256://'; }
container_health() { "$E" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null; }
container_exists() { "$E" inspect "$1" >/dev/null 2>&1; }
unit_name() { echo "$1.service"; }
# the 3.1 shape left on this host: a central container or its state dir
legacy_central_present() {
    container_exists "$CENTRAL_NAME" && return 0
    { [ -d "$LEGACY_CENTRAL/data" ] || [ -d "$LEGACY_CENTRAL/keys" ]; } && return 0
    [ -f "$QUADLET_DIR/$CENTRAL_NAME.container" ] || [ -f "$UNIT_DIR/$CENTRAL_NAME.service" ] || [ -f "$BASE/deploy/spec/$CENTRAL_NAME.docker" ] && return 0
    return 1
}
is_empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1" 2>/dev/null)" ]; }

# ---------------------------------------------------------------------------
case "$CMD" in
account)
    # python -m accounts <list-users | reset-password <user> [--revoke-devices] [--make-admin]>
    # inside the running console container (its own user, its own data volume)
    load_conf
    container_exists "$CONSOLE_NAME" || { echo "the console container ($CONSOLE_NAME) is not deployed here" >&2; exit 1; }
    exec "$E" exec -w /app/backend "$CONSOLE_NAME" python -m accounts "$@"
    ;;
probe)
    echo "arch=$(uname -m)"
    if [ -r /etc/os-release ]; then . /etc/os-release; echo "os_id=${ID:-}"; echo "os_like=${ID_LIKE:-}"; echo "os_name=${PRETTY_NAME:-}"; fi
    echo "user=$(id -un)"; echo "uid=$(id -u)"
    echo "hostname=$(hostname 2>/dev/null)"
    echo "podman=$(podman_version)"
    quadlet_supported && echo "quadlet=yes" || echo "quadlet=no"
    echo "docker=$(docker_version)"
    if command -v docker >/dev/null 2>&1 && ! docker --version 2>/dev/null | grep -qi podman; then
        docker info >/dev/null 2>&1 && echo "docker_ok=yes" || echo "docker_ok=no"
        echo "docker_enabled=$(systemctl is-enabled docker 2>/dev/null || echo unknown)"
    fi
    echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
    echo "systemd_user=$(systemctl --user is-system-running 2>/dev/null || echo unavailable)"
    echo "disk_free_mb=$(df -Pm "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
    echo "mem_total_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
    # the first LAN IPv4 actually assigned to an interface (not a container
    # bridge); `hostname -I` may list addresses nothing can bind to
    ipv4="$( (ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; hostname -I 2>/dev/null | tr ' ' '\n') | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v -E '^(172\.1[6-9]|172\.2[0-9]|172\.3[01]|10\.88|10\.89)\.' | head -1)"
    echo "ipv4=$ipv4"
    echo "tools=$(for t in gzip openssl curl ss; do command -v "$t" >/dev/null && printf '%s ' "$t"; done)"
    echo "ufw=$(command -v ufw >/dev/null 2>&1 && echo present || echo absent)"
    echo "conf_exists=$([ -f "$CONF" ] && echo yes || echo no)"
    [ -f "$CONF" ] && sed 's/^/conf_/' "$CONF"
    load_conf
    echo "engine=$ENGINE"
    echo "console_image_id=$(image_id "localhost/jacarium:$CONSOLE_TAG")"
    echo "console_fingerprint=$(image_fingerprint "localhost/jacarium:$CONSOLE_TAG")"
    # the sending side's image id recorded after the last transfer (an image
    # loaded from a docker-archive gets a different id in each engine)
    echo "console_src_id=$(cat "$BASE/deploy/jacarium.$CONSOLE_TAG.srcid" 2>/dev/null)"
    echo "console_container=$(container_health "$CONSOLE_NAME")"
    # the build-inputs hash the running container was built from (a label
    # deploy-to-host.sh puts on every image it builds): the same inputs mean
    # nothing to build, send or restart, whatever the image id says
    echo "console_inputs=$("$E" inspect --format '{{index .Config.Labels "com.jacarium.inputs"}}' "$CONSOLE_NAME" 2>/dev/null)"
    # the 3.1 two-container shape still on this host (moved into the console on apply)
    echo "legacy_central=$(legacy_central_present && echo yes || echo no)"
    echo "central_container=$(container_health "$CENTRAL_NAME")"
    echo "central_ticket_key=$( { [ -s "$CENTRAL_STATE/keys/account-ticket.key" ] || [ -s "$LEGACY_CENTRAL/keys/account-ticket.key" ]; } && echo yes || echo no)"
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$CONSOLE_PORT\$"; then echo "listening_$CONSOLE_PORT=yes"; fi
    ;;

apply)
    # The new config arrives on stdin (KEY=VALUE lines) and replaces the
    # stored one; the stored one supplies what the caller did not set.
    load_conf
    NEW="$(cat)"
    # UNCHANGED=console: the sender found the running container built from
    # the same inputs (deploy-to-host.sh): it is not restarted unless a
    # configuration change needs it, whatever the tag points at
    UNCHANGED=""
    eval "$NEW"
    E="$ENGINE"
    unchanged_inputs() { case ",$UNCHANGED," in *",console,"*) return 0 ;; esac; return 1; }
    mkdir -p "$BASE" "$BASE/deploy"
    [ -n "$ADDRESS" ] || die "no ADDRESS in the configuration"
    case "$ENGINE" in
        podman) if quadlet_supported; then MODE=quadlet; else MODE=systemd; fi ;;
        docker) MODE=docker ;;
        *) die "unknown engine $ENGINE" ;;
    esac
    HOST_UID="$(id -u)"
    {
        echo "ENGINE=$ENGINE"; echo "ADDRESS=$ADDRESS"; echo "NAME=$NAME"; echo "PUBLIC_URL=$PUBLIC_URL"; echo "SAN=$SAN"
        echo "PROXY_CA_FROM=$PROXY_CA_FROM"; echo "PROXY_CA_PATH=$PROXY_CA_PATH"
        echo "CONSOLE_PORT=$CONSOLE_PORT"; echo "CONSOLE_TAG=$CONSOLE_TAG"
        echo "MODE=$MODE"; echo "AUTH_MODE=$AUTH_MODE"
    } > "$CONF.tmp"
    chmod 600 "$CONF.tmp"

    # The certificate names: the address plus every SAN; a change means the
    # certificate is regenerated and every client must accept it again.
    WANT_CERT_SAN="IP:$ADDRESS"
    for n in $(echo "$SAN" | tr ',' ' '); do
        case "$n" in
            "") ;;
            *[a-zA-Z]*) case "$n" in *:*) WANT_CERT_SAN="$WANT_CERT_SAN,IP:$n" ;; *) WANT_CERT_SAN="$WANT_CERT_SAN,DNS:$n" ;; esac ;;
            *) WANT_CERT_SAN="$WANT_CERT_SAN,IP:$n" ;;
        esac
    done
    CERT_CHANGED=no
    if [ -n "$CERT_SAN" ] && [ "$CERT_SAN" != "$WANT_CERT_SAN" ]; then CERT_CHANGED=yes; fi
    echo "CERT_SAN=$WANT_CERT_SAN" >> "$CONF.tmp"

    if [ "$ENGINE" = podman ]; then
        systemctl --user is-system-running >/dev/null 2>&1 || warn "no systemd user session: units cannot be managed (is this an SSH login with lingering enabled?)"
        mkdir -p "$QUADLET_DIR" "$UNIT_DIR"
    fi

    # -- the run specification of a container, engine-neutral ----------------
    # SPEC lines: Publish=, Volume=, Env=, EnvFile=, HostName=, Network=
    # podman: written to a unit (Quadlet or podman-run service); docker: a
    # `docker run` command. Both are persisted; a change restarts the container.
    SPEC_DIR="$BASE/deploy/spec"; mkdir -p "$SPEC_DIR"
    # host:ctr[:opts] -> with the SELinux relabel option added (podman only)
    vol_z() { case "$1" in *:*:*) echo "$1,Z" ;; *) echo "$1:Z" ;; esac; }
    render_unit() {   # $1 name, $2 description, $3 image, spec lines on stdin -> unit text
        local name="$1" desc="$2" image="$3" line body="" args=""
        while IFS= read -r line; do
            case "$MODE" in
                quadlet)
                    case "$line" in
                        Publish=*) body="$body
PublishPort=${line#Publish=}" ;;
                        Volume=*)  body="$body
Volume=$(vol_z "${line#Volume=}")" ;;
                        Env=*)     body="$body
Environment=${line#Env=}" ;;
                        EnvFile=*) body="$body
EnvironmentFile=${line#EnvFile=}" ;;
                        HostName=*) body="$body
HostName=${line#HostName=}" ;;
                        Network=*) body="$body
Network=${line#Network=}" ;;
                    esac ;;
                systemd)
                    case "$line" in
                        Publish=*) args="$args -p ${line#Publish=}" ;;
                        Volume=*)  args="$args -v $(vol_z "${line#Volume=}")" ;;
                        Env=*)     args="$args -e ${line#Env=}" ;;
                        EnvFile=*) args="$args --env-file ${line#EnvFile=}" ;;
                        HostName=*) args="$args --hostname ${line#HostName=}" ;;
                        Network=*) args="$args --network ${line#Network=}" ;;
                    esac ;;
            esac
        done
        if [ "$MODE" = quadlet ]; then
            printf '%s' "[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Container]
ContainerName=$name
Image=$image
Pull=never
UserNS=keep-id:uid=1001,gid=0$body

[Service]
Restart=always
RestartSec=5
TimeoutStartSec=600

[Install]
WantedBy=default.target
"
        else
            # podman < 4.4: the shape `podman generate systemd --new` produces -
            # the container is created from the image at every start, so
            # nothing else ever has to `podman run` it.
            printf '%s' "[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
Environment=PODMAN_SYSTEMD_UNIT=%n
Restart=always
RestartSec=5
TimeoutStartSec=600
TimeoutStopSec=70
ExecStart=/usr/bin/podman run --cidfile=%t/%n.ctr-id --cgroups=no-conmon --rm --sdnotify=conmon --replace -d --pull=never --userns=keep-id:uid=1001,gid=0 --name $name$args $image
ExecStop=/usr/bin/podman stop --ignore --cidfile=%t/%n.ctr-id
ExecStopPost=/usr/bin/podman rm -f --ignore --cidfile=%t/%n.ctr-id
Type=notify
NotifyAccess=all

[Install]
WantedBy=default.target
"
        fi
    }
    docker_run_args() {   # spec lines on stdin -> docker run arguments (one per line)
        local line
        while IFS= read -r line; do
            case "$line" in
                Publish=*) printf -- '-p\n%s\n' "${line#Publish=}" ;;
                Volume=*)  printf -- '-v\n%s\n' "${line#Volume=}" ;;
                Env=*)     printf -- '-e\n%s\n' "${line#Env=}" ;;
                EnvFile=*) printf -- '--env-file\n%s\n' "${line#EnvFile=}" ;;
                HostName=*) printf -- '--hostname\n%s\n' "${line#HostName=}" ;;
                Network=*) printf -- '--network\n%s\n' "${line#Network=}" ;;
            esac
        done
    }
    # the file that holds a container's definition for this engine / mode
    definition_file() { # $1 name
        if [ "$ENGINE" = podman ]; then
            if [ "$MODE" = quadlet ]; then echo "$QUADLET_DIR/$1.container"; else echo "$UNIT_DIR/$1.service"; fi
        else
            echo "$SPEC_DIR/$1.docker"
        fi
    }
    # $1 name, $2 description, $3 image; spec on stdin. Persists the rendered
    # definition; returns 0 when it changed (restart needed), 1 when unchanged.
    define_container() {
        local name="$1" desc="$2" image="$3" spec file rendered
        spec="$(cat)"
        file="$(definition_file "$name")"
        if [ "$ENGINE" = podman ]; then
            rendered="$(printf '%s\n' "$spec" | render_unit "$name" "$desc" "$image")"
        else
            rendered="docker run -d --name $name --restart unless-stopped --user $HOST_UID:0
$(printf '%s\n' "$spec" | docker_run_args | tr '\n' ' ')
$image"
        fi
        if [ -f "$file" ] && [ "$(cat "$file")" = "$rendered" ]; then return 1; fi
        printf '%s' "$rendered" > "$file"
        return 0
    }
    docker_start() {   # $1 name, $2 description, $3 image; spec file already written: (re)create the container
        local name="$1" image="$3" args
        "$E" rm -f "$name" >/dev/null 2>&1 || true
        mapfile -t args < <(sed -n '2p' "$SPEC_DIR/$name.docker" | tr ' ' '\n' | sed '/^$/d')
        "$E" run -d --name "$name" --restart unless-stopped --user "$HOST_UID:0" "${args[@]}" "$image" >/dev/null
    }
    stop_container() {   # $1 name: stop it (podman: its unit) without removing anything
        [ "$ENGINE" = podman ] && systemctl --user stop "$(unit_name "$1")" >/dev/null 2>&1
        "$E" stop -t 20 "$1" >/dev/null 2>&1 || true
    }
    remove_container() {   # $1 name: container, unit, definition
        if [ "$ENGINE" = podman ]; then
            systemctl --user disable --now "$(unit_name "$1")" >/dev/null 2>&1 || true
            rm -f "$QUADLET_DIR/$1.container" "$UNIT_DIR/$1.service"
            systemctl --user daemon-reload
            systemctl --user reset-failed "$(unit_name "$1")" >/dev/null 2>&1 || true
        fi
        "$E" rm -f "$1" >/dev/null 2>&1 || true
        rm -f "$SPEC_DIR/$1.docker"
    }

    # -- the 3.1 two-container shape: move the central server's state in -------
    # The central server's data (client registry, encrypted Yjs snapshots)
    # and keys (the Yjs encryption key - without it every shared document
    # is unreadable - and the account-ticket key) MOVE from the old state
    # dir into the console's data dir, where the one container finds them
    # at /data/central. Done before the new container starts, with the old
    # central container stopped (it writes those files). Each of the two
    # directories is one rename on the same filesystem: a run interrupted
    # between them resumes - a directory already moved is left where it is,
    # one not moved yet is moved; a directory present on both sides with
    # content stops the run (nothing is ever overwritten or merged). The
    # old container, its unit, the network and the central image are
    # removed only once the new container is healthy; until then they are
    # the rollback: migrate_central_undo puts the state back, restores the
    # console's previous definition and starts the central server again.
    MIGRATED=""        # the directories this run moved (undo moves them back)
    MIGRATION_SAVED="" # the console definition before this run (restored on undo)
    migrate_central() {
        local sub src dst
        legacy_central_present || return 0
        if container_exists "$CENTRAL_NAME"; then
            say "central server: stopping the separate container $CENTRAL_NAME (its state moves into the console's data dir)"
            stop_container "$CENTRAL_NAME"
        fi
        mkdir -p "$CENTRAL_STATE"
        for sub in data keys; do
            src="$LEGACY_CENTRAL/$sub"; dst="$CENTRAL_STATE/$sub"
            [ -d "$src" ] || continue
            if is_empty_dir "$dst"; then rmdir "$dst"; fi
            if [ -e "$dst" ]; then
                if is_empty_dir "$src"; then rmdir "$src"; continue; fi
                die "central server state exists on both sides: $src and $dst both have content - move one away by hand (nothing was changed)"
            fi
            mv "$src" "$dst" || die "could not move $src to $dst"
            MIGRATED="$MIGRATED $sub"
            say "central server: moved $src -> $dst"
        done
        # the 3.1 env files held copies of the keys for the two containers; the
        # one container reads the key files themselves
        rm -f "$CENTRAL_STATE/keys/console.env" "$CENTRAL_STATE/keys/central.env" "$CENTRAL_STATE/keys/console.env.tmp" "$CENTRAL_STATE/keys/central.env.tmp"
        return 0
    }
    # The enrollment secret of 3.0/3.1 (<central state>/keys/enrollment.secret)
    # has no reader any more: the central server in the container recognises
    # signed-in users by the account-ticket key alone. It is removed once the
    # container is up - and only when the central server really runs that way:
    # the ticket key exists and the console's definition configures no
    # ENROLLMENT_SECRET (nor runs without the embedded central server). Nothing
    # to do when the file is gone already (every run passes here).
    retire_enrollment_secret() {
        local f="$CENTRAL_STATE/keys/enrollment.secret"
        [ -e "$f" ] || return 0
        if [ -s "$CENTRAL_STATE/keys/account-ticket.key" ] && ! grep -Eq '^Env=(ENROLLMENT_SECRET=|JACARIUM_CENTRAL=off|CENTRAL_UPSTREAM=)' "$(definition_file "$CONSOLE_NAME")" 2>/dev/null; then
            rm -f "$f" && say "central server: removed the enrollment secret of 3.0/3.1 ($f) - signed-in users are recognised by the account-ticket key, nothing reads it any more"
        else
            warn "central server: $f is left in place (the central server does not run account-ticket-only here)"
        fi
        return 0
    }
    migrate_central_undo() {
        local sub
        for sub in $MIGRATED; do
            if [ -d "$CENTRAL_STATE/$sub" ] && [ ! -e "$LEGACY_CENTRAL/$sub" ]; then
                mv "$CENTRAL_STATE/$sub" "$LEGACY_CENTRAL/$sub" && warn "central server: moved $CENTRAL_STATE/$sub back to $LEGACY_CENTRAL/$sub"
            fi
        done
        MIGRATED=""
        if [ -n "$MIGRATION_SAVED" ] && [ -f "$MIGRATION_SAVED" ]; then
            cp -f "$MIGRATION_SAVED" "$(definition_file "$CONSOLE_NAME")"
            [ "$ENGINE" = podman ] && systemctl --user daemon-reload
            warn "central server: the console's previous definition is back"
        fi
        if container_exists "$CENTRAL_NAME"; then
            if [ "$ENGINE" = podman ]; then systemctl --user start "$(unit_name "$CENTRAL_NAME")" >/dev/null 2>&1 || "$E" start "$CENTRAL_NAME" >/dev/null 2>&1 || true
            else "$E" start "$CENTRAL_NAME" >/dev/null 2>&1 || true; fi
            warn "central server: the separate container $CENTRAL_NAME is running again"
        fi
    }
    migrate_central_finish() {
        local id t
        container_exists "$CENTRAL_NAME" || [ -d "$LEGACY_CENTRAL" ] || [ -f "$(definition_file "$CENTRAL_NAME")" ] || "$E" network inspect "$NET_NAME" >/dev/null 2>&1 || return 0
        if container_exists "$CENTRAL_NAME" || [ -f "$(definition_file "$CENTRAL_NAME")" ]; then
            remove_container "$CENTRAL_NAME"
            say "central server: the separate container, its unit and definition are removed"
        fi
        rm -f "$BASE/deploy/jacarium-central.$CENTRAL_TAG.srcid"
        "$E" network rm "$NET_NAME" >/dev/null 2>&1 && say "container network $NET_NAME removed"
        # the central image is no longer used by anything (kept until now as the rollback aid)
        if [ "$ENGINE" = docker ]; then
            for t in "$CENTRAL_TAG" previous failed; do "$E" rmi "localhost/jacarium-central:$t" >/dev/null 2>&1 || true; done
            docker image prune -f --filter "label=com.jacarium.image=central" >/dev/null 2>&1 || true
        else
            for id in $(podman images --filter "label=com.jacarium.image=central" --format '{{.ID}}' | awk 'NF && !seen[$1]++'); do
                podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | awk -v id="$id" '$1 == id && $2 !~ /<none>/ {print $2}' | while read -r t; do podman rmi "$t" >/dev/null 2>&1 || true; done
                podman image exists "$id" 2>/dev/null && podman rmi "$id" >/dev/null 2>&1 || true
            done
        fi
        say "central server: the 3.1 central image is removed"
        # what is left of the old state dir (a certs/ of a standalone server, empty dirs)
        if [ -d "$LEGACY_CENTRAL" ]; then
            rm -rf "$LEGACY_CENTRAL/certs"
            rmdir "$LEGACY_CENTRAL" 2>/dev/null || warn "central server: $LEGACY_CENTRAL is not empty and was left in place"
        fi
        [ -n "$MIGRATION_SAVED" ] && rm -f "$MIGRATION_SAVED"
        MIGRATION_SAVED=""
        return 0
    }

    # -- the container ---------------------------------------------------------
    RESTART_NEEDED=""
    mkdir -p "$CONSOLE_DATA"
    if [ "$CERT_CHANGED" = yes ] && [ -f "$CONSOLE_DATA/certs/cert.pem" ]; then
        mv -f "$CONSOLE_DATA/certs/cert.pem" "$CONSOLE_DATA/certs/cert.pem.previous"
        mv -f "$CONSOLE_DATA/certs/key.pem" "$CONSOLE_DATA/certs/key.pem.previous"
        warn "the address / names changed: the console certificate is regenerated on start (browsers must accept it again)"
        RESTART_NEEDED=yes
    fi
    TLS_SAN="${WANT_CERT_SAN#IP:$ADDRESS}"; TLS_SAN="${TLS_SAN#,}"
    # behind a reverse proxy on this host the console listens on loopback
    # only (the proxy is the only way in); the entrypoint's certificate
    # already carries localhost / 127.0.0.1, the proxy does not verify it
    CONSOLE_BIND="$ADDRESS"; [ -n "$PUBLIC_URL" ] && CONSOLE_BIND="127.0.0.1"
    # The CA root of the certificate clients see, for the desktop app to pin
    # (electron/tls-trust.cjs): behind a reverse proxy it is the proxy's,
    # read out of its container (exec cat: read-only, nothing in that
    # container is touched) into <data>/tls/root.crt, which the console
    # serves at /api/tls/root.crt; the console reads the file per request, so
    # a refreshed root needs no restart. Without a proxy the console's own
    # certificate is the root and the backend serves that (JACARIUM_BEHIND_PROXY
    # unset); behind a proxy without --proxy-ca-from the endpoint answers 404.
    if [ -n "$PROXY_CA_FROM" ]; then
        mkdir -p "$CONSOLE_DATA/tls"
        if "$E" exec "$PROXY_CA_FROM" cat "$PROXY_CA_PATH" > "$CONSOLE_DATA/tls/root.crt.tmp" 2>/dev/null \
           && openssl x509 -noout -in "$CONSOLE_DATA/tls/root.crt.tmp" >/dev/null 2>&1; then
            if ! cmp -s "$CONSOLE_DATA/tls/root.crt.tmp" "$CONSOLE_DATA/tls/root.crt" 2>/dev/null; then
                mv -f "$CONSOLE_DATA/tls/root.crt.tmp" "$CONSOLE_DATA/tls/root.crt"; chmod 644 "$CONSOLE_DATA/tls/root.crt"
                say "reverse proxy CA root: $(openssl x509 -noout -subject -in "$CONSOLE_DATA/tls/root.crt" 2>/dev/null | sed 's/^subject=//') from container $PROXY_CA_FROM, served at /api/tls/root.crt"
            else
                rm -f "$CONSOLE_DATA/tls/root.crt.tmp"
            fi
        else
            rm -f "$CONSOLE_DATA/tls/root.crt.tmp"
            if [ -s "$CONSOLE_DATA/tls/root.crt" ]; then warn "could not read $PROXY_CA_PATH from container $PROXY_CA_FROM (is it running?); the root served so far stays"
            else warn "could not read $PROXY_CA_PATH from container $PROXY_CA_FROM (is it running? is the path right?): no CA root is served, the desktop app pins the proxy's leaf certificate"; fi
        fi
    elif [ -n "$PUBLIC_URL" ] && [ -s "$CONSOLE_DATA/tls/root.crt" ]; then
        say "reverse proxy CA root: keeping the one at $CONSOLE_DATA/tls/root.crt (give --proxy-ca-from to refresh it, or remove the file)"
    fi
    if legacy_central_present; then
        # keep the console's current definition for the undo path, then move the state
        DEF="$(definition_file "$CONSOLE_NAME")"
        if [ -f "$DEF" ]; then MIGRATION_SAVED="$BASE/deploy/$CONSOLE_NAME.definition.pre32"; cp -f "$DEF" "$MIGRATION_SAVED"; fi
        migrate_central
        RESTART_NEEDED=yes
    fi
    if define_container "$CONSOLE_NAME" "Jacarium (browser deployment with the central server)" "localhost/jacarium:$CONSOLE_TAG" <<EOF
HostName=$CONSOLE_NAME
Publish=$CONSOLE_BIND:$CONSOLE_PORT:8443
Volume=$CONSOLE_DATA:/data
Env=TLS_SAN=IP:$ADDRESS${TLS_SAN:+,$TLS_SAN}
Env=JACARIUM_AUTH_MODE=$AUTH_MODE
${PUBLIC_URL:+Env=JACARIUM_BEHIND_PROXY=1}
EOF
    then RESTART_NEEDED=yes; fi
    mv -f "$CONF.tmp" "$CONF"
    [ "$ENGINE" = podman ] && systemctl --user daemon-reload

    # -- start / update, health-check, roll back ---------------------------------
    wait_healthy() {   # $1 container, $2 seconds
        local i status
        for i in $(seq 1 "$2"); do
            status="$(container_health "$1")"
            case "$status" in
                healthy) return 0 ;;
                unhealthy|exited|dead) [ "$i" -gt 20 ] && return 1 ;;
            esac
            sleep 1
        done
        return 1
    }
    start_container() {   # $1 name, $2 description, $3 image
        if [ "$ENGINE" = podman ]; then
            systemctl --user enable "$(unit_name "$1")" >/dev/null 2>&1 || true
            systemctl --user restart "$(unit_name "$1")" 2>&1 | sed 's/^/[remote]   /' || true
        else
            docker_start "$1" "$2" "$3" 2>&1 | sed 's/^/[remote]   /'
        fi
    }
    prune_images() {   # keep :tag and :previous, remove the rest of ours (label deploy)
        local keep1 keep2 id in_use
        keep1="$(image_id "localhost/jacarium:$CONSOLE_TAG")"; keep2="$(image_id "localhost/jacarium:previous")"
        if [ "$ENGINE" = docker ]; then
            # untagged images of this project only; tagged ones (:tag, :previous, :failed) stay
            docker image prune -f --filter "label=com.jacarium.image=deploy" >/dev/null 2>&1 || true
            return 0
        fi
        in_use="$(podman ps -a --format '{{.ImageID}}')"
        for id in $(podman images --filter "label=com.jacarium.image=deploy" --format '{{.ID}}' | awk 'NF && !seen[$1]++'); do
            case "$keep1$keep2" in *"$id"*) continue ;; esac
            echo "$in_use" | grep -q "^$id" && continue
            podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | awk -v id="$id" '$1 == id && $2 !~ /<none>/ {print $2}' | while read -r t; do podman rmi "$t" >/dev/null 2>&1 || true; done
            podman image exists "$id" 2>/dev/null && podman rmi "$id" >/dev/null 2>&1 || true
        done
    }
    update_console() {
        local name="$CONSOLE_NAME" image=jacarium tag="$CONSOLE_TAG" wait=240 desc="Jacarium (browser deployment with the central server)"
        local want current
        want="$(image_id "localhost/$image:$tag")"
        [ -n "$want" ] || die "console: image localhost/$image:$tag is not on this host"
        current="$(container_image_id "$name")"
        if unchanged_inputs && [ -n "$current" ] && [ -z "$RESTART_NEEDED" ] && [ "$(container_health "$name")" = healthy ]; then
            say "console: unchanged (built from the same inputs, healthy) - not restarting"
            [ "$ENGINE" = podman ] && { systemctl --user is-enabled "$(unit_name "$name")" >/dev/null 2>&1 || systemctl --user enable "$(unit_name "$name")" >/dev/null 2>&1 || true; }
            return 0
        fi
        if [ "$current" = "$want" ] && [ -z "$RESTART_NEEDED" ] && [ "$(container_health "$name")" = healthy ]; then
            say "console: unchanged (image ${want:0:12}, healthy) - not restarting"
            [ "$ENGINE" = podman ] && { systemctl --user is-enabled "$(unit_name "$name")" >/dev/null 2>&1 || systemctl --user enable "$(unit_name "$name")" >/dev/null 2>&1 || true; }
            prune_images
            return 0
        fi
        if [ -n "$current" ] && [ "$current" != "$want" ]; then
            "$E" tag "$current" "localhost/$image:previous" 2>/dev/null && say "console: previous image kept as localhost/$image:previous for rollback"
        fi
        say "console: (re)starting $name with image ${want:0:12} ($MODE)"
        start_container "$name" "$desc" "localhost/$image:$tag"
        if wait_healthy "$name" "$wait"; then
            say "console: healthy (the central server behind /central included)"
            "$E" rmi "localhost/$image:failed" >/dev/null 2>&1 || true   # a kept failed image is obsolete once an update succeeds
            migrate_central_finish
            prune_images
            return 0
        fi
        warn "console: the new container did not become healthy within ${wait}s (state: $(container_health "$name"))"
        "$E" logs --tail 30 "$name" 2>&1 | sed 's/^/[remote]   log: /' || true
        if [ "$ENGINE" = podman ] && journalctl --user -u "$(unit_name "$name")" --no-pager -n 40 2>/dev/null | grep -q "bind: can't assign requested address"; then
            warn "console: podman could not publish on $ADDRESS (bind: can't assign requested address) - this host cannot bind that address rootless; re-run with --address <an address of this host> (127.0.0.1 for this machine only)"
        fi
        if [ -n "$MIGRATED$MIGRATION_SAVED" ]; then
            warn "console: undoing the central server's move (the 3.1 two-container shape comes back)"
            stop_container "$name"
            migrate_central_undo
        fi
        if [ -n "$current" ] && [ "$current" != "$want" ]; then
            warn "console: rolling back to the previous image ${current:0:12}"
            "$E" tag "$want" "localhost/$image:failed" >/dev/null 2>&1 || true
            "$E" tag "$current" "localhost/$image:$tag"
            start_container "$name" "$desc" "localhost/$image:$tag"
            if wait_healthy "$name" "$wait"; then
                warn "console: ROLLED BACK - the previous image is running again; the failed image is tagged localhost/$image:failed"
            else
                warn "console: rollback did not become healthy either (state: $(container_health "$name"))"
            fi
        elif [ -f "$BASE/deploy/$CONSOLE_NAME.definition.pre32" ]; then
            # the same image, only the definition changed: start it as it was
            start_container "$name" "$desc" "localhost/$image:$tag"
            wait_healthy "$name" "$wait" && warn "console: the previous definition is running again"
        fi
        return 1
    }
    update_console || exit $?
    retire_enrollment_secret
    exit 0
    ;;

status)
    load_conf
    echo "instance: $INSTANCE  engine: $ENGINE  mode: ${MODE:-?}  address: ${ADDRESS:-?}  sign-in: $AUTH_MODE  central: in the container, behind /central"
    if [ "$AUTH_MODE" = accounts ] && [ -s "$CONSOLE_DATA/setup-code" ]; then
        echo "first run: no account exists yet - create the administrator on the sign-in page with the setup code in $CONSOLE_DATA/setup-code"
    fi
    if [ "$ENGINE" = podman ]; then
        echo "reboots: linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown) (must be yes)"
    else
        echo "reboots: docker service $(systemctl is-enabled docker 2>/dev/null || echo unknown); container uses --restart unless-stopped"
    fi
    echo "--- console + central ($CONSOLE_NAME)"
    if [ "$ENGINE" = podman ]; then
        echo "  unit:      $(systemctl --user is-enabled "$(unit_name "$CONSOLE_NAME")" 2>/dev/null || echo not-installed) / $(systemctl --user is-active "$(unit_name "$CONSOLE_NAME")" 2>/dev/null || echo inactive)"
    else
        echo "  restart:   $("$E" inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$CONSOLE_NAME" 2>/dev/null || echo n/a)"
    fi
    echo "  container: $("$E" ps -a --filter "name=^$CONSOLE_NAME\$" --format '{{.Status}}' 2>/dev/null | head -1)  health: $(container_health "$CONSOLE_NAME")  (unhealthy when the console OR the central server is down)"
    echo "  image:     $(image_id "localhost/jacarium:$CONSOLE_TAG" | cut -c1-12)  previous: $(image_id "localhost/jacarium:previous" | cut -c1-12)"
    if [ -n "$PUBLIC_URL" ]; then
        echo "  url:       $PUBLIC_URL  (through the reverse proxy; the console listens on 127.0.0.1:$CONSOLE_PORT)"
        echo "  central:   $PUBLIC_URL/central/api/health"
    else
        echo "  url:       https://${NAME:-$ADDRESS}:$CONSOLE_PORT  (by address: https://$ADDRESS:$CONSOLE_PORT)"
        echo "  central:   https://${NAME:-$ADDRESS}:$CONSOLE_PORT/central/api/health"
    fi
    echo "  state:     $CONSOLE_DATA (the central server's under central/)"
    if legacy_central_present; then
        echo "--- 3.1 central server still present ($CENTRAL_NAME, $LEGACY_CENTRAL): the next deploy moves it into the container"
    fi
    ;;

logs)
    load_conf
    # (the one container carries the central server's lines with a [central] prefix)
    exec "$E" logs --tail "${2:-100}" -f "$CONSOLE_NAME"
    ;;

stop|start)
    load_conf
    if [ "$ENGINE" = podman ]; then
        systemctl --user "$CMD" "$(unit_name "$CONSOLE_NAME")" 2>&1 | sed 's/^/[remote]   /'
    else
        "$E" "$CMD" "$CONSOLE_NAME" >/dev/null 2>&1 || true
    fi
    say "console: $CMD"
    ;;

uninstall)
    load_conf
    PURGE="${1:-}"
    for pair in "console:$CONSOLE_NAME:jacarium:$CONSOLE_TAG" "central:$CENTRAL_NAME:jacarium-central:$CENTRAL_TAG"; do
        IFS=: read -r comp name image tag <<< "$pair"
        if [ "$ENGINE" = podman ]; then
            systemctl --user disable --now "$(unit_name "$name")" >/dev/null 2>&1 || true
            rm -f "$QUADLET_DIR/$name.container" "$UNIT_DIR/$name.service"
            systemctl --user daemon-reload
            systemctl --user reset-failed "$(unit_name "$name")" >/dev/null 2>&1 || true   # forget a failed record, or the user manager stays "degraded"
        fi
        "$E" rm -f "$name" >/dev/null 2>&1 || true
        rm -f "$BASE/deploy/spec/$name.docker" "$BASE/deploy/$image.$tag.srcid" "$BASE/deploy/$name.definition.pre32"
        for t in "$tag" previous failed; do "$E" rmi "localhost/$image:$t" >/dev/null 2>&1 || true; done
        [ "$comp" = console ] && say "container, definition and images removed"
    done
    [ "$ENGINE" = podman ] && systemctl --user daemon-reload
    "$E" network rm "$NET_NAME" >/dev/null 2>&1 && say "container network $NET_NAME removed"
    if [ "$PURGE" = "--purge" ]; then
        rm -rf "$CONSOLE_DATA" "$LEGACY_CENTRAL" "$CONF"
        [ "$INSTANCE" != default ] && rm -rf "$BASE/instances/$INSTANCE"
        say "state removed (data dir with the central server's state, config)"
    else
        say "state kept: $CONSOLE_DATA (the central server's under central/), $CONF (use --purge to remove)"
    fi
    ;;

*)
    die "unknown command: $CMD"
    ;;
esac
