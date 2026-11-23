"""
Sign-in for the browser deployment (``JACARIUM_AUTH_MODE=accounts``).

    POST /api/auth/setup      first run only: {setupCode, username, password,
                              displayName} -> the admin account + a session
    POST /api/auth/login      {username, password} -> session cookie
    POST /api/auth/sso/begin  {purpose: login|link|confirm, password?} ->
                              {url}: where the browser goes (the identity
                              provider), with the sealed state cookie set
    GET  /api/auth/sso/callback  the provider's answer: signs in, links or
                              confirms, then a same-site page leads back
    POST /api/auth/sso/unlink {password}
    POST /api/auth/logout
    GET  /api/auth/me         the signed-in user (401 otherwise)
    POST /api/auth/password   {currentPassword, newPassword}; an account
                              without a password (single sign-on only)
                              sets its first one after a fresh SSO
                              round-trip (purpose confirm) instead
    POST /api/auth/profile    {displayName}

    devices (the desktop app linked to this server, src/electron/home-server.cjs):
    GET    /api/auth/devices            the account's device tokens
    POST   /api/auth/devices            {name} -> {id, token} (the token is shown once)
    DELETE /api/auth/devices/<id>       revoke
    A request may authenticate with ``Authorization: Bearer <token>``
    instead of the cookie; it still carries the X-Requested-With header.

    admin only:
    GET  /api/admin/users
    POST /api/admin/users                 {username, password, displayName, role}
    POST /api/admin/users/<id>/disable | /enable
    POST /api/admin/users/<id>/password   {newPassword}
    GET/PUT /api/admin/settings           the server-default settings
                                          (same contract as /api/settings)

The cookie: ``__Host-jacarium_session`` - Secure, HttpOnly, SameSite=Strict,
Path=/ (the ``__Host-`` prefix makes browsers refuse it over plain HTTP or
with a Domain attribute). Every state-changing request must also carry
``X-Requested-With: Jacarium`` (checked in extensions.py), which a
cross-site page cannot add without a CORS preflight; the proxy's own
cross-site guard (deploy/Caddyfile) is the third layer.

Rate limits: /login 20 per IP and 8 per username per 15 minutes; /setup 10
per IP per 15 minutes. 429 with Retry-After.

On the first admin's creation, the data the container collected before
accounts existed is adopted (``legacy_migration.migrate_container_data``).
"""
import html
import time

from flask import Blueprint, g, jsonify, make_response, request

import accounts
import oidc
from accounts import AccountsError, RateLimiter
from oidc import OidcError
from user_context import accounts_mode, current_user, is_admin, user_home_for

auth_api = Blueprint('auth_api', __name__)

SESSION_COOKIE = '__Host-jacarium_session'
CSRF_HEADER = 'X-Requested-With'
CSRF_VALUE = 'Jacarium'

login_ip_limiter = RateLimiter(20, 15 * 60)
login_user_limiter = RateLimiter(8, 15 * 60)
setup_limiter = RateLimiter(10, 15 * 60)
# single sign-on round-trips per address: a household or an office behind one address signs in together in the
# morning, so the window is wider than the password one (nothing is guessed here; it bounds work, not attempts)
sso_limiter = RateLimiter(60, 15 * 60)
sso_callback_limiter = RateLimiter(60, 15 * 60)


def client_ip():
    # Behind the proxy (deploy/Caddyfile) the client address is forwarded;
    # the proxy is the only way in, so the header is trustworthy there.
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()[:64]
    return (request.remote_addr or 'unknown')[:64]


def session_cookie_value():
    return request.cookies.get(SESSION_COOKIE)


def set_session_cookie(response, raw):
    response.set_cookie(SESSION_COOKIE, raw, max_age=accounts.SESSION_MAX_AGE_SECONDS,
                        secure=True, httponly=True, samesite='Strict', path='/')


def clear_session_cookie(response):
    response.set_cookie(SESSION_COOKIE, '', max_age=0, expires=0, secure=True, httponly=True, samesite='Strict', path='/')


def _too_many(retry_after):
    response = jsonify({'error': 'Too many attempts. Try again later.', 'retryAfter': retry_after})
    response.status_code = 429
    response.headers['Retry-After'] = str(retry_after)
    return response


def _json_body():
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _session_response(user, raw_session, status=200):
    response = make_response(jsonify({'ok': True, 'user': user}), status)
    set_session_cookie(response, raw_session)
    return response


def require_admin():
    """A refusal response, or None when the request's user is an admin."""
    if not current_user():
        return jsonify({'error': 'Sign in first'}), 401
    if not is_admin():
        return jsonify({'error': 'Administrator access required'}), 403
    return None


# ---------------------------------------------------------------------------
# step-up for linked devices (the desktop app administering its home server)
# ---------------------------------------------------------------------------
# A device token signs the desktop's requests (src/electron/home-server.cjs)
# and is deliberately weaker than a password session: it may READ the
# administration (users, audit, sessions, devices), but every state-changing
# administrative action over it needs the administrator's password once,
# right before that action: POST /api/auth/step-up {password} marks the
# token elevated for ONE such action within STEP_UP_SECONDS. Verified with
# the login rate limits, audited ('step-up'), never stored. Password sessions
# (the browser) are unaffected; "Delete all my data" keeps refusing device
# tokens altogether.
STEP_UP_SECONDS = 90
_step_ups = {}   # token hash -> expiry (single use)


def _step_up_key():
    token = bearer_token()
    return accounts._token_hash(token) if token else None


def consume_step_up():
    """True when the request's device token was elevated (and spend it)."""
    key = _step_up_key()
    if not key:
        return False
    expiry = _step_ups.pop(key, 0)
    return expiry > time.time()


def require_admin_action():
    """require_admin() plus, over a device token, a spent step-up."""
    refusal = require_admin()
    if refusal:
        return refusal
    if bearer_token() and not consume_step_up():
        return jsonify({'error': 'Confirm your password to do this from a linked device', 'code': 'STEP_UP_REQUIRED'}), 403
    return None


# ---------------------------------------------------------------------------
# the central server behind this console: the account ticket is the way in
# ---------------------------------------------------------------------------
# A signed-in user (session cookie, or a linked desktop's device token) gets a
# short-lived signed ticket naming the account's identity on the central
# server (backend/central_ticket.py); the central server verifies it with the
# key the two share - the only way a client is recognised there. Minting is
# cheap and happens at every (re)connect, so it is audited once per account
# and hour, not per ticket; failures are audited.
ticket_limiter = RateLimiter(120, 60)
_ticket_audited = {}   # user id -> last audit time


@auth_api.route('/api/auth/central-ticket', methods=['POST'])
def central_ticket():
    import central_ticket as tickets
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    if not tickets.central_provided():
        return jsonify({'error': 'This server provides no central server', 'code': 'NO_CENTRAL'}), 404
    if not tickets.account_sign_in_available():
        return jsonify({'error': 'The central server behind this server accepts no account sign-in (it has no ticket key): redeploy the server', 'code': 'ACCOUNT_SIGN_IN_NOT_ACCEPTED'}), 409
    allowed, retry = ticket_limiter.hit(f"{user['id']}|{client_ip()}")
    if not allowed:
        accounts.audit('central-ticket-rate-limited', user=user['username'], ip=client_ip())
        return _too_many(retry)
    ticket, expires_at, machine_id = tickets.mint(user)
    now = time.time()
    if now - _ticket_audited.get(user['id'], 0) > 3600:
        _ticket_audited[user['id']] = now
        accounts.audit('central-ticket', user=user['username'], identity=machine_id, ip=client_ip(), device=('token' if bearer_token() else 'session'))
    return jsonify({'ticket': ticket, 'expiresAt': expires_at, 'identity': machine_id, 'centralPath': tickets.central_path(), 'validFor': tickets.TICKET_SECONDS})


@auth_api.route('/api/auth/step-up', methods=['POST'])
def step_up():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    if not bearer_token():
        return jsonify({'error': 'Only a linked device needs to confirm its password'}), 400
    allowed, retry = login_ip_limiter.hit(client_ip())
    if not allowed:
        return _too_many(retry)
    allowed, retry = login_user_limiter.hit(user['username'])
    if not allowed:
        return _too_many(retry)
    body = _json_body()
    if not accounts.check_login(user['username'], body.get('password')):
        accounts.audit('step-up-failed', user=user['username'], ip=client_ip())
        return jsonify({'error': 'Wrong password'}), 403
    _step_ups[_step_up_key()] = time.time() + STEP_UP_SECONDS
    accounts.audit('step-up', user=user['username'], ip=client_ip())
    return jsonify({'ok': True, 'validFor': STEP_UP_SECONDS})


# ---------------------------------------------------------------------------
# first-run setup
# ---------------------------------------------------------------------------
@auth_api.route('/api/auth/setup', methods=['POST'])
def setup():
    if not accounts_mode():
        return jsonify({'error': 'Accounts are not enabled on this server'}), 404
    allowed, retry = setup_limiter.hit(client_ip())
    if not allowed:
        return _too_many(retry)
    if not accounts.setup_required():
        return jsonify({'error': 'Setup is already done: sign in instead'}), 409
    body = _json_body()
    if not accounts.verify_setup_code(body.get('setupCode')):
        print(f'[Accounts] setup refused from {client_ip()}: wrong or missing setup code')
        return jsonify({'error': 'Wrong setup code. It is printed in the server log and stored in setup-code on the data volume.'}), 403
    try:
        user = accounts.create_user(body.get('username'), body.get('password'), body.get('displayName'), role='admin', require_empty=True)
    except AccountsError as exc:
        status = 409 if 'already' in str(exc) else 400
        return jsonify({'error': str(exc)}), status
    accounts.clear_setup_code()
    print(f'[Accounts] first admin account created: {user["username"]} (from {client_ip()})')
    try:
        from legacy_migration import migrate_container_data
        report = migrate_container_data(user_home_for(user['id']), log=print)
    except Exception as exc:  # the account exists; the data can be adopted by hand
        print(f'[Accounts] WARNING: adopting the pre-accounts data failed: {exc}')
        report = {'error': str(exc)}
    raw = accounts.create_session(user['id'], request.headers.get('User-Agent', ''))
    g.user = user
    response = _session_response(user, raw, 201)
    payload = response.get_json()
    payload['migration'] = report
    response.set_data(jsonify(payload).get_data())
    return response


# ---------------------------------------------------------------------------
# sign in / out
# ---------------------------------------------------------------------------
@auth_api.route('/api/auth/login', methods=['POST'])
def login():
    if not accounts_mode():
        return jsonify({'error': 'Accounts are not enabled on this server'}), 404
    body = _json_body()
    username = body.get('username') if isinstance(body.get('username'), str) else ''
    password = body.get('password') if isinstance(body.get('password'), str) else ''
    ip = client_ip()
    allowed, retry = login_ip_limiter.hit(ip)
    if not allowed:
        return _too_many(retry)
    key = username.strip().lower()[:64] or '-'
    allowed, retry = login_user_limiter.hit(key)
    if not allowed:
        return _too_many(retry)
    if accounts.setup_required():
        return jsonify({'error': 'No account exists yet: create the first one with the setup code', 'setupRequired': True}), 409
    user = accounts.check_login(username, password)
    if not user:
        print(f'[Accounts] sign-in refused for {key!r} from {ip}')
        accounts.audit('sign-in-failed', user=key, ip=ip)
        return jsonify({'error': 'Wrong username or password'}), 401
    if not oidc.password_login_allowed() and user['role'] != 'admin':
        # JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN: the right password of a non-administrator is still refused (after
        # the check, so the answer tells nothing about which usernames exist); administrators keep the way in
        accounts.audit('sign-in-refused-sso-only', user=user['username'], ip=ip)
        return jsonify({'error': 'This server signs in with single sign-on. Passwords are for administrators only.', 'code': 'PASSWORD_LOGIN_DISABLED'}), 403
    login_user_limiter.clear(key)
    raw = accounts.create_session(user['id'], request.headers.get('User-Agent', ''))
    g.user = user
    print(f'[Accounts] {user["username"]} signed in from {ip}' + (' with a temporary password (must change it now)' if user.get('mustChangePassword') else ''))
    accounts.audit('sign-in', user=user['username'], ip=ip, temporary=int(bool(user.get('mustChangePassword'))))
    return _session_response(user, raw)


@auth_api.route('/api/auth/logout', methods=['POST'])
def logout():
    raw = session_cookie_value()
    # a session that came from the provider may end there too (JACARIUM_OIDC_END_SESSION): the page goes on to it
    onward = oidc.end_session_url() if accounts.session_sso_age(raw) is not None else None
    accounts.delete_session(raw)
    response = make_response(jsonify({'ok': True, **({'ssoLogoutUrl': onward} if onward else {})}))
    clear_session_cookie(response)
    return response


# ---------------------------------------------------------------------------
# single sign-on (OpenID Connect; backend/oidc.py)
# ---------------------------------------------------------------------------
# Every round-trip starts with a POST from this app (the X-Requested-With guard applies: no other site can start
# one in the user's browser) and comes back as a top-level navigation from the provider, which carries the sealed
# state cookie (SameSite=Lax) but not the session cookie (SameSite=Strict). So the callback never trusts a session:
# what a link / confirm applies to is named inside the sealed cookie, by the hash of the session that asked.
def set_sso_cookie(response, sealed):
    response.set_cookie(oidc.STATE_COOKIE, sealed, max_age=oidc.FLOW_SECONDS, secure=True, httponly=True, samesite='Lax', path='/')


def clear_sso_cookie(response):
    response.set_cookie(oidc.STATE_COOKIE, '', max_age=0, expires=0, secure=True, httponly=True, samesite='Lax', path='/')


def _sso_landing(query, raw_session=None):
    """
    The callback's answer: a page of this origin that leads back into the app. Not a redirect - the browser got
    here through the provider (a cross-site navigation), and a SameSite=Strict session cookie set on a redirect in
    that chain is not sent to where it points; a navigation this page starts itself is same-site, and it is.
    """
    try:
        base = oidc.config()['public_url']
    except OidcError:
        base = ''
    target = html.escape(f'{base}/?{query}', quote=True)
    page = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">'
            f'<meta http-equiv="refresh" content="0;url={target}"><title>Jacarium</title></head>'
            f'<body><p><a href="{target}">Continue to Jacarium</a></p></body></html>')
    response = make_response(page, 200)
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Content-Security-Policy'] = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    response.headers['Referrer-Policy'] = 'no-referrer'
    clear_sso_cookie(response)
    if raw_session:
        set_session_cookie(response, raw_session)
    return response


def _sso_refused(code, detail, **fields):
    """Log and audit the reason; the page only ever gets the short code (its own text, never the provider's)."""
    print(f'[Accounts] single sign-on refused from {client_ip()}: {code} ({detail})')
    accounts.audit('sso-refused', reason=code, ip=client_ip(), **fields)
    return _sso_landing(f'sso_error={code}')


@auth_api.route('/api/auth/sso/begin', methods=['POST'])
def sso_begin():
    if not accounts_mode() or not oidc.enabled():
        return jsonify({'error': 'Single sign-on is not configured on this server'}), 404
    allowed, retry = sso_limiter.hit(client_ip())
    if not allowed:
        return _too_many(retry)
    body = _json_body()
    purpose = body.get('purpose') or 'login'
    user_id = session = None
    if purpose == 'login':
        if accounts.setup_required():
            return jsonify({'error': 'No account exists yet: create the first one with the setup code', 'setupRequired': True}), 409
    elif purpose in ('link', 'confirm'):
        user = current_user()
        session = session_cookie_value()
        if not user or bearer_token() or not accounts.validate_session(session):
            return jsonify({'error': 'Sign in in the browser first'}), 401
        if purpose == 'link':
            if user.get('sso'):
                return jsonify({'error': 'This account is already linked to an identity: unlink it first'}), 409
            if user.get('hasPassword'):
                # whoever holds the session must also know the password before another way in is attached
                allowed, retry = login_user_limiter.hit(user['username'])
                if not allowed:
                    return _too_many(retry)
                if not accounts.check_login(user['username'], body.get('password')):
                    accounts.audit('sso-link-refused', user=user['username'], reason='password', ip=client_ip())
                    return jsonify({'error': 'Wrong password'}), 403
                login_user_limiter.clear(user['username'])
        elif not user.get('sso'):
            return jsonify({'error': 'This account is not linked to an identity'}), 409
        user_id = user['id']
    else:
        return jsonify({'error': 'purpose must be login, link or confirm'}), 400
    try:
        url, sealed = oidc.begin(purpose, user_id=user_id, session=session)
    except OidcError as exc:
        print(f'[Accounts] single sign-on could not start ({purpose}) from {client_ip()}: {exc.detail}')
        accounts.audit('sso-refused', reason=exc.code, ip=client_ip())
        return jsonify({'error': 'Single sign-on is not available right now. An administrator finds the reason in the server log.', 'code': exc.code}), 502
    response = make_response(jsonify({'ok': True, 'url': url}))
    response.headers['Cache-Control'] = 'no-store'
    set_sso_cookie(response, sealed)
    return response


def _sso_sign_in(claims, cfg):
    """An SSO sign-in resolved to an account: (user, what happened) or an OidcError naming why not."""
    issuer, subject = cfg['issuer'], claims['sub']
    verdict = oidc.access(claims, cfg)
    if not verdict['allowed']:
        raise OidcError(verdict['reason'], f'identity {subject!r} is not on the allow-list')
    user, event = accounts.get_user_by_identity(issuer, subject), 'sso-sign-in'
    if user is None:
        email = oidc.verified_email(claims)
        invited = accounts.get_user_by_sso_invite(email) if email else None
        if invited is not None:
            # an administrator approved exactly this verified email for exactly this account, once
            user, event = accounts.link_identity(invited['id'], issuer, subject), 'sso-linked-by-invite'
        elif cfg['auto_create']:
            username = oidc.new_username(claims, cfg)
            if accounts.get_user_by_username(username):
                # never attach to an account because a name matches: its owner links it from Settings
                raise OidcError('link_required', f'the username {username!r} exists; the identity is not linked to it')
            user = accounts.create_sso_user(username, oidc.display_name(claims, username), role='admin' if verdict['admin'] else 'user', issuer=issuer, subject=subject)
            user_home_for(user['id'])
            event = 'sso-user-created'
        else:
            raise OidcError('no_account', f'no account is linked to identity {subject!r} and accounts are not created at sign-in')
    if user['disabled']:
        raise OidcError('disabled', f'{user["username"]} is disabled')
    if verdict['admin'] and user['role'] != 'admin':
        user = accounts.set_user_role(user['id'], 'admin')
        accounts.audit('sso-role-granted', user=user['username'], role='admin', ip=client_ip())
    return user, event


@auth_api.route('/api/auth/sso/callback', methods=['GET'])
def sso_callback():
    if not accounts_mode() or not oidc.enabled():
        return jsonify({'error': 'Single sign-on is not configured on this server'}), 404
    allowed, retry = sso_callback_limiter.hit(client_ip())
    if not allowed:
        return _too_many(retry)
    if request.args.get('error'):
        # the provider's own words stay in the log; the page gets one of two codes
        refused = request.args.get('error') in ('access_denied', 'login_required', 'interaction_required', 'consent_required')
        return _sso_refused('denied' if refused else 'provider', f"the provider answered {str(request.args.get('error'))[:60]!r}")
    try:
        cfg = oidc.config()
        claims, flow = oidc.finish(request.args.get('code'), request.args.get('state'), request.cookies.get(oidc.STATE_COOKIE))
        purpose = flow['p']
        if purpose == 'login':
            user, event = _sso_sign_in(claims, cfg)
            raw = accounts.create_session(user['id'], request.headers.get('User-Agent', ''), sso=True)
            g.user = user
            print(f'[Accounts] {user["username"]} signed in with single sign-on from {client_ip()} ({event})')
            accounts.audit(event, user=user['username'], ip=client_ip(), **({'role': user['role']} if event == 'sso-user-created' else {}))
            return _sso_landing('sso=signed-in', raw)
        # link / confirm: for the account and the very session that asked (named in the sealed cookie)
        user = accounts.get_user(flow.get('u')) if flow.get('u') else None
        live = {row['id'] for row in accounts.list_sessions(user['id'])} if user else set()
        if user is None or user['disabled'] or not flow.get('h') or flow['h'] not in live:
            raise OidcError('wrong_session', 'the session that asked is gone')
        verdict = oidc.access(claims, cfg)
        if not verdict['allowed']:
            raise OidcError(verdict['reason'], 'the identity is not on the allow-list')
        if purpose == 'link':
            try:
                accounts.link_identity(user['id'], cfg['issuer'], claims['sub'])
            except AccountsError as exc:
                raise OidcError('identity_in_use', str(exc)) from exc
            accounts.mark_session_hash_sso(flow['h'])
            accounts.audit('sso-linked', user=user['username'], ip=client_ip())
            print(f'[Accounts] {user["username"]} linked a single sign-on identity from {client_ip()}')
            return _sso_landing('sso=linked')
        if not user.get('sso') or (user['sso']['issuer'], user['sso']['subject']) != (cfg['issuer'], claims['sub']):
            raise OidcError('mismatch', 'another identity than the linked one confirmed')
        accounts.mark_session_hash_sso(flow['h'])
        accounts.audit('sso-confirmed', user=user['username'], ip=client_ip())
        return _sso_landing('sso=confirmed')
    except OidcError as exc:
        return _sso_refused(exc.code, exc.detail)
    except AccountsError as exc:
        return _sso_refused('refused', str(exc))
    except Exception as exc:   # never a stack trace on the way back from the provider
        return _sso_refused('provider', f'unexpected {type(exc).__name__}: {exc}')


@auth_api.route('/api/auth/sso/unlink', methods=['POST'])
def sso_unlink():
    user = current_user()
    if not user or bearer_token():
        return jsonify({'error': 'Sign in in the browser first'}), 401
    allowed, retry = login_user_limiter.hit(user['username'])
    if not allowed:
        return _too_many(retry)
    if not user.get('hasPassword'):
        return jsonify({'error': 'This account has no password: set one first, or it could not sign in any more'}), 409
    if not accounts.check_login(user['username'], _json_body().get('password')):
        return jsonify({'error': 'Wrong password'}), 403
    login_user_limiter.clear(user['username'])
    try:
        g.user = accounts.unlink_identity(user['id'])
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 409
    accounts.audit('sso-unlinked', user=user['username'], ip=client_ip())
    return jsonify({'ok': True, 'user': g.user})


@auth_api.route('/api/auth/me', methods=['GET'])
def me():
    user = current_user()
    if not user:
        return jsonify({'error': 'Not signed in', 'authMode': 'accounts', 'setupRequired': accounts.setup_required() if accounts_mode() else False}), 401
    return jsonify({'user': user})


@auth_api.route('/api/auth/password', methods=['POST'])
def change_password():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    body = _json_body()
    current = body.get('currentPassword') if isinstance(body.get('currentPassword'), str) else ''
    first = not user.get('hasPassword')
    if first:
        # an account that signs in with SSO only has no current password to ask for: the session must have come
        # back from the provider within the last minutes (POST /api/auth/sso/begin {purpose: confirm}), so a
        # session someone else got hold of cannot quietly give the account a password of theirs
        age = None if bearer_token() else accounts.session_sso_age(session_cookie_value())
        if age is None or age > oidc.FRESH_SECONDS:
            return jsonify({'error': 'Confirm with single sign-on first, then set the password', 'code': 'SSO_CONFIRM_REQUIRED'}), 403
    elif not accounts.check_login(user['username'], current):
        return jsonify({'error': 'The current password is wrong'}), 403
    try:
        accounts.set_user_password(user['id'], body.get('newPassword'), keep_sessions=session_cookie_value())
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 400
    accounts.audit('password-set' if first else 'password-changed-after-recovery' if user.get('mustChangePassword') else 'password-changed', user=user['username'], ip=client_ip())
    g.user = accounts.get_user(user['id'])
    return jsonify({'ok': True, 'user': g.user})


@auth_api.route('/api/auth/profile', methods=['POST'])
def update_profile():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    body = _json_body()
    try:
        updated = accounts.set_display_name(user['id'], body.get('displayName'))
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 400
    g.user = updated
    return jsonify({'ok': True, 'user': updated})


# ---------------------------------------------------------------------------
# devices
# ---------------------------------------------------------------------------
@auth_api.route('/api/auth/devices', methods=['GET'])
def list_devices():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    return jsonify({'devices': accounts.list_device_tokens(user['id'])})


@auth_api.route('/api/auth/devices', methods=['POST'])
def create_device():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    if bearer_token():
        return jsonify({'error': 'A device cannot mint another device token: sign in with the password'}), 403
    body = _json_body()
    try:
        token_id, raw = accounts.create_device_token(user['id'], body.get('name'))
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 400
    print(f'[Accounts] {user["username"]} linked a device ({body.get("name") or "device"})')
    accounts.audit('device-linked', user=user['username'], device=(body.get('name') or 'device').replace(' ', '_')[:40], ip=client_ip())
    return jsonify({'ok': True, 'id': token_id, 'token': raw, 'user': user}), 201


@auth_api.route('/api/auth/devices/<token_id>', methods=['DELETE'])
def revoke_device(token_id):
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    if not accounts.revoke_device_token(user['id'], token_id):
        return jsonify({'error': 'No such device'}), 404
    accounts.audit('device-revoked', user=user['username'], by=user['username'])
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# sessions (one's own; an administrator sees and ends anyone's below)
# ---------------------------------------------------------------------------
@auth_api.route('/api/auth/sessions', methods=['GET'])
def list_own_sessions():
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    return jsonify({'sessions': accounts.list_sessions(user['id'], session_cookie_value())})


@auth_api.route('/api/auth/sessions/<session_id>', methods=['DELETE'])
def end_own_session(session_id):
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    if not accounts.delete_session_id(user['id'], session_id):
        return jsonify({'error': 'No such session'}), 404
    accounts.audit('session-ended', user=user['username'], by=user['username'])
    return jsonify({'ok': True})


@auth_api.route('/api/auth/sessions', methods=['DELETE'])
def end_other_sessions():
    """Sign out everywhere else (this session stays)."""
    user = current_user()
    if not user:
        return jsonify({'error': 'Sign in first'}), 401
    ended = accounts.delete_other_sessions(user['id'], session_cookie_value())
    accounts.audit('sessions-ended', user=user['username'], by=user['username'], count=ended)
    return jsonify({'ok': True, 'ended': ended})


# ---------------------------------------------------------------------------
# administration
# ---------------------------------------------------------------------------
@auth_api.route('/api/admin/users', methods=['GET'])
def admin_list_users():
    refusal = require_admin()
    if refusal:
        return refusal
    return jsonify({'users': accounts.list_users()})


@auth_api.route('/api/admin/users', methods=['POST'])
def admin_create_user():
    refusal = require_admin_action()
    if refusal:
        return refusal
    body = _json_body()
    role = body.get('role') or 'user'
    try:
        if body.get('ssoEmail') and not body.get('password'):
            # no password: the person signs in with single sign-on, and this verified email links them once
            if not oidc.enabled():
                return jsonify({'error': 'Single sign-on is not configured on this server'}), 400
            user = accounts.create_sso_user(body.get('username'), body.get('displayName'), role=role, invite_email=body.get('ssoEmail'))
        else:
            user = accounts.create_user(body.get('username'), body.get('password'), body.get('displayName'), role=role)
    except AccountsError as exc:
        status = 409 if 'taken' in str(exc) else 400
        return jsonify({'error': str(exc)}), status
    user_home_for(user['id'])
    print(f'[Accounts] {current_user()["username"]} created account {user["username"]} ({role})')
    accounts.audit('user-created', user=user['username'], role=role, by=current_user()['username'])
    return jsonify({'ok': True, 'user': user}), 201


def _admin_target(user_id):
    target = accounts.get_user(user_id)
    if not target:
        return None, (jsonify({'error': 'No such user'}), 404)
    return target, None


@auth_api.route('/api/admin/users/<user_id>/sso', methods=['POST'])
def admin_user_sso(user_id):
    """{action: 'unlink'} or {action: 'invite', email} ('' withdraws the invite)."""
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, missing = _admin_target(user_id)
    if missing:
        return missing
    body = _json_body()
    by = current_user()['username']
    try:
        if body.get('action') == 'unlink':
            user = accounts.unlink_identity(user_id)
            accounts.audit('sso-unlinked', user=target['username'], by=by)
        elif body.get('action') == 'invite':
            user = accounts.set_sso_invite(user_id, body.get('email') or None)
            accounts.audit('sso-invited' if user.get('ssoInviteEmail') else 'sso-invite-withdrawn', user=target['username'], by=by)
        else:
            return jsonify({'error': 'action must be unlink or invite'}), 400
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 409
    return jsonify({'ok': True, 'user': user})


@auth_api.route('/api/admin/users/<user_id>/disable', methods=['POST'])
def admin_disable_user(user_id):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    if target['id'] == current_user()['id']:
        return jsonify({'error': 'You cannot disable your own account'}), 400
    if target['role'] == 'admin' and not target['disabled'] and accounts.admin_count() <= 1:
        return jsonify({'error': 'The last administrator cannot be disabled'}), 400
    accounts.audit('user-disabled', user=target['username'], by=current_user()['username'])
    return jsonify({'ok': True, 'user': accounts.set_user_disabled(user_id, True)})


@auth_api.route('/api/admin/users/<user_id>/enable', methods=['POST'])
def admin_enable_user(user_id):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    accounts.audit('user-enabled', user=target['username'], by=current_user()['username'])
    return jsonify({'ok': True, 'user': accounts.set_user_disabled(user_id, False)})


@auth_api.route('/api/admin/users/<user_id>/password', methods=['POST'])
def admin_reset_password(user_id):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    body = _json_body()
    try:
        keep = session_cookie_value() if target['id'] == current_user()['id'] else None
        accounts.set_user_password(user_id, body.get('newPassword'), keep_sessions=keep)
    except AccountsError as exc:
        return jsonify({'error': str(exc)}), 400
    print(f'[Accounts] {current_user()["username"]} reset the password of {target["username"]}')
    accounts.audit('password-reset', user=target['username'], by=current_user()['username'])
    return jsonify({'ok': True})


@auth_api.route('/api/admin/users/<user_id>/role', methods=['POST'])
def admin_set_role(user_id):
    """Promote or demote. The last administrator is never demoted (it would lock everyone out)."""
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    role = (_json_body().get('role') or '').strip()
    if role not in ('admin', 'user'):
        return jsonify({'error': 'role must be admin or user'}), 400
    if role == 'user' and target['role'] == 'admin' and not target['disabled'] and accounts.admin_count() <= 1:
        return jsonify({'error': 'The last administrator cannot be demoted'}), 400
    if role == target['role']:
        return jsonify({'ok': True, 'user': target})
    updated = accounts.set_user_role(user_id, role)
    accounts.audit('role-changed', user=target['username'], role=role, by=current_user()['username'])
    return jsonify({'ok': True, 'user': updated})


@auth_api.route('/api/admin/users/<user_id>', methods=['DELETE'])
def admin_delete_user(user_id):
    """Delete an account (its sessions and devices with it). Its home directory on the volume stays."""
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    if target['id'] == current_user()['id']:
        return jsonify({'error': 'You cannot delete your own account'}), 400
    if target['role'] == 'admin' and not target['disabled'] and accounts.admin_count() <= 1:
        return jsonify({'error': 'The last administrator cannot be deleted'}), 400
    if (_json_body().get('confirmUsername') or '').strip().lower() != target['username']:
        return jsonify({'error': 'Type the username to confirm'}), 400
    accounts.delete_user(user_id)
    accounts.audit('user-deleted', user=target['username'], by=current_user()['username'])
    print(f'[Accounts] {current_user()["username"]} deleted account {target["username"]} (its data directory stays on the volume)')
    return jsonify({'ok': True})


@auth_api.route('/api/admin/users/<user_id>/sessions', methods=['GET'])
def admin_list_sessions(user_id):
    refusal = require_admin()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    mine = session_cookie_value() if target['id'] == current_user()['id'] else None
    return jsonify({'sessions': accounts.list_sessions(user_id, mine), 'devices': accounts.list_device_tokens(user_id)})


@auth_api.route('/api/admin/users/<user_id>/sessions/<session_id>', methods=['DELETE'])
def admin_end_session(user_id, session_id):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    if not accounts.delete_session_id(user_id, session_id):
        return jsonify({'error': 'No such session'}), 404
    accounts.audit('session-ended', user=target['username'], by=current_user()['username'])
    return jsonify({'ok': True})


@auth_api.route('/api/admin/users/<user_id>/devices/<token_id>', methods=['DELETE'])
def admin_revoke_device(user_id, token_id):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target, error = _admin_target(user_id)
    if error:
        return error
    if not accounts.revoke_device_token(user_id, token_id):
        return jsonify({'error': 'No such device'}), 404
    accounts.audit('device-revoked', user=target['username'], by=current_user()['username'])
    return jsonify({'ok': True})


@auth_api.route('/api/admin/audit', methods=['GET'])
def admin_audit():
    """The audit log (sign-ins, failures, password changes/resets/recoveries, administrative acts, data deletions)."""
    refusal = require_admin()
    if refusal:
        return refusal
    try:
        limit = int(request.args.get('limit', 200))
    except ValueError:
        limit = 200
    return jsonify({'entries': accounts.read_audit(limit)})


@auth_api.route('/api/admin/settings', methods=['GET', 'PUT'])
def admin_settings():
    """The server-default settings every account inherits (admin only)."""
    refusal = require_admin_action() if request.method == 'PUT' else require_admin()
    if refusal:
        return refusal
    from settings_store import get_settings_for, put_settings_for, server_defaults_path
    if request.method == 'GET':
        return get_settings_for(server_defaults_path())
    from settings_store import _limiters
    _limiters()
    return put_settings_for(server_defaults_path(), apply_environ=False, audit_scope='server')


def bearer_token():
    header = request.headers.get('Authorization', '')
    if header.lower().startswith('bearer '):
        return header[7:].strip()
    return None


def session_user_from_request():
    """The user for the request's session cookie or device token (None when absent/invalid)."""
    token = bearer_token()
    if token:
        return accounts.validate_device_token(token)
    return accounts.validate_session(session_cookie_value())


def csrf_ok():
    """State-changing requests must carry the custom header."""
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return True
    return request.headers.get(CSRF_HEADER, '') == CSRF_VALUE


_last_purge = [0.0]


def purge_sessions_occasionally():
    now = time.time()
    if now - _last_purge[0] > 3600:
        _last_purge[0] = now
        try:
            accounts.purge_expired_sessions(now)
        except Exception:
            pass
