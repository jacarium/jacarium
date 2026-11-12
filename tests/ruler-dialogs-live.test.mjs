#!/usr/bin/env node
/**
 * The reading ruler inside dialogs (Playwright against the Vite dev server,
 * no backend). With the ruler in Mask mode on the Documents page: opening
 * Settings moves the overlay into the dialog's layer (its z-index above the
 * dialog's), the mask dims the dialog and the page behind alike with only
 * the band bright: over a profile card's description the band is that one
 * text line (a tall card is no row; the grid never is), over the gap
 * between cards a free one-line band, over a nav item or a toggle its row;
 * the toggles under the mask stay clickable; closing Settings returns the
 * ruler to the page at z 40. The delete confirmation (a real action, no
 * server): the clip sits on the message block, the mask dims the rest, the
 * Cancel and Delete buttons sit outside the clip and Cancel works; the
 * ruler returns to the page.
 *
 * Needs playwright-core with Chromium. Port RULER_DIALOGS_TEST_PORT (5231).
 * Run: node tests/ruler-dialogs-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.RULER_DIALOGS_TEST_PORT || 5231);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (RULER_DIALOGS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('documentsReadingAids', JSON.stringify({ ruler: true, rulerMode: 'mask' })); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().evaluate((el) => el.click()); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const rect = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
const ruler = () => page.evaluate(() => {
  const c = document.querySelector('[data-testid="reading-ruler"]'); if (!c) return { mounted: false };
  const b = c.querySelector('[data-testid="reading-ruler-band"]'); const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
  const s = document.querySelector('[data-testid="reading-ruler-shade"]');
  const hole = s && !s.hidden && s.dataset.hole ? s.dataset.hole.split(',').map(Number) : null;
  return { mounted: true, hidden: c.hidden, z: getComputedStyle(c).zIndex, shadow: !!s && !s.hidden, shadeZ: s ? getComputedStyle(s).zIndex : null, hole: hole && { left: hole[0], top: hole[1], right: hole[2], bottom: hole[3] }, top: r.top, height: r.height, clip: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width, height: cr.height } };
});
// a point is dimmed when the shade is shown and the point lies outside its hole (the shade is fixed over the whole window)
const dimmed = (r, x, y) => r.shadow && (!r.hole || x < r.hole.left || x > r.hole.right || y < r.hole.top || y > r.hole.bottom);
const centre = (b) => b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
const lineHeightOf = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return 0; const lh = parseFloat(getComputedStyle(el).lineHeight); return Number.isFinite(lh) ? lh : parseFloat(getComputedStyle(el).fontSize) * 1.2; }, sel);
const within = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const openDeleteDialog = async () => {
  let row = page.locator('[data-side="left"] .sc-row', { hasText: /Untitled/ }).first();
  if (!(await row.count()) || !(await row.isVisible())) { await page.locator('[data-side="left"] button', { hasText: /^General/ }).first().click(); await sleep(400); row = page.locator('[data-side="left"] .sc-row', { hasText: /Untitled/ }).first(); }
  await row.click({ button: 'right' }); await sleep(300);
  const item = page.locator('button', { hasText: /^Delete Document$/ }).last();
  if (!(await item.count())) return false;
  await item.click(); await sleep(500);
  return (await page.locator('[data-testid="confirmation-modal"]').count()) > 0;
};

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('New Document', await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; }));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(500);
  await page.evaluate(() => { document.querySelector('.sc-editor-cm .cm-content').focus(); });
  await page.keyboard.insertText(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the page's text, long enough to read.`).join('\n')); await sleep(500);
  await page.mouse.move(700, 300); await sleep(200);
  let r = await ruler();
  const editor = await rect('.sc-editor-cm');
  check('on the page: the mask over the editor at z 40', r.mounted && !r.hidden && r.z === '40' && r.shadow && within(r.clip, { ...editor, left: editor.left - 2, right: editor.right + 2 }), JSON.stringify([r, editor]));
  const pageBandTop = r.top;

  // ---- Settings: the overlay in the dialog's layer; the mask dims the dialog and the page behind alike, the band on
  // the text line (a profile card is no row), a free band over a gap, the nav item's row; the controls stay usable
  await page.locator('[data-testid="sidebar-brand-mark"]').evaluate((el) => el.click());
  await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Accessibility' }).click(); await sleep(400);
  const body = await rect('[data-testid="settings-body"]');
  r = await ruler();
  const dialogBox = await rect('[data-testid="settings-modal"]');
  check('Settings open (the pointer on the nav tab it clicked): the overlay moves into the dialog\'s layer (z above 50), its clip inside the dialog', !r.hidden && parseInt(r.z, 10) > 50 && within(r.clip, { ...dialogBox, left: dialogBox.left - 2, top: dialogBox.top - 2, right: dialogBox.right + 2, bottom: dialogBox.bottom + 2 }), JSON.stringify([r, dialogBox]));
  const bodyLh = await lineHeightOf('[data-testid="settings-body"]');
  const pagePoint = { x: 12, y: 450 };   // the page behind the dialog (the rail)
  // a profile card's description line: the band is that one line, not the card and not the grid
  await page.locator('[data-testid="ra-profile-focus"]').scrollIntoViewIfNeeded(); await sleep(200);
  const card = await rect('[data-testid="ra-profile-focus"]');
  const desc = await rect('#ra-profile-focus-desc');
  const descLh = await lineHeightOf('#ra-profile-focus-desc');
  await page.mouse.move(desc.left + 30, desc.top + descLh / 2); await sleep(250);
  r = await ruler();
  check('the pointer over a profile card\'s description: the band is one text line tall (within 1.5 x its line height) at that line - the card (a tall radio) is no row', !r.hidden && parseInt(r.z, 10) > 50 && r.height <= descLh * 1.5 && r.top >= desc.top - 2 && r.top + r.height <= desc.top + descLh * 1.5 + 2 && r.height < card.height / 3, JSON.stringify({ r, desc, descLh, card }));
  const navCentre = centre(await rect('[data-testid="settings-modal"] .sc-rail-tab'));
  const otherCardCentre = centre(await rect('[data-testid="ra-profile-default"]'));
  check('... and the mask dims the rest of the dialog (the nav, another card) and the page behind', r.shadow && parseInt(r.shadeZ, 10) > 50 && dimmed(r, navCentre.x, navCentre.y) && dimmed(r, otherCardCentre.x, otherCardCentre.y) && dimmed(r, pagePoint.x, pagePoint.y) && r.hole && r.hole.top >= r.top - 1 && r.hole.bottom <= r.top + r.height + 1, JSON.stringify(r));
  // the gap between two cards: a free one-line band around the pointer
  const cardDefault = await rect('[data-testid="ra-profile-default"]');
  const cardComfortable = await rect('[data-testid="ra-profile-comfortable"]');
  const gapX = (cardDefault.right + cardComfortable.left) / 2; const gapY = cardDefault.top + cardDefault.height / 2;
  await page.mouse.move(gapX, gapY); await sleep(250);
  r = await ruler();
  check('the pointer over the gap between two cards: a free one-line band around the pointer, the mask still on', !r.hidden && r.shadow && r.height <= bodyLh * 1.5 && gapY >= r.top - 1 && gapY <= r.top + r.height + 1 && dimmed(r, pagePoint.x, pagePoint.y), JSON.stringify({ r, gapX, gapY, bodyLh }));
  check('the profile grid itself is never one row', r.height < cardDefault.height, JSON.stringify([r.height, cardDefault.height]));
  // the dialog's nav: the band snaps to the nav item under the pointer (the band follows everywhere in the dialog)
  const navItem = await rect('[data-testid="settings-modal"] .sc-rail-tab:nth-child(2), [data-testid="settings-modal"] .sc-rail-tab');
  await page.mouse.move(navItem.left + navItem.width / 2, navItem.top + navItem.height / 2); await sleep(250);
  r = await ruler();
  check('the pointer over a Settings nav item: the band snaps to the item\'s row, still in the dialog\'s layer', !r.hidden && parseInt(r.z, 10) > 50 && Math.abs(r.top - navItem.top) <= 2 && Math.abs(r.height - navItem.height) <= 2, JSON.stringify([r, navItem]));
  const cardCentre = centre(card); const toggleCentre = centre(await rect('[data-testid="ra-high-contrast"]'));
  check('... and the mask dims the body (a card, a toggle) and the page behind', r.shadow && dimmed(r, cardCentre.x, cardCentre.y) && dimmed(r, toggleCentre.x, toggleCentre.y) && dimmed(r, pagePoint.x, pagePoint.y), JSON.stringify(r));
  // the toggles under the mask stay clickable (the shade takes no pointer events)
  await page.locator('[data-testid="ra-high-contrast"]').scrollIntoViewIfNeeded(); await sleep(200);
  const toggle = await rect('[data-testid="ra-high-contrast"]');
  await page.mouse.move(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2); await sleep(200);
  r = await ruler();
  check('the pointer over a toggle: the toggle\'s row (a switch is row-like), the mask on', !r.hidden && r.shadow && Math.abs(r.top - toggle.top) <= 2 && Math.abs(r.height - toggle.height) <= 2, JSON.stringify([r, toggle]));
  const toggleBefore = await page.locator('[data-testid="ra-high-contrast"]').getAttribute('aria-checked');
  await page.mouse.click(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2); await sleep(300);
  const toggleAfter = await page.locator('[data-testid="ra-high-contrast"]').getAttribute('aria-checked');
  check('a control inside the Settings body is usable under the mask (the High contrast toggle flips on a real click)', toggleBefore !== toggleAfter, JSON.stringify([toggleBefore, toggleAfter]));
  await page.mouse.click(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2); await sleep(300);
  await page.locator('[data-testid="ra-greyscale"]').scrollIntoViewIfNeeded().catch(() => {}); await sleep(200);
  const greyscale = await rect('[data-testid="ra-greyscale"]');
  if (greyscale) {
    const before = await page.locator('[data-testid="ra-greyscale"]').getAttribute('aria-checked');
    await page.mouse.click(greyscale.left + greyscale.width / 2, greyscale.top + greyscale.height / 2); await sleep(300);
    const after = await page.locator('[data-testid="ra-greyscale"]').getAttribute('aria-checked');
    check('a second toggle (Greyscale) flips under the mask too', before !== after, JSON.stringify([before, after]));
    await page.mouse.click(greyscale.left + greyscale.width / 2, greyscale.top + greyscale.height / 2); await sleep(300);
  }
  await page.keyboard.press('Escape'); await sleep(500);
  r = await ruler();
  check('Settings closed: the ruler returns to the page at z 40, the mask over the editor again', !r.hidden && r.z === '40' && r.shadow && overlaps(r.clip, editor), JSON.stringify([r, editor, pageBandTop]));

  // ---- the delete confirmation: the mask within the message block, the buttons outside and usable
  check('the delete dialog opens from the sidebar', await openDeleteDialog());
  const dialog = await rect('[data-testid="confirmation-modal"]');
  const message = await rect('[data-testid="confirmation-modal"] .ra-reading');
  r = await ruler();
  check('the delete dialog: the overlay in the dialog\'s layer, the clip on the message block, the mask dimming the rest of the dialog and the page', !r.hidden && parseInt(r.z, 10) > 50 && r.shadow && message && within(r.clip, message) && within(r.clip, dialog) && dimmed(r, 12, 450), JSON.stringify([r, message]));
  const cancel = await page.locator('[data-testid="confirmation-modal"] button', { hasText: /^Cancel$/ }).boundingBox();
  const confirm = await page.locator('[data-testid="confirmation-modal"] button', { hasText: /^Delete$/ }).boundingBox();
  const cancelBox = cancel && { left: cancel.x, top: cancel.y, right: cancel.x + cancel.width, bottom: cancel.y + cancel.height };
  const confirmBox = confirm && { left: confirm.x, top: confirm.y, right: confirm.x + confirm.width, bottom: confirm.y + confirm.height };
  check('the Cancel and Delete buttons sit outside the clip (never under the mask)', cancelBox && confirmBox && !overlaps(cancelBox, r.clip) && !overlaps(confirmBox, r.clip), JSON.stringify([cancelBox, confirmBox, r.clip]));
  await page.locator('[data-testid="confirmation-modal"] button', { hasText: /^Cancel$/ }).click(); await sleep(500);
  r = await ruler();
  check('Cancel works; the ruler returns to the page', (await page.locator('[data-testid="confirmation-modal"]').count()) === 0 && !r.hidden && r.z === '40' && overlaps(r.clip, editor), JSON.stringify(r));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
