"""Interactive SSH terminal: Socket.IO event handlers and the shared
paramiko connection pool (also used by the SSH AI-chat provider).

Not a Flask blueprint -- importing this module registers the @socketio.on
handlers on the shared Socket.IO instance from extensions.py.
"""
import os
import secrets
import threading

from flask import request
from flask_socketio import emit, join_room, leave_room

from extensions import (
    ACCOUNTS,
    APP_AUTH_TOKEN,
    KNOWN_HOSTS_PATH,
    _tofu_host_key_policy,
    known_hosts_path,
    socketio,
)
from user_context import as_socket_user, bind_socket_user, current_user, ssh_identity_files

# SSH Connection Pool - reuse SSH connections for AI chat
# Maps "user@host" -> paramiko SSHClient
# Accessed from both Flask request threads (ai_chat.py) and Socket.IO
# handlers, and the server runs with async_mode='threading', so all pool
# mutations must hold _ssh_pool_lock. Do NOT hold the lock across
# client.connect() -- that would serialize every SSH operation behind a
# potentially 60s handshake.
ssh_connection_pool = {}
_ssh_pool_lock = threading.Lock()


def _probe_ssh_client(client):
    """Round-trip liveness check for a pooled connection.

    transport.is_active() only reflects local socket state: a connection
    dropped by the remote side (idle timeout, sshd restart, network change)
    can still report active until the next write fails. Opening and closing
    a throwaway session forces a real round trip, so a half-dead connection
    is detected here instead of failing later inside exec_command with a
    confusing error.
    """
    try:
        transport = client.get_transport()
        if transport is None or not transport.is_active():
            return False
        channel = transport.open_session(timeout=5)
        channel.close()
        return True
    except Exception:
        return False


def drop_ssh_connection(ssh_host, ssh_user):
    """Remove and close a pooled connection (e.g. after exec_command failed)."""
    connection_key = f"{ssh_user}@{ssh_host}"
    with _ssh_pool_lock:
        client = ssh_connection_pool.pop(connection_key, None)
    if client is not None:
        try:
            client.close()
        except Exception:
            pass
        print(f"[SSH Pool] Dropped connection: {connection_key}")


def get_ssh_connection(ssh_host, ssh_user, ssh_password=None):
    """Get or create a reusable SSH connection"""
    import paramiko

    # With sign-in the pool is per account: one account must never ride
    # another's authenticated session to the same target.
    account = current_user()
    connection_key = f"{account['id'] + ':' if account else ''}{ssh_user}@{ssh_host}"

    # Check if a pooled connection exists and actually responds
    with _ssh_pool_lock:
        client = ssh_connection_pool.get(connection_key)
    if client is not None:
        if _probe_ssh_client(client):
            print(f"[SSH Pool] Reusing pooled connection: {connection_key}")
            return client
        # Dead or half-dead: discard it and fall through to a fresh connect.
        with _ssh_pool_lock:
            if ssh_connection_pool.get(connection_key) is client:
                del ssh_connection_pool[connection_key]
        try:
            client.close()
        except Exception:
            pass
        print(f"[SSH Pool] Discarded dead pooled connection: {connection_key}")

    # Create new connection with trust-on-first-use host key verification:
    # load the persisted store so a changed key raises BadHostKeyException,
    # while unseen hosts are accepted and recorded by the TOFU policy.
    client = paramiko.SSHClient()
    if os.path.exists(known_hosts_path()):
        client.load_host_keys(known_hosts_path())
    client.set_missing_host_key_policy(_tofu_host_key_policy())

    try:
        if ssh_password:
            client.connect(
                ssh_host,
                username=ssh_user,
                password=ssh_password,
                timeout=60,
                auth_timeout=60,
                look_for_keys=False,
                allow_agent=False
            )
        else:
            client.connect(
                ssh_host,
                username=ssh_user,
                timeout=60,
                auth_timeout=60,
                banner_timeout=60,
                **_key_login_options()
            )

        # Store in pool. If another thread connected for the same key while
        # we were in connect(), the entry is simply replaced; the displaced
        # client may still be in use by that thread, so it is left to close
        # when its work finishes rather than being force-closed here.
        with _ssh_pool_lock:
            ssh_connection_pool[connection_key] = client
        print(f"[SSH Pool] Created new connection: {connection_key}")
        return client

    except paramiko.BadHostKeyException:
        raise ValueError(
            f"SSH host key verification failed for {ssh_host}: the host "
            "presented a key that does not match the one previously recorded "
            f"in {known_hosts_path()}. This may indicate a machine-in-the-middle "
            "attack. If the host's key legitimately changed (e.g. the server "
            "was reinstalled), remove its entry from that file and retry."
        )
    except paramiko.AuthenticationException:
        raise ValueError(
            "SSH authentication failed.\n\n"
            "Please ensure SSH key-based authentication is set up:\n"
            "1. Generate SSH key (if you don't have one):\n"
            "   ssh-keygen -t rsa -b 4096\n\n"
            "2. Copy your public key to the remote server:\n"
            f"   ssh-copy-id {ssh_user}@{ssh_host}\n\n"
            "3. Test passwordless login:\n"
            f"   ssh {ssh_user}@{ssh_host} 'echo Connected successfully'\n\n"
            "After setting up SSH keys, try again."
        )
    except Exception as e:
        raise ValueError(f"SSH connection error: {str(e)}")

def _key_login_options():
    """paramiko connect() keywords for a key login: with sign-in only the
    account's own identities (user_context.ssh_identity_files), no agent."""
    if not ACCOUNTS:
        return {}
    return {'key_filename': ssh_identity_files() or None, 'look_for_keys': False, 'allow_agent': False}


# Interactive SSH WebSocket handlers
ssh_sessions = {}  # Store active SSH sessions by session_id

@socketio.on('connect', namespace='/ws/ssh-interactive')
def handle_ssh_connect(auth):
    """Handle WebSocket connection for interactive SSH.

    The same boundary as /api/*: with accounts the handshake must carry a
    live session cookie (the user is then bound to this socket for every
    later event); otherwise the shared-secret app token, passed by the
    client via the Socket.IO `auth` payload (io(url, {auth: {token}})).
    Returning False rejects the connection before any SSH session can be
    started.
    """
    if ACCOUNTS:
        import auth as _auth
        user = _auth.session_user_from_request()
        if not user:
            print('[SSH Interactive] Rejected connection: not signed in')
            return False
        bind_socket_user(request.sid, user)
        print(f'[SSH Interactive] Client connected ({user["username"]})')
        emit('connected', {'status': 'ready'})
        return None
    token = auth.get('token') if isinstance(auth, dict) else None
    if not APP_AUTH_TOKEN or not token or not secrets.compare_digest(token, APP_AUTH_TOKEN):
        print('[SSH Interactive] Rejected connection: missing/invalid token')
        return False

    print('[SSH Interactive] Client connected')
    emit('connected', {'status': 'ready'})


@socketio.on('disconnect', namespace='/ws/ssh-interactive')
def handle_ssh_disconnect():
    """Handle WebSocket disconnection: tear down the SSH sessions this
    socket opened (the monitor thread closes channel + client when
    `connected` flips to False)."""
    sid = request.sid
    owned = [s for s, d in list(ssh_sessions.items()) if d.get('sid') == sid]
    for session_id in owned:
        ssh_sessions[session_id]['connected'] = False
    bind_socket_user(sid, None)
    print(f'[SSH Interactive] Client disconnected ({len(owned)} session(s) closed)')


def _sessions_for_socket(sid):
    """Session ids opened by the given Socket.IO sid, oldest first."""
    return [s for s, d in ssh_sessions.items() if d.get('sid') == sid and d.get('connected')]


@socketio.on('message', namespace='/ws/ssh-interactive')
def handle_ssh_message(data):
    """Handle messages from WebSocket client"""
    import threading
    import paramiko
    import uuid
    import socket as sock

    message_type = data.get('type')

    # Act as the account bound to this socket at connect (accounts mode):
    # its known_hosts, its identities. A socket without one gets nothing.
    if ACCOUNTS and not as_socket_user(request.sid):
        emit('message', {'type': 'error', 'error': 'Not signed in'})
        return

    if message_type == 'connect':
        # Start new SSH session. It is BOUND to the Socket.IO connection that
        # opened it: output is emitted only to that socket's private room and
        # input is accepted only from that socket. Previously output went to
        # the whole namespace and input was routed to whichever session
        # happened to be first, so two terminal windows cross-wired.
        session_id = str(uuid.uuid4())
        owner_sid = request.sid
        join_room(session_id)

        try:
            # Extract connection parameters
            host = data.get('host')
            port = data.get('port', 22)
            username = data.get('username')
            auth_method = data.get('authMethod', 'agent')
            password = data.get('password', '')

            print(f'[SSH Interactive] Connecting to {username}@{host}:{port}')

            # Create SSH client with trust-on-first-use host key verification:
            # load the persisted store so a changed key raises
            # BadHostKeyException, while unseen hosts are accepted and recorded.
            ssh = paramiko.SSHClient()
            if os.path.exists(known_hosts_path()):
                ssh.load_host_keys(known_hosts_path())
            ssh.set_missing_host_key_policy(_tofu_host_key_policy())

            # Connect based on auth method
            if auth_method == 'agent':
                ssh.connect(
                    hostname=host,
                    port=port,
                    username=username,
                    timeout=10,
                    **({'look_for_keys': True, 'allow_agent': True} if not ACCOUNTS else _key_login_options())
                )
            else:
                ssh.connect(
                    hostname=host,
                    port=port,
                    username=username,
                    password=password,
                    look_for_keys=False,
                    allow_agent=False,
                    timeout=10
                )

            # Get shell with PTY for interactive mode
            channel = ssh.invoke_shell(term='xterm', width=120, height=40)
            channel.settimeout(0.1)

            # Store session (owner sid + private room = the session id)
            ssh_sessions[session_id] = {
                'ssh': ssh,
                'channel': channel,
                'connected': True,
                'sid': owner_sid,
                'room': session_id
            }

            # Emit connection success
            emit('connected', {'sessionId': session_id})

            # Start output monitoring thread
            def monitor_output():
                buffer = ''
                try:
                    while ssh_sessions.get(session_id, {}).get('connected', False):
                        try:
                            if channel.recv_ready():
                                data_recv = channel.recv(4096).decode('utf-8', errors='replace')
                                buffer += data_recv

                                if '\n' in buffer or len(buffer) > 100:
                                    socketio.emit('message', {
                                        'type': 'output',
                                        'data': buffer
                                    }, namespace='/ws/ssh-interactive', to=session_id)
                                    buffer = ''

                            if channel.recv_stderr_ready():
                                err_data = channel.recv_stderr(4096).decode('utf-8', errors='replace')
                                socketio.emit('message', {
                                    'type': 'error',
                                    'error': err_data
                                }, namespace='/ws/ssh-interactive', to=session_id)

                            if channel.exit_status_ready():
                                exit_code = channel.recv_exit_status()
                                if buffer:
                                    socketio.emit('message', {
                                        'type': 'output',
                                        'data': buffer
                                    }, namespace='/ws/ssh-interactive', to=session_id)
                                socketio.emit('message', {
                                    'type': 'exit',
                                    'exitCode': exit_code
                                }, namespace='/ws/ssh-interactive', to=session_id)
                                break

                            threading.Event().wait(0.05)

                        except sock.timeout:
                            continue
                        except Exception as e:
                            print(f'[SSH Interactive] Output error: {e}')
                            break

                except Exception as e:
                    print(f'[SSH Interactive] Monitor error: {e}')
                finally:
                    if session_id in ssh_sessions:
                        try:
                            ssh_sessions[session_id]['channel'].close()
                            ssh_sessions[session_id]['ssh'].close()
                        except:
                            pass
                        del ssh_sessions[session_id]

            monitor_thread = threading.Thread(target=monitor_output, daemon=True)
            monitor_thread.start()

        except paramiko.BadHostKeyException as e:
            print(f'[SSH Interactive] Host key mismatch: {e}')
            emit('message', {
                'type': 'error',
                'error': (
                    f'Host key verification failed for {host}: the host '
                    'presented a key that does not match the one previously '
                    f'recorded in {known_hosts_path()}. This may indicate a '
                    "machine-in-the-middle attack. If the host's key "
                    'legitimately changed, remove its entry from that file '
                    'and retry.'
                )
            })
        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f'[SSH Interactive] Connection error: {error_trace}')
            emit('message', {
                'type': 'error',
                'error': f'Connection failed: {str(e)}'
            })

    elif message_type == 'input':
        # Route input ONLY to a session owned by this socket. An optional
        # sessionId narrows it further (and must still belong to this socket).
        owned = _sessions_for_socket(request.sid)
        requested = data.get('sessionId')
        if requested:
            owned = [s for s in owned if s == requested]
        if not owned:
            emit('message', {'type': 'error', 'error': 'No active SSH session for this connection'})
            return
        session_data = ssh_sessions.get(owned[-1])
        if session_data:
            try:
                input_data = data.get('data', '')
                channel = session_data['channel']
                channel.send(input_data)
            except Exception as e:
                print(f'[SSH Interactive] Input error: {e}')


def cleanup_ssh_connections():
    """Close all SSH connections in the pool"""
    print("[SSH Pool] Cleaning up connections...")
    with _ssh_pool_lock:
        clients = list(ssh_connection_pool.items())
        ssh_connection_pool.clear()
    for key, client in clients:
        try:
            client.close()
            print(f"[SSH Pool] Closed connection: {key}")
        except:
            pass
