// Desktop profiles: several separate sets of data in one installation.
//
// A profile is a directory. The "default" profile is Electron's own
// userData directory (~/.config/jacarium on Linux, ~/Library/
// Application Support/Jacarium on macOS) - exactly what a single-
// user installation used before profiles existed, so nothing moves. Every
// other profile lives at ~/.config/jacarium-<name> (the directory
// the old INSTANCE_NAME environment variable pointed at, so those keep
// working as profiles of the same name) and holds:
//
//   <dir>/                 Electron userData: IndexedDB, localStorage,
//                          ui-settings.json, central-server-cert-pins.json
//   <dir>/profile.json     { displayName, createdAt, lastUsedAt }
//   <dir>/backend/         the backend's home for this profile - the same
//                          layout a home directory has (.jacarium.env,
//                          .taskrc, .task/, .ssh/known_hosts, .jacarium/
//                          vector_db, the calendar token), passed to the
//                          backend as JACARIUM_PROFILE_HOME
//
// The default profile keeps the real home for all of that (unchanged
// behaviour). On a named profile's first run the settings file and
// known_hosts of the real home are COPIED in (never moved), so a new
// profile starts with the same integrations.
//
// Choosing: `--profile <name>` (or INSTANCE_NAME=<name>) picks one;
// `--profile-picker` always asks; otherwise, with one profile the app opens
// it directly (a single-user desktop never sees a picker), with several it
// opens the remembered one (profiles.json: defaultProfile) or asks.
//
// Every profile gets its own cloud-sync identity: the OS username plus
// "+<name>" (user+work@host), so two profiles on one machine can both
// pair with the central server. The default profile stays user@host.
//
// No Electron imports: unit-tested with plain Node (tests/electron-profiles.test.mjs).

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_PROFILE = 'default';
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const RESERVED_NAMES = new Set(['default', 'picker', 'server']);
const DIR_PREFIX = 'jacarium-';
const SETTINGS_FILE = 'jacarium-profiles.json';
const META_FILE = 'profile.json';

/** Where named profiles live: ~/.config (JACARIUM_PROFILES_ROOT for tests). */
function profilesRoot(env = process.env, homedir = os.homedir()) {
  return env.JACARIUM_PROFILES_ROOT ? path.resolve(env.JACARIUM_PROFILES_ROOT) : path.join(homedir, '.config');
}

/** Where the default profile's backend files come from (the real home; tests redirect it). */
function seedHome(env = process.env, homedir = os.homedir()) {
  return env.JACARIUM_PROFILE_SEED_HOME ? path.resolve(env.JACARIUM_PROFILE_SEED_HOME) : homedir;
}

function validateProfileName(name) {
  if (typeof name !== 'string') return { ok: false, error: 'Profile name must be text' };
  const value = name.trim().toLowerCase();
  if (!PROFILE_NAME_RE.test(value)) {
    return { ok: false, error: 'Profile name: 1-32 characters, letters, digits, ".", "_" and "-", starting with a letter or digit' };
  }
  if (RESERVED_NAMES.has(value)) return { ok: false, error: `"${value}" is reserved` };
  return { ok: true, value };
}

/** The directory of a profile. `defaultDir` is Electron's userData for the default one. */
function profileDir(root, name, defaultDir) {
  if (name === DEFAULT_PROFILE) return defaultDir;
  return path.join(root, DIR_PREFIX + name);
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readProfileMeta(dir) {
  return readJson(path.join(dir, META_FILE));
}

function writeProfileMeta(dir, partial) {
  const merged = { ...readProfileMeta(dir), ...partial };
  writeJson(path.join(dir, META_FILE), merged);
  return merged;
}

/** { defaultProfile: name | null } - the picker's "always open this profile". */
function readProfilesSettings(root) {
  return readJson(path.join(root, SETTINGS_FILE));
}

function writeProfilesSettings(root, partial) {
  const merged = { ...readProfilesSettings(root), ...partial };
  writeJson(path.join(root, SETTINGS_FILE), merged);
  return merged;
}

/**
 * Every profile: the default one (always listed, even before its directory
 * exists) first, then the named ones under `root`, sorted by name.
 * Each: { name, dir, isDefault, displayName, createdAt, lastUsedAt, exists }.
 */
function listProfiles(root, defaultDir) {
  const profiles = [];
  const defaultMeta = readProfileMeta(defaultDir);
  profiles.push({
    name: DEFAULT_PROFILE, dir: defaultDir, isDefault: true,
    displayName: defaultMeta.displayName || 'Default',
    createdAt: defaultMeta.createdAt || null, lastUsedAt: defaultMeta.lastUsedAt || null,
    exists: fs.existsSync(defaultDir),
  });
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const named = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIR_PREFIX)) continue;
    const name = entry.name.slice(DIR_PREFIX.length);
    if (!validateProfileName(name).ok) continue;
    const dir = path.join(root, entry.name);
    if (path.resolve(dir) === path.resolve(defaultDir)) continue;
    const meta = readProfileMeta(dir);
    named.push({
      name, dir, isDefault: false,
      displayName: meta.displayName || name,
      createdAt: meta.createdAt || null, lastUsedAt: meta.lastUsedAt || null,
      exists: true,
    });
  }
  named.sort((a, b) => a.name.localeCompare(b.name));
  return profiles.concat(named);
}

/** argv without any --profile / --profile=<name> / --profile-picker (for a relaunch). */
function stripProfileArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile-picker' || arg.startsWith('--profile=')) continue;
    if (arg === '--profile') { i++; continue; }
    out.push(arg);
  }
  return out;
}

/** Parse --profile <name> / --profile=<name> / --profile-picker from argv. */
function profileArgs(argv) {
  const result = { name: null, picker: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile-picker') result.picker = true;
    else if (arg === '--profile' && i + 1 < argv.length) result.name = argv[++i];
    else if (arg.startsWith('--profile=')) result.name = arg.slice('--profile='.length);
  }
  return result;
}

/**
 * Which profile to open: { name } or { ask: true }, plus `reason`.
 *   --profile-picker              ask
 *   --profile X / INSTANCE_NAME=X that one (created if missing; "default"
 *                                 names the default profile)
 *   one profile in total          it, without asking
 *   several + remembered choice   the remembered one
 *   several, nothing remembered   ask
 */
function resolveProfileSelection({ argv = [], env = {}, profiles = [], settings = {} }) {
  const args = profileArgs(argv);
  if (args.picker) return { ask: true, reason: '--profile-picker' };
  const requested = args.name || env.INSTANCE_NAME || null;
  if (requested) {
    if (String(requested).trim().toLowerCase() === DEFAULT_PROFILE) return { name: DEFAULT_PROFILE, reason: args.name ? '--profile' : 'INSTANCE_NAME' };
    const checked = validateProfileName(requested);
    if (!checked.ok) return { ask: true, reason: `invalid profile name ${JSON.stringify(requested)}: ${checked.error}` };
    return { name: checked.value, reason: args.name ? '--profile' : 'INSTANCE_NAME' };
  }
  const existing = profiles.filter((p) => p.exists || p.isDefault);
  const named = existing.filter((p) => !p.isDefault);
  if (named.length === 0) return { name: DEFAULT_PROFILE, reason: 'the only profile' };
  const remembered = settings.defaultProfile;
  if (remembered && existing.some((p) => p.name === remembered)) return { name: remembered, reason: 'remembered choice' };
  return { ask: true, reason: 'several profiles, none remembered' };
}

/** The backend's home for a profile (null for the default profile: the real home). */
function backendHome(dir, name) {
  return name === DEFAULT_PROFILE ? null : path.join(dir, 'backend');
}

/** The settings file the main process reads/writes for a profile. */
function envFilePathFor(dir, name, homedir = os.homedir()) {
  const home = backendHome(dir, name);
  return path.join(home || homedir, '.jacarium.env');
}

/** Extra environment for the backend child of a profile. */
function backendEnvForProfile(dir, name) {
  const home = backendHome(dir, name);
  if (!home) return {};
  return {
    JACARIUM_PROFILE_HOME: home,
    JACARIUM_ENV_FILE: path.join(home, '.jacarium.env'),
    JACARIUM_KNOWN_HOSTS: path.join(home, '.ssh', 'known_hosts'),
  };
}

function copyIfMissing(src, dst, mode) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    if (mode !== undefined) fs.chmodSync(dst, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a profile ready to open: its directory, its backend home (named
 * profiles), the first-run copies of the real home's settings file and
 * known_hosts (named profiles, only when absent), its metadata. Returns
 * { dir, created, copied: [...] }.
 */
function prepareProfile(dir, name, { seed = seedHome(), now = Date.now() } = {}) {
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  const home = backendHome(dir, name);
  if (home) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (copyIfMissing(path.join(seed, '.jacarium.env'), path.join(home, '.jacarium.env'), 0o600)) copied.push('.jacarium.env');
    if (copyIfMissing(path.join(seed, '.jacarium', 'known_hosts'), path.join(home, '.ssh', 'known_hosts'), 0o600)) copied.push('known_hosts');
  }
  const meta = readProfileMeta(dir);
  writeProfileMeta(dir, {
    displayName: meta.displayName || (name === DEFAULT_PROFILE ? 'Default' : name),
    createdAt: meta.createdAt || new Date(now).toISOString(),
    lastUsedAt: new Date(now).toISOString(),
  });
  return { dir, created, copied };
}

/** The cloud-sync username of a profile: user for the default one, user+name otherwise. */
function machineUsernameForProfile(osUsername, name) {
  if (!name || name === DEFAULT_PROFILE) return osUsername;
  return `${osUsername}+${name}`;
}

/** The preferred port when free, else the next free one (two profiles can run at once). */
function pickFreePort(preferred, { attempts = 20 } = {}) {
  const tryPort = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => server.close(() => resolve(true)));
  });
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      const port = preferred + i;
      if (await tryPort(port)) return port;
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1' }, () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  })();
}

module.exports = {
  DEFAULT_PROFILE,
  PROFILE_NAME_RE,
  profilesRoot,
  seedHome,
  validateProfileName,
  profileDir,
  listProfiles,
  profileArgs,
  stripProfileArgs,
  resolveProfileSelection,
  readProfilesSettings,
  writeProfilesSettings,
  readProfileMeta,
  writeProfileMeta,
  backendHome,
  envFilePathFor,
  backendEnvForProfile,
  prepareProfile,
  machineUsernameForProfile,
  pickFreePort,
};
