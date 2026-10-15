/**
 * Launch a PACKAGED desktop build (dist-electron/<platform>/Jacarium.app
 * or a Linux unpacked dir) for a test - never against the user's data.
 *
 * Isolation, enforced in this order:
 *   1. before launch, the build's app.asar is read: its electron/main.cjs must
 *      carry PACKAGED_USER_DATA_OVERRIDE (it honours JACARIUM_USER_DATA_DIR
 *      when packaged). A build without it is REFUSED - it would open the real
 *      profile (macOS keys userData off ~/Library, not HOME);
 *   2. the launch sets JACARIUM_USER_DATA_DIR and
 *      JACARIUM_PROFILES_ROOT to fresh scratch directories (and
 *      --profile default, so no picker, no ~/.config profile);
 *   3. first thing after launch, app.getPath('userData') is checked to be
 *      under the scratch directory; otherwise the app is closed at once and
 *      the launch fails.
 *
 *   const { app, scratch, close } = await launchPackagedApp({ executablePath });
 *   ...
 *   await close();   // closes the app and removes the scratch directories
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(REPO, 'package.json'));
const MARKER = 'PACKAGED_USER_DATA_OVERRIDE';

/** The packaged apps under dist-electron, newest first: [{ executablePath, asar }]. */
export function findPackagedApps(distDir = path.join(REPO, 'dist-electron')) {
  const found = [];
  if (!fs.existsSync(distDir)) return found;
  for (const entry of fs.readdirSync(distDir)) {
    const mac = path.join(distDir, entry, 'Jacarium.app');
    if (fs.existsSync(mac)) found.push({ executablePath: path.join(mac, 'Contents', 'MacOS', 'Jacarium'), asar: path.join(mac, 'Contents', 'Resources', 'app.asar') });
    const linux = path.join(distDir, entry, 'resources', 'app.asar');
    if (fs.existsSync(linux)) found.push({ executablePath: path.join(distDir, entry, 'jacarium'), asar: linux });
  }
  return found.filter((a) => fs.existsSync(a.executablePath)).sort((a, b) => fs.statSync(b.asar).mtimeMs - fs.statSync(a.asar).mtimeMs);
}

/** True when the build honours JACARIUM_USER_DATA_DIR while packaged (checked without launching it). */
export function buildSupportsUserDataOverride(asar) {
  try {
    // @electron/asar comes with electron-builder; read the file straight from the archive
    const src = req('@electron/asar').extractFile(asar, 'electron/main.cjs').toString('utf8');
    return src.includes(MARKER) && !/if \(!app\.isPackaged && process\.env\.JACARIUM_USER_DATA_DIR\)/.test(src);
  } catch {
    return false;
  }
}

export async function launchPackagedApp({ executablePath, asar, args = [], env = {}, timeout = 120000 } = {}) {
  if (!executablePath) throw new Error('launchPackagedApp: executablePath is required');
  if (!asar) {
    const guess = findPackagedApps().find((a) => a.executablePath === executablePath);
    asar = guess?.asar;
  }
  if (!asar || !fs.existsSync(asar)) throw new Error(`launchPackagedApp: no app.asar next to ${executablePath}`);
  if (!buildSupportsUserDataOverride(asar)) {
    throw new Error(`launchPackagedApp: REFUSED - this build does not honour JACARIUM_USER_DATA_DIR when packaged (no ${MARKER} in its electron/main.cjs); it would open the real profile. Rebuild from a tree that has it.`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-app-scratch-'));
  const userData = path.join(scratch, 'userData');
  const profilesRoot = path.join(scratch, 'profiles');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(profilesRoot, { recursive: true });
  const { _electron } = req('playwright-core');
  const app = await _electron.launch({
    executablePath,
    args: ['--profile', 'default', ...args],
    env: { ...process.env, ...env, JACARIUM_USER_DATA_DIR: userData, JACARIUM_PROFILES_ROOT: profilesRoot },
    timeout,
  });
  const close = async () => {
    try { await app.close(); } catch { /* already gone */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  let resolved;
  try {
    resolved = await app.evaluate(({ app: a }) => ({ userData: a.getPath('userData'), packaged: a.isPackaged }));
  } catch (error) {
    await close();
    throw new Error(`launchPackagedApp: could not verify userData: ${error.message}`);
  }
  if (!path.resolve(resolved.userData).startsWith(path.resolve(userData))) {
    await close();
    throw new Error(`launchPackagedApp: ABORTED - the app's userData is ${resolved.userData}, not under the scratch directory ${userData}`);
  }
  return { app, scratch, userData, profilesRoot, packaged: resolved.packaged, close };
}
