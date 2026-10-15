"""Shared application kernel.

This module owns the Flask app / Socket.IO instances and the cross-cutting
infrastructure used by every blueprint module (auth token gate, debug logging
gate, SSH trust-on-first-use host-key store, lazy vector DB singleton).

It must never import any blueprint module (old or new), so anything importing
FROM it can never create a circular import: extensions.py is the leaf of the
dependency graph, blueprint modules import from it, and app.py imports both.
"""
import time as _time
_startup_begin = _time.time()

def _log_timing(label, start):
    elapsed = _time.time() - start
    print(f"[Startup] {label}: {elapsed:.3f}s")

_t = _time.time()
from flask import Flask, request, jsonify
_log_timing("import flask", _t)

_t = _time.time()
from flask_compress import Compress
_log_timing("import flask_compress", _t)

_t = _time.time()
from flask_cors import CORS
_log_timing("import flask_cors", _t)

_t = _time.time()
from flask_socketio import SocketIO
_log_timing("import flask_socketio", _t)

import os
import secrets

_t = _time.time()
from dotenv import load_dotenv
_log_timing("import dotenv", _t)

# Vector DB import is deferred to first use (lancedb/fastembed are heavy)
VECTOR_DB_AVAILABLE = True

# How a request proves it may use this backend - the one seam where an
# authentication scheme plugs in (see _authenticate_request below):
#   app-token  (default) the desktop app: every request carries the
#              per-launch X-App-Token the Electron main process minted.
#   none       the container without sign-in: Flask listens on 127.0.0.1
#              INSIDE the container and is reachable only through the
#              reverse proxy (deploy/Caddyfile) that serves the same-origin
#              UI; requests are anonymous.
#   accounts   the container with sign-in (backend/auth.py): a session
#              cookie names the user, every state-changing request carries
#              the X-Requested-With header, and each account has its own
#              files (backend/user_context.py).
AUTH_MODE = os.environ.get('JACARIUM_AUTH_MODE', 'app-token').strip().lower() or 'app-token'
if AUTH_MODE not in ('app-token', 'none', 'accounts'):
    raise SystemExit(f"JACARIUM_AUTH_MODE must be 'app-token', 'none' or 'accounts', not {AUTH_MODE!r}")
PROXIED_SAME_ORIGIN = AUTH_MODE in ('none', 'accounts')
ACCOUNTS = AUTH_MODE == 'accounts'

# Load environment variables from user's home directory (settings from UI)
_t = _time.time()
# JACARIUM_ENV_FILE overrides the location (the container keeps it on
# the /data volume); Settings > Integrations / AI Providers writes the same
# file through backend/settings_store.py when the app runs in a browser.
# With accounts there is no single file: settings_store.setting() resolves
# each account's own file and the server defaults per request, and nothing
# of them is loaded into the process environment.
if not ACCOUNTS:
    from settings_store import env_file_path as _env_file_path
    load_dotenv(_env_file_path())
_log_timing("load_dotenv", _t)

_t = _time.time()
app = Flask(__name__)
# Belt-and-suspenders: restrict the CORS allow-list to the app's own origins
# (Vite dev server / packaged file:// renderer, which Chromium reports as the
# literal Origin "null"). This is secondary to the X-App-Token check below --
# CORS only stops a malicious page from *reading* a response, it does not stop
# "simple" cross-origin requests (e.g. text/plain or form-urlencoded bodies)
# from being sent and executed server-side in the first place.
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "null",
]

CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS}}, supports_credentials=True)
Compress(app)
# Behind the proxy the browser's own origin is the only legitimate one:
# engineio's default (None) accepts exactly the request's scheme://host,
# honouring X-Forwarded-Proto, which is what the proxy sends.
socketio = SocketIO(app, cors_allowed_origins=None if PROXIED_SAME_ORIGIN else ALLOWED_ORIGINS, async_mode='threading')
_log_timing("create Flask app", _t)

app.secret_key = secrets.token_hex(32)

# ============================================================================
# APP AUTH TOKEN
# ============================================================================
# A random shared-secret token generated fresh per app launch by the Electron
# main process and passed to this process via the APP_AUTH_TOKEN environment
# variable (never a CLI arg, never a file). The Electron renderer obtains the
# same token over an isolated IPC/contextBridge channel and sends it as the
# X-App-Token header on every request. This is the actual security boundary:
# this backend binds to 127.0.0.1 with no other authentication, so without
# this check ANY web page open in the user's regular browser could silently
# trigger SSH command execution or the URL-fetch/SSRF proxy below just by
# issuing a fetch()/form POST to this port -- CORS alone would not stop that,
# since "simple" cross-origin requests are sent by the browser regardless of
# CORS policy.
APP_AUTH_TOKEN = os.environ.get("APP_AUTH_TOKEN")

if not APP_AUTH_TOKEN:
    print(
        "[SECURITY WARNING] APP_AUTH_TOKEN is not set. This backend was "
        "expected to be launched by the Electron app, which generates and "
        "passes this token. Running without it, every request below will be "
        "rejected with 401 (except the exempted /health and /static paths)."
    )

# Opt-in debug logging: set DEBUG_LOGGING=1 to enable verbose success-path
# logs. Errors, warnings, security events and startup timing always print.
DEBUG_LOGGING = os.environ.get("DEBUG_LOGGING") == "1"

def debug_print(*args, **kwargs):
    if DEBUG_LOGGING:
        print(*args, **kwargs)

# ============================================================================
# SSH HOST KEY VERIFICATION (trust-on-first-use)
# ============================================================================
# All SSH code paths (OpenSSH subprocess calls and paramiko clients) share
# this known_hosts store. First connection to a host is accepted automatically
# and its key is persisted (no human is present to confirm fingerprints --
# SSH is driven by the automated Workflow Editor); any later connection where
# the host presents a DIFFERENT key is rejected, which is what defends
# against machine-in-the-middle attacks.
KNOWN_HOSTS_PATH = os.path.expanduser(
    os.environ.get('JACARIUM_KNOWN_HOSTS') or '~/.jacarium/known_hosts')


def known_hosts_path():
    """
    The known_hosts store for this request: one per account with sign-in
    (``~/.ssh/known_hosts`` under the account's home, user_context.py),
    else the process-wide KNOWN_HOSTS_PATH.
    """
    if ACCOUNTS:
        from user_context import user_home
        return os.path.join(user_home(), '.ssh', 'known_hosts')
    return KNOWN_HOSTS_PATH


def _ensure_known_hosts_dir():
    """Create the known_hosts parent directory (mode 0700) if missing.

    ssh will create the file itself but not the parent dir, and paramiko's
    save_host_keys() creates neither.
    """
    os.makedirs(os.path.dirname(known_hosts_path()), mode=0o700, exist_ok=True)


_TOFU_POLICY_CLASS = None


def _tofu_host_key_policy():
    """Return a trust-on-first-use paramiko host key policy instance.

    Defined lazily because this module defers `import paramiko` to first use.
    The policy only fires for *unseen* hosts: callers must load_host_keys()
    from KNOWN_HOSTS_PATH before connect() so that a key MISMATCH is caught
    by paramiko itself (raising BadHostKeyException) instead of reaching us.
    """
    global _TOFU_POLICY_CLASS
    if _TOFU_POLICY_CLASS is None:
        import paramiko

        class TofuHostKeyPolicy(paramiko.MissingHostKeyPolicy):
            """Trust-on-first-use: accept and persist unseen host keys."""

            def missing_host_key(self, client, hostname, key):
                client._host_keys.add(hostname, key.get_name(), key)
                _ensure_known_hosts_dir()
                client.save_host_keys(known_hosts_path())

        _TOFU_POLICY_CLASS = TofuHostKeyPolicy
    return _TOFU_POLICY_CLASS()

# Paths that are safe to reach without the token: no side effects, no
# sensitive data. Everything else (including the blueprints registered
# in app.py) requires a valid X-App-Token header.
# /api/version and the desktop installers (backend/downloads.py) need no
# sign-in in any mode: a desktop app checks the version before it has a
# token, and an installer is public by nature
_AUTH_EXEMPT_PATHS = {"/health", "/api/version", "/api/tls/root.crt"}   # a certificate is public: the desktop fetches it before it is linked
_AUTH_EXEMPT_PREFIXES = ("/static/", "/api/downloads")
# With accounts: reachable without a session (they establish one, or tell
# the app that it needs one). /api/auth/me answers 401 by itself.
_ACCOUNTS_EXEMPT_PATHS = {"/api/capabilities", "/api/auth/login", "/api/auth/setup", "/api/auth/me", "/api/auth/logout"}
# all a session may do while its password must still be changed
_PASSWORD_CHANGE_PATHS = {"/api/auth/password", "/api/auth/me", "/api/auth/logout", "/api/capabilities"}


def _authenticate_request():
    """
    The authentication seam: returns a refusal response, or None to let the
    request through. AUTH_MODE picks the scheme (see the CORS block above).
    """
    if AUTH_MODE == 'none':
        return None
    if AUTH_MODE == 'accounts':
        return _require_session()
    return _require_app_token_header()


def _require_session():
    import auth as _auth
    # Every state-changing request needs the custom header - a cross-site
    # page cannot add one without a CORS preflight, which never passes.
    if not _auth.csrf_ok():
        return jsonify({"error": "Missing X-Requested-With header"}), 403
    _auth.purge_sessions_occasionally()
    user = _auth.session_user_from_request()
    from user_context import set_current_user
    set_current_user(user)
    if request.path in _ACCOUNTS_EXEMPT_PATHS:
        return None
    if user is None:
        import accounts as _accounts
        return jsonify({"error": "Sign in first", "authMode": "accounts",
                        "setupRequired": _accounts.setup_required()}), 401
    if user.get("mustChangePassword") and request.path not in _PASSWORD_CHANGE_PATHS:
        # signed in with a temporary password (host-side recovery): nothing
        # else until the user chose a password of their own
        return jsonify({"error": "Choose a new password first", "passwordChangeRequired": True}), 403
    return None


@app.before_request
def _require_app_token():
    # Let CORS preflight requests through untouched; they carry no
    # meaningful body/side-effects and the browser never exposes their
    # response to the page anyway.
    if request.method == "OPTIONS":
        return None

    path = request.path
    if path in _AUTH_EXEMPT_PATHS or path.startswith(_AUTH_EXEMPT_PREFIXES):
        return None

    return _authenticate_request()


def _require_app_token_header():
    if not APP_AUTH_TOKEN:
        # Fail closed if the backend was somehow started without a token.
        return jsonify({"error": "Server misconfigured: APP_AUTH_TOKEN not set"}), 500

    supplied = request.headers.get("X-App-Token", "")
    if not supplied or not secrets.compare_digest(supplied, APP_AUTH_TOKEN):
        return jsonify({"error": "Unauthorized"}), 401

    return None


def _central_capabilities():
    try:
        import central_ticket
        return central_ticket.capabilities()
    except Exception:  # pragma: no cover - a missing module must not break the page
        return {"provided": False}


@app.route("/api/capabilities", methods=["GET"])
def _capabilities():
    """
    What this backend provides for the app in a browser (the desktop gets
    the same features from the Electron main process). The renderer's
    src/utils/platform.js merges this into can().
    """
    import socket as _socket
    from reports_root import reports_root, shared_reports_root
    from version_info import version_info
    answer = {
        "authMode": AUTH_MODE,
        # the app version (package.json) and the compatibility protocol
        # (protocol.json) - what a desktop compares against its own
        "version": version_info()["app"],
        "protocol": version_info()["protocol"],
        # The host part of a browser's cloud-sync identity
        # (src/utils/cloudCentralSync.js); in the container this is the
        # name deploy-podman.sh gives it.
        "hostname": _socket.gethostname(),
        "capabilities": {
            "settings": True,        # /api/settings (write-only secrets)
            "jiraProxy": True,       # /api/jira/<path>
            "whois": True,           # /api/whois
            "httpProxy": True,       # /api/workflow/http-request
            "sync": ACCOUNTS,        # /api/sync/* (the account's data on this server)
            # the central server behind this one (deploy/Caddyfile /central/*):
            # {provided, path, accountSignIn} - the app derives its URL from it
            "central": _central_capabilities(),
        },
    }
    if ACCOUNTS:
        import accounts as _accounts
        from user_context import current_user, is_admin
        user = current_user()
        answer["auth"] = {
            "mode": "accounts",
            "setupRequired": _accounts.setup_required(),
            "user": user,
            "admin": is_admin(),
        }
        # Per-account paths exist only once someone is signed in.
        answer["reportsRoot"] = reports_root() if user else None
        answer["sharedReportsRoot"] = shared_reports_root()
    else:
        answer["auth"] = {"mode": AUTH_MODE}
        answer["reportsRoot"] = reports_root()
    return jsonify(answer)


UPLOAD_FOLDER = './uploads'
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Lazy-initialize Vector DB for RAG functionality. One manager per index
# directory: a single one on the desktop / without sign-in, one per account
# with sign-in (``~/.jacarium/vector_db`` under the account's home),
# all sharing one loaded embedding model.
_vector_db = None
_vector_db_checked = False
_vector_dbs = {}
_vector_embedder = None


def vector_db_path():
    from user_context import expand_user_path
    return expand_user_path('~/.jacarium/vector_db')


def get_vector_db():
    global _vector_db, _vector_db_checked, _vector_embedder, VECTOR_DB_AVAILABLE
    path = vector_db_path()
    if _vector_db_checked and _vector_db is not None and path in _vector_dbs:
        return _vector_dbs[path]
    if _vector_db_checked and _vector_db is not None:
        # Another account's index: reuse the loaded embedding model
        from vector_db import VectorDBManager
        _vector_dbs[path] = VectorDBManager(path, embedding_model=_vector_embedder)
        return _vector_dbs[path]
    if not _vector_db_checked:
        _vector_db_checked = True
        # fastembed downloads the embedding model through huggingface_hub on
        # first use; without a cached model and no way to fetch it the
        # singleton stays unchecked so a later call tries again.
        try:
            from vector_db import VectorDBManager
            _vector_db = VectorDBManager(path)
            _vector_embedder = _vector_db.embedding_model
            _vector_dbs[path] = _vector_db
        except ImportError:
            VECTOR_DB_AVAILABLE = False
            print("[WARNING] Vector DB dependencies not available - RAG features disabled")
        except Exception:
            _vector_db_checked = False
            raise
    return _vector_db
