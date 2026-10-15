"""
Google Calendar API Integration Blueprint

This module provides a Flask blueprint for integrating with Google Calendar API
using OAuth 2.0 authentication. It handles calendar operations, event management,
and synchronization with the user's Google Calendar.
"""

import os
import pickle
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import pytz
from flask import Blueprint, jsonify, request
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from settings_store import setting
from user_context import auth_mode, expand_user_path

# Create blueprint
google_calendar_bp = Blueprint('google_calendar', __name__, url_prefix='/api/calendar')

# OAuth 2.0 scope for Google Calendar
SCOPES = ['https://www.googleapis.com/auth/calendar']

# Token storage path (per account with sign-in: ``~`` is the account's home)
TOKEN_FILE = os.path.expanduser('~/.jacarium-gcal-token.pickle')


def token_file():
    return expand_user_path('~/.jacarium-gcal-token.pickle')


def _tighten_token_permissions(path=None):
    """Ensure the token file is owner-read/write only (0600).

    The pickle holds a live OAuth refresh token for the user's Google
    account. It used to be written with the process umask (typically 0644,
    world-readable). Called before every read and after every write so a
    file created by an older version is tightened too. No-op on Windows,
    where the mode bits do not carry the same meaning.
    """
    path = path or token_file()
    if os.name == 'nt' or not os.path.exists(path):
        return
    try:
        if os.stat(path).st_mode & 0o777 != 0o600:
            os.chmod(path, 0o600)
    except OSError as e:
        print(f"Warning: could not tighten permissions on {path}: {e}")


def _save_token(creds, path=None):
    """Write the credentials pickle with mode 0600 from the moment it exists.

    os.open with an explicit mode (masked only by the umask, never widened)
    plus O_TRUNC so a pre-existing looser file is replaced in place; the
    chmod afterwards covers that pre-existing-file case.
    """
    path = path or token_file()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as token:
        pickle.dump(creds, token)
    _tighten_token_permissions(path)


def get_credentials():
    """
    Retrieve or create Google Calendar API credentials.

    Returns:
        Credentials: Valid Google OAuth credentials
        None: If credentials are not configured or invalid
    """
    client_id = setting('GOOGLE_CALENDAR_CLIENT_ID')
    client_secret = setting('GOOGLE_CALENDAR_CLIENT_SECRET')

    if not client_id or not client_secret:
        return None

    creds = None

    # Load existing token if available (tightening a legacy 0644 file first)
    if os.path.exists(token_file()):
        _tighten_token_permissions()
        try:
            with open(token_file(), 'rb') as token:
                creds = pickle.load(token)
        except Exception as e:
            print(f"Error loading token: {e}")
            creds = None

    # Refresh or validate credentials
    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            # Save refreshed credentials (0600)
            _save_token(creds)
            return creds
        except Exception as e:
            print(f"Error refreshing token: {e}")
            return None

    return None


def get_calendar_service():
    """
    Get authenticated Google Calendar service instance.

    Returns:
        Resource: Google Calendar API service instance
        None: If not authenticated
    """
    creds = get_credentials()
    if not creds:
        return None

    try:
        service = build('calendar', 'v3', credentials=creds)
        return service
    except Exception as e:
        print(f"Error building service: {e}")
        return None


# ============================================================================
# AUTHENTICATION ENDPOINTS
# ============================================================================

NOT_CONFIGURED_MESSAGE = (
    "Google Calendar isn't set up: add your Google OAuth client ID and "
    "secret in Settings > Integrations > Google Calendar."
)
BROWSER_SIGN_IN_MESSAGE = (
    'Google sign-in is not available on the home server yet: it opens a '
    'browser on the machine that runs the backend. Connect Google Calendar '
    'from the desktop app.'
)
SIGN_IN_TIMEOUT_SECONDS = 300


def sign_in_available():
    """
    Whether this backend can run the Google sign-in. The InstalledAppFlow
    opens a browser on the machine the backend runs on and waits for the
    redirect on a loopback port there - fine for the desktop app (auth mode
    app-token: the backend runs next to the window), impossible for the
    browser deployment (accounts / none: the backend runs in a container on
    the home server and the user sits somewhere else). A web OAuth flow
    (redirect URI on the console origin) would be the way to add it there.
    """
    return auth_mode() == 'app-token'


# The one sign-in that may be in flight (the desktop app has one user).
_sign_in = {'thread': None, 'started_at': None, 'error': None}
_sign_in_lock = threading.Lock()


def _sign_in_pending():
    thread = _sign_in['thread']
    return bool(thread and thread.is_alive())


def _sign_in_snapshot():
    """{signInPending, signInError} for auth-status (the error is reported
    until a new attempt starts)."""
    with _sign_in_lock:
        return {
            'signInPending': _sign_in_pending(),
            'signInError': None if _sign_in_pending() else _sign_in['error'],
        }


def _run_sign_in(flow, path):
    """The blocking part of the flow, off the request thread."""
    try:
        creds = flow.run_local_server(port=0, timeout_seconds=SIGN_IN_TIMEOUT_SECONDS)
        if creds is None:
            raise RuntimeError('the sign-in was not completed in time')
        # Save credentials (0600 - this pickle holds a live refresh token)
        _save_token(creds, path)
        with _sign_in_lock:
            _sign_in['error'] = None
    except Exception as e:  # noqa: BLE001 - reported to the app, never raised
        message = f'Authentication failed: {e}'
        print(f'[Google Calendar] {message}')
        with _sign_in_lock:
            _sign_in['error'] = message


def _reset_sign_in_for_tests():
    with _sign_in_lock:
        _sign_in.update({'thread': None, 'started_at': None, 'error': None})


@google_calendar_bp.route('/auth-status', methods=['GET'])
def auth_status():
    """
    Check Google Calendar authentication status.

    Returns:
        JSON: {
            configured: bool - OAuth credentials configured,
            authenticated: bool - User authenticated,
            signInAvailable: bool - this backend can run the Google sign-in
                                    (false for the browser deployment),
            signInPending: bool - a sign-in started by POST /authenticate
                                  is waiting for the browser,
            signInError: str|null - why the last sign-in failed,
            message: str - Status message
        }
    """
    client_id = setting('GOOGLE_CALENDAR_CLIENT_ID')
    client_secret = setting('GOOGLE_CALENDAR_CLIENT_SECRET')
    common = {
        'signInAvailable': sign_in_available(),
        **_sign_in_snapshot(),
    }

    if not client_id or not client_secret:
        return jsonify({
            'configured': False,
            'authenticated': False,
            'message': NOT_CONFIGURED_MESSAGE,
            **common,
        })

    creds = get_credentials()

    if not creds:
        return jsonify({
            'configured': True,
            'authenticated': False,
            'message': 'Not authenticated. Please sign in with Google.',
            **common,
        })

    return jsonify({
        'configured': True,
        'authenticated': True,
        'message': 'Authenticated',
        **common,
    })


@google_calendar_bp.route('/authenticate', methods=['POST'])
def authenticate():
    """
    Start the OAuth flow to authenticate with Google Calendar.

    Opens the browser on this machine for the user's consent and saves the
    credentials once the redirect arrives. The flow runs on its own thread:
    the answer is 202 as soon as the browser has been asked to open, and
    GET /auth-status reports signInPending until the token is saved (then
    authenticated) or the attempt failed (signInError).

    Returns:
        JSON: {success: bool, started: bool, message: str, code?: str}
        400 NOT_CONFIGURED, 501 SIGN_IN_UNAVAILABLE (browser deployment),
        409 SIGN_IN_PENDING, 500 when the flow could not be started.
    """
    client_id = setting('GOOGLE_CALENDAR_CLIENT_ID')
    client_secret = setting('GOOGLE_CALENDAR_CLIENT_SECRET')

    if not client_id or not client_secret:
        return jsonify({
            'success': False,
            'code': 'NOT_CONFIGURED',
            'message': NOT_CONFIGURED_MESSAGE,
        }), 400

    if not sign_in_available():
        return jsonify({
            'success': False,
            'code': 'SIGN_IN_UNAVAILABLE',
            'message': BROWSER_SIGN_IN_MESSAGE,
        }), 501

    with _sign_in_lock:
        if _sign_in_pending():
            return jsonify({
                'success': False,
                'code': 'SIGN_IN_PENDING',
                'message': 'A Google sign-in is already in progress: finish it in your browser.',
            }), 409

        try:
            # Create client config from the settings
            client_config = {
                'installed': {
                    'client_id': client_id,
                    'client_secret': client_secret,
                    'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                    'token_uri': 'https://oauth2.googleapis.com/token',
                    'auth_provider_x509_cert_url': 'https://www.googleapis.com/oauth2/v1/certs',
                    'redirect_uris': ['http://localhost']
                }
            }

            flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
            # the token path is resolved here, inside the request
            path = token_file()
            thread = threading.Thread(target=_run_sign_in, args=(flow, path), name='gcal-sign-in', daemon=True)
            _sign_in.update({'thread': thread, 'started_at': datetime.now(timezone.utc), 'error': None})
            thread.start()
        except Exception as e:
            _sign_in.update({'thread': None, 'error': None})
            return jsonify({
                'success': False,
                'code': 'SIGN_IN_FAILED',
                'message': f'Authentication failed: {str(e)}'
            }), 500

    return jsonify({
        'success': True,
        'started': True,
        'message': 'Complete the Google sign-in in the browser window that just opened.'
    }), 202


@google_calendar_bp.route('/revoke', methods=['POST'])
def revoke():
    """
    Revoke Google Calendar authentication.

    Deletes stored credentials.

    Returns:
        JSON: {success: bool, message: str}
    """
    try:
        if os.path.exists(token_file()):
            os.remove(token_file())

        return jsonify({
            'success': True,
            'message': 'Authentication revoked'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'Error revoking authentication: {str(e)}'
        }), 500


# ============================================================================
# CALENDAR ENDPOINTS
# ============================================================================

@google_calendar_bp.route('/calendars', methods=['GET'])
def get_calendars():
    """
    List all calendars from user's Google account.

    Returns:
        JSON: {
            calendars: [{
                id: str,
                name: str,
                description: str,
                backgroundColor: str,
                foregroundColor: str,
                accessRole: str,
                primary: bool
            }]
        }
    """
    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        calendar_list = service.calendarList().list().execute()

        calendars = []
        for calendar in calendar_list.get('items', []):
            calendars.append({
                'id': calendar['id'],
                'summary': calendar.get('summary', 'Unnamed Calendar'),
                'description': calendar.get('description', ''),
                'backgroundColor': calendar.get('backgroundColor', '#9E69AF'),
                'foregroundColor': calendar.get('foregroundColor', '#FFFFFF'),
                'accessRole': calendar.get('accessRole', 'reader'),
                'primary': calendar.get('primary', False)
            })

        return jsonify({'calendars': calendars})

    except HttpError as e:
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error fetching calendars: {str(e)}'
        }), 500


@google_calendar_bp.route('/calendars/<calendar_id>', methods=['DELETE'])
def remove_calendar(calendar_id):
    """
    Remove a calendar from user's calendar list.

    This removes the calendar from the user's view (unsubscribe) but does NOT
    delete the actual calendar. Use this to stop viewing shared calendars.

    Args:
        calendar_id: Google calendar ID

    Returns:
        JSON: {success: true} or {error: str}
    """
    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Remove calendar from user's calendar list (this does NOT delete the calendar itself)
        service.calendarList().delete(calendarId=calendar_id).execute()

        return jsonify({
            'success': True,
            'message': 'Calendar removed from your list'
        })

    except HttpError as e:
        error_message = str(e)
        if e.resp.status == 404:
            return jsonify({
                'error': 'Calendar not found in your list'
            }), 404
        return jsonify({
            'error': f'Google API error: {error_message}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error removing calendar: {str(e)}'
        }), 500


@google_calendar_bp.route('/calendars', methods=['POST'])
def add_calendar():
    """
    Subscribe to a calendar (add to user's calendar list).

    This adds an existing calendar to the user's calendar list, allowing them
    to view it. Use this to subscribe to shared calendars.

    Request body:
        {
            "calendarId": str  # Calendar ID (usually an email address)
        }

    Returns:
        JSON: {success: true, calendar: {...}} or {error: str}
    """
    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        data = request.get_json()
        calendar_id = data.get('calendarId')

        if not calendar_id:
            return jsonify({
                'error': 'Calendar ID is required'
            }), 400

        # Subscribe to the calendar by adding it to the calendar list
        body = {
            'id': calendar_id
        }

        result = service.calendarList().insert(body=body).execute()

        # Return the added calendar info
        calendar_info = {
            'id': result['id'],
            'summary': result.get('summary', 'Unnamed Calendar'),
            'description': result.get('description', ''),
            'backgroundColor': result.get('backgroundColor', '#9E69AF'),
            'foregroundColor': result.get('foregroundColor', '#FFFFFF'),
            'accessRole': result.get('accessRole', 'reader'),
            'primary': result.get('primary', False)
        }

        return jsonify({
            'success': True,
            'calendar': calendar_info
        })

    except HttpError as e:
        error_message = str(e)
        if e.resp.status == 404:
            return jsonify({
                'error': 'Calendar not found. Make sure the calendar ID is correct and you have permission to access it.'
            }), 404
        if e.resp.status == 409:
            return jsonify({
                'error': 'You are already subscribed to this calendar.'
            }), 409
        return jsonify({
            'error': f'Google API error: {error_message}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error subscribing to calendar: {str(e)}'
        }), 500


# ============================================================================
# TIMEZONE ENDPOINTS
# ============================================================================

@google_calendar_bp.route('/timezones', methods=['GET'])
def get_timezones():
    """
    List common timezones.

    Returns:
        JSON: {
            timezones: [{
                id: str (IANA timezone ID),
                name: str (display name)
            }]
        }
    """
    try:
        # Get common timezones from pytz
        common_timezones = list(pytz.common_timezones)

        timezones = []
        for tz_id in sorted(common_timezones):
            # Format display name
            display_name = tz_id.replace('_', ' ')
            timezones.append({
                'id': tz_id,
                'name': display_name
            })

        return jsonify({'timezones': timezones})

    except Exception as e:
        return jsonify({
            'error': f'Error fetching timezones: {str(e)}'
        }), 500


# ============================================================================
# SYNC ENDPOINTS
# ============================================================================

@google_calendar_bp.route('/sync', methods=['POST'])
def sync_calendar():
    """
    Manually sync events for a specific calendar.

    Query params:
        calendarId: str - Google Calendar ID
        timeMin: str - ISO timestamp for start of range (optional)
        timeMax: str - ISO timestamp for end of range (optional)

    Returns:
        JSON: {
            success: bool,
            eventCount: int,
            message: str
        }
    """
    calendar_id = request.args.get('calendarId')
    time_min = request.args.get('timeMin')
    time_max = request.args.get('timeMax')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Build API request parameters
        list_params = {
            'calendarId': calendar_id,
            'maxResults': 2500,
            'singleEvents': True,
            'orderBy': 'startTime'
        }

        # Add time range if specified
        if time_min:
            list_params['timeMin'] = time_min
        if time_max:
            list_params['timeMax'] = time_max

        # Fetch events from Google Calendar
        events_result = service.events().list(**list_params).execute()

        events = events_result.get('items', [])

        return jsonify({
            'success': True,
            'eventCount': len(events),
            'events': events,
            'message': f'Synced {len(events)} events'
        })

    except HttpError as e:
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error syncing calendar: {str(e)}'
        }), 500


@google_calendar_bp.route('/sync-all', methods=['POST'])
def sync_all_calendars():
    """
    Sync all calendars from user's Google account.

    Returns:
        JSON: {
            success: bool,
            calendars: [{
                id: str,
                eventCount: int
            }],
            message: str
        }
    """
    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Get all calendars
        calendar_list = service.calendarList().list().execute()

        synced_calendars = []

        for calendar in calendar_list.get('items', []):
            calendar_id = calendar['id']

            try:
                # Fetch events for this calendar
                events_result = service.events().list(
                    calendarId=calendar_id,
                    maxResults=2500,
                    singleEvents=True,
                    orderBy='startTime'
                ).execute()

                events = events_result.get('items', [])

                synced_calendars.append({
                    'id': calendar_id,
                    'name': calendar.get('summary', 'Unnamed'),
                    'eventCount': len(events)
                })

            except HttpError:
                # Skip calendars we can't access
                continue

        return jsonify({
            'success': True,
            'calendars': synced_calendars,
            'message': f'Synced {len(synced_calendars)} calendars'
        })

    except HttpError as e:
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error syncing calendars: {str(e)}'
        }), 500


@google_calendar_bp.route('/sync-status', methods=['GET'])
def sync_status():
    """
    Get sync status for a calendar.

    Query params:
        calendarId: str - Google Calendar ID

    Returns:
        JSON: {
            status: str ('synced', 'syncing', 'error'),
            lastSynced: timestamp
        }
    """
    calendar_id = request.args.get('calendarId')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    # This is a placeholder - actual sync status would be tracked
    # in frontend IndexedDB or a backend database
    return jsonify({
        'status': 'synced',
        'lastSynced': datetime.now(timezone.utc).isoformat()
    })


# ============================================================================
# EVENT CRUD ENDPOINTS
# ============================================================================

@google_calendar_bp.route('/events', methods=['GET'])
def get_events():
    """
    List events for a calendar within a time range.

    Query params:
        calendarId: str - Google Calendar ID
        timeMin: str - ISO 8601 timestamp (optional)
        timeMax: str - ISO 8601 timestamp (optional)

    Returns:
        JSON: {events: [...]}
    """
    calendar_id = request.args.get('calendarId')
    time_min = request.args.get('timeMin')
    time_max = request.args.get('timeMax')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        params = {
            'calendarId': calendar_id,
            'maxResults': 2500,
            'singleEvents': True,
            'orderBy': 'startTime'
        }

        if time_min:
            params['timeMin'] = time_min
        if time_max:
            params['timeMax'] = time_max

        events_result = service.events().list(**params).execute()
        events = events_result.get('items', [])

        return jsonify({'events': events})

    except HttpError as e:
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error fetching events: {str(e)}'
        }), 500


@google_calendar_bp.route('/events/<event_id>', methods=['GET'])
def get_event(event_id):
    """
    Get a single event by ID.

    Query params:
        calendarId: str - Google Calendar ID

    Returns:
        JSON: {event: {...}}
    """
    calendar_id = request.args.get('calendarId')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        event = service.events().get(
            calendarId=calendar_id,
            eventId=event_id
        ).execute()

        return jsonify({'event': event})

    except HttpError as e:
        if e.resp.status == 404:
            return jsonify({
                'error': 'Event not found'
            }), 404
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error fetching event: {str(e)}'
        }), 500


@google_calendar_bp.route('/events', methods=['POST'])
def create_event():
    """
    Create a new calendar event.

    Request body:
        {
            calendarId: str,
            summary: str,
            description: str (optional),
            location: str (optional),
            startTime: str (ISO 8601),
            endTime: str (ISO 8601),
            timezone: str (IANA timezone),
            guests: [str] (email addresses, optional),
            recurring: bool (optional),
            frequency: str ('daily'|'weekly'|'monthly', optional),
            recurrenceEndDate: str (ISO 8601, optional),
            reminders: [{method: str, minutes: int}] (optional)
        }

    Returns:
        JSON: {
            success: bool,
            eventId: str,
            eventLink: str,
            message: str
        }
    """
    data = request.json

    calendar_id = data.get('calendarId')
    summary = data.get('summary')
    start_time = data.get('startTime')
    end_time = data.get('endTime')
    timezone_id = data.get('timezone', 'UTC')

    if not all([calendar_id, summary, start_time, end_time]):
        return jsonify({
            'error': 'Missing required fields: calendarId, summary, startTime, endTime'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Build event object
        event = {
            'summary': summary,
            'start': {
                'dateTime': start_time,
                'timeZone': timezone_id
            },
            'end': {
                'dateTime': end_time,
                'timeZone': timezone_id
            }
        }

        # Add optional fields
        if data.get('description'):
            event['description'] = data['description']

        if data.get('location'):
            event['location'] = data['location']

        # Add guests/attendees
        guests = data.get('guests', [])
        if guests:
            event['attendees'] = [{'email': email.strip()} for email in guests if email.strip()]

        # Add recurrence rule
        if data.get('recurring'):
            frequency = data.get('frequency', 'weekly').upper()
            recurrence_end = data.get('recurrenceEndDate')

            if recurrence_end:
                # Convert to RRULE format
                rrule = f'RRULE:FREQ={frequency};UNTIL={recurrence_end.replace("-", "").replace(":", "")}00Z'
                event['recurrence'] = [rrule]

        # Add reminders
        reminders = data.get('reminders', [])
        if reminders:
            event['reminders'] = {
                'useDefault': False,
                'overrides': reminders
            }

        # Create event
        created_event = service.events().insert(
            calendarId=calendar_id,
            body=event
        ).execute()

        return jsonify({
            'success': True,
            'eventId': created_event['id'],
            'eventLink': created_event.get('htmlLink', ''),
            'message': 'Event created successfully'
        })

    except HttpError as e:
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error creating event: {str(e)}'
        }), 500


@google_calendar_bp.route('/events/<event_id>', methods=['PATCH'])
def update_event(event_id):
    """
    Update an existing event.

    Query params:
        calendarId: str - Google Calendar ID

    Request body: Same as create_event

    Returns:
        JSON: {success: bool, message: str}
    """
    calendar_id = request.args.get('calendarId')
    data = request.json

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Get existing event
        event = service.events().get(
            calendarId=calendar_id,
            eventId=event_id
        ).execute()

        # Update fields
        if 'summary' in data:
            event['summary'] = data['summary']

        if 'description' in data:
            event['description'] = data['description']

        if 'location' in data:
            event['location'] = data['location']

        if 'startTime' in data and 'endTime' in data:
            timezone_id = data.get('timezone', 'UTC')
            event['start'] = {
                'dateTime': data['startTime'],
                'timeZone': timezone_id
            }
            event['end'] = {
                'dateTime': data['endTime'],
                'timeZone': timezone_id
            }

        if 'guests' in data:
            guests = data['guests']
            event['attendees'] = [{'email': email.strip()} for email in guests if email.strip()]

        if 'reminders' in data:
            event['reminders'] = {
                'useDefault': False,
                'overrides': data['reminders']
            }

        # Update event
        updated_event = service.events().update(
            calendarId=calendar_id,
            eventId=event_id,
            body=event
        ).execute()

        return jsonify({
            'success': True,
            'message': 'Event updated successfully'
        })

    except HttpError as e:
        if e.resp.status == 404:
            return jsonify({
                'error': 'Event not found'
            }), 404
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error updating event: {str(e)}'
        }), 500


@google_calendar_bp.route('/events/<event_id>', methods=['DELETE'])
def delete_event(event_id):
    """
    Delete an event.

    Query params:
        calendarId: str - Google Calendar ID

    Returns:
        JSON: {success: bool, message: str}
    """
    calendar_id = request.args.get('calendarId')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        service.events().delete(
            calendarId=calendar_id,
            eventId=event_id
        ).execute()

        return jsonify({
            'success': True,
            'message': 'Event deleted successfully'
        })

    except HttpError as e:
        if e.resp.status == 404:
            return jsonify({
                'error': 'Event not found'
            }), 404
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error deleting event: {str(e)}'
        }), 500


# ============================================================================
# RECURRING EVENT INSTANCE ENDPOINTS
# ============================================================================

@google_calendar_bp.route('/events/<event_id>/instances/<instance_id>', methods=['PATCH'])
def update_event_instance(event_id, instance_id):
    """
    Update a single instance of a recurring event.

    Query params:
        calendarId: str - Google Calendar ID

    Request body: Same as update_event

    Returns:
        JSON: {success: bool, message: str}
    """
    calendar_id = request.args.get('calendarId')
    data = request.json

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        # Get the specific instance
        instance = service.events().get(
            calendarId=calendar_id,
            eventId=instance_id
        ).execute()

        # Update fields
        if 'summary' in data:
            instance['summary'] = data['summary']

        if 'startTime' in data and 'endTime' in data:
            timezone_id = data.get('timezone', 'UTC')
            instance['start'] = {
                'dateTime': data['startTime'],
                'timeZone': timezone_id
            }
            instance['end'] = {
                'dateTime': data['endTime'],
                'timeZone': timezone_id
            }

        # Update instance
        updated_instance = service.events().update(
            calendarId=calendar_id,
            eventId=instance_id,
            body=instance
        ).execute()

        return jsonify({
            'success': True,
            'message': 'Event instance updated successfully'
        })

    except HttpError as e:
        if e.resp.status == 404:
            return jsonify({
                'error': 'Event instance not found'
            }), 404
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error updating event instance: {str(e)}'
        }), 500


@google_calendar_bp.route('/events/<event_id>/instances/<instance_id>', methods=['DELETE'])
def delete_event_instance(event_id, instance_id):
    """
    Delete a single instance of a recurring event.

    Query params:
        calendarId: str - Google Calendar ID

    Returns:
        JSON: {success: bool, message: str}
    """
    calendar_id = request.args.get('calendarId')

    if not calendar_id:
        return jsonify({
            'error': 'calendarId parameter required'
        }), 400

    service = get_calendar_service()

    if not service:
        return jsonify({
            'error': 'Not authenticated'
        }), 401

    try:
        service.events().delete(
            calendarId=calendar_id,
            eventId=instance_id
        ).execute()

        return jsonify({
            'success': True,
            'message': 'Event instance deleted successfully'
        })

    except HttpError as e:
        if e.resp.status == 404:
            return jsonify({
                'error': 'Event instance not found'
            }), 404
        return jsonify({
            'error': f'Google API error: {str(e)}'
        }), 500
    except Exception as e:
        return jsonify({
            'error': f'Error deleting event instance: {str(e)}'
        }), 500
