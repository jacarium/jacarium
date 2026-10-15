#!/bin/bash

# Runs every test in tests/ and prints a summary.
#
# .mjs tests are run with `node`. .py tests are run with the backend's own
# venv interpreter (backend/venv/bin/python) since they import Flask modules
# from backend/ - falls back to plain `python3` with a warning if that venv
# doesn't exist.
#
# Checks dependencies up front (see check_dependencies below) and reports
# anything missing with the exact command to fix it, rather than letting each
# test fail one at a time with its own scattered error. jsdom/fake-indexeddb
# are auto-installed if missing (npm install --no-save, per the convention
# documented in each test file's header - safe, doesn't touch package.json).
# Everything else (node_modules, backend/venv, the TaskWarrior CLI) is only
# reported, never auto-installed, since those touch the system or need a
# deliberate setup step.
#
# Real-browser tests (export-import-theme.test.mjs,
# documents-import-theme.test.mjs, notice-banner-theme.test.mjs,
# documents-find-in-files-live.test.mjs, tailwind-visual-regression.test.mjs,
# browser-mode.test.mjs: Vite dev server + headless Chrome, see tests/helpers/live-documents-app.mjs)
# and the real-Electron tests (pdf-export-electron.test.mjs,
# documents-mermaid-live.test.mjs, documents-pdf-trailing-page.test.mjs,
# documents-code-highlight-live.test.mjs: Vite dev server + the Electron app
# via Playwright on a throwaway profile, see tests/helpers/electron-app.mjs;
# the PDF export only exists in the desktop app; SKIPs on
# SKIP_ELECTRON_TESTS=1 or when playwright-core / a GUI is unavailable)
# SKIP with exit code 0 and a
# "SKIP:" line when no Chrome/Chromium binary is found or
# SKIP_BROWSER_TESTS=1 is set, so the suite stays green on machines without
# a browser; set CHROME_BIN to run them there.
#
# Usage:
#   ./tests/run-all.sh
#
# Exit code: 0 if every test passed, 1 if any failed or a required
# dependency is missing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$REPO_ROOT/backend/venv/bin/python"

cd "$REPO_ROOT" || exit 1

MISSING=0

check_dependencies() {
    echo "Checking dependencies..."
    echo ""

    # Needed by every .mjs test (socket.io-client, yjs, ...)
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        echo "❌ node_modules/ missing at repo root"
        echo "   Fix: npm install"
        MISSING=1
    else
        echo "✓ node_modules/ present"
    fi

    # Needed by the jacarium-central-backed .mjs tests (they spawn a real
    # server instance)
    if [ ! -d "$REPO_ROOT/jacarium-central/node_modules" ]; then
        echo "❌ jacarium-central/node_modules/ missing"
        echo "   Fix: cd jacarium-central && npm install"
        MISSING=1
    else
        echo "✓ jacarium-central/node_modules/ present"
    fi

    # Needed by the tests that mount real React components in jsdom
    # (cloud-upload-live-sync, collab-cursor-rendering,
    # yjs-server-doc-load-failure) - deliberately not in package.json, see
    # those test files' header comments. Safe to auto-install: --no-save
    # never touches package.json/package-lock.json.
    if [ -d "$REPO_ROOT/node_modules/jsdom" ] && [ -d "$REPO_ROOT/node_modules/fake-indexeddb" ]; then
        echo "✓ jsdom + fake-indexeddb present"
    else
        echo "⚠️  jsdom and/or fake-indexeddb missing (needed by the jsdom-based tests)"
        echo "   Installing now: npm install --no-save jsdom fake-indexeddb"
        if (cd "$REPO_ROOT" && npm install --no-save jsdom fake-indexeddb > /dev/null 2>&1); then
            echo "✓ installed"
        else
            echo "❌ install failed - run it yourself: npm install --no-save jsdom fake-indexeddb"
            MISSING=1
        fi
    fi

    # Needed by the .py tests (they import Flask/requests from backend/)
    if [ -x "$VENV_PYTHON" ]; then
        echo "✓ backend/venv present"
        PYTHON="$VENV_PYTHON"
    else
        echo "⚠️  backend/venv missing - falling back to plain python3 for .py tests"
        echo "   Fix: cd backend && python3.14 -m venv venv && venv/bin/pip install -r requirements.txt -c requirements.lock"
        PYTHON="python3"
    fi

    # Needed specifically by taskwarrior_purge.test.py
    if command -v task >/dev/null 2>&1; then
        echo "✓ TaskWarrior CLI present ($(task --version 2>/dev/null))"
    else
        echo "❌ TaskWarrior CLI ('task') not found (needed by taskwarrior_purge.test.py)"
        echo "   Fix: brew install task   (macOS)   /   sudo apt install taskwarrior   (Debian/Ubuntu)"
        MISSING=1
    fi

    # Needed specifically by ai_chat_timeout.test.py, taskwarrior_purge.test.py
    # (they spin up the real Flask app briefly)
    if command -v curl >/dev/null 2>&1; then
        echo "✓ curl present"
    else
        echo "❌ curl not found (needed by the Python test suite)"
        MISSING=1
    fi
    if command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
        echo "✓ container engine present (container-deploy.test.mjs builds and runs the browser deployment)"
    else
        echo "⚠️  no podman/docker: container-deploy.test.mjs will SKIP"
    fi

    echo ""
    if [ "$MISSING" -ne 0 ]; then
        echo "⚠️  One or more required dependencies are missing (see ❌ above)."
        echo "   Tests that need them will fail until they're installed."
    fi
    echo ""
}

check_dependencies

declare -a RESULTS=()
FAILED=0

run_test() {
    local file="$1"
    local runner="$2"
    local name
    name="$(basename "$file")"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if "$runner" "$file"; then
        RESULTS+=("PASS  $name")
    else
        RESULTS+=("FAIL  $name")
        FAILED=1
    fi
}

run_node() { node "$1"; }
run_python() { "$PYTHON" "$1"; }

for file in "$SCRIPT_DIR"/*.test.mjs; do
    [ -e "$file" ] || continue
    run_test "$file" run_node
done

for file in "$SCRIPT_DIR"/*.test.py; do
    [ -e "$file" ] || continue
    run_test "$file" run_python
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Summary"
echo "═══════════════════════════════════════════════════"
for line in "${RESULTS[@]}"; do
    echo "  $line"
done
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo "✅ All tests passed"
else
    echo "❌ One or more tests failed"
fi

exit "$FAILED"
