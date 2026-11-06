#!/usr/bin/env node
/**
 * Code blocks in the editor, in the real Documents page (Vite dev server +
 * headless Chromium): a document with Python, Bash and YAML fences, an
 * indented block and inline code, in dark and in light:
 *   - the block lines have the code background (different from the editor's),
 *     the code font and the left edge; the fence lines are dimmed; the
 *     language label is drawn as a small badge; inline code has its mark;
 *   - the colours come from the theme (dark and light differ);
 *   - only the visible lines are decorated: a block far below the viewport
 *     has no decorated line in the DOM until it is scrolled to;
 *   - the caret and a selection inside a block work (typing in a block keeps
 *     it a block).
 * Screenshots: /private/tmp/claude-501/shots/editor-code-blocks/{dark,light}.png
 * (EDITOR_CODE_BLOCKS_SHOTS_DIR overrides).
 *
 * SKIPs like tests/markdown-callouts-ui.test.mjs. Run: node tests/editor-code-blocks-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { pwEditorValue, pwSelect } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CODE_BLOCKS_TEST_PORT || 5199);
const OUT = process.env.EDITOR_CODE_BLOCKS_SHOTS_DIR || '/private/tmp/claude-501/shots/editor-code-blocks';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CODE_BLOCKS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
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
  '    print("hello", argv)',
  '    return 0',
  '',
  'if __name__ == "__main__":',
  '    sys.exit(main(sys.argv))',
  '```',
  '',
  'Then on the host:',
  '',
  '```bash',
  'set -euo pipefail',
  'for h in web-1 web-2; do',
  '  ssh "$h" systemctl restart app',
  'done',
  '```',
  '',
  'The config it reads:',
  '',
  '```yaml',
  'replicas: 3',
  'image:',
  '  name: app',
  '  tag: 4.1.0',
  '```',
  '',
  'An indented block:',
  '',
  '    plain indented code',
  '    second line',
  '',
  'Done.',
  '',
  ...Array.from({ length: 400 }, (_, i) => `Filler paragraph ${i + 1} to push the last block below the viewport.`),
  '',
  '```json',
  '{ "far": "below" }',
  '```',
  '',
].join('\n');

async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
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
    if (theme === 'light') localStorage.setItem('app-theme', JSON.stringify('light')); else localStorage.removeItem('app-theme');
  }, { md: MD, theme });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(800); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  return { context, page, errors };
}

const measure = (page) => page.evaluate(() => {
  const content = document.querySelector('.sc-editor-cm .cm-content');
  const base = getComputedStyle(content);
  const block = document.querySelector('.sc-editor-cm .cm-line.cm-code-block');
  const bs = block && getComputedStyle(block);
  const fence = document.querySelector('.sc-editor-cm .cm-code-fence');
  const info = document.querySelector('.sc-editor-cm .cm-code-info');
  const inline = document.querySelector('.sc-editor-cm .cm-inline-code');
  const first = document.querySelector('.sc-editor-cm .cm-line.cm-code-block-first');
  const labels = Array.from(document.querySelectorAll('.sc-editor-cm .cm-code-info')).map((e) => e.textContent);
  return {
    editorBg: base.backgroundColor, editorFont: base.fontFamily,
    blockBg: bs && bs.backgroundColor, blockFont: bs && bs.fontFamily, blockShadow: bs && bs.boxShadow,
    blockLines: document.querySelectorAll('.sc-editor-cm .cm-line.cm-code-block').length,
    fenceColor: fence && getComputedStyle(fence).color, fenceOpacity: fence && getComputedStyle(fence).opacity,
    labels, labelBg: info && getComputedStyle(info).backgroundColor, labelRadius: info && getComputedStyle(info).borderRadius, inlineRadius: inline && getComputedStyle(inline).borderRadius, firstRadius: first && getComputedStyle(first).borderTopLeftRadius,
    inlineBg: inline && getComputedStyle(inline).backgroundColor, inlineFont: inline && getComputedStyle(inline).fontFamily,
    textColor: base.color, blockColor: bs && bs.color,
  };
});

try {
  const results = {};
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    const m = await measure(page);
    results[theme] = m;
    check(`${theme}: the block lines have the code background, different from the editor's, the code font and a left edge`, m.blockLines >= 16 && m.blockBg && m.blockBg !== m.editorBg && /mono|Mono|Red Hat Mono/.test(m.blockFont) && m.blockShadow !== 'none', JSON.stringify(m));
    check(`${theme}: the fence lines are dimmed and the languages show as labels (python, bash, yaml)`, m.fenceOpacity && Number(m.fenceOpacity) < 1 && m.labels.join() === 'python,bash,yaml', JSON.stringify(m.labels));
    check(`${theme}: the label is a small square badge (background, no rounding), inline code and the block are square, and inline code has its mark in the code font`, m.labelBg && m.labelBg !== 'rgba(0, 0, 0, 0)' && m.labelRadius === '0px' && m.inlineRadius === '0px' && (m.firstRadius == null || m.firstRadius === '0px') && m.inlineBg && m.inlineBg !== 'rgba(0, 0, 0, 0)' && /mono|Mono/.test(m.inlineFont), JSON.stringify(m));
    check(`${theme}: the block below the viewport (the json fence) is not decorated until scrolled to`, !m.labels.includes('json'));
    await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm .cm-scroller'); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(500);
    const after = await measure(page);
    check(`${theme}: scrolled to the end: the json block is decorated now`, after.labels.includes('json'), JSON.stringify(after.labels));
    await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm .cm-scroller'); s.scrollTop = 0; });
    await page.waitForTimeout(400);
    // the caret in a block: typing keeps it a block
    const value = await pwEditorValue(page);
    const pos = value.indexOf('    return 0') + '    return 0'.length;
    await pwSelect(page, pos, pos);
    await page.keyboard.type('  # ok', { delay: 15 }); await page.waitForTimeout(300);
    const typed = await measure(page);
    check(`${theme}: typing inside a block keeps the block (same line count, the text changed)`, typed.blockLines === m.blockLines && (await pwEditorValue(page)).includes('return 0  # ok'));
    await page.locator('.sc-editor-cm').screenshot({ path: path.join(OUT, `${theme}.png`) });
    check(`${theme}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
  check('dark and light use different code backgrounds (the theme tokens)', results.dark.blockBg !== results.light.blockBg, `${results.dark.blockBg} / ${results.light.blockBg}`);
  console.log(`  screenshots: ${OUT}/dark.png, ${OUT}/light.png`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
