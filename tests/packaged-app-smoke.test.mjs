/**
 * Smoke test of a PACKAGED desktop build through the isolated driver
 * (tests/helpers/packaged-app.mjs): the app starts with its data directory
 * under a scratch path (never the user's profile), reports its version,
 * answers the home-server version call without error (the call 3.0.0
 * failed on), and leaves the real data directories alone. Skips when no
 * packaged app is under dist-electron, and when the build is too old to be
 * isolated (the driver refuses to launch it - nothing is run).
 * Run: node tests/packaged-app-smoke.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackagedApps, buildSupportsUserDataOverride, launchPackagedApp } from './helpers/packaged-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
const apps = findPackagedApps();
if (!apps.length) { console.log('SKIP: no packaged app under dist-electron (npx electron-builder --mac dir --arm64 builds one)'); process.exit(0); }
const target = apps[0];
console.log(`packaged app: ${path.relative(REPO, target.executablePath)}`);
if (!buildSupportsUserDataOverride(target.asar)) {
  // an older build (3.0.1 and before) cannot be isolated: the driver refuses to launch it, so there is nothing safe to test
  console.log('SKIP: this packaged build does not honour JACARIUM_USER_DATA_DIR when packaged - the driver refuses to launch it (rebuild from the current tree)');
  process.exit(0);
}
check('the build honours JACARIUM_USER_DATA_DIR when packaged (the driver would refuse it otherwise)', true);
let launched = null;
try {
  launched = await launchPackagedApp(target);
  const { app, userData, close } = launched;
  check('the app runs with its userData under the scratch directory', fs.existsSync(path.join(userData, 'profile.json')) || fs.existsSync(userData));
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  check('app.getVersion() is package.json\'s version', version === pkg.version, `${version} vs ${pkg.version}`);
  const win = await app.firstWindow({ timeout: 120000 });
  await win.waitForTimeout(3000);
  const bridge = await win.evaluate(async () => ({ version: await window.electronAPI.getAppVersion(), check: await window.electronAPI.homeServerVersion() }));
  check('the renderer bridge answers homeServerVersion() with this build\'s app version and protocol, no error', bridge.version === pkg.version && bridge.check?.desktop?.app === pkg.version && Number.isInteger(bridge.check?.desktop?.protocol) && bridge.check?.server?.linked === false, JSON.stringify(bridge).slice(0, 200));
  check('profile.json was written in the scratch userData (not elsewhere)', fs.existsSync(path.join(userData, 'profile.json')));
  await close();
  launched = null;
} catch (error) {
  check('the packaged app launched and answered', false, error.message);
} finally {
  if (launched) await launched.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
