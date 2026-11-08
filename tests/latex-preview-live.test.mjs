#!/usr/bin/env node
/**
 * ```latex blocks in the Documents preview, live (Vite dev server + headless
 * Chromium, no backend): a document with a simple formula, a multi-line
 * aligned one, two formulas separated by a blank line, a very wide one and
 * a broken one is previewed -
 *   - each block renders as KaTeX display maths (HTML + MathML), the source
 *     hidden, nothing of KaTeX fetched from a network host;
 *   - the blank-line block gives two displays;
 *   - the maths take the preview's text colour: the dark scheme, the light
 *     scheme and a custom-coloured palette (Nord);
 *   - the wide formula scrolls inside its box, the page never widens;
 *   - the broken formula is an error box with KaTeX's message and the source
 *     still shown;
 *   - the editor shows the block as a fenced block (tinted, "latex" label).
 * Screenshots (dark, light, Nord) in LATEX_SHOTS_DIR (/private/tmp/claude-501/shots/latex).
 *
 * SKIPs like tests/editor-preview-place-live.test.mjs. Run: node tests/latex-preview-live.test.mjs
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
const PORT = Number(process.env.LATEX_TEST_PORT || 5212);
const OUT = process.env.LATEX_SHOTS_DIR || '/private/tmp/claude-501/shots/latex';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (LATEX_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const DOC = [
  '# Maths', '', 'A paragraph before the maths.', '',
  '```latex', 'E = mc^2', '```', '',
  '```latex', '\\begin{aligned}', 'a &= b + c \\\\', '  &= d \\cdot \\frac{1}{2}', '\\end{aligned}', '```', '',
  '```latex', '\\int_0^1 x^2 \\, dx = \\tfrac{1}{3}', '', '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', '```', '',
  '```latex', 'x = ' + Array.from({ length: 40 }, (_, i) => `a_{${i}} b_{${i}}`).join(' + '), '```', '',
  '```latex', '\\frac{1}{', '```', '',
  'A paragraph after.', '',
].join('\n');

const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
const external = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(URL_) && !u.startsWith('data:') && !u.startsWith('blob:') && !/localhost:8080/.test(u)) external.push(u); });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.evaluate(async ({ DOC }) => {
  const { db } = await import('/src/db/database.js');
  await db.documents.clear();
  const now = new Date();
  const id = await db.documents.add({ title: 'Maths', content: DOC, category: 'General', stableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', createdAt: now, updatedAt: now });
  localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Maths', category: 'General', inCloud: false }]));
  localStorage.setItem('currentDocumentId', JSON.stringify(id));
  localStorage.setItem('whatsNewLastSeen', '99.0.0');
  localStorage.setItem('previewAllDocuments', 'false');
  localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General']));
  localStorage.setItem('app-theme', 'dark');
}, { DOC });
const reloadApp = async () => {
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
};
await reloadApp();
const inPreview = async () => (await page.locator('.markdown-preview').count()) > 0;
const toggle = async () => { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(1300); };
const waitRendered = async () => { const t0 = Date.now(); while (Date.now() - t0 < 20000) { const n = await page.evaluate(() => document.querySelectorAll('.latex-block[data-latex="rendered"], .latex-block[data-latex="error"]').length); if (n >= 5) return true; await sleep(100); } return false; };
const probe = () => page.evaluate(() => {
  const preview = document.querySelector('.markdown-preview');
  const blocks = Array.from(preview.querySelectorAll('.latex-block')).map((b) => {
    const out = b.querySelector('.latex-block-output');
    const display = out && out.querySelector('.katex-display');
    const katex = display && display.querySelector('.katex');
    return {
      state: b.dataset.latex, displays: out ? out.querySelectorAll('.katex-display').length : 0, mathml: out ? out.querySelectorAll('math').length : 0,
      preShown: b.querySelector('pre') ? getComputedStyle(b.querySelector('pre')).display !== 'none' : null,
      color: katex ? getComputedStyle(katex).color : null,
      scrollW: display ? display.scrollWidth : 0, clientW: display ? display.clientWidth : 0, overflowX: display ? getComputedStyle(display).overflowX : null,
      error: b.querySelector('.latex-block-error') ? b.querySelector('.mermaid-diagram-error-message').textContent : null,
      textAlign: display ? getComputedStyle(display).textAlign : null,
      links: out ? out.querySelectorAll('a, img, script, iframe').length : 0,
    };
  });
  return { blocks, textColor: getComputedStyle(preview.querySelector('p')).color, pageScrollW: document.documentElement.scrollWidth, pageClientW: document.documentElement.clientWidth, previewScrollW: preview.scrollWidth, previewClientW: preview.clientWidth, dark: document.documentElement.classList.contains('dark') };
});

try {
  console.log('\n--- the editor ---');
  check('the editor shows the document', !(await inPreview()));
  const ed = await page.evaluate(() => { const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line')); const tinted = lines.filter((l) => l.classList.contains('cm-code-block') && /E = mc/.test(l.textContent)).length; const labels = Array.from(document.querySelectorAll('.sc-editor-cm .cm-code-info')).map((l) => l.textContent.trim()); return { tinted, labels }; });
  check('a ```latex block is a fenced block in the editor: tinted lines and the "latex" label', ed.tinted === 1 && ed.labels.includes('latex'), JSON.stringify(ed));

  console.log('\n--- the preview, dark ---');
  await toggle();
  check('the five blocks render (or error) within 20 s', await waitRendered());
  let p = await probe();
  console.log(`  ${JSON.stringify(p.blocks.map((b) => [b.state, b.displays, b.mathml, b.error && b.error.slice(0, 40)]))}`);
  check('the simple formula: one display with HTML and MathML, the source hidden, no link / image / script in the output', p.blocks[0].state === 'rendered' && p.blocks[0].displays === 1 && p.blocks[0].mathml === 1 && p.blocks[0].preShown === false && p.blocks[0].links === 0, JSON.stringify(p.blocks[0]));
  check('the aligned multi-line formula renders as one display', p.blocks[1].state === 'rendered' && p.blocks[1].displays === 1, JSON.stringify(p.blocks[1]));
  check('two formulas separated by a blank line become two displays', p.blocks[2].state === 'rendered' && p.blocks[2].displays === 2 && p.blocks[2].mathml === 2, JSON.stringify(p.blocks[2]));
  check('the wide formula scrolls inside its box (overflow-x auto, scrollWidth > clientWidth) and the page and the preview did not widen', p.blocks[3].state === 'rendered' && p.blocks[3].overflowX === 'auto' && p.blocks[3].scrollW > p.blocks[3].clientW + 50 && p.pageScrollW <= p.pageClientW && p.previewScrollW <= p.previewClientW + 1, JSON.stringify([p.blocks[3], p.pageScrollW, p.pageClientW, p.previewScrollW, p.previewClientW]));
  check('the broken formula is an error box with KaTeX\'s message, its source still shown', p.blocks[4].state === 'error' && /Expected|Unexpected|group/i.test(p.blocks[4].error || '') && p.blocks[4].preShown === true, JSON.stringify(p.blocks[4]));
  check('the maths take the preview\'s text colour (dark)', p.dark && p.blocks[0].color === p.textColor && p.blocks[0].textAlign === 'center', JSON.stringify([p.blocks[0].color, p.textColor, p.blocks[0].textAlign]));
  check('nothing of KaTeX was fetched from a network host (stylesheet and fonts bundled)', external.length === 0, external.slice(0, 3).join(' '));
  await page.screenshot({ path: path.join(OUT, 'latex-preview-dark.png') });

  console.log('\n--- light, and a custom-coloured palette ---');
  await page.evaluate(() => localStorage.setItem('app-theme', 'light'));
  await reloadApp();
  if (!(await inPreview())) await toggle();
  check('the blocks render again after a reload (light)', await waitRendered());
  p = await probe();
  check('light: the maths take the light text colour', !p.dark && p.blocks[0].color === p.textColor && p.blocks[0].state === 'rendered', JSON.stringify([p.blocks[0].color, p.textColor]));
  await page.screenshot({ path: path.join(OUT, 'latex-preview-light.png') });
  await page.evaluate(() => localStorage.setItem('app-theme', 'starter-nord'));
  await reloadApp();
  if (!(await inPreview())) await toggle();
  check('the blocks render again (Nord)', await waitRendered());
  p = await probe();
  check('Nord: the maths take the palette\'s text colour (#eceff4)', p.blocks[0].color === 'rgb(236, 239, 244)' && p.blocks[0].color === p.textColor, JSON.stringify([p.blocks[0].color, p.textColor]));
  await page.screenshot({ path: path.join(OUT, 'latex-preview-nord.png') });
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}/`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await context.close().catch(() => {});
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
