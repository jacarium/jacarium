#!/usr/bin/env node
/**
 * The same as tests/diagnostics-return-styles.test.mjs, in the REAL Electron app against the REAL Flask backend: a
 * must-gather loaded in Diagnostics, Network > Node Network Config (NNCP) open, Documents, back to Diagnostics -
 * three times - and the restored tab's first frame document carries the backend stylesheet and paints styled;
 * then the same for a sosreport's System > Processes tab.
 *
 * The development Electron app spawns electron/server.cjs (the Node backend), which has no Diagnostics routes, so
 * this test launches the app with PORT=8080 against a placeholder, reads the per-launch app token from the
 * renderer, and starts backend/app.py itself on :8080 with that token, so the renderer talks to Flask - what the
 * packaged app does with its bundled Flask backend. The fixture is the synthetic diagnostics
 * mock in a temporary directory; the page's reports directory is set the way the page stores it
 * (localStorage diagnosticsReportsDirectory, DiagnosticsPage.jsx).
 *
 * SKIPs when SKIP_ELECTRON_TESTS is set, when :5173 / :8080 are taken (a running app is never driven here), when
 * backend/venv is missing or the app does not start. Run: node tests/diagnostics-return-styles-electron.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import { launchElectronApp, sleep, REPO } from './helpers/electron-app.mjs';
import { reapOnExit } from './helpers/reap.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 800) : ''}`); if (!ok) failed += 1; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const FLASK_PORT = 8080;

if (process.env.SKIP_ELECTRON_TESTS) { console.log('SKIP: SKIP_ELECTRON_TESTS is set'); process.exit(0); }
for (const port of [5173, FLASK_PORT]) { if (!(await portFree(port))) { console.log(`SKIP: port ${port} is in use (a running app is never driven by this test)`); process.exit(0); } }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot start the backend'); process.exit(0); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-return-electron-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', path.join(work, 'reports'), '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic reports: ' + (gen.stderr || '').slice(0, 200)); process.exit(0); }
const REPORTS = path.join(work, 'reports');
const MG = 'must-gather.local.1234567890';
const SOS = 'sosreport-web-01-2026-10-13-abcdef';

// The backend's token: the main process mints one per launch and hands it to the renderer (get-app-token), and
// the Flask backend refuses its routes without APP_AUTH_TOKEN - so the app starts first against a placeholder on
// :8080 (it answers /health, so the app does not wait; the Node backend the dev app spawns cannot bind the port and
// exits, which the main process only logs), the token is read from the renderer, and Flask takes the port with it.
const placeholder = http.createServer((req, res) => { if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","service":"placeholder"}'); } else { res.writeHead(404); res.end(); } });
await new Promise((resolve) => placeholder.listen(FLASK_PORT, '127.0.0.1', resolve));
const launched = await launchElectronApp({ profilePrefix: 'electron-diag-return-', env: { PORT: String(FLASK_PORT) } });
if (launched.skip) { console.log('SKIP: ' + launched.skip); placeholder.close(); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(0); }
const token = await launched.page.evaluate(() => window.electronAPI && window.electronAPI.getAppToken ? window.electronAPI.getAppToken() : null).catch(() => null);
await new Promise((resolve) => placeholder.close(resolve));
if (!token) { console.log('SKIP: the app window gave no app token'); await launched.close(); process.exit(0); }
// the Flask backend on :8080 with the app's token and its own home (nothing of the user's is read or written)
const HOME = path.join(work, 'home');
fs.mkdirSync(HOME, { recursive: true });
const backend = reapOnExit(spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME, PORT: String(FLASK_PORT), APP_AUTH_TOKEN: token, JACARIUM_KNOWN_HOSTS: path.join(HOME, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
if (!up) { console.log('SKIP: the Flask backend did not start\n' + backendLog.slice(-600)); await launched.close(); stopBackend(); process.exit(0); }

const { page, close } = launched;
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
async function firstFrame(tab, timeoutMs = 30000) {
  const t0 = Date.now();
  let srcdoc = null, handle = null;
  while (Date.now() - t0 < timeoutMs) {
    handle = await page.$(`iframe[title="Diagnostics content"][data-tab="${tab}"]`);
    if (handle) { srcdoc = await handle.getAttribute('srcdoc'); if (srcdoc) break; }
    await sleep(40);
  }
  let frame = null;
  for (let i = 0; i < 150 && handle && !frame; i++) {
    const f = await handle.contentFrame();
    if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content .ui-findings'))) frame = f; } catch { /* navigating */ } }
    if (!frame) await sleep(100);
  }
  return { srcdoc, frame };
}
const look = (frame) => frame.evaluate(() => {
  const badge = document.querySelector('#diagnostics-content .ui-finding .ui-badge');
  const box = document.querySelector('#diagnostics-content .ui-findings');
  const widest = Array.from(document.querySelectorAll('#diagnostics-content svg')).reduce((m, s) => Math.max(m, s.getBoundingClientRect().width), 0);
  return { badge: badge ? getComputedStyle(badge).display : 'none', box: box ? getComputedStyle(box).borderTopWidth : 'none', widest };
});
const styled = (l) => (l.badge === 'inline-flex' || l.badge === 'flex') && parseFloat(l.box) > 0 && l.widest > 0 && l.widest <= 40;   // the box's border is 1px, or a HiDPI hairline (0.56px in Electron)
const styledFirst = (srcdoc) => typeof srcdoc === 'string' && srcdoc.includes('#diagnostics-content .ui-findings {');
const resetDiagnostics = async () => { await page.evaluate(() => { localStorage.removeItem('diagnostics-page-session'); }); };
/** Open a report from the Diagnostics page's list and one of its sub-tabs (the group expanded first). */
async function openTab(reportName, groupLabel, tabLabel, tab) {
  await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, reportName, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 60000 }).catch(() => {});
  await sleep(400);
  await page.evaluate((label) => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) btn.click(); }, groupLabel);
  await sleep(300);
  await page.evaluate(([groupLabel, tabLabel]) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = all.findIndex((el) => el.textContent.trim() === groupLabel) + 1; const s = all.slice(from).find((el) => el.textContent.trim() === tabLabel); if (s) s.closest('div.cursor-pointer').click(); }, [groupLabel, tabLabel]);
  return firstFrame(tab);
}

try {
  await page.evaluate((dir) => { localStorage.setItem('diagnosticsReportsDirectory', dir); localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.removeItem('diagnostics-page-session'); }, REPORTS);
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
  for (let i = 0; i < 6; i++) { if (await clickButton('Got it!')) break; await sleep(300); }
  await clickButton('Tools'); await sleep(400); await clickButton('Diagnostics'); await sleep(1000);
  check('the Diagnostics page lists the synthetic reports from the real backend', await page.waitForFunction((name) => Array.from(document.querySelectorAll('button')).some((el) => el.textContent.includes(name) && el.offsetParent), MG, { timeout: 60000 }).then(() => true).catch(() => false), (await page.evaluate(() => document.body.innerText.slice(0, 600))).replace(/\n+/g, ' | '));
  for (const [kind, name, group, tabLabel, tab] of [['must-gather', MG, 'Network', 'Node Network Config (NNCP)', 'nmstate'], ['sosreport', SOS, 'System', 'Processes', 'processes']]) {
    const first = await openTab(name, group, tabLabel, tab);
    check(`${kind}: ${tabLabel} renders with the stylesheet in its first document`, styledFirst(first.srcdoc) && !!first.frame, first.srcdoc ? first.srcdoc.slice(0, 120) : 'no frame');
    if (first.frame) check(`${kind}: ...and paints styled`, styled(await look(first.frame)), JSON.stringify(await look(first.frame)));
    for (let round = 1; round <= 3; round++) {
      await clickButton('Documents'); await sleep(800);
      check(`${kind} round ${round}: on Documents the frame and the parent's diagnostics <style> are gone`, !(await page.$('iframe[title="Diagnostics content"]')) && !(await page.evaluate(() => !!document.getElementById('diagnostics-styles'))));
      await clickButton('Tools'); await sleep(300); await clickButton('Diagnostics');
      const back = await firstFrame(tab);
      check(`${kind} round ${round}: back on Diagnostics the restored ${tabLabel} frame's first document carries the stylesheet`, styledFirst(back.srcdoc) && !!back.frame, back.srcdoc ? back.srcdoc.slice(0, 120) : 'no frame');
      if (back.frame) { const l = await look(back.frame); check(`${kind} round ${round}: ...and paints styled (icons at most 40 px wide: ${Math.round(l.widest)} px)`, styled(l), JSON.stringify(l)); }
    }
    // back to the report list for the next report (the page's own "Load different report")
    if (await clickButton('Load different report')) { await sleep(800); } else { await resetDiagnostics(); await clickButton('Documents'); await sleep(400); await clickButton('Tools'); await sleep(300); await clickButton('Diagnostics'); await sleep(1500); }
  }
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await close();
  stopBackend();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
