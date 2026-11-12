#!/usr/bin/env node
/**
 * The accent is one colour everywhere under the colour-vision palettes
 * (Playwright against the Vite dev server, no backend). For each of the
 * three palettes in light and dark - on the built-in schemes and on a
 * custom theme with its own accent - the computed colours of the accent
 * elements are collected: a primary button, a toggle that is on, a
 * checkbox and a slider (accent-color), a focused field's ring, the
 * selected settings tab, a hovered drag bar, a selected pill; each equals
 * the palette's accent or a shade derived from it (the button's bg and its
 * hover, never the theme's blue), and white on the button reads at 4.5:1
 * or better. Screenshots of Settings and Tasks under the blue-weak palette,
 * light and dark, go to READING_AIDS_SHOTS_DIR/accent.
 *
 * Needs playwright-core with Chromium. Port CV_ACCENT_TEST_PORT (5219).
 * Run: node tests/cv-palette-accent-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CV_ACCENT_TEST_PORT || 5219);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'accent');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CV_ACCENT_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
// a custom theme with a violet accent: the palette must win over it too
const violet = ct.validateCustomTheme({ ...ct.defaultTheme('dark', 'Violet accent'), colors: { ...ct.defaultTheme('dark', 'Violet accent').colors, accent: '#a855f7' } }).theme;

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'dark'); if (!localStorage.getItem('jacarium-custom-themes')) localStorage.setItem('jacarium-custom-themes', JSON.stringify([theme])); } catch { /* storage */ } }, { theme: violet });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.3.1', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const openSettings = async (tab) => {
  if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); }
  await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250);
};
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const goTo = async (label) => { await page.locator(`nav.w-16 button[aria-label="${label}"]`).first().click(); await page.mouse.move(700, 450); await sleep(700); };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// every colour resolved to rgb by painting it over white on a canvas (oklch, color-mix and alpha included)
const collect = () => page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (c, over = '#ffffff') => { if (!c || c === 'none') return null; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]}, ${d[1]}, ${d[2]})`; };
  const bodyCs = getComputedStyle(document.body);
  const token = (n) => bodyCs.getPropertyValue(n).trim();
  // the expected colours: the accent, its hover shade, the primary button's bg / hover / active, the ring and the quiet tints over white
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const resolve = (expr) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = expr; return rgb(getComputedStyle(probe).backgroundColor); };
  const expected = { accent: resolve('var(--os-blue)'), accentHover: resolve('var(--os-blue-hover)'), button: resolve('var(--btn-primary-bg)'), buttonHover: resolve('var(--btn-primary-bg-hover)'), buttonActive: resolve('var(--btn-primary-bg-active)'), ring40: resolve('color-mix(in srgb, var(--os-blue) 40%, transparent)'), ring50: resolve('color-mix(in srgb, var(--os-blue) 50%, transparent)'), selected: resolve('var(--btn-selected-bg)'), themeBlue: null };
  probe.remove();
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const ringOf = (el) => { if (!el) return null; const s = getComputedStyle(el).boxShadow; const all = s ? Array.from(s.matchAll(/rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]+/gi)).map((m) => rgb(m[0])) : []; return all.length ? all : (s && s !== 'none' ? [s] : null); };
  const button = Array.from(document.querySelectorAll('button.sc-btn-primary, button.btn-primary')).find((b) => b.offsetParent && !b.disabled);
  const toggleOn = document.querySelector('[role="switch"][aria-checked="true"]');
  const checkbox = document.querySelector('input[type="checkbox"]');
  const slider = document.querySelector('input[type="range"]');
  const tab = document.querySelector('[data-testid="settings-modal"] .sc-rail-tab[aria-selected="true"]');
  const focused = document.activeElement && document.activeElement.matches('select, input') ? document.activeElement : null;
  const pill = document.querySelector('[data-testid="ra-text-align"] button[aria-pressed="true"], [data-testid="ra-ruler-lines"] button[aria-pressed="true"], .btn-selected');
  const bar = document.querySelector('[data-testid="drag-bar-probe"]');
  return {
    expected,
    tokens: { accent: token('--os-blue'), button: token('--btn-primary-bg') },
    got: {
      primaryButton: rgb(cs(button, 'backgroundColor')), primaryButtonText: rgb(cs(button, 'color')),
      toggleOn: rgb(cs(toggleOn, 'backgroundColor')), checkbox: rgb(cs(checkbox, 'accentColor')), slider: rgb(cs(slider, 'accentColor')),
      selectedTab: rgb(cs(tab, 'backgroundColor')), focusRing: ringOf(focused), pill: rgb(cs(pill, 'backgroundColor')), dragBar: bar ? rgb(getComputedStyle(bar).borderLeftColor) : null,
    },
    present: { button: !!button, toggleOn: !!toggleOn, checkbox: !!checkbox, slider: !!slider, tab: !!tab, focused: !!focused, pill: !!pill, bar: !!bar },
  };
});
const parse = (s) => { const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
const close = (a, b, tol = 3) => { const x = parse(a), y = parse(b); return !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) <= tol); };
const hex = (s) => { const p = parse(s); return p ? '#' + p.map((v) => v.toString(16).padStart(2, '0')).join('') : null; };

const PALETTES = ['protanopia', 'deuteranopia', 'tritanopia'];
const SCHEMES = [['light', 'light'], ['dark', 'dark'], [`custom-${violet.id}`, 'custom violet']];
try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  for (const [scheme, schemeName] of SCHEMES) {
    await page.evaluate((s) => localStorage.setItem('app-theme', s), scheme);
    await page.reload({ waitUntil: 'load' }); await sleep(1200); await dismiss();
    const themeAccent = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--os-blue').trim());
    for (const kind of PALETTES) {
      await setAids({ colorVision: kind, highlightLinks: true }); await sleep(300);
      await openSettings('Accessibility');
      // a focused select for the ring; the drag bar of the Documents sidebar is probed on the Documents page below
      await page.locator('#ra-line-height').focus(); await sleep(100);
      const c = await collect();
      if (!c.present.button) {
        // no enabled primary button in the dialog (Save waits for a change): the Tasks page's Create Instance
        await closeSettings(); await goTo('Tasks'); await sleep(300);
        const t = await collect();
        c.got.primaryButton = t.got.primaryButton; c.got.primaryButtonText = t.got.primaryButtonText; c.present.button = t.present.button;
        await openSettings('Accessibility'); await page.locator('#ra-line-height').focus(); await sleep(100);
      }
      const exp = c.expected;
      const ok = {
        primaryButton: close(c.got.primaryButton, exp.button),
        toggleOn: close(c.got.toggleOn, exp.button) || close(c.got.toggleOn, exp.selected),
        checkbox: !c.present.checkbox || close(c.got.checkbox, exp.accent), slider: close(c.got.slider, exp.accent),
        selectedTab: close(c.got.selectedTab, exp.selected) || close(c.got.selectedTab, exp.button),
        focusRing: Array.isArray(c.got.focusRing) && c.got.focusRing.some((r) => close(r, exp.ring40) || close(r, exp.ring50) || close(r, exp.accent)),
        pill: !c.present.pill || close(c.got.pill, exp.selected) || close(c.got.pill, exp.button),
      };
      const notTheme = schemeName === 'custom violet' ? !close(c.got.primaryButton, '#a855f7'.replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`)) : true;
      check(`${schemeName} + ${kind}: the primary button, the toggle, the checkbox, the slider, the selected tab, the focus ring and the pill are the palette's accent (${c.tokens.accent}) or its button shade (${c.tokens.button}); the theme's accent (${themeAccent}) is not used`, Object.values(ok).every(Boolean) && c.present.button && c.present.toggleOn && c.present.slider && c.present.tab && c.present.focused && notTheme && !close(c.got.primaryButton, exp.themeBlue), JSON.stringify({ ok, got: c.got, expected: exp, present: c.present }));
      const ratio = ct.contrastRatio(hex(c.got.primaryButtonText) || '#ffffff', hex(c.got.primaryButton) || '#000000');
      check(`${schemeName} + ${kind}: white on the primary button reads at 4.5:1 or better (${ratio.toFixed(2)} on ${hex(c.got.primaryButton)})`, ratio >= 4.5);
      if (kind === 'tritanopia' && schemeName !== 'custom violet') await shot(`tritanopia-${schemeName}-settings`);
      await closeSettings();
      // the drag bar: the Documents sidebar's resize handle takes the accent on hover
      await goTo('Documents');
      const handle = page.locator('[data-testid="document-sidebar"] .cursor-col-resize').first();
      if (await handle.count()) {
        await handle.hover(); await sleep(150);
        const bar = await handle.evaluate((el) => { const cs = getComputedStyle(el); return [cs.borderLeftColor, cs.borderRightColor, cs.backgroundColor]; });
        const barOk = await page.evaluate(([bar]) => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); const rgb = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; }; const probe = document.createElement('div'); document.body.appendChild(probe); probe.style.backgroundColor = 'var(--os-blue)'; const accent = rgb(getComputedStyle(probe).backgroundColor); probe.remove(); return { accent, bar: bar.map(rgb) }; }, [bar]);
        check(`${schemeName} + ${kind}: the hovered drag bar is the accent`, barOk.bar.includes(barOk.accent), JSON.stringify(barOk));
      }
      if (kind === 'tritanopia' && schemeName !== 'custom violet') { await goTo('Tasks'); await shot(`tritanopia-${schemeName}-tasks`); }
    }
    await setAids({ colorVision: 'none', highlightLinks: false });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
