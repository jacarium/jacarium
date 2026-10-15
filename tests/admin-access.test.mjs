/**
 * Who sees the administration in Settings (src/utils/adminAccess.js), and
 * that the Settings dialog gates its Users/Audit categories with it:
 *   - browser with accounts: an admin sees them, a user does not;
 *   - desktop, not linked: no account section, no administration;
 *   - desktop linked as a user: the account section, no administration;
 *   - desktop linked as an admin to a server with desktopAdmin: both, with
 *     the server's name in the labels;
 *   - desktop linked as an admin to an older server: the notice instead.
 * Plus the renderer's account calls: on the desktop they go through the
 * main process with the device token and a STEP_UP_REQUIRED answer asks the
 * registered prompt once, confirms at /api/auth/step-up and retries.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const { adminAccess, serverLabel } = await import(path.join(REPO, 'src/utils/adminAccess.js'));
const caps = { desktopAdmin: true, stepUp: true };
let a = adminAccess({ accountsMode: true, admin: true });
check('browser, admin: account section and administration, not remote', a.account && a.admin && !a.remote && !a.unsupported);
a = adminAccess({ accountsMode: true, admin: false });
check('browser, user: account section, no administration', a.account && !a.admin);
a = adminAccess({ accountsMode: false, remote: null });
check('desktop, not linked: nothing', !a.account && !a.admin && !a.remote);
a = adminAccess({ accountsMode: false, remote: { url: 'https://pi.console/', role: 'user', capabilities: caps } });
check('desktop linked as a user: the account section on the server, no administration', a.account && !a.admin && a.remote && a.server === 'pi.console');
a = adminAccess({ accountsMode: false, remote: { url: 'https://pi.console/', role: 'admin', capabilities: caps } });
check('desktop linked as an admin: administration of the server', a.account && a.admin && a.remote && !a.unsupported && a.server === 'pi.console');
a = adminAccess({ accountsMode: false, remote: { url: 'https://192.168.0.5:8443', role: 'admin', capabilities: {} } });
check('desktop linked as an admin to an older server: no administration, the notice', a.account && !a.admin && a.unsupported && a.server === '192.168.0.5:8443');
check('serverLabel: host, with a non-default port', serverLabel('https://pi.console/') === 'pi.console' && serverLabel('https://10.0.0.8:8443/') === '10.0.0.8:8443');

// the Settings dialog uses it for its categories
const modal = fs.readFileSync(path.join(REPO, 'src/components/common/modals/SettingsModal.jsx'), 'utf8');
check('SettingsModal gates Users/Audit with adminAccess and labels the remote server', /adminAccess\(\{ accountsMode: accountsEnabled\(\), admin: isAdmin\(\), remote \}\)/.test(modal) && /label: access\.remote \? `Users on \$\{access\.server\}` : 'Users'/.test(modal) && /remote-admin-unsupported/.test(modal) && /<StepUpModal/.test(modal));
check('SettingsModal reads the role and the capabilities from the linked server through the main process', /transport\.fetch\('\/api\/auth\/me'\)/.test(modal) && /transport\.fetch\('\/api\/version'\)/.test(modal) && /setRemoteAccount\(account\)/.test(modal));

// ---- the account calls on the desktop: through the bridge, with the step-up retry ----
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-access-'));
const OUT = path.join(WORK, 'auth.cjs');
await build({ entryPoints: [path.join(REPO, 'src/utils/auth.js')], bundle: true, outfile: OUT, format: 'cjs', platform: 'node', logLevel: 'silent', define: { 'import.meta.env': '{}' } });
const calls = [];
let stepUps = 0;
globalThis.window = {
  electronAPI: {
    homeServerFetch: async (p, init) => {
      calls.push({ path: p, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (p === '/api/auth/step-up') { stepUps++; return { ok: true, status: 200, text: JSON.stringify({ ok: true }) }; }
      if (p === '/api/admin/users' && init.method === 'POST') {
        if (stepUps === 0) return { ok: false, status: 403, text: JSON.stringify({ error: 'Confirm your password', code: 'STEP_UP_REQUIRED' }) };
        return { ok: true, status: 201, text: JSON.stringify({ ok: true, user: { id: 'u-carol', username: init.body && JSON.parse(init.body).username } }) };
      }
      if (p === '/api/admin/users') return { ok: true, status: 200, text: JSON.stringify({ users: [{ username: 'alice', role: 'admin' }] }) };
      return { ok: false, status: 404, text: '{}' };
    },
    getBackendPort: async () => 8080,
    getAppToken: async () => 'synthetic',
  },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const auth = req(OUT);
auth.setRemoteAccount({ url: 'https://pi.console/', username: 'alice', role: 'admin', capabilities: caps });
const users = await auth.admin.listUsers();
check('a read goes through the main-process bridge with no step-up', users.users[0].username === 'alice' && calls.length === 1 && calls[0].path === '/api/admin/users' && stepUps === 0, JSON.stringify(calls));
let prompted = 0;
auth.setStepUpPrompt(async () => { prompted++; return 'alices password'; });
const created = await auth.admin.createUser({ username: 'carol', password: 'carols password 1', role: 'user' });
check('a state-changing call answered STEP_UP_REQUIRED asks the prompt once, confirms the password and retries', created.user.username === 'carol' && prompted === 1 && stepUps === 1 && calls.filter((c) => c.path === '/api/admin/users' && c.method === 'POST').length === 2, JSON.stringify({ prompted, stepUps, calls: calls.length }));
check('the password went only to /api/auth/step-up', calls.filter((c) => c.body && c.body.password === 'alices password').every((c) => c.path === '/api/auth/step-up'));
auth.setStepUpPrompt(async () => null);
stepUps = 0;
let refused = null;
try { await auth.admin.createUser({ username: 'dave', password: 'daves password 1', role: 'user' }); } catch (e) { refused = e; }
check('cancelling the prompt leaves the action refused (error marked stepUp)', refused && refused.stepUp === true && refused.status === 403, refused && refused.message);
const urlRemote = await auth.accountData.backupUrl('x.tar.gz');
check('a backup download is not offered on the desktop (no session for the browser download)', urlRemote === null);
auth.setRemoteAccount(null);
fs.rmSync(WORK, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
