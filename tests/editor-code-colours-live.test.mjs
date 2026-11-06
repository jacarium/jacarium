#!/usr/bin/env node
/**
 * Syntax colours inside fenced code in the editor, in the real Documents page
 * (Vite dev server + headless Chromium), dark and light:
 *   - the python / bash / yaml fences carry highlight tokens whose computed
 *     colours differ from the block's base text colour, over the theme's
 *     --os-code-* tokens (the same ones the preview uses: the same class set
 *     for the same snippet in the editor and in the preview);
 *   - a ```rust fence and a bare fence stay uncoloured (no auto-detect);
 *   - the json fence far below the viewport is not coloured until scrolled to;
 *   - the caret, a selection and typing inside a coloured block work; the
 *     doc-link chip and the inline code mark are still drawn.
 * Screenshots: /private/tmp/claude-501/shots/editor-code-colours/{dark,light}.png
 * (EDITOR_CODE_COLOURS_SHOTS_DIR overrides).
 *
 * SKIPs like tests/markdown-callouts-ui.test.mjs. Run: node tests/editor-code-colours-live.test.mjs
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
const PORT = Number(process.env.CODE_COLOURS_TEST_PORT || 5203);
const OUT = process.env.EDITOR_CODE_COLOURS_SHOTS_DIR || '/private/tmp/claude-501/shots/editor-code-colours';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CODE_COLOURS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const PY = 'import sys\n\ndef main(argv):\n    print("hello", argv)  # greet\n    return 0\n';
const MD = [
  '# Deploy runbook',
  '',
  'Run `kubectl get pods -n demo` first; see [[doc:11111111-2222-4333-8444-555555555555]].',
  '',
  '```python', PY.trimEnd(), '```',
  '',
  '```bash', 'set -euo pipefail', 'for h in web-1 web-2; do', '  ssh "$h" systemctl restart app  # each host', 'done', '```',
  '',
  '```yaml', 'replicas: 3', 'image:', '  name: app', '  tag: "4.1.0"', '```',
  '',
  '```rust', 'fn main() { println!("no colours"); }', '```',
  '',
  '```', 'a bare fence stays plain', '```',
  '',
  ...Array.from({ length: 400 }, (_, i) => `Filler paragraph ${i + 1} to push the last block below the viewport.`),
  '',
  '```json', '{ "far": "below", "n": 1 }', '```',
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
    const now = new Date();
    await db.documents.add({ title: 'Target', content: '# Target', category: 'General', stableId: '11111111-2222-4333-8444-555555555555', createdAt: now, updatedAt: now });
    const id = await db.documents.add({ title: 'Deploy runbook', content: md, category: 'General', stableId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdAt: new Date(now.getTime() + 1000), updatedAt: new Date(now.getTime() + 1000) });
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
  await page.waitForTimeout(500);
  return { context, page, errors };
}

const measure = (page) => page.evaluate(() => {
  const content = document.querySelector('.sc-editor-cm .cm-content');
  const block = document.querySelector('.sc-editor-cm .cm-line.cm-code-block');
  const baseColor = block && getComputedStyle(block).color;
  const tokens = Array.from(document.querySelectorAll('.sc-editor-cm [class*="hljs-"]'));
  const byClass = {};
  for (const t of tokens) { const c = t.className.split(' ').find((x) => x.startsWith('hljs-')); byClass[c] = byClass[c] || getComputedStyle(t).color; }
  const texts = tokens.map((t) => t.textContent);
  const lineOf = (text) => Array.from(document.querySelectorAll('.sc-editor-cm .cm-line')).find((l) => l.textContent.includes(text));
  const rust = lineOf('println!');
  const bare = lineOf('a bare fence');
  return {
    editorColor: getComputedStyle(content).color, baseColor,
    tokenCount: tokens.length, byClass, texts: texts.slice(0, 40),
    distinct: new Set(Object.values(byClass)).size,
    rustTokens: rust ? rust.querySelectorAll('[class*="hljs-"]').length : -1,
    bareTokens: bare ? bare.querySelectorAll('[class*="hljs-"]').length : -1,
    jsonVisible: !!lineOf('"far"'), jsonTokens: lineOf('"far"') ? lineOf('"far"').querySelectorAll('[class*="hljs-"]').length : -1,
    chip: document.querySelectorAll('.sc-editor-cm .cm-doc-link-chip').length, inline: document.querySelectorAll('.sc-editor-cm .cm-inline-code').length,
  };
});
const previewClasses = (page, code, lang) => page.evaluate(async ([code, lang]) => { const { highlightCode } = await import('/src/utils/codeHighlight.js'); const div = document.createElement('div'); div.innerHTML = highlightCode(code, lang); return Array.from(div.querySelectorAll('[class]')).map((e) => e.className).sort(); }, [code, lang]);
const editorClasses = (page, text) => page.evaluate((text) => { const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line')); const start = lines.findIndex((l) => l.textContent.includes(text)); const out = []; for (let i = start; i < lines.length; i++) { if (lines[i].textContent.trim() === '```') break; out.push(...Array.from(lines[i].querySelectorAll('[class*="hljs-"]')).map((e) => e.className)); } return out.sort(); }, text);

try {
  const results = {};
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    const m = await measure(page);
    results[theme] = m;
    check(`${theme}: the fences carry highlight tokens in several colours, different from the block's text colour`, m.tokenCount >= 20 && m.distinct >= 3 && Object.values(m.byClass).some((c) => c !== m.baseColor), JSON.stringify({ count: m.tokenCount, distinct: m.distinct, base: m.baseColor, byClass: m.byClass }));
    check(`${theme}: the keyword, the string and the comment have their own colours`, m.byClass['hljs-keyword'] && m.byClass['hljs-string'] && m.byClass['hljs-comment'] && new Set([m.byClass['hljs-keyword'], m.byClass['hljs-string'], m.byClass['hljs-comment']]).size === 3, JSON.stringify(m.byClass));
    const pc = await previewClasses(page, PY, 'python');
    const ec = await editorClasses(page, 'import sys');
    check(`${theme}: the python fence's classes in the editor are the preview's for the same snippet`, ec.join('|') === pc.join('|'), `editor ${ec.join('|')} vs preview ${pc.join('|')}`);
    check(`${theme}: the rust fence and the bare fence are not coloured; the json fence below the viewport is not rendered yet`, m.rustTokens === 0 && m.bareTokens === 0 && !m.jsonVisible, JSON.stringify({ rust: m.rustTokens, bare: m.bareTokens, json: m.jsonVisible }));
    check(`${theme}: the doc-link chip and the inline code mark are still drawn`, m.chip === 1 && m.inline === 1);
    await page.locator('.sc-editor-cm').screenshot({ path: path.join(OUT, `${theme}.png`) });
    await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm .cm-scroller'); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(600);
    const after = await measure(page);
    check(`${theme}: scrolled to the end: the json fence is coloured now`, after.jsonVisible && after.jsonTokens > 0, JSON.stringify({ json: after.jsonVisible, tokens: after.jsonTokens }));
    await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm .cm-scroller'); s.scrollTop = 0; });
    await page.waitForTimeout(400);
    if (theme === 'dark') {
      const value = await pwEditorValue(page);
      const pos = value.indexOf('    return 0') + '    return 0'.length;
      await pwSelect(page, pos, pos);
      await page.keyboard.type('  # done', { delay: 15 }); await page.waitForTimeout(400);
      const typed = await measure(page);
      check('typing inside a coloured block: the text changed and the new comment is coloured as a comment', (await pwEditorValue(page)).includes('return 0  # done') && typed.texts.includes('# done'), JSON.stringify(typed.texts.slice(0, 12)));
      await pwSelect(page, pos - 8, pos);
      const sel = await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm').editorSurface; return { start: s.selectionStart, end: s.selectionEnd, layer: !!document.querySelector('.sc-editor-cm .cm-selectionLayer') }; });
      check('a selection across coloured tokens is held and drawn', sel.end - sel.start === 8 && sel.layer, JSON.stringify(sel));
    }
    check(`${theme}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
  check('dark and light colour the keyword differently (the theme tokens)', results.dark.byClass['hljs-keyword'] !== results.light.byClass['hljs-keyword'], `${results.dark.byClass['hljs-keyword']} / ${results.light.byClass['hljs-keyword']}`);
  console.log(`  screenshots: ${OUT}/dark.png, ${OUT}/light.png`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
