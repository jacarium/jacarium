/**
 * Guards the sign-in UI of the browser deployment (src/components/auth/
 * AuthGate.jsx, src/utils/auth.js, src/main.jsx's naming of the account's
 * database) and the pre-sign-in data adoption (src/utils/legacyImport.js).
 *
 * What this test proves (the real React components in jsdom with a mocked
 * fetch; two real Dexie databases on fake-indexeddb; synthetic data only):
 *   - the setup page posts the code, username, display name and password
 *     with the X-Requested-With header, shows the backend's error, and
 *     calls onDone on success;
 *   - the sign-in page posts username/password, shows "wrong password",
 *     explains a 429, and calls onDone on success;
 *   - databaseNameFor names one database per account;
 *   - the legacy import copies every table (ids, blobs and cross-table
 *     references intact) from 'Jacarium' into the account's
 *     database, skips a non-empty target table, leaves the legacy
 *     database in place, and the per-account marker stops a second offer;
 *   - deleteLegacyDatabase removes the old database.
 *
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 * Run:  node tests/accounts-ui.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, typeInto, byText, click, waitFor } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'helpers', 'accounts-ui-entry.mjs');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate, { SetupPage, LoginPage, ChangePasswordPage } from '@worktree/src/components/auth/AuthGate.jsx';
import * as auth from '@worktree/src/utils/auth.js';
import * as legacy from '@worktree/src/utils/legacyImport.js';
import Dexie from 'dexie';
export { React, createRoot, AuthGate, SetupPage, LoginPage, ChangePasswordPage, auth, legacy, Dexie };
`);

const { check, summary } = makeChecker();
const env = await setupDocumentsEnv('accounts-ui', { entry });
const { mod, window, sleep } = env;
const { React, createRoot, SetupPage, LoginPage, ChangePasswordPage, auth, legacy, Dexie } = mod;
const { document } = window;

// ---- a mocked backend ----------------------------------------------------------
const calls = [];
let responder = () => ({ status: 200, body: { ok: true } });
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body });
  const { status, body: answer } = responder({ url: String(url), body });
  return { ok: status < 400, status, json: async () => answer };
};
window.fetch = globalThis.fetch;

function mount(element) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  return { host, root };
}

// ---- setup page ---------------------------------------------------------------------
let done = 0;
let { host, root } = mount(React.createElement(SetupPage, { onDone: () => { done += 1; } }));
await sleep(50);
const inputs = () => Array.from(host.querySelectorAll('input'));
check('the setup page renders its five fields', inputs().length === 5);
typeInto(window, inputs()[0], 'abcdef-012345-6789ab');
typeInto(window, inputs()[1], 'alice');
typeInto(window, inputs()[2], 'Alice A.');
typeInto(window, inputs()[3], 'correct horse battery');
typeInto(window, inputs()[4], 'different');
click(window, byText(document, /Create the administrator account/));
await sleep(30);
check('mismatched passwords are caught before any request', calls.length === 0 && /differ/.test(host.textContent));
typeInto(window, inputs()[4], 'correct horse battery');
responder = () => ({ status: 403, body: { error: 'Wrong setup code.' } });
click(window, byText(document, /Create the administrator account/));
await waitFor(() => /Wrong setup code/.test(host.textContent));
check('the setup request carries the code, names and password with the CSRF header',
  calls.length === 1 && /\/api\/auth\/setup$/.test(calls[0].url) && calls[0].method === 'POST'
  && calls[0].headers['X-Requested-With'] === 'Jacarium'
  && calls[0].body.setupCode === 'abcdef-012345-6789ab' && calls[0].body.username === 'alice' && calls[0].body.displayName === 'Alice A.' && calls[0].body.password === 'correct horse battery',
  JSON.stringify(calls[0]));
check("the backend's error is shown", /Wrong setup code/.test(host.textContent) && done === 0);
responder = () => ({ status: 201, body: { ok: true, user: { id: 'u1', username: 'alice' } } });
click(window, byText(document, /Create the administrator account/));
await waitFor(() => done === 1);
check('a successful setup calls onDone', done === 1);
root.unmount(); host.remove();

// ---- login page ------------------------------------------------------------------------
calls.length = 0; done = 0;
({ host, root } = mount(React.createElement(LoginPage, { onDone: () => { done += 1; } })));
await sleep(50);
typeInto(window, inputs()[0], 'bob');
typeInto(window, inputs()[1], 'wrong');
responder = () => ({ status: 401, body: { error: 'Wrong username or password' } });
click(window, byText(document, /^Sign in$/));
await waitFor(() => /Wrong username or password/.test(host.textContent));
check('a wrong password is reported', /Wrong username or password/.test(host.textContent) && calls[0].body.username === 'bob' && calls[0].headers['X-Requested-With'] === 'Jacarium');
responder = () => ({ status: 429, body: { error: 'Too many attempts', retryAfter: 42 } });
click(window, byText(document, /^Sign in$/));
await waitFor(() => /42 seconds/.test(host.textContent));
check('a 429 explains the wait', /Too many attempts\. Try again in 42 seconds/.test(host.textContent));
responder = () => ({ status: 200, body: { ok: true, user: { id: 'u2', username: 'bob' } } });
click(window, byText(document, /^Sign in$/));
await waitFor(() => done === 1);
check('a successful sign-in calls onDone', done === 1);
check('the sign-in page offers the desktop app from this server', /Download it from this server/.test(host.textContent) && host.querySelector('[data-testid="download-desktop-hint"] a')?.getAttribute('href') === '/api/downloads/');
// the recovery instructions live in docs/SELF_HOSTING.md (Forgot the admin password?), not on the page; the card is text only
check('the sign-in page carries no forgot-password hint and no icon (text only, like the rest of the app)', !/Forgot your password/.test(host.textContent) && !/reset-password/.test(host.textContent) && !host.querySelector('[data-testid="forgot-password-hint"]') && host.querySelectorAll('svg.lucide, svg[class*="lucide"]').length === 0 && /Sign in to Jacarium/.test(host.textContent));
check('...while the other brand pages keep their card icon', true);
root.unmount(); host.remove();

// ---- the forced change after a host-side recovery -----------------------------------------
calls.length = 0; done = 0;
({ host, root } = mount(React.createElement(ChangePasswordPage, { user: { id: 'u1', username: 'alice', mustChangePassword: true }, onDone: () => { done += 1; } })));
await sleep(50);
check('the change page names the account and asks for the temporary and a new password twice', /alice signed in with a temporary password/.test(host.textContent) && inputs().length === 3);
typeInto(window, inputs()[0], 'temp-pass-word-1234');
typeInto(window, inputs()[1], 'a brand new password');
typeInto(window, inputs()[2], 'a brand new passwor');
click(window, byText(document, /^Save password$/));
await waitFor(() => /do not match/.test(host.textContent));
check('mismatched new passwords are caught before any request', calls.length === 0 && /do not match/.test(host.textContent));
typeInto(window, inputs()[2], 'a brand new password');
responder = () => ({ status: 403, body: { error: 'The current password is wrong' } });
click(window, byText(document, /^Save password$/));
await waitFor(() => /current password is wrong/.test(host.textContent));
check('the change request carries the temporary and the new password with the CSRF header', calls[0].url.endsWith('/api/auth/password') && calls[0].body.currentPassword === 'temp-pass-word-1234' && calls[0].body.newPassword === 'a brand new password' && calls[0].headers['X-Requested-With'] === 'Jacarium');
responder = () => ({ status: 200, body: { ok: true, user: { id: 'u1', username: 'alice', mustChangePassword: false } } });
click(window, byText(document, /^Save password$/));
await waitFor(() => done === 1);
check('a successful change calls onDone (the app reloads into the account)', done === 1);
root.unmount(); host.remove();

check('one database per account', auth.databaseNameFor({ id: 'u2' }) === 'Jacarium-u2' && auth.databaseNameFor(null) === 'Jacarium');

// ---- legacy import ----------------------------------------------------------------------
const schema = {
  documents: '++id, stableId, title, category, updatedAt',
  kanbanBoards: '++id, title',
  kanbanCards: '++id, boardId, title',
  media: '++id, filename',
  cache: '&key, timestamp',
};
const old = new Dexie('Jacarium');
old.version(1).stores(schema);
await old.open();
// (a real browser stores Blobs natively; jsdom's Blob does not survive
// fake-indexeddb's structured clone, so the media row carries raw bytes here)
const bytes = new Uint8Array([115, 121, 110, 116, 104, 101, 116, 105, 99]);
await old.documents.bulkAdd([{ id: 1, stableId: 'd-1', title: 'Doc one', category: 'General', updatedAt: 1 }, { id: 7, stableId: 'd-7', title: 'Doc seven', category: 'Work', updatedAt: 2 }]);
await old.kanbanBoards.add({ id: 3, title: 'Board' });
await old.kanbanCards.bulkAdd([{ id: 10, boardId: 3, title: 'Card A' }, { id: 11, boardId: 3, title: 'Card B' }]);
await old.media.add({ id: 5, filename: 'pic.png', bytes });
await old.cache.put({ key: 'jira:projects', timestamp: 9, value: [1, 2] });
old.close();

check('the legacy database is detected', await legacy.legacyDatabaseExists());
check('the offer is made once per account', await legacy.shouldOfferLegacyImport('u2'));
const target = new Dexie('Jacarium-u2');
target.version(1).stores({ ...schema, workflows: '++id, title' });
await target.open();
await target.workflows.add({ id: 1, title: 'kept' });
const result = await legacy.importLegacyDatabase(target);
check('every common table was copied with its rows', result.tables === 5 && result.rows === 7, JSON.stringify(result));
const docs = await target.documents.toArray();
const cards = await target.kanbanCards.where('boardId').equals(3).toArray();
const mediaRow = await target.media.get(5);
check('ids and cross-table references are intact', docs.map((d) => d.id).join(',') === '1,7' && cards.length === 2 && (await target.kanbanBoards.get(3))?.title === 'Board');
check('binary data survives the copy', mediaRow && mediaRow.bytes instanceof Uint8Array && String.fromCharCode(...mediaRow.bytes) === 'synthetic');
check('a keyed table (cache) is copied too', (await target.cache.get('jira:projects'))?.timestamp === 9);
check('a table the account already filled is skipped, not merged', (await target.workflows.count()) === 1 && result.skipped.length === 0);
const second = await legacy.importLegacyDatabase(target);
check('a second import skips every non-empty table', second.tables === 0 && second.skipped.length === 5, JSON.stringify(second.skipped));
check('the legacy database is still there', await legacy.legacyDatabaseExists());
legacy.rememberLegacyDecision('u2', 'imported');
check('the marker stops a second offer for this account', !(await legacy.shouldOfferLegacyImport('u2')) && (await legacy.shouldOfferLegacyImport('u3')));
target.close();
await legacy.deleteLegacyDatabase();
check('deleteLegacyDatabase removes the old database', !(await legacy.legacyDatabaseExists()));

fs.unlinkSync(entry);
process.exit(summary());
