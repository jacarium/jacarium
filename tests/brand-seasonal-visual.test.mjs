/**
 * The seasonal decorations of the mark, in the real browser, on every
 * theme: for each of none / pumpkin / Santa hat / New Year / 4 May (forced
 * through the localStorage preview knob, src/brand/seasonal/active.js) and
 * each of the eight themes (Light, Jacaranda, Dark neutral and the five
 * gradients, through the app's own `app-theme` setting) the sidebar mark
 * stays 36 px at the same spot in its 48 x 44 slot and the navigation below
 * it does not move (no layout shift), the decoration group overflows the
 * mark's box without being clipped by any scrolling or overflow-hidden
 * ancestor (the rail, the Settings modal around About), the decoration is
 * visibly there (the top-left corner and the About hero differ from the
 * undecorated ones by enough pixels), the hat is hit-testable above the
 * arch, and no runtime exception occurs.
 *
 * Screenshots land in SEASONAL_SHOTS_DIR (default: a temp dir): the
 * top-left corner (3x) and the About hero (2x) per decoration and theme,
 * a grid per decoration with all eight themes (grid-<id>.png: the themes in
 * columns under a header strip, the rail above the hero), and a side-by-side
 * close-up of the five marks at 256 px on the dark rail and on the light
 * About hero.
 *
 * Needs backend/venv, Chrome and ports 5173/8080 free; skips cleanly
 * otherwise. Synthetic data only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const VITE_PORT = 5173;
const FLASK_PORT = 8080;
const DECORATIONS = ['none', 'pumpkin', 'christmas', 'newyear', 'may-the-fourth'];
const LABEL = { none: 'no decoration', pumpkin: 'pumpkin', christmas: 'Santa hat', newyear: 'New Year', 'may-the-fourth': '4 May' };
const THEMES = [
  { key: 'light', name: 'Light' }, { key: 'dark', name: 'Jacaranda' }, { key: 'dark-neutral', name: 'Dark neutral' },
  { key: 'gradient-red-purple', name: 'Magma' }, { key: 'gradient-blue-purple', name: 'Nebula' }, { key: 'gradient-green-blue', name: 'Vulkan' },
  { key: 'gradient-orange-red', name: 'Sunset' }, { key: 'gradient-pink-purple', name: 'Aurora' },
];
const RAIL_CLIP = { x: 0, y: 0, width: 160, height: 110, scale: 3 };   // 480 x 330
const HERO_W = 320, HERO_SCALE = 1.5;                                  // the hero's left 320 px at 1.5x: 480 wide
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

const DATA = mkdtempSync(path.join(tmpdir(), 'brand-seasonal-data-'));
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

const outDir = process.env.SEASONAL_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'brand-seasonal-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'brand-seasonal-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const png = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
// pixels that differ clearly (more than 40 of 255 in a channel) between two same-sized screenshots
const differing = (fileA, fileB) => { const a = PNG.sync.read(readFileSync(fileA)), b = PNG.sync.read(readFileSync(fileB)); if (a.width !== b.width || a.height !== b.height) return -1; let n = 0; for (let i = 0; i < a.data.length; i += 4) { if (Math.abs(a.data[i] - b.data[i]) > 40 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 40 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 40) n++; } return n; };
const shot = async (name, clip) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);

// The mark in a container: its box, the decoration group's box, whether any
// overflow-clipping ancestor cuts the group, and the next sibling's box (the
// layout around the mark must not move when a decoration is on).
const markProbe = (container) => app.evaluate(`(() => {
  const c = document.querySelector(${JSON.stringify(container)}); if (!c) return { missing: 'container' };
  const svg = c.querySelector('svg[data-brand="mark"]'); if (!svg) return { missing: 'svg' };
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const g = svg.querySelector('[data-decoration]');
  let clipped = null;
  if (g) {
    const gb = g.getBoundingClientRect();
    for (let a = svg.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const ab = a.getBoundingClientRect();
      if (gb.left < ab.left - 1 || gb.top < ab.top - 1 || gb.right > ab.right + 1 || gb.bottom > ab.bottom + 1) { clipped = a.tagName + '.' + String(a.className).slice(0, 60); break; }
    }
  }
  const slot = c.closest('button') || c;
  const edge = getComputedStyle(svg).getPropertyValue('--decor-blade-edge').trim();
  return { svg: r(svg), slot: r(slot), decoration: g ? g.getAttribute('data-decoration') : null, group: g ? r(g) : null, overflow: svg.getAttribute('overflow'), clipped, next: slot.nextElementSibling ? r(slot.nextElementSibling) : null, outer: svg.outerHTML, edge, theme: document.documentElement.getAttribute('data-theme'), dark: document.documentElement.classList.contains('dark') };
})()`);

// the app reads both settings when it starts: set them, reload, land signed in on the documents page
const load = async (themeKey, id) => {
  await app.evaluate(`localStorage.setItem('app-theme', ${JSON.stringify(themeKey)}); localStorage.setItem('brand-decoration', ${JSON.stringify(id)}); true`);
  await app.send('Page.reload');
  await sleep(4500);
  await noMotion();
  await dismissWhatsNew(app);
  await app.waitFor(`!!document.querySelector('[data-testid="sidebar-brand-mark"] svg[data-brand="mark"]')`, 20000);
};
const openAbout = async () => {
  await app.evaluate(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'about' } }))`);
  return app.waitFor(`!!document.querySelector('[data-testid="about-settings"] svg[data-brand="mark"]')`, 8000);
};
const heroClip = async () => {
  const r = await app.evaluate(`(() => { const h = document.querySelector('[data-testid="about-settings"] .brand-hero'); const b = h.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
  return { x: Math.round(r[0]), y: Math.round(r[1]), width: Math.min(HERO_W, Math.round(r[2])), height: Math.round(r[3]), scale: HERO_SCALE };
};

// a grid per decoration: the header strip (theme names), then per theme column the rail clip over the hero clip
const headerStrip = async () => {
  const cells = THEMES.map((t) => `<div style="width:160px;text-align:center;font:600 11px Sora, sans-serif;line-height:20px;color:#15121F;background:#F6F2FF">${t.name}</div>`).join('');
  await app.evaluate(`(() => { document.querySelectorAll('[data-closeup]').forEach((n) => n.remove()); const d = document.createElement('div'); d.setAttribute('data-closeup', '1'); d.style.cssText = 'position:fixed;left:0;top:0;z-index:100000;display:flex;background:#F6F2FF'; d.innerHTML = ${JSON.stringify(cells)}; document.body.appendChild(d); return true; })()`);
  await sleep(200);
  const f = await shot('grid-header', { x: 0, y: 0, width: 160 * THEMES.length, height: 20, scale: 3 });
  await app.evaluate(`document.querySelectorAll('[data-closeup]').forEach((n) => n.remove()); true`);
  return PNG.sync.read(readFileSync(f));
};
const paste = (dst, src, x, y) => { for (let r = 0; r < src.height; r++) for (let c = 0; c < src.width; c++) { const si = (r * src.width + c) * 4, di = ((y + r) * dst.width + (x + c)) * 4; if (x + c >= dst.width || y + r >= dst.height) continue; dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = 255; } };
const buildGrid = (id, header, files) => {
  const col = 480, railH = 330;
  const heroH = Math.max(...files.map((f) => (f.hero ? PNG.sync.read(readFileSync(f.hero)).height : 0)), 1);
  const grid = new PNG({ width: col * THEMES.length, height: header.height + railH + heroH + 8 });
  grid.data.fill(255);
  paste(grid, header, 0, 0);
  files.forEach((f, i) => {
    if (f.rail) paste(grid, PNG.sync.read(readFileSync(f.rail)), i * col, header.height);
    if (f.hero) paste(grid, PNG.sync.read(readFileSync(f.hero)), i * col, header.height + railH + 8);
  });
  const out = path.join(outDir, `grid-${id}.png`);
  writeFileSync(out, PNG.sync.write(grid));
  return out;
};

const railMarkup = {};   // decoration -> the sidebar svg on Jacaranda (tone dark)
const aboutMarkup = {};  // decoration -> the About svg on Light (tone auto)
const baseline = {};     // theme -> { probe, rail, hero } of the undecorated mark
const grids = {};
try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await noMotion();
  await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]')`, 15000);
  const created = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ setupCode: ${JSON.stringify(setupCode)}, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) }).then((r) => r.status)`);
  check('the synthetic administrator is created and signed in', created === 201, String(created));
  const header = await headerStrip();

  for (const id of DECORATIONS) {
    const files = [];
    for (const t of THEMES) {
      const tag = `${id}-${t.key}`;
      await load(t.key, id);
      const p = await markProbe('[data-testid="sidebar-brand-mark"]');
      check(`${tag}: the sidebar mark is present on the theme (${t.name} applied)`, !p.missing && p.theme === t.key && p.dark === (t.key !== 'light'), p.missing || `${p.theme} dark=${p.dark}`);
      if (p.missing) { files.push({}); continue; }
      if (t.key === 'dark') railMarkup[id] = p.outer;
      check(`${tag}: the decoration group is ${id === 'none' ? 'absent' : 'present'}`, (p.decoration || 'none') === id, String(p.decoration));
      check(`${tag}: the mark is 36 px in its 48 x 44 slot`, p.svg[2] === 36 && p.svg[3] === 36 && p.slot[2] === 48 && p.slot[3] === 44, JSON.stringify([p.svg, p.slot]));
      const rail = await shot(`rail-${tag}`, RAIL_CLIP);
      check(`${tag}: the top-left corner renders non-blank`, pixelSpread(rail) > 40);
      if (id === 'none') {
        baseline[t.key] = { probe: p, rail };
        check(`${tag}: the plain mark has no overflow attribute`, p.overflow === null, String(p.overflow));
      } else {
        const b = baseline[t.key].probe;
        check(`${tag}: the mark sits exactly where the plain mark sits and the navigation below does not move`, JSON.stringify(p.svg) === JSON.stringify(b.svg) && JSON.stringify(p.slot) === JSON.stringify(b.slot) && JSON.stringify(p.next) === JSON.stringify(b.next), JSON.stringify([p.svg, b.svg, p.next, b.next]));
        check(`${tag}: the svg lets the decoration overflow (overflow="visible")`, p.overflow === 'visible', String(p.overflow));
        const g = p.group, s = p.svg;
        check(`${tag}: the decoration reaches beyond the mark's box`, g[0] < s[0] || g[1] < s[1] || g[0] + g[2] > s[0] + s[2] || g[1] + g[3] > s[1] + s[3], JSON.stringify([g, s]));
        check(`${tag}: no overflow-clipping ancestor cuts the decoration`, p.clipped === null, String(p.clipped));
        check(`${tag}: the sword's edge variable is ${t.key.startsWith('gradient-') ? 'the theme\'s deep tone' : t.key === 'light' ? 'the mid blue' : 'none'}`, t.key.startsWith('gradient-') ? /^#[0-9A-Fa-f]{6}$/.test(p.edge) && p.edge.toUpperCase() !== '#4F7BE8' : t.key === 'light' ? p.edge.toUpperCase() === '#4F7BE8' : p.edge === 'none', p.edge);
        const diff = differing(baseline[t.key].rail, rail);
        check(`${tag}: the decoration is visible in the top-left corner (${diff} pixels differ from the undecorated mark at 3x; >= 300 expected)`, diff >= 300, String(diff));
      }
      if (id === 'christmas' && t.key === 'dark') {
        // the hat's body is above the arch: a hit test 3 px above the svg's top edge, three quarters along, lands in the hat
        const hit = await app.evaluate(`(() => { const svg = document.querySelector('[data-testid="sidebar-brand-mark"] svg'); const b = svg.getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width * 0.72, b.top - 3); return el ? (el.closest('[data-decoration]') || {}).getAttribute?.('data-decoration') || el.tagName : null; })()`);
        check('christmas: the hat is hit-testable above the mark (not clipped by the rail)', hit === 'christmas', String(hit));
      }

      // Settings > About on the same theme
      const about = await openAbout();
      check(`${tag}: Settings > About shows the mark`, !!about);
      let hero = null;
      if (about) {
        const a = await markProbe('[data-testid="about-settings"] .brand-hero');
        if (t.key === 'light') aboutMarkup[id] = a.outer;
        check(`${tag}: About's mark is 56 px with the ${id === 'none' ? 'plain mark' : 'decoration'}`, a.svg[2] === 56 && (a.decoration || 'none') === id, JSON.stringify([a.svg, a.decoration]));
        if (id !== 'none') check(`${tag}: About's decoration is not clipped by the modal`, a.clipped === null, String(a.clipped));
        hero = await shot(`about-${tag}`, await heroClip());
        check(`${tag}: the About hero renders non-blank`, pixelSpread(hero) > 20);
        if (id === 'none') baseline[t.key].hero = hero;
        else { const diff = differing(baseline[t.key].hero, hero); check(`${tag}: the decoration is visible in the About hero (${diff} pixels differ at 1.5x; >= 150 expected)`, diff >= 150, String(diff)); }
      }
      files.push({ rail, hero });
    }
    grids[id] = buildGrid(id, header, files);
  }

  // ---- the close-ups: the five marks at 256 px side by side, on the rail surface (Jacaranda) and on the About hero (Light) ----
  const at256 = (svg) => svg.replace(/width="\d+" height="\d+"/, 'width="256" height="256"');
  const row = (markup, labelClass) => DECORATIONS.map((id) => `<div style="display:flex;flex-direction:column;align-items:center;gap:16px;width:260px">${at256(markup[id] || '')}<span class="${labelClass}" style="font:600 18px Sora, sans-serif">${LABEL[id]}</span></div>`).join('');
  const overlay = (inner, cls) => app.evaluate(`(() => { document.querySelectorAll('[data-closeup]').forEach((n) => n.remove()); const d = document.createElement('div'); d.setAttribute('data-closeup', '1'); d.className = ${JSON.stringify(cls)}; d.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;gap:16px;padding:40px'; d.innerHTML = ${JSON.stringify(inner)}; document.body.appendChild(d); return true; })()`);
  await load('dark', 'none');
  await overlay(row(railMarkup, 'text-white'), 'bg-os-rail');
  await sleep(300);
  const dark = await shot('closeup-dark');
  check('close-up (Jacaranda, rail surface) renders non-blank', pixelSpread(dark) > 40);
  await load('light', 'none');
  await overlay(row(aboutMarkup, 'brand-hero-title'), 'brand-hero');
  await sleep(300);
  const light = await shot('closeup-light');
  check('close-up (Light, About hero) renders non-blank', pixelSpread(light) > 40);
  await app.evaluate(`document.querySelectorAll('[data-closeup]').forEach((n) => n.remove()); localStorage.removeItem('brand-decoration'); localStorage.removeItem('app-theme'); true`);

  check('no runtime exception while cycling the decorations and themes', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('seasonal decorations run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
for (const [id, f] of Object.entries(grids)) console.log(`grid ${id}: ${f}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
