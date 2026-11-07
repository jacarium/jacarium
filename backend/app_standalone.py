#!/usr/bin/env python3
"""
Standalone Flask backend for Electron app
Entry point for PyInstaller packaging
"""
# Worker processes (parsers/parallel.py: the Log Collection Histogram reads its logs in a process pool) are started
# by running THIS executable again with multiprocessing's own arguments (--multiprocessing-fork for a spawned
# worker; -c 'from multiprocessing.resource_tracker import main...' for the spawn method's resource tracker).
# freeze_support() - PyInstaller's version, on every platform - recognises those invocations, runs the worker or the
# helper and exits, so a child never gets past this line: no second app, no port bound, nothing below imported.
# First, before anything else (the --runtime-version check included). In a normal run it does nothing.
import multiprocessing

multiprocessing.freeze_support()

import sys  # noqa: E402
import os  # noqa: E402

# `flask-backend --runtime-version` prints the Python frozen into the build
# (X.Y.Z) and exits: the build's check that the installers carry the pinned
# CPython (rebuild.sh, build.yml). Before the app import so nothing else runs.
if len(sys.argv) == 2 and sys.argv[1] == '--runtime-version':
    import platform
    print(platform.python_version())
    sys.exit(0)

# `flask-backend --selftest-parallel` runs a small job through the worker pool (parsers/parallel.py) and prints the
# result as JSON, then exits without starting the app: the packaging test's proof that the frozen backend can start
# its worker processes (tests/backend_worker_processes.test.py). Before the app import, like --runtime-version.
if len(sys.argv) == 2 and sys.argv[1] == '--selftest-parallel':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import importlib
    # through importlib, like every parser: the parsers ship as data files beside the frozen code (the spec's datas),
    # never half in the archive
    sys.exit(importlib.import_module('parsers.selftest').main())

# Add backend directory to Python path
backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, backend_dir)

if __name__ == '__main__':
    # The app is imported here, under the main guard: a process that imports this module without running it
    # (a multiprocessing child outside the frozen app) never starts the app's schedulers or binds the port.
    from app import app, socketio

    port = int(os.getenv('PORT', '8080'))
    print(f"Starting Flask backend on http://127.0.0.1:{port}")
    print(f"Backend accessible only from localhost (central server architecture)")
    # Use socketio.run (not app.run) so Socket.IO's WebSocket routing is
    # started the same way the dev entrypoint (app.py's __main__) already
    # does - see that file for why. allow_unsafe_werkzeug=True is required
    # here: Electron spawns this process as a child with no attached
    # terminal (non-TTY stdin), and flask-socketio's threading-mode run()
    # refuses to start at all under that condition unless this is passed.
    socketio.run(
        app,
        host='127.0.0.1',
        port=port,
        debug=False,
        use_reloader=False,
        allow_unsafe_werkzeug=True
    )
