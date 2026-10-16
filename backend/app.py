import time as _time
_startup_begin = _time.time()

import os

# extensions owns the Flask app / Socket.IO instances and shared
# infrastructure (auth token gate, debug logging, TOFU host-key store,
# vector DB singleton). Blueprint modules import from extensions, never
# from this module, so the import graph stays one-directional.
_t = _time.time()
import extensions
from extensions import app, socketio, _log_timing
_log_timing("import extensions", _t)

from flask import jsonify

_t = _time.time()
from mustgather import mustgather
_log_timing("import mustgather", _t)

_t = _time.time()
from sosreport import sosreport
_log_timing("import sosreport", _t)

_t = _time.time()
from workflow_executor import workflow_executor
_log_timing("import workflow_executor", _t)

_t = _time.time()
from taskwarrior import taskwarrior
_log_timing("import taskwarrior", _t)

_t = _time.time()
from google_calendar import google_calendar_bp
_log_timing("import google_calendar", _t)

_t = _time.time()
from log_viewer import log_viewer
_log_timing("import log_viewer", _t)

_t = _time.time()
from url_fetch import url_fetch
_log_timing("import url_fetch", _t)

_t = _time.time()
from ssh_exec import ssh_exec
_log_timing("import ssh_exec", _t)

# Not a blueprint: importing this module registers its @socketio.on
# handlers (interactive SSH terminal) on the shared Socket.IO instance.
_t = _time.time()
import ssh_interactive  # noqa: F401
_log_timing("import ssh_interactive", _t)

_t = _time.time()
from ai_chat import ai_chat_bp
_log_timing("import ai_chat", _t)

_t = _time.time()
from rag_chat import rag_chat
from settings_store import settings_api
from jira_proxy import jira_proxy
from whois_lookup import whois_api
from auth import auth_api
from update_check import update_check_api, start_update_check_scheduler
from sync_api import sync_api
from account_data import account_data
from downloads import downloads
_log_timing("import rag_chat", _t)

_t = _time.time()
app.register_blueprint(mustgather)
app.register_blueprint(sosreport)
app.register_blueprint(workflow_executor)
app.register_blueprint(taskwarrior)
app.register_blueprint(google_calendar_bp)
app.register_blueprint(log_viewer)
app.register_blueprint(url_fetch)
app.register_blueprint(ssh_exec)
app.register_blueprint(ai_chat_bp)
app.register_blueprint(rag_chat)
# Browser deployment: Settings over HTTP (write-only secrets), the Jira proxy
# and WHOIS that the Electron main process provides on the desktop
app.register_blueprint(settings_api)
app.register_blueprint(jira_proxy)
app.register_blueprint(whois_api)
# The release check of a self-hosted server (administrators only; off unless
# an administrator turns it on, one request a day then)
app.register_blueprint(update_check_api)
start_update_check_scheduler()
# Sign-in for the browser deployment (JACARIUM_AUTH_MODE=accounts);
# its routes answer 404 in the other modes.
app.register_blueprint(auth_api)
# Per-account synchronisation of the app's database (accounts mode)
app.register_blueprint(sync_api)
app.register_blueprint(account_data)
app.register_blueprint(downloads)
_log_timing("register blueprints", _t)

if extensions.ACCOUNTS:
    # First run: no account yet -> the one-time setup code goes to the log
    # (and to <HOME>/setup-code); gone once the admin exists.
    import accounts as _accounts
    _accounts.ensure_setup_code(log=print)

_log_timing("TOTAL startup", _startup_begin)


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint for testing integration"""
    return jsonify({
        "status": "healthy",
        "service": "sosreport-mustgather-parser",
        "version": "1.0"
    })


if __name__ == "__main__":
    import atexit
    from ssh_interactive import cleanup_ssh_connections
    # Register cleanup function
    atexit.register(cleanup_ssh_connections)

    # Use socketio.run instead of app.run for WebSocket support
    # Debug defaults off: Werkzeug's interactive debugger allows arbitrary code
    # execution on any unhandled exception. Opt in with FLASK_DEBUG=1 for dev.
    socketio.run(app, debug=os.environ.get("FLASK_DEBUG") == "1", host='127.0.0.1', port=int(os.environ.get("PORT", 8080)), allow_unsafe_werkzeug=True)
