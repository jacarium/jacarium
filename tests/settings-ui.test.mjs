/**
 * Guards the Settings > Users and Settings > Audit tabs (administrators) in
 * jsdom with the REAL components and a mocked backend:
 *   - the accounts list marks the last administrator and keeps the last
 *     admin's Promote/Demote, Disable and Delete buttons disabled (and
 *     one's own); a promotion asks for confirmation and calls the role route;
 *   - deleting an account opens the confirmation with the username to type
 *     (the button stays disabled until it matches) and sends it;
 *   - expanding a user shows sessions, linked devices and the "delete data"
 *     form: its confirm button needs the typed username + the admin's
 *     password; the request carries includeFiles=false by default;
 *     a session can be ended and a device revoked from there;
 *   - the Audit tab lists entries newest first with readable labels.
 * Run: node tests/settings-ui.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['react', 'esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom`); process.exit(1); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ui-'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };

const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import UsersSettings from '@worktree/src/components/common/modals/settings/UsersSettings.jsx';
import AuditSettings from '@worktree/src/components/common/modals/settings/AuditSettings.jsx';
import * as platform from '@worktree/src/utils/platform.js';
let root = null;
export { platform };
export function mount(which) {
  if (root) root.unmount();
  root = createRoot(document.getElementById('root'));
  root.render(which === 'audit' ? <AuditSettings /> : <UsersSettings />);
}
export function unmount() { if (root) { root.unmount(); root = null; } }
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.test/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'localStorage', 'sessionStorage']) define(k, window[k]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const type = (input, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); };
const byTestId = (id) => doc.querySelector(`[data-testid="${id}"]`);
// the last match: a confirmation dialog is portaled to the end of the body, after the row buttons it may share a label with
const byText = (re) => Array.from(doc.querySelectorAll('button')).filter((b) => re.test(b.textContent.trim())).pop();
const settle = async (ms = 80) => { await sleep(ms); };

// ---- the mocked backend ----
const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice', role: 'admin', disabled: false, mustChangePassword: false };
const BOB = { id: 'u-bob', username: 'bob', displayName: 'Bob', role: 'user', disabled: false, mustChangePassword: false };
let users = [ALICE, BOB];
const calls = [];
const AUDIT = [
  { at: '2026-10-11T13:00:00+0000', action: 'data-deleted', fields: { user: 'bob', by: 'alice', records: '12', files: '0' } },
  { at: '2026-10-11T12:59:00+0000', action: 'sign-in-failed', fields: { user: 'bob', ip: '10.0.0.5' } },
  { at: '2026-10-11T12:58:00+0000', action: 'sign-in', fields: { user: 'alice', ip: '10.0.0.4', temporary: '0' } },
];
globalThis.fetch = async (url, options = {}) => {
  const u = String(url); const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url: u, method, body });
  const json = (status, answer) => ({ ok: status < 400, status, json: async () => answer });
  if (u.endsWith('/api/capabilities')) return json(200, { authMode: 'accounts', auth: { mode: 'accounts', user: ALICE, admin: true }, capabilities: { sync: true } });
  if (u.endsWith('/api/admin/users') && method === 'GET') return json(200, { users });
  if (/\/api\/admin\/users\/u-bob\/role$/.test(u)) { users = users.map((x) => (x.id === 'u-bob' ? { ...x, role: body.role } : x)); return json(200, { ok: true }); }
  if (/\/api\/admin\/users\/u-bob$/.test(u) && method === 'DELETE') { users = users.filter((x) => x.id !== 'u-bob'); return json(200, { ok: true }); }
  if (/\/api\/admin\/users\/u-bob\/sessions$/.test(u)) return json(200, { sessions: [{ id: 's1', createdAt: 1, lastSeen: 1791700000, userAgent: 'bobs-tablet', current: false }], devices: [{ id: 'd1', name: 'bobs desktop', lastSeen: null, revoked: false }] });
  if (/\/api\/admin\/users\/u-bob\/sessions\/s1$/.test(u) && method === 'DELETE') return json(200, { ok: true });
  if (/\/api\/admin\/users\/u-bob\/devices\/d1$/.test(u) && method === 'DELETE') return json(200, { ok: true });
  if (/\/api\/admin\/users\/u-bob\/backups$/.test(u)) return json(200, { backups: [], keep: 3 });
  if (/\/api\/admin\/users\/u-bob\/data\/delete$/.test(u)) return json(200, { ok: true, generation: 2, deleted: { records: 12, files: [] }, backups: ['20261011T130000Z-before-delete.json'] });
  if (/\/api\/admin\/audit/.test(u)) return json(200, { entries: AUDIT });
  return json(404, { error: `unmocked ${method} ${u}` });
};
window.fetch = globalThis.fetch;

const { mount, unmount, platform } = createRequire(import.meta.url)(BUNDLE);
await platform.initializePlatform();

try {
  // ---- Users ----
  mount('users');
  await settle(150);
  check('the accounts are listed; alice is "(you)" and the last administrator', /alice \(you\)/.test(byTestId('user-row-alice')?.textContent || '') && /\(last\)/.test(byTestId('user-row-alice')?.textContent || ''), byTestId('user-row-alice')?.textContent);
  const aliceButtons = Array.from(byTestId('user-row-alice').querySelectorAll('button')).filter((b) => /Promote|Demote|Disable|Delete/.test(b.textContent));
  check('the last admin\'s Demote, Disable and Delete are disabled', aliceButtons.length === 3 && aliceButtons.every((b) => b.disabled), aliceButtons.map((b) => `${b.textContent.trim()}:${b.disabled}`).join(','));
  const promote = byTestId('user-role-bob');
  check('bob can be promoted', promote && !promote.disabled && /Promote/.test(promote.textContent));
  click(promote);
  await settle();
  check('promoting asks for confirmation (ConfirmationModal)', /Make bob an administrator\?/.test(doc.body.textContent));
  click(byText(/^Make administrator$/));
  await settle(150);
  check('...and calls the role route, then reloads the list (bob is an administrator; alice no longer "(last)")', calls.some((c) => /u-bob\/role$/.test(c.url) && c.body.role === 'admin') && /administrator/.test(byTestId('user-row-bob')?.textContent || '') && !/\(last\)/.test(byTestId('user-row-alice')?.textContent || ''));
  check('with two admins alice\'s Disable/Delete stay disabled only because she is herself', Array.from(byTestId('user-row-alice').querySelectorAll('button')).filter((b) => /Disable|Delete/.test(b.textContent)).every((b) => b.disabled && /own|another administrator/.test(b.title)));

  // expand bob: sessions, devices, data deletion
  click(byTestId('user-expand-bob'));
  await settle(150);
  const details = byTestId('user-details-bob');
  check('expanding bob shows his session and linked device', details && /bobs-tablet/.test(details.textContent) && /bobs desktop/.test(details.textContent), details?.textContent.slice(0, 160));
  click(Array.from(details.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Sign out'));
  await settle(120);
  check('ending his session calls the admin session route', calls.some((c) => /u-bob\/sessions\/s1$/.test(c.url) && c.method === 'DELETE'));
  click(Array.from(byTestId('user-details-bob').querySelectorAll('button')).find((b) => b.textContent.trim() === 'Revoke'));
  await settle();
  click(byText(/^Revoke$/));
  await settle(120);
  check('revoking his device asks first, then calls the admin device route', calls.some((c) => /u-bob\/devices\/d1$/.test(c.url) && c.method === 'DELETE'));
  click(byTestId('delete-data-open-bob'));
  await settle();
  const form = byTestId('delete-data-form-bob');
  check('the data-deletion form says whose data it is and needs the typed username + the admin\'s password', form && /deleting the data of bob/.test(form.textContent) && byTestId('delete-data-confirm').disabled);
  type(byTestId('delete-data-username'), 'bob');
  await settle();
  check('...the username alone is not enough', byTestId('delete-data-confirm').disabled);
  type(byTestId('delete-data-password'), 'alices password');
  await settle();
  check('...username + password enable it', !byTestId('delete-data-confirm').disabled);
  click(byTestId('delete-data-confirm'));
  await settle(150);
  const del = calls.find((c) => /u-bob\/data\/delete$/.test(c.url));
  check('the request carries the password, the typed username and includeFiles=false by default', del && del.body.password === 'alices password' && del.body.confirmUsername === 'bob' && del.body.includeFiles === false, JSON.stringify(del?.body));
  check('...and the result is shown', /12 record\(s\) of bob removed/.test(byTestId('delete-data-result')?.textContent || ''), byTestId('delete-data-result')?.textContent);

  // delete the account: typed username in the confirmation
  click(byTestId('user-delete-bob'));
  await settle();
  const confirmBtn = byText(/^Delete account$/);
  check('deleting an account asks for the username to be typed (button disabled until it matches)', /Delete the account bob\?/.test(doc.body.textContent) && confirmBtn?.disabled);
  type(Array.from(doc.querySelectorAll('input[type=text]')).find((i) => /Type: bob/.test(i.placeholder)), 'bob');
  await settle();
  check('...typing it enables the button', !byText(/^Delete account$/).disabled);
  click(byText(/^Delete account$/));
  await settle(150);
  check('...and the DELETE carries confirmUsername; bob is gone from the list', calls.some((c) => /u-bob$/.test(c.url) && c.method === 'DELETE' && c.body.confirmUsername === 'bob') && !byTestId('user-row-bob'));
  unmount();

  // ---- Audit ----
  mount('audit');
  await settle(150);
  const rows = Array.from(doc.querySelectorAll('[data-testid="audit-table"] tbody tr'));
  check('the audit tab lists the entries newest first with readable labels', rows.length === 3 && /All data deleted on the server/.test(rows[0].textContent) && /bob by alice 12 record\(s\)/.test(rows[0].textContent) && /Sign-in failed/.test(rows[1].textContent) && /Signed in/.test(rows[2].textContent), rows.map((r) => r.textContent.slice(0, 60)).join(' / '));
  unmount();
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  try { unmount(); } catch { /* done */ }
  fs.rmSync(WORKDIR, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
