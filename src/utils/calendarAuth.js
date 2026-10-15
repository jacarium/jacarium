/**
 * Google Calendar is optional (like Jira, src/services/jiraApi.js): nothing
 * calendar-related goes out unless the backend says the calendar is
 * connected. One cached GET /api/calendar/auth-status answers:
 *
 *   configured       the Google OAuth client ID + secret are set
 *   authenticated    a token exists (~/.jacarium-gcal-token.pickle)
 *   signInAvailable  this backend can run the Google sign-in (the desktop
 *                    app; the browser deployment on the home server cannot)
 *   signInPending    a sign-in is waiting for the browser
 *   signInError      why the last sign-in failed
 *
 * calendarConnectionState() folds that into one word the page renders:
 *   'unknown' | 'unconfigured' | 'connected' | 'unavailable' | 'disconnected'
 *
 * ensureCalendarConnected() is the gate every fetcher calls first: it
 * rejects with a CalendarNotConnectedError (code + the user-facing message)
 * without a network call, so background syncs stop quietly and a manual
 * action can show the reason. The cache is dropped after a settings save
 * ('settingsSaved'), after a sign-in, and when a calendar call answers 401.
 */
import { getBackendUrl, apiFetch } from './backendUrl';

export const CALENDAR_NOT_CONFIGURED_MESSAGE = "Google Calendar isn't set up: add your Google OAuth client ID and secret in Settings > Integrations > Google Calendar.";
export const CALENDAR_NOT_CONNECTED_MESSAGE = 'Google Calendar is not connected yet: sign in with Google from the Calendars page.';
export const CALENDAR_SIGN_IN_UNAVAILABLE_MESSAGE = 'Google sign-in is not available on the home server yet. Connect Google Calendar from the desktop app.';
export const CALENDAR_STATUS_UNKNOWN_MESSAGE = 'Google Calendar status is not known yet (the backend did not answer).';

const CODES = {
  unknown: 'CALENDAR_STATUS_UNKNOWN',
  unconfigured: 'CALENDAR_NOT_CONFIGURED',
  unavailable: 'CALENDAR_SIGN_IN_UNAVAILABLE',
  disconnected: 'CALENDAR_NOT_CONNECTED',
};

/** The message the page shows for a state that is not 'connected'. */
export function calendarStateMessage(state) {
  switch (state) {
    case 'unconfigured': return CALENDAR_NOT_CONFIGURED_MESSAGE;
    case 'unavailable': return CALENDAR_SIGN_IN_UNAVAILABLE_MESSAGE;
    case 'disconnected': return CALENDAR_NOT_CONNECTED_MESSAGE;
    case 'connected': return 'Google Calendar is connected.';
    default: return CALENDAR_STATUS_UNKNOWN_MESSAGE;
  }
}

export class CalendarNotConnectedError extends Error {
  constructor(state, message) {
    super(message || calendarStateMessage(state));
    this.name = 'CalendarNotConnectedError';
    this.state = state;
    this.code = CODES[state] || CODES.unknown;
  }
}

export function isCalendarNotConnectedError(error) {
  return !!error && (error instanceof CalendarNotConnectedError || Object.values(CODES).includes(error.code));
}

let statusCache = null; // Promise<status> | null

async function readStatus() {
  try {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/calendar/auth-status`);
    if (!response.ok) return { reachable: false, configured: false, authenticated: false, signInAvailable: false, signInPending: false, signInError: null };
    const data = await response.json();
    return {
      reachable: true,
      configured: !!data.configured,
      authenticated: !!data.authenticated,
      // an older backend does not report it: it is the desktop app's
      signInAvailable: data.signInAvailable !== false,
      signInPending: !!data.signInPending,
      signInError: data.signInError || null,
      message: data.message || '',
    };
  } catch (error) {
    console.warn('[calendarAuth] Could not read the Google Calendar status:', error?.message || error);
    return { reachable: false, configured: false, authenticated: false, signInAvailable: false, signInPending: false, signInError: null };
  }
}

/** The cached auth status (one request until something changes it). */
export function getCalendarAuthStatus({ refresh = false } = {}) {
  if (refresh || !statusCache) {
    statusCache = readStatus().then((status) => {
      // an unreachable backend is asked again next time
      if (!status.reachable) statusCache = null;
      return status;
    });
  }
  return statusCache;
}

export function invalidateCalendarAuthStatus() {
  statusCache = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('settingsSaved', invalidateCalendarAuthStatus);
}

/** One word for what the page should render, from a status (null = not read yet). */
export function calendarConnectionState(status) {
  if (!status || status.reachable === false) return 'unknown';
  if (!status.configured) return 'unconfigured';
  if (status.authenticated) return 'connected';
  if (!status.signInAvailable) return 'unavailable';
  return 'disconnected';
}

/** The gate: resolves with the status when connected, rejects (no network) otherwise. */
export async function ensureCalendarConnected() {
  const status = await getCalendarAuthStatus();
  const state = calendarConnectionState(status);
  if (state !== 'connected') throw new CalendarNotConnectedError(state);
  return status;
}

/**
 * The backend's own refusal of a calendar call, as the same typed error:
 * 401 (no token) is a state, not a failure. Returns null for any other answer. A 401 drops the cached status so the page
 * re-reads it (the token may have been revoked meanwhile).
 */
export function calendarRefusalError(response) {
  if (!response) return null;
  if (response.status === 401) {
    invalidateCalendarAuthStatus();
    return new CalendarNotConnectedError('disconnected');
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sign in with Google. POST /api/calendar/authenticate starts the flow on
 * the backend (the browser opens on that machine) and answers 202 at once;
 * `onBrowserOpened(message)` is called only then - never before the backend
 * has actually started the flow. The status is then polled until the token
 * is saved (resolves with the status) or the attempt failed (rejects with
 * the backend's message). Any refusal (400 not configured, 501 browser
 * deployment, 409 already pending) rejects with the backend's `message`
 * and `code`.
 */
export async function connectGoogleCalendar({ onBrowserOpened = null, pollMs = 2000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}/api/calendar/authenticate`, { method: 'POST' });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Authentication failed (HTTP ${response.status})`);
    error.code = data.code || 'CALENDAR_SIGN_IN_FAILED';
    error.status = response.status;
    throw error;
  }
  invalidateCalendarAuthStatus();
  if (response.status !== 202 && !data.started) {
    // an older backend ran the whole flow inside the request
    return getCalendarAuthStatus({ refresh: true });
  }
  if (onBrowserOpened) onBrowserOpened(data.message || 'Complete the Google sign-in in your browser.');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(pollMs);
    const status = await getCalendarAuthStatus({ refresh: true });
    if (status.authenticated) return status;
    if (status.signInError) {
      const error = new Error(status.signInError);
      error.code = 'CALENDAR_SIGN_IN_FAILED';
      throw error;
    }
    if (!status.signInPending && status.reachable) {
      const error = new Error('The Google sign-in did not complete.');
      error.code = 'CALENDAR_SIGN_IN_FAILED';
      throw error;
    }
    if (Date.now() > deadline) {
      const error = new Error('The Google sign-in was not completed in time. Try again.');
      error.code = 'CALENDAR_SIGN_IN_TIMEOUT';
      throw error;
    }
  }
}
