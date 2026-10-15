#!/bin/bash
# Start the Flask backend on its own (the desktop app starts it itself; this
# is for the Vite dev server - `npm run dev` without Electron - and for tests).
#
#   ./start-backend.sh            http://127.0.0.1:8080 (PORT to change it)
#   ./start-backend.sh --help
#
# Creates backend/venv with Python 3.14 when missing (requirements.lock is
# resolved for 3.14, the version the container runs too) and installs
# requirements.txt against the lock whenever either file is newer than the
# last install. ~/.jacarium.env (the Settings file) is loaded into the
# environment when it exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/scripts/lib.sh"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    "") ;;
    *) log_error "unknown option: $1"; usage; exit 1 ;;
esac

cd "$SCRIPT_DIR/backend"
PORT="${PORT:-8080}"

if [ ! -d venv ]; then
    PY="$(command -v python3.14 || command -v python3 || true)"
    [ -n "$PY" ] || die "python3.14 not found (brew install python@3.14, or your distribution's python3.14)"
    log_info "creating the virtual environment with $PY"
    "$PY" -m venv venv
fi
PYTHON="$PWD/venv/bin/python"

STAMP=venv/.requirements_installed
if [ ! -f "$STAMP" ] || [ requirements.txt -nt "$STAMP" ] || [ requirements.lock -nt "$STAMP" ]; then
    log_info "installing Python requirements (requirements.txt against requirements.lock)"
    "$PYTHON" -m pip install -q -r requirements.txt -c requirements.lock
    touch "$STAMP"
    log_success "requirements installed"
else
    log_info "requirements up to date"
fi

if [ -f "$HOME/.jacarium.env" ]; then
    log_info "loading ~/.jacarium.env"
    set -a
    # shellcheck disable=SC1091
    . "$HOME/.jacarium.env"
    set +a
else
    log_info "no ~/.jacarium.env - integrations are configured in the app's Settings"
fi

echo ""
echo "==========================================="
echo "  Flask backend"
echo "  URL: http://127.0.0.1:$PORT"
echo "  Press Ctrl+C to stop"
echo "==========================================="
echo ""
export PORT
exec "$PYTHON" app.py
