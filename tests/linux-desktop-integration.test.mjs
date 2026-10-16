/**
 * Linux desktop integration of the packaged app - the pieces that decide
 * whether a window shows Jacarium's icon or a generic one, guarded
 * statically so they cannot drift apart again:
 *
 *  - the window icon: every BrowserWindow in electron/main.cjs (main,
 *    profile picker, standalone pop-outs) and the About panel use the one
 *    WINDOW_ICON, a PNG under build/icons/ that exists and is packaged as it
 *    is (package.json build.files includes build/icons/**), so the path
 *    resolves in development and inside app.asar alike. On X11 this icon is
 *    what the title bar, task switcher and docks show for a window that no
 *    .desktop file claims (an AppImage run directly);
 *  - window association: Electron's app_id (Wayland) / WM_CLASS (X11) is the
 *    package.json `desktopName` minus ".desktop"; electron-builder names the
 *    installed .desktop file after it (linux.syncDesktopName) and writes
 *    StartupWMClass to match, so GNOME/KDE find the entry - and its Icon -
 *    for every window, including an AppImage integrated by appimaged /
 *    AppImageLauncher (whose desktop file is renamed, leaving only
 *    StartupWMClass to match on). The repository's own
 *    com.jacarium.app.desktop and the AppStream metainfo say the same;
 *  - the icon set: build/icons/ holds the PNG sizes electron-builder's Linux
 *    targets use (hicolor icons for deb/rpm, .DirIcon and the root PNG of the
 *    AppImage), each file really being a PNG of the size its name claims.
 *
 * What only a Linux desktop can confirm (see docs/DEVELOPMENT.md): run the
 * AppImage / installed package and check `xprop WM_CLASS` (X11) or the
 * app_id in Looking Glass (GNOME Wayland) equals com.jacarium.app, and that
 * the dock shows the icon.
 *
 * Run:  node tests/linux-desktop-integration.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

const pkg = JSON.parse(read('package.json'));
const main = read('electron/main.cjs');
const desktopFile = read('com.jacarium.app.desktop');
const metainfo = read('com.jacarium.app.metainfo.xml');

// ---- the window icon --------------------------------------------------------
const iconDecl = /^const WINDOW_ICON = path\.join\(__dirname, '\.\.\/build\/icons\/(\d+)x\1\.png'\);$/m.exec(main);
check('electron/main.cjs declares WINDOW_ICON as a build/icons/<n>x<n>.png next to the electron/ directory', !!iconDecl, iconDecl ? iconDecl[0] : 'not found');
const iconFile = iconDecl ? `build/icons/${iconDecl[1]}x${iconDecl[1]}.png` : null;
check('...and that file exists', !!iconFile && fs.existsSync(path.join(REPO, iconFile)), iconFile || '');
check('...and is at least 256px (docks and task switchers scale down, never up)', !!iconDecl && Number(iconDecl[1]) >= 256);
const windows = main.match(/new BrowserWindow\(\{/g) || [];
const iconOptions = main.match(/^\s+icon: WINDOW_ICON,?$/gm) || [];
check(`every BrowserWindow passes icon: WINDOW_ICON (${windows.length} windows, ${iconOptions.length} icon options)`, windows.length > 0 && iconOptions.length === windows.length);
check('no window builds its own icon path from dist/ or public/ any more', !/dist\/icon\.png|public\/icon\.png/.test(main.replace(/^\s*\/\/.*$/gm, '')));
check('the About panel uses the same WINDOW_ICON', /iconPath: WINDOW_ICON,/.test(main));
check('package.json build.files packages build/icons/** as it is (so the path resolves inside app.asar)', Array.isArray(pkg.build?.files) && pkg.build.files.includes('build/icons/**/*'));

// ---- window association: desktopName <-> .desktop file <-> StartupWMClass ---
const DESKTOP_ID = 'com.jacarium.app';
check(`package.json desktopName is ${DESKTOP_ID}.desktop (Electron's app_id / WM_CLASS on Linux)`, pkg.desktopName === `${DESKTOP_ID}.desktop`, String(pkg.desktopName));
check('build.linux.syncDesktopName is true (electron-builder names the .desktop file and StartupWMClass after desktopName)', pkg.build?.linux?.syncDesktopName === true);
check('build.linux.executableName is jacarium (the Exec= and Icon= names electron-builder writes, and the hicolor icon file name)', pkg.build?.linux?.executableName === 'jacarium');
check('build.linux.icon is the build/icons directory', pkg.build?.linux?.icon === 'build/icons');
check('build.linux.desktop.entry does not override Exec, Icon, Name or StartupWMClass (electron-builder computes them)', !['Exec', 'Icon', 'Name', 'StartupWMClass'].some((k) => k in (pkg.build?.linux?.desktop?.entry || {})));
check(`the repository's ${DESKTOP_ID}.desktop carries StartupWMClass=${DESKTOP_ID}`, new RegExp(`^StartupWMClass=${DESKTOP_ID.replace(/\./g, '\\.')}$`, 'm').test(desktopFile));
check('...Icon=jacarium (the hicolor icon the deb/rpm install) and Exec=jacarium', /^Icon=jacarium$/m.test(desktopFile) && /^Exec=jacarium %U$/m.test(desktopFile));
check('...Name=Jacarium (the productName)', /^Name=Jacarium$/m.test(desktopFile) && pkg.build?.productName === 'Jacarium');
check(`the AppStream metainfo launches ${DESKTOP_ID}.desktop`, new RegExp(`<launchable type="desktop-id">${DESKTOP_ID.replace(/\./g, '\\.')}\\.desktop</launchable>`).test(metainfo) && new RegExp(`<id>${DESKTOP_ID.replace(/\./g, '\\.')}</id>`).test(metainfo));

// ---- the icon set -------------------------------------------------------------
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
for (const size of SIZES) {
  const file = path.join(REPO, 'build/icons', `${size}x${size}.png`);
  const dims = fs.existsSync(file) ? pngSize(file) : null;
  check(`build/icons/${size}x${size}.png is a ${size}px PNG`, !!dims && dims.width === size && dims.height === size, dims ? `${dims.width}x${dims.height}` : 'missing or not a PNG');
}
check('brand-icons.sh renders exactly these sizes', SIZES.every((s) => read('scripts/brand-icons.sh').includes(String(s))));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
