#!/usr/bin/env node
/**
 * The selection highlight over code blocks in the editor (src/index.css, the .cm-selectionLayer rule next to the
 * .cm-code-block styles), in the real Documents page (Vite dev server + headless Chromium), dark and light.
 *
 * THE BUG: selecting text inside a fenced block selected it (copy worked) but showed no highlight - drawSelection()
 * paints its rectangles in a layer CodeMirror orders below the content (z-index -1 in the scroller's stacking
 * context) and the block's opaque line background (.cm-line.cm-code-block) covered it; inline code's mark
 * background and the doc-link chips did the same. The selection layer now sits above the content (its colour is
 * translucent in every theme), taking no pointer events.
 *
 * What is checked, by pixels (pngjs): a row of pixels through a selection rectangle, sampled with nothing selected
 * and again with the selection - with the highlight visible most of them change; with the layer forced back under
 * the content (the bug, re-created with one style rule) none does, which is the before screenshot and proves the
 * measure. Three selections: inside a fenced block, across a paragraph into the block, across inline code. Then the
 * huge-document mode (drawSelection() off, isHugeDocument): the native selection over a block changes the pixels
 * too. Screenshots: /private/tmp/claude-501/shots/codeblock-selection/{before,after}-{dark,light}.png
 * (CODEBLOCK_SELECTION_SHOTS_DIR overrides).
 *
 * SKIPs like tests/editor-code-blocks-live.test.mjs. Run: node tests/editor-codeblock-selection-live.test.mjs
 * (CODEBLOCK_SELECTION_TEST_PORT, default 5205)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { pwEditorValue, pwSelect, EDITOR_EXPR } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CODEBLOCK_SELECTION_TEST_PORT || 5205);
const OUT = process.env.CODEBLOCK_SELECTION_SHOTS_DIR || '/private/tmp/claude-501/shots/codeblock-selection';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static: the rule and the translucent tokens it relies on ----
{
  const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
  check('the selection layer is ordered above the content with !important (CodeMirror sets its z-index inline) and takes no pointer events', /\.sc-editor-cm\.cm-editor > \.cm-scroller > \.cm-selectionLayer \{ z-index: 1 !important; pointer-events: none; \}/.test(css));
  const tokens = [...css.matchAll(/--os-terminal-selection:\s*([^;]+);/g)].map((m) => m[1].trim());
  check(`every theme's selection colour is translucent (rgba with alpha under 0.5), so the text reads through it: ${tokens.join(' / ')}`, tokens.length >= 3 && tokens.every((t) => { const m = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(t); return m && Number(m[1]) > 0 && Number(m[1]) < 0.5; }), tokens.join(' / '));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(failed ? 1 : 0); }
const { PNG } = await import('pngjs');
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CODEBLOCK_SELECTION_TEST_PORT)`); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(failed ? 1 : 0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(failed ? 1 : 0); }
fs.mkdirSync(OUT, { recursive: true });

const MD = [
  '# Deploy runbook',
  '',
  'Run `kubectl get pods -n demo` first, then the script below.',
  '',
  '```python',
  'import sys',
  '',
  'def main(argv):',
  '    print("hello world from the runbook", argv)',
  '    return 0',
  '```',
  '',
  'Then on the host, see [[doc:cccccccc-cccc-4ccc-8ccc-cccccccccccc]] for the rest.',
  '',
].join('\n');
// the bug re-created: the layer back under the content
const BUG_CSS = '.sc-editor-cm.cm-editor > .cm-scroller > .cm-selectionLayer { z-index: -1 !important; }';

async function open(theme, md) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, reducedMotion: 'reduce', colorScheme: theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(async ({ md, theme }) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const id = await db.documents.add({ title: 'Deploy runbook', content: md, category: 'General', stableId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Deploy runbook', category: 'General', inCloud: false }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    localStorage.setItem('previewAllDocuments', 'false');
    localStorage.setItem('app-theme', theme);
  }, { md, theme });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(800); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; } .sc-editor-cm .cm-cursor { display: none !important; }' });
  return { context, page, errors };
}

/** The pixels of one row (y) across x0..x1 of the page, as [r,g,b] triples. */
async function row(page, x0, x1, y) {
  const buf = await page.screenshot({ type: 'png', clip: { x: Math.floor(x0), y: Math.floor(y), width: Math.max(1, Math.floor(x1 - x0)), height: 1 } });
  const png = PNG.sync.read(buf);
  const out = [];
  for (let i = 0; i < png.width; i++) out.push([png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]]);
  return out;
}
const differs = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 2);
/** How many of the row's pixels changed between two samples (0..1). */
const changed = (before, after) => { const n = Math.min(before.length, after.length); let c = 0; for (let i = 0; i < n; i++) if (differs(before[i], after[i])) c++; return n ? c / n : 0; };
/** The drawn selection's rectangles that lie on a code-block line (or any, when `inBlock` is false). */
const selectionRects = (page, inBlock) => page.evaluate((inBlock) => {
  const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line.cm-code-block')).map((l) => l.getBoundingClientRect());
  return Array.from(document.querySelectorAll('.sc-editor-cm .cm-selectionLayer .cm-selectionBackground')).map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
    .filter((r) => r.w > 8 && r.h > 4 && (!inBlock || lines.some((l) => r.y >= l.top - 1 && r.y + r.h <= l.bottom + 1)));
}, inBlock);
const nativeRects = (page) => page.evaluate(() => { const s = window.getSelection(); if (!s || s.rangeCount === 0) return []; return Array.from(s.getRangeAt(0).getClientRects()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })).filter((r) => r.w > 8 && r.h > 4); });
const deselect = (page) => page.evaluate((expr) => { const s = eval(expr); s.focus(); s.setSelectionRange(0, 0); }, EDITOR_EXPR);

/** Select `text` (its first occurrence, or from `fromText` to the end of `text`) and measure a rectangle's row before / after. */
async function measureSelection(page, { fromText, text, inBlock = true, native = false }) {
  const value = await pwEditorValue(page);
  const start = value.indexOf(fromText || text);
  const end = value.indexOf(text) + text.length;
  await deselect(page); await page.waitForTimeout(150);
  await pwSelect(page, start, end); await page.waitForTimeout(250);
  const rects = native ? await nativeRects(page) : await selectionRects(page, inBlock);
  if (!rects.length) return { rects: 0 };
  const r = rects[rects.length - 1];
  const y = r.y + r.h / 2, x0 = r.x + 1, x1 = r.x + r.w - 1;
  const withSelection = await row(page, x0, x1, y);
  await deselect(page); await page.waitForTimeout(150);
  const without = await row(page, x0, x1, y);
  return { rects: rects.length, changed: changed(without, withSelection), width: Math.round(r.w) };
}

try {
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme, MD);
    check(`${theme}: the editor shows the fenced block and the inline code`, (await page.locator('.sc-editor-cm .cm-line.cm-code-block').count()) >= 6 && (await page.locator('.sc-editor-cm .cm-inline-code').count()) === 1);
    // the bug, re-created: the layer under the content - nothing changes on the block's row (and the "before" screenshot)
    const bug = await page.addStyleTag({ content: BUG_CSS });
    const hidden = await measureSelection(page, { text: 'hello world from the runbook' });
    check(`${theme}: with the layer under the content (the bug) a selection inside the block changes no pixel of its row - the measure sees the bug`, hidden.rects > 0 && hidden.changed < 0.05, JSON.stringify(hidden));
    await pwSelect(page, (await pwEditorValue(page)).indexOf('def main'), (await pwEditorValue(page)).indexOf('return 0') + 8); await page.waitForTimeout(250);
    await page.locator('.sc-editor-cm').screenshot({ path: path.join(OUT, `before-${theme}.png`) });
    await bug.evaluate((el) => el.remove());
    await page.waitForTimeout(200);
    // the fix: inside the block
    const inside = await measureSelection(page, { text: 'hello world from the runbook' });
    check(`${theme}: a selection inside the fenced block is drawn over the block's tint (${Math.round((inside.changed || 0) * 100)}% of the row's pixels change)`, inside.rects > 0 && inside.changed > 0.5, JSON.stringify(inside));
    // across the paragraph into the block
    const across = await measureSelection(page, { fromText: 'then the script', text: 'def main(argv):' });
    check(`${theme}: a selection from the paragraph into the block is drawn on the block's lines too`, across.rects > 0 && across.changed > 0.5, JSON.stringify(across));
    // across inline code
    const inline = await measureSelection(page, { fromText: 'Run `', text: 'pods -n demo` first', inBlock: false });
    check(`${theme}: a selection across inline code is drawn over its mark background`, inline.rects > 0 && inline.changed > 0.5, JSON.stringify(inline));
    // the doc-link chip
    const chip = await measureSelection(page, { fromText: 'host, see', text: 'for the rest', inBlock: false });
    check(`${theme}: a selection across a doc-link chip is drawn over the chip`, chip.rects > 0 && chip.changed > 0.5, JSON.stringify(chip));
    await pwSelect(page, (await pwEditorValue(page)).indexOf('def main'), (await pwEditorValue(page)).indexOf('return 0') + 8); await page.waitForTimeout(250);
    await page.locator('.sc-editor-cm').screenshot({ path: path.join(OUT, `after-${theme}.png`) });
    check(`${theme}: the selection layer takes no pointer events and sits above the content`, await page.evaluate(() => { const l = document.querySelector('.sc-editor-cm .cm-selectionLayer'); const cs = getComputedStyle(l); return cs.pointerEvents === 'none' && Number(cs.zIndex) === 1; }));
    // a click through the layer still places the caret
    const line = page.locator('.sc-editor-cm .cm-line.cm-code-block').nth(3);
    await line.click({ position: { x: 40, y: 8 } }); await page.waitForTimeout(200);
    const sel = await page.evaluate((expr) => { const s = eval(expr); return { start: s.selectionStart, end: s.selectionEnd }; }, EDITOR_EXPR);
    check(`${theme}: a click on a block line through the layer places the caret (no selection left)`, sel.start === sel.end && sel.start > 0, JSON.stringify(sel));
    check(`${theme}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
  // the huge-document mode: drawSelection() off, the native selection over the block
  {
    const huge = MD + '\n' + Array.from({ length: 260000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const { context, page, errors } = await open('dark', huge);
    const mode = await page.evaluate((expr) => { const s = eval(expr); return { huge: !!s._hugeDocument, layer: !!document.querySelector('.sc-editor-cm .cm-selectionLayer') }; }, EDITOR_EXPR);
    check('the huge document runs without the drawn selection (no selection layer)', mode.huge && !mode.layer, JSON.stringify(mode));
    const native = await measureSelection(page, { text: 'hello world from the runbook', native: true });
    check(`huge document: the native selection inside the block is visible over the tint (${Math.round((native.changed || 0) * 100)}% of the row's pixels change)`, native.rects > 0 && native.changed > 0.3, JSON.stringify(native));
    check('huge document: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
  console.log(`  screenshots: ${OUT}/{before,after}-{dark,light}.png`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
