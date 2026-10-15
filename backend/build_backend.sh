#!/bin/bash
# Build script for packaging Flask backend with PyInstaller (run from
# backend/: `npm run backend:build`, rebuild.sh, deploy-to-host.sh publish-desktop --build)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Building Flask backend for platform: $(uname -s)"

# Third-party browser assets for the pages this backend serves itself
# (backend/templates -> /static/vendor/...) are copied from node_modules so no
# CDN is needed at runtime. PyInstaller packages backend/static.
# Requires `npm install` at the repo root to have run (devDependencies).
if [ -d "../node_modules" ]; then
    node ../scripts/vendor-assets.mjs --strict || { echo "Error: vendoring static assets failed"; exit 1; }
else
    echo "Error: ../node_modules missing - run 'npm install' at the repo root first (needed for backend/static/vendor)"
    exit 1
fi

# The venv's own interpreter is used explicitly everywhere below (no
# `source activate`): backend/venv when it exists, else an activated one,
# else a fresh venv.
FRESH_VENV=0
if [ -d "venv" ]; then
    echo "Using the virtual environment backend/venv"
    PYTHON_BIN="$PWD/venv/bin/python3"
elif [ -n "${VIRTUAL_ENV:-}" ]; then
    echo "Using already activated virtual environment: $VIRTUAL_ENV"
    PYTHON_BIN="$VIRTUAL_ENV/bin/python3"
else
    echo "Warning: No virtual environment found!"
    echo "Creating venv..."
    # requirements.lock is resolved for Python 3.14 (what the container runs)
    "$(command -v python3.14 || command -v python3)" -m venv venv
    PYTHON_BIN="$PWD/venv/bin/python3"
    FRESH_VENV=1
fi
[ -x "$PYTHON_BIN" ] || { echo "Error: no Python interpreter at $PYTHON_BIN"; exit 1; }

echo "Using Python: $PYTHON_BIN"
echo "Python version: $($PYTHON_BIN --version)"

# Supply-chain cooldown for every pip install below (pip counterpart of
# .npmrc min-release-age=7): only accept versions uploaded to PyPI at least
# 7 days ago, so a hijacked release can be caught and yanked before this build
# pulls it in. Needs pip >= 26.1; older pip hard-errors on it.
PIP_COOLDOWN="--uploaded-prior-to=P7D"

# Bring the venv's own pip up to date first (security fixes + bundled urllib3),
# scoped to $PYTHON_BIN so the system pip is never touched. A bootstrapped pip
# older than 26.1 cannot express the cooldown for its own upgrade: probe for the
# option offline and do one plain upgrade in that case. Everything after this
# block is cooldown-gated regardless.
if "$PYTHON_BIN" -m pip install "$PIP_COOLDOWN" --help >/dev/null 2>&1; then
    "$PYTHON_BIN" -m pip install -q "$PIP_COOLDOWN" --upgrade pip
else
    echo "Bootstrapped pip predates 26.1 - upgrading it without the release cooldown"
    "$PYTHON_BIN" -m pip install -q --upgrade pip
fi

if [ "$FRESH_VENV" = "1" ]; then
    echo "Installing requirements into the new venv..."
    # requirements.lock pins the whole resolved set (see lock-requirements.sh)
    "$PYTHON_BIN" -m pip install -q --disable-pip-version-check "$PIP_COOLDOWN" -r requirements.txt -c requirements.lock
fi

# Install PyInstaller if not already installed
echo "Installing PyInstaller to venv..."
"$PYTHON_BIN" -m pip install -q --disable-pip-version-check "$PIP_COOLDOWN" pyinstaller

# Clean previous builds
rm -rf build dist

# Build the Flask backend using spec file
# The spec file excludes system libraries to prevent GLIBCXX version conflicts
echo "Running PyInstaller with spec file (excludes system libraries)..."
"$PYTHON_BIN" -m PyInstaller flask-backend.spec

echo ""
echo "Build complete!"
echo "Binary location: dist/flask-backend"
echo ""
echo "Test the binary with: ./dist/flask-backend"
