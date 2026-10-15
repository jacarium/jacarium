#!/bin/bash
# Jacarium central server - quick local run, no container (for local testing only;
# ./deploy-podman.sh is the real deployment).
#
#   ./run.sh                 start on port 3000 (PORT=<n> to change it)
#   ./run.sh --help
#
# Installs node_modules when missing. Documents persist across restarts only
# with YJS_STORAGE_ENCRYPTION_KEY set (see ./generate-yjs-key.sh); without it
# the server runs in memory-only mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-}" in
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    "") ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
esac

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

PORT="${PORT:-3000}"
echo "Starting the central server on port $PORT (Ctrl+C to stop)"
echo ""
PORT="$PORT" exec node server.js
