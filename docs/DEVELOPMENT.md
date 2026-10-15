# Development and building

Running Jacarium from source, building the desktop app, and the Python
dependencies of the backend.

## Development and building

One script per task, each with `--help`:

```bash
./run.sh                          # development: Vite dev server + Electron (hot reload)
./run.sh --profile alice --port 8080 --machine-id alice@test   # a second identity next to the first
./run.sh --packaged               # the app built by ./rebuild.sh (dist-electron/)
./start-backend.sh                # the Flask backend alone (for `npm run dev` without Electron)
./rebuild.sh                      # Linux AppImage, built in a container (podman or docker)
./rebuild.sh --format deb         # another format; --no-container builds on this host
./rebuild.sh --no-container --platform mac   # on a Mac: a dmg (--format "dmg zip" or zip for more)
./rebuild.sh --testing            # a testing build: DevTools open, MACHINE_ID honoured - never ship it
./tests/run-all.sh                # every test
```

`npm run build` (scripts/build-ui.sh) builds the UI alone; `npm run
electron:build:full` builds backend, UI and the package for this machine.
The shell scripts share `scripts/lib.sh` and pass `shellcheck`
(`tests/scripts.test.mjs` checks them, and runs shellcheck when it is
installed: `brew install shellcheck`, or `npm install --no-save shellcheck`).

Local AI models: install [Ollama](https://ollama.com) and leave it on its
default port; Settings > AI Providers offers it.

## Python dependencies

`backend/requirements.txt` lists the backend's direct dependencies;
`backend/requirements.lock` is the full resolved set (every package, one
exact version, for Python 3.14 on Linux, macOS and Windows). The desktop
venv and the container run the same Python minor version, 3.14: the
container image is `ubi9/python-314`, and locally `rebuild.sh` picks
Homebrew's `python@3.14` (`brew install python@3.14`; on Linux, the
distribution's `python3.14` package). Everything that installs the backend -
`start-backend.sh`, `backend/build_backend.sh`, `rebuild.sh` and
`deploy/Containerfile` - runs

```bash
pip install -r requirements.txt -c requirements.lock
```

so the desktop venv, the PyInstaller build and the container end up with the
same versions, and pip refuses to install when the lock no longer satisfies
`requirements.txt`. Edit the lock only through the script:

```bash
backend/lock-requirements.sh                      # after changing requirements.txt
backend/lock-requirements.sh --upgrade-package X  # let one package (and its needs) move
backend/lock-requirements.sh --upgrade            # newest allowed version of everything
backend/venv/bin/pip install -r backend/requirements.txt -c backend/requirements.lock
```

The script uses `uv` (from PATH, or installed into a temporary venv for the
run) and only considers releases published at least 7 days ago, the same
cooldown as `.npmrc` and the pip installs in the build scripts.
`tests/requirements_lock_consistency.test.py` (part of `tests/run-all.sh`)
checks that the lock matches `requirements.txt` and that the venv matches
the lock. To look for known vulnerabilities, audit the lock itself so local
and container are judged on the same versions:

```bash
pip-audit --no-deps -r backend/requirements.lock
```
