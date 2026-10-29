"""One-shot SSH command execution route (subprocess/sshpass, used by Workflow Editor)."""
import hashlib
import os
import re
import sys

from flask import Blueprint, request, jsonify

from extensions import AUTH_MODE, KNOWN_HOSTS_PATH, _ensure_known_hosts_dir, known_hosts_path
from user_context import accounts_mode, expand_user_path, ssh_identity_files

ssh_exec = Blueprint('ssh_exec', __name__)

# ============================================================================
# SSH CONNECTION REUSE (OpenSSH ControlMaster multiplexing)
# ============================================================================
# Every call to /api/execute-ssh shells out to a fresh `ssh` process. Without
# multiplexing, each call pays a full TCP connect + key exchange + auth
# handshake for a single command -- brutal for Workflow Editor graphs that
# run an SSH node inside a forloop (one handshake PER ITERATION).
#
# ControlMaster=auto + ControlPath + ControlPersist fix this at the ssh CLI
# layer already in use here, for BOTH auth methods (agent and sshpass), with
# no change to auth mechanism, stdout/stderr/exit-code semantics, or host-key
# checking:
#   - the first ssh call authenticates normally, then forks a background
#     "master" holding the connection open and listening on a control socket;
#   - subsequent ssh calls to the same target find the socket and run their
#     command over the existing connection near-instantly (no re-handshake);
#   - ControlPersist=<N>s makes the master auto-exit after N seconds with no
#     active sessions, so idle connections clean themselves up -- nothing
#     leaks forever and no bookkeeping is needed in this process;
#   - if the socket is stale (master died) or multiplexing is unavailable,
#     ssh transparently falls back to a normal direct connection, i.e. the
#     pre-fix per-command behavior. The backgrounded master detaches its
#     stdio, so subprocess.run(capture_output=True) is not held open by it.
#
# The control socket is one authenticated session, so the path is keyed by
# (auth method, username, host, port) -- hashed, because AF_UNIX socket paths
# have a hard ~104-byte limit on macOS/BSD (ssh exits 255 without running the
# command if ControlPath is too long, and the master's temporary
# "<path>.XXXXXXXXXXXXXXXX" rename dance needs ~17 spare bytes on top).

MUX_DIR = os.path.expanduser('~/.jacarium/ssh-mux')
MUX_PERSIST_SECONDS = 60


def mux_dir():
    """
    The control-socket directory: one per account with sign-in. Kept short
    (``<server home>/.ssh-mux/<8-char account hash>``, not under the account's
    home) because AF_UNIX socket paths are capped at ~104 bytes and
    ``/data/users/<uuid>/...`` would already exceed the budget below.
    """
    if accounts_mode():
        from user_context import current_user, server_home
        user = current_user()
        tag = hashlib.sha256(str(user['id'] if user else '').encode()).hexdigest()[:8]
        return os.path.join(server_home(), '.ssh-mux', tag)
    return MUX_DIR


def _identity_options():
    """
    With sign-in, key logins use the account's own identities only
    (``~/.ssh/id_*`` under the account's home) - never the server's or
    another account's keys, and no agent. [] in the other modes.
    """
    if not accounts_mode():
        return []
    options = ['-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none']
    for key in ssh_identity_files():
        options.extend(['-i', key])
    return options
# ssh hard-fails at 104 bytes; leave room for the master's temp-name suffix.
_MUX_MAX_CONTROL_PATH_BYTES = 86

_ALLOWED_SSH_OPTION_NAMES = {
    'StrictHostKeyChecking', 'UserKnownHostsFile', 'LogLevel', 'ConnectTimeout',
    'ConnectionAttempts', 'ServerAliveInterval', 'ServerAliveCountMax',
    'KexAlgorithms', 'Ciphers', 'MACs', 'HostKeyAlgorithms', 'PubkeyAcceptedAlgorithms',
    'Compression', 'TCPKeepAlive', 'IdentitiesOnly', 'PreferredAuthentications',
}


# ----------------------------------------------------------------------------
# SSH target validation (argv injection guard)
# ----------------------------------------------------------------------------
# The ssh command line is built as [..., '-p', port, f'{username}@{host}',
# command]. OpenSSH parses its argv with getopt, so a username or host that
# STARTS WITH '-' is read as an option, not a destination: a username of
# "-oProxyCommand=<cmd>" (giving "-oProxyCommand=<cmd>@host") runs <cmd>
# locally, sidestepping the _sanitize_ssh_options allowlist entirely. Both
# values (and the port) are therefore checked against strict allowlists
# before any argv is assembled. Legitimate values are unaffected: hostnames,
# FQDNs, IPv4/IPv6 literals and POSIX usernames (dots, underscores and
# mid-string hyphens included) all pass; only values that cannot be a real
# username/host - a leading '-', whitespace, quotes, '@', '/', ... - are
# rejected with a 400 before ssh is ever invoked.

_SSH_USERNAME_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$')
# hostname / FQDN / IPv4 / bare IPv6 (':' allowed, incl. leading '::1')
_SSH_HOST_RE = re.compile(r'^[A-Za-z0-9:][A-Za-z0-9.:_-]{0,252}$')


def _validate_ssh_target(host, port, username):
    """Validate the pieces that land in ssh argv.

    Returns (error_message, port_number). error_message is None when all
    three values are safe; port_number is the validated int port.
    """
    if not isinstance(username, str) or not _SSH_USERNAME_RE.match(username):
        return ('Invalid SSH username: only letters, digits, ".", "_" and "-" are allowed, '
                'and it must not start with "-"'), None
    if not isinstance(host, str) or not _SSH_HOST_RE.match(host):
        return ('Invalid SSH host: only letters, digits, ".", ":", "_" and "-" are allowed, '
                'and it must not start with "-"'), None
    try:
        port_number = int(str(port).strip())
    except (TypeError, ValueError):
        return 'Invalid SSH port: must be an integer between 1 and 65535', None
    if not 1 <= port_number <= 65535:
        return 'Invalid SSH port: must be an integer between 1 and 65535', None
    return None, port_number


def _sanitize_ssh_options(ssh_options):
    """Filter a free-text SSH -o option string down to a safe allowlist.

    Only accepts `-o Name=Value` pairs where Name is in
    _ALLOWED_SSH_OPTION_NAMES. Silently drops anything else (bare flags,
    unknown -o names, ProxyCommand/LocalCommand, or malformed tokens) rather
    than erroring, since this is user-editable free text in the UI.
    """
    if not ssh_options:
        return []
    tokens = ssh_options.replace('\n', ' ').strip().split()
    safe_args = []
    i = 0
    while i < len(tokens):
        if tokens[i] == '-o' and i + 1 < len(tokens):
            option = tokens[i + 1]
            name = option.split('=', 1)[0] if '=' in option else None
            if name in _ALLOWED_SSH_OPTION_NAMES:
                safe_args.extend(['-o', option])
            i += 2
        else:
            i += 1
    return safe_args


def _mux_control_path(host, port, username, auth_method):
    """Deterministic, collision-safe control socket path for one SSH target.

    sha256 over NUL-joined fields (NUL cannot appear in any of them, so
    distinct tuples can never produce the same digest input); 16 hex chars
    keeps the socket path short enough for the AF_UNIX limit.
    """
    key = hashlib.sha256(
        f'{auth_method}\x00{username}\x00{host}\x00{port}'.encode()
    ).hexdigest()[:16]
    return os.path.join(mux_dir(), key)


def _mux_options(host, port, username, auth_method, ssh_options=''):
    """Return extra ssh -o flags enabling connection reuse, or [] to fall back.

    An empty return means "no multiplexing": the ssh command is then exactly
    what this route always built, i.e. one full handshake per command. That
    is the safe degradation path whenever anything is off (opt-out env var,
    unsupported platform, socket dir not creatable, control path too long,
    or the caller passed their own ControlMaster/ControlPath via sshOptions,
    which must keep winning like every other user-supplied option).
    """
    if os.environ.get('JACARIUM_DISABLE_SSH_MUX') == '1':
        return []
    if AUTH_MODE == 'none':
        # Browser deployment without sign-in: the backend serves every user
        # of the proxy with one process and one home directory, so a control
        # socket opened by one request (an authenticated session to host H
        # as user U) would be reused by the next request from ANYONE for the
        # same target, with no credentials. With accounts the socket
        # directory is per account (mux_dir), so reuse is safe there.
        return []
    if sys.platform == 'win32':
        # Windows OpenSSH has no ControlMaster support.
        return []
    if ssh_options and ('ControlMaster' in ssh_options or 'ControlPath' in ssh_options):
        return []
    try:
        # 0700: the control socket grants full access to the authenticated
        # SSH session, so only this user may traverse the directory. chmod
        # separately because makedirs' mode is ignored for a pre-existing dir.
        os.makedirs(mux_dir(), mode=0o700, exist_ok=True)
        os.chmod(mux_dir(), 0o700)
    except OSError:
        return []
    control_path = _mux_control_path(host, port, username, auth_method)
    if len(control_path.encode()) > _MUX_MAX_CONTROL_PATH_BYTES:
        return []
    return [
        '-o', 'ControlMaster=auto',
        '-o', f'ControlPath={control_path}',
        '-o', f'ControlPersist={MUX_PERSIST_SECONDS}s',
    ]


@ssh_exec.route("/api/execute-ssh", methods=["POST"])
def execute_ssh():
    """Execute SSH command on remote host"""
    try:
        import subprocess
        import shlex
        import shutil

        data = request.json
        host = data.get('host', '')
        port = data.get('port', 22)
        username = data.get('username', '')
        auth_method = data.get('authMethod', 'agent')
        password = data.get('password', '')
        command = data.get('command', '')
        ssh_options = data.get('sshOptions', '')

        if not host or not username or not command:
            return jsonify({"error": "host, username, and command are required"}), 400

        # Reject anything that could be parsed as an ssh option instead of a
        # destination (see _validate_ssh_target) before building argv.
        target_error, port = _validate_ssh_target(host, port, username)
        if target_error:
            return jsonify({"error": target_error}), 400

        # ssh creates the known_hosts file if missing, but not its parent dir
        _ensure_known_hosts_dir()

        # Reuse an already-authenticated connection to this exact target when
        # one exists (see module header); [] degrades to one-shot behavior.
        mux_options = _mux_options(host, port, username, auth_method, ssh_options)

        # Build SSH command based on auth method
        if auth_method == 'agent':
            # Use SSH agent (key-based authentication)
            ssh_cmd = [
                'ssh',
                '-F', '/dev/null',  # Ignore SSH config files to avoid crypto-policy issues
                # Trust-on-first-use: accept unseen host keys, hard-fail on a
                # key that contradicts the persisted known_hosts store (MITM).
                '-o', 'StrictHostKeyChecking=accept-new',
                '-o', f'UserKnownHostsFile={known_hosts_path()}',
                '-o', 'LogLevel=ERROR',
                *mux_options,
                *_identity_options(),
                '-p', str(port),
                f'{username}@{host}',
                command
            ]

            # Add custom SSH options if provided (allowlisted -o names only — see
            # _sanitize_ssh_options; blocks ProxyCommand/LocalCommand-style option
            # injection, which would otherwise let this run arbitrary local commands)
            safe_opts = _sanitize_ssh_options(ssh_options)
            if safe_opts:
                insert_pos = ssh_cmd.index(f'{username}@{host}')
                for opt in reversed(safe_opts):
                    ssh_cmd.insert(insert_pos, opt)

            # Execute SSH command
            result = subprocess.run(
                ssh_cmd,
                capture_output=True,
                text=True,
                timeout=30
            )

            return jsonify({
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.returncode
            })

        elif auth_method == 'password':
            # Use sshpass for password authentication
            if not password:
                return jsonify({"error": "password is required for password authentication"}), 400

            # Check if sshpass is available: looked up on PATH in-process (the container image, ubi9-minimal,
            # ships no `which` binary, and a missing one must not read as "sshpass is missing")
            if not shutil.which('sshpass'):
                return jsonify({
                    "error": "sshpass is not installed. Install it with: sudo apt-get install sshpass (Debian/Ubuntu) or sudo yum install sshpass (RHEL/CentOS)"
                }), 500

            ssh_cmd = [
                'sshpass',
                # -e reads the password from the SSHPASS env var instead of
                # argv, keeping it out of `ps` / /proc/<pid>/cmdline.
                '-e',
                'ssh',
                '-F', '/dev/null',  # Ignore SSH config files to avoid crypto-policy issues
                # Trust-on-first-use: accept unseen host keys, hard-fail on a
                # key that contradicts the persisted known_hosts store (MITM).
                '-o', 'StrictHostKeyChecking=accept-new',
                '-o', f'UserKnownHostsFile={known_hosts_path()}',
                '-o', 'LogLevel=ERROR',
                *mux_options,
                '-p', str(port),
                f'{username}@{host}',
                command
            ]

            # Add custom SSH options if provided (allowlisted -o names only — see
            # _sanitize_ssh_options; blocks ProxyCommand/LocalCommand-style option
            # injection, which would otherwise let this run arbitrary local commands)
            safe_opts = _sanitize_ssh_options(ssh_options)
            if safe_opts:
                insert_pos = ssh_cmd.index(f'{username}@{host}')
                for opt in reversed(safe_opts):
                    ssh_cmd.insert(insert_pos, opt)

            # Execute SSH command with password (passed via env, not argv)
            env = {**os.environ, 'SSHPASS': password}
            result = subprocess.run(
                ssh_cmd,
                capture_output=True,
                text=True,
                timeout=30,
                env=env
            )

            return jsonify({
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.returncode
            })

        else:
            return jsonify({"error": f"Unknown auth method: {auth_method}"}), 400

    except subprocess.TimeoutExpired:
        return jsonify({"error": "SSH command timeout (30s limit)"}), 500
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[SSH Execute Error] {error_trace}")
        return jsonify({"error": f"Failed to execute SSH command: {str(e)}"}), 500
