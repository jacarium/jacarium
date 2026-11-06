#!/usr/bin/env node
/**
 * Coming back to Diagnostics with a report open paints the tab WITH the backend stylesheet, from the first frame
 * document on (DiagnosticsPage.jsx: loadDiagnosticsCSS / the diagnosticsCss session cache / loadTab awaiting it /
 * buildDiagnosticsSrcDoc inlining it).
 *
 * THE BUG: the page removes its <style id="diagnostics-styles"> on unmount and fetched styles.css again on
 * remount, while the restored session loaded the tab's HTML at once; the frame document was baked from
 * document.styleSheets before the fetch landed, so Documents -> Diagnostics showed the Findings as plain lines,
 * unstyled cards and the shared icons (viewBox-only SVGs) drawn full-width. The same race could hit the very
 * first tab on a slow backend.
 *
 * Static (plain Node): the cache, the await in loadTab, the inlined stylesheet, the icons' explicit size.
 * Live (headless Chromium, the real page, a faked backend whose styles.css answers late and whose tabs answer at
 * once - the race made deliberate): the must-gather's NNCP tab and a sosreport's Processes tab; the first load
 * and three Documents -> Diagnostics round trips each: the FIRST frame document already carries the stylesheet,
 * a Findings badge computes as styled, every SVG in the frame is icon-sized; the frame-bridge and detail-page
 * tests cover the rest of the frame.
 *
 * Run: node tests/diagnostics-return-styles.test.mjs   (env: SMOKE_PORT (default 5349), SKIP_BROWSER_TESTS=1)
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
  check('the stylesheet is cached for the session (diagnosticsCss) and re-injected synchronously from the cache', /const diagnosticsCss = \{ text: '', promise: null \}/.test(diag) && /if \(diagnosticsCss\.text\) \{\s*injectDiagnosticsCSS\(diagnosticsCss\.text\);\s*return Promise\.resolve/.test(diag));
  const loadTab = diag.slice(diag.indexOf('async function loadTab('), diag.indexOf('loadTabRef.current = loadTab;'));
  check('loadTab starts the stylesheet load before the tab request and awaits it before the content is shown', /const cssReady = loadDiagnosticsCSS\(\);/.test(loadTab) && loadTab.indexOf('await cssReady;') < loadTab.indexOf('setContent(data.html);') && loadTab.indexOf('await cssReady;') > loadTab.indexOf('const data = await response.json();'));
  check('the frame document inlines the cached stylesheet when the parent\'s <style> is not there', /function buildDiagnosticsSrcDoc\(fragmentHtml, theme, tabKey, backendCss = ''\)/.test(diag) && /diagnostics-styles-inline/.test(diag) && /buildDiagnosticsSrcDoc\(content, appTheme\(\), contentKeyRef\.current, diagnosticsCss\.text\)/.test(diag));
  check('a failed fetch resolves to no stylesheet (the content still shows) and never throws', /catch \(err\) \{\s*console\.warn\('Failed to load diagnostics CSS:', err\);/.test(diag) && /return diagnosticsCss\.text;/.test(diag));
  check('the loading placeholder\'s spinner is capped at 2rem even without the app styles', /animate-spin rounded-full h-8 w-8 border-b-2 border-os-blue" style="max-width: 2rem; max-height: 2rem"/.test(diag));
  const ui = read('backend/templates/tabs/_ui.html');
  check('the shared icons (the search / chevron / select glyphs, the row chevron) carry an explicit width and height', /macro icon\(name\) -%\}\s*<svg viewBox="0 0 24 24" width="16" height="16"/.test(ui) && /class="ui-xrow-btn"[^>]*><svg viewBox="0 0 24 24" width="14" height="14"/.test(ui) && /var CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14"/.test(read('backend/static/diagnostics-ui.js')));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll static checks passed (browser part skipped)'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }

// ---------------------------------------------------------------------------
// The fixtures: the synthetic must-gather's Network / NNCP tabs and the sosreport's System / Processes tabs, rendered through Flask
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-return-styles-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
function render(name, type, tabs) {
  const htmlDir = path.join(work, 'html-' + type);
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, name), '--report-type', type, '--tabs', ...tabs], { encoding: 'utf8' });
  if (ren.status !== 0) { console.log(`SKIP: the ${type} tabs did not render: ` + (ren.stderr || '').slice(-200)); process.exit(failed ? 1 : 0); }
  const html = {};
  for (const t of tabs) html[t] = fs.readFileSync(path.join(htmlDir, t + '.html'), 'utf8');
  return { name, path: '/tmp/diagnostics-return/' + name, type, modified: 1760000000, html, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
}
const reports = {
  mustgather: render('must-gather.local.1234567890', 'mustgather', ['network', 'nmstate']),
  sosreport: render('sosreport-web-01-2026-10-13-abcdef', 'sosreport', ['system', 'processes']),
};
const PORT = Number(process.env.SMOKE_PORT || 5349);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };

/** The first frame document of the tab (its srcdoc as soon as the frame exists), then the live frame. */
async function firstFrame(page, tab, timeoutMs = 20000) {
  const t0 = Date.now();
  let srcdoc = null;
  let handle = null;
  while (Date.now() - t0 < timeoutMs) {
    handle = await page.$(`iframe[title="Diagnostics content"][data-tab="${tab}"]`);
    if (handle) { srcdoc = await handle.getAttribute('srcdoc'); if (srcdoc) break; }
    await sleep(40);
  }
  let frame = null;
  for (let i = 0; i < 100 && handle && !frame; i++) {
    const f = await handle.contentFrame();
    if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content .ui-findings'))) frame = f; } catch { /* navigating */ } }
    if (!frame) await sleep(100);
  }
  return { srcdoc, frame };
}
/** What the frame looks like: a Findings badge's computed style, the widest SVG, the findings box. */
const look = (frame) => frame.evaluate(() => {
  const badge = document.querySelector('#diagnostics-content .ui-finding .ui-badge');
  const box = document.querySelector('#diagnostics-content .ui-findings');
  const svgs = Array.from(document.querySelectorAll('#diagnostics-content svg'));
  const widest = svgs.reduce((m, s) => Math.max(m, s.getBoundingClientRect().width), 0);
  return { badge: badge ? getComputedStyle(badge).display : 'none', box: box ? getComputedStyle(box).borderTopWidth : 'none', widest, svgs: svgs.length, styled: !!document.querySelector('style') && Array.from(document.querySelectorAll('style')).some((s) => s.textContent.includes('.ui-findings {')) };
});
const styledFirst = (srcdoc) => typeof srcdoc === 'string' && srcdoc.includes('#diagnostics-content .ui-findings {') && srcdoc.includes('#diagnostics-content .ui-badge {');

try {
  for (const [kind, report] of Object.entries(reports)) {
    const [group, tab, groupLabel, tabLabel] = kind === 'mustgather' ? ['network', 'nmstate', 'Network', 'Node Network Config (NNCP)'] : ['system', 'processes', 'System', 'Processes'];
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify('dark')); localStorage.setItem('diagnosticsReportsDirectory', '/tmp/diagnostics-return'); } catch { /* storage */ } });
    await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
    await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
    await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.1.0', protocol: 2 } }));
    await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
    await context.route('**/socket.io/**', (r) => r.abort());
    await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
    await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
    await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [{ name: report.name, path: report.path, type: report.type, modified: report.modified }] } }));
    await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs: report.tabs, report_type: report.type, directory: report.path } }));
    await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
    // the race made deliberate: the stylesheet answers late, the tabs at once
    let cssRequests = 0;
    await context.route('http://localhost:8080/static/styles.css', async (r) => { cssRequests += 1; await sleep(1200); r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }); });
    await context.route('http://localhost:8080/load_tab', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const key = body.sub_tab || body.tab; r.fulfill({ json: { html: report.html[key] || '<div class="ui-note">no such tab in this test</div>' } }); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(1500);
    for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
    const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
    await clickButton('Tools'); await sleep(300); await clickButton('Diagnostics'); await sleep(400);
    await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, report.name, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
    await sleep(200);
    // the group expanded, the sub-tab clicked - right away, while the stylesheet is still on its way
    await page.evaluate((label) => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) btn.click(); }, groupLabel);
    await sleep(200);
    await page.evaluate(([groupLabel, tabLabel]) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = all.findIndex((el) => el.textContent.trim() === groupLabel) + 1; const s = all.slice(from).find((el) => el.textContent.trim() === tabLabel); if (s) s.closest('div.cursor-pointer').click(); }, [groupLabel, tabLabel]);
    const first = await firstFrame(page, tab);
    check(`${kind}: the first load of ${tabLabel} while styles.css is still loading: the frame document is baked with the stylesheet (loadTab waited for it)`, styledFirst(first.srcdoc) && !!first.frame, first.srcdoc ? first.srcdoc.slice(0, 200) : 'no frame');
    if (first.frame) {
      const l = await look(first.frame);
      check(`${kind}: ...and renders styled: a Findings badge is a flex pill, the Findings box has its border, every SVG is icon-sized (widest ${Math.round(l.widest)} px of ${l.svgs})`, (l.badge === 'inline-flex' || l.badge === 'flex') && l.box === '1px' && l.widest > 0 && l.widest <= 40, JSON.stringify(l));
    }
    check(`${kind}: the stylesheet was fetched once`, cssRequests === 1, String(cssRequests));
    // Documents -> Diagnostics, three times: the restored tab's FIRST document carries the stylesheet
    for (let round = 1; round <= 3; round++) {
      await clickButton('Documents'); await sleep(500);
      check(`${kind} round ${round}: on the Documents page the Diagnostics frame is gone`, !(await page.$('iframe[title="Diagnostics content"]')));
      const parentStyle = await page.evaluate(() => !!document.getElementById('diagnostics-styles'));
      check(`${kind} round ${round}: ...and the parent's diagnostics <style> was removed with the page`, parentStyle === false);
      await clickButton('Tools'); await sleep(200); await clickButton('Diagnostics');
      const back = await firstFrame(page, tab);
      check(`${kind} round ${round}: back on Diagnostics the restored ${tabLabel} frame's first document carries the stylesheet`, styledFirst(back.srcdoc) && !!back.frame, back.srcdoc ? back.srcdoc.slice(0, 200) : 'no frame');
      if (back.frame) {
        const l = await look(back.frame);
        check(`${kind} round ${round}: ...and paints styled (badge a flex pill, bordered Findings box, icons at most 40 px wide: ${Math.round(l.widest)} px)`, (l.badge === 'inline-flex' || l.badge === 'flex') && l.box === '1px' && l.widest > 0 && l.widest <= 40, JSON.stringify(l));
      }
      check(`${kind} round ${round}: the parent's diagnostics <style> is back at once, from the cache (no new fetch)`, (await page.evaluate(() => !!document.getElementById('diagnostics-styles'))) && cssRequests === 1, String(cssRequests));
    }
    check(`${kind}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
