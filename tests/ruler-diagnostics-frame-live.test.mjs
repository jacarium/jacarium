#!/usr/bin/env node
/**
 * The reading ruler inside the Diagnostics report frames (Playwright, Vite
 * on a spare port, Flask on another with the synthetic sosreport fixture of
 * tests/helpers/diagnostics-driver). The report is a sandboxed, opaque-origin
 * srcdoc iframe: the parent never sees a pointer over it, so the frame
 * measures the line under its pointer or focus and posts it over the frame
 * bridge; the parent's one overlay draws over the frame's box. Checked on
 * several tabs: the band starts on the frame's first line when a tab
 * loads; the pointer over a table row inside the frame moves the band to
 * that row; another row moves it again; the mask covers the frame outside
 * the band; the pointer leaving keeps the band; scrolling the page keeps
 * the band on the same report line; keyboard focus inside the frame moves
 * it; a monospace / log line snaps to its own height; Highlight mode works;
 * switching tabs re-initialises it; the sandbox attributes are unchanged.
 *
 * Needs playwright-core with Chromium, backend/venv and python3. Ports
 * RULER_DIAG_PORT (5235) and +1000 for Flask.
 * Run: node tests/ruler-diagnostics-frame-live.test.mjs
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
const PORT = Number(process.env.RULER_DIAG_PORT || 5235);
const FLASK = PORT + 1000;
const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1000) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = async (why, cleanup) => { console.log(`SKIP: ${why}`); if (cleanup) await cleanup(); process.exit(0); };
if (process.env.SKIP_BROWSER_TESTS) await skip('SKIP_BROWSER_TESTS is set');
let pw;
try { pw = req('playwright-core'); } catch { await skip('playwright-core is not installed'); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT)) || !(await portFree(FLASK))) await skip(`port ${PORT} or ${FLASK} is busy (RULER_DIAG_PORT)`);
const python = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(python)) await skip('backend/venv is missing');
const fx = await new Promise((resolve) => { const r = spawn('python3', [path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'make_fixture.py')], { stdio: 'ignore' }); r.once('exit', (code) => resolve(code === 0)); r.once('error', () => resolve(false)); });
if (!fx) await skip('the synthetic diagnostics fixture could not be built (python3?)');
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

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(({ dir }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('diagnosticsReportsDirectory', dir); localStorage.setItem('documentsReadingAids', JSON.stringify({ ruler: true, rulerMode: 'mask' })); } catch { /* storage */ } }, { dir: FIXTURE_ROOT });
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
const openTab = async (label) => { const ok = await page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label); await sleep(2500); return ok; };
const reportFrame = async () => { for (let i = 0; i < 40; i++) { for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { if (await f.evaluate(() => !!document.getElementById('diagnostics-content') && document.body.textContent.trim().length > 50)) return f; } catch { /* detached */ } } await sleep(250); } return null; };
const frameBox = async () => { const b = await page.locator('iframe[data-ra-frame]').first().boundingBox(); return b && { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height }; };
const ruler = () => page.evaluate(() => {
  const c = document.querySelector('[data-testid="reading-ruler"]'); if (!c) return { mounted: false };
  const b = c.querySelector('[data-testid="reading-ruler-band"]'); const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
  return { mounted: true, hidden: c.hidden, shadow: (() => { const s = document.querySelector('[data-testid="reading-ruler-shade"]'); return !!s && !s.hidden; })(), top: r.top, height: r.height, clip: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width, height: cr.height }, vh: window.innerHeight };
});
// a row / cell / line inside the frame, in page coordinates
const inFrameBox = async (f, selector, nth = 0) => { const el = f.locator(selector).nth(nth); if (!(await el.count())) return null; await el.scrollIntoViewIfNeeded().catch(() => {}); const b = await el.boundingBox(); return b && { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height }; };
const overlaps = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const bandOn = (r, box) => box && r.top + r.height > box.top - 2 && r.top < box.bottom + 2;   // the band's line within the element's vertical extent
const visibleFrame = (fb, vh) => fb && { left: fb.left, top: Math.max(0, fb.top), right: fb.right, bottom: Math.min(vh, fb.bottom) };
const within = (a, b) => a.left >= b.left - 2 && a.top >= b.top - 2 && a.right <= b.right + 2 && a.bottom <= b.bottom + 2;

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
  const TABS = [pick(['System', 'Memory', 'Services', 'Processes']), pick(['Log Collection']), pick(['Network', 'Networking', 'Network Configuration', 'NNCP', 'Interfaces']), pick(['Disk', 'Storage', 'C States', 'PCI Devices', 'System Information'])].filter(Boolean);
  check(`the report has several tabs to walk (${TABS.join(', ')})`, TABS.length >= 3, labels.join(', '));
  check('the sandbox attributes are unchanged (allow-scripts allow-downloads, no allow-same-origin)', (await page.locator('iframe[data-ra-frame]').first().getAttribute('sandbox')) === 'allow-scripts allow-downloads');

  let firstTab = true;
  for (const tab of TABS) {
    if (!(await openTab(tab))) { check(`${tab}: the tab opens`, false); continue; }
    const f = await reportFrame();
    check(`${tab}: the report frame is up`, !!f);
    if (!f) continue;
    await sleep(500);
    let fb = await frameBox(); let r = await ruler();
    check(`${tab}: when the tab loads the overlay is over the frame (its clip the frame's visible box, the mask on) with the band on the frame's first line, before any pointer`, r.mounted && !r.hidden && r.shadow && within(r.clip, visibleFrame(fb, r.vh)) && bandOn(r, { top: fb.top, bottom: fb.top + 200 }), JSON.stringify({ r, fb }));
    // a table row (or the first text block) under the pointer
    const rowSel = '#diagnostics-content tbody tr td, #diagnostics-content .ui-finding, #diagnostics-content p, #diagnostics-content li';
    const row1 = await inFrameBox(f, rowSel, 0); const row2 = await inFrameBox(f, rowSel, 2);
    if (row1) { await page.mouse.move(row1.left + Math.min(40, row1.width / 2), row1.top + row1.height / 2); await sleep(350); }
    r = await ruler(); fb = await frameBox();
    check(`${tab}: the pointer over a row inside the frame moves the band to that row's line (the band stays inside the frame's clip)`, row1 && bandOn(r, row1) && within(r.clip, visibleFrame(fb, r.vh)), JSON.stringify({ r, row1 }));
    const top1 = r.top;
    if (row2 && Math.abs(row2.top - row1.top) > 4) { await page.mouse.move(row2.left + Math.min(40, row2.width / 2), row2.top + row2.height / 2); await sleep(350); }
    r = await ruler();
    check(`${tab}: another row moves the band again`, !row2 || Math.abs(row2.top - row1.top) <= 4 || (bandOn(r, row2) && Math.abs(r.top - top1) > 2), JSON.stringify({ r, row2, top1 }));
    // non-text content (a chart's canvas): the band follows the pointer freely - centred on it - and snaps again over text
    const chart = await inFrameBox(f, '#diagnostics-content canvas', 0);
    if (chart && chart.height > 60) {
      const centres = [];
      for (const frac of [0.25, 0.5, 0.75]) {
        const y = chart.top + chart.height * frac;
        await page.mouse.move(chart.left + chart.width / 2, y); await sleep(350);
        const rc = await ruler();
        centres.push({ y: Math.round(y), band: Math.round(rc.top + rc.height / 2), hidden: rc.hidden });
      }
      check(`${tab}: the pointer over the chart moves the band with it (its centre on the pointer at three heights: ${centres.map((c) => `${c.y}->${c.band}`).join(', ')})`, centres.every((c) => !c.hidden && Math.abs(c.band - c.y) <= 2) && centres[0].band < centres[1].band && centres[1].band < centres[2].band, JSON.stringify(centres));
      if (row1) { await page.mouse.move(row1.left + Math.min(40, row1.width / 2), row1.top + row1.height / 2); await sleep(350); }
      r = await ruler();
      check(`${tab}: back over a row the band snaps to the row's line again`, row1 && bandOn(r, row1), JSON.stringify({ r, row1 }));
    } else {
      console.log(`  ${tab}: no chart canvas on this tab (the free band is covered on the tab that has one)`);
    }
    // the pointer leaves the window: the band stays
    const before = (await ruler()).top;
    await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: -10, clientY: -10, bubbles: true, pointerType: 'mouse' })); }); await sleep(300);
    r = await ruler();
    check(`${tab}: the pointer leaving the window keeps the band where it was, the mask still on`, !r.hidden && r.shadow && Math.abs(r.top - before) < 1, JSON.stringify([before, r.top]));
    // scrolling the page: the band stays on the same report line (moves with the frame), the clip follows the frame's visible box
    const scrolled = await page.evaluate(() => { let el = document.querySelector('iframe[data-ra-frame]'); for (let n = el && el.parentElement; n; n = n.parentElement) { const cs = getComputedStyle(n); if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 100) { const from = n.scrollTop; n.scrollTop = from + 120; return n.scrollTop - from; } } return 0; });
    await sleep(350);
    const after = await ruler(); fb = await frameBox();
    check(`${tab}: scrolling the page by ${scrolled} px keeps the band on the same report line (it moves with the frame) and the clip on the frame's visible box`, scrolled === 0 || (Math.abs((before - after.top) - scrolled) <= 2 && within(after.clip, visibleFrame(fb, after.vh))), JSON.stringify({ before, after: after.top, scrolled, clip: after.clip, fb }));
    // keyboard focus inside the frame moves the band
    const focusable = f.locator('#diagnostics-content button, #diagnostics-content a[href], #diagnostics-content [tabindex="0"], #diagnostics-content input, #diagnostics-content th[tabindex]').first();
    if (await focusable.count()) {
      await focusable.scrollIntoViewIfNeeded().catch(() => {});
      await focusable.focus(); await sleep(350);
      const fbox = await focusable.boundingBox(); r = await ruler();
      check(`${tab}: keyboard focus inside the frame moves the band to the focused element's line`, fbox && bandOn(r, { top: fbox.y, bottom: fbox.y + fbox.height }), JSON.stringify({ r, fbox }));
    }
    if (firstTab) {
      // a monospace / log line snaps to its own height; Highlight mode works too
      const mono = await inFrameBox(f, '#diagnostics-content .ui-code-lines > *, #diagnostics-content pre, #diagnostics-content td.ui-cmd, #diagnostics-content code', 0);
      if (mono) {
        await page.mouse.move(mono.left + 20, mono.top + Math.min(10, mono.height / 2)); await sleep(350);
        r = await ruler();
        const lh = await f.evaluate((sel) => { const el = document.querySelector(sel); const lh = parseFloat(getComputedStyle(el).lineHeight); return Number.isFinite(lh) ? lh : el.getBoundingClientRect().height; }, '#diagnostics-content .ui-code-lines > *, #diagnostics-content pre, #diagnostics-content td.ui-cmd, #diagnostics-content code');
        check(`${tab}: a monospace line snaps: the band is one line of it tall (${lh.toFixed(1)} px) and on it`, bandOn(r, mono) && Math.abs(r.height - lh) <= 2, JSON.stringify({ r, mono, lh }));
      }
      await setAids({ ruler: true, rulerMode: 'highlight' }); await sleep(400);
      if (row1) { await page.mouse.move(row1.left + 40, row1.top + row1.height / 2); await sleep(350); }
      r = await ruler();
      check(`${tab}: Highlight mode: the band (no mask) follows the pointer over the row`, !r.hidden && !r.shadow && row1 && bandOn(r, row1), JSON.stringify({ r, row1 }));
      await setAids({ ruler: true, rulerMode: 'mask' }); await sleep(400);
      firstTab = false;
    }
  }
  // ---- the section nav (the page's sidebar) is a reading area: the band follows the pointer onto it, clipped to the
  //      sidebar, and back over a frame row the frame's line takes over again
  const nav = await page.locator('[data-side][data-ra-area]').first().boundingBox();
  const navItem = await page.locator('[data-side][data-ra-area] span', { hasText: /Processes|PCI Devices|Services|System Information/ }).first().boundingBox();
  if (navItem) { await page.mouse.move(navItem.x + 10, navItem.y + navItem.height / 2); await sleep(350); }
  let rn = await ruler();
  check('Diagnostics: the pointer over a section-nav item puts the band on it, the mask clipped to the sidebar', !!nav && !!navItem && rn.top <= navItem.y + navItem.height + 1 && rn.top + rn.height >= navItem.y - 1 && Math.abs(rn.clip.left - nav.x) <= 2 && rn.clip.width <= nav.width + 2, JSON.stringify({ rn, nav, navItem }));
  const fLast = await reportFrame();
  const rowBack = fLast ? await inFrameBox(fLast, '#diagnostics-content tbody tr td, #diagnostics-content .ui-finding, #diagnostics-content p, #diagnostics-content li', 1) : null;
  if (rowBack) { await page.mouse.move(rowBack.left + 40, rowBack.top + rowBack.height / 2); await sleep(400); }
  rn = await ruler(); const fbLast = await frameBox();
  check('Diagnostics: back over a frame row the frame\'s line takes the band again, clipped to the frame', !!rowBack && bandOn(rn, rowBack) && within(rn.clip, visibleFrame(fbLast, rn.vh)), JSON.stringify({ rn, rowBack }));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
