#!/usr/bin/env node
/**
 * Reduce motion, live (Playwright against the Vite dev server, no backend).
 * Settings > Accessibility > Everywhere > Reduce motion: Follow system
 * (the default) / On / Off, on this device. One switch - ra-reduce-motion on
 * <html> - and every animation and transition ends at once under it: the
 * sidebar column's slide and the zen overlay's, a spinner (animate-spin), a
 * skeleton (animate-pulse), a colour transition, the shared panel motion's
 * token; smooth scrolling asks scrollBehavior(). Follow system follows the
 * OS live (the media query's change event, no reload); Off keeps the
 * motion when the OS asks for less; the Calm profile reduces motion; the
 * Reading shortcut flips it once bound; the Settings control shows the
 * three choices. By default, with the OS not asking, nothing changes.
 *
 * Needs playwright-core with Chromium. Port REDUCE_MOTION_TEST_PORT (5236).
 * Run: node tests/reduce-motion-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.REDUCE_MOTION_TEST_PORT || 5236);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (REDUCE_MOTION_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

// the OS not asking for less motion: the default look must not change
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'no-preference', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const domClick = (locator) => locator.first().evaluate((el) => el.click());
const goTo = async (label) => { await domClick(page.locator(`nav.w-16 button[aria-label="${label}"]`)); await page.mouse.move(700, 450); await sleep(600); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const zen = (on) => page.evaluate(async (on) => { const m = await import('/src/utils/readingAids.js'); m.zenMode.set(on); }, on);
const ms = (v) => (/ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000);
// what the page's motion computes to right now: the switch, the sidebar column's slide, a spinner, a skeleton, a
// colour transition (probes injected once, so the measure is the stylesheet's and not a page's choice), the token,
// the scroll behaviour the scripts would ask for
const state = () => page.evaluate(async () => {
  const m = await import('/src/utils/readingAids.js');
  let probe = document.getElementById('rm-probe');
  if (!probe) {
    probe = document.createElement('div'); probe.id = 'rm-probe'; probe.style.cssText = 'position:fixed;left:-9999px;top:0';
    probe.innerHTML = '<span class="animate-spin inline-block">s</span><span class="animate-pulse inline-block">p</span><button type="button" class="transition-colors">t</button>';
    document.body.appendChild(probe);
  }
  const anim = (el) => { const cs = getComputedStyle(el); return { name: cs.animationName, duration: cs.animationDuration, count: cs.animationIterationCount }; };
  const column = document.querySelector('[data-side="left"][data-ra-area]');
  const overlay = document.querySelector('[data-testid="zen-sidebar-overlay"]');
  const root = getComputedStyle(document.documentElement);
  return {
    on: document.documentElement.classList.contains('ra-reduce-motion'),
    column: column ? anim(column) : null,
    overlay: overlay ? anim(overlay) : null,
    spin: anim(probe.children[0]), pulse: anim(probe.children[1]),
    transition: getComputedStyle(probe.children[2]).transitionDuration,
    token: root.getPropertyValue('--motion-panel-duration').trim(),
    scroll: m.scrollBehavior(),
    setting: m.loadReadingAids().reduceMotion,
  };
});
// the sidebar column has no motion of its own by design (the panel motion is none: src/index.css), so it reads the same
// either way; what moves is the rest
const moving = (s) => s.column && s.column.name === 'none' && s.spin.name !== 'none' && ms(s.spin.duration) >= 500 && s.spin.count === 'infinite' && s.pulse.count === 'infinite' && ms(s.transition) >= 100 && ms(s.token) === 0 && s.scroll === 'smooth' && !s.on;
const still = (s) => s.on && s.column && s.column.name === 'none' && ms(s.spin.duration) <= 0.01 && s.spin.count === '1' && s.pulse.count === '1' && ms(s.transition) <= 0.01 && ms(s.token) === 0 && s.scroll === 'auto';

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  await goTo('Tasks');
  let s = await state();
  check('by default (Follow system, the OS not asking): no switch on <html>; the sidebar column shows in place (the panel motion is none by design, token 0 ms), a spinner spins (infinite), a skeleton pulses, a colour transition lasts, scripts scroll smoothly', s.setting === 'system' && moving(s), JSON.stringify(s));

  // ---- On: everything ends at once
  await setAids({ reduceMotion: 'on' }); await sleep(300);
  s = await state();
  check('On: html.ra-reduce-motion; the column has no slide, the spinner and the skeleton stop (0.01 ms, one iteration), the transition ends at once, the panel token is 0 ms, scripts scroll without smoothing', still(s), JSON.stringify(s));
  await zen(true); await sleep(300);
  await domClick(page.locator('[data-testid="zen-sidebar-button"]')); await sleep(300);
  s = await state();
  check('On, zen: the sidebar overlay opens without the slide', s.overlay && s.overlay.name === 'none', JSON.stringify(s.overlay));
  await page.keyboard.press('Escape'); await zen(false); await sleep(300);

  // ---- Off: the motion stays even when the OS asks for less
  await setAids({ reduceMotion: 'off' }); await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(400);
  s = await state();
  check('Off with the OS asking for less motion: no switch, everything moves (the setting wins; no media query in the stylesheet)', moving(s), JSON.stringify(s));

  // ---- Follow system: the OS decides, live
  await setAids({ reduceMotion: 'system' }); await sleep(400);
  s = await state();
  check('Follow system with the OS asking: the switch is on, everything ends at once', still(s), JSON.stringify(s));
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(400);
  s = await state();
  check('...the OS stops asking: the switch goes, the motion is back - live, no reload (the media query\'s change event)', moving(s), JSON.stringify(s));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(400);
  s = await state();
  check('...and asks again: reduced again', still(s), JSON.stringify(s));
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(300);

  // ---- the Calm profile reduces motion; Default puts it back to Follow system
  await page.evaluate(async () => { const m = await import('/src/utils/readingAidProfiles.js'); m.applyProfile('calm'); }); await sleep(400);
  s = await state();
  check('the Calm profile: motion reduced (On) with its 60 % saturation and hidden images', s.setting === 'on' && still(s), JSON.stringify(s));
  await page.evaluate(async () => { const m = await import('/src/utils/readingAidProfiles.js'); m.applyProfile('default'); }); await sleep(400);
  s = await state();
  check('the Default profile: back to Follow system, the motion back', s.setting === 'system' && moving(s), JSON.stringify(s));

  // ---- the Settings control
  await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Accessibility' }).click(); await sleep(300);
  const seg = page.locator('[data-testid="ra-reduce-motion"]');
  const labels = await seg.locator('button').allTextContents();
  const pressed = async () => seg.locator('button[aria-pressed="true"]').textContent();
  check('Settings > Accessibility > Everywhere: Reduce motion offers Follow system / On / Off, Follow system pressed', labels.join() === 'Follow system,On,Off' && (await pressed()) === 'Follow system', labels.join());
  const group = await page.evaluate(() => { const seg = document.querySelector('[data-testid="ra-reduce-motion"]'); const grp = seg && seg.closest('[data-testid^="ra-group-"]'); return grp ? grp.getAttribute('data-testid') : null; });
  check('...in the Everywhere group', group === 'ra-group-app', String(group));
  await seg.locator('button', { hasText: 'On' }).click(); await sleep(400);
  s = await state();
  check('pressing On: the switch is on at once, the dialog\'s own transitions included', (await pressed()) === 'On' && still(s), JSON.stringify(s));
  await seg.locator('button', { hasText: 'Off' }).click(); await sleep(400);
  s = await state();
  check('pressing Off: the motion is back', (await pressed()) === 'Off' && moving(s), JSON.stringify(s));
  await seg.locator('button', { hasText: 'Follow system' }).click(); await sleep(300);
  await page.keyboard.press('Escape'); await sleep(300);

  // ---- the shortcut (unbound by default): bound to Mod+Alt+M it flips what is in effect
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const rowsBefore = await page.evaluate(async () => { const m = await import('/src/shortcuts/registry.js'); const a = m.ACTIONS.find((x) => x.id === 'reading.reduceMotion'); return a && m.defaultChord(a, 'mac') === null && m.defaultChord(a, 'other') === null; });
  check('the Reading shortcut "Reduce motion" has no default chord', rowsBefore === true);
  await page.evaluate(async () => { const m = await import('/src/shortcuts/store.js'); m.setOverrides({ ...m.getOverrides(), 'reading.reduceMotion': 'Mod+Alt+KeyM' }); });
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await page.keyboard.press(`${mod}+Alt+KeyM`); await sleep(400);
  s = await state();
  const first = s.setting;
  await page.keyboard.press(`${mod}+Alt+KeyM`); await sleep(400);
  const second = (await state()).setting;
  check('bound to Mod+Alt+M: the first press turns it On (Follow system with the OS not asking was off), the second Off', first === 'on' && second === 'off', JSON.stringify({ first, second }));
  await page.evaluate(async () => { const m = await import('/src/shortcuts/store.js'); const o = { ...m.getOverrides() }; delete o['reading.reduceMotion']; m.setOverrides(o); });
  await setAids({ reduceMotion: 'system' });

  // ---- a second context: the OS asking from the start, the default setting - reduced from the first paint
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
  await ctx2.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
  await ctx2.route('**/api/**', (r) => r.fulfill({ status: 404, json: {} })); await ctx2.route('**/socket.io/**', (r) => r.abort());
  const p2 = await ctx2.newPage(); await p2.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  const fromStart = await p2.evaluate(() => ({ on: document.documentElement.classList.contains('ra-reduce-motion'), token: getComputedStyle(document.documentElement).getPropertyValue('--motion-panel-duration').trim() }));
  check('a fresh window with the OS asking for less motion (Follow system): the switch is on from the start, the panel token 0 ms', fromStart.on && ms(fromStart.token) === 0, JSON.stringify(fromStart));
  await ctx2.close();
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
