#!/usr/bin/env node
/**
 * deploy/deploy-to-host.sh and the local Podman machine (macOS / Windows,
 * where podman runs in a VM): before building locally the script must
 * check that podman answers, start the machine when it is not running and
 * wait for it, say what it did, and fall back to building on the target
 * when there is no machine or it does not come up. The warning about a
 * cross-architecture build must be one readable line, not `podman info`'s
 * output pasted into a sentence.
 *
 * Nothing real is touched: `podman` and `ssh` are stubs on PATH (they log
 * their calls; the ssh stub answers the target probe with a synthetic
 * Fedora/arm64 target and succeeds at everything else), HOME is a scratch
 * directory and the "target" is a TEST-NET address that is never contacted.
 *
 * Run: node tests/deploy-podman-machine.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'deploy', 'deploy-to-host.sh');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

const PODMAN_STUB = `#!/bin/bash
# a stand-in for podman: records every call, answers from the scenario in the environment
STATE="$STUB_STATE"
printf '%s\\n' "$*" >> "$STATE/podman.calls"
fmt() { for a in "$@"; do case "$prev" in --format) printf '%s' "$a"; return ;; esac; prev="$a"; done; }
FMT="$(fmt "$@")"
case "$1 $2" in
  "info "|"info --format")
    if [ -f "$STATE/up" ]; then
      case "$FMT" in *Host.Arch*) echo "\${PODMAN_HOST_ARCH:-arm64}" ;; *) echo "host:"; echo "  arch: \${PODMAN_HOST_ARCH:-arm64}" ;; esac
      exit 0
    fi
    # what the real client prints with the machine down: its own section on stdout, the error on stderr
    printf 'OS: darwin/arm64\\nprovider: applehv\\nversion: 5.3.1\\n'
    echo "Cannot connect to Podman. Please verify your connection to the Linux system using \\\`podman system connection list\\\`, or try \\\`podman machine init\\\` and \\\`podman machine start\\\` to manage a new Linux VM" >&2
    echo "Error: unable to connect to Podman socket: failed to connect: dial tcp 127.0.0.1:49900: connect: connection refused" >&2
    exit 125 ;;
  "machine list")
    [ "\${STUB_MACHINES:-one}" = none ] && exit 0
    running=false; [ -f "$STATE/up" ] && running=true
    case "$FMT" in *Running*) echo "podman-machine-default $running" ;; *Default*) echo "podman-machine-default true" ;; *) echo "podman-machine-default" ;; esac
    exit 0 ;;
  "machine start")
    [ -n "\${STUB_START_FAILS:-}" ] && { echo "Error: unable to start" >&2; exit 125; }
    [ -n "\${STUB_NEVER_UP:-}" ] || touch "$STATE/up"
    exit 0 ;;
  "machine inspect") echo applehv; exit 0 ;;
  "system connection") printf 'podman-machine-default-root true\\npodman-machine-default false\\n'; exit 0 ;;
  "version "|"version --format") echo 5.3.1; exit 0 ;;
  "build "*|"build --format") exit 0 ;;
  "image inspect")
    # the built image's architecture: the target's (arm64 in every scenario here), what a real --platform build
    # yields on either machine; PODMAN_BUILT_ARCH overrides it to exercise the script's architecture check
    case "$FMT" in *Id*) echo sha256:aaa111aaa111 ;; *Layers*) echo "sha256:l1,sha256:l2," ;; *Size*) echo 1048576 ;; *Architecture*) echo "\${PODMAN_BUILT_ARCH:-arm64}" ;; *) echo "" ;; esac
    exit 0 ;;
  "save "*|"save --format") printf 'tar'; exit 0 ;;
  *) exit 0 ;;
esac
`;
const SSH_STUB = `#!/bin/bash
# a stand-in for ssh: never contacts anything; answers the target probe, swallows its stdin, succeeds
STATE="$STUB_STATE"
printf '%s\\n' "$*" >> "$STATE/ssh.calls"
case "$*" in
  *"remote-host.sh probe"*)
    cat <<'EOF'
arch=aarch64
os_name=Fedora Linux 41
os_id=fedora
os_like=
podman=5.2.2
quadlet=yes
mem_total_mb=4096
disk_free_mb=20000
docker=
docker_ok=
docker_enabled=
systemd_user=running
linger=yes
user=deploy
hostname=pi
ipv4=192.0.2.10
conf_exists=no
console_container=
console_inputs=
console_src_id=
legacy_central=no
listening_8443=no
EOF
    exit 0 ;;
  *"image inspect"*"Layers"*) [ -t 0 ] || cat >/dev/null; printf 'sha256:l1,sha256:l2,' | shasum -a 256 | cut -c1-32; exit 0 ;;
  *"image inspect"*) [ -t 0 ] || cat >/dev/null; echo sha256:bbb222bbb222; exit 0 ;;
  *) [ -t 0 ] || cat >/dev/null; echo ok; exit 0 ;;
esac
`;

function run(scenario = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-podman-machine-'));
  const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const home = path.join(dir, 'home');
  fs.mkdirSync(bin); fs.mkdirSync(state); fs.mkdirSync(home);
  if (scenario.podman !== false) fs.writeFileSync(path.join(bin, 'podman'), PODMAN_STUB, { mode: 0o755 });
  if (scenario.docker) fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), SSH_STUB, { mode: 0o755 });
  if (scenario.up) fs.writeFileSync(path.join(state, 'up'), '');
  // (PATH: the stubs first, then only the system directories - never the real podman)
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, STUB_STATE: state, DEPLOY_HOST_OS: scenario.hostOs || 'Darwin', PODMAN_MACHINE_START_TIMEOUT: String(scenario.timeout ?? 20), ...(scenario.env || {}) };
  const r = spawnSync('bash', [SCRIPT, 'deploy@192.0.2.10', '--name', 'pi.test', '--address', '192.0.2.10', '--tag', 'stub', '--yes', ...args], { cwd: REPO, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const calls = (f) => (fs.existsSync(path.join(state, f)) ? fs.readFileSync(path.join(state, f), 'utf8').split('\n').filter(Boolean) : []);
  const out = strip(r.stdout) + strip(r.stderr);
  const podman = calls('podman.calls'); const ssh = calls('ssh.calls');
  if (process.env.SHOW) console.log(`--- exit ${r.status}
${out}
--- podman: ${podman.join(" | ")}
--- ssh: ${ssh.map((c) => c.slice(0, 80)).join(" | ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out, podman, ssh };
}
const builtOnTarget = (r) => r.ssh.some((c) => /deploy\/Containerfile/.test(c));
const builtHere = (r) => r.podman.some((c) => /^build /.test(c));

// ---- 1. the machine is down: started, awaited, the build runs here --------------
let r = run();
check('1. a stopped machine is started (the one the default connection points at, "-root" stripped) and the script says so', r.podman.filter((c) => c === 'machine start podman-machine-default').length === 1 && /machine 'podman-machine-default' is not running: starting it/.test(r.out) && /started \(\d+s\); it stays running/.test(r.out), r.out.split('\n').filter((l) => /machine|podman/i.test(l)).join(' / '));
check('1. ...then the image is built here, not on the target, and the deploy completes', builtHere(r) && !builtOnTarget(r) && r.status === 0, `exit ${r.status}; builds here: ${builtHere(r)}, on target: ${builtOnTarget(r)}`);
check('1. the machine is not stopped afterwards', !r.podman.some((c) => /^machine stop/.test(c)));
check("1. same architecture (the machine builds arm64, the target needs arm64): no emulation warning, but the target's platform is still named on the build and the built image's architecture checked", !/emulated/.test(r.out) && r.podman.some((c) => /^build --platform linux\/arm64 /.test(c)) && /built a arm64 image for/.test(r.out), r.podman.filter((c) => /^build/.test(c)).join(' / ') + ' | ' + r.out.split('\n').filter((l) => /image for|is a/.test(l)).join(' / '));
// the architecture check itself: an image that came out as the other architecture stops the deploy before anything is sent
{
  const bad = run({ up: true, env: { PODMAN_BUILT_ARCH: 'amd64' } });
  check("1. a built image of the wrong architecture is refused before anything is sent (exec format error at the target otherwise)", bad.status !== 0 && /is amd64, the target .* needs arm64/.test(bad.out) && !bad.podman.some((c) => /^save/.test(c)) && !/applying on/.test(bad.out), `exit ${bad.status}; ${bad.out.split('\n').filter((l) => /amd64|arm64/.test(l)).join(' / ').slice(0, 300)}`);
}

// ---- 2. the cross-architecture warning is one readable line -----------------------
r = run({ env: { PODMAN_HOST_ARCH: 'amd64' } });
const warn = r.out.split('\n').find((l) => /emulated/.test(l)) || '';
check('2. a machine that builds amd64 for an arm64 target warns in ONE line naming the machine, Podman and its provider', warn === '[WARN] this machine (darwin/arm64, Podman 5.3.1 via applehv) builds amd64 images; the target needs arm64: building with --platform linux/arm64 (emulated, slower)', warn);
check('2. ...and builds with --platform linux/arm64', r.podman.some((c) => /^build .*--platform linux\/arm64/.test(c)));
check('2. nothing of `podman info` leaks into the messages (OS:/provider:/version: lines)', !/^(OS|provider|version):/m.test(r.out));

// ---- 3. podman already answers: no start, a note, the build runs -----------------
r = run({ up: true });
check('3. a running machine is left alone (no `machine start`), the script notes podman is reachable', !r.podman.some((c) => /^machine start/.test(c)) && /podman is reachable here \(the machine was already running\)/.test(r.out) && builtHere(r) && r.status === 0, r.out.split('\n').filter((l) => /reachable|machine/.test(l)).join(' / '));

// ---- 4. no machine at all: how to make one, then the target builds ---------------
r = run({ env: { STUB_MACHINES: 'none' } });
check('4. without a machine the script says how to create one (podman machine init / start) and builds on the target', /podman machine init/.test(r.out) && /building on deploy@192\.0\.2\.10 instead/.test(r.out) && !r.podman.some((c) => /^machine start/.test(c)) && builtOnTarget(r) && !builtHere(r) && r.status === 0, r.out.split('\n').filter((l) => /machine|instead/.test(l)).join(' / '));

// ---- 5. the machine starts but podman never answers: a timeout, then the target ----
r = run({ env: { STUB_NEVER_UP: '1' }, timeout: 3 });
check('5. a machine that does not come up within the timeout is reported and the target builds instead', /did not answer within 3s/.test(r.out) && builtOnTarget(r) && !builtHere(r) && r.status === 0, r.out.split('\n').filter((l) => /machine|instead/.test(l)).join(' / '));
r = run({ env: { STUB_START_FAILS: '1' } });
check('5. a failing `podman machine start` is reported and the target builds instead', /'podman machine start podman-machine-default' failed/.test(r.out) && builtOnTarget(r) && r.status === 0, r.out.split('\n').filter((l) => /machine|instead/.test(l)).join(' / '));

// ---- 6. no podman here (Docker Desktop or not): a message, the target builds -------
r = run({ podman: false, docker: true });
check('6. with Docker but no podman: says the script does not build with Docker, how to install podman, and builds on the target', /does not build with Docker/.test(r.out) && /brew install podman/.test(r.out) && builtOnTarget(r) && r.status === 0, r.out.split('\n').filter((l) => /podman|Docker|instead/.test(l)).join(' / '));
r = run({ podman: false });
check('6. without podman or Docker: builds on the target', /podman is not installed here/.test(r.out) && builtOnTarget(r) && r.status === 0);

// ---- 7. Linux has no machine: an unreachable podman is an error, no `machine start` ----
r = run({ hostOs: 'Linux' });
check('7. on Linux an unreachable podman is reported as such (no machine to start) and the target builds', /does not answer \(podman info failed\)/.test(r.out) && !r.podman.some((c) => /^machine/.test(c)) && builtOnTarget(r), r.out.split('\n').filter((l) => /podman|instead/.test(l)).join(' / '));

// ---- 8. --no-build needs the local podman: no machine means an error, not a target build ----
r = run({ env: { STUB_MACHINES: 'none' } }, ['--no-build']);
check('8. --no-build without a reachable podman fails with a clear message instead of building on the target', r.status !== 0 && /--no-build needs a local image/.test(r.out) && !builtOnTarget(r), `exit ${r.status}`);

// ---- 9. --build-on-target never looks at the local podman ------------------------
r = run({}, ['--build-on-target']);
check('9. --build-on-target does not touch the local podman (no info, no machine start)', !r.podman.some((c) => /^(info|machine)/.test(c)) && builtOnTarget(r) && r.status === 0, r.podman.join(' / '));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
