#!/usr/bin/env node
/**
 * The editor's code blocks are styled the moment they are on screen (the
 * real Documents page: Vite dev server + headless Chromium) - the tinted
 * lines, the fence label and the syntax colours - without any scrolling:
 *
 *   - a document with fenced blocks opened from another document (the
 *     sidebar): the blocks in view are tinted and coloured at once;
 *   - Preview -> Editor at the top of the document;
 *   - Preview, scrolled to a code section far down, -> Editor: the editor
 *     lands there and the blocks in view are tinted and coloured at once,
 *     no scrolling (the case reported: they only appeared after the block
 *     left the viewport and came back);
 *   - a document much longer than the viewport with blocks on screen at load.
 *
 * The decorations are built from the Markdown syntax tree, which the parser
 * fills in idle time: a build that runs before the parse reaches the
 * viewport finds nothing and must run again when the tree moves on
 * (codemirror/markdownLanguage.js treeChanged / treeFor).
 *
 * SKIPs like tests/editor-preview-place-live.test.mjs. Run: node tests/editor-codeblocks-visible-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CODEBLOCKS_VISIBLE_TEST_PORT || 5211);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CODEBLOCKS_VISIBLE_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

// a long document: a fenced bash block in every section (the first ones on screen at load, later ones far down)
const sections = [];
for (let s = 1; s <= 80; s++) {
  sections.push(`## Section ${s}`, '', `Paragraph of section ${s} with some words to read, repeated for length.`, '', '```bash', `# section ${s}`, `echo "section ${s}"`, `export COUNT_${s}=${s}`, 'ls -la', '```', '', `- item one of ${s}`, `- item two of ${s}`, '');
}
const CODE_MD = ['# Code document', '', 'Intro paragraph.', '', ...sections].join('\n');
const OTHER_MD = '# Other\n\nShort document without code.\n';

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.evaluate(async ({ CODE_MD, OTHER_MD }) => {
  const { db } = await import('/src/db/database.js');
  await db.documents.clear();
  const now = new Date();
  await db.documents.add({ title: 'Code document', content: CODE_MD, category: 'General', stableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', createdAt: now, updatedAt: now });
  const id = await db.documents.add({ title: 'Other', content: OTHER_MD, category: 'General', stableId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', createdAt: new Date(now.getTime() + 1000), updatedAt: new Date(now.getTime() + 1000) });
  localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Other', category: 'General', inCloud: false }]));
  localStorage.setItem('currentDocumentId', JSON.stringify(id));
  localStorage.setItem('whatsNewLastSeen', '99.0.0');
  localStorage.setItem('previewAllDocuments', 'false');
  localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General']));
}, { CODE_MD, OTHER_MD });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(800); }
await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

const SURFACE = "(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)";
// what the editor shows right now: the top line, how many code lines are on screen and how many are drawn as a block
// (tinted, in the code font), the fence labels and the syntax-coloured spans - and whether anything scrolled
const snapshot = () => page.evaluate(`(() => {
  const s = ${SURFACE}; if (!s) return null;
  const view = s.view;
  const top = s.topVisibleLine();
  const scrollTop = s.scrollTop;
  const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line'));
  const r = view.scrollDOM.getBoundingClientRect();
  const onScreen = lines.filter((el) => { const b = el.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; });
  const codeText = onScreen.filter((el) => /^(# section \d|echo "section|export COUNT_|ls -la)/.test(el.textContent));
  const tinted = codeText.filter((el) => el.classList.contains('cm-code-block') && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const labels = onScreen.filter((el) => el.querySelector('.cm-code-info')).length;
  const coloured = onScreen.filter((el) => el.querySelector('[class*="hljs-"]')).length;
  return { top, scrollTop, onScreen: onScreen.length, codeText: codeText.length, tinted: tinted.length, labels, coloured };
})()`);
const snapshotReady = async () => { let snap = null; await waitFor(async () => { snap = await snapshot(); return !!snap; }, 5000); return snap; };
const styledNow = (snap) => snap && snap.codeText > 0 && snap.tinted === snap.codeText && snap.labels > 0 && snap.coloured > 0;
const inPreview = async () => (await page.locator('.markdown-preview').count()) > 0;
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
// the mode toggle, then the other view's presence (a mount, not a time)
const toggle = async () => { const was = await inPreview(); await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(1300); if ((await inPreview()) === was) console.log(`  (the view did not change: ${was ? 'still the preview' : 'still the editor'})`); };
const previewScrollToLine = (n) => page.evaluate(async (n) => { const m = await import('/src/utils/previewPlace.js'); const c = document.querySelector('.markdown-preview'); const b = m.previewBlockForLine(c, n); m.scrollPreviewToBlock(c, b); return b ? Number(b.dataset.sourceLine) : null; }, n);
const openDoc = async (title) => { await page.locator('.sc-row', { hasText: title }).first().click(); await waitFor(async () => (await page.evaluate(`(() => { const s = ${SURFACE}; return s ? s.value.slice(0, 40) : ''; })()`)).includes(title)); await sleep(150); };

try {
  console.log('\n--- opened from another document (the sidebar), no scrolling ---');
  await openDoc('Other');
  check('the Other document is up in the editor (no code)', !(await inPreview()) && (await snapshot()).codeText === 0, JSON.stringify(await snapshot()));
  await openDoc('Code document');
  let s = await snapshotReady();
  console.log(`  ${JSON.stringify(s)}`);
  check('the Code document shows its first blocks tinted, labelled and coloured right away (no scroll: scrollTop 0)', styledNow(s) && s.scrollTop === 0, JSON.stringify(s));

  console.log('\n--- Preview -> Editor at the top ---');
  await toggle();
  check('the preview is up', await inPreview());
  await toggle();
  s = await snapshotReady();
  if (!s) console.log('  debug: ' + JSON.stringify(await page.evaluate(() => ({ hosts: document.querySelectorAll('.sc-editor-cm').length, cm: document.querySelectorAll('.cm-editor').length, surface: !!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface), preview: document.querySelectorAll('.markdown-preview').length }))));
  console.log(`  ${JSON.stringify(s)}`);
  check('back in the editor at the top: the blocks in view are styled at once', styledNow(s) && s.top <= 2, JSON.stringify(s));

  console.log('\n--- Preview scrolled to a code section far down -> Editor, no scrolling ---');
  await toggle();
  const target = await previewScrollToLine(700); await page.waitForTimeout(300);
  await toggle();
  s = await snapshotReady();
  console.log(`  preview scrolled to the block of line ${target}; ${JSON.stringify(s)}`);
  check('the editor lands at that section (top line within 5 of the block) and the blocks in view are tinted, labelled and coloured at once', target && Math.abs(s.top - target) <= 5 && styledNow(s), JSON.stringify(s));
  const before = s.scrollTop;
  await page.waitForTimeout(600);
  s = await snapshotReady();
  check('...and nothing scrolled meanwhile (the styling did not need the blocks to leave and come back)', s.scrollTop === before && styledNow(s), JSON.stringify(s));

  console.log('\n--- a long document with blocks on screen at load (reload) ---');
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (await inPreview()) await toggle();
  await openDoc('Code document');
  s = await snapshotReady();
  console.log(`  ${JSON.stringify(s)}`);
  check('after a reload the Code document\'s blocks on screen are styled at once', styledNow(s), JSON.stringify(s));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await context.close().catch(() => {});
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
