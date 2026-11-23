/**
 * The sign-in page and src/utils/auth.js with and without single sign-on
 * (the real React components in jsdom, a mocked fetch, synthetic data).
 *
 *   - a server that does not configure single sign-on (capabilities
 *     `sso: { enabled: false }`, or no `sso` at all as before 4.5.0): the
 *     page is the one it always was - two fields, one primary "Sign in"
 *     button, the desktop hint; no SSO button, no extra text, no link;
 *   - configured: the SSO button comes first (the configured label, the
 *     primary button; the password button steps back to secondary), it
 *     POSTs /api/auth/sso/begin with the CSRF header and the browser goes
 *     where the server says; a 429 and a 502 are explained;
 *   - passwords for administrators only: the fields are hidden behind
 *     "Administrator sign-in with a password";
 *   - a refusal comes back as ?sso_error=<code>: the page shows OUR text for
 *     the code (an unknown code or free text gets the generic sentence, and
 *     is never shown), and the code leaves the address;
 *   - takeSsoResult / rememberSsoResult / recallSsoResult; signing out
 *     follows ssoLogoutUrl when the server names one, else reloads.
 *
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/sso-ui.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, typeInto, byText, click, waitFor } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'helpers', 'sso-ui-entry.mjs');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPage } from '@worktree/src/components/auth/AuthGate.jsx';
import * as auth from '@worktree/src/utils/auth.js';
import * as platform from '@worktree/src/utils/platform.js';
export { React, createRoot, LoginPage, auth, platform };
`);

const { check, summary } = makeChecker();
const env = await setupDocumentsEnv('sso-ui', { entry });
const { mod, window, sleep } = env;
const { React, createRoot, LoginPage, auth, platform } = mod;
const { document } = window;

const calls = [];
let capabilities = {};
let responder = () => ({ status: 200, body: { ok: true } });
globalThis.fetch = async (url, options = {}) => {
  if (/\/api\/capabilities$/.test(String(url))) return { ok: true, status: 200, json: async () => capabilities };
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body });
  const { status, body: answer } = responder({ url: String(url), body });
  return { ok: status < 400, status, json: async () => answer };
};
window.fetch = globalThis.fetch;

async function server(sso) {
  capabilities = { authMode: 'accounts', auth: { mode: 'accounts', setupRequired: false, user: null, admin: false, ...(sso === undefined ? {} : { sso }) } };
  platform.__resetPlatformForTests();
  await platform.initializePlatform();
}
function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(LoginPage, { onDone: () => {} }));
  return { host, root, close: () => { root.unmount(); host.remove(); } };
}
const shape = (host) => ({
  inputs: Array.from(host.querySelectorAll('input')).map((i) => `${i.type}:${i.autocomplete}`),
  buttons: Array.from(host.querySelectorAll('button')).map((b) => `${b.textContent.trim()}|${b.type}|${/btn-primary/.test(b.className) ? 'primary' : /btn-secondary/.test(b.className) ? 'secondary' : 'plain'}`),
  sso: host.querySelectorAll('[data-testid^="sso-"], [data-testid="admin-password-sign-in"]').length,
  hint: !!host.querySelector('[data-testid="download-desktop-hint"]'),
  alert: host.querySelector('[role="alert"]')?.textContent || '',
});
const AS_BEFORE = { inputs: ['text:username', 'password:current-password'], buttons: ['Sign in|submit|primary'], sso: 0, hint: true, alert: '' };

// ---- not configured: the page as it always was -----------------------------------------
for (const [name, sso] of [['sso: { enabled: false }', { enabled: false, passwordLogin: true }], ['no sso block at all (a server before 4.5.0)', undefined]]) {
  await server(sso);
  const page = mount();
  await sleep(40);
  check(`not configured (${name}): two fields, one primary "Sign in", the desktop hint - nothing of single sign-on`, JSON.stringify(shape(page.host)) === JSON.stringify(AS_BEFORE), JSON.stringify(shape(page.host)));
  check(`not configured (${name}): ssoState() is null and the username field has the focus`, auth.ssoState() === null && document.activeElement === page.host.querySelector('input'));
  calls.length = 0;
  typeInto(window, page.host.querySelectorAll('input')[0], 'bob');
  typeInto(window, page.host.querySelectorAll('input')[1], 'a long password');
  click(window, byText(document, /^Sign in$/));
  await waitFor(() => calls.length === 1);
  check(`not configured (${name}): signing in posts the username and password to /api/auth/login, as before`, /\/api\/auth\/login$/.test(calls[0].url) && calls[0].body.username === 'bob' && calls[0].headers['X-Requested-With'] === 'Jacarium' && !calls.some((c) => /sso/.test(c.url)));
  page.close();
}

// ---- configured ---------------------------------------------------------------------------
await server({ enabled: true, buttonLabel: 'Sign in with Example ID', passwordLogin: true, issuer: 'https://idp.example.test/realms/demo', autoCreate: false });
let page = mount();
await sleep(40);
let s = shape(page.host);
check('configured: the SSO button comes first with the configured label (primary); the password form follows, its button secondary', s.buttons[0] === 'Sign in with Example ID|button|primary' && s.buttons[1] === 'Sign in|submit|secondary'
  && s.inputs.length === 2 && /or with your username and password/.test(page.host.textContent) && s.hint, JSON.stringify(s));
check('configured: the SSO button is a text button (no icon in it)', !page.host.querySelector('[data-testid="sso-sign-in"] svg'));
const assigned = [];
auth.navigation.assign = (u) => assigned.push(u);
auth.navigation.reload = () => assigned.push('reload');
calls.length = 0;
responder = () => ({ status: 200, body: { ok: true, url: 'https://idp.example.test/realms/demo/auth?state=synthetic' } });
click(window, page.host.querySelector('[data-testid="sso-sign-in"]'));
await waitFor(() => assigned.length === 1);
check('configured: the button POSTs /api/auth/sso/begin {purpose: login} with the CSRF header and the browser goes to the URL the server answers', calls.length === 1 && /\/api\/auth\/sso\/begin$/.test(calls[0].url) && calls[0].method === 'POST'
  && calls[0].body.purpose === 'login' && calls[0].headers['X-Requested-With'] === 'Jacarium' && assigned[0] === 'https://idp.example.test/realms/demo/auth?state=synthetic', JSON.stringify(calls[0]));
page.close();
page = mount();
await sleep(40);
responder = () => ({ status: 429, body: { error: 'Too many attempts', retryAfter: 33 } });
click(window, page.host.querySelector('[data-testid="sso-sign-in"]'));
await waitFor(() => /33 seconds/.test(page.host.textContent));
check('configured: a 429 explains the wait and the button is usable again', /Try again in 33 seconds/.test(shape(page.host).alert) && !page.host.querySelector('[data-testid="sso-sign-in"]').disabled);
responder = () => ({ status: 502, body: { error: 'Single sign-on is not available right now. An administrator finds the reason in the server log.', code: 'provider' } });
click(window, page.host.querySelector('[data-testid="sso-sign-in"]'));
await waitFor(() => /not available right now/.test(page.host.textContent));
check('configured: a provider that cannot be reached is said in our words', /not available right now/.test(shape(page.host).alert));
page.close();

// ---- passwords for administrators only ------------------------------------------------------
await server({ enabled: true, buttonLabel: 'Sign in with SSO', passwordLogin: false, issuer: 'https://idp.example.test/realms/demo' });
page = mount();
await sleep(40);
s = shape(page.host);
check('administrators only: the SSO button and a quiet "Administrator sign-in with a password" link; no password fields', s.inputs.length === 0 && s.buttons.length === 2 && s.buttons[0] === 'Sign in with SSO|button|primary'
  && s.buttons[1] === 'Administrator sign-in with a password|button|plain', JSON.stringify(s));
click(window, page.host.querySelector('[data-testid="admin-password-sign-in"]'));
await sleep(30);
s = shape(page.host);
check('administrators only: the link reveals the two fields and the password button, said to be for administrators', s.inputs.length === 2 && s.buttons.includes('Sign in|submit|secondary') && /Administrators: sign in with your password/.test(page.host.textContent), JSON.stringify(s));
calls.length = 0;
typeInto(window, page.host.querySelectorAll('input')[0], 'carol');
typeInto(window, page.host.querySelectorAll('input')[1], 'a long password');
responder = () => ({ status: 403, body: { error: 'This server signs in with single sign-on. Passwords are for administrators only.', code: 'PASSWORD_LOGIN_DISABLED' } });
click(window, byText(document, /^Sign in$/));
await waitFor(() => /administrators only/.test(shape(page.host).alert));
check('administrators only: a user\'s password is answered with the server\'s sentence', /Passwords are for administrators only/.test(shape(page.host).alert));
page.close();

// ---- a refusal comes back as a code ------------------------------------------------------------
// put an outcome into the address; the returned list fills with what the page rewrites it to
function address(search) {
  window.history.pushState({}, '', `/${search}#tab`);
  const replaced = [];
  const real = window.history.replaceState.bind(window.history);
  window.history.replaceState = (state, title, url) => { replaced.push(url); window.history.replaceState = real; real(state, title, url); };
  return replaced;
}
await server({ enabled: true, buttonLabel: 'Sign in with SSO', passwordLogin: true, issuer: 'https://idp.example.test/realms/demo' });
for (const [code, sentence] of [['no_account', /No account on this server is linked/], ['link_required', /not linked to your identity/], ['not_allowed_group', /not in a group/],
  ['email_not_verified', /has not verified your email/], ['denied', /cancelled or refused/], ['state', /did not start in this browser/], ['token', /could not be verified/], ['disabled', /disabled/]]) {
  const replaced = address(`?sso_error=${code}&keep=1`);
  page = mount();
  await sleep(30);
  check(`refusal "${code}": the page shows our sentence for it and the code leaves the address (other parameters and the hash stay)`, sentence.test(shape(page.host).alert) && replaced.length === 1 && replaced[0] === '/?keep=1#tab', `${shape(page.host).alert} | ${replaced}`);
  page.close();
}
for (const hostile of ['Your account is locked. Call 555-0100', '<img src=x onerror=alert(1)>', 'x'.repeat(200)]) {
  address(`?sso_error=${encodeURIComponent(hostile)}`);
  page = mount();
  await sleep(30);
  check(`a value that is not one of our codes (${hostile.slice(0, 24)}...) is never shown: the generic sentence stands`, shape(page.host).alert === 'Single sign-on did not complete.' && !page.host.innerHTML.includes('555-0100') && !page.host.querySelector('img'), shape(page.host).alert);
  page.close();
}
address('');
page = mount();
await sleep(30);
check('no code in the address: no message', shape(page.host).alert === '');
page.close();

// ---- the helpers ----------------------------------------------------------------------------------
let replaced = address('?sso=linked');
check('takeSsoResult: ?sso=linked -> { ok, what: linked }, removed from the address', JSON.stringify(auth.takeSsoResult()) === JSON.stringify({ ok: true, what: 'linked' }) && replaced[0] === '/#tab');
replaced = address('?sso=something-else');
check('takeSsoResult: an unknown outcome is dropped (and still removed)', auth.takeSsoResult() === null && replaced.length === 1);
address('?page=documents');
check('takeSsoResult: an address without an outcome is left alone', auth.takeSsoResult() === null);
auth.rememberSsoResult({ ok: true, what: 'confirmed' });
check('rememberSsoResult / recallSsoResult: it crosses a page load in sessionStorage, leaves it at the first read, and stays for this page (Settings may mount twice)',
  window.sessionStorage.getItem('jacarium-sso-result') !== null && auth.recallSsoResult()?.what === 'confirmed' && window.sessionStorage.getItem('jacarium-sso-result') === null && auth.recallSsoResult()?.what === 'confirmed');
check('ssoMessage: every code the server sends has a sentence of ours; anything else the generic one', ['no_account', 'link_required', 'disabled', 'not_allowed_group', 'not_allowed_domain', 'email_not_verified', 'missing_claim', 'denied', 'state', 'stale', 'token', 'provider', 'config', 'identity_in_use', 'wrong_session', 'mismatch']
  .every((c) => auth.ssoMessage(c) !== 'Single sign-on did not complete.') && auth.ssoMessage('whatever') === 'Single sign-on did not complete.');
const backend = fs.readFileSync(path.join(here, '..', 'backend', 'auth.py'), 'utf8') + fs.readFileSync(path.join(here, '..', 'backend', 'oidc.py'), 'utf8');
const serverCodes = Array.from(new Set([...backend.matchAll(/OidcError\('([a-z_]+)'/g), ...backend.matchAll(/_sso_refused\('([a-z_]+)'/g), ...backend.matchAll(/reason = '([a-z_]+)'/g)].map((m) => m[1]))).filter((c) => c !== 'request' && c !== 'refused');
check(`...checked against the server's sources (${serverCodes.length} codes)`, serverCodes.length >= 12 && serverCodes.every((c) => auth.ssoMessage(c) !== 'Single sign-on did not complete.'), serverCodes.filter((c) => auth.ssoMessage(c) === 'Single sign-on did not complete.').join(', '));

// ---- signing out ------------------------------------------------------------------------------------
const went = [];
auth.navigation.assign = (u) => went.push(u);
auth.navigation.reload = () => went.push('reload');
responder = () => ({ status: 200, body: { ok: true } });
await auth.signOutAndReload();
responder = () => ({ status: 200, body: { ok: true, ssoLogoutUrl: 'https://idp.example.test/realms/demo/logout?client_id=jacarium' } });
await auth.signOutAndReload();
check('signing out reloads as before; when the server names the provider\'s sign-out address, the browser goes there instead', went.length === 2 && went[0] === 'reload' && went[1] === 'https://idp.example.test/realms/demo/logout?client_id=jacarium', went.join(' | '));

fs.rmSync(entry, { force: true });
await env.close?.();
process.exit(summary());
