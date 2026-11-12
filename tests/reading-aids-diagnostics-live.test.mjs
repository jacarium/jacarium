#!/usr/bin/env node
/**
 * The app-wide reading aids inside the Diagnostics report frames (Playwright
 * against the Vite dev server and a throwaway Flask backend on a spare port,
 * the synthetic sosreport fixture of tests/helpers/diagnostics-driver -
 * no real data). The page's calls to the backend are proxied by the browser
 * (the backend's CORS list only knows :5173), so the shared ports stay
 * free. The report's tabs (a findings page, the Log Collection histogram, a
 * network page when the fixture has one, the Log Viewer) are opened with
 * OpenDyslexic at the widest spacing, then high contrast, then the
 * deuteranopia palette, and inside the sandboxed frame:
 *   - the report text carries the font and the spacing, the monospace parts
 *     (.ui-mono, .ui-code-lines, pre, td.ui-cmd) keep their font and none;
 *   - high contrast reaches the frame's <body> tokens (the card black /
 *     white, the text the opposite) and its charts' colours;
 *   - the palette's status tokens reach the frame (no green);
 *   - the findings carry their severity as text (a badge), not colour alone.
 * Screenshots go to READING_AIDS_SHOTS_DIR/diagnostics.
 *
 * SKIPS without Chrome, python3, backend/venv or when the ports are busy.
 * Ports: READING_AIDS_DIAG_PORT (5218) for Vite, +1000 for Flask.
 * Run: node tests/reading-aids-diagnostics-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.READING_AIDS_DIAG_PORT || 5218);
const FLASK = PORT + 1000;
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'diagnostics');
const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = async (why, cleanup) => { console.log(`SKIP: ${why}`); if (cleanup) await cleanup(); process.exit(0); };
if (process.env.SKIP_BROWSER_TESTS) await skip('SKIP_BROWSER_TESTS is set');
let pw;
try { pw = req('playwright-core'); } catch { await skip('playwright-core is not installed'); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT)) || !(await portFree(FLASK))) await skip(`port ${PORT} or ${FLASK} is busy (READING_AIDS_DIAG_PORT)`);
const python = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(python)) await skip('backend/venv is missing');
// the fixture (synthetic, no real data)
const fx = await new Promise((resolve) => { const r = spawn('python3', [path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'make_fixture.py')], { stdio: 'ignore' }); r.once('exit', (code) => resolve(code === 0 && fs.existsSync(path.join(FIXTURE_ROOT, FIXTURE_REPORT)))); r.once('error', () => resolve(false)); });
if (!fx) await skip('the synthetic diagnostics fixture could not be built (python3?)');
// Flask on the spare port
const token = randomBytes(16).toString('hex');
const flask = reapOnExit(spawn(python, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...process.env, APP_AUTH_TOKEN: token, PORT: String(FLASK), FLASK_DEBUG: '0' }, stdio: 'ignore' }));
let flaskReady = false;
for (let i = 0; i < 120 && !flaskReady; i++) { try { flaskReady = (await fetch(`http://127.0.0.1:${FLASK}/health`)).ok; } catch { await sleep(250); } if (flask.exitCode !== null) break; }
const stopFlask = () => { try { flask.kill('SIGTERM'); } catch { /* gone */ } };
if (!flaskReady) await skip('the Flask backend did not come up on the spare port', stopFlask);
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { await skip(`Chromium could not start (${String(e.message).split('\n')[0]})`, stopFlask); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } stopFlask(); };
if (!ready) await skip('the Vite dev server did not come up', stop);
fs.mkdirSync(OUT, { recursive: true });

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(({ dir }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'dark'); localStorage.setItem('diagnosticsReportsDirectory', dir); } catch { /* storage */ } }, { dir: FIXTURE_ROOT });
// the page talks to localhost:8080; the browser carries each call to the spare Flask with the token, and answers CORS itself
const cors = (origin) => ({ 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-app-token, authorization', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-credentials': 'true' });
await context.route(/^http:\/\/(localhost|127\.0\.0\.1):8080\//, async (route) => {
  const r = route.request();
  const origin = r.headers().origin || URL_.replace(/\/$/, '');
  if (r.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors(origin) }); return; }
  if (/\/socket\.io\//.test(r.url())) { await route.abort(); return; }
  try {
    const res = await route.fetch({ url: r.url().replace(/^http:\/\/(localhost|127\.0\.0\.1):8080/, `http://127.0.0.1:${FLASK}`), headers: { ...r.headers(), 'x-app-token': token } });
    const headers = { ...res.headers(), ...cors(origin) };
    delete headers['content-encoding']; delete headers['content-length'];
    await route.fulfill({ status: res.status(), headers, body: await res.body() });
  } catch (e) { await route.fulfill({ status: 502, body: String(e) }); }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const goTo = async (label) => { await page.locator(`nav.w-16 button[aria-label="${label}"]`).first().click(); await page.mouse.move(700, 450); await sleep(900); };
const tabLabels = () => page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()).filter(Boolean));
const openTab = async (label) => { const ok = await page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label); await sleep(3500); return ok; };
const reportFrame = async () => { for (let i = 0; i < 40; i++) { for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { if (await f.evaluate(() => !!document.getElementById('diagnostics-content') && document.body.textContent.trim().length > 50)) return f; } catch { /* detached */ } } await sleep(250); } return null; };
const frameProbe = (f) => f.evaluate(() => {
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const html = document.documentElement; const body = document.body;
  const textEl = document.querySelector('.ui-finding-title, .panel h2, .panel h3, #diagnostics-content td, #diagnostics-content p, #diagnostics-content li');
  const monoEl = document.querySelector('#diagnostics-content .ui-code-lines, #diagnostics-content .ui-mono, #diagnostics-content pre, #diagnostics-content td.ui-cmd');
  const badge = document.querySelector('.ui-finding .ui-badge');
  const bodyCs = getComputedStyle(body);
  return {
    htmlClasses: html.className, htmlStyle: html.getAttribute('style') || '',
    textFont: cs(textEl, 'fontFamily'), textLetter: cs(textEl, 'letterSpacing'), textTag: textEl && textEl.tagName + '.' + textEl.className,
    monoFont: cs(monoEl, 'fontFamily'), monoLetter: cs(monoEl, 'letterSpacing'), monoTag: monoEl && monoEl.tagName + '.' + monoEl.className,
    card: bodyCs.getPropertyValue('--os-card').trim(), text: bodyCs.getPropertyValue('--os-text-primary').trim(), good: bodyCs.getPropertyValue('--chart-good').trim(), bad: bodyCs.getPropertyValue('--chart-bad').trim(), warn: bodyCs.getPropertyValue('--chart-warn').trim(),
    panelBg: cs(document.querySelector('.panel'), 'backgroundColor'), contentColor: cs(document.getElementById('diagnostics-content'), 'color'),
    chartText: window.diagnosticsThemeColor ? window.diagnosticsThemeColor('text') : null,
    findings: document.querySelectorAll('.ui-finding').length, badgeText: badge ? badge.textContent.trim() : null,
    canvases: document.querySelectorAll('canvas').length,
  };
});
const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
const hueOf = (c) => { const p = ct.parseColor(c); if (!p) return null; const { r, g, b } = p; const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max - min < 24) return null; const d = max - min; let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  await goTo('Tools'); await goTo('Diagnostics');
  const opened = await page.evaluate(async (name) => { for (let i = 0; i < 80; i++) { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (b) { b.click(); return true; } await new Promise((r) => setTimeout(r, 250)); } return false; }, FIXTURE_REPORT);
  check('the synthetic report appears in the Diagnostics list and opens', opened);
  await sleep(2500);
  const labels = await tabLabels();
  console.log(`  tabs: ${labels.join(', ')}`);
  const pick = (cands) => cands.find((c) => labels.includes(c));
  const FINDINGS = pick(['System', 'Memory', 'Services', 'Processes']);
  const HISTOGRAM = pick(['Log Collection']);
  const NETWORK = pick(['Network', 'Networking', 'Network Configuration', 'NNCP', 'Interfaces']);
  const LOGVIEW = pick(['Log Viewer']);
  check('the report has tabs to walk (a findings page, the Log Collection histogram, a network page; the Log Viewer lives inside Log Collection in this fixture)', !!FINDINGS && !!HISTOGRAM && !!NETWORK, labels.join(', '));

  // ---- 1. OpenDyslexic at the widest spacing
  await setAids({ font: 'opendyslexic', letterSpacing: 0.2, wordSpacing: 0.6, highlightLinks: true }); await sleep(600);
  for (const [label, name] of [[FINDINGS, 'findings'], [HISTOGRAM, 'histogram'], [NETWORK, 'network'], [LOGVIEW, 'log-viewer']]) {
    if (!label) continue;
    if (!(await openTab(label))) { check(`${label}: opens`, false); continue; }
    const f = await reportFrame();
    if (!f) { check(`${label}: the report frame rendered`, false); continue; }
    const p = await frameProbe(f);
    check(`${label}: the frame's <html> carries ra-app and the --ra-* properties; its text is OpenDyslexic with the spacing; its monospace parts keep a mono font and no spacing`, /\bra-app\b/.test(p.htmlClasses) && /OpenDyslexic/.test(p.htmlStyle) && (!p.textFont || /OpenDyslexic/.test(p.textFont)) && (!p.textLetter || parseFloat(p.textLetter) >= 2) && (!p.monoFont || /Mono|monospace/.test(p.monoFont)) && (!p.monoLetter || /^(0px|normal)$/.test(p.monoLetter)), JSON.stringify(p));
    if (name === 'findings') check('the findings carry their severity as a badge with text, not colour alone', p.findings === 0 || /^[A-Z]{3,}$/.test(p.badgeText || ''), JSON.stringify([p.findings, p.badgeText]));
    await shot(`wide-${name}`);
    if (name === 'histogram') {
      // the Log Viewer and the Histogram open from this page's buttons, inside the frame
      for (const [button, sub] of [['Open Log Viewer', 'log-viewer'], ['Open Histogram', 'histogram-chart']]) {
        const ff = (await reportFrame()) || f; const b = ff.locator('button', { hasText: button });
        if (!(await b.count())) { check(`${button}: present`, false); continue; }
        await b.first().click().catch(() => {}); await sleep(3000);
        const g = (await reportFrame()) || f;
        const q = await frameProbe(g);
        check(`${button}: the frame keeps the font for its text and a mono font with no spacing for its lines / code (${q.monoTag || 'no mono element'})`, /OpenDyslexic/.test(q.htmlStyle) && (!q.monoFont || /Mono|monospace/.test(q.monoFont)) && (!q.monoLetter || /^(0px|normal)$/.test(q.monoLetter)), JSON.stringify(q));
        await shot(`wide-${sub}`);
        await openTab(label);
      }
    }
  }
  // ---- 2. high contrast
  await setAids({ font: 'default', letterSpacing: 0, wordSpacing: 0, highContrast: true }); await sleep(800);
  for (const [label, name] of [[FINDINGS, 'findings'], [HISTOGRAM, 'histogram'], [NETWORK, 'network']]) {
    if (!label) continue;
    if (!(await openTab(label))) continue;
    const f = await reportFrame();
    if (!f) { check(`${label}: the report frame rendered (high contrast)`, false); continue; }
    const p = await frameProbe(f);
    check(`${label}: high contrast reaches the frame - ra-high-contrast on its <html>, the card black and the text white on <body>, the panel painted black, the chart text white`, /\bra-high-contrast\b/.test(p.htmlClasses) && p.card === '#000000' && p.text === '#ffffff' && (!p.panelBg || p.panelBg === 'rgb(0, 0, 0)') && (!p.chartText || /#fff|255, 255, 255/i.test(p.chartText)), JSON.stringify(p));
    await shot(`high-contrast-${name}`);
    if (name === 'histogram') {
      const ff = (await reportFrame()) || f; const b = ff.locator('button', { hasText: 'Open Histogram' });
      if (await b.count()) { await b.first().click().catch(() => {}); await sleep(3000); const g = (await reportFrame()) || f; const q = await frameProbe(g); check('the Histogram in high contrast: the frame\'s chart text white, a canvas drawn', (!q.chartText || /#fff|255, 255, 255/i.test(q.chartText)) && q.canvases >= 0, JSON.stringify(q)); await shot('high-contrast-histogram-chart'); await openTab(label); }
    }
  }
  // ---- 3. the deuteranopia palette
  await setAids({ highContrast: false, colorVision: 'deuteranopia' }); await sleep(800);
  for (const [label, name] of [[FINDINGS, 'findings'], [HISTOGRAM, 'histogram'], [NETWORK, 'network']]) {
    if (!label) continue;
    if (!(await openTab(label))) continue;
    const f = await reportFrame();
    if (!f) continue;
    const p = await frameProbe(f);
    const hues = [p.good, p.warn, p.bad].map(hueOf);
    check(`${label}: the palette reaches the frame - ra-cv-deuteranopia on its <html>, good / warning / bad on <body> without green and apart`, /\bra-cv-deuteranopia\b/.test(p.htmlClasses) && hues.every((h) => h === null || Math.abs(h - 165) > 25) && p.good !== p.bad, JSON.stringify([p.htmlClasses, p.good, p.warn, p.bad]));
    await shot(`deuteranopia-${name}`);
  }
  // ---- 4. text size 150 %: the report's text and its monospace parts scale with it, the mono font kept
  await setAids({ colorVision: 'none', textScale: 150 }); await sleep(800);
  for (const [label, name] of [[FINDINGS, 'findings'], [HISTOGRAM, 'histogram']]) {
    if (!label) continue;
    if (!(await openTab(label))) continue;
    const f = await reportFrame();
    if (!f) continue;
    const sizes = await f.evaluate(() => { const root = document.getElementById('diagnostics-content'); const mono = document.querySelector('#diagnostics-content .ui-code-lines, #diagnostics-content .ui-mono, #diagnostics-content pre, #diagnostics-content td.ui-cmd'); return { root: root ? getComputedStyle(root).fontSize : null, mono: mono ? getComputedStyle(mono).fontSize : null, monoFont: mono ? getComputedStyle(mono).fontFamily : null, scale: document.documentElement.style.getPropertyValue('--ra-text-scale') }; });
    check(`${label} at 150 %: the frame carries the scale, its root text is 19.5 px (13 x 1.5)${sizes.mono ? `, its monospace part 18 px (12 x 1.5) in the mono font` : ''}`, sizes.scale === '1.5' && sizes.root === '19.5px' && (!sizes.mono || (sizes.mono === '18px' && /Mono|monospace/.test(sizes.monoFont))), JSON.stringify(sizes));
    await shot(`text-150-${name}`);
    if (name === 'histogram') { const ff = (await reportFrame()) || f; const b = ff.locator('button', { hasText: 'Open Log Viewer' }); if (await b.count()) { await b.first().click().catch(() => {}); await sleep(3000); await shot('text-150-log-viewer'); } }
  }
  await setAids({ textScale: 100 });
  // ---- 5. one scale for the whole report: the ratio of a table cell to the root text is the same at 100 % and under
  //         Low vision (150 %, interface scaled); the frame's own document never scrolls the parent
  const sizes = () => (async () => { const f = await reportFrame(); if (!f) return null; return f.evaluate(() => { const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null); const root = px(document.getElementById('diagnostics-content')); const td = px(document.querySelector('#diagnostics-content table td')); const badge = px(document.querySelector('#diagnostics-content .ui-badge')); const finding = px(document.querySelector('#diagnostics-content .ui-finding')); const head = px(document.querySelector('#diagnostics-content .ui-findings-head')); return { root, td, badge, finding, head, tdRatio: td && root ? td / root : null, badgeRatio: badge && root ? badge / root : null, findingRatio: finding && root ? finding / root : null }; }); })();
  if (FINDINGS && (await openTab(FINDINGS))) {
    const at100 = await sizes();
    await setAids({ textScale: 150, scaleChrome: true, highContrast: true, font: 'atkinson', highlightLinks: true }); await sleep(900);
    await openTab(FINDINGS);
    const atLv = await sizes();
    const same = (a, b) => a === null || b === null || Math.abs(a - b) < 0.02;
    check(`${FINDINGS}: under Low vision the report's root text is 1.5x (${at100 && at100.root} -> ${atLv && atLv.root} px) and the table cells, the findings rows and the badges keep their ratio to it (${at100 && at100.tdRatio && at100.tdRatio.toFixed(3)} / ${atLv && atLv.tdRatio && atLv.tdRatio.toFixed(3)})`, !!at100 && !!atLv && Math.abs(atLv.root - at100.root * 1.5) < 0.1 && same(at100.tdRatio, atLv.tdRatio) && same(at100.badgeRatio, atLv.badgeRatio) && same(at100.findingRatio, atLv.findingRatio), JSON.stringify({ at100, atLv }));
    const parentScroll = await page.evaluate(() => ({ scrollHeight: document.scrollingElement.scrollHeight, innerHeight }));
    check('...and the window does not scroll as a whole', parentScroll.scrollHeight === parentScroll.innerHeight, JSON.stringify(parentScroll));
    await shot('low-vision-findings');
    const cstates = labels.find((l) => /C States/.test(l));
    if (cstates && (await openTab(cstates))) { await shot('low-vision-c-states'); }
    await setAids({ textScale: 100, scaleChrome: false, highContrast: false, font: 'default', highlightLinks: false });
  }
  // ---- 6. the reading fonts inside the frame: the faces travel with the theme as data: URLs, so document.fonts.check
  //         is true in the frame's own document and its text, controls and tables carry the font; monospace stays mono
  const frameFonts = (family) => (async () => { const f = await reportFrame(); if (!f) return null; await f.evaluate(async () => { await document.fonts.ready; }); return f.evaluate((family) => { const cs = (el) => (el ? getComputedStyle(el).fontFamily : null); const first = (sel) => document.querySelector(sel); return { loaded: document.fonts.check(`16px "${family}"`), faceStyle: !!document.getElementById('ra-reading-font') && document.getElementById('ra-reading-font').textContent.includes(family), finding: cs(first('.ui-finding-title, .ui-finding')), td: cs(first('#diagnostics-content table td')), input: cs(first('#diagnostics-content input, #diagnostics-content select')), button: cs(first('#diagnostics-content button')), mono: cs(first('#diagnostics-content .ui-code-lines, #diagnostics-content .ui-mono, #diagnostics-content pre, #diagnostics-content td.ui-cmd')), sandbox: window.frameElement ? null : 'opaque' }; }, family); })();
  for (const [id, family] of [['lexend', 'Lexend'], ['opendyslexic', 'OpenDyslexic'], ['atkinson', 'Atkinson Hyperlegible']]) {
    await setAids({ font: id, letterSpacing: 0.05 }); await sleep(900);
    for (const [label, name] of [[FINDINGS, 'findings'], [HISTOGRAM, 'log collection'], [NETWORK, 'network']]) {
      if (!label || !(await openTab(label))) continue;
      const r = await frameFonts(family);
      const carries = (v) => !v || v.startsWith(`"${family}"`) || v.startsWith(family);
      check(`${family} in the ${name} frame: the face is in the frame (document.fonts.check true, the @font-face style present), the findings, cells, controls and buttons carry it, the monospace part stays mono`, !!r && r.loaded && r.faceStyle && carries(r.finding) && carries(r.td) && carries(r.input) && carries(r.button) && (!r.mono || /Mono|monospace/.test(r.mono)), JSON.stringify(r));
      if (name === 'log collection') { const ff = (await reportFrame()); const b = ff && ff.locator('button', { hasText: 'Open Log Viewer' }); if (b && (await b.count())) { await b.first().click().catch(() => {}); await sleep(2500); const lv = await frameFonts(family); check(`${family} in the Log Viewer: its controls carry the font, its lines stay mono`, !!lv && lv.loaded && carries(lv.input) && carries(lv.button) && (!lv.mono || /Mono|monospace/.test(lv.mono)), JSON.stringify(lv)); if (id === 'lexend') await shot('lexend-log-viewer'); } }
    }
  }
  const attrs = await page.evaluate(() => { const f = document.querySelector('iframe[srcdoc]'); return f ? { sandbox: f.getAttribute('sandbox'), csp: f.getAttribute('csp') } : null; });
  check('the frame keeps its sandbox (allow-scripts allow-downloads, no same-origin) and no CSP attribute was added', !!attrs && attrs.sandbox === 'allow-scripts allow-downloads' && attrs.csp === null, JSON.stringify(attrs));
  await setAids({ font: 'default', letterSpacing: 0 });
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
