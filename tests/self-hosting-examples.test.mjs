/**
 * The two self-hosting examples in docs/SELF_HOSTING.md - the Quadlet
 * `.container` unit and the pod file for `podman kube play` - must not drift
 * from the deployment they describe:
 *
 *   - static (always): both pin the image by digest
 *     (quay.io/zerodayz/jacarium@sha256:...); the container port, the /data
 *     mount, the default JACARIUM_AUTH_MODE, the user id and the health
 *     check agree with deploy/Containerfile and deploy/deploy-podman.sh (the
 *     published address and port are the script's defaults); nothing in
 *     them is a secret, a host path or a machine name; the Quadlet unit has
 *     the restart policy and WantedBy the deploy script's own unit has
 *     (deploy/remote-host.sh);
 *   - live, when the tooling is there (SKIP otherwise): the unit passes
 *     `quadlet -dryrun` (the binary on this machine, or inside the podman
 *     machine), and the pod file plays with podman - a local jacarium image
 *     in place of the digest, port 8081, scratch names - until its health
 *     check answers, then everything is taken down, the volume included.
 * Run: node tests/self-hosting-examples.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

// ---------------------------------------------------------------------------
// the examples, out of the doc; the deployment, out of its sources
// ---------------------------------------------------------------------------
const doc = read('docs/SELF_HOSTING.md');
const blocks = [...doc.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], text: m[2] }));
const unit = (blocks.find((b) => b.lang === 'ini' && /\[Container\]/.test(b.text) && /@sha256:/.test(b.text)) || {}).text || '';
const yaml = (blocks.find((b) => b.lang === 'yaml' && /kind: Pod/.test(b.text)) || {}).text || '';
check('docs/SELF_HOSTING.md has the Quadlet unit (an ini block with [Container] and a digest) and the pod file (a yaml block with kind: Pod)', unit.length > 0 && yaml.length > 0);

const containerfile = read('deploy/Containerfile');
const deployScript = read('deploy/deploy-podman.sh');
const remoteHost = read('deploy/remote-host.sh');
const want = {
  user: (/^USER (\d+)/m.exec(containerfile) || [])[1],
  port: (/^EXPOSE (\d+)/m.exec(containerfile) || [])[1],
  volume: (/^VOLUME \["([^"]+)"\]/m.exec(containerfile) || [])[1],
  authMode: (/^\s*JACARIUM_AUTH_MODE=(\w+)/m.exec(containerfile) || [])[1],
  health: (/^HEALTHCHECK[\s\S]*?CMD ([\s\S]*?)\n\n/m.exec(containerfile) || [])[1] || '',
  bind: (/^BIND_ADDRESS="\$\{BIND_ADDRESS:-([^}]+)\}"/m.exec(deployScript) || [])[1],
  hostPort: (/^PORT="\$\{PORT:-(\d+)\}"/m.exec(deployScript) || [])[1],
  publish: (/-p "\$\{BIND_ADDRESS\}:\$\{PORT\}:(\d+)"/.exec(deployScript) || [])[1],
  mount: (/-v "\$\{DATA_DIR\}:([^:"]+)/.exec(deployScript) || [])[1],
  env: (/-e "(JACARIUM_AUTH_MODE)=\$AUTH_MODE"/.exec(deployScript) || [])[1],
};
check('the sources give every fact (Containerfile: USER, EXPOSE, VOLUME, JACARIUM_AUTH_MODE, HEALTHCHECK; deploy-podman.sh: the address, port, publish, mount, env)', Object.values(want).every((v) => v), JSON.stringify(want));
check('deploy-podman.sh publishes the port the image exposes and mounts the volume the image declares', want.publish === want.port && want.mount === want.volume, `${want.publish} vs ${want.port}, ${want.mount} vs ${want.volume}`);
// the health check's two URLs (the console and the central server behind it) and the marker file
const healthParts = [...want.health.matchAll(/https:\/\/127\.0\.0\.1:\$\{HTTPS_PORT\}(\/[^"\s]*)/g)].map((m) => m[1]);
const marker = (/\[ ! -f (\S+) \]/.exec(want.health) || [])[1];
check('the Containerfile HEALTHCHECK checks /health and /central/api/health behind a marker file', healthParts.includes('/health') && healthParts.includes('/central/api/health') && !!marker, JSON.stringify({ healthParts, marker }));

const DIGEST = /quay\.io\/zerodayz\/jacarium@sha256:<[^>]+>/;
const unitField = (name) => (new RegExp(`^${name}=(.*)$`, 'm').exec(unit) || [])[1];
const noSecret = (text) => !/(KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*=(?!<)[^\s,<]{8,}/.test(text) && !/(?:api|ticket)[-_ ]?key\s*[:=]\s*[A-Za-z0-9+/]{16,}/i.test(text);
const noHostBits = (text) => !/\/Users\/|\/home\/[a-z]|\/var\/folders|\.local\b|\.internal\b|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\.)/.test(text.replace(/127\.0\.0\.1|192\.168\.1\.20/g, ''));

// ---------------------------------------------------------------------------
// the Quadlet unit against the deployment and the unit deploy-to-host.sh writes
// ---------------------------------------------------------------------------
{
  check('Quadlet: Image= is the release pinned by digest, with a placeholder', DIGEST.test(unitField('Image') || ''), unitField('Image'));
  check(`Quadlet: PublishPort= is deploy-podman.sh's default address and port onto the image's port (${want.bind}:${want.hostPort}:${want.port})`, unitField('PublishPort') === `${want.bind}:${want.hostPort}:${want.port}`, unitField('PublishPort'));
  check(`Quadlet: Volume= is a named volume on ${want.volume}`, /^[a-z][a-z0-9-]*:\/data$/.test(unitField('Volume') || '') && (unitField('Volume') || '').endsWith(`:${want.volume}`), unitField('Volume'));
  check(`Quadlet: Environment=${want.env}=${want.authMode}, the image's default and the script's env`, unitField('Environment') === `${want.env}=${want.authMode}`, unitField('Environment'));
  check(`Quadlet: the UserNS line names the image's user (${want.user})`, new RegExp(`UserNS=keep-id:uid=${want.user},gid=0`).test(unit));
  const remoteUnit = (/\[Container\]\nContainerName=\$name\nImage=\$image\nPull=never\nUserNS=keep-id:uid=(\d+),gid=0/.exec(remoteHost) || [])[1];
  check('deploy/remote-host.sh maps the same user id in its own unit', remoteUnit === want.user, `${remoteUnit} vs ${want.user}`);
  for (const line of ['Restart=always', 'RestartSec=5', 'TimeoutStartSec=600', 'WantedBy=default.target', 'After=network-online.target', 'Wants=network-online.target']) {
    check(`Quadlet: ${line}, as in the unit deploy-to-host.sh writes`, unit.includes(`\n${line}\n`) && remoteHost.includes(`\n${line}\n`));
  }
  check('Quadlet: ContainerName and HostName are jacarium (the sync identity; the quick start uses the same)', unitField('ContainerName') === 'jacarium' && unitField('HostName') === 'jacarium');
  check('Quadlet: no HealthCmd (the image health check is inherited) and no AutoUpdate with a digest pin', !/^HealthCmd=/m.test(unit) && !/^AutoUpdate=/m.test(unit) && !/^Label=io\.containers\.autoupdate/m.test(unit));
  check('Quadlet: no secret value, no host path, no machine name', noSecret(unit) && noHostBits(unit));
  const lines = unit.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  check(`Quadlet: a short unit (${lines.length} lines without comments, 15-25)`, lines.length >= 15 && lines.length <= 25);
  check('the doc says how to get and verify the digest with the README\'s commands', /gh attestation verify oci:\/\/quay\.io\/zerodayz\/jacarium:X\.Y\.Z/.test(doc) && /cosign verify quay\.io\/zerodayz\/jacarium:X\.Y\.Z/.test(doc) && /docker-manifest-digest/.test(doc));
  check('the doc gives the install steps (the directory, daemon-reload, start, status, logs, linger)', /~\/\.config\/containers\/systemd/.test(doc) && /systemctl --user daemon-reload/.test(doc) && /systemctl --user start jacarium\.service/.test(doc) && /systemctl --user status jacarium\.service/.test(doc) && /journalctl --user -u jacarium\.service/.test(doc) && /loginctl enable-linger/.test(doc));
  check('the doc says where secrets go (podman secret / Secret=) and what AutoUpdate=registry needs (a tag)', /podman secret create/.test(doc) && /Secret=<name>,type=env/.test(doc) && /AutoUpdate=registry/.test(doc) && /must be a tag/.test(doc));
}

// ---------------------------------------------------------------------------
// the pod file against the deployment
// ---------------------------------------------------------------------------
{
  const y = (re) => (re.exec(yaml) || [])[1];
  check('pod file: image is the release pinned by digest, with a placeholder', DIGEST.test(y(/^\s+image: (.+)$/m) || ''), y(/^\s+image: (.+)$/m));
  check(`pod file: containerPort ${want.port}, published on ${want.bind}:${want.hostPort} like the script's default`, y(/containerPort: (\d+)/) === want.port && y(/hostIP: (\S+)/) === want.bind && y(/hostPort: (\d+)/) === want.hostPort, `${y(/containerPort: (\d+)/)} ${y(/hostIP: (\S+)/)}:${y(/hostPort: (\d+)/)}`);
  check(`pod file: the volume is a persistentVolumeClaim mounted at ${want.volume}, no hostPath`, y(/mountPath: (\S+)/) === want.volume && /persistentVolumeClaim:/.test(yaml) && /kind: PersistentVolumeClaim/.test(yaml) && !/hostPath/.test(yaml));
  check(`pod file: runs as the image's user (${want.user}), non-root, every capability dropped, no privilege escalation`, y(/runAsUser: (\d+)/) === want.user && /runAsNonRoot: true/.test(yaml) && /drop: \[ALL\]/.test(yaml) && /allowPrivilegeEscalation: false/.test(yaml));
  check(`pod file: ${want.env}=${want.authMode}`, new RegExp(`- name: ${want.env}\\n\\s+value: ${want.authMode}`).test(yaml));
  const liveness = y(/livenessProbe:\n\s+exec:\n\s+command: \[.*?"((?:[^"\\]|\\.)*)"\]/);
  check('pod file: the liveness probe is the image HEALTHCHECK (both URLs, the marker file, the container port)', !!liveness && healthParts.every((p) => liveness.includes(`https://127.0.0.1:${want.port}${p}`)) && liveness.includes(`[ ! -f ${marker} ]`), liveness);
  check('pod file: a readiness probe on /health, resource requests and limits', /readinessProbe:/.test(yaml) && /resources:\n\s+requests:/.test(yaml) && /limits:/.test(yaml));
  check('pod file: hostname jacarium, no secret value, no host path, no machine name', y(/^\s+hostname: (\S+)/m) === 'jacarium' && noSecret(yaml) && noHostBits(yaml));
  check('the doc gives podman kube play / --replace / down / down --force and the Kubernetes caveat (Deployment, Service or Ingress, the certificate, fsGroup)', /podman kube play jacarium\.yaml/.test(doc) && /podman kube play --replace/.test(doc) && /podman kube down --force jacarium\.yaml/.test(doc) && /`Deployment`/.test(doc) && /`Service` or an Ingress/.test(doc) && /\/data\/certs/.test(doc) && /fsGroup: 0` needs/.test(doc));
}

// ---------------------------------------------------------------------------
// live: quadlet -dryrun, and the pod file played with podman (SKIP without the tooling)
// ---------------------------------------------------------------------------
const podman = sh('podman', ['--version']).status === 0;
if (!podman) console.log('SKIP: podman is not installed - the quadlet dry run and the kube play are skipped');
else {
  // quadlet: the binary here, or inside the podman machine (macOS)
  const local = ['/usr/libexec/podman/quadlet', '/usr/lib/podman/quadlet', '/usr/lib/systemd/user-generators/podman-user-generator'].find((p) => fs.existsSync(p));
  let dry = null;
  if (local) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-quadlet-'));
    fs.writeFileSync(path.join(dir, 'jacarium.container'), unit);
    dry = sh(local, ['-dryrun', '-user'], { env: { ...process.env, QUADLET_UNIT_DIRS: dir } });
    fs.rmSync(dir, { recursive: true, force: true });
  } else if (sh('podman', ['machine', 'ssh', 'test -x /usr/libexec/podman/quadlet']).status === 0) {
    const dir = `/tmp/jacarium-quadlet-${process.pid}`;
    dry = sh('podman', ['machine', 'ssh', `mkdir -p ${dir} && cat > ${dir}/jacarium.container && QUADLET_UNIT_DIRS=${dir} /usr/libexec/podman/quadlet -dryrun -user; s=$?; rm -rf ${dir}; exit $s`], { input: unit });
  }
  if (!dry) console.log('SKIP: no quadlet binary here or in the podman machine - the dry run is skipped');
  else check('quadlet -dryrun accepts the unit and generates jacarium.service with the image, port and volume', dry.status === 0 && /jacarium\.service/.test(dry.stdout) && /quay\.io\/zerodayz\/jacarium@sha256:/.test(dry.stdout) && /--publish 127\.0\.0\.1:8443:8443|-p 127\.0\.0\.1:8443:8443/.test(dry.stdout) && /jacarium-data:\/data/.test(dry.stdout), (dry.stderr || dry.stdout || '').slice(-300));

  // kube play: a local jacarium image stands in for the digest; scratch names; port 8081
  const images = sh('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}']).stdout.split('\n').filter((l) => /^localhost\/jacarium:\d/.test(l)).sort().reverse();
  const PORT = 8081;
  if (!images.length) console.log('SKIP: no local jacarium image (localhost/jacarium:<version>) to play the pod file with');
  else if (!(await portFree(PORT))) console.log(`SKIP: port ${PORT} is busy - the kube play is skipped`);
  else {
    const image = images[0];
    const name = `jacarium-example-test-${process.pid}`;
    const played = yaml
      .replace(/quay\.io\/zerodayz\/jacarium@sha256:<[^>]+>/, image)
      .replace(/hostPort: \d+/, `hostPort: ${PORT}`)
      .replace(/name: jacarium-data/g, `name: ${name}-data`).replace(/claimName: jacarium-data/, `claimName: ${name}-data`)
      .replace(/^  name: jacarium$/m, `  name: ${name}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-kube-'));
    const file = path.join(dir, 'jacarium.yaml');
    fs.writeFileSync(file, played);
    const down = () => { sh('podman', ['kube', 'down', '--force', file]); sh('podman', ['pod', 'rm', '-f', name]); sh('podman', ['volume', 'rm', '-f', `${name}-data`]); };
    try {
      const play = sh('podman', ['kube', 'play', file], { timeout: 180000 });
      check(`podman kube play accepts the pod file (image ${image}, port ${PORT})`, play.status === 0, (play.stderr || '').slice(-300));
      let healthy = false, central = false, status = '';
      for (let i = 0; i < 36 && !(healthy && central); i++) {
        await sleep(2500);
        healthy = sh('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', `https://127.0.0.1:${PORT}/health`]).stdout === '200';
        central = sh('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', `https://127.0.0.1:${PORT}/central/api/health`]).stdout === '200';
      }
      status = sh('podman', ['ps', '--filter', `name=${name}-jacarium`, '--format', '{{.Status}}']).stdout.trim();
      check('the played pod answers /health and /central/api/health on the published port', healthy && central, `health ${healthy}, central ${central}, status ${status}`);
      const uid = sh('podman', ['exec', `${name}-jacarium`, 'id', '-u']).stdout.trim();
      check(`the container runs as uid ${want.user} on the claim's volume`, uid === want.user && sh('podman', ['volume', 'exists', `${name}-data`]).status === 0, `uid ${uid}`);
      for (let i = 0; i < 20 && !/healthy/.test(status); i++) { await sleep(3000); status = sh('podman', ['ps', '--filter', `name=${name}-jacarium`, '--format', '{{.Status}}']).stdout.trim(); }
      check('the liveness probe passes (podman reports the container healthy)', /\(healthy\)/.test(status), status);
    } finally {
      down();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const left = sh('podman', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']).stdout.trim();
    const volLeft = sh('podman', ['volume', 'exists', `${name}-data`]).status === 0;
    check('everything the play created is removed (the pod, its containers, the volume)', !left && !volLeft, `${left} ${volLeft ? 'volume left' : ''}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
