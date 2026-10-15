#!/bin/bash
# Container entrypoint (deploy/Containerfile): prepare /data, make sure a
# TLS certificate and the central server's keys exist, then run gunicorn
# (Flask backend, loopback only), the central server (Node, loopback only,
# supervised) and Caddy (HTTPS front door). Runs as the unprivileged user
# 1001; PID 1 is this script, which forwards TERM/INT to the three
# processes and waits for them.
set -euo pipefail

DATA_DIR="${HOME:-/data}"
CERT_FILE="${TLS_CERT_FILE:-/data/certs/cert.pem}"
KEY_FILE="${TLS_KEY_FILE:-/data/certs/key.pem}"
BACKEND_PORT="${PORT:-8080}"
GUNICORN_THREADS="${GUNICORN_THREADS:-32}"
CENTRAL_PORT="${CENTRAL_PORT:-3000}"
CENTRAL_STATE="$DATA_DIR/central"

log() { echo "[entrypoint] $*"; }

# --- /data layout ----------------------------------------------------------
mkdir -p "$DATA_DIR/certs" "$DATA_DIR/reports" "$DATA_DIR/.ssh" \
         "$DATA_DIR/.jacarium" "$DATA_DIR/.task" "$DATA_DIR/users"
chmod 700 "$DATA_DIR/users"
chmod 700 "$DATA_DIR/.ssh"
touch "$DATA_DIR/.ssh/known_hosts"

# Taskwarrior: a minimal rc file so `task` never prompts to create one.
if [ ! -f "$DATA_DIR/.taskrc" ]; then
  cat > "$DATA_DIR/.taskrc" <<EOF
# Jacarium - Taskwarrior configuration (container)
data.location=$DATA_DIR/.task
confirmation=off
EOF
  log "wrote $DATA_DIR/.taskrc"
fi

# --- TLS certificate ------------------------------------------------------
# Self-signed on first start. To use your own certificate, put cert.pem and
# key.pem in <data>/certs before starting (or point TLS_CERT_FILE /
# TLS_KEY_FILE at mounted files). TLS_SAN adds names to the generated
# certificate, e.g. TLS_SAN="DNS:console.example.internal,IP:192.168.1.20".
if [ ! -s "$CERT_FILE" ] || [ ! -s "$KEY_FILE" ]; then
  if [ "$CERT_FILE" != "/data/certs/cert.pem" ] || [ "$KEY_FILE" != "/data/certs/key.pem" ]; then
    log "ERROR: TLS_CERT_FILE / TLS_KEY_FILE point at missing files: $CERT_FILE $KEY_FILE"
    exit 1
  fi
  SAN="DNS:localhost,IP:127.0.0.1"
  if [ -n "${TLS_SAN:-}" ]; then
    SAN="$SAN,${TLS_SAN}"
  fi
  log "generating a self-signed certificate ($SAN)"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -subj "/CN=jacarium" \
    -addext "subjectAltName=$SAN" \
    -addext "basicConstraints=CA:FALSE" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
  chmod 600 "$KEY_FILE"
  log "certificate written to $CERT_FILE (import it in the browser, or replace it with your own)"
fi

# --- the central server's place and keys ----------------------------------
# JACARIUM_CENTRAL=off: no central server (no /central route, no team
# features). CENTRAL_UPSTREAM=host:port: forward /central to a central
# server running elsewhere (then nothing is started here and that server
# must hold the same account-ticket key). Default: the embedded one on
# loopback, its state under /data/central: data/ (client registry,
# encrypted Yjs snapshots) and keys/ (the Yjs encryption key - losing it
# makes every persisted shared document unreadable - and the account-ticket
# key the backend signs tickets with). Both keys are generated once, 0600.
CENTRAL_MODE=embedded
if [ "${JACARIUM_CENTRAL:-on}" = off ]; then CENTRAL_MODE=off
elif [ -n "${CENTRAL_UPSTREAM:-}" ]; then CENTRAL_MODE=external
else CENTRAL_UPSTREAM="127.0.0.1:${CENTRAL_PORT}"; fi
rm -f /tmp/central.expected
YJS_STORAGE_ENCRYPTION_KEY=""; ACCOUNT_TICKET_KEY=""
if [ "$CENTRAL_MODE" = embedded ]; then
  mkdir -p "$CENTRAL_STATE/data" "$CENTRAL_STATE/keys"
  chmod 700 "$CENTRAL_STATE/keys"
  for k in yjs-encryption account-ticket; do
    if [ ! -s "$CENTRAL_STATE/keys/$k.key" ]; then
      (umask 077; openssl rand -hex 32 > "$CENTRAL_STATE/keys/$k.key")
      log "generated $CENTRAL_STATE/keys/$k.key$([ "$k" = yjs-encryption ] && echo ' - back it up: shared documents are encrypted with it')"
    fi
  done
  # read once here; the processes get them through their environment, never argv
  YJS_STORAGE_ENCRYPTION_KEY="$(tr -d ' \n' < "$CENTRAL_STATE/keys/yjs-encryption.key")"
  ACCOUNT_TICKET_KEY="$(tr -d ' \n' < "$CENTRAL_STATE/keys/account-ticket.key")"
  export JACARIUM_CENTRAL_TICKET_KEY="$ACCOUNT_TICKET_KEY"
  touch /tmp/central.expected   # the health check asks /central too (the embedded server is ours to keep up)
fi
if [ "$CENTRAL_MODE" != off ]; then
  # (external: the key arrives in JACARIUM_CENTRAL_TICKET_KEY from the deploy,
  # as in 3.1, and that other container's health is its own)
  export JACARIUM_CENTRAL_PATH="${JACARIUM_CENTRAL_PATH:-/central}"
  export CENTRAL_UPSTREAM
fi

# --- processes ------------------------------------------------------------
# The hashed UI assets of this build join the previous build's on the data
# volume (deploy/Caddyfile serves /assets/* from there): a browser tab that
# was open during a redeploy can still fetch the chunks its index.html
# names. Only the two most recent builds are kept.
UI_ASSETS="$DATA_DIR/ui-assets"
mkdir -p "$UI_ASSETS/assets" "$UI_ASSETS/.builds"
BUILD_ID="$(sha256sum /app/ui/index.html | cut -c1-16)"
ls /app/ui/assets > "$UI_ASSETS/.builds/$BUILD_ID.list"
touch "$UI_ASSETS/.builds/$BUILD_ID.list"
cp -f /app/ui/assets/* "$UI_ASSETS/assets/" 2>/dev/null || true
# keep the newest two build lists, drop files that belong to neither
ls -t "$UI_ASSETS/.builds"/*.list 2>/dev/null | tail -n +3 | xargs -r rm -f
cat "$UI_ASSETS/.builds"/*.list 2>/dev/null | sort -u > "$UI_ASSETS/.keep"
for f in "$UI_ASSETS/assets"/*; do
  [ -f "$f" ] || continue
  grep -qxF -- "$(basename "$f")" "$UI_ASSETS/.keep" || rm -f -- "$f"
done
log "ui assets: build $BUILD_ID ($(wc -l < "$UI_ASSETS/.builds/$BUILD_ID.list" | tr -d ' ') files), $(ls "$UI_ASSETS/.builds" | wc -l | tr -d ' ') build(s) kept on the volume"

cd /app/backend
log "starting the backend on 127.0.0.1:${BACKEND_PORT} (auth mode: ${JACARIUM_AUTH_MODE:-app-token})"
if [ "${JACARIUM_AUTH_MODE:-}" = accounts ] && [ ! -s "$DATA_DIR/accounts.sqlite" ]; then
  log "sign-in is on and no account exists yet: the backend prints a one-time setup code below (also written to $DATA_DIR/setup-code)"
fi
gunicorn \
  --bind "127.0.0.1:${BACKEND_PORT}" \
  --workers 1 \
  --worker-class gthread \
  --threads "$GUNICORN_THREADS" \
  --timeout 600 \
  --graceful-timeout 20 \
  --access-logfile - \
  --error-logfile - \
  app:app &
BACKEND_PID=$!

# The central server: loopback only (Caddy is its only client), plain HTTP
# behind Caddy's TLS, client addresses from X-Forwarded-For, its state on
# the volume. Supervised: a crash is restarted after a short pause (1 s,
# then doubling up to 30 s while it keeps failing; a server that ran for a
# minute resets the pause), the console stays up meanwhile and the health
# check reports the gap. SIGTERM reaches the node process itself, which
# flushes its Yjs documents before it exits; the loop ends with it.
CENTRAL_PID=""
CENTRAL_STOP=/tmp/central.stop
rm -f "$CENTRAL_STOP"
central_loop() {
  local pause=1 started status
  while [ ! -e "$CENTRAL_STOP" ]; do
    started=$(date +%s)
    PORT="$CENTRAL_PORT" HOST=127.0.0.1 USE_HTTPS=false TRUST_PROXY=1 \
      DATA_DIR="$CENTRAL_STATE/data" \
      YJS_STORAGE_ENCRYPTION_KEY="$YJS_STORAGE_ENCRYPTION_KEY" \
      ACCOUNT_TICKET_KEY="$ACCOUNT_TICKET_KEY" \
      node /app/central/server.js > >(sed -u 's/^/[central] /') 2>&1 &
    CENTRAL_NODE_PID=$!
    echo "$CENTRAL_NODE_PID" > /tmp/central.pid
    wait "$CENTRAL_NODE_PID" && status=0 || status=$?
    [ -e "$CENTRAL_STOP" ] && break
    if [ $(( $(date +%s) - started )) -ge 60 ]; then pause=1; fi
    log "central server exited with status $status; restarting in ${pause}s"
    sleep "$pause"
    pause=$(( pause * 2 )); [ "$pause" -gt 30 ] && pause=30
  done
}
if [ "$CENTRAL_MODE" = embedded ]; then
  log "starting the central server on 127.0.0.1:${CENTRAL_PORT} (state: $CENTRAL_STATE, behind /central/)"
  central_loop &
  CENTRAL_PID=$!
elif [ "$CENTRAL_MODE" = external ]; then
  log "central server elsewhere: /central/ is forwarded to ${CENTRAL_UPSTREAM} (nothing started here)"
fi

# Caddy: the /central block only when a central server is expected;
# otherwise it leaves the Caddyfile so the path is an ordinary unknown
# route, not a 502.
CADDYFILE=/app/Caddyfile
if [ "$CENTRAL_MODE" = off ]; then
  CADDYFILE=/tmp/Caddyfile
  sed '/# >>> central/,/# <<< central/d' /app/Caddyfile > "$CADDYFILE"
  log "no central server (JACARIUM_CENTRAL=off): no /central route, no team features"
fi
log "starting caddy on https://:${HTTPS_PORT:-8443}"
caddy run --config "$CADDYFILE" --adapter caddyfile &
CADDY_PID=$!

shutdown() {
  log "stopping"
  touch "$CENTRAL_STOP"
  kill -TERM "$CADDY_PID" "$BACKEND_PID" 2>/dev/null || true
  [ -s /tmp/central.pid ] && kill -TERM "$(cat /tmp/central.pid)" 2>/dev/null || true
  wait "$CADDY_PID" "$BACKEND_PID" 2>/dev/null || true
  [ -n "$CENTRAL_PID" ] && wait "$CENTRAL_PID" 2>/dev/null || true
}
trap shutdown TERM INT

# Caddy or the backend dying ends the container (the runtime's restart
# policy brings it back); the central server is restarted in place above.
wait -n "$BACKEND_PID" "$CADDY_PID"
STATUS=$?
log "a process exited with status $STATUS; shutting down"
shutdown
exit "$STATUS"
