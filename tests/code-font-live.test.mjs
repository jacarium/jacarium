#!/usr/bin/env node
/**
 * The code font (Settings > Accessibility > Code font), live: Playwright
 * against the Vite dev server and a throwaway Flask backend on a spare port
 * with the synthetic sosreport fixture (tests/helpers/diagnostics-driver -
 * no real data), the backend calls proxied by the browser like the other
 * Diagnostics live tests.
 *
 * For each code font offered besides Default: the editor's code block,
 * inline code and line-number gutter, the Preview's code block and inline
 * code, a Diagnostics report monospace cell and a Log Viewer line all
 * compute to the chosen family; document.fonts.check is true in the page
 * and inside the frame; the text stays monospace (two strings of equal
 * length have equal width), carries no letter spacing, and indented lines
 * align on character columns; back to Default, Red Hat Mono returns. The
 * fonts load lazily (nothing of them before the choice).
 *
 * SKIPS without Chromium, python3, backend/venv or when the ports are busy.
 * Port CODE_FONT_TEST_PORT (5239; Flask on +1000).
 * Run: node tests/code-font-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { EDITOR_EXPR } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CODE_FONT_TEST_PORT || 5239);
const FLASK = PORT + 1000;
const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = async (why, cleanup) => { console.log(`SKIP: ${why}`); if (cleanup) await cleanup(); process.exit(0); };
if (process.env.SKIP_BROWSER_TESTS) await skip('SKIP_BROWSER_TESTS is set');
let pw;
try { pw = req('playwright-core'); } catch { await skip('playwright-core is not installed'); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT)) || !(await portFree(FLASK))) await skip(`port ${PORT} or ${FLASK} is busy (CODE_FONT_TEST_PORT)`);
const python = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(python)) await skip('backend/venv is missing');
const fx = await new Promise((resolve) => { const r = spawn('python3', [path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'make_fixture.py')], { stdio: 'ignore' }); r.once('exit', (code) => resolve(code === 0 && fs.existsSync(path.join(FIXTURE_ROOT, FIXTURE_REPORT)))); r.once('error', () => resolve(false)); });
if (!fx) await skip('the synthetic diagnostics fixture could not be built (python3?)');
const token = randomBytes(16).toString('hex');
const flask = reapOnExit(spawn(python, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...process.env, APP_AUTH_TOKEN: token, PORT: String(FLASK), FLASK_DEBUG: '0' }, stdio: 'ignore' }));
let flaskReady = false;
for (let i = 0; i < 120 && !flaskReady; i++) { try { flaskReady = (await fetch(`http://127.0.0.1:${FLASK}/health`)).ok; } catch { await sleep(250); } if (flask.exitCode !== null) break; }
const stopFlask = () => { try { flask.kill('SIGTERM'); } catch { /* gone */ } };
if (!flaskReady) await skip('the Flask backend did not come up on the spare port', stopFlask);
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { await skip(`Chromium could not start (${String(e.message).split('\n')[0]})`, stopFlask); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } stopFlask(); };
if (!ready) await skip('the Vite dev server did not come up', stop);

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(({ dir }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('diagnosticsReportsDirectory', dir); } catch { /* storage */ } }, { dir: FIXTURE_ROOT });
const cors = (origin) => ({ 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-app-token, authorization', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-credentials': 'true' });
await context.route(/^http:\/\/(localhost|127\.0\.0\.1):8080\//, async (route) => {
  const r = route.request();
  const origin = r.headers().origin || URL_.replace(/\/$/, '');
  if (r.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors(origin) }); return; }
  if (/\/socket\.io\//.test(r.url())) { await route.abort(); return; }
  try {
    const res = await route.fetch({ url: r.url().replace(/^http:\/\/(localhost|127\.0\.0\.1):8080/, `http://127.0.0.1:${FLASK}`), headers: { ...r.headers(), 'x-app-token': token } });
    const headers = { ...res.headers(), ...cors(origin) };
    delete headers['content-encoding']; delete headers['content-length'];
    await route.fulfill({ status: res.status(), headers, body: await res.body() });
  } catch (e) { await route.fulfill({ status: 502, body: String(e) }); }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const domClick = (locator) => locator.first().evaluate((el) => el.click());
const goTo = async (label) => { await domClick(page.locator(`nav.w-16 button[aria-label="${label}"]`)); await page.mouse.move(700, 450); await sleep(900); };
const openTab = async (label) => { const ok = await page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label); await sleep(3500); return ok; };
const reportFrame = async () => { for (let i = 0; i < 40; i++) { for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { if (await f.evaluate(() => !!document.getElementById('diagnostics-content') && document.body.textContent.trim().length > 50)) return f; } catch { /* detached */ } } await sleep(250); } return null; };
const family = (ff) => (ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
// what an element computes to, and whether its font still behaves as monospace: two strings of equal length set in the
// element's own font measure the same width (the probe spans are removed again)
const MEASURE = `(sel, root) => {
  const el = (root || document).querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const probe = (text) => { const s = document.createElement('span'); s.textContent = text; s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;letter-spacing:inherit;word-spacing:inherit'; el.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
  const narrow = probe('iiiiiiiiiiiiiiiiiiii'), wide = probe('MMMMMMMMMMMMMMMMMMMM'), space = probe('                    ');
  return { tag: el.tagName + '.' + String(el.className).slice(0, 40), family: cs.fontFamily, letter: cs.letterSpacing, word: cs.wordSpacing, size: cs.fontSize, narrow, wide, space, mono: Math.abs(narrow - wide) < 0.6 && Math.abs(narrow - space) < 0.6 };
}`;
const measure = (sel) => page.evaluate(`(${MEASURE})(${JSON.stringify(sel)})`);
const measureIn = (frame, sel) => frame.evaluate(`(${MEASURE})(${JSON.stringify(sel)})`);
// the columns of the code block: the x of the first glyph of each line against its indentation in spaces
const columns = (sel) => page.evaluate((sel) => {
  const lines = Array.from(document.querySelectorAll(sel)).filter((l) => /\S/.test(l.textContent));
  const out = [];
  for (const line of lines) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node; let offset = 0; let found = null;
    while ((node = walker.nextNode())) { const m = /\S/.exec(node.textContent); if (m) { found = { node, i: m.index }; break; } offset += node.textContent.length; }
    if (!found) continue;
    const range = document.createRange(); range.setStart(found.node, found.i); range.setEnd(found.node, found.i + 1);
    const r = range.getBoundingClientRect();
    out.push({ text: line.textContent.slice(0, 24), indent: offset + found.i, x: r.left, w: r.width });
  }
  return out;
}, sel);
const aligned = (cols) => { if (cols.length < 3) return false; const base = cols.find((c) => c.indent === 0); if (!base) return false; const unit = base.w; return cols.every((c) => Math.abs((c.x - base.x) - c.indent * unit) < 1.5); };
// a face of the family declared in the page (document.fonts lists the @font-face rules; fonts.check alone answers
// true for a family the page never declared), and loaded
const fontDeclared = (name) => page.evaluate((name) => Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === name), name);
const fontsCheck = (name) => page.evaluate((name) => Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === name && f.status === 'loaded') && document.fonts.check(`12px "${name}"`), name);
const waitFont = async (name) => { for (let i = 0; i < 40; i++) { if (await fontsCheck(name)) return true; await sleep(250); } return false; };
const text = '# Code font\n\nInline `code 0O1lI` in a sentence.\n\n```python\ndef f(x):\n    if x:\n        return "0O1lI"\n    return None\n```\n';

const RA = await import(path.join(REPO, 'src/utils/readingAids.js'));
const CODE_FONTS = Object.entries(RA.CODE_FONTS).filter(([id]) => id !== 'default');

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check(`the code fonts offered besides Default: ${CODE_FONTS.map(([, f]) => f.label).join(', ')}`, CODE_FONTS.length >= 1);
  for (const [, f] of CODE_FONTS) check(`${family(f.family)}: no face of it is declared before it is chosen (lazy)`, !(await fontDeclared(family(f.family))));
  const nd = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; });
  check('New Document', nd);
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(300);
  // typed through the editor (its onChange feeds the document the Preview renders; a value set on the surface would not)
  await page.locator('.sc-editor-cm .cm-content').click(); await page.keyboard.insertText(text); await sleep(600);
  await page.evaluate((expr) => { const s = eval(expr); s.setSelectionRange(0, 0); }, EDITOR_EXPR);
  const before = { code: await measure('.sc-editor-cm .cm-line.cm-code-block'), gutter: await measure('.sc-editor-cm .cm-gutters'), inline: await measure('.sc-editor-cm .cm-inline-code') };
  check(`today: the editor's code block, gutter and inline code are Red Hat Mono (${before.code && family(before.code.family)}), monospace, no spacing`, before.code && before.gutter && before.inline && [before.code, before.gutter, before.inline].every((m) => family(m.family) === 'Red Hat Mono' && m.mono && /^(normal|0px)$/.test(m.letter)), JSON.stringify(before));

  for (const [id, f] of CODE_FONTS) {
    const name = family(f.family);
    await setAids({ codeFont: id }); await sleep(300);
    check(`${name}: chosen, the font loads (document.fonts.check)`, await waitFont(name));
    await sleep(400);
    const code = await measure('.sc-editor-cm .cm-line.cm-code-block');
    const gutter = await measure('.sc-editor-cm .cm-gutters');
    const inline = await measure('.sc-editor-cm .cm-inline-code');
    const prose = await measure('.sc-editor-cm .cm-line:not(.cm-code-block)');
    check(`${name}: the editor's code block computes to it, still monospace (equal advance), no letter spacing, the size unchanged (${code && code.size})`, code && family(code.family) === name && code.mono && /^(normal|0px)$/.test(code.letter) && code.size === before.code.size, JSON.stringify(code));
    check(`${name}: the line-number gutter matches the code`, gutter && family(gutter.family) === name && /^(normal|0px)$/.test(gutter.letter), JSON.stringify(gutter));
    check(`${name}: inline code in the editor too`, inline && family(inline.family) === name && inline.mono, JSON.stringify(inline));
    // the editor shows markdown source in the mono font, so its prose lines follow the code font too - unless a reading
    // font is chosen, which the prose takes while the code block keeps the code font
    check(`${name}: the editor's prose lines (markdown source, monospace by design) follow it too`, prose && family(prose.family) === name, JSON.stringify(prose));
    await setAids({ font: 'lexend' }); await sleep(900);
    const withReading = { prose: await measure('.sc-editor-cm .cm-line:not(.cm-code-block)'), code: await measure('.sc-editor-cm .cm-line.cm-code-block'), gutter: await measure('.sc-editor-cm .cm-gutters') };
    check(`${name}: with Lexend as the reading font, the prose takes Lexend while the code block and the gutter keep ${name}`, withReading.prose && family(withReading.prose.family) === 'Lexend' && withReading.code && family(withReading.code.family) === name && withReading.gutter && family(withReading.gutter.family) === name, JSON.stringify(withReading));
    await setAids({ font: 'default' }); await sleep(400);
    const cols = await columns('.sc-editor-cm .cm-line.cm-code-block');
    check(`${name}: the code block's indentation aligns on character columns (${cols.map((c) => c.indent).join('/')})`, aligned(cols), JSON.stringify(cols));
    // the Preview
    // the Preview: the mode toggle cycles editor -> Preview -> Preview all -> editor
    const isPreview = () => page.evaluate(() => !!document.querySelector('[data-testid="reading-aids-surface"] .markdown-preview'));
    for (let i = 0; i < 3 && !(await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); }
    await page.locator('[data-testid="reading-aids-surface"] .markdown-preview pre').first().waitFor({ timeout: 15000 }).catch(() => {}); await sleep(400);
    const pre = await measure('.markdown-preview pre code, .markdown-preview pre');
    const pinline = await measure('.markdown-preview :not(pre) > code');
    check(`${name}: the Preview's code block computes to it, monospace, no spacing`, pre && family(pre.family) === name && pre.mono && /^(normal|0px)$/.test(pre.letter), JSON.stringify(pre));
    check(`${name}: the Preview's inline code too`, pinline && family(pinline.family) === name && pinline.mono, JSON.stringify(pinline));
    const pcols = await columns('.markdown-preview pre code');
    check(`${name}: the Preview's code block aligns on columns too`, pcols.length >= 1 && (pcols.length < 3 || aligned(pcols)), JSON.stringify(pcols));
    // the toggle cycles Preview -> Preview all -> editor: click until the editor is back
    for (let i = 0; i < 3 && (await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); }
    await page.locator('[data-testid="reading-aids-surface"] .sc-editor-cm .cm-content').waitFor({ timeout: 15000 }).catch(() => {}); await sleep(300);
  }
  // back to Default
  await setAids({ codeFont: 'default' }); await sleep(400);
  const after = await measure('.sc-editor-cm .cm-line.cm-code-block');
  check('back to Default: Red Hat Mono again, live', after && family(after.family) === 'Red Hat Mono', JSON.stringify(after));

  // ---- the Diagnostics report frame: a monospace cell and a Log Viewer line
  await goTo('Tools'); await goTo('Diagnostics');
  const opened = await page.evaluate(async (name) => { for (let i = 0; i < 80; i++) { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (b) { b.click(); return true; } await new Promise((r) => setTimeout(r, 250)); } return false; }, FIXTURE_REPORT);
  check('the synthetic report opens', opened);
  await sleep(2500);
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()).filter(Boolean));
  const HISTOGRAM = ['Log Collection'].find((c) => labels.includes(c));
  const FINDINGS = ['Processes', 'System', 'Memory', 'Services'].find((c) => labels.includes(c));
  check(`the report has a findings page and Log Collection (tabs: ${labels.slice(0, 8).join(', ')})`, !!FINDINGS && !!HISTOGRAM, labels.join(', '));
  const MONO = '#diagnostics-content .ui-code-lines, #diagnostics-content td.ui-cmd, #diagnostics-content .ui-mono, #diagnostics-content pre, #diagnostics-content code';
  for (const [id, f] of CODE_FONTS) {
    const name = family(f.family);
    await setAids({ codeFont: id }); await sleep(600);
    await openTab(FINDINGS);
    const fr = await reportFrame();
    check(`${name}: the findings page rendered in the frame`, !!fr);
    if (!fr) continue;
    const fontIn = await fr.evaluate((n) => document.fonts.check(`12px "${n}"`), name);
    const cell = await measureIn(fr, MONO);
    const html = await fr.evaluate(() => ({ cls: document.documentElement.className, style: document.documentElement.getAttribute('style') || '', faces: (document.getElementById('ra-reading-font') || {}).textContent ? document.getElementById('ra-reading-font').textContent.length : 0 }));
    check(`${name}: the frame carries the variable and the faces as data: URLs, and document.fonts.check is true inside it`, /ra-code-font-family/.test(html.style) && html.faces > 1000 && fontIn, JSON.stringify(html).slice(0, 300));
    check(`${name}: a monospace cell of the report (${cell && cell.tag}) computes to it, monospace, no spacing`, cell && family(cell.family) === name && cell.mono && /^(normal|0px)$/.test(cell.letter), JSON.stringify(cell));
    const prose = await measureIn(fr, '#diagnostics-content p, #diagnostics-content td:not(.ui-cmd), .ui-finding-title');
    check(`${name}: the report's prose keeps its own font (${prose && family(prose.family)})`, prose && family(prose.family) !== name, JSON.stringify(prose));
    await openTab(HISTOGRAM);
    const ff = await reportFrame();
    const b = ff && ff.locator('button', { hasText: 'Open Log Viewer' });
    if (b && (await b.count())) {
      await b.first().click().catch(() => {}); await sleep(2500);
      const lv = await reportFrame();
      // the viewer: the fixture's files are picked, Get Date Range then Load Logs fill the table
      if (lv) {
        const range = lv.locator('#get-range-btn'); if (await range.count()) { await range.first().click().catch(() => {}); await sleep(2000); }
        const load = lv.locator('#load-logs-btn'); if (await load.count()) { await load.first().click().catch(() => {}); await sleep(3500); }
      }
      // a line of the loaded table, whatever its markup: the first cell with text whose computed font is a mono family
      const line = lv && await lv.evaluate(`(() => { const rows = document.querySelectorAll('#log-table-body tr').length; const all = Array.from(document.querySelectorAll('#log-table-body td, #log-table-body td *, #diagnostics-content pre, #diagnostics-content .ui-mono')).filter((el) => /\\S/.test(el.textContent) && /Mono|monospace/.test(getComputedStyle(el).fontFamily)); const el = all[0]; if (!el) { const td = document.querySelector('#log-table-body td'); return { none: true, rows, tdFont: td ? getComputedStyle(td).fontFamily : null, text: document.body.textContent.trim().slice(0, 120) }; } el.id = el.id || 'cf-probe'; const m = (${MEASURE})('#' + el.id); m.rows = rows; return m; })()`);
      check(`${name}: a Log Viewer line (${line && line.tag}, ${line && line.rows} rows loaded) computes to it and stays monospace`, line && !line.none && family(line.family) === name && line.mono, JSON.stringify(line));
    } else {
      check(`${name}: the Log Viewer opens from Log Collection`, false, 'no Open Log Viewer button');
    }
  }
  await setAids({ codeFont: 'default' }); await sleep(600);
  await openTab(FINDINGS);
  const fr2 = await reportFrame();
  const back = fr2 && await measureIn(fr2, MONO);
  check('back to Default in the frame: Red Hat Mono again', back && family(back.family) === 'Red Hat Mono', JSON.stringify(back));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
