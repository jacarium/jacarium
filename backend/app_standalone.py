#!/usr/bin/env python3
"""
Standalone Flask backend for Electron app
Entry point for PyInstaller packaging
"""
import sys
import os

# Add backend directory to Python path
backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, backend_dir)

# Import the Flask app
from app import app, socketio

if __name__ == '__main__':
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
