/**
 * Brand pages, in the real browser: the setup and sign-in pages show the
 * hero (mark, wordmark, tagline) over the form card - in the dark theme the
 * card takes the tinted hero surface, in the light theme the neutral one -,
 * the footer names the version and the website; signed in, the sidebar
 * carries the mark (a click opens Settings; What's New shows the mark in its header)
 * and Settings has the About category (version rows, tagline from
 * package.json, the website link labelled as opening in the browser).
 *
 * Screenshots (light/dark, desktop and 393 px phone) land in
 * BRAND_SHOTS_DIR (default: a temp dir). Needs backend/venv, Chrome and
 * ports 5173/8080 free; skips cleanly otherwise. Synthetic data only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';
import { parseCssColor } from './helpers/color.mjs';

const VITE_PORT = 5173;
const FLASK_PORT = 8080;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
// the sync protocol About shows comes from protocol.json (the same source the component reads)
const PROTOCOL = Number(JSON.parse(readFileSync(path.join(REPO, 'protocol.json'), 'utf8')).protocol) || 1;

const DATA = mkdtempSync(path.join(tmpdir(), 'brand-pages-data-'));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(FLASK_PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-800)); stopBackend(); process.exit(1); }
const setupCode = readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();

const outDir = process.env.BRAND_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'brand-pages-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'brand-pages-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const png = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const setSize = (w, h, mobile = false) => app.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
const rgb = (s) => (parseCssColor(s) || []).slice(0, 3);   // any computed syntax (tests/helpers/color.mjs)
const near = (a, b, tol = 3) => a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const clickText = (text) => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);

const heroProbe = () => app.evaluate(`(() => {
  const page = document.querySelector('[data-testid="brand-page"]'); const hero = document.querySelector('[data-testid="brand-hero"]');
  const card = document.querySelector('.brand-form-card'); const foot = document.querySelector('[data-testid="brand-foot"]');
  if (!page || !hero || !card || !foot) return { missing: [!page && 'page', !hero && 'hero', !card && 'card', !foot && 'foot'].filter(Boolean).join(',') };
  const cs = (el) => getComputedStyle(el);
  return {
    pageBg: cs(page).backgroundColor, heroBg: cs(hero).backgroundColor, heroRadius: cs(hero).borderTopLeftRadius, cardBg: cs(card).backgroundColor, cardRadius: cs(card).borderTopLeftRadius,
    mark: !!hero.querySelector('svg[data-brand="mark"]'), wordmark: (hero.querySelector('.brand-wordmark') || {}).textContent, tagline: (hero.querySelector('[data-testid="brand-tagline"]') || {}).textContent,
    foot: foot.textContent, footLink: (foot.querySelector('a') || {}).href, footTarget: (foot.querySelector('a') || {}).target,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`);

async function brandPage(name) {
  for (const theme of ['light', 'dark']) {
    await setSize(1400, 900);
    await setTheme(theme);
    const p = await heroProbe();
    check(`${name} (${theme}): hero, form card and footer are present`, !p.missing, p.missing);
    if (p.missing) continue;
    check(`${name} (${theme}): the hero shows the mark, the wordmark and the tagline from package.json`, p.mark && p.wordmark === 'Jacarium' && p.tagline === pkg.description, `${p.wordmark} / ${p.tagline}`);
    check(`${name} (${theme}): the footer names the version and the website (opens in the browser)`, p.foot.includes(`Jacarium ${pkg.version}`) && p.foot.includes('jacarium.com') && /opens in your browser/.test(p.foot) && p.footLink === 'https://jacarium.com/' && p.footTarget === '_blank', p.foot);
    check(`${name} (${theme}): the hero has the 28 px radius`, p.heroRadius === '28px', p.heroRadius);
    if (theme === 'dark') {
      check(`${name} (dark): night-ink page, tinted hero, the form card takes the hero surface`, near(rgb(p.pageBg), [15, 13, 22]) && near(rgb(p.heroBg), [23, 20, 31]) && p.cardBg === p.heroBg, `${p.pageBg} / ${p.heroBg} / ${p.cardBg}`);
    } else {
      check(`${name} (light): lilac hero, the form card keeps the neutral surface`, near(rgb(p.heroBg), [246, 242, 255]) && p.cardBg !== p.heroBg && !near(rgb(p.cardBg), [246, 242, 255]), `${p.heroBg} / ${p.cardBg}`);
    }
    const f = await shot(`${name}-${theme}`);
    check(`${name} (${theme}) renders non-blank`, pixelSpread(f) > 40);
    await setSize(393, 852, true);
    await sleep(300);
    const phone = await heroProbe();
    check(`${name} (${theme}) phone: no horizontal overflow`, phone.overflow === false);
    await shot(`${name}-${theme}-phone393`);
  }
  await setSize(1400, 900);
  await setTheme('light');
}

try {
  await noMotion();
  // ---- the setup page (no account yet) ----
  const setup = await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]') && /Set up Jacarium/.test(document.body.textContent)`, 15000);
  check('the first-run setup page shows with the brand hero', !!setup);
  await brandPage('setup');

  // ---- the sign-in page: create the administrator over HTTP (with the cookie cleared the page asks to sign in) ----
  const created = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ setupCode: ${JSON.stringify(setupCode)}, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) }).then((r) => r.status)`);
  check('the synthetic administrator is created from the page', created === 201, String(created));
  await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'Jacarium' } }).then((r) => r.status)`);
  await app.send('Page.reload');
  await sleep(5000);
  await noMotion();
  const signin = await app.waitFor(`/Sign in to Jacarium/.test(document.body.textContent) && !!document.querySelector('[data-testid="brand-hero"]')`, 15000);
  check('after sign-out the sign-in page shows with the brand hero', !!signin);
  await brandPage('signin');

  // ---- signed in: the sidebar mark, What's New, Settings > About ----
  const signedIn = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ username: 'alice', password: 'alices password' }) }).then((r) => r.status)`);
  check('alice signs in over HTTP', signedIn === 200, String(signedIn));
  await app.send('Page.reload');
  await sleep(6000);
  await noMotion();
  await dismissWhatsNew(app);
  const mark = await app.waitFor(`!!document.querySelector('[data-testid="sidebar-brand-mark"] svg[data-brand="mark"]')`, 15000);
  check('the sidebar carries the mark at its top', !!mark);
  const sidebarMark = await app.evaluate(`(() => { const b = document.querySelector('[data-testid="sidebar-brand-mark"]'); const r = b.getBoundingClientRect(); const svg = b.querySelector('svg'); const s = svg.getBoundingClientRect(); const sep = b.nextElementSibling; return { w: r.width, h: r.height, mark: s.width, top: r.top, title: b.getAttribute('title'), separator: sep && sep.getAttribute('aria-hidden') === 'true', firstNav: !!document.querySelector('[data-testid="sidebar-brand-mark"] ~ div button') }; })()`);
  check('the mark is 36 px in a 48x44 slot above a separator and the navigation', sidebarMark.mark === 36 && sidebarMark.w === 48 && sidebarMark.h === 44 && sidebarMark.separator && sidebarMark.firstNav && /Settings/.test(sidebarMark.title), JSON.stringify(sidebarMark));
  await app.evaluate(`document.querySelector('[data-testid="sidebar-brand-mark"]').click()`);
  const settingsFromMark = await app.waitFor(`!!document.querySelector('[data-testid="settings-modal"]')`, 8000);
  check('a click on the sidebar mark opens Settings', !!settingsFromMark);
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(500);
  await app.evaluate(`window.dispatchEvent(new Event('toggleWhatsNew'))`);
  const wn = await app.waitFor(`(() => { const h = Array.from(document.querySelectorAll('*')).find((el) => el.textContent.trim().startsWith("What's New") && el.querySelector && el.querySelector('svg[data-brand="mark"]')); return !!h; })()`, 8000);
  check("What's New shows the mark in its header", !!wn);
  for (const theme of ['light', 'dark']) { await setTheme(theme); await shot(`whats-new-${theme}`); }
  await setTheme('light');
  await dismissWhatsNew(app);

  await app.evaluate(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'about' } }))`);
  const about = await app.waitFor(`!!document.querySelector('[data-testid="about-settings"]')`, 8000);
  check("Settings opens on the About category (openAppSettings 'about')", !!about);
  const rail = await app.evaluate(`(() => { const m = document.querySelector('[data-testid="settings-modal"]') || document.body; const labels = Array.from(m.querySelectorAll('button')).map((b) => b.textContent.trim()).filter((t) => ['General', 'Integrations', 'AI Providers', 'Users', 'Audit', 'About'].includes(t)); return labels; })()`);
  check('About is the last category in the rail', rail[rail.length - 1] === 'About', rail.join(' > '));
  const aboutProbe = await app.evaluate(`(() => { const a = document.querySelector('[data-testid="about-settings"]'); const link = a.querySelector('[data-testid="about-website"]'); return { tagline: (a.querySelector('[data-testid="about-tagline"]') || {}).textContent, version: ((a.querySelector('[data-testid="about-app-version"]') || {}).lastElementChild || {}).textContent, mark: !!a.querySelector('svg[data-brand="mark"]'), protocol: /Sync protocol\\s*${PROTOCOL}(?!\\d)/.test(a.textContent.replace(/\\s+/g, ' ')), server: /Home server\\s*Jacarium \\d+\\.\\d+\\.\\d+ \\(protocol \\d+\\)/.test(a.textContent.replace(/\\s+/g, ' ')), website: link && link.textContent, licence: /Licence\\s*AGPL-3\\.0/.test(a.textContent.replace(/\\s+/g, ' ')), downloads: !!a.querySelector('[data-testid="about-downloads"]'), whatsNew: Array.from(a.querySelectorAll('button')).some((b) => /What's New/.test(b.textContent)) }; })()`);
  check('About: mark, tagline from package.json, the app version', aboutProbe.mark && aboutProbe.tagline === pkg.description && aboutProbe.version === pkg.version, JSON.stringify(aboutProbe).slice(0, 200));
  check('About: sync protocol, the home server version (the server the browser runs on), licence AGPL-3.0', aboutProbe.protocol && aboutProbe.server && aboutProbe.licence, JSON.stringify(aboutProbe).slice(0, 200));
  check("About: What's New and the downloads page (a browser on the server) and the website link labelled as opening in the browser", aboutProbe.whatsNew && aboutProbe.downloads && /jacarium\.com/.test(aboutProbe.website) && /opens in your browser/.test(aboutProbe.website), aboutProbe.website);
  for (const theme of ['light', 'dark']) { await setTheme(theme); const f = await shot(`settings-about-${theme}`); check(`About (${theme}) renders non-blank`, pixelSpread(f) > 40); }
  await setTheme('light');
  await setSize(800, 900);
  await sleep(300);
  const overflow = await app.evaluate(`(() => { const m = document.querySelector('[data-testid="settings-modal"]'); return m ? m.scrollWidth > m.clientWidth + 2 : 'no modal'; })()`);
  check('About has no horizontal overflow at 800 px', overflow === false, String(overflow));
  await shot('settings-about-light-narrow');
  check('no runtime exception on the brand pages', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('brand pages run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
