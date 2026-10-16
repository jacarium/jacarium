/**
 * The brand, statically:
 *
 *  - the app icon (public/brand/icon.svg, icon-small.svg: the rounded square)
 *    is only for the OS and browser chrome around the app - build/icons,
 *    the Electron window and About panel icon, favicon, apple-touch-icon and
 *    the web manifest - and every one of those derives from icon*.svg;
 *  - the mark (public/brand/mark.svg, mark-light.svg: the arch with the
 *    blossom, no square) is what the UI shows - src/brand/BrandMark.jsx, the
 *    profile picker, the downloads page, the README - and no in-app
 *    component imports the icon files;
 *  - the tagline has one source (package.json description) and the static
 *    copies (index.html, the manifest, the desktop and AppStream files)
 *    equal it; the website is the plain https://jacarium.com link;
 *  - no "Support Console" (the app's previous name) remains anywhere users
 *    read it - the app, the release notes, CHANGELOG.md, the README and
 *    docs/; only the code and tests that recognise the previous version's
 *    exports and Taskwarrior paths keep it (the allow-list).
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const pkg = JSON.parse(read('package.json'));
const TAGLINE = pkg.description;
const HOMEPAGE = 'https://jacarium.com';

// ---- the sources -----------------------------------------------------------
const icon = read('public/brand/icon.svg');
const iconSmall = read('public/brand/icon-small.svg');
const mark = read('public/brand/mark.svg');
const markLight = read('public/brand/mark-light.svg');
const ARCH = 'M22 110 V54 A38 38 0 0 1 98 54 V110 Z';
check('the icon sources are the rounded square (rx=28) in the accent', /<rect width="120" height="120" rx="28" fill="#7B5CE0"\/>/.test(icon) && /<rect width="120" height="120" rx="28" fill="#7B5CE0"\/>/.test(iconSmall));
check('the mark sources are the arch with the blossom and no square', [mark, markLight].every((s) => s.includes(`d="${ARCH}"`) && !/<rect/.test(s) && (s.match(/<ellipse/g) || []).length === 5));
check('the mark blossom is lilac on dark surfaces and white on light ones', /<g fill="#EDE6FF">/.test(mark) && /<g fill="#FFFFFF">/.test(markLight));
check('the SVG sources carry no metadata, script or external reference', [icon, iconSmall, mark, markLight].every((s) => !/<metadata|<script|xlink:href|http:\/\/(?!www\.w3\.org)/.test(s)));

// ---- the app icon: OS and browser chrome only -------------------------------
const iconsScript = read('scripts/brand-icons.sh');
check('brand-icons.sh renders build/icons and the public PNGs from icon.svg / icon-small.svg only', /src="\$SRC\/icon\.svg"/.test(iconsScript) && /src="\$SRC\/icon-small\.svg"/.test(iconsScript) && !/mark(-light)?\.svg/.test(iconsScript.replace(/^#.*$/gm, '')));
for (const out of ['public/favicon.png', 'public/apple-touch-icon.png', 'public/icon-192.png', 'public/icon-512.png', 'public/icon.png']) {
  check(`${out} is rendered by brand-icons.sh and exists`, iconsScript.includes(`"$OUT/${out}"`) && fs.existsSync(path.join(REPO, out)));
}
{
  const ico = fs.readFileSync(path.join(REPO, 'public/favicon.ico')); const built = fs.readFileSync(path.join(REPO, 'build/icons/icon.ico'));
  check('public/favicon.ico is the app icon ICO (identical to build/icons/icon.ico)', ico.equals(built) && ico.length > 1000);
  check('index.html links /favicon.ico (sizes any) for the browsers that ask for it regardless', /rel="icon" href="\/favicon\.ico" sizes="any"/.test(read('index.html')));
  const caddy = read('deploy/Caddyfile');
  check('the browser deployment serves every built file anonymously by existence (file matcher), not a hand list of icons', /file \{path\}/.test(caddy) && /not path \/api\/\* \/socket\.io\/\* \/health \/assets\/\*/.test(caddy) && !/\/favicon\.svg \/icon\.png/.test(caddy));
}
for (const out of []) {
  check(`${out} is rendered by brand-icons.sh and exists`, iconsScript.includes(`"$OUT/${out}"`) && fs.existsSync(path.join(REPO, out)));
}
check('public/favicon.svg is the small icon source, public/icon.svg the icon source', read('public/favicon.svg') === iconSmall && read('public/icon.svg') === icon);
const html = read('index.html');
check('index.html links the favicon (svg + png), the 180 px apple-touch-icon and the manifest', /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/.test(html) && /rel="icon" type="image\/png" sizes="48x48" href="\/favicon\.png"/.test(html) && /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/.test(html) && /rel="manifest" href="\/manifest\.webmanifest"/.test(html));
const manifest = JSON.parse(read('public/manifest.webmanifest'));
check('the web manifest names the app, carries the tagline and the 192/512 icons', manifest.name === 'Jacarium' && manifest.description === TAGLINE && manifest.icons.some((i) => i.src === 'icon-192.png' && i.sizes === '192x192') && manifest.icons.some((i) => i.src === 'icon-512.png' && i.sizes === '512x512'));
check('the Electron builds use build/icons (icns, ico, the png directory)', pkg.build.mac.icon === 'build/icons/icon.icns' && pkg.build.win.icon === 'build/icons/icon.ico' && pkg.build.linux.icon === 'build/icons');
const main = read('electron/main.cjs');
check('the Electron windows and About panel use the one rendered app icon (WINDOW_ICON, a build/icons PNG), not the mark', /^const WINDOW_ICON = path\.join\(__dirname, '\.\.\/build\/icons\/\d+x\d+\.png'\);$/m.test(main) && (main.match(/WINDOW_ICON/g) || []).length >= 4 && !/mark(-light)?\.svg/.test(main));
try {
  const sizes = execFileSync('sips', ['-g', 'pixelWidth', path.join(REPO, 'public/apple-touch-icon.png'), path.join(REPO, 'public/icon-192.png')], { encoding: 'utf8' });
  check('apple-touch-icon is 180 px, icon-192 is 192 px', /pixelWidth: 180/.test(sizes) && /pixelWidth: 192/.test(sizes), sizes.replace(/\s+/g, ' '));
} catch { console.log('SKIP: sips not available - PNG sizes not checked'); }
const rsvg = spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
if (rsvg.status === 0) {
  const r = spawnSync('bash', ['scripts/brand-icons.sh', '--check'], { cwd: REPO, encoding: 'utf8' });
  check('the committed icons match the sources (scripts/brand-icons.sh --check)', r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' / '));
} else {
  console.log('SKIP: rsvg-convert missing - the rendered icons are not compared with the sources');
}

// ---- the mark: inside the UI only -------------------------------------------
const brandMark = read('src/brand/BrandMark.jsx');
check('BrandMark draws the mark (the arch, five petals, the centre) and no square', brandMark.includes(`d="${ARCH}"`) && /\[0, 72, 144, 216, 288\]/.test(brandMark) && !/<rect/.test(brandMark) && /data-brand="mark"/.test(brandMark));
check('BrandMark uses the same colours as the mark sources', /#7B5CE0/.test(brandMark) && /dark: '#EDE6FF', light: '#FFFFFF'/.test(brandMark));
check('BrandMark paints through theme variables (--mark-arch, --mark-blossom, --mark-center) with the brand defaults', /var\(--mark-arch, \$\{ACCENT\}\)/.test(brandMark) && /var\(--mark-blossom, \$\{toneBlossom\}\)/.test(brandMark) && /var\(--mark-center, var\(--mark-arch, \$\{ACCENT\}\)\)/.test(brandMark));
{
  // every gradient theme restyles the mark: a tinted-white arch >= 3:1 on the gradient's top colour, the blossom >= 4.5:1 on the arch
  const themeSrc = read('src/contexts/ThemeContext.jsx');
  const themes = Array.from(themeSrc.matchAll(/'(gradient-[a-z-]+)': \{\s*name: '([^']+)',[^}]*?from: '(#[0-9a-fA-F]{6})'/g)).map((m) => ({ key: m[1], name: m[2], from: m[3] }));
  const indexCss = read('src/index.css');
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [16, 8, 0].map((sh) => ((n >> sh) & 255) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  check('ThemeContext lists the five gradient themes', themes.length === 5, themes.map((t) => t.name).join(','));
  for (const t of themes) {
    const m = new RegExp(`\\[data-theme="${t.key}"\\] \\{ --mark-arch: (#[0-9a-fA-F]{6}); --mark-blossom: (#[0-9a-fA-F]{6}); \\}`).exec(indexCss);
    check(`${t.name}: the mark has its own arch and blossom`, !!m);
    if (!m) continue;
    check(`${t.name}: the arch is >= 3:1 on the gradient's top colour and the blossom >= 4.5:1 on the arch`, ratio(m[1], t.from) >= 3 && ratio(m[2], m[1]) >= 4.5, `arch/gradient ${ratio(m[1], t.from).toFixed(2)}, blossom/arch ${ratio(m[2], m[1]).toFixed(2)}`);
  }
  check('the default themes do not restyle the mark (brand violet stays)', !/(:root|\.dark|\[data-theme="(light|dark|auto|dark-neutral)"\])[^{]*\{[^}]*--mark-arch/.test(indexCss));
}
for (const [file, label] of [['electron/profile-picker.html', 'the profile picker'], ['backend/downloads.py', 'the downloads page']]) {
  const s = read(file);
  check(`${label} shows the mark inline (the arch path, no square)`, s.includes(`d="${ARCH}"`) && !/<rect width="120" height="120" rx="28"/.test(s));
}
const readme = read('README.md');
check('the README header shows the mark (dark and light variants) next to a text heading', /srcset="public\/brand\/mark\.svg"/.test(readme) && /src="public\/brand\/mark-light\.svg"/.test(readme) && /^# Jacarium$/m.test(readme));
const uiFiles = execFileSync('git', ['ls-files', 'src', 'electron', 'backend', 'index.html'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.(jsx?|mjs|cjs|py|html|css)$/.test(f));
const iconUse = uiFiles.filter((f) => f !== 'electron/main.cjs' && /brand\/icon(-small)?\.svg|build\/icons|favicon\.(svg|png)|apple-touch-icon|icon-(192|512)\.png/.test(read(f)) && f !== 'index.html');
check('no in-app component references the app icon files (the mark is what the UI shows)', iconUse.length === 0, iconUse.join(', '));
const markUse = ['src/components/CompactSidebar.jsx', 'src/components/auth/AuthGate.jsx', 'src/components/StartupError.jsx', 'src/components/WhatsNew.jsx', 'src/components/common/modals/settings/AboutSettings.jsx'].filter((f) => !/from '[./]*brand\/BrandMark'/.test(read(f)));
check('the sidebar, the sign-in pages, the startup error, What\'s New and About use BrandMark', markUse.length === 0, markUse.join(', '));

// ---- the words: one tagline, one website ------------------------------------
check('package.json carries the tagline and the homepage', TAGLINE.length > 20 && pkg.homepage === HOMEPAGE, `${TAGLINE} / ${pkg.homepage}`);
check('index.html <meta name="description"> equals the tagline', html.includes(`<meta name="description" content="${TAGLINE}"`));
check('the desktop file Comment equals the tagline', read('com.jacarium.app.desktop').includes(`Comment=${TAGLINE}`));
check('the AppStream summary equals the tagline and the homepage is the website', read('com.jacarium.app.metainfo.xml').includes(`<summary>${TAGLINE}</summary>`) && read('com.jacarium.app.metainfo.xml').includes(`<url type="homepage">${HOMEPAGE}</url>`));
check('the README states the tagline under the heading', readme.includes(`\n# Jacarium\n\n${TAGLINE}\n`));
check('vite.config.js injects the author from package.json (About > Created by)', /'__APP_AUTHOR__': JSON\.stringify\(\{ name: pkg\.author\?\.name/.test(read('vite.config.js')) && pkg.author?.name === 'Robin Cernin' && pkg.author?.url === 'https://github.com/zerodayz');
check('vite.config.js injects the funding links from package.json (About > Support Jacarium: Ko-fi and GitHub Sponsors)', /'__APP_FUNDING__': JSON\.stringify\(\[\]\.concat\(pkg\.funding/.test(read('vite.config.js')) && JSON.stringify([].concat(pkg.funding).map((f) => f.url)) === JSON.stringify(['https://ko-fi.com/robincernin', 'https://github.com/sponsors/zerodayz']));
check('vite.config.js injects the repository from package.json (About > Source code)', /'__APP_REPOSITORY__': JSON\.stringify\(pkg\.repository\?\.url/.test(read('vite.config.js')) && pkg.repository?.url === 'https://github.com/jacarium/jacarium');
check('vite.config.js injects the tagline and the homepage from package.json', /'__APP_TAGLINE__': JSON\.stringify\(pkg\.description/.test(read('vite.config.js')) && /'__APP_HOMEPAGE__': JSON\.stringify\(pkg\.homepage/.test(read('vite.config.js')));
check('the Electron About panel takes the tagline and the homepage from package.json', /credits: `\$\{pkg\.description\}/.test(main) || /pkg\.description/.test(main.slice(main.indexOf('setAboutPanelOptions'), main.indexOf('setAboutPanelOptions') + 800)));
check('the downloads page takes the tagline and the homepage from the version info (package.json)', /info\.get\('tagline'\)/.test(read('backend/downloads.py')) && /info\.get\('homepage'\)/.test(read('backend/downloads.py')) && /'tagline': str\(pkg\.get\('description'/.test(read('backend/version_info.py')));
const linkFiles = execFileSync('git', ['ls-files', 'src', 'electron', 'backend', 'public', 'index.html', 'README.md', 'com.jacarium.app.desktop', 'com.jacarium.app.metainfo.xml', 'package.json', 'deploy'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f && !/\.(png|ico|icns|woff2?|ttf|lock)$/.test(f));
const badLinks = [];
for (const f of linkFiles) {
  const s = read(f);
  for (const m of s.matchAll(/(\S*?)jacarium\.com(\S*)/g)) {
    if (/http:\/\/$/.test(m[1]) || /[\w-]\.$/.test(m[1]) || /^\/[\w-]/.test(m[2])) badLinks.push(`${f}: ${m[0]}`);
  }
}
check('every website reference is the plain https://jacarium.com link (no http://, no subdomain, no other host)', badLinks.length === 0, badLinks.slice(0, 5).join(' ; '));

// ---- no user-visible "Support Console" outside the allow-list ----------------
const ALLOW = ['tests/fixtures/old-export/', 'tests/import-old-export.test.mjs', 'tests/taskwarrior-follow.test.mjs', 'tests/brand.test.mjs', 'src/utils/taskwarriorPaths.js'];   // taskwarriorPaths recognises the previous app's folders on purpose   // the two tests carry old paths as synthetic fixtures
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f && /\.(jsx?|mjs|cjs|py|html|css|json|sh|md|xml|desktop|webmanifest)$/.test(f) && !ALLOW.some((a) => f.startsWith(a)) && !/package-lock\.json$/.test(f));
const leftovers = [];
for (const f of tracked) {
  read(f).split('\n').forEach((line, i) => {
    if (/Support Console|SupportConsole|support-console|SUPPORT_CONSOLE/.test(line)) leftovers.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
  });
}
check('no "Support Console" (or the old identifiers) remains outside the allow-list', leftovers.length === 0, leftovers.slice(0, 6).join(' ; '));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
