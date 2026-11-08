#!/usr/bin/env node
/**
 * The reader's place across Editor <-> Preview, in the real Documents page
 * (Vite dev server + headless Chromium): switching no longer jumps to the top.
 *
 *   - Editor -> Preview: the line at the top of the editor (CodeMirror's line
 *     blocks) finds its block in the preview (data-source-line, the nearest
 *     preceding one) and the preview scrolls there;
 *   - Preview -> Editor: the preview's top visible block's line is at the top
 *     of the editor; the selection is where it was (the editor is remounted,
 *     so it would otherwise be at 0); when the preview was not scrolled
 *     elsewhere and the caret was on screen, it stays on screen;
 *   - back and forth several times: no drift to the top;
 *   - the huge document (2,000,000 lines, the deferred "Rendering preview of N
 *     lines..." render): the place is applied once the content lands;
 *   - a document switch keeps each document's place (src/utils/documentPlaces.js):
 *     another document, never opened, starts at the top in both views; coming
 *     back shows the place left, editor or preview; the huge document too.
 * The numbers measured are printed for the report.
 *
 * SKIPs like tests/markdown-callouts-ui.test.mjs. Run: node tests/editor-preview-place-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { pwEditorValue, pwSelect } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.PREVIEW_PLACE_TEST_PORT || 5201);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (PREVIEW_PLACE_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

// a long mixed document: a heading every section, lists, code, tables, a [[toc]] at the top
const sections = [];
for (let s = 1; s <= 60; s++) {
  sections.push(`## Section ${s}`, '', `Paragraph of section ${s} with some words to read, repeated for length.`, '', `- item one of ${s}`, `- item two of ${s}`, `- item three of ${s}`, '', '```bash', `echo "section ${s}"`, `ls -la /tmp/${s}`, '```', '', `| key | value |`, `|-----|-------|`, `| s | ${s} |`, '', `> a quote in section ${s}`, '');
}
const LONG_MD = ['# Long document', '', '[[toc]]', '- [Section 1](#section-1)', '[[/toc]]', '', ...sections].join('\n');
const LONG_LINES = LONG_MD.split('\n').length;
const OTHER_MD = ['# Other', '', ...Array.from({ length: 150 }, (_, i) => `Other paragraph ${i + 1} with a few words to read.\n`)].join('\n');

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.evaluate(async ({ LONG_MD, OTHER_MD }) => {
  const { db } = await import('/src/db/database.js');
  await db.documents.clear();
  const now = new Date();
  await db.documents.add({ title: 'Other', content: OTHER_MD, category: 'General', stableId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: now, updatedAt: now });
  const id = await db.documents.add({ title: 'Long document', content: LONG_MD, category: 'General', stableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: new Date(now.getTime() + 1000), updatedAt: new Date(now.getTime() + 1000) });
  localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Long document', category: 'General', inCloud: false }]));
  localStorage.setItem('currentDocumentId', JSON.stringify(id));
  localStorage.setItem('whatsNewLastSeen', '99.0.0');
  localStorage.setItem('previewAllDocuments', 'false');
  localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General']));
}, { LONG_MD, OTHER_MD });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(800); }
await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

const SURFACE = "(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)";
const editorTop = () => page.evaluate(`(() => { const s = ${SURFACE}; return s ? s.topVisibleLine() : null; })()`);
const editorScrollTo = (n) => page.evaluate(`(() => { const s = ${SURFACE}; s.scrollToLine(${n}); })()`);
const selectionStart = () => page.evaluate(`(() => { const s = ${SURFACE}; return s ? s.selectionStart : null; })()`);
const cursorVisible = () => page.evaluate(`(() => { const s = ${SURFACE}; return s ? s.isCursorVisible() : null; })()`);
const previewTop = () => page.evaluate(async () => { const m = await import('/src/utils/previewPlace.js'); const c = document.querySelector('.markdown-preview'); return c ? m.previewTopVisibleLine(c) : null; });
const previewScrollToLine = (n) => page.evaluate(async (n) => { const m = await import('/src/utils/previewPlace.js'); const c = document.querySelector('.markdown-preview'); const b = m.previewBlockForLine(c, n); m.scrollPreviewToBlock(c, b); return Number(b.getAttribute('data-source-line')); }, n);
const inPreview = async () => (await page.locator('.markdown-preview').count()) > 0;
const toggle = async () => { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(1300); };
const waitRendered = async (ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await page.locator('[data-testid="preview-rendering"]').count()) && await page.locator('.markdown-preview [data-source-line]').count()) return true; await sleep(250); } return false; };

try {
  console.log(`\n--- editor -> preview -> editor (a ${LONG_LINES}-line mixed document) ---`);
  check('the editor is up with the long document', !(await inPreview()) && (await pwEditorValue(page)).length === LONG_MD.length);
  await editorScrollTo(400); await page.waitForTimeout(300);
  const e0 = await editorTop();
  const value = await pwEditorValue(page);
  const caretPos = value.indexOf(`## Section ${Math.ceil(400 / 19)}`) + 5;   // a line near the top of the view
  await pwSelect(page, caretPos, caretPos); await page.waitForTimeout(200);
  const sel0 = await selectionStart();
  const vis0 = await cursorVisible();
  console.log(`  editor top line ${e0}, caret at ${sel0} (on screen: ${vis0})`);
  check('the editor was scrolled to the middle (top line about 400)', Math.abs(e0 - 400) <= 2, String(e0));
  await toggle();
  const p1 = await previewTop();
  console.log(`  preview top block line ${p1} (editor top was ${e0})`);
  check('Editor -> Preview: the preview shows the block of the editor\'s top line (the nearest preceding block, within 20 lines, not the top)', await inPreview() && p1 != null && p1 <= e0 + 1 && e0 - p1 <= 20 && p1 > 100, `preview ${p1} vs editor ${e0}`);
  await toggle();
  const e1 = await editorTop();
  console.log(`  editor top line ${e1} after coming back (caret ${await selectionStart()}, on screen ${await cursorVisible()})`);
  check('Preview -> Editor without scrolling the preview: the editor is back where it was (within 20 lines), the selection unchanged and the caret on screen', !(await inPreview()) && Math.abs(e1 - e0) <= 20 && (await selectionStart()) === sel0 && (await cursorVisible()) === true, `editor ${e1} vs ${e0}`);

  console.log('\n--- the preview scrolled elsewhere ---');
  await toggle();
  const target = await previewScrollToLine(820); await page.waitForTimeout(300);
  const p2 = await previewTop();
  console.log(`  preview scrolled to the block of line ${target} (top block now ${p2})`);
  await toggle();
  const e2 = await editorTop();
  console.log(`  editor top line ${e2}, caret ${await selectionStart()}`);
  check('Preview -> Editor after scrolling the preview: the editor shows that part (the block\'s line at the top, within 3 lines), the selection untouched', Math.abs(e2 - p2) <= 3 && (await selectionStart()) === sel0, `editor ${e2} vs preview ${p2}`);

  console.log('\n--- back and forth ---');
  const trail = [];
  for (let i = 0; i < 3; i++) {
    await toggle(); trail.push(['preview', await previewTop()]);
    await toggle(); trail.push(['editor', await editorTop()]);
  }
  console.log('  ' + trail.map(([k, v]) => `${k}:${v}`).join(' '));
  check('three round trips without drift: every view stays near the same place (within 25 lines of the first), never at the top', trail.every(([, v]) => v != null && Math.abs(v - e2) <= 25 && v > 100), JSON.stringify(trail));

  console.log('\n--- the place per document: a switch keeps each document where it was ---');
  const a0 = await editorTop();
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(1000);
  check('another document, never opened before, opens at the top of the editor', !(await inPreview()) && (await editorTop()) === 1 && /^# Other/.test(await pwEditorValue(page)), String(await editorTop()));
  await toggle();
  check('...and at the top of its preview', await inPreview() && (await previewTop()) === 1 && (await page.evaluate(() => document.querySelector('.markdown-preview').scrollTop)) === 0, `preview top ${await previewTop()}, scrollTop ${await page.evaluate(() => document.querySelector('.markdown-preview')?.scrollTop)}`);
  await toggle();
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(1000);
  const a1 = await editorTop();
  console.log(`  long document left at top line ${a0}, back at ${a1}; selection ${await selectionStart()} (was ${sel0})`);
  check('back to the long document: the editor is where it was left (within 1 line), the selection as it was', Math.abs(a1 - a0) <= 1 && (await selectionStart()) === sel0, `${a1} vs ${a0}, selection ${await selectionStart()}`);
  // Other keeps a place of its own
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(800);
  await editorScrollTo(90); await page.waitForTimeout(300);
  const o0 = await editorTop();
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(800);
  const a2 = await editorTop();
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(800);
  const o1 = await editorTop();
  console.log(`  Other scrolled to ${o0}; long document ${a2}; Other back at ${o1}`);
  check('each document keeps its own place across switches (Other at its line, the long document at its line, within 1)', Math.abs(a2 - a0) <= 1 && o0 >= 80 && Math.abs(o1 - o0) <= 1, `${a2}/${a0} ${o1}/${o0}`);
  // the preview remembers too: the long document's preview scrolled elsewhere, Other visited, back
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(800);
  await toggle();
  const pA = await previewScrollToLine(300); await page.waitForTimeout(500);
  const pTop = await previewTop();
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(1000);
  const otherPreviewTop = await previewTop();
  const otherInPreview = await inPreview();
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(1000);
  const pBack = await previewTop();
  console.log(`  long preview at block ${pTop} (asked ${pA}); Other opened in ${otherInPreview ? 'preview' : 'editor'} at ${otherInPreview ? otherPreviewTop : await editorTop()}; back: ${pBack}`);
  check('in the preview: the long document comes back to the block it was left at (within 1 line), Other at its own place', await inPreview() && pBack != null && Math.abs(pBack - pTop) <= 1, `${pBack} vs ${pTop}`);
  await toggle();
  const eBack = await editorTop();
  check('...and its editor opens at that place too (the top block\'s line, within 3)', Math.abs(eBack - pTop) <= 3, `${eBack} vs ${pTop}`);

  console.log('\n--- B in Preview, back to A by its tab: A (still in the Editor) keeps its place ---');
  // the place store as the page sees it (sessionStorage mirror, written 250 ms after a change)
  const storeLine = async (stable) => { await page.waitForTimeout(400); return page.evaluate((k) => { try { const o = JSON.parse(sessionStorage.getItem('documentPlaces') || '{}'); return o[k] ? o[k].line : null; } catch { return null; } }, `stable:${stable}`); };
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tab = (title) => page.locator('[data-testid="document-tab"]', { hasText: title }).first();
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(800);
  if (await inPreview()) await toggle();
  await editorScrollTo(500); await page.waitForTimeout(300);
  const aPlace = await editorTop();
  const trail2 = [['A scrolled in the editor', await storeLine(A)]];
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(800);
  trail2.push(['B opened', await storeLine(A)]);
  await toggle();
  const bInPreview = await inPreview();
  trail2.push(['B in Preview', await storeLine(A)]);
  await tab('Long document').click(); await page.waitForTimeout(1200);
  trail2.push(['A\'s tab clicked', await storeLine(A)]);
  const aBack = await editorTop();
  console.log(`  A left at editor line ${aPlace}; the store's line for A along the way: ${trail2.map(([k, v]) => `${k}: ${v}`).join(' | ')}; A back at ${aBack} (${(await inPreview()) ? 'preview' : 'editor'})`);
  check('B in Preview did not overwrite A\'s place in the store', bInPreview && trail2.every(([, v]) => v != null && Math.abs(v - aPlace) <= 1), JSON.stringify(trail2));
  check('A\'s tab: A opens in the Editor (its own mode) at its place (within 1 line)', !(await inPreview()) && Math.abs(aBack - aPlace) <= 1, `${aBack} vs ${aPlace}`);

  console.log('\n--- A left in Preview, B in the Editor, back to A (tab and sidebar): the preview block, then the editor line ---');
  await toggle();   // A to Preview
  const pA2 = await previewScrollToLine(640); await page.waitForTimeout(500);
  const aPreviewTop = await previewTop();
  await tab('Other').click(); await page.waitForTimeout(800);
  if (await inPreview()) await toggle();   // B in the Editor
  const bEditor = !(await inPreview());
  await tab('Long document').click(); await page.waitForTimeout(1200);
  const aPrev = await previewTop();
  check('A left in Preview, B in the Editor, A\'s tab: A opens in Preview at its block (within 1 line)', bEditor && (await inPreview()) && aPrev != null && Math.abs(aPrev - aPreviewTop) <= 1, `${aPrev} vs ${aPreviewTop} (asked ${pA2})`);
  await toggle();   // A to the Editor: the line the preview was at
  const aEd = await editorTop();
  check('...and A\'s editor opens at that line (within 3)', Math.abs(aEd - aPreviewTop) <= 3, `${aEd} vs ${aPreviewTop}`);
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(800);
  await page.locator('.sc-row', { hasText: 'Long document' }).first().click(); await page.waitForTimeout(1000);
  const aEd2 = await editorTop();
  check('...via the sidebar too: back to A in the Editor at the same line (within 1)', !(await inPreview()) && Math.abs(aEd2 - aEd) <= 1, `${aEd2} vs ${aEd}`);

  console.log('\n--- the huge document (2,000,000 lines, the deferred render) ---');
  const hugeId = await page.evaluate(async () => {
    const { db } = await import('/src/db/database.js');
    const parts = [];
    for (let i = 1; i <= 2000000; i++) { parts.push(`Line ${i} of the huge document.`); if (i % 10 === 0) parts.push(''); }
    const now = new Date();
    return db.documents.add({ title: 'Huge document', content: parts.join('\n'), category: 'General', stableId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdAt: new Date(now.getTime() + 5000), updatedAt: new Date(now.getTime() + 5000) });
  });
  await page.evaluate(async () => { const { db } = await import('/src/db/database.js'); return db.documents.count(); });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2000);
  if (await inPreview()) await toggle();
  await page.locator('.sc-row', { hasText: 'Huge document' }).first().click(); await page.waitForTimeout(4000);
  const hugeLines = await page.evaluate(`(() => { const s = ${SURFACE}; return s ? s.view.state.doc.lines : null; })()`);
  check(`the huge document is in the editor (${hugeLines} lines)`, hugeLines > 2000000, String(hugeLines));
  await editorScrollTo(1000000); await page.waitForTimeout(500);
  const h0 = await editorTop();
  const tStart = Date.now();
  await page.locator('[data-testid="editor-mode-toggle"]').click();
  let indicator = 0;
  for (let i = 0; i < 40 && !indicator; i++) { indicator = await page.locator('[data-testid="preview-rendering"]').count(); if (!indicator) await sleep(50); }
  const rendered = await waitRendered();
  const renderMs = Date.now() - tStart;
  const hp = await previewTop();
  // (the indicator is painted before the deferred render blocks the main thread, which is when the
  // test's polling can run, so observing it here is incidental: tests/preview-rendering-indicator.test.mjs owns it)
  console.log(`  editor top line ${h0}; indicator observed: ${indicator === 1}; preview rendered in ${renderMs} ms; preview top block line ${hp}`);
  check('the huge document: the preview lands at the editor\'s place once the deferred render is in (the top block within 15 lines of the editor\'s top line, not the top)', rendered && hp != null && Math.abs(hp - h0) <= 15 && hp > 1000, `preview ${hp} vs editor ${h0}`);
  await page.waitForTimeout(1300);
  await previewScrollToLine(1500000); await page.waitForTimeout(500);
  const hp2 = await previewTop();
  await toggle();
  const he2 = await editorTop();
  console.log(`  preview scrolled to ${hp2}; editor top line ${he2} after coming back`);
  check('...and back: the editor at the preview\'s place (within 3 lines)', Math.abs(he2 - hp2) <= 3, `editor ${he2} vs preview ${hp2}`);
  await page.locator('.sc-row', { hasText: 'Other' }).first().click(); await page.waitForTimeout(1000);
  await page.locator('.sc-row', { hasText: 'Huge document' }).first().click(); await page.waitForTimeout(4000);
  const he3 = await editorTop();
  console.log(`  the huge document opened again from the sidebar: top line ${he3}`);
  check('the huge document opened again from the sidebar: back at its place (within 3 lines)', Math.abs(he3 - he2) <= 3, `${he3} vs ${he2}`);
  void hugeId;
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
