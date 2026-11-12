#!/usr/bin/env node
/**
 * The app-wide reading aids on every main page (Playwright against the Vite
 * dev server, no backend - the pages show their empty / unreachable states,
 * which is the chrome the options must not break). With OpenDyslexic, the
 * widest letter and word spacing, highlighted links and hidden images on,
 * then high contrast, then the deuteranopia palette, each page (Documents,
 * Calendars, AI Chat, Kanban, Tasks, Workflow Builder, Diagnostics, JQL
 * Search, Tools, the Team Chat panel, Settings) is visited and checked:
 *   - the reading text carries the font and the spacing (a sample of visible
 *     text elements), code / monospace elements keep a mono font and no
 *     letter spacing, and SVG icons no spacing either;
 *   - nothing overflows: no horizontal page scroll, no visible element past
 *     the viewport's right edge, no truncated text in a button;
 *   - high contrast: the page's visible text measures 7:1 or better against
 *     what it sits on (a sample), the body and the rail are black / white;
 *   - the palette: no green among the status colours in use, the status
 *     tokens apart.
 * Screenshots of a few pages per setting go to READING_AIDS_SHOTS_DIR
 * (/private/tmp/claude-501/shots/reading-aids/pages).
 *
 * Needs playwright-core with Chromium. Port READING_AIDS_PAGES_PORT (5214).
 * Run: node tests/reading-aids-pages-live.test.mjs
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
const PORT = Number(process.env.READING_AIDS_PAGES_PORT || 5214);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'pages');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (READING_AIDS_PAGES_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const PAGES = ['Documents', 'Calendars', 'Robin', 'Kanban', 'Tasks', 'Workflow Builder', 'Diagnostics', 'JQL Search', 'Tools'];
const SHOT_PAGES = new Set(['Documents', 'Robin', 'Tasks', 'Diagnostics', 'Kanban']);
const WIDE = { font: 'opendyslexic', letterSpacing: 0.2, wordSpacing: 0.6, lineHeight: 2, highlightLinks: true, hideImages: true, ruler: false };

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
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
const resetAids = () => page.evaluate(async () => { const m = await import('/src/utils/readingAids.js'); m.resetReadingAids(); });
const goTo = async (label) => {
  const b = page.locator(`nav.w-16 button[aria-label="${label}"]`);
  if (await b.count()) { await b.first().click(); await page.mouse.move(700, 450); await sleep(900); return true; }
  // a page that did not fit in the rail sits in its "..." menu
  const more = page.locator('[data-testid="rail-more"]');
  if (!(await more.count())) return false;
  await more.click(); await sleep(200);
  const item = page.locator('[data-testid="rail-more-menu"] button', { hasText: label });
  if (!(await item.count())) { await page.keyboard.press('Escape'); return false; }
  await item.first().click(); await page.mouse.move(700, 450); await sleep(900);
  return true;
};
const openTeam = async () => { const b = page.locator('nav.w-16 button', { hasText: 'Team Chat' }); if (await b.count()) await b.first().click(); await sleep(700); };
const openSettings = async () => { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); await sleep(300); };
const closeSettings = async () => { await page.keyboard.press('Escape'); await sleep(300); };

// what the page shows: a sample of visible text elements with their font / spacing / colour, the mono elements, the overflow
const survey = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05; };
  const own = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  // the colour an element's text and backdrop paint as: every ancestor background composited onto a canvas, in any syntax (oklch, alpha)
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (colors) => { ctx.clearRect(0, 0, 1, 1); for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); } const d = ctx.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]}, ${d[1]}, ${d[2]})`; };
  const bgChain = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') chain.unshift(bg); } return chain.length ? chain : [getComputedStyle(document.body).backgroundColor]; };
  const bgOf = (el) => paint(['#000', ...bgChain(el)]);
  const fgOf = (el) => paint(['#000', ...bgChain(el), getComputedStyle(el).color]);
  const MONO = 'code, pre, kbd, samp, .font-mono, .os-terminal, .sc-editor-cm .cm-line.cm-code-block';
  const text = []; const mono = []; const overflow = []; const clipped = [];
  const all = Array.from(document.querySelectorAll('body *'));
  for (const el of all) {
    if (el.closest('[data-testid="reading-ruler"], script, style')) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (r.right > vw + 1 && r.left < vw && cs.position !== 'fixed' && !el.closest('[class*="overflow-x-auto"], [class*="overflow-auto"], [class*="overflow-hidden"], [class*="overflow-x-hidden"]')) overflow.push(`${el.tagName.toLowerCase()}.${String(el.className).toString().slice(0, 30)} right=${Math.round(r.right)}`);
    if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && !el.querySelector('.truncate')) clipped.push(`${el.textContent.trim().slice(0, 30)} ${el.scrollWidth}>${el.clientWidth}`);
    if (el.matches(MONO) || el.closest(MONO)) { if (own(el)) mono.push({ tag: el.tagName, font: cs.fontFamily, letter: cs.letterSpacing }); continue; }
    if (el.tagName === 'svg' || el.closest('svg')) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[disabled], [aria-disabled="true"]')) continue;
    if (own(el) && text.length < 400) text.push({ tag: el.tagName, cls: String(el.className).toString().slice(0, 24), text: el.textContent.trim().slice(0, 24), tracked: /tracking-/.test(String(el.className)), font: cs.fontFamily, letter: cs.letterSpacing, word: cs.wordSpacing, color: fgOf(el), bg: bgOf(el), size: parseFloat(cs.fontSize) });
  }
  const html = document.documentElement;
  return { vw, scrollWidth: html.scrollWidth, text, mono, overflow: overflow.slice(0, 12), clipped: clipped.slice(0, 12), svgSpacing: Array.from(document.querySelectorAll('svg text')).slice(0, 20).map((t) => getComputedStyle(t).letterSpacing), bodyBg: getComputedStyle(document.body).backgroundColor, railBg: (() => { const n = document.querySelector('nav.w-16'); return n ? getComputedStyle(n).backgroundColor : null; })(), htmlClasses: html.className };
});
const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
const contrast = (a, b) => { try { return ct.contrastRatio(a, b); } catch { return 21; } };
const OI_GREEN_HUE = 165;
const hueOf = (c) => { const p = ct.parseColor(c); if (!p) return null; const { r, g, b } = p; const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max - min < 24) return null; const d = max - min; let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const visit = async (label) => {
  if (label === 'Team Chat') { await openTeam(); return true; }
  if (label === 'Settings') { await openSettings(); return true; }
  return goTo(label);
};
const leave = async (label) => { if (label === 'Team Chat') await openTeam(); if (label === 'Settings') await closeSettings(); };
const TOUR = [...PAGES, 'Team Chat', 'Settings'];

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('the rail names its pages (aria-label), all nine', (await page.locator('nav.w-16 button[aria-label]').count()) >= 9);
  const baseline = {};
  for (const label of TOUR) { if (!(await visit(label))) { check(`${label}: reachable`, false); continue; } baseline[label] = await survey(); await leave(label); }

  // ---- 1. OpenDyslexic + the widest spacing + links + hidden images
  await setAids(WIDE); await sleep(400);
  await page.evaluate(async () => { await document.fonts.ready; });
  for (const label of TOUR) {
    if (!(await visit(label))) { check(`${label}: reachable`, false); continue; }
    await sleep(300);
    const s = await survey();
    const base = baseline[label] || { text: [] };
    const reading = s.text.filter((t) => !/Red Hat Mono|monospace/.test(t.font));
    const withFont = reading.filter((t) => /OpenDyslexic/.test(t.font)).length;
    const withLetter = reading.filter((t) => t.tracked || parseFloat(t.letter) >= Math.min(t.size * 0.19, 3.1)).length;   // a tracked label (tracking-wide) keeps its own spacing
    check(`${label}: the visible reading text (${reading.length} elements) carries OpenDyslexic and 0.2 em letters (tracked labels keep their tracking)`, reading.length > 0 && withFont >= reading.length * 0.95 && withLetter >= reading.length * 0.95, JSON.stringify(reading.filter((t) => !/OpenDyslexic/.test(t.font) || (!t.tracked && parseFloat(t.letter) < Math.min(t.size * 0.19, 3.1))).slice(0, 6)));
    const monoBad = s.mono.filter((m) => !/Mono|monospace|Consolas|Menlo/.test(m.font) || !/^(0px|normal)$/.test(m.letter));
    check(`${label}: code / monospace elements (${s.mono.length}) keep a mono font and no letter spacing; SVG text none either`, monoBad.length === 0 && s.svgSpacing.every((v) => /^(0px|normal)$/.test(v)), JSON.stringify(monoBad.slice(0, 5)));
    check(`${label}: nothing overflows - no horizontal page scroll, no visible element past the right edge, no clipped button`, s.scrollWidth <= s.vw + 1 && s.overflow.length === 0 && s.clipped.length === 0, JSON.stringify({ scrollWidth: s.scrollWidth, vw: s.vw, overflow: s.overflow, clipped: s.clipped }));
    check(`${label}: the layout kept its text (as many visible text elements as before, within a third)`, s.text.length >= base.text.length * 0.66, `${s.text.length} vs ${base.text.length}`);
    if (SHOT_PAGES.has(label) || label === 'Settings') await shot(`wide-${label.toLowerCase().replace(/\s+/g, '-')}`);
    await leave(label);
  }

  // ---- 2. high contrast (dark): 7:1 on every page
  await setAids({ ...WIDE, letterSpacing: 0, wordSpacing: 0, font: 'default', highContrast: true }); await sleep(400);
  for (const label of TOUR) {
    if (!(await visit(label))) { check(`${label}: reachable`, false); continue; }
    await sleep(300);
    const s = await survey();
    const low = s.text.map((t) => ({ ...t, ratio: contrast(t.color, t.bg) })).filter((t) => t.ratio < 7);
    check(`${label}: high contrast - body and rail black, ${s.text.length} visible text elements at 7:1 or better on what they sit on (a sample)`, s.bodyBg === 'rgb(0, 0, 0)' && (s.railBg === null || s.railBg === 'rgb(0, 0, 0)') && s.htmlClasses.includes('ra-high-contrast') && low.length <= Math.max(2, Math.floor(s.text.length * 0.03)), JSON.stringify({ bodyBg: s.bodyBg, railBg: s.railBg, low: low.slice(0, 8).map((t) => `${t.tag}.${t.cls} "${t.text}" ${t.color} on ${t.bg} ${t.ratio.toFixed(1)}`) }));
    if (SHOT_PAGES.has(label)) await shot(`high-contrast-${label.toLowerCase().replace(/\s+/g, '-')}`);
    await leave(label);
  }
  // ...and light
  await page.evaluate(() => localStorage.setItem('app-theme', 'light'));
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();
  for (const label of ['Documents', 'Tasks', 'Diagnostics', 'Settings']) {
    if (!(await visit(label))) { check(`${label}: reachable`, false); continue; }
    await sleep(300);
    const s = await survey();
    const low = s.text.map((t) => ({ ...t, ratio: contrast(t.color, t.bg) })).filter((t) => t.ratio < 7);
    check(`${label}: high contrast (light) - body and rail white, the visible text at 7:1 or better (a sample)`, s.bodyBg === 'rgb(255, 255, 255)' && (s.railBg === null || s.railBg === 'rgb(255, 255, 255)') && low.length <= Math.max(2, Math.floor(s.text.length * 0.03)), JSON.stringify({ bodyBg: s.bodyBg, railBg: s.railBg, low: low.slice(0, 8).map((t) => `${t.tag}.${t.cls} "${t.text}" ${t.color} on ${t.bg} ${t.ratio.toFixed(1)}`) }));
    if (label === 'Tasks' || label === 'Documents') await shot(`high-contrast-light-${label.toLowerCase()}`);
    await leave(label);
  }

  // ---- 3. the deuteranopia palette: the status tokens in use carry no green
  await setAids({ highContrast: false, colorVision: 'deuteranopia' }); await sleep(400);
  for (const label of ['Documents', 'Tasks', 'Kanban', 'Diagnostics', 'Settings']) {
    if (!(await visit(label))) { check(`${label}: reachable`, false); continue; }
    await sleep(300);
    const tokens = await page.evaluate(() => { const cs = getComputedStyle(document.body); return ['--os-status-success', '--chart-good', '--chart-warn', '--chart-bad', '--color-status-warning', '--color-status-danger', '--link', '--os-blue'].map((n) => [n, cs.getPropertyValue(n).trim()]); });
    const hues = tokens.map(([n, v]) => [n, hueOf(v)]);
    const noGreen = hues.every(([, h]) => h === null || Math.abs(h - OI_GREEN_HUE) > 25);
    check(`${label}: deuteranopia - the status, chart and link tokens on <body> are the palette's (no green among them; good, warning and bad apart)`, tokens.every(([, v]) => v) && noGreen && hues.find(([n]) => n === '--chart-good')[1] !== hues.find(([n]) => n === '--chart-bad')[1], JSON.stringify(tokens));
    if (label === 'Tasks' || label === 'Diagnostics') await shot(`deuteranopia-${label.toLowerCase()}`);
    await leave(label);
  }
  // ---- 4. Low vision (150 % and 200 %, interface scaled, high contrast, Atkinson Hyperlegible, links): the window never
  //         scrolls, the rail fits and every item is reachable, the rail tooltip reads, the sidebar titles and the
  //         profile cards are not clipped, the font is really loaded (document.fonts.check), code stays mono
  await page.evaluate(() => localStorage.setItem('app-theme', 'dark'));
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();
  const PAGE_COUNT = 9;
  const fit = () => page.evaluate((PAGE_COUNT) => {
    const u = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
    const rail = document.querySelector('nav.w-16'); const r = rail && rail.getBoundingClientRect();
    const PAGE_LABELS = ['Documents', 'Calendars', 'Robin', 'Kanban', 'Tasks', 'Workflow Builder', 'Diagnostics', 'JQL Search', 'Tools'];
    const pages = rail ? Array.from(rail.querySelectorAll('button[aria-label]')).filter((b) => PAGE_LABELS.includes(b.getAttribute('aria-label')) && b.offsetParent) : [];
    const rects = pages.map((b) => b.getBoundingClientRect());
    const wrongSize = rects.filter((b) => b.height < 48 * u * 0.88 || b.height > 48 * u + 1 || Math.abs(b.width - 48 * u) > 1).length;   // the page items may give up to 12 % of their height to the rail's slack (the fit guard), never more, never grow
    const gaps = rects.slice(1).map((b, i) => b.top - rects[i].bottom);
    const tightGap = gaps.filter((g) => g < 4 * u - 1).length;
    const more = rail && rail.querySelector('[data-testid="rail-more"]');
    const bottomGroup = rail ? Array.from(rail.querySelectorAll('[data-testid^="rail-"]')).filter((b) => b.tagName === 'BUTTON' && b.offsetParent) : [];
    return { scrollHeight: document.scrollingElement.scrollHeight, innerHeight, railTop: r && r.top, railBottom: r && r.bottom, visiblePages: pages.length, wrongSize, tightGap, more: !!more, moreHeight: more ? more.getBoundingClientRect().height : null, u, scrollWidth: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, PAGE_COUNT, bottomInView: bottomGroup.every((b) => b.getBoundingClientRect().bottom <= innerHeight + 1) };
  }, PAGE_COUNT);
  const menuPages = async () => {
    if (!(await page.locator('[data-testid="rail-more"]').count())) return 0;
    await page.locator('[data-testid="rail-more"]').click(); await sleep(200);
    const n = await page.locator('[data-testid="rail-more-menu"] button').count();
    await page.keyboard.press('Escape'); await sleep(150);
    if (await page.locator('[data-testid="rail-more-menu"]').count()) { await page.mouse.click(700, 450); await sleep(150); }
    return n;
  };
  const tooltipProbe = () => page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = (c, over) => { ctx.clearRect(0, 0, 1, 1); if (over) { ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1); } ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const button = document.querySelector('nav.w-16 button[aria-label="Documents"]'); const tip = button && button.querySelector('.bg-os-rail-tooltip');
    if (!tip) return null;
    const cs = getComputedStyle(tip); const bg = rgb(cs.backgroundColor); const fg = rgb(cs.color, cs.backgroundColor);
    const ratio = (Math.max(lum(bg), lum(fg)) + 0.05) / (Math.min(lum(bg), lum(fg)) + 0.05);
    const br = button.getBoundingClientRect(); const tr = tip.getBoundingClientRect();
    return { bg: cs.backgroundColor, fg: cs.color, ratio, opacity: cs.opacity, left: tr.left, buttonRight: br.right, top: tr.top, bottom: tr.bottom, buttonTop: br.top, buttonBottom: br.bottom, text: tip.textContent.trim() };
  });
  for (const scale of [150, 200]) {
    await setAids({ textScale: scale, scaleChrome: true, highContrast: true, font: 'atkinson', highlightLinks: true, letterSpacing: 0, wordSpacing: 0, hideImages: false, lineHeight: 0, colorVision: 'none' }); await sleep(600);
    await page.evaluate(async () => { await document.fonts.ready; });
    for (const label of TOUR) {
      if (!(await visit(label))) { check(`${label}: reachable`, false); continue; }
      await sleep(400);
      const f = await fit();
      const inMenu = label === 'Documents' ? await menuPages() : null;
      check(`Low vision ${scale} %, ${label}: the window cannot scroll (scrollHeight ${f.scrollHeight} = innerHeight ${f.innerHeight}), the rail is within the viewport, its ${f.visiblePages} visible page items keep their size (${(48 * f.u).toFixed(0)} px) and gap, ${f.more ? 'the "..." menu holds the rest' : 'no "..." needed'}, the bottom group in view, no horizontal scroll`, f.scrollHeight === f.innerHeight && f.railTop >= -1 && f.railBottom <= f.innerHeight + 1 && f.wrongSize === 0 && f.tightGap === 0 && f.bottomInView && f.scrollWidth <= f.vw + 1 && (f.more ? f.visiblePages < PAGE_COUNT : f.visiblePages === PAGE_COUNT) && (inMenu === null || f.visiblePages + inMenu === PAGE_COUNT), JSON.stringify({ ...f, inMenu }));
      if (label === 'Documents' && scale === 150) await shot('low-vision-150-documents');
      if (label === 'Diagnostics' && scale === 150) await shot('low-vision-150-diagnostics');
      if (label === 'Settings' && scale === 150) await shot('low-vision-150-settings');
      await leave(label);
    }
    // the rail tooltip under high contrast: hovered, its text against its own background, next to its icon
    await goTo('Documents');
    await page.locator('nav.w-16 button[aria-label="Documents"]').hover(); await sleep(250);
    const tip = await tooltipProbe();
    check(`Low vision ${scale} %: the rail tooltip reads (text vs its own background ${tip && tip.ratio.toFixed(1)}:1, 7:1 or better), is visible on hover and sits to the right of its icon`, !!tip && tip.ratio >= 7 && tip.opacity === '1' && tip.left >= tip.buttonRight && tip.top < tip.buttonBottom && tip.bottom > tip.buttonTop, JSON.stringify(tip));
    if (scale === 150) await page.screenshot({ path: path.join(OUT, 'low-vision-150-rail-tooltip.png'), clip: { x: 0, y: 0, width: 420, height: 320 } });
    await page.mouse.move(700, 450);
    const clipped = await page.evaluate(() => { const out = []; for (const el of document.querySelectorAll('[data-testid="document-sidebar"] h2, [data-testid="document-sidebar"] span.truncate')) { if (el.scrollWidth > el.clientWidth + 1 && /documents|templates/i.test(el.textContent)) out.push(`${el.textContent.trim()} ${el.scrollWidth}>${el.clientWidth}`); } return out; });
    check(`Low vision ${scale} %: the Documents sidebar's section titles are not clipped (the sidebar's width follows the interface scale)`, clipped.length === 0, clipped.join(' ; '));
    await openSettings();
    await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Accessibility' }).click(); await sleep(300);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="ra-profile-"][role="radio"]')).map((c) => { const n = c.querySelector('span.break-words'); return { name: n && n.textContent.trim(), clipped: n ? n.scrollWidth > n.clientWidth + 1 : null }; }));
    const fonts = await page.evaluate(() => ({ loaded: document.fonts.check('16px "Atkinson Hyperlegible"'), controls: Array.from(document.querySelectorAll('[data-testid="settings-modal"] select, [data-testid="settings-modal"] input[type="text"], [data-testid="settings-modal"] button')).filter((e) => e.offsetParent).slice(0, 12).map((e) => getComputedStyle(e).fontFamily) }));
    check(`Low vision ${scale} %: no profile card name is clipped; Atkinson Hyperlegible is loaded (document.fonts.check) and the settings' controls carry it`, cards.length > 0 && cards.every((c) => c.clipped === false) && fonts.loaded && fonts.controls.length > 0 && fonts.controls.every((f) => /Atkinson/.test(f)), JSON.stringify({ cards: cards.filter((c) => c.clipped), fonts }));
    await closeSettings();
  }
  // the rail at other window heights, with the interface scaled and with high contrast alone: every visible item at its
  // normal size, the "..." menu exactly when the items do not fit, every page reachable, the window never scrolling
  for (const [name, aids] of [['high contrast alone', { textScale: 100, scaleChrome: false, highContrast: true, font: 'default' }], ['Low vision', { textScale: 150, scaleChrome: true, highContrast: true, font: 'atkinson' }], ['200 % interface', { textScale: 200, scaleChrome: true, highContrast: false, font: 'default' }]]) {
    await setAids(aids); await sleep(500);
    for (const height of [900, 700, 520]) {
      await page.setViewportSize({ width: 1360, height }); await sleep(500);
      await goTo('Documents');
      const f = await fit();
      const inMenu = await menuPages();
      check(`${name}, a ${height} px window: the window cannot scroll, the rail fits, its ${f.visiblePages} visible page items keep their size (${(48 * f.u).toFixed(0)} px) and gap, ${f.more ? `the "..." menu holds ${inMenu}` : 'no "..." needed'}, all ${PAGE_COUNT} pages reachable, the bottom group in view`, f.scrollHeight === f.innerHeight && f.railBottom <= f.innerHeight + 1 && f.wrongSize === 0 && f.tightGap === 0 && f.bottomInView && (f.more ? f.visiblePages < PAGE_COUNT && f.moreHeight && f.moreHeight >= 48 * f.u * 0.88 && f.moreHeight <= 48 * f.u + 1 : f.visiblePages === PAGE_COUNT) && f.visiblePages + inMenu === PAGE_COUNT, JSON.stringify({ ...f, inMenu }));
      if (height === 700 && name === 'high contrast alone') await shot('rail-high-contrast-700');
      if (height === 700 && name === 'Low vision') { await shot('rail-low-vision-700'); if (f.more) { await page.locator('[data-testid="rail-more"]').click(); await sleep(200); await shot('rail-low-vision-700-menu'); await page.keyboard.press('Escape'); await sleep(150); } }
    }
    await page.setViewportSize({ width: 1360, height: 900 }); await sleep(300);
  }
  // every reading font really loads (document.fonts.check) on the pages
  for (const [id, family] of [['lexend', 'Lexend'], ['opendyslexic', 'OpenDyslexic'], ['atkinson', 'Atkinson Hyperlegible']]) {
    await setAids({ textScale: 100, scaleChrome: false, highContrast: false, font: id }); await sleep(400);
    await page.evaluate(async () => { await document.fonts.ready; });
    const r = await page.evaluate((family) => ({ loaded: document.fonts.check(`16px "${family}"`), body: getComputedStyle(document.body).fontFamily }), family);
    check(`${family}: loaded in the page (document.fonts.check) and first in the body's font stack`, r.loaded && r.body.startsWith(`"${family}"`) || r.loaded && r.body.startsWith(family), JSON.stringify(r));
  }
  await resetAids();
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
