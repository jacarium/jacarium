#!/usr/bin/env node
/**
 * Runs deploy/deploy-to-host.sh against a throwaway Linux target: the podman
 * machine VM, reached over its own SSH port with its identity key, as the
 * `core` user (rootless podman 5 with Quadlet, lingering on, systemd user
 * session) - the shape of a Fedora Raspberry Pi. Everything is a separate
 * named instance (own container, units, image tags, state dirs and port),
 * so the user's own containers and images are not touched; the podman
 * storage is shared with this machine's podman, so the "already has the
 * image" path is the normal one and --force-transfer exercises the
 * save | gzip | ssh | load pipeline.
 *
 * What this test proves:
 *   0. the upgrade from 3.1: the 3.1.0 deploy scripts (from the git tag)
 *      install the two-container shape - console + jacarium-central on a
 *      shared network, the central state under instances/X/central - and an
 *      account shares a document there (its identity in clients.json, a
 *      synthetic snapshot file, the Yjs and account-ticket keys); the CURRENT
 *      script then upgrades it: ONE container runs, the central state was
 *      MOVED (same bytes) into the console data dir, the old container, its
 *      unit, the network and the central image are gone, the identity is
 *      still known and a fresh ticket still works, nothing was left behind;
 *   1. the install is healthy as an enabled Quadlet unit, state dir, config
 *      and certificate exist; the central server runs in the container,
 *      reachable at <console>/central with account sign-in on and pairing
 *      closed; the keys are 0600 in the data dir and in no process argument;
 *   2. an unchanged re-run restarts nothing (container start time equal),
 *      and neither does a re-run after the local image is gone: the
 *      container is left alone when it was built from the same inputs (a
 *      label on the image), whatever the image id; sign-in is on by default;
 *   3. an update with a changed image: the new image runs, the previous one
 *      is kept as :previous, a marker file, the certificate and the central
 *      keys survive untouched;
 *   4. rollback: a broken image (its entrypoint exits) is deployed with
 *      --no-build; the script reports the rollback and the previous image is
 *      running and healthy again; a broken image deployed over a 3.1-style
 *      state dir moves the central state back where it was;
 *   5. reboot survival: the unit is enabled in default.target, lingering is
 *      on, a container killed under systemd's feet is brought back, and the
 *      central server killed inside the container is restarted in place;
 *   6. uninstall keeps the state, uninstall --purge removes it.
 *
 * The Docker path cannot run here (the VM's `docker` is podman's alias);
 * it is checked against a real Docker host by hand.
 *
 * Run:  node tests/deploy-to-host.test.mjs
 * SKIPs (exit 0) when podman has no running machine, when its SSH details
 * are unavailable, or with SKIP_DEPLOY_TO_HOST_TESTS set. Synthetic data only.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'deploy', 'deploy-to-host.sh');
if (process.env.SKIP_DEPLOY_TO_HOST_TESTS) { console.log('SKIP: SKIP_DEPLOY_TO_HOST_TESTS is set'); process.exit(0); }
if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: podman is not installed'); process.exit(0); }
const inspect = spawnSync('podman', ['machine', 'inspect', '--format', '{{.SSHConfig.RemoteUsername}} {{.SSHConfig.Port}} {{.SSHConfig.IdentityPath}} {{.State}}'], { encoding: 'utf8' });
if (inspect.status !== 0 || !/running/.test(inspect.stdout)) { console.log('SKIP: no running podman machine to use as the throwaway target'); process.exit(0); }
const [sshUser, sshPort, sshKey] = inspect.stdout.trim().split(' ');
const TARGET = `${sshUser}@localhost`;
const SSH_OPTS = ['-i', sshKey, '-p', sshPort, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR'];
const env = { ...process.env, DEPLOY_SSH_OPTS: SSH_OPTS.join(' ') };
// (is-system-running exits non-zero for "degraded" - a failed unit of someone
// else's - so only its answer is required, not its exit status)
const probe = spawnSync('ssh', [...SSH_OPTS, '-o', 'BatchMode=yes', TARGET, 'podman --version && systemctl --user is-system-running; true'], { encoding: 'utf8' });
if (probe.status !== 0 || !/podman version/.test(probe.stdout)) { console.log(`SKIP: cannot reach the podman machine over SSH (${(probe.stderr || probe.stdout || '').trim().slice(0, 120)})`); process.exit(0); }

const INSTANCE = `dt${process.pid}`;
const CONSOLE_PORT = 20000 + (process.pid % 5000);
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`); };
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const rssh = (cmd) => spawnSync('ssh', [...SSH_OPTS, '-o', 'BatchMode=yes', TARGET, cmd], { encoding: 'utf8' });
const remote = (cmd) => (rssh(cmd).stdout || '').trim();
const deployWith = (script, args, extraEnv = {}) => {
  const r = spawnSync('bash', [script, TARGET, ...args, '--instance', INSTANCE, '--tag', INSTANCE, '--yes'], { encoding: 'utf8', env: { ...env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: strip(r.stdout) + strip(r.stderr) };
};
const deploy = (args, extraEnv = {}) => deployWith(SCRIPT, args, extraEnv);
const stateDir = `~/.config/jacarium/instances/${INSTANCE}`;
const CONSOLE = `jacarium-${INSTANCE}`;
const CENTRAL = `jacarium-central-${INSTANCE}`;
const startedAt = () => remote(`podman inspect --format '{{.Name}} {{.State.StartedAt}}' ${CONSOLE} 2>/dev/null`);
const imageOf = (name) => remote(`podman inspect --format '{{.Image}}' ${name} 2>/dev/null`);
const sha = (file) => remote(`sha256sum ${file} 2>/dev/null | cut -c1-16`);
const localImageId = (tag) => (spawnSync('podman', ['image', 'inspect', '--format', '{{.Id}}', `localhost/jacarium:${tag}`], { encoding: 'utf8' }).stdout || '').trim();
const curl = (p, extra = '') => remote(`curl -sk ${extra} 'https://127.0.0.1:${CONSOLE_PORT}${p}'`);
const health = (name) => remote(`podman inspect --format '{{.State.Health.Status}}' ${name} 2>/dev/null`);
const sleep = (ms) => spawnSync('sleep', [String(ms / 1000)]);
const waitFor = (fn, tries = 90) => { let v = ''; for (let i = 0; i < tries; i++) { v = fn(); if (v) return v; sleep(1000); } return v; };

const OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-310-'));
const cleanup = () => {
  spawnSync('bash', [SCRIPT, TARGET, 'uninstall', '--instance', INSTANCE, '--purge', '--yes'], { env, stdio: 'ignore' });
  // (the 3.1 shape's leftovers, should the upgrade have failed half-way)
  rssh(`systemctl --user disable --now ${CENTRAL}.service >/dev/null 2>&1; rm -f ~/.config/containers/systemd/${CENTRAL}.container; systemctl --user daemon-reload; podman rm -f ${CENTRAL} >/dev/null 2>&1; podman network rm jacarium-${INSTANCE} >/dev/null 2>&1; rm -rf ${stateDir}; true`);
  spawnSync('podman', ['rmi', '-f', `localhost/jacarium:${INSTANCE}`, `localhost/jacarium-central:${INSTANCE}`, `localhost/jacarium:${INSTANCE}-broken`], { stdio: 'ignore' });
  spawnSync('bash', [path.join(REPO, 'deploy', 'prune-images.sh'), '--component', 'deploy'], { stdio: 'ignore' });
  spawnSync('bash', [path.join(REPO, 'deploy', 'prune-images.sh'), '--component', 'central'], { stdio: 'ignore' });
  fs.rmSync(OLD, { recursive: true, force: true });
};

// A run that is interrupted (Ctrl+C, a killed run-all) skips the `finally`
// below: clean up on the signal too, or the instance stays installed in the
// podman machine as a systemd unit that starts with it.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}
// Instances left by earlier runs that were killed outright (dt<pid> of a
// process that is no longer alive on this machine) are removed before starting.
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
for (const name of remote(`ls ~/.config/containers/systemd/ 2>/dev/null`).split('\n')) {
  const m = /^jacarium-(dt(\d+))\.container$/.exec(name.trim());
  if (!m || m[1] === INSTANCE || isAlive(Number(m[2]))) continue;
  console.log(`removing the leftover test instance ${m[1]} (its run is gone)`);
  spawnSync('bash', [SCRIPT, TARGET, 'uninstall', '--instance', m[1], '--purge', '--yes'], { env, stdio: 'ignore' });
  spawnSync('podman', ['rmi', '-f', `localhost/jacarium:${m[1]}`, `localhost/jacarium-central:${m[1]}`, `localhost/jacarium:${m[1]}-broken`], { stdio: 'ignore' });
}

try {
  // ---- 0. the 3.1.0 two-container shape, then the upgrade -----------------------------
  console.log(`--- 3.1.0 install (instance ${INSTANCE}, port ${CONSOLE_PORT}) with the scripts of tag v3.1.0`);
  // the 3.1.0 deploy scripts, and the 3.1.0 central server image built from
  // the tag (the console image: the current one - its CENTRAL_UPSTREAM mode
  // is the 3.1 shape, so the 3.1 script runs it exactly as it ran 3.1.0)
  fs.mkdirSync(path.join(OLD, 'deploy'), { recursive: true });
  for (const f of ['deploy-to-host.sh', 'remote-host.sh']) fs.writeFileSync(path.join(OLD, 'deploy', f), spawnSync('git', ['show', `v3.1.0:deploy/${f}`], { cwd: REPO, encoding: 'utf8' }).stdout);
  fs.mkdirSync(path.join(OLD, 'central'));
  const archive = spawnSync('git', ['archive', 'v3.1.0', 'jacarium-central'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  spawnSync('tar', ['-x', '-C', path.join(OLD, 'central'), '--strip-components=1'], { input: archive.stdout });
  const cbuild = spawnSync('podman', ['build', '--format', 'docker', '-t', `localhost/jacarium-central:${INSTANCE}`, path.join(OLD, 'central')], { encoding: 'utf8' });
  check('0. the 3.1.0 central server image builds from the tag', cbuild.status === 0, (cbuild.stderr || '').split('\n').filter(Boolean).slice(-3).join(' / '));
  const build = spawnSync('podman', ['build', '--format', 'docker', '-f', path.join(REPO, 'deploy', 'Containerfile'), '-t', `localhost/jacarium:${INSTANCE}`, REPO], { encoding: 'utf8' });
  check('0. the console image builds', build.status === 0, (build.stderr || '').split('\n').filter(Boolean).slice(-3).join(' / '));
  let r = deployWith(path.join(OLD, 'deploy', 'deploy-to-host.sh'), ['--address', '127.0.0.1', '--name', 'pi.console', '--san', 'throwaway.example.test', '--console-port', String(CONSOLE_PORT), '--no-build']);
  check('0. the 3.1.0 script installs the two containers', r.status === 0 && /console: healthy/.test(r.out) && /central: healthy/.test(r.out), r.out.split('\n').filter((l) => /ERROR|WARN.*healthy|ROLLED/.test(l)).join(' / '));
  check('0. ...two containers, a shared network, the central state under instances/X/central', remote(`podman ps --format '{{.Names}}' | grep -c "^jacarium.*${INSTANCE}$"`) === '2' && remote(`podman network exists jacarium-${INSTANCE} && echo yes`) === 'yes' && remote(`test -s ${stateDir}/central/keys/yjs-encryption.key && test -s ${stateDir}/central/keys/account-ticket.key && echo yes`) === 'yes');
  const oldConf = remote(`cat ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf`);
  check('0. ...the 3.1 config names both components', /COMPONENTS=console,central/.test(oldConf) && /CENTRAL_MODE=fronted/.test(oldConf), oldConf.replace(/\n/g, ' | '));
  // an account shares a document through the 3.1 central server (its identity goes on record)
  const code = waitFor(() => remote(`cat ${stateDir}/console-data/setup-code 2>/dev/null`), 30);
  const setup = curl('/api/auth/setup', `-D - -o /dev/null -X POST -H 'Content-Type: application/json' -H 'X-Requested-With: Jacarium' -d '{"setupCode":"${code}","username":"alice","password":"alices password 1","displayName":"Alice Example"}'`);
  const cookie = (setup.match(/set-cookie: ([^;]+)/i) || [])[1] || '';
  check('0. an administrator account exists on the 3.1 console', !!cookie, setup.split('\n')[0]);
  const ticketOld = JSON.parse(curl('/api/auth/central-ticket', `-X POST -H 'Content-Type: application/json' -H 'X-Requested-With: Jacarium' -H 'Cookie: ${cookie}' -d '{}'`) || '{}');
  const upload = curl('/central/api/documents', `-o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'X-Account-Ticket: ${ticketOld.ticket}' -d '{"document":{"title":"Shared before the upgrade","content":"x","ownerId":"${ticketOld.identity}","category":"General","cloudLastUpdated":1}}'`);
  check('0. ...and shares a document at the 3.1 central server with its ticket', upload === '200' && /^alice@account-/.test(ticketOld.identity || ''), `${upload} ${ticketOld.identity}`);
  const registryBefore = waitFor(() => remote(`cat ${stateDir}/central/data/clients.json 2>/dev/null`), 10);
  check('0. ...the identity is on record in the 3.1 central state', registryBefore.includes(ticketOld.identity), registryBefore.slice(0, 120));
  // a synthetic persisted snapshot next to it: the central server's data dir must move as it is;
  // and the enrollment secret a 3.0/3.1 deploy could store (nothing reads it since 3.1.1)
  remote(`mkdir -p ${stateDir}/central/data/documents && printf 'synthetic ydoc bytes %s' ${INSTANCE} > ${stateDir}/central/data/documents/synthetic-${INSTANCE}.ydoc && printf 'synthetic-enrollment-secret' > ${stateDir}/central/keys/enrollment.secret`);
  const before = { yjs: sha(`${stateDir}/central/keys/yjs-encryption.key`), ticket: sha(`${stateDir}/central/keys/account-ticket.key`), doc: sha(`${stateDir}/central/data/documents/synthetic-${INSTANCE}.ydoc`), inode: remote(`stat -c %i ${stateDir}/central/data/documents/synthetic-${INSTANCE}.ydoc`) };
  check('0. the state to carry over is in place (keys, synthetic snapshot)', before.yjs && before.ticket && before.doc && before.inode, JSON.stringify(before));
  const oldCentralImage = imageOf(CENTRAL);

  console.log('--- upgrade to the one container (the current script)');
  r = deploy([]);
  check('0. the upgrade succeeds', r.status === 0, r.out.split('\n').filter((l) => /ERROR|WARN|ROLLED/.test(l)).join(' / '));
  check('0. ...and said what it was about to do', /moves into the console's container/.test(r.out) && /moved .*central\/data -> .*console-data\/central\/data/.test(r.out) && /moved .*central\/keys -> .*console-data\/central\/keys/.test(r.out), r.out.split('\n').filter((l) => /moved|moves/.test(l)).join(' / '));
  check('0. ONE container runs; the central container, its unit and the network are gone', remote(`podman ps -a --format '{{.Names}}' | grep -c "^jacarium.*${INSTANCE}$"`) === '1' && remote(`podman inspect ${CENTRAL} >/dev/null 2>&1 || echo gone`) === 'gone' && remote(`ls ~/.config/containers/systemd/ | grep -c ${INSTANCE}`) === '1' && remote(`podman network exists jacarium-${INSTANCE} || echo gone`) === 'gone');
  check('0. the central state MOVED (same bytes, same inode: a rename, not a copy)', sha(`${stateDir}/console-data/central/keys/yjs-encryption.key`) === before.yjs && sha(`${stateDir}/console-data/central/keys/account-ticket.key`) === before.ticket && sha(`${stateDir}/console-data/central/data/documents/synthetic-${INSTANCE}.ydoc`) === before.doc && remote(`stat -c %i ${stateDir}/console-data/central/data/documents/synthetic-${INSTANCE}.ydoc`) === before.inode, JSON.stringify(before));
  check('0. ...and the old state dir is gone (nothing left behind, the 3.1 env files included)', remote(`test -e ${stateDir}/central || echo gone`) === 'gone' && remote(`ls ${stateDir}/console-data/central/keys`).split('\n').sort().join(',') === 'account-ticket.key,yjs-encryption.key');
  check('0. the unused enrollment secret of 3.0/3.1 was removed once the container was up, and the run said so', /removed the enrollment secret of 3\.0\/3\.1/.test(r.out) && remote(`test -e ${stateDir}/console-data/central/keys/enrollment.secret || echo gone`) === 'gone', r.out.split('\n').filter((l) => /enrollment/.test(l)).join(' / '));
  check('0. ...and nothing in the output says to remove it by hand', !/remove it when you like/.test(r.out));
  check('0. the 3.1 central image was removed after success (the rollback aid is no longer needed)', remote(`podman image exists localhost/jacarium-central:${INSTANCE} || echo gone`) === 'gone' && remote(`podman image exists ${oldCentralImage} || echo gone`) === 'gone');
  const registryAfter = remote(`cat ${stateDir}/console-data/central/data/clients.json`);
  check('0. the identity shared before the upgrade is still known to the central server', registryAfter.includes(ticketOld.identity));
  const ticketNew = JSON.parse(curl('/api/auth/central-ticket', `-X POST -H 'Content-Type: application/json' -H 'X-Requested-With: Jacarium' -H 'Cookie: ${cookie}' -d '{}'`) || '{}');
  const upload2 = curl('/central/api/documents', `-o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'X-Account-Ticket: ${ticketNew.ticket}' -d '{"document":{"title":"Shared after the upgrade","content":"y","ownerId":"${ticketNew.identity}","category":"General","cloudLastUpdated":2}}'`);
  check('0. the account still signs in to the central server (the same key, a fresh ticket) and shares', upload2 === '200' && ticketNew.identity === ticketOld.identity, `${upload2} ${ticketNew.identity}`);
  check('0. the config no longer names components or a central mode', !/COMPONENTS|CENTRAL_MODE|CENTRAL_PORT|CORS_ORIGIN/.test(remote(`cat ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf`)));

  // ---- 1. the install ---------------------------------------------------------------
  console.log('--- the one-container install');
  check('the URLs lead with the name; the central server is in the container', /Jacarium: https:\/\/pi\.console:\d+/.test(r.out) && /Central server: +https:\/\/pi\.console:\d+\/central/.test(r.out) && /nothing to set up/.test(r.out), r.out.split('\n').filter((l) => /Central server/.test(l)).join(' / '));
  check('the name-resolution fix is printed (pi.console does not resolve here)', /sudo tee -a \/etc\/hosts/.test(r.out));
  const units = remote(`systemctl --user is-enabled ${CONSOLE}.service 2>&1`);
  // Quadlet-generated units answer "generated" to is-enabled (the generator
  // applies their [Install] section); hand-written units answer "enabled"
  check('the unit is an installed Quadlet unit', /^(generated|enabled)/.test(units), units);
  check('health is reported by the container itself', health(CONSOLE) === 'healthy');
  const conf = remote(`cat ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf`);
  check('the config is stored on the target with name, address and port', /NAME=pi\.console/.test(conf) && /ADDRESS=127\.0\.0\.1/.test(conf) && new RegExp(`CONSOLE_PORT=${CONSOLE_PORT}`).test(conf) && /MODE=quadlet/.test(conf), conf.replace(/\n/g, ' | '));
  const centralHealth = curl('/central/api/health');
  check('the central server answers at <console>/central/api/health with account sign-in on', /"status":"ok"/.test(centralHealth) && /"account_sign_in":true/.test(centralHealth), centralHealth.slice(0, 160));
  check('the keys are 0600 in the data dir and in no process argument',
    remote(`stat -c %a ${stateDir}/console-data/central/keys/account-ticket.key ${stateDir}/console-data/central/keys/yjs-encryption.key | sort -u`) === '600'
    && remote(`podman inspect --format '{{.Args}} {{.Config.Cmd}}' ${CONSOLE}`).includes(remote(`cat ${stateDir}/console-data/central/keys/account-ticket.key`)) === false
    && remote(`podman exec ${CONSOLE} sh -c 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "'`).includes(remote(`cat ${stateDir}/console-data/central/keys/account-ticket.key`)) === false);
  check('/api/version on the console announces the provided central server', /"provided": ?true/.test(curl('/api/version')));
  check('pairing is closed at the central server (403 ACCOUNT_SIGN_IN_ONLY through /central)', /ACCOUNT_SIGN_IN_ONLY/.test(curl('/central/api/register', `-X POST -H 'Content-Type: application/json' -d '{"machine_id":"browser-00000000@x"}'`)));
  check('the deprecated options are refused with a message', /unknown option/.test(deploy(['--set-enrollment-secret']).out) && /gone/.test(deploy(['--central', 'standalone']).out) && /gone/.test(deploy(['--only', 'console']).out));
  check('the Socket.IO handshake answers under /central/socket.io through the console', /^0\{"sid"/.test(curl('/central/socket.io/?EIO=4&transport=polling')));
  check('the console answers /health through its own certificate', /healthy/.test(curl('/health')));
  check('state dir is owned by the target user (keep-id)', remote(`stat -c %U ${stateDir}/console-data/certs/cert.pem ${stateDir}/console-data/central/data 2>/dev/null | sort -u`) === sshUser);
  check('sign-in is on: the API answers 401 without a session, AUTH_MODE stored', /AUTH_MODE=accounts/.test(conf) && curl('/api/taskwarrior/check', "-o /dev/null -w '%{http_code}'") === '401', conf.replace(/\n/g, ' | '));
  check('...and the image carries the build-inputs label', /^[0-9a-f]{16}$/.test(remote(`podman inspect --format '{{index .Config.Labels "com.jacarium.inputs"}}' ${CONSOLE}`)));
  check('the central server logs into the container log with its prefix', /\[central\] .*Jacarium central server/.test(remote(`podman logs ${CONSOLE} 2>&1 | head -80`)));

  // ---- 2. unchanged re-run ----------------------------------------------------------
  console.log('--- unchanged re-run');
  const startBefore = startedAt();
  // (an enrollment secret turning up on an already-upgraded target - a restored backup - goes the same way, restart or not)
  remote(`printf 'synthetic-enrollment-secret' > ${stateDir}/console-data/central/keys/enrollment.secret`);
  r = deploy([]);
  check('an unchanged re-run succeeds', r.status === 0);
  check('...reports the container unchanged', /console: unchanged/.test(r.out));
  check('...and restarts nothing (start time unchanged)', startedAt() === startBefore, startedAt());
  check('...and still removes a 3.0/3.1 enrollment secret it finds (idempotent: the healthy container runs account-ticket-only)', /removed the enrollment secret/.test(r.out) && remote(`test -e ${stateDir}/console-data/central/keys/enrollment.secret || echo gone`) === 'gone', r.out.split('\n').filter((l) => /enrollment/.test(l)).join(' / '));
  r = deploy([]);
  check('...a run with no such file says nothing about it', r.status === 0 && !/enrollment/.test(r.out) && startedAt() === startBefore);
  check('...sends nothing (the target already has the image)', !/sending image/.test(r.out) && /built from these inputs/.test(r.out) && !/building the image locally/.test(r.out), r.out.split('\n').filter((l) => /inputs|building|sending/.test(l)).join(' / '));
  // a rebuilt image with the same inputs is not a change (the build cache gets
  // pruned, an archive load gives another id: the inputs label on the running
  // container is what counts); the local image gets a new id by a trivial
  // rebuild on top of itself - the inputs label is inherited
  console.log('--- re-run with a locally rebuilt image (new id, same inputs)');
  spawnSync('podman', ['build', '--format', 'docker', '-t', `localhost/jacarium:${INSTANCE}`, '-f', '-', REPO], { input: `FROM localhost/jacarium:${INSTANCE}\nLABEL test.rebuild=${Date.now()}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
  check('the local image now differs from what runs on the target', localImageId(INSTANCE) !== imageOf(CONSOLE));
  r = deploy([]);
  check('a re-run with a rebuilt image succeeds without building, sending or restarting', r.status === 0 && !/building the image locally/.test(r.out) && !/sending image/.test(r.out) && startedAt() === startBefore && /console: unchanged/.test(r.out), r.out.split('\n').filter((l) => /ERROR|building|sending|unchanged/.test(l)).join(' / '));

  // ---- 2c. the reverse proxy's CA root -----------------------------------------------
  // (the console container stands in for the proxy container: its own
  // certificate is read out of it, read-only, and served at /api/tls/root.crt)
  console.log('--- --proxy-ca-from (the proxy\'s CA root served for the desktop to pin)');
  r = deploy(['--public-url', `https://pi.console:${CONSOLE_PORT}`, '--proxy-ca-from', CONSOLE, '--proxy-ca-path', '/data/certs/cert.pem']);
  check('a run with --proxy-ca-from reads the root out of the container and says so', r.status === 0 && /reverse proxy CA root: .* from container/.test(r.out), r.out.split('\n').filter((l) => /CA root|ERROR/.test(l)).join(' / '));
  check('...the root is in the data dir and served at /api/tls/root.crt', sha(`${stateDir}/console-data/tls/root.crt`) === sha(`${stateDir}/console-data/certs/cert.pem`) && curl('/api/tls/root.crt').includes('BEGIN CERTIFICATE') && /PROXY_CA_FROM=jacarium-/.test(remote(`cat ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf`)));
  r = deploy(['--no-public-url', '--no-proxy-ca']);
  check('...--no-public-url --no-proxy-ca returns to the LAN address and stops refreshing it', r.status === 0 && !/PROXY_CA_FROM=jacarium/.test(remote(`cat ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf`)), r.out.split('\n').filter((l) => /ERROR/.test(l)).join(' / '));
  remote(`rm -f ${stateDir}/console-data/tls/root.crt`);

  // ---- 3. update with a changed image -----------------------------------------------
  console.log('--- update (changed image)');
  remote(`touch ${stateDir}/console-data/reports/synthetic-marker && echo ok`);
  const certBefore = sha(`${stateDir}/console-data/certs/cert.pem`);
  const oldImage = imageOf(CONSOLE);
  r = deploy(['--force-transfer'], { DEPLOY_TO_HOST_BUILD_ARGS: `--label test.rev=${Date.now()}` });
  check('the update succeeds', r.status === 0, r.out.split('\n').filter((l) => /ERROR|not become|ROLLED/.test(l)).join(' / '));
  check('...sent the image (forced) and restarted the container with it', /console: sending image/.test(r.out) && /console: \(re\)starting/.test(r.out) && /console: healthy/.test(r.out));
  const newImage = imageOf(CONSOLE);
  check('...the container runs the new image', newImage !== oldImage && newImage === localImageId(INSTANCE), `${oldImage.slice(0, 12)} -> ${newImage.slice(0, 12)}`);
  check('...the previous image is kept as :previous', remote(`podman image inspect --format '{{.Id}}' localhost/jacarium:previous`) === oldImage);
  check('...the data dir marker survived', remote(`test -f ${stateDir}/console-data/reports/synthetic-marker && echo yes`) === 'yes');
  check('...the certificate and the central keys were not regenerated', sha(`${stateDir}/console-data/certs/cert.pem`) === certBefore && sha(`${stateDir}/console-data/central/keys/yjs-encryption.key`) === before.yjs && sha(`${stateDir}/console-data/central/keys/account-ticket.key`) === before.ticket);
  check('...and the identity shared before the upgrade is still there', remote(`cat ${stateDir}/console-data/central/data/clients.json`).includes(ticketOld.identity));

  // ---- 4. rollback from a broken image ------------------------------------------------
  console.log('--- rollback (broken image)');
  const good = localImageId(INSTANCE);
  const broken = spawnSync('podman', ['build', '--format', 'docker', '-t', `localhost/jacarium:${INSTANCE}`, '-f', '-', REPO], { encoding: 'utf8', input: `FROM localhost/jacarium:${INSTANCE}\nENTRYPOINT ["/bin/sh","-c","echo synthetic breakage; sleep 2; exit 1"]\n` });
  const brokenId = localImageId(INSTANCE);
  check('a broken image is built locally under the deploy tag', broken.status === 0 && brokenId !== good, broken.stderr.slice(-200));
  r = deploy(['--no-build']);
  check('deploying the broken image fails', r.status !== 0);
  check('...and reports the rollback', /ROLLED BACK/.test(r.out), r.out.split('\n').filter((l) => /ROLLED|not become|failed/.test(l)).join(' / '));
  check('...the previous image is running and healthy again', imageOf(CONSOLE) === good && health(CONSOLE) === 'healthy');
  check('...the failed image is kept as :failed for inspection', remote(`podman image inspect --format '{{.Id}}' localhost/jacarium:failed`) !== '');
  // a broken image over a 3.1-style state dir: the central state must go back where it was
  console.log('--- rollback of the migration (broken image over a 3.1-style state dir)');
  // (the rollback above re-tagged the good image on the shared storage: the broken one goes back under the deploy tag)
  spawnSync('podman', ['tag', brokenId, `localhost/jacarium:${INSTANCE}`], { stdio: 'ignore' });
  remote(`systemctl --user stop ${CONSOLE}.service; mkdir -p ${stateDir}/central && mv ${stateDir}/console-data/central/data ${stateDir}/central/data && mv ${stateDir}/console-data/central/keys ${stateDir}/central/keys && echo staged`);
  r = deploy(['--no-build']);
  check('deploying a broken image over the 3.1-style state fails and says the move is undone', r.status !== 0 && /undoing the central server's move/.test(r.out) && /moved .* back to/.test(r.out), r.out.split('\n').filter((l) => /undo|back to|ERROR|ROLLED|healthy/.test(l)).join(' / ').slice(-600));
  check('...the central state is back where it was, byte for byte', sha(`${stateDir}/central/keys/yjs-encryption.key`) === before.yjs && sha(`${stateDir}/central/data/documents/synthetic-${INSTANCE}.ydoc`) === before.doc && remote(`test -e ${stateDir}/console-data/central/data || echo gone`) === 'gone');
  spawnSync('podman', ['tag', good, `localhost/jacarium:${INSTANCE}`], { stdio: 'ignore' });
  r = deploy(['--no-build']);
  check('the good image then takes the 3.1-style state in again', r.status === 0 && sha(`${stateDir}/console-data/central/data/documents/synthetic-${INSTANCE}.ydoc`) === before.doc && remote(`test -e ${stateDir}/central || echo gone`) === 'gone', r.out.split('\n').filter((l) => /ERROR|moved/.test(l)).join(' / '));

  // ---- 5. reboot survival (simulated) ---------------------------------------------------
  console.log('--- reboot survival (simulated)');
  check('lingering is enabled for the target user', remote(`loginctl show-user ${sshUser} -p Linger --value`) === 'yes');
  check('the unit is wanted by default.target', remote(`systemctl --user show -p WantedBy ${CONSOLE}.service`).includes('default.target'));
  remote(`podman kill ${CONSOLE} >/dev/null 2>&1; echo`);
  check('a killed container is brought back by its unit (Restart=always)', waitFor(() => (health(CONSOLE) === 'healthy' ? 'healthy' : ''), 90) === 'healthy', health(CONSOLE));
  // the central server killed inside the container comes back by itself (the entrypoint's supervision)
  const centralPidBefore = remote(`podman exec ${CONSOLE} cat /tmp/central.pid`);
  remote(`podman exec ${CONSOLE} sh -c 'kill -9 $(cat /tmp/central.pid)'`);
  const centralBack = waitFor(() => (/"status":"ok"/.test(curl('/central/api/health')) && remote(`podman exec ${CONSOLE} cat /tmp/central.pid`) !== centralPidBefore ? 'back' : ''), 30);
  check('the central server killed inside the container is restarted in place (the console stayed up)', centralBack === 'back' && /central server exited with status 137; restarting/.test(remote(`podman logs ${CONSOLE} 2>&1 | tail -40`)) && startedAt() !== '' && health(CONSOLE) === 'healthy');
  const stoppedThenStarted = remote(`systemctl --user stop ${CONSOLE}.service && sleep 2 && podman ps --format '{{.Names}}' | grep -c ${CONSOLE}; systemctl --user start ${CONSOLE}.service && sleep 3 && podman ps --format '{{.Names}}' | grep -c ${CONSOLE}`);
  check('systemctl --user stop/start controls the container (no fight with the deploy script)', stoppedThenStarted.replace(/\n/g, ' ') === '0 1', stoppedThenStarted);
  check('...and it becomes healthy again', waitFor(() => (health(CONSOLE) === 'healthy' ? 'healthy' : ''), 120) === 'healthy', health(CONSOLE));
  r = deploy(['status']);
  check('status shows the container running with the name URLs and the central server inside', /unit: +(enabled|generated) \/ active/.test(r.out) && /https:\/\/pi\.console:/.test(r.out) && /central: +https:\/\/pi\.console:\d+\/central\/api\/health/.test(r.out), r.out.split('\n').slice(-8).join(' / '));

  // ---- 5b. accounts from the host (the recovery path for a forgotten admin password) ----
  r = deploy(['list-users']);
  check('list-users runs the accounts CLI inside the container over SSH', r.status === 0 && /alice/.test(r.out), r.out.slice(-200));
  r = deploy(['reset-password', 'nobody']);
  check('reset-password of an unknown user is refused with the hint, creating nothing', r.status !== 0 && /no such user: nobody/.test(r.out) && /list-users/.test(r.out), r.out.slice(-200));
  r = deploy(['reset-password']);
  check('reset-password without a username is refused locally', r.status !== 0 && /needs a username/.test(r.out), r.out.slice(-160));

  // ---- 5c. desktop installers published to the data volume (not the image) ----
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-desktop-'));
  fs.writeFileSync(path.join(dlDir, 'Jacarium-9.9.9-arm64.dmg'), Buffer.from('synthetic dmg bytes '.repeat(50)));
  fs.writeFileSync(path.join(dlDir, 'Jacarium-9.9.9-arm64-mac.zip'), Buffer.from('synthetic zip bytes '.repeat(50)));
  fs.writeFileSync(path.join(dlDir, 'Jacarium-9.9.9-arm64.dmg.blockmap'), 'ignored');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const srcName = `jacarium-${pkgVersion}-src.tar.gz`;
  const tagged = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/v${pkgVersion}`], { cwd: REPO }).status === 0;
  r = deploy(['publish-desktop', '--from', dlDir]);
  const expectedFiles = tagged ? 3 : 2;
  check('publish-desktop copies the installers (and the source archive when the release is tagged) to the target\'s data volume with a manifest', r.status === 0 && new RegExp(`${expectedFiles} file\\(s\\), ${expectedFiles} sent, 0 unchanged`).test(r.out) && (tagged ? new RegExp(`source archive: ${srcName}`).test(r.out) : /not published/.test(r.out)), r.out.slice(-300));
  const remoteList = remote(`ls ${stateDir}/console-data/downloads`);
  check('...only the installers, the source archive and the manifest are there (no .blockmap)', remoteList.split('\n').sort().join(',') === ['Jacarium-9.9.9-arm64-mac.zip', 'Jacarium-9.9.9-arm64.dmg', 'manifest.json', ...(tagged ? [srcName] : [])].sort().join(','), remoteList);
  const served = curl('/api/downloads/manifest.json');
  check('the console lists them (version, size, sha256) without a sign-in', /"Jacarium-9\.9\.9-arm64\.dmg"/.test(served) && /"version": ?"9\.9\.9"/.test(served) && /"sha256": ?"[0-9a-f]{64}"/.test(served), served.slice(0, 200));
  r = deploy(['publish-desktop', '--from', dlDir]);
  check('publishing the same files again sends nothing', r.status === 0 && new RegExp(`0 sent, ${expectedFiles} unchanged`).test(r.out), r.out.slice(-200));
  fs.rmSync(dlDir, { recursive: true, force: true });

  // ---- 6. uninstall ------------------------------------------------------------------------
  console.log('--- uninstall');
  r = deploy(['uninstall']);
  check('uninstall removes the container and the unit', r.status === 0 && remote(`podman ps -a --format '{{.Names}}' | grep -c ${INSTANCE}`) === '0' && remote(`ls ~/.config/containers/systemd/ | grep -c ${INSTANCE}`) === '0');
  check('...but keeps the state (the central server\'s included)', remote(`test -f ${stateDir}/console-data/central/keys/yjs-encryption.key && test -f ${stateDir}/console-data/reports/synthetic-marker && echo kept`) === 'kept');
  r = deploy(['uninstall', '--purge']);
  check('uninstall --purge removes the state and the config', remote(`test -e ${stateDir} || test -e ~/.config/jacarium/deploy-to-host.${INSTANCE}.conf || echo gone`) === 'gone');
} catch (error) {
  check('the run completed', false, error.stack || error.message);
} finally {
  cleanup();
}

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
