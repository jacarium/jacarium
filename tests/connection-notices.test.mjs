#!/usr/bin/env node
/**
 * Guards src/utils/connectionNotices.js, which decides when the central
 * server's connection reports become a "Working Offline" / "Back Online"
 * notification (src/hooks/useConnectionNotices.js, once for the app):
 *   - app start: "not connected yet", then connected - no notification
 *     (it used to show Offline then Online on every start);
 *   - a real drop and return: Offline, then Online - once each, however many
 *     failed reconnect attempts come in between;
 *   - a server that is never reached: silent;
 *   - repeated reports of the same state: silent.
 *
 * Run:  node tests/connection-notices.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionNoticeTracker } from '../src/utils/connectionNotices.js';

const notices = (reports) => {
  const next = createConnectionNoticeTracker();
  return reports.map(next).filter(Boolean);
};

test('app start (not connected yet, then connected) shows nothing', () => {
  assert.deepEqual(notices([false, false, true]), []);
});

test('a drop and a return show Offline then Online, once each', () => {
  assert.deepEqual(notices([false, true, false, false, false, true]), ['offline', 'online']);
});

test('a second drop is reported again', () => {
  assert.deepEqual(notices([false, true, false, true, false, true]), ['offline', 'online', 'offline', 'online']);
});

test('a server never reached stays silent', () => {
  assert.deepEqual(notices([false, false, false]), []);
});

test('already connected on the first report, then repeats: silent', () => {
  assert.deepEqual(notices([true, true, true]), []);
});
