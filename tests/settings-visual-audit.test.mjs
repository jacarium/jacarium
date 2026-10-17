/**
 * The Settings dialog in the REAL app (Vite dev server + headless Chrome
 * over CDP, the REAL Flask backend in accounts mode with a synthetic
 * administrator): every tab and sub-tab, light and dark, at a wide and a
 * narrow window. Screenshots go to
 * SETTINGS_SHOTS_DIR (kept) or a temp dir (removed) - the same capture
 * before and after a UI change is the before/after record of the change.
 *
 * Checks (synthetic data only):
 *   - every tab renders without a runtime exception and non-blank, in both
 *     themes and at 800px wide (no horizontal overflow of the dialog);
 *   - structure (the unified Settings look, src/components/common/modals/
 *     settings/ui.jsx): inside the dialog no `rounded-lg`/`rounded-md`
 *     boxes, every text input/select/textarea carries the shared field
 *     classes, every section heading is the shared heading, the primary
 *     buttons share one style; focus is visible on the first field
 *     (focus-visible ring);
 *   - no window.confirm() left in the Settings components (confirmations
 *     go through ConfirmationModal).
 * SETTINGS_AUDIT_MODE=before skips the structure checks (capturing the
 * state before the unification).
 *
 * Skips cleanly without Chrome, the backend venv, or when :5173 / :8080
 * are busy. Run: node tests/settings-visual-audit.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew, slug } from './helpers/visual-snapshots.mjs';

const VITE_PORT = 5173;   // the only dev origin the backend's CORS allow-list accepts
const FLASK_PORT = 8080;  // where the dev UI expects the backend (src/utils/backendUrl.js)
const BEFORE = process.env.SETTINGS_AUDIT_MODE === 'before';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

// ---- the backend: accounts mode, throwaway data, a synthetic administrator ----
const DATA = mkdtempSync(path.join(tmpdir(), 'settings-audit-data-'));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(FLASK_PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-800)); stopBackend(); process.exit(1); }
const setupCode = readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();

const outDir = process.env.SETTINGS_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'settings-audit-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'settings-audit-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const png = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const setSize = (w, h) => app.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(400); };
const clickText = (text) => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const MODAL = `document.querySelector('[data-testid="settings-modal"]') || Array.from(document.querySelectorAll('.bg-os-modal.shadow-lg')).find((m) => /Application Settings/.test(m.textContent))`;

try {
  await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
  // sign in as the synthetic administrator (the page's own origin talks to :8080 with its cookie)
  const signedIn = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ setupCode: ${JSON.stringify(setupCode)}, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) }).then((r) => r.status)`);
  check('the synthetic administrator is created from the page', signedIn === 201, String(signedIn));
  await app.send('Page.reload');
  await sleep(6000);
  await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
  await dismissWhatsNew(app);
  const signedInApp = await app.waitFor(`!!document.querySelector('[data-testid="status-corner"], nav, aside') && !document.querySelector('[data-testid="login-form"]')`, 15000);
  check('the app loads signed in (no sign-in page)', !!signedInApp);
  // the accounts-mode app: Users tab + Account section exist
  await app.evaluate(`window.dispatchEvent(new Event('openAppSettings'))`);
  const opened = await app.waitFor(`!!(${MODAL})`, 8000);
  check('Settings opens (openAppSettings event)', !!opened);

  const tabs = [
    ['General', []],
    ['Integrations', ['JIRA', 'Google Calendar', 'HuggingFace']],
    ['AI Providers', ['Default Settings', 'OpenAI', 'Anthropic', 'Google Gemini', 'Custom/Ollama', 'AI Over SSH']],
    ['Users', []],
    ['Audit', []],
  ];
  const structureProblems = [];
  for (const [tab, subs] of tabs) {
    const errorsBefore = app.errors.length;
    check(`tab "${tab}" exists`, await clickText(tab));
    await sleep(800);
    const views = subs.length ? subs : [null];
    for (const sub of views) {
      if (sub) { await clickText(sub); await sleep(500); }
      const name = slug(sub ? `${tab}-${sub}` : tab);
      for (const theme of ['light', 'dark']) {
        await setSize(1400, 900);
        await setTheme(theme);
        const wide = await shot(`settings-${name}-${theme}`);
        check(`${name} (${theme}) renders non-blank`, pixelSpread(wide) > 40);
        await setSize(800, 900);
        await sleep(300);
        await shot(`settings-${name}-${theme}-narrow`);
        const overflow = await app.evaluate(`(() => { const m = ${MODAL}; if (!m) return 'no modal'; return m.scrollWidth > m.clientWidth + 2 ? 'overflow ' + m.scrollWidth + '>' + m.clientWidth : ''; })()`);
        check(`${name} (${theme}) has no horizontal overflow at 800px`, overflow === '', overflow);
      }
      await setSize(1400, 900);
      await setTheme('light');
      if (!BEFORE) {
        const report = await app.evaluate(`(() => {
          const m = ${MODAL}; if (!m) return ['no modal'];
          const problems = [];
          const body = m.querySelector('[data-testid="settings-body"]') || m;
          for (const el of body.querySelectorAll('[class*="rounded-lg"], [class*="rounded-md"], [class*="rounded-xl"]')) problems.push('rounded box: ' + el.className.slice(0, 80));
          for (const el of body.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), select, textarea')) {
            if (!el.className.includes('sc-field')) problems.push((el.tagName.toLowerCase()) + ' without the shared field class: ' + el.className.slice(0, 80));
          }
          for (const el of body.querySelectorAll('h3')) { if (!el.className.includes('sc-section-title')) problems.push('heading not shared: ' + el.textContent.trim().slice(0, 40)); }
          for (const el of body.querySelectorAll('button')) {
            const c = el.className;
            if (el.getAttribute('role') === 'switch') continue;   // the shared Toggle primitive (blue when on), not a one-off button
            if (/bg-(purple|green|red|blue|amber)-600/.test(c) && !c.includes('sc-btn')) problems.push('one-off coloured button: ' + el.textContent.trim().slice(0, 30));
          }
          return problems;
        })()`);
        for (const p of report) structureProblems.push(`${name}: ${p}`);
      }
    }
    const newErrors = app.errors.slice(errorsBefore);
    check(`${tab}: no runtime exception`, newErrors.length === 0, newErrors.join(' || ').slice(0, 300));
  }
  if (!BEFORE) {
    check('structure: the unified Settings look (shared field/heading/button classes, no rounded-lg boxes)', structureProblems.length === 0, structureProblems.slice(0, 8).join(' ; '));
    // text only in the rail, the headings and the buttons; the footer buttons take the control radius and the normal weight
    const chrome = await app.evaluate(`(() => { const m = ${MODAL}; if (!m) return { error: 'no modal' }; const cs = (e) => getComputedStyle(e);
      const rail = Array.from(m.querySelectorAll('[role="tablist"] button')); const save = m.querySelector('[data-testid="settings-save"]');
      const footerButtons = save ? Array.from(save.parentElement.querySelectorAll('button')) : [];
      const headings = Array.from(m.querySelectorAll('.sc-section-title'));
      const textButtons = Array.from(m.querySelectorAll('button.sc-btn')).filter((b) => b.textContent.trim().length > 1);
      return {
        railIcons: rail.filter((b) => b.querySelector('svg')).length, railCount: rail.length,
        headingIcons: headings.filter((h) => h.parentElement.querySelector('svg')).length, headingCount: headings.length,
        buttonIcons: textButtons.filter((b) => b.querySelector('svg')).map((b) => b.textContent.trim().slice(0, 30)),
        save: save ? cs(save).borderTopLeftRadius + '/' + cs(save).fontWeight : 'missing', footer: footerButtons.map((b) => cs(b).borderTopLeftRadius + '/' + cs(b).fontWeight),
        bold: textButtons.filter((b) => Number(cs(b).fontWeight) > 400).map((b) => b.textContent.trim().slice(0, 30)),
        fields: Array.from(m.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')).map((f) => cs(f).borderTopLeftRadius + '/' + cs(f).fontWeight).filter((v) => v !== '8px/400'),
        labels: Array.from(m.querySelectorAll('label')).filter((l) => Number(cs(l).fontWeight) > 400).length,
      }; })()`);
    check('Settings rail: text only, no icons', chrome.railCount > 0 && chrome.railIcons === 0, JSON.stringify(chrome).slice(0, 200));
    check('Settings section headings: text only', chrome.headingCount > 0 && chrome.headingIcons === 0, `${chrome.headingIcons}/${chrome.headingCount}`);
    check('Settings text buttons carry no icons', Array.isArray(chrome.buttonIcons) && chrome.buttonIcons.length === 0, (chrome.buttonIcons || []).join(', '));
    check('Save Settings and Cancel take the control radius (8px) and the normal weight', chrome.save === '8px/400' && chrome.footer.every((v) => v === '8px/400'), `${chrome.save} ${chrome.footer}`);
    check('no bold text button in Settings', Array.isArray(chrome.bold) && chrome.bold.length === 0, (chrome.bold || []).join(', '));
    check('every Settings field takes the control radius and the normal weight', Array.isArray(chrome.fields) && chrome.fields.length === 0, (chrome.fields || []).join(', '));
    check('Settings labels are normal weight', chrome.labels === 0, String(chrome.labels));
    // a headless window has no focus of its own: emulate it, or :focus never matches
    await app.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await clickText('General');
    await sleep(500);
    const focusRing = await app.evaluate(`(() => { const m = ${MODAL}; const f = m && m.querySelector('input:not([type=checkbox]), select'); if (!f) return 'no field'; const before = getComputedStyle(f).borderColor + '|' + getComputedStyle(f).boxShadow; f.focus(); const after = getComputedStyle(f).borderColor + '|' + getComputedStyle(f).boxShadow; return after !== before || getComputedStyle(f).outlineStyle !== 'none' ? 'visible' : 'none (' + after + ')'; })()`);
    check('keyboard focus on a field is visible (ring or outline)', focusRing === 'visible', focusRing);
    const settingsDir = path.join(REPO, 'src', 'components', 'common', 'modals', 'settings');
    const confirms = spawnSync('grep', ['-rln', 'window.confirm', settingsDir, path.join(REPO, 'src', 'components', 'common', 'modals', 'CloudSettingsModal.jsx'), path.join(REPO, 'src', 'components', 'common', 'modals', 'SettingsModal.jsx')], { encoding: 'utf8' });
    check('no window.confirm() in the Settings components (ConfirmationModal instead)', (confirms.stdout || '').trim() === '', confirms.stdout);
  }
  // The team features come with the home server: the Documents menu has no
  // "Cloud Settings" item, and Settings > General shows the central status
  // in the Account section (signed in here, so the server provides it)
  await clickText('Cancel');
  await sleep(500);
  const menuItems = await app.evaluate(`(async () => {
    const menu = Array.from(document.querySelectorAll('button')).find((b) => /menu/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
    if (!menu) return 'no hamburger';
    menu.click(); await new Promise((r) => setTimeout(r, 400));
    const labels = Array.from(document.querySelectorAll('button, [role=menuitem]')).map((b) => b.textContent.trim()).filter(Boolean);
    document.body.click(); await new Promise((r) => setTimeout(r, 300));
    return labels.join('|');
  })()`);
  check('the Documents menu no longer offers "Cloud Settings" (but still Settings)', /\|Settings\|/.test(`|${menuItems}|`) && !/Cloud Settings/.test(menuItems), menuItems.slice(0, 200));
  await app.evaluate(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'general' } }))`);
  const centralStatus = await app.waitFor(`(() => { const s = document.querySelector('[data-testid="settings-modal"] [data-testid="central-status"]'); if (!s || s.getAttribute('data-state') === 'asking') return null; return s.getAttribute('data-state') + '|' + (s.querySelector('[data-testid="central-connection"]') || {}).textContent; })()`, 8000);
  check('Settings > General > Account shows the central status (no Cloud Sync tab)', typeof centralStatus === 'string' && !/^asking/.test(centralStatus) && !(await app.evaluate(`Array.from(document.querySelectorAll('[data-testid="settings-modal"] [role=tab]')).some((t) => t.textContent.trim() === 'Cloud Sync')`)), String(centralStatus));
  await clickText('Cancel');
  console.log(`screenshots in ${outDir}`);
} catch (error) {
  check('the audit ran to the end', false, (error.stack || error.message) + '\n' + app.errors.slice(-3).join(' | '));
} finally {
  await app.close();
  stopBackend();
  if (!process.env.SETTINGS_SHOTS_DIR) rmSync(outDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
