#!/usr/bin/env node
/**
 * The reading aids on every page (Playwright against the Vite dev server,
 * no backend). With line height 1.8, paragraph spacing, a 60-character
 * column and justified text set: on each of the nine pages, in the
 * Settings dialog and in the empty states, every text block (paragraphs,
 * list items, definitions, quotes) reads at 1.8 x its font size while the
 * controls (buttons, fields, tabs, the rail) keep the heights they had;
 * long-form text (markdown previews, marked reading areas) is capped at the
 * column and justified, dialog paragraphs are capped but not justified.
 * Zen on every page: the rail, the page's sidebar and the panels step
 * aside, a compact button opens the sidebar as an overlay (Diagnostics:
 * "Sections"), Esc closes the overlay then leaves zen. The profiles apply
 * on every page (Dyslexia friendly's Lexend on a text block). The ruler
 * overlay is present on a page without a markdown area (the page pane is
 * a reading area). Screenshots of Comfortable reading and Dyslexia
 * friendly on AI Chat, Tasks, Kanban, Diagnostics and Settings go to
 * READING_AIDS_SHOTS_DIR/everywhere.
 *
 * Needs playwright-core with Chromium. Port EVERYWHERE_TEST_PORT (5226).
 * Run: node tests/accessibility-everywhere-live.test.mjs
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
const PORT = Number(process.env.EVERYWHERE_TEST_PORT || 5226);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'everywhere');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (EVERYWHERE_TEST_PORT)`); process.exit(0); }
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
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().click(); } else { await page.locator('[data-testid="rail-more"]').click(); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().click(); } await page.mouse.move(700, 450); await sleep(700); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const resetAids = () => page.evaluate(async () => { const m = await import('/src/utils/readingAids.js'); m.resetReadingAids(); });
const applyProfile = (id) => page.evaluate(async (id) => { const m = await import('/src/utils/readingAidProfiles.js'); m.applyProfile(id); }, id);
const zen = (on) => page.evaluate(async (on) => { const m = await import('/src/utils/readingAids.js'); m.zenMode.set(on); }, on);
const openSettings = async (tab) => { if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); } await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250); };
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
// the text blocks and the controls in view (inside `root`, or the whole page)
const survey = (rootSel = 'body') => page.evaluate((rootSel) => {
  const root = document.querySelector(rootSel) || document.body;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const CONTROL = 'button, label, nav, [role="menu"], [role="listbox"], [role="tablist"], pre, code, table, .sc-editor-cm, .react-flow';
  const text = [];
  for (const el of root.querySelectorAll('p, li, dd, dt, blockquote, figcaption, summary')) {
    if (!visible(el) || el.closest(CONTROL) || el.closest('[data-testid="reading-ruler"]')) continue;
    if (!/[A-Za-z]{3,}/.test(el.textContent || '')) continue;
    const cs = getComputedStyle(el);
    // Documents' editor and Preview (.ra-surface) centre their column with a padding instead of a max-width
    text.push({ tag: el.tagName, t: (el.textContent || '').trim().slice(0, 30), fs: parseFloat(cs.fontSize), lh: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight), mw: cs.maxWidth, align: cs.textAlign, long: !!el.closest('.markdown-preview, .ra-reading'), surface: !!el.closest('.ra-surface'), dialog: !!el.closest('[role="dialog"], [data-testid="settings-modal"], .sc-modal-backdrop'), mb: parseFloat(cs.marginBottom) });
  }
  const controls = [];
  const seen = new Map();   // unlabelled icon buttons share a key: numbered in document order, so like is compared with like
  for (const el of root.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role="tab"]')) {
    if (!visible(el) || el.closest('[data-testid="reading-ruler"]')) continue;
    const base = (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.id || el.textContent.trim().slice(0, 24)) + '/' + el.tagName;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    controls.push({ key: `${base}#${n}`, h: Math.round(el.getBoundingClientRect().height) });
  }
  const rail = Array.from(document.querySelectorAll('nav.w-16 button')).map((b) => Math.round(b.getBoundingClientRect().height));
  return { text, controls, rail };
}, rootSel);
const controlsSame = (a, b) => { const m = new Map(a.map((c) => [c.key, c.h])); let diff = []; for (const c of b) { if (m.has(c.key) && Math.abs(m.get(c.key) - c.h) > 1) diff.push(`${c.key}: ${m.get(c.key)} -> ${c.h}`); } return diff; };
const LH = 1.8;
const textOk = (s) => s.text.filter((t) => t.lh == null || Math.abs(t.lh - t.fs * LH) > 1.5);
const longOk = (s) => s.text.filter((t) => t.long && ((t.mw === 'none' && !t.surface) || t.align !== 'justify'));
const dialogOk = (s) => s.text.filter((t) => t.dialog && !t.long && (t.mw === 'none' || t.align === 'justify'));

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  // a document with a couple of paragraphs, so Documents has long-form text in Preview
  const nd = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; });
  check('New Document', nd);
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(400);
  await page.locator('.sc-editor-cm .cm-content').click();
  await page.keyboard.insertText('# Everywhere\n\nA first paragraph of reading text that goes on for a while so that it wraps across a few lines in the preview.\n\nA second paragraph, as long as the first, so the paragraph spacing shows between them.\n');
  await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(500);

  // ---- baseline: the controls' heights per page and in Settings, at the defaults
  await resetAids(); await sleep(300);
  const base = {};
  for (const label of PAGES) { await goTo(label); base[label] = await survey(); }
  await openSettings('Accessibility'); base.settings = await survey('[data-testid="settings-modal"]'); await closeSettings();

  // ---- the reading options on: every page, the Settings dialog, the empty states
  await setAids({ lineHeight: LH, paragraphSpacing: 1.5, lineWidth: 60, textAlign: 'justify' }); await sleep(400);
  const table = [];
  for (const label of PAGES) {
    await goTo(label);
    const s = await survey();
    const bad = textOk(s); const lng = longOk(s); const ctl = controlsSame(base[label].controls, s.controls);
    const railSame = JSON.stringify(s.rail) === JSON.stringify(base[label].rail);
    check(`${label}: every text block in view (${s.text.length}) reads at ${LH} x its size; long-form blocks (${s.text.filter((t) => t.long).length}) capped at the column and justified; the controls (${s.controls.length}) and the rail keep their heights`, s.text.length > 0 && bad.length === 0 && lng.length === 0 && ctl.length === 0 && railSame, JSON.stringify({ bad: bad.slice(0, 5), lng: lng.slice(0, 5), ctl: ctl.slice(0, 8), railSame }));
    table.push({ page: label, blocks: s.text.length, long: s.text.filter((t) => t.long).length, dialog: 0, controls: s.controls.length });
  }
  await openSettings('Accessibility');
  let s = await survey('[data-testid="settings-modal"]');
  let bad = textOk(s); let dlg = dialogOk(s); let ctl = controlsSame(base.settings.controls, s.controls);
  check(`the Settings dialog (Accessibility): its text blocks (${s.text.length}) read at ${LH} x, capped at the column and not justified; its controls (${s.controls.length}) keep their heights`, s.text.length > 3 && bad.length === 0 && dlg.length === 0 && ctl.length === 0, JSON.stringify({ bad: bad.slice(0, 5), dlg: dlg.slice(0, 5), ctl: ctl.slice(0, 8) }));
  await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Theme' }).click(); await sleep(250);
  s = await survey('[data-testid="settings-modal"]'); bad = textOk(s); dlg = dialogOk(s);
  check(`the Settings dialog (Theme): its text blocks (${s.text.length}) read at ${LH} x, capped and not justified`, s.text.length > 0 && bad.length === 0 && dlg.length === 0, JSON.stringify({ bad: bad.slice(0, 5), dlg: dlg.slice(0, 5) }));
  await closeSettings();
  await goTo('Kanban');
  s = await survey('.sc-empty');
  check(`an empty state (Kanban, no boards): its description (${s.text.length}) reads at ${LH} x and is capped at the column`, s.text.length > 0 && textOk(s).length === 0 && s.text.every((t) => t.mw !== 'none'), JSON.stringify(s.text));
  console.log('TABLE ' + JSON.stringify(table));

  // ---- letter and word spacing: every section title (tracked, uppercase) carries its own tracking plus the user's
  //      spacing, the same on every page and in Settings; the editor's gutter and tabular numbers stay unspaced
  await setAids({ letterSpacing: 0.1, wordSpacing: 0.3 }); await sleep(400);
  const spacingOf = (sel) => page.evaluate(([sel]) => Array.from(document.querySelectorAll(sel)).filter((el) => el.getBoundingClientRect().width > 0).slice(0, 6).map((el) => { const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize); return { t: (el.textContent || '').trim().slice(0, 20), tag: el.tagName, letterEm: Math.round((parseFloat(cs.letterSpacing) || 0) / fs * 1000) / 1000, wordEm: Math.round((parseFloat(cs.wordSpacing) || 0) / fs * 1000) / 1000, tracking: cs.getPropertyValue('--tw-tracking').trim() }; }), [sel]);
  const titleOk = (x) => Math.abs(x.letterEm - Math.max(0.025, 0.1)) <= 0.006 && Math.abs(x.wordEm - 0.3) <= 0.01;   // max(tracking-wide 0.025em, the user's 0.1em); 0.3em words
  const titles = {};
  for (const label of ['Documents', 'Tasks', 'Kanban', 'Calendars', 'Diagnostics']) {
    await goTo(label);
    titles[label] = await spacingOf('[data-side="left"] [class*="tracking-"], [data-side="left"] h2');
    check(`${label}: the sidebar's section titles (${titles[label].map((x) => x.t).join(', ')}) take the user's letter spacing as a minimum over their tracking (0.1 em) and the word spacing (0.3 em)`, titles[label].length > 0 && titles[label].every(titleOk), JSON.stringify(titles[label]));
  }
  await goTo('Documents');
  const gutter = await spacingOf('.sc-editor-cm .cm-gutters, .sc-editor-cm .cm-gutterElement');
  const tabular = await spacingOf('.tabular-nums');
  check('the editor\'s line-number gutter and the tabular numbers take no letter or word spacing', (gutter.length === 0 || gutter.every((x) => x.letterEm === 0 && x.wordEm === 0)) && tabular.every((x) => x.letterEm === 0 && x.wordEm === 0), JSON.stringify({ gutter, tabular }));
  await openSettings('Accessibility');
  const settingsTitles = await spacingOf('[data-testid="settings-modal"] [class*="tracking-"]');
  check(`Settings: its section titles (${settingsTitles.map((x) => x.t).join(', ')}) carry the same spacing`, settingsTitles.length > 0 && settingsTitles.every(titleOk), JSON.stringify(settingsTitles));
  await closeSettings();
  await setAids({ letterSpacing: 0, wordSpacing: 0 }); await sleep(300);

  // ---- the ruler everywhere: on a page without a markdown area the page pane is the reading area
  await setAids({ ruler: true, rulerMode: 'highlight' }); await sleep(400);
  await goTo('Tasks');
  const ruler = await page.evaluate(() => { const c = document.querySelector('[data-testid="reading-ruler"]'); if (!c) return { mounted: false }; const r = c.getBoundingClientRect(); const pane = document.querySelector('[data-ra-area]'); const pr = pane ? pane.getBoundingClientRect() : null; return { mounted: true, hidden: c.hidden, clip: [r.left, r.top, r.width, r.height], pane: pr && [pr.left, pr.top, pr.width, pr.height] }; });
  check('the ruler on Tasks (no markdown area): the overlay is present over the page pane (data-ra-area), not hidden', ruler.mounted && ruler.hidden === false && ruler.pane && Math.abs(ruler.clip[0] - ruler.pane[0]) < 2 && ruler.clip[2] > 300, JSON.stringify(ruler));
  await setAids({ ruler: false });

  // ---- zen on every page
  await resetAids(); await sleep(300);
  for (const label of PAGES) {
    await goTo(label);
    const before = await page.evaluate(() => ({ rail: getComputedStyle(document.querySelector('nav.w-16')).display, sidebars: Array.from(document.querySelectorAll('[data-side="left"]')).filter((el) => el.getBoundingClientRect().width > 0).length }));
    await zen(true); await sleep(400);
    const z = await page.evaluate((label) => {
      const btn = document.querySelector('[data-testid="zen-sidebar-button"]');
      return { rail: getComputedStyle(document.querySelector('nav.w-16')).display, sidebars: Array.from(document.querySelectorAll('[data-side="left"]')).filter((el) => el.getBoundingClientRect().width > 0).length, button: btn ? btn.getAttribute('aria-label') : null, hint: !!document.querySelector('[data-testid="zen-badge"]') && !document.querySelector('[data-testid="zen-hint"]'), zen: document.documentElement.classList.contains('zen-mode'), label };
    }, label);
    // every page with a sidebar has the left tab, Documents included (its list and Templates); the footer bar is gone, the Zen label in the status corner stands in
    const expectButton = 'Show sidebar';   // one name on every page; the chip says "Sidebar", the overlay's title names the page's list
    check(`${label}: zen hides the rail (was ${before.rail}) and the page's sidebar column (${before.sidebars} before), shows the Zen label (no footer bar), and a left-edge tab "${expectButton}"`, z.zen && z.rail === 'none' && z.sidebars === 0 && z.hint && z.button === expectButton, JSON.stringify({ before, z }));
    if (expectButton) {
      await page.locator('[data-testid="zen-sidebar-button"]').click(); await sleep(300);
      const open = await page.evaluate(() => { const o = document.querySelector('[data-testid="zen-sidebar-overlay"]'); return o ? { role: o.getAttribute('role'), w: o.getBoundingClientRect().width } : null; });
      await page.keyboard.press('Escape'); await sleep(300);
      const after = await page.evaluate(() => ({ overlay: !!document.querySelector('[data-testid="zen-sidebar-overlay"]'), zen: document.documentElement.classList.contains('zen-mode') }));
      check(`${label}: the edge tab opens the sidebar as an overlay (a dialog); Esc closes it and zen stays on`, open && open.role === 'dialog' && open.w > 150 && !after.overlay && after.zen, JSON.stringify({ open, after }));
    }
    await page.keyboard.press('Escape'); await sleep(400);
    const left = await page.evaluate(() => ({ zen: document.documentElement.classList.contains('zen-mode'), rail: getComputedStyle(document.querySelector('nav.w-16')).display, sidebars: Array.from(document.querySelectorAll('[data-side="left"]')).filter((el) => el.getBoundingClientRect().width > 0).length }));
    check(`${label}: Esc leaves zen - the rail and the sidebar are back`, !left.zen && left.rail !== 'none' && left.sidebars === before.sidebars, JSON.stringify(left));
  }
  // a panel (AI Chat) hides in zen and is back after
  await goTo('Tasks');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleAIChatSidebar'))); await sleep(600);
  const panelBefore = await page.evaluate(() => Array.from(document.querySelectorAll('[data-side]')).filter((el) => el.getBoundingClientRect().width > 0).length);
  await zen(true); await sleep(400);
  const panelZen = await page.evaluate(() => Array.from(document.querySelectorAll('[data-side]')).filter((el) => el.getBoundingClientRect().width > 0).length);
  await zen(false); await sleep(400);
  const panelAfter = await page.evaluate(() => Array.from(document.querySelectorAll('[data-side]')).filter((el) => el.getBoundingClientRect().width > 0).length);
  check(`the panels: with the AI Chat panel open (${panelBefore} columns), zen hides every column, leaving zen brings them back`, panelBefore >= 2 && panelZen === 0 && panelAfter === panelBefore, JSON.stringify([panelBefore, panelZen, panelAfter]));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleAIChatSidebar'))); await sleep(400);

  // ---- the profiles on every page, with screenshots
  for (const label of PAGES) {
    await goTo(label);
    await applyProfile('dyslexia'); await sleep(500);
    const font = await page.evaluate(() => { const el = Array.from(document.querySelectorAll('p, li, h1, h2, h3, button')).find((e) => e.getBoundingClientRect().height > 0 && /[A-Za-z]{3,}/.test(e.textContent) && !e.closest('nav.w-16, pre, code')); return el ? getComputedStyle(el).fontFamily : null; });
    check(`${label}: the Dyslexia friendly profile applies (Lexend on the page's text)`, !!font && /Lexend/.test(font), font);
    if (['Robin', 'Tasks', 'Kanban', 'Diagnostics'].includes(label)) await shot(`dyslexia-${label.toLowerCase()}`);
    await applyProfile('comfortable'); await sleep(500);
    if (['Robin', 'Tasks', 'Kanban', 'Diagnostics'].includes(label)) await shot(`comfortable-${label.toLowerCase()}`);
  }
  await openSettings('Accessibility'); await shot('comfortable-settings');
  await applyProfile('dyslexia'); await sleep(500); await shot('dyslexia-settings');
  await closeSettings();
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
