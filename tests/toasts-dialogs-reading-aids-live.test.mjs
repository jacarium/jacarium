#!/usr/bin/env node
/**
 * Toasts and confirmation dialogs follow the reading aids (Playwright
 * against the Vite dev server, no backend). A toast is raised through the
 * app's window event (NOTIFY_EVENT); the confirmation dialogs come from
 * real actions that need no server: deleting a local document (the
 * sidebar's context menu) and switching scheme with unsaved Customize
 * changes (Settings > Theme). With line height 1.8, paragraph spacing, a
 * 60-character column and the text at 150 % / 200 % with the interface
 * scaled: the toast's and the dialogs' text reads at 1.8 x its size and is
 * capped at the column; the buttons keep the heights they had at the
 * defaults; nothing overflows the viewport; high contrast gives the text
 * and the buttons 7:1, each colour-vision palette 4.5:1.
 *
 * Needs playwright-core with Chromium. Port TOASTS_TEST_PORT (5230).
 * Run: node tests/toasts-dialogs-reading-aids-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.TOASTS_TEST_PORT || 5230);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1000) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (TOASTS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const resetAids = () => page.evaluate(async () => { const m = await import('/src/utils/readingAids.js'); m.resetReadingAids(); });
// the popup toasts are the confirm-type notifications (the others go to the history and the Notifications panel)
const toast = (detail) => page.evaluate((detail) => { window.dispatchEvent(new CustomEvent('jacariumNotify', { detail: { ...detail, type: 'confirm', confirmLabel: 'Retry', onConfirm: () => {} } })); }, detail);
const openSettings = async (tab) => { if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); } await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250); };
const closeSettings = async () => { while (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
// the text blocks, buttons and box of a toast or dialog
const probe = (rootSel) => page.evaluate((rootSel) => {
  const root = document.querySelector(rootSel); if (!root) return null;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (c, over) => { ctx.clearRect(0, 0, 1, 1); if (over) { ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1); } ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgBehind = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
  const contrast = (el) => { const bg = bgBehind(el); const fg = rgb(getComputedStyle(el).color, bg); const b = rgb(bg); const l1 = lum(fg), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10; };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = Array.from(root.querySelectorAll('p, .ra-reading, h3, h4')).filter(visible).map((el) => { const cs = getComputedStyle(el); return { t: (el.textContent || '').trim().slice(0, 30), tag: el.tagName, reading: el.classList.contains('ra-reading') || !!el.closest('.ra-reading'), fs: parseFloat(cs.fontSize), lh: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight), mw: cs.maxWidth, contrast: contrast(el) }; });
  const buttons = Array.from(root.querySelectorAll('button')).filter(visible).map((b) => ({ key: (b.getAttribute('data-testid') || b.textContent.trim().slice(0, 20)) + '/' + b.tagName, h: Math.round(b.getBoundingClientRect().height), contrast: contrast(b) }));
  const r = root.getBoundingClientRect();
  return { box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }, vw: window.innerWidth, vh: window.innerHeight, hScroll: document.documentElement.scrollWidth > window.innerWidth + 1, text, buttons };
}, rootSel);
const LH = 1.8;
const inView = (p) => p.box.left >= -1 && p.box.top >= -1 && p.box.right <= p.vw + 1 && p.box.bottom <= p.vh + 1 && !p.hScroll;
const readingOk = (p) => p.text.filter((t) => t.reading).every((t) => t.lh != null && Math.abs(t.lh - t.fs * LH) <= 1.5 && t.mw !== 'none');
// a labelled button scales with the interface (its text and padding are rem); an icon-only button (key "/BUTTON") scales
// less, its lucide icon being px by the app's convention: anywhere between its base height and the base times the scale
const buttonsSame = (a, b, u = 1) => { const m = new Map(a.map((c) => [c.key, c.h])); return b.filter((c) => { if (!m.has(c.key)) return false; const base = m.get(c.key); return c.key.startsWith('/') ? c.h < base - 1 || c.h > base * u + 2 : Math.abs(base * u - c.h) > 2; }).map((c) => `${c.key}: ${m.get(c.key)} x ${u} -> ${c.h}`); };
let lastSeen = '';
const TOAST = '.animate-slide-in-right';
const DIALOG = '[data-testid="confirmation-modal"]';

// the dialogs: deleting the local document through the sidebar's context menu; discarding Customize changes
const openDeleteDialog = async () => {
  // the document row sits under its category, which may be collapsed: expand it first
  let row = page.locator('[data-side="left"] .sc-row', { hasText: /Untitled/ }).first();
  if (!(await row.count()) || !(await row.isVisible())) {
    await page.locator('[data-side="left"] button', { hasText: /^General/ }).first().click(); await sleep(400);   // the category button ("General" + its count)
    row = page.locator('[data-side="left"] .sc-row', { hasText: /Untitled/ }).first();
    if (!(await row.count())) row = page.locator('[data-side="left"]').getByText(/Untitled/).first();
  }
  await row.click({ button: 'right' }); await sleep(300);
  const item = page.locator('button', { hasText: /^Delete Document$/ }).last();
  if (!(await item.count())) { lastSeen = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent.trim().slice(0, 20)).slice(-12).join(' | ')); return false; }
  await item.click(); await sleep(400);
  if (!(await page.locator(DIALOG).count())) lastSeen = 'no dialog after Delete';
  return (await page.locator(DIALOG).count()) > 0;
};
const closeDialog = async () => { const cancel = page.locator(`${DIALOG} button`, { hasText: /^Cancel$/ }).first(); if (await cancel.count()) await cancel.click(); else await page.keyboard.press('Escape'); await sleep(300); };
const openDiscardDialog = async () => {
  await openSettings('Theme');
  const name = page.locator('[data-testid="custom-theme-color-canvas-hex"]').first();   // a colour change makes the draft dirty (a name alone does not)
  if (!(await name.count())) { lastSeen = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="settings-modal"] [data-testid]')).map((e) => e.getAttribute('data-testid')).filter((t) => /theme|custom/.test(t)).join(' | ')); return false; }
  await name.fill('#123456'); await sleep(300);
  await page.locator('[data-testid="scheme-card-light"]').click(); await sleep(400);
  return (await page.locator(DIALOG).count()) > 0;
};

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  const nd = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; });
  check('New Document (a local document to delete)', nd);
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(500);

  // ---- baselines at the defaults
  await resetAids(); await sleep(300);
  await toast({ type: 'error', title: 'Export Failed', message: 'Failed to export the category to ZIP: the archive could not be written because the folder is read-only, and the export stopped before the first file.' });
  await sleep(400);
  const toastBase = await probe(TOAST);
  check('a toast raised through the window event shows, with its message a reading block', !!toastBase && toastBase.text.some((t) => t.reading && /Failed to export/.test(t.t)), JSON.stringify(toastBase && toastBase.text));
  await page.locator(`${TOAST} button`).first().click().catch(() => {}); await sleep(300);
  check('the delete dialog opens from the sidebar (a real action, no server)', await openDeleteDialog(), lastSeen);
  const deleteBase = await probe(DIALOG);
  check('the delete dialog: its message is a reading block, its buttons Cancel and Delete', !!deleteBase && deleteBase.text.some((t) => t.reading) && deleteBase.buttons.length >= 2, JSON.stringify(deleteBase));
  await closeDialog();
  const discardOpened = await openDiscardDialog();
  check('the discard dialog opens from Settings > Theme (Customize changes, then another scheme)', discardOpened, lastSeen);
  const discardBase = discardOpened ? await probe(DIALOG) : null;
  if (discardOpened) await closeDialog();
  await closeSettings();

  // ---- the reading options on, at 150 % and 200 % with the interface scaled
  for (const scale of [150, 200]) {
    await setAids({ lineHeight: LH, paragraphSpacing: 1.5, lineWidth: 60, textScale: scale, scaleChrome: true }); await sleep(500);
    await toast({ type: 'error', title: 'Export Failed', message: 'Failed to export the category to ZIP: the archive could not be written because the folder is read-only, and the export stopped before the first file.' });
    await sleep(400);
    const t = await probe(TOAST);
    check(`${scale} %: the toast's message reads at ${LH} x its size and is capped at the column; its buttons keep their heights (times the interface scale); the toast stays inside the viewport, no horizontal scroll`, !!t && readingOk(t) && buttonsSame(toastBase.buttons, t.buttons, scale / 100).length === 0 && inView(t), JSON.stringify({ t, diff: t && buttonsSame(toastBase.buttons, t.buttons, scale / 100) }));
    await page.locator(`${TOAST} button`).first().click().catch(() => {}); await sleep(300);
    check(`${scale} %: the delete dialog opens`, await openDeleteDialog());
    const d = await probe(DIALOG);
    check(`${scale} %: the delete dialog's message reads at ${LH} x and is capped; Cancel and Delete keep their heights (times the scale); the dialog stays inside the viewport`, !!d && readingOk(d) && buttonsSame(deleteBase.buttons, d.buttons, scale / 100).length === 0 && inView(d), JSON.stringify({ d, diff: d && buttonsSame(deleteBase.buttons, d.buttons, scale / 100) }));
    await closeDialog();
    if (discardBase) {
      check(`${scale} %: the discard dialog opens`, await openDiscardDialog());
      const g = await probe(DIALOG);
      check(`${scale} %: the discard dialog's message reads at ${LH} x and is capped; its buttons keep their heights (times the scale); inside the viewport`, !!g && readingOk(g) && buttonsSame(discardBase.buttons, g.buttons, scale / 100).length === 0 && inView(g), JSON.stringify({ g, diff: g && buttonsSame(discardBase.buttons, g.buttons, scale / 100) }));
      await closeDialog(); await closeSettings();
    }
  }
  await resetAids(); await sleep(300);

  // ---- high contrast 7:1, each palette 4.5:1: the text and the buttons of the toast and the delete dialog
  for (const [name, aids, min] of [['high contrast', { highContrast: true }, 7], ['red-weak', { colorVision: 'protanopia' }, 4.5], ['green-weak', { colorVision: 'deuteranopia' }, 4.5], ['blue-weak', { colorVision: 'tritanopia' }, 4.5]]) {
    await setAids({ highContrast: false, colorVision: 'none', ...aids }); await sleep(400);
    await toast({ type: 'error', title: 'Export Failed', message: 'Failed to export the category to ZIP: the folder is read-only.' }); await sleep(400);
    const t = await probe(TOAST);
    const tLow = t ? [...t.text.filter((x) => x.contrast < min), ...t.buttons.filter((b) => b.contrast < min)] : null;
    check(`${name}: the toast's text and buttons read at ${min}:1 or better`, !!t && tLow.length === 0, JSON.stringify(tLow));
    await page.locator(`${TOAST} button`).first().click().catch(() => {}); await sleep(300);
    check(`${name}: the delete dialog opens`, await openDeleteDialog());
    const d = await probe(DIALOG);
    const dLow = d ? [...d.text.filter((x) => x.contrast < min), ...d.buttons.filter((b) => b.contrast < min)] : null;
    check(`${name}: the delete dialog's text and buttons (Cancel, Delete) read at ${min}:1 or better`, !!d && dLow.length === 0, JSON.stringify(dLow));
    await closeDialog();
  }
  await resetAids();
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
