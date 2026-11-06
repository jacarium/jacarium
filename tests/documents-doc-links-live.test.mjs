#!/usr/bin/env node
/**
 * Links between documents ([[doc:...]], src/utils/docLinks.js) in the real
 * Documents page (Vite dev server + headless Chromium, playwright-core):
 *
 *   - the preview renders the id form and the title form as links carrying
 *     the target's CURRENT title, an unknown id as a muted "Document not
 *     found"; clicking a link opens that document (the page's own
 *     open-document path: it becomes the current document, in a tab);
 *     Enter on a focused link does the same (keyboard);
 *   - the editor shows the id form as a chip with the title, the unknown
 *     one as a "not found" chip, and the text underneath stays the directive;
 *   - typing "[[doc:Tar" opens the picker listing the matching title; Enter
 *     inserts [[doc:<stableId>]] (then a chip); the /link slash command inserts
 *     "[[doc:" and opens the picker with every other document; Escape leaves
 *     the text; Insert > Link to document is in the toolbar menu;
 *   - typing inside a title-form directive offers to convert it: Enter
 *     replaces it with the id form;
 *   - a rename in the sidebar: the preview's link and the chip show the new
 *     title (the title form, no longer matching, says not found);
 *   - a delete: the id link becomes "Document not found".
 * Writes /tmp/jacarium-doc-links/{preview,editor}.png.
 *
 * SKIPs like tests/markdown-callouts-ui.test.mjs (no Chromium, a busy port, Vite down).
 * Run: node tests/documents-doc-links-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { pwEditor, pwEditorValue, pwSetEditorText, pwSelect } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.DOC_LINKS_TEST_PORT || 5197);
const OUT = '/tmp/jacarium-doc-links';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (DOC_LINKS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const T = '11111111-2222-4333-8444-555555555555';
const GONE = '99999999-8888-4777-8666-555555555555';
const SOURCE_MD = `# Source\n\nSee [[doc:${T}]] and [[doc:${T}|the target]] and [[doc:Target doc]].\n\nUnknown: [[doc:${GONE}]].\n`;

const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(2000);
await page.evaluate(async ({ T, SOURCE_MD }) => {
  const { db } = await import('/src/db/database.js');
  await db.documents.clear();
  const now = new Date();
  await db.documents.add({ title: 'Target doc', content: '# Target content\n\nHello from the target.', category: 'General', stableId: T, createdAt: now, updatedAt: now });
  const sourceId = await db.documents.add({ title: 'Source', content: SOURCE_MD, category: 'General', stableId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', createdAt: new Date(now.getTime() + 1000), updatedAt: new Date(now.getTime() + 1000) });
  localStorage.setItem('documentOpenTabs', JSON.stringify([{ id: sourceId, title: 'Source', category: 'General', inCloud: false }]));
  localStorage.setItem('currentDocumentId', JSON.stringify(sourceId));
  localStorage.setItem('whatsNewLastSeen', '99.0.0');
  localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General']));
}, { T, SOURCE_MD });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

const toggle = async () => { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(1300); };
const inPreview = () => page.locator('.markdown-preview').count().then((n) => n > 0);
const toPreview = async () => { if (!(await inPreview())) await toggle(); };
const toEditor = async () => { if (await inPreview()) await toggle(); if (await inPreview()) await toggle(); };
const sidebarRow = (title) => page.locator('.sc-row', { hasText: title }).first();
const openFromSidebar = async (title) => { await sidebarRow(title).click(); await page.waitForTimeout(800); };
const shownDocument = () => page.evaluate(() => { const ed = document.querySelector('.sc-editor-cm')?.editorSurface; const pv = document.querySelector('.markdown-preview'); return (ed && ed.value) || (pv && pv.textContent) || ''; });

try {
  console.log('\n--- the preview ---');
  await toPreview();
  const previewLinks = () => page.locator('.markdown-preview a[data-doc-link]');
  check('the id form, the custom-text form and the title form render as links; the id link shows the current title', await previewLinks().count() === 3 && (await previewLinks().allTextContents()).join('|') === 'Target doc|the target|Target doc', (await previewLinks().allTextContents()).join('|'));
  check('an unknown id is a muted "Document not found" span with the raw id, no link', await page.locator('.markdown-preview .doc-link-missing').count() === 1 && /Document not found:.*99999999/.test(await page.locator('.markdown-preview .doc-link-missing').textContent()));
  check('the links carry the target\'s stable id in a data attribute and href="#" only', await page.evaluate(() => Array.from(document.querySelectorAll('.markdown-preview a[data-doc-link]')).every((a) => a.getAttribute('href') === '#' && a.dataset.docLink === '11111111-2222-4333-8444-555555555555')));
  await page.locator('.markdown-preview').screenshot({ path: path.join(OUT, 'preview.png') });
  await previewLinks().first().click(); await page.waitForTimeout(1200);
  check('clicking a link opens the target document (it is the shown document now)', /Hello from the target/.test(await shownDocument()), (await shownDocument()).slice(0, 80));
  check('...in a tab of its own (the tab bar lists Source and Target doc)', (await page.locator('div[draggable="true"]').allTextContents()).some((t) => /Target doc/.test(t)), (await page.locator('div[draggable="true"]').allTextContents()).join('|'));
  await openFromSidebar('Source'); await toPreview();
  await previewLinks().first().focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
  check('Enter on a focused link opens it too (keyboard)', /Hello from the target/.test(await shownDocument()));

  console.log('\n--- the editor ---');
  await openFromSidebar('Source'); await toEditor();
  check('the editor is shown for Source', await pwEditor(page).count() === 1 && /See \[\[doc:/.test(await pwEditorValue(page)));
  const chips = () => page.locator('.sc-editor-cm .cm-doc-link-chip');
  check('the id-form directives are chips with the title / the custom text; the unknown one a "not found" chip; the title form stays text', await chips().count() === 3 && (await chips().allTextContents()).join('|') === `Target doc|the target|Document not found: ${GONE}` && (await page.locator('.sc-editor-cm .cm-doc-link-chip-missing').count()) === 1 && (await page.locator('.sc-editor-cm .cm-content').textContent()).includes('[[doc:Target doc]]'), (await chips().allTextContents()).join('|'));
  check('the text underneath stays the directive', (await pwEditorValue(page)).includes(`[[doc:${T}|the target]]`));
  await page.locator('.sc-editor-cm').screenshot({ path: path.join(OUT, 'editor.png') });

  // typing "[[doc:Tar": the picker, Enter inserts the id form
  await pwSetEditorText(page, 'Link: '); await page.waitForTimeout(200);
  await pwSelect(page, 6, 6);
  await page.keyboard.type('[[doc:Tar', { delay: 20 }); await page.waitForTimeout(400);
  const menu = page.locator('[data-testid="doc-link-menu"]');
  check('typing "[[doc:Tar" opens the picker with the matching document', await menu.count() === 1 && (await menu.locator('[data-doc-link-entry]').allTextContents()).some((t) => /Target doc/.test(t)), (await menu.count()) ? (await menu.textContent()) : 'no menu');
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  check('Enter inserts [[doc:<stableId>]] over the typed text, the picker closes', (await pwEditorValue(page)) === `Link: [[doc:${T}]]` && await menu.count() === 0, JSON.stringify(await pwEditorValue(page)));
  check('...shown as a chip with the title', await chips().count() === 1 && (await chips().first().textContent()) === 'Target doc');
  // the /link slash command
  await pwSetEditorText(page, 'Text\n'); await page.waitForTimeout(200);
  await pwSelect(page, 5, 5);
  await page.keyboard.type('/link', { delay: 20 }); await page.waitForTimeout(400);
  check('"/link" lists Link to document in the slash popup', (await page.locator('[data-slash-entry="block-doclink"]').count()) === 1);
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  check('Enter inserts "[[doc:" and opens the picker with the other documents listed', (await pwEditorValue(page)) === 'Text\n[[doc:' && await menu.count() === 1 && (await menu.locator('[data-doc-link-entry]').count()) >= 1, JSON.stringify(await pwEditorValue(page)));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check('Escape closes the picker and leaves the text', await menu.count() === 0 && (await pwEditorValue(page)) === 'Text\n[[doc:');
  // Insert > Link to document
  await page.locator('[data-testid="insert-menu-button"]').click(); await page.waitForTimeout(200);
  check('the toolbar\'s Insert menu offers Link to document', (await page.locator('[data-testid="insert-menu"] [data-menu-item="doc-link"]').count()) === 1);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  // the title form converted through the picker
  await pwSetEditorText(page, '[[doc:Target do]]'); await page.waitForTimeout(200);
  await pwSelect(page, 15, 15);
  await page.keyboard.type('c', { delay: 20 }); await page.waitForTimeout(400);
  check('typing inside a title-form directive offers to convert it (the picker names the title)', await menu.count() === 1 && /Convert to a permanent link/.test(await menu.textContent()) && (await menu.locator('[data-doc-link-entry]').allTextContents()).some((t) => /Target doc/.test(t)), (await menu.count()) ? await menu.textContent() : 'no menu');
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  check('Enter replaces the whole title-form directive with the id form', (await pwEditorValue(page)) === `[[doc:${T}]]`, JSON.stringify(await pwEditorValue(page)));
  // back to the source text for the rename / delete checks below: the helper's set is an external
  // change (no onChange), so a typed space-and-backspace hands the text to the page, whose autosave
  // writes the record - wait for it
  await pwSetEditorText(page, SOURCE_MD); await page.waitForTimeout(200);
  await pwSelect(page, SOURCE_MD.length, SOURCE_MD.length);
  await page.keyboard.type(' ', { delay: 20 }); await page.keyboard.press('Backspace');
  let saved = false;
  for (let i = 0; i < 40 && !saved; i++) {
    await page.waitForTimeout(250);
    saved = await page.evaluate(async (md) => { const { db } = await import('/src/db/database.js'); const d = await db.documents.where('stableId').equals('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').first(); return !!d && d.content === md; }, SOURCE_MD);
  }
  check('the source text is saved again before the rename', saved);

  console.log('\n--- a rename ---');
  // (a double click: the row's first click opens the document and re-renders the list under a real
  // mouse, so the dblclick event is dispatched as such - what React's onDoubleClick listens to)
  await sidebarRow('Target doc').dispatchEvent('dblclick'); await page.waitForTimeout(300);
  // (the row's text is the input's value now, so it is found as the list's one input)
  const edit = page.locator('.sc-row input').first();
  check('double-clicking the sidebar row opens the inline rename', await edit.count() === 1 && (await edit.inputValue()) === 'Target doc');
  await edit.fill('Target doc v2'); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
  check('the sidebar shows the new title', await sidebarRow('Target doc v2').count() === 1);
  await openFromSidebar('Source');
  await toEditor();
  check('the editor chips show the new title; the custom text stays', (await chips().allTextContents()).slice(0, 2).join('|') === 'Target doc v2|the target', (await chips().allTextContents()).join('|'));
  await toPreview();
  check('the preview\'s id links show the new title with no change to the text; the old title form is now "not found"', (await previewLinks().allTextContents()).join('|') === 'Target doc v2|the target' && (await page.locator('.markdown-preview .doc-link-missing').allTextContents()).some((t) => /Target doc/.test(t)), (await previewLinks().allTextContents()).join('|'));

  console.log('\n--- a delete ---');
  await sidebarRow('Target doc v2').click({ button: 'right' }); await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Delete Document$/ }).first().click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Delete$/ }).first().click(); await page.waitForTimeout(1500);
  check('the document is gone from the sidebar', await sidebarRow('Target doc v2').count() === 0);
  await openFromSidebar('Source'); await toPreview();
  check('the preview: every link to it is now "Document not found", no link left', await previewLinks().count() === 0 && (await page.locator('.markdown-preview .doc-link-missing').count()) === 4, String(await page.locator('.markdown-preview .doc-link-missing').count()));
  await toEditor();
  check('the editor: its chips are "not found" chips', await page.locator('.sc-editor-cm .cm-doc-link-chip-missing').count() === 3);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
