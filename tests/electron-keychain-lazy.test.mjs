#!/usr/bin/env node
/**
 * The desktop app asks the OS keychain only when it keeps something there.
 *
 * Electron's safeStorage is synchronous: isEncryptionAvailable(),
 * encryptString() and decryptString() open the keychain item on the main
 * thread, and macOS may answer with a prompt ("... wants to use your
 * confidential information stored in ... Safe Storage") that blocks the
 * whole main process until it is answered. The settings-scope controller
 * (electron/account-settings.cjs) is created 4 s after every start and used
 * to ask at once, in every profile; with nobody at the screen the app stood
 * still - a full test run stalled for 17 minutes on it. Now:
 *
 *   - a profile that is not linked to a home server and has no cached
 *     account settings never calls safeStorage - not when the controller is
 *     created, not on refresh(), not for state(), not for the link status;
 *   - a linked profile asks when the token is actually read or written, and
 *     an encrypted cache is opened only when there is one;
 *   - what state() reports about the keychain is what is already known (null
 *     before it was asked): showing Settings is never the reason to ask.
 *
 * Plain Node with a counting stand-in for safeStorage and throwaway
 * directories; no Electron, no real keychain.
 * Run: node tests/electron-keychain-lazy.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const homeServer = require('../electron/home-server.cjs');
const { createAccountSettings } = require('../electron/account-settings.cjs');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail !== '' ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };

function countingKeychain() {
  const calls = [];
  return {
    calls,
    isEncryptionAvailable: () => { calls.push('isEncryptionAvailable'); return true; },
    encryptString: (text) => { calls.push('encryptString'); return Buffer.from(`enc:${Buffer.from(text).toString('base64')}`); },
    decryptString: (buf) => { calls.push('decryptString'); return Buffer.from(String(buf).slice(4), 'base64').toString(); },
  };
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-keychain-lazy-'));
const profile = (name) => { const dir = path.join(WORK, name); fs.mkdirSync(dir, { recursive: true }); return dir; };

try {
  // ---- a profile that keeps nothing in the keychain -------------------------------------------------
  let keychain = countingKeychain();
  let dir = profile('fresh');
  let ctx = { storePath: path.join(dir, 'home-server.json'), pinsPath: path.join(dir, 'pins.json'), safeStorage: keychain };
  check('an unlinked profile: the link status is read without the keychain', homeServer.homeServerStatus(ctx).linked === false && keychain.calls.length === 0, keychain.calls.join());
  const posts = [];
  let controller = createAccountSettings({
    dir, safeStorage: keychain,
    homeServer: { fetch: async () => { throw new Error('not linked: never fetched'); }, linked: () => !!homeServer.homeServerStatus(ctx).linked },
    localBackend: { post: async (pathName, body) => { posts.push(body); return { ok: true, status: 200, text: '{}' }; } },
  });
  check('creating the settings controller does not ask the keychain (it used to, 4 s after every start)', keychain.calls.length === 0, keychain.calls.join());
  await controller.refresh();
  check('refresh() on a device-scope, unlinked profile does not ask it either', keychain.calls.length === 0, keychain.calls.join());
  const state = controller.state();
  check('state() reports the keychain as not asked yet (null) and still does not ask', state.keychain === null && state.scope === 'device' && keychain.calls.length === 0, JSON.stringify({ keychain: state.keychain, calls: keychain.calls }));
  const fetched = await homeServer.homeServerFetch('/api/auth/me', {}, ctx);
  check('a request through an unlinked profile is refused locally, without the keychain', fetched.ok === false && keychain.calls.length === 0, keychain.calls.join());

  // ---- a keychain that would block: nothing of the above may even reach it ----------------------------
  const blocking = { isEncryptionAvailable: () => { throw new Error('the keychain was asked'); }, encryptString: () => { throw new Error('the keychain was asked'); }, decryptString: () => { throw new Error('the keychain was asked'); } };
  dir = profile('blocking');
  ctx = { storePath: path.join(dir, 'home-server.json'), pinsPath: path.join(dir, 'pins.json'), safeStorage: blocking };
  let threw = null;
  try {
    controller = createAccountSettings({ dir, safeStorage: blocking, homeServer: { fetch: async () => ({ ok: false, status: 0, text: '' }), linked: () => !!homeServer.homeServerStatus(ctx).linked }, localBackend: { post: async () => ({ ok: true, status: 200, text: '{}' }) } });
    await controller.refresh();
    controller.state();
    homeServer.homeServerStatus(ctx);
  } catch (e) { threw = e; }
  check('with a keychain that fails the moment it is touched, start-up of an unlinked profile goes through untouched', threw === null, threw && threw.message);

  // ---- a linked profile: asked when the token is used ---------------------------------------------------
  keychain = countingKeychain();
  dir = profile('linked');
  ctx = { storePath: path.join(dir, 'home-server.json'), pinsPath: path.join(dir, 'pins.json'), safeStorage: keychain };
  const codec = homeServer.createCodec(keychain);
  check('the codec itself asks nothing when it is made', keychain.calls.length === 0);
  const sealed = codec.encode('synthetic-device-token');
  check('encoding a token asks whether the keychain is usable, once, and encrypts', keychain.calls.join() === 'isEncryptionAvailable,encryptString' && typeof sealed.encrypted === 'string', keychain.calls.join());
  check('decoding it decrypts without asking again; a plain record needs no keychain', codec.decode(sealed) === 'synthetic-device-token' && keychain.calls.join() === 'isEncryptionAvailable,encryptString,decryptString'
    && homeServer.createCodec(blocking).decode({ plain: 'x' }) === 'x' && homeServer.createCodec(blocking).decode(null) === null, keychain.calls.join());
  fs.mkdirSync(path.dirname(ctx.storePath), { recursive: true });
  fs.writeFileSync(ctx.storePath, JSON.stringify({ url: 'https://home.example.test:8443', username: 'alice', deviceId: 'd1', deviceName: 'laptop', token: sealed, linkedAt: '2026-11-01T00:00:00Z' }));
  keychain.calls.length = 0;
  const status = homeServer.homeServerStatus(ctx);
  check('a linked profile\'s status is linked and encrypted; the keychain is asked there (something is stored in it)', status.linked === true && status.encrypted === true && keychain.calls.join() === 'isEncryptionAvailable', keychain.calls.join());

  // ---- the account-settings cache: opened only when there is one ----------------------------------------
  keychain = countingKeychain();
  dir = profile('cache');
  const answer = { values: { EDITOR_FONT: 'mono' }, secretValues: { API_KEY: 'synthetic-secret' }, sources: {}, revision: 3, revisions: {}, serverRevision: 7 };
  const linkedServer = { fetch: async () => ({ ok: true, status: 200, text: JSON.stringify(answer) }), linked: () => true };
  fs.writeFileSync(path.join(dir, 'settings-scope.json'), JSON.stringify({ scope: 'account' }));
  controller = createAccountSettings({ dir, safeStorage: keychain, homeServer: linkedServer, localBackend: { post: async () => ({ ok: true, status: 200, text: '{}' }) } });
  check('account scope, linked: creating the controller still asks nothing', keychain.calls.length === 0, keychain.calls.join());
  await controller.refresh();
  const cacheFiles = fs.readdirSync(dir).filter((f) => f !== 'settings-scope.json');
  const cacheText = cacheFiles.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('after a fetch the secrets are cached encrypted: now the keychain is asked, and no secret is on disk in clear', keychain.calls.includes('encryptString') && cacheFiles.length >= 1 && !cacheText.includes('synthetic-secret'), JSON.stringify({ calls: keychain.calls, cacheFiles }));
  check('state() then says the keychain is usable (it is known now)', controller.state().keychain === true);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
