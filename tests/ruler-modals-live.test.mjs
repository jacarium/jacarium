#!/usr/bin/env node
/**
 * The reading ruler inside the modals that used to be plain fixed panels
 * (Playwright against the Vite dev server, no backend). With the ruler in
 * Mask mode: the Documents "Edit Template" modal (DocumentTemplateModal),
 * the JQL "Import JQL Templates" modal and the Tasks "Custom report" modal
 * are dialogs now (BaseModal: role="dialog", aria-modal), so with the
 * pointer inside one the band follows the modal's fields - the name input,
 * the description textarea, a content line - in the dialog's layer, the
 * page behind is dimmed by the mask, and nothing on the page moves while
 * the pointer is in the modal; Esc closes the modal and the ruler returns
 * to the page.
 *
 * Needs playwright-core with Chromium. Port RULER_MODALS_TEST_PORT (5244).
 * Run: node tests/ruler-modals-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.RULER_MODALS_TEST_PORT || 5244);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (RULER_MODALS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('documentsReadingAids', JSON.stringify({ ruler: true, rulerMode: 'mask' })); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); localStorage.setItem('expandedTemplateCategories', JSON.stringify(['General'])); localStorage.setItem('templateSidebarCollapsed', 'false'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().evaluate((el) => el.click()); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().evaluate((el) => el.click()); } else { await page.locator('[data-testid="rail-more"]').evaluate((el) => el.click()); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().evaluate((el) => el.click()); } await page.mouse.move(700, 450); await sleep(700); };
const box = (b) => b && { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
const ruler = () => page.evaluate(() => {
  const c = document.querySelector('[data-testid="reading-ruler"]'); const b = document.querySelector('[data-testid="reading-ruler-band"]'); const s = document.querySelector('[data-testid="reading-ruler-shade"]');
  if (!c || c.hidden || !b) return null;
  const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
  const hole = s && !s.hidden && s.dataset.hole ? s.dataset.hole.split(',').map(Number) : null;
  return { z: getComputedStyle(c).zIndex, band: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }, clip: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom }, shade: !!s && !s.hidden, shadeZ: s ? getComputedStyle(s).zIndex : null, hole: hole && { left: hole[0], top: hole[1], right: hole[2], bottom: hole[3] } };
});
const within = (a, b, tol = 2) => a.left >= b.left - tol && a.top >= b.top - tol && a.right <= b.right + tol && a.bottom <= b.bottom + tol;
const dimmed = (st, x, y) => st && st.shade && (!st.hole || x < st.hole.left || x > st.hole.right || y < st.hole.top || y > st.hole.bottom);
const pageSnapshot = () => page.evaluate(() => Array.from(document.querySelectorAll('.sc-row, .sc-editor-cm .cm-line')).slice(0, 12).map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; }));

// the band follows the fields of the open dialog; the page behind is dimmed; the page's layout does not move
async function dialogChecks(tag, dialogSel) {
  const dialog = page.locator(dialogSel).last();
  const db = box(await dialog.boundingBox());
  const role = await dialog.evaluate((el) => ({ role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'), panel: el.classList.contains('sc-modal-panel') }));
  check(`${tag}: the modal is a dialog (role, aria-modal, a name, the shared panel class)`, role.role === 'dialog' && role.modal === 'true' && !!role.name && role.panel, JSON.stringify(role));
  const before = await pageSnapshot();
  const fields = dialog.locator('input[type="text"], input:not([type]), textarea');
  const n = await fields.count();
  check(`${tag}: the dialog has text fields to follow (${n})`, n >= 1);
  let followed = 0;
  for (let i = 0; i < Math.min(n, 3); i++) {
    const fb = box(await fields.nth(i).boundingBox());
    if (!fb || fb.height === 0) continue;
    await page.mouse.move(fb.left + 30, fb.top + Math.min(14, fb.height / 2)); await sleep(300);
    const st = await ruler();
    const ok = st && parseInt(st.z, 10) > 50 && st.band.top >= fb.top - 2 && st.band.bottom <= fb.bottom + 2 && within(st.clip, { ...db, left: db.left - 2, top: db.top - 2, right: db.right + 2, bottom: db.bottom + 2 }) && st.shade && dimmed(st, 60, 450) && dimmed(st, db.left - 20, 450);
    if (ok) followed++;
    else check(`${tag}: field ${i + 1}: the band inside the field's box, the overlay in the dialog's layer, the clip inside the dialog, the page dimmed`, false, JSON.stringify({ st, fb, db }));
  }
  check(`${tag}: the band follows the dialog's fields (${followed} of ${Math.min(n, 3)}), in the dialog's layer, the page behind dimmed`, followed >= 1 && followed === Math.min(n, 3));
  const after = await pageSnapshot();
  check(`${tag}: nothing on the page moved while the pointer was in the modal`, JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
  await page.keyboard.press('Escape'); await sleep(400);
  check(`${tag}: Esc closes the modal and the ruler returns to the page`, (await page.locator(dialogSel).count()) === 0 && (await ruler()) && (await ruler()).z === '40', JSON.stringify(await ruler()));
}

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500); await dismiss();
  await page.evaluate(async () => {
    const d = await import('/src/utils/documents.js');
    await d.createDocument({ title: 'Sample note', content: '# Sample\n\nSample text.', category: 'General' });
    const t = await import('/src/utils/documentTemplates.js');
    await t.createDocumentTemplate({ name: 'Sample template', content: '# Case\n\nWhat happened.\n\nNext steps.', category: 'General', description: 'A sample', tags: ['sample'] });
  });
  await goTo('Tasks'); await goTo('Documents'); await sleep(500);

  // 1. Edit Template (DocumentTemplateModal): the Templates section, the template's context menu, Edit
  let tplRow = page.locator('[data-side="left"] div.text-sm', { hasText: /^Sample template$/ }).first();
  if (!(await tplRow.count())) { const cat = page.locator('[data-side="left"] button', { hasText: /^General/ }).last(); if (await cat.count()) { await cat.click(); await sleep(400); } tplRow = page.locator('[data-side="left"] div.text-sm', { hasText: /^Sample template$/ }).first(); }
  check('the Templates section lists the seeded template', (await tplRow.count()) > 0);
  await tplRow.click({ button: 'right' }); await sleep(400);
  const edit = page.locator('button', { hasText: /^\s*Edit( Template)?\s*$/ }).last();
  if (await edit.count()) { await edit.click(); await sleep(500); }
  else { const menuBtn = page.locator('[data-side="left"] button[title="Template menu"]').first(); if (await menuBtn.count()) { await menuBtn.click(); await sleep(300); await page.locator('button', { hasText: /Edit/ }).last().click(); await sleep(500); } }
  check('the Edit Template modal opens as a dialog', (await page.locator('[role="dialog"][aria-modal="true"]', { hasText: /Edit Template/i }).count()) === 1);
  await dialogChecks('Edit Template', '[role="dialog"][aria-modal="true"]');

  // 2. Import JQL Templates (ImportJQLModal)
  await goTo('JQL Search'); await sleep(500);
  const importBtn = page.locator('button[title="Import JQL query"]').first();
  check('the JQL page has the Import JQL query button', (await importBtn.count()) > 0);
  if (await importBtn.count()) {
    await importBtn.click(); await sleep(500);
    check('the Import JQL modal opens as a dialog', (await page.locator('[role="dialog"][aria-modal="true"]').count()) >= 1);
    await dialogChecks('Import JQL query', '[role="dialog"][aria-modal="true"]');
  }

  // 3. Custom report (CustomReportModal) from the Tasks Filters menu ("New Filter")
  await goTo('Tasks'); await sleep(500);
  const filtersMenu = page.locator('button[title="Filters menu"]').first();
  let opened = false;
  if (await filtersMenu.count()) {
    await filtersMenu.click(); await sleep(300);
    const item = page.locator('.sc-menu button', { hasText: /^New Filter$/ }).first();
    if (await item.count()) { await item.click(); await sleep(500); opened = (await page.locator('[role="dialog"][aria-modal="true"]').count()) >= 1; }
    else await page.keyboard.press('Escape');
  }
  check('the Custom report modal opens as a dialog from the Filters menu', opened);
  if (opened) await dialogChecks('Custom report', '[role="dialog"][aria-modal="true"]');

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
