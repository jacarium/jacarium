#!/usr/bin/env node
/*
 * The Diagnostics frame's message bridge (src/components/DiagnosticsPage.jsx): the sandboxed srcdoc frame reaches
 * the backend and the app only through postMessage, and the parent answers only the frame it owns.
 *
 * Static: every request handler, the "/highlight" one included, sits behind the one validation (the event's source
 * is the frame's window, the message carries __diagnosticsApi and dir 'up'); the highlight path is not a backend
 * path (handled before the allowlist, absent from it), caps the text (2 MB) and the language (json | yaml), and
 * answers through post() (dir 'down') with the escaped HTML codeHighlight.js produces.
 *
 * Browser (Vite + playwright-core, the synthetic must-gather's Pod tab in the frame): from the frame,
 * diagnosticsApiRequest('/highlight') returns highlighted, escaped HTML (a "<b>" in a value comes back as &lt;b&gt;,
 * keys as hljs-attr spans); an unknown language is treated as json; a 3 MB text is cut to 2 MB; a path outside the
 * allowlist is refused ("Forbidden path"); the same message posted by the app window itself, and by another iframe
 * the test adds, gets no answer at all.
 *
 *   node tests/diagnostics-frame-bridge.test.mjs        env: SMOKE_PORT, SKIP_BROWSER_TESTS=1 (static only)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
{
  const diag = read('src/components/DiagnosticsPage.jsx');
  const start = diag.indexOf('const handleApiMessage = async (event) => {');
  const handler = diag.slice(start, diag.indexOf('window.addEventListener(\'message\', handleApiMessage)', start));
  const guard = handler.indexOf("if (!frame || event.source !== frame.contentWindow) return;");
  const guard2 = handler.indexOf("if (!d || d.__diagnosticsApi !== true || d.dir !== 'up') return;");
  const hl = handler.indexOf("path === '/highlight'");
  const allow = handler.indexOf('DIAGNOSTICS_API_ALLOWLIST.has(path)');
  check('the request handler validates the source (the frame\'s own window) and the envelope (__diagnosticsApi, dir up) before anything else', guard > 0 && guard2 > guard && guard2 < 400);
  check('the "/highlight" handler runs only after that validation, before the backend allowlist, and the path is in no allowlist', hl > guard2 && hl < allow && !/'\/highlight'/.test(diag.slice(diag.indexOf('const DIAGNOSTICS_API_ALLOWLIST'), diag.indexOf('function buildDiagnosticsSrcDoc'))));
  const block = handler.slice(hl, handler.indexOf('return;', hl) + 7);
  check('it caps the text at 2 MB and the language to json | yaml, highlights through codeHighlight.js and answers with post() (dir down) as {html}', /body\.text\.slice\(0, 2 \* 1024 \* 1024\)/.test(block) && /body\.language === 'yaml' \? 'yaml' : 'json'/.test(block) && /highlightCode\(text, language\)/.test(block) && /post\(\{ type: 'response', requestId, ok: typeof html === 'string', status: 200, json: \{ html \} \}\)/.test(block) && /import \{ highlightCode \} from '\.\.\/utils\/codeHighlight'/.test(diag));
  check('codeHighlight.js escapes the code (&, <, >, ", \') and highlights with an explicit language and ignoreIllegals', /hljs\.highlight\(\) escapes the code/.test(read('src/utils/codeHighlight.js')) && /ignoreIllegals:\s*true/.test(read('src/utils/codeHighlight.js')));
  check('the frame asks for it through the same request helper as the backend calls (diagnosticsApiRequest)', /diagnosticsApiRequest\('\/highlight', \{ text: text, language: format \}\)/.test(read('backend/static/diagnostics-ui.js')));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll static checks passed (browser part skipped)'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tab'); process.exit(failed ? 1 : 0); }

// ---------------------------------------------------------------------------
// The fixture: the synthetic must-gather's Pod tab rendered through Flask (any frame will do; this one has the viewer)
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-bridge-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
const NAME = 'must-gather.local.1234567890';
const htmlDir = path.join(work, 'html');
const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, NAME), '--report-type', 'mustgather', '--tabs', 'pod'], { encoding: 'utf8' });
if (ren.status !== 0) { console.log('SKIP: the Pod tab did not render: ' + (ren.stderr || '').slice(-200)); process.exit(failed ? 1 : 0); }
const report = { name: NAME, path: '/tmp/diagnostics-bridge/' + NAME, type: 'mustgather', modified: 1760000000, html: { pod: fs.readFileSync(path.join(htmlDir, 'pod.html'), 'utf8') }, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };

const PORT = Number(process.env.SMOKE_PORT || 5347);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify('dark')); localStorage.setItem('diagnosticsReportsDirectory', '/tmp/diagnostics-bridge'); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ } });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.6', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [{ name: report.name, path: report.path, type: report.type, modified: report.modified }] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs: report.tabs, report_type: report.type, directory: report.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', async (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const key = body.sub_tab || body.tab; r.fulfill({ json: { html: report.html[key] || '<div class="panel rounded-lg shadow-sm"><p>not rendered</p></div>' } }); });
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
  await clickButton('Tools'); await sleep(400); await clickButton('Diagnostics'); await sleep(600);
  await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, report.name, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
  await sleep(400);
  await page.evaluate(() => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Workloads'); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) btn.click(); });
  await sleep(300);
  await page.evaluate(() => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = all.findIndex((el) => el.textContent.trim() === 'Workloads') + 1; const s = all.slice(from).find((el) => el.textContent.trim() === 'Pod'); if (s) s.closest('div.cursor-pointer').click(); });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    const h = await page.$('iframe[title="Diagnostics content"][data-tab="pod"]');
    if (h) { const f = await h.contentFrame(); if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content') && !!window.diagnosticsApiRequest)) frame = f; } catch { /* navigating */ } } }
    if (!frame) await sleep(250);
  }
  check('the Pod tab renders in the frame with the request helper in place', !!frame);
  if (frame) {
    // from the frame: highlighted, escaped HTML
    const hl = await frame.evaluate(async () => {
      const r = await window.diagnosticsApiRequest('/highlight', { text: '{\n  "name": "<b>x</b> & \'y\'",\n  "n": 1\n}', language: 'json' });
      return { ok: r.ok, html: r.json && r.json.html };
    });
    check('the frame gets highlighted, escaped HTML for JSON (keys as hljs-attr, the "<b>" and "&" of a value escaped, no tag of the input left)', hl.ok && /class="hljs-attr">&quot;name&quot;<\/span>/.test(hl.html) && /&lt;b&gt;x&lt;\/b&gt; &amp; (&#x27;|&#39;|')y/.test(hl.html) && !/<b>/.test(hl.html) && /class="hljs-number">1<\/span>/.test(hl.html), String(hl.html).slice(0, 300));
    const yaml = await frame.evaluate(async () => { const r = await window.diagnosticsApiRequest('/highlight', { text: 'a: 1\nb: <i>x</i>\n', language: 'yaml' }); return r.json && r.json.html; });
    check('YAML is highlighted as YAML, escaped', /class="hljs-attr">a:<\/span>/.test(yaml) && /&lt;i&gt;/.test(yaml) && !/<i>/.test(yaml), String(yaml).slice(0, 200));
    const other = await frame.evaluate(async () => { const r = await window.diagnosticsApiRequest('/highlight', { text: 'echo $HOME', language: 'bash' }); return r.json && r.json.html; });
    check('an unknown language is treated as json (never another grammar)', typeof other === 'string' && !/hljs-built_in|hljs-variable/.test(other), String(other).slice(0, 200));
    const big = await frame.evaluate(async () => { const r = await window.diagnosticsApiRequest('/highlight', { text: '"' + 'a'.repeat(3 * 1024 * 1024) + '"', language: 'json' }); const t = (r.json && r.json.html || '').replace(/<[^>]+>/g, ''); return { ok: r.ok, length: t.length }; });
    check('the text is capped at 2 MB (a 3 MB input comes back cut)', big.ok && big.length > 1.9 * 1024 * 1024 && big.length <= 2 * 1024 * 1024 + 16, JSON.stringify(big));
    const bad = await frame.evaluate(async () => { try { await window.diagnosticsApiRequest('/etc_passwd', {}); return 'answered'; } catch (e) { return String(e.message); } });
    check('a path outside the allowlist is refused ("Forbidden path")', /Forbidden path/.test(bad), bad);
    const empty = await frame.evaluate(async () => { const r = await window.diagnosticsApiRequest('/highlight', { language: 'json' }); return r.json && r.json.html; });
    check('a missing text highlights as an empty string, no error', empty === '');
    // the same message from the app window itself: not the frame's window, so no answer
    const fromPage = await page.evaluate(() => new Promise((resolve) => {
      let answered = false;
      const onMsg = (e) => { if (e.data && e.data.__diagnosticsApi && e.data.dir === 'down' && e.data.requestId === 777001) answered = true; };
      window.addEventListener('message', onMsg);
      window.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'request', requestId: 777001, path: '/highlight', body: { text: '{}', language: 'json' } }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(answered); }, 800);
    }));
    check('the same request posted by the app window itself gets no answer', fromPage === false);
    // the same message from another iframe the test adds: not the Diagnostics frame, so no answer
    const fromOther = await page.evaluate(() => new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = '<script>window.addEventListener("message", (e) => { if (e.data && e.data.__diagnosticsApi && e.data.dir === "down") parent.postMessage({ bridgeLeak: true, data: e.data }, "*"); }); parent.postMessage({ __diagnosticsApi: true, dir: "up", type: "request", requestId: 777002, path: "/highlight", body: { text: "{}", language: "json" } }, "*"); parent.postMessage({ __diagnosticsApi: true, dir: "up", type: "request", requestId: 777003, path: "/get_log_date_range", body: {} }, "*");</script>';
      let leaked = false;
      const onMsg = (e) => { if (e.data && e.data.bridgeLeak) leaked = true; };
      window.addEventListener('message', onMsg);
      document.body.appendChild(f);
      setTimeout(() => { window.removeEventListener('message', onMsg); f.remove(); resolve(leaked); }, 1200);
    }));
    check('the same requests (the highlight and a backend path) posted by another iframe get no answer', fromOther === false);
    // and the real frame still works afterwards
    const again = await frame.evaluate(async () => { const r = await window.diagnosticsApiRequest('/highlight', { text: '{"k": true}', language: 'json' }); return r.ok && /hljs-literal/.test(r.json.html); });
    check('the Diagnostics frame is still answered after the foreign messages', again === true);
  }
  await context.close();
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
