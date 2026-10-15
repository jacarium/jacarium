"""
Google Calendar authentication on the backend (backend/google_calendar.py):

  GET  /api/calendar/auth-status   configured / authenticated plus
                                   signInAvailable (false for the browser
                                   deployment), signInPending, signInError,
                                   offline
  POST /api/calendar/authenticate  400 NOT_CONFIGURED with a clear message,
                                   501 SIGN_IN_UNAVAILABLE in a browser
                                   deployment (the InstalledAppFlow is never
                                   built: it would open a browser on the
                                   server), 403 {offline:true} in Offline
                                   Mode, 409 while a sign-in is pending; on
                                   the desktop (auth mode app-token) the flow
                                   runs on its own thread and the request
                                   answers 202 at once, auth-status reports
                                   signInPending until the token is saved
                                   (0600) or the failure message.

Flask test client, a temp HOME, synthetic client values, the Google flow
replaced by a fake - nothing contacts Google. Run with the backend venv:
  backend/venv/bin/python tests/google_calendar_auth.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import stat
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

HOME = tempfile.mkdtemp(prefix='jacarium-gcal-auth-')
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'none'          # the browser deployment without sign-in
os.environ['JACARIUM_ENV_FILE'] = os.path.join(HOME, 'jacarium.env')
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, 'known_hosts')
for key in ('GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import google_calendar  # noqa: E402

client = app_module.app.test_client()
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(detail)[:300]) if (not ok and detail) else ''}")


def body(r):
    return r.get_json(silent=True) or {}


class FakeCreds:
    """Picklable stand-in for google.oauth2.credentials.Credentials."""
    valid = True
    expired = False
    refresh_token = 'synthetic-refresh'


class FakeFlow:
    """InstalledAppFlow stand-in: run_local_server blocks on an event."""
    release = threading.Event()
    fail_with = None
    calls = []

    @classmethod
    def from_client_config(cls, config, scopes):
        cls.calls.append((config, scopes))
        return cls()

    def run_local_server(self, **kwargs):
        FakeFlow.release.wait(5)
        if FakeFlow.fail_with:
            raise RuntimeError(FakeFlow.fail_with)
        return FakeCreds()


class RefusingFlow:
    @classmethod
    def from_client_config(cls, config, scopes):
        raise AssertionError('InstalledAppFlow must not be built in a browser deployment')


token_path = google_calendar.token_file()

# ---- not configured ----
r = client.get('/api/calendar/auth-status')
b = body(r)
check('not configured: configured False, authenticated False, signInAvailable False (browser)', b.get('configured') is False and b.get('authenticated') is False and b.get('signInAvailable') is False and 'offline' not in b, b)
check("not configured: the message says where to add the client", 'Settings > Integrations > Google Calendar' in b.get('message', ''), b.get('message'))
google_calendar.InstalledAppFlow = RefusingFlow
r = client.post('/api/calendar/authenticate')
b = body(r)
check('not configured: POST /authenticate -> 400 NOT_CONFIGURED with the same clear message', r.status_code == 400 and b.get('code') == 'NOT_CONFIGURED' and 'Settings > Integrations' in b.get('message', '') and b.get('success') is False, (r.status_code, b))

# ---- configured, browser deployment: the sign-in is refused cleanly ----
os.environ['GOOGLE_CALENDAR_CLIENT_ID'] = '000000000000-synthetic.apps.googleusercontent.com'
os.environ['GOOGLE_CALENDAR_CLIENT_SECRET'] = 'GOCSPX-synthetic-secret'
r = client.get('/api/calendar/auth-status')
b = body(r)
check('configured (browser): configured True, authenticated False, signInAvailable False', b.get('configured') is True and b.get('authenticated') is False and b.get('signInAvailable') is False, b)
r = client.post('/api/calendar/authenticate')
b = body(r)
check('configured (browser): POST /authenticate -> 501 SIGN_IN_UNAVAILABLE naming the desktop app, no flow built', r.status_code == 501 and b.get('code') == 'SIGN_IN_UNAVAILABLE' and 'desktop app' in b.get('message', ''), (r.status_code, b))
r = client.get('/api/calendar/calendars')
check('configured (browser): GET /calendars without a token is 401 Not authenticated', r.status_code == 401 and body(r).get('error') == 'Not authenticated', (r.status_code, body(r)))
check('no token file was written', not os.path.exists(token_path))

# ---- the desktop app (auth mode app-token): the flow runs on its own thread ----
google_calendar.auth_mode = lambda: 'app-token'
google_calendar.InstalledAppFlow = FakeFlow
r = client.get('/api/calendar/auth-status')
check('desktop: signInAvailable True', body(r).get('signInAvailable') is True, body(r))
r = client.post('/api/calendar/authenticate')
b = body(r)
check('desktop: POST /authenticate answers 202 started at once (the browser is opening)', r.status_code == 202 and b.get('started') is True and b.get('success') is True and 'browser' in b.get('message', ''), (r.status_code, b))
check('desktop: the flow was built from the configured client (installed type, localhost redirect)', len(FakeFlow.calls) == 1 and FakeFlow.calls[0][0]['installed']['client_id'] == os.environ['GOOGLE_CALENDAR_CLIENT_ID'] and FakeFlow.calls[0][0]['installed']['redirect_uris'] == ['http://localhost'], FakeFlow.calls)
r = client.get('/api/calendar/auth-status')
b = body(r)
check('desktop: auth-status reports signInPending while the browser is open', b.get('signInPending') is True and b.get('authenticated') is False and b.get('signInError') is None, b)
r = client.post('/api/calendar/authenticate')
check('desktop: a second POST while pending -> 409 SIGN_IN_PENDING', r.status_code == 409 and body(r).get('code') == 'SIGN_IN_PENDING', (r.status_code, body(r)))
FakeFlow.release.set()
google_calendar._sign_in['thread'].join(5)
r = client.get('/api/calendar/auth-status')
b = body(r)
check('desktop: once the redirect arrived, auth-status is authenticated, not pending, no error', b.get('authenticated') is True and b.get('signInPending') is False and b.get('signInError') is None, b)
check('desktop: the token file exists with mode 0600', os.path.exists(token_path) and stat.S_IMODE(os.stat(token_path).st_mode) == 0o600, oct(os.stat(token_path).st_mode) if os.path.exists(token_path) else 'missing')

# ---- a failed sign-in is reported, not raised ----
os.remove(token_path)
google_calendar._reset_sign_in_for_tests()
FakeFlow.release = threading.Event()
FakeFlow.fail_with = 'access_denied: the user declined'
r = client.post('/api/calendar/authenticate')
check('desktop (failure): the attempt starts (202)', r.status_code == 202, (r.status_code, body(r)))
FakeFlow.release.set()
google_calendar._sign_in['thread'].join(5)
r = client.get('/api/calendar/auth-status')
b = body(r)
check('desktop (failure): auth-status carries the failure message and stays not authenticated', b.get('authenticated') is False and b.get('signInPending') is False and 'access_denied' in (b.get('signInError') or ''), b)
check('desktop (failure): no token file', not os.path.exists(token_path))
FakeFlow.release = threading.Event()
FakeFlow.fail_with = None
r = client.post('/api/calendar/authenticate')
check('desktop (failure): a new attempt may start again (202) and clears the old error', r.status_code == 202 and body(client.get('/api/calendar/auth-status')).get('signInError') is None, (r.status_code, body(r)))
FakeFlow.release.set()
google_calendar._sign_in['thread'].join(5)
check('desktop: ...and completes', body(client.get('/api/calendar/auth-status')).get('authenticated') is True)

failed = [n for n, ok, _ in results if not ok]
print()
print(f"{len(results) - len(failed)}/{len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ''))
sys.exit(1 if failed else 0)
