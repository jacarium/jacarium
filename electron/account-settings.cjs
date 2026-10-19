// The desktop's settings scope: "This device" (the profile's own
// ~/.jacarium.env, as always) or "My account" (the account's settings on
// the linked home server - its file over the server defaults, secrets
// included - the same values the browser on that server uses).
//
// With "My account" the main process fetches the account's RESOLVED
// settings from the home server (GET /api/settings/effective?secrets=1, a
// device-token-only route: backend/settings_store.py), keeps the secret
// values in memory and, encrypted with safeStorage (the OS keychain), in
// <userData>/account-settings.enc for offline starts, and hands the whole
// map to the local backend over the loopback (POST /api/internal/settings
// with the app token): an in-memory overlay the backend's setting() reads
// instead of the profile file. Nothing is written to a plain file, the
// renderer never receives a secret (read() reports set / not set), and the
// log never carries a value.
//
// Switching back to "This device" drops the overlay at once. Unlink, a
// revoked token (401 from the server), sign-out and a deleted profile wipe
// the cached secrets and flip the scope back to the device.
//
// Electron-free except for what the caller injects (safeStorage, the two
// fetchers, paths), so tests/electron-account-settings.test.mjs drives it
// with a fake keychain, a real accounts-mode backend as the "home server"
// and a stub local backend.

const fs = require('fs');
const path = require('path');
const { isReservedKey } = require('./settings-store.cjs');

const SCOPE_FILE = 'settings-scope.json';
const CACHE_FILE = 'account-settings.enc';
const SCOPES = new Set(['device', 'account']);

// Mirror of SECRET_KEYS / _SECRET_SUFFIX in backend/settings_store.py
// (electron/settings-store.cjs has the same): what must never reach the
// renderer or a log line.
const SECRET_KEYS = new Set(['JIRA_PAT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CALENDAR_CLIENT_SECRET', 'HF_TOKEN', 'CUSTOM_API_KEY', 'SSH_AI_PASSWORD']);
const SECRET_SUFFIX = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PAT|_PASS)$/;
function isSecretKey(key) { return SECRET_KEYS.has(key) || SECRET_SUFFIX.test(key); }

function readJson(file) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data && typeof data === 'object' ? data : null; } catch { return null; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/** Encrypt/decrypt with safeStorage; without a usable keychain nothing is cached (the secrets stay in memory only). */
function createCodec(safeStorage) {
  const usable = !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  return {
    usable,
    encode(text) { return safeStorage.encryptString(text).toString('base64'); },
    decode(encoded) { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); },
  };
}

/**
 * The scope controller of one profile.
 *   dir            the profile's userData directory (scope + cache files)
 *   safeStorage    Electron's safeStorage (or a fake)
 *   homeServer     { fetch(pathName, init) -> { ok, status, text }, linked() -> bool }
 *   localBackend   { post(pathName, body) -> { ok, status, text } }  (the app-token loopback)
 *   log            (message) => void  - never given a value, only key names
 *   onChange       (state) => void  - the renderer is told to reload its view
 */
function createAccountSettings({ dir, safeStorage, homeServer, localBackend, log = () => {}, onChange = () => {} }) {
  const scopeFile = path.join(dir, SCOPE_FILE);
  const cacheFile = path.join(dir, CACHE_FILE);
  const codec = createCodec(safeStorage);
  let memory = null;           // { values, secretValues, sources, revision, revisions, serverRevision, fetchedAt }
  let lastError = null;
  let offline = false;
  let pushed = { active: false, signature: '' };

  function scope() {
    const record = readJson(scopeFile);
    return record && SCOPES.has(record.scope) ? record.scope : 'device';
  }

  /** The cached answer, decrypted (null when there is none or the keychain cannot open it). */
  function readCache() {
    const record = readJson(cacheFile);
    if (!record || !record.encrypted) return null;
    if (!codec.usable) return null;
    try { return JSON.parse(codec.decode(record.encrypted)); } catch { return null; }
  }
  function writeCache(data) {
    if (!codec.usable) return false;   // no keychain: memory only, nothing on disk
    writeJson(cacheFile, { encrypted: codec.encode(JSON.stringify(data)), cachedAt: new Date().toISOString() });
    return true;
  }
  function dropCache() {
    try { fs.unlinkSync(cacheFile); } catch { /* none */ }
  }

  /** The merged map the local backend runs on (plain + secret values). */
  function overlayValues(data) {
    return { ...(data?.values || {}), ...(data?.secretValues || {}) };
  }

  /** Install or drop the overlay on the local backend; idempotent per content. */
  async function pushOverlay(active) {
    const data = memory;
    const body = active && data ? { active: true, values: overlayValues(data) } : { active: false };
    const signature = active && data ? `${data.revision}:${data.serverRevision}:${Object.keys(body.values).sort().join(',')}` : 'off';
    if (pushed.active === !!(active && data) && pushed.signature === signature) return true;
    try {
      const answer = await localBackend.post('/api/internal/settings', body);
      if (!answer.ok) { log(`[Settings] the local backend refused the overlay (HTTP ${answer.status})`); return false; }
      pushed = { active: !!(active && data), signature };
      log(active && data ? `[Settings] running on the account's settings (${Object.keys(body.values).length} keys)` : '[Settings] running on this device\'s settings');
      return true;
    } catch (error) {
      log(`[Settings] could not reach the local backend: ${error.message}`);
      return false;
    }
  }

  /** Fetch the account's resolved settings (with secrets); false when the server could not be reached or refused. */
  async function fetchFromServer() {
    if (!homeServer.linked()) return false;
    let answer;
    try {
      answer = await homeServer.fetch('/api/settings/effective?secrets=1', { method: 'GET', headers: {} });
    } catch (error) {
      offline = true; lastError = error.message;
      return false;
    }
    if (answer.status === 401) {
      // the token was revoked or the account disabled: forget everything
      log('[Settings] the home server no longer accepts this device - the account settings are wiped');
      await wipe({ reason: 'revoked' });
      return false;
    }
    if (!answer.ok) {
      offline = answer.status === 0;
      lastError = `HTTP ${answer.status}`;
      return false;
    }
    let data;
    try { data = JSON.parse(answer.text); } catch { lastError = 'bad answer'; return false; }
    memory = {
      values: data.values || {}, secretValues: data.secretValues || {}, sources: data.sources || {},
      revision: Number(data.revision) || 0, revisions: data.revisions || {}, serverRevision: Number(data.serverRevision) || 0,
      fetchedAt: new Date().toISOString(),
    };
    offline = false; lastError = null;
    writeCache(memory);
    return true;
  }

  /**
   * Bring the backend in line with the scope: My account -> the freshest
   * values (the server, else the keychain cache) as the overlay; This
   * device -> no overlay. Called on launch, on each sync tick, after a save.
   */
  async function refresh({ force = false } = {}) {
    if (scope() !== 'account') {
      await pushOverlay(false);
      return state();
    }
    const fetched = await fetchFromServer();
    if (!fetched && !memory) memory = readCache();
    if (!fetched && !memory) {
      // nothing to run on yet: the device file stays in force until the server answers
      await pushOverlay(false);
      return state();
    }
    if (fetched || force || !pushed.active) await pushOverlay(true);
    onChange(state());
    return state();
  }

  async function setScope(next) {
    if (!SCOPES.has(next)) throw new Error('unknown settings scope');
    if (next === 'account' && !homeServer.linked()) throw new Error('Link this profile to your home server first');
    writeJson(scopeFile, { scope: next, changedAt: new Date().toISOString() });
    log(`[Settings] scope: ${next === 'account' ? 'my account' : 'this device'}`);
    return refresh({ force: true });
  }

  /** What the renderer may see: plain values, secrets as set / not set, where each comes from. Never a secret value. */
  function state() {
    const data = memory || readCache();
    const secrets = {};
    for (const key of Object.keys(data?.secretValues || {})) secrets[key] = true;
    return {
      scope: scope(),
      linked: homeServer.linked(),
      available: !!data,
      values: { ...(data?.values || {}) },
      secrets,
      sources: { ...(data?.sources || {}) },
      revision: data?.revision ?? 0,
      revisions: { ...(data?.revisions || {}) },
      lastSynced: data?.fetchedAt || null,
      offline,
      error: lastError,
      keychain: codec.usable,
    };
  }

  /** Save to the account (plain values replace, secrets write-only, ifRevision for the 409 check), then refetch. */
  async function write({ values = {}, secrets = {}, ifRevision = null } = {}) {
    if (!homeServer.linked()) throw new Error('Not linked to a home server');
    const answer = await homeServer.fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, secrets, ...(ifRevision ? { ifRevision } : {}) }),
    });
    let data = null;
    try { data = JSON.parse(answer.text); } catch { data = null; }
    if (answer.status === 409) {
      const error = new Error(data?.error || 'Changed on another device - reload the settings');
      error.status = 409; error.conflicts = data?.conflicts || [];
      throw error;
    }
    if (!answer.ok) throw new Error(data?.error || `The home server refused the save (HTTP ${answer.status})`);
    await refresh({ force: true });
    return state();
  }

  /** The migration: copy chosen keys of the device file to the account (the caller reads the file; secrets by name). */
  async function copyFromDevice({ deviceValues = {}, plainKeys = [], secretKeys = [] } = {}) {
    // (a reserved name - PATH, HOME, JACARIUM_* ... - never travels, the
    // server would refuse the whole save for it)
    const values = {};
    for (const key of plainKeys) if (!isSecretKey(key) && !isReservedKey(key) && deviceValues[key]) values[key] = deviceValues[key];
    const secrets = {};
    for (const key of secretKeys) if (isSecretKey(key) && !isReservedKey(key) && deviceValues[key]) secrets[key] = deviceValues[key];
    const result = await write({ values, secrets });
    log(`[Settings] copied ${Object.keys(values).length + Object.keys(secrets).length} settings from this device to the account`);
    return { copied: Object.keys(values).concat(Object.keys(secrets)), state: result };
  }

  /** Forget the account's settings on this device: cache, memory, overlay; the scope goes back to the device. */
  async function wipe({ reason = 'unlink' } = {}) {
    memory = null;
    dropCache();
    try { fs.unlinkSync(scopeFile); } catch { /* none */ }
    pushed = { active: true, signature: 'force-off' };
    await pushOverlay(false);
    log(`[Settings] account settings removed from this device (${reason})`);
    onChange(state());
    return state();
  }

  return { scope, setScope, refresh, state, write, copyFromDevice, wipe, isSecretKey, files: { scopeFile, cacheFile } };
}

module.exports = { createAccountSettings, isSecretKey, SCOPE_FILE, CACHE_FILE };
