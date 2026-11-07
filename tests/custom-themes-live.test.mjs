#!/usr/bin/env node
/**
 * Custom themes, live (Playwright against the Vite dev server, no backend):
 * Settings > Theme as redesigned for 4.2.0 - the scheme gallery at the top
 * (the built-in schemes, the palettes, the user's themes; a click or the
 * arrow keys switch at once, a palette applies from its template and
 * survives a reload), Customize below it (prefilled from the scheme on
 * screen; edits preview live; Save as new theme creates "Midnight"; on a
 * theme of the user's Save saves in place, Save as new copies, Reset
 * returns, switching tiles with changes asks first), Export JSON (the
 * shared ExportJsonModal: the JSON selected, Copy, Ctrl/Cmd+A/C, Download),
 * the round trip Copy -> Import JSON (paste, Dry Run, Import) giving the
 * identical theme under a new id, a tampered file's Validation Error, an
 * oversize paste, Delete, and the Diagnostics frame taking the theme.
 * Screenshots in CUSTOM_THEMES_SHOTS_DIR (/private/tmp/claude-501/shots/custom-themes).
 *
 * Needs playwright-core with Chromium. Port CUSTOM_THEMES_TEST_PORT (5206).
 * Run: node tests/custom-themes-live.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CUSTOM_THEMES_TEST_PORT || 5206);
const OUT = process.env.CUSTOM_THEMES_SHOTS_DIR || '/private/tmp/claude-501/shots/custom-themes';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CUSTOM_THEMES_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-themes-'));
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

// the Diagnostics fixture (the synthetic sosreport's Processes tab through Flask), when the backend venv is there
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
let report = null;
if (fs.existsSync(PYTHON)) {
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  const NAME = 'sosreport-web-01-2026-10-13-abcdef';
  const htmlDir = path.join(work, 'html');
  const ren = gen.status === 0 ? spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, NAME), '--report-type', 'sosreport', '--tabs', 'system', 'processes'], { encoding: 'utf8' }) : { status: 1 };
  if (ren.status === 0) report = { name: NAME, path: '/tmp/custom-themes-diag/' + NAME, type: 'sosreport', modified: 1760000000, html: { system: fs.readFileSync(path.join(htmlDir, 'system.html'), 'utf8'), processes: fs.readFileSync(path.join(htmlDir, 'processes.html'), 'utf8') }, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
}

const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce', colorScheme: 'dark', acceptDownloads: true });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('diagnosticsReportsDirectory', '/tmp/custom-themes-diag'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.2.0', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
if (report) {
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [{ name: report.name, path: report.path, type: report.type, modified: report.modified }] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs: report.tabs, report_type: report.type, directory: report.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(REPO, 'backend/static/styles.css'), 'utf8') }));
  await context.route('http://localhost:8080/load_tab', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const key = body.sub_tab || body.tab; r.fulfill({ json: { html: report.html[key] || '<div class="ui-note">no such tab</div>' } }); });
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const typeHex = async (testId, hex) => { const el = page.locator(`[data-testid="${testId}-hex"]`); await el.fill(''); await el.fill(hex); await page.waitForTimeout(120); };
const openThemeSettings = async () => {
  await page.locator('[data-testid="sidebar-brand-mark"]').click();
  await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="settings-modal"] [role="tab"]', { hasText: 'Theme' }).click();
  await page.locator('[data-testid="scheme-gallery"]').waitFor({ timeout: 10000 });
};
const closeSettings = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(400); if (await page.locator('[data-testid="settings-modal"]').count()) { await clickButton('Cancel'); await page.waitForTimeout(400); } };

try {
  await page.goto(URL_, { waitUntil: 'load' }); await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const before = await token('--os-canvas');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('jacarium-custom-themes') || '[]'));
  const appTheme = () => page.evaluate(() => localStorage.getItem('app-theme'));
  const railBg = () => page.evaluate(() => getComputedStyle(document.querySelector('nav.w-16')).backgroundImage + ' ' + getComputedStyle(document.querySelector('nav.w-16')).backgroundColor);
  const nameValue = () => page.locator('[data-testid="custom-theme-name"]').inputValue();
  const hexValue = (key) => page.locator(`[data-testid="custom-theme-color-${key}-hex"]`).inputValue();
  const active = () => page.locator('[data-testid^="scheme-card-"][aria-checked="true"]').getAttribute('data-testid');
  const confirmButton = (label) => page.getByRole('button', { name: new RegExp(`^${label}$`) }).last();

  await openThemeSettings();
  const tiles = await page.locator('[data-testid="scheme-gallery"] [data-testid^="scheme-card-"]').count();
  check('Settings > Theme: the gallery at the top (Auto active; Light, Jacaranda, Dark, the five gradient schemes, the eleven palettes, the six Crazy ones; Your themes empty), no select, and Customize prefilled from the scheme on screen ("Jacaranda (dark) (custom)", Save as new theme)', tiles === 26 && (await active()) === 'scheme-card-auto' && (await page.locator('[data-testid="theme-color-scheme"]').count()) === 0 && (await page.locator('[data-testid="scheme-gallery-empty"]').count()) === 1 && (await nameValue()) === 'Jacaranda (dark) (custom)' && (await page.locator('[data-testid="custom-theme-save"]').textContent()).trim() === 'Save as new theme' && (await page.locator('[data-testid="custom-theme-reset"]').isDisabled()), JSON.stringify([tiles, await active(), await nameValue()]));
  await page.locator('[data-testid="settings-modal"]').screenshot({ path: path.join(OUT, 'settings-theme-page-dark.png') });

  // a palette tile: applied at once
  await page.locator('[data-testid="scheme-card-starter-nord"]').click(); await page.waitForTimeout(400);
  check('clicking Nord switches at once: app-theme starter-nord, the canvas token and the rail from the palette, the tile active, Customize prefilled as "Nord (custom)"', (await appTheme()) === 'starter-nord' && (await token('--os-canvas')) === '#2e3440' && /rgb\(46, 52, 64\)/.test(await railBg()) && (await active()) === 'scheme-card-starter-nord' && (await nameValue()) === 'Nord (custom)' && (await hexValue('accent')) === '#88c0d0' && (await page.locator('[data-testid="custom-theme-warnings"]').count()) === 0, JSON.stringify([await appTheme(), await token('--os-canvas'), await railBg(), await active(), await nameValue()]));
  await closeSettings();
  await page.screenshot({ path: path.join(OUT, 'app-palette-nord.png') });
  // the keyboard: the arrows choose, Home / End jump
  await openThemeSettings();
  await page.locator('[data-testid="scheme-card-starter-nord"]').focus();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  const afterRight = await appTheme();
  await page.keyboard.press('End'); await page.waitForTimeout(300);
  const afterEnd = [await appTheme(), await page.evaluate(() => document.documentElement.classList.contains('dark')), await page.evaluate(() => document.activeElement?.dataset?.testid)];
  await page.keyboard.press('Home'); await page.waitForTimeout(300);
  const afterHome = await appTheme();
  check('the gallery is a radio group: ArrowRight chooses Dracula, End the last tile (Toxic Neon, a dark scheme, focus following), Home Auto', afterRight === 'starter-dracula' && afterEnd[0] === 'starter-toxic-neon' && afterEnd[1] === true && afterEnd[2] === 'scheme-card-starter-toxic-neon' && afterHome === 'auto', JSON.stringify([afterRight, afterEnd, afterHome]));
  await page.locator('[data-testid="scheme-card-starter-nord"]').click(); await page.waitForTimeout(300);
  await closeSettings();
  // a reload keeps a palette (nothing stored for it)
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  check('a reload keeps the palette: starter-nord applied from the template, no custom theme stored', (await appTheme()) === 'starter-nord' && (await token('--os-canvas')) === '#2e3440' && (await stored()).length === 0 && before !== '#2e3440');

  // Customize from Nord: edits preview live; Save as new theme creates "Midnight"
  await openThemeSettings();
  await page.locator('[data-testid="custom-theme-name"]').fill('Midnight');
  await typeHex('custom-theme-color-canvas', '#101827');
  await typeHex('custom-theme-color-card', '#1A2238');
  await typeHex('custom-theme-color-accent', '#F59E0B');
  await typeHex('custom-theme-color-markArch', '#F59E0B');
  await page.waitForTimeout(300);
  check('typing colours previews them on the app at once: --os-canvas, --os-card, --os-blue (the accent) and --mark-arch computed on <html>; Reset is enabled', (await token('--os-canvas')) === '#101827' && (await token('--os-card')) === '#1a2238' && (await token('--os-blue')) === '#f59e0b' && (await token('--mark-arch')) === '#f59e0b' && !(await page.locator('[data-testid="custom-theme-reset"]').isDisabled()), JSON.stringify([await token('--os-canvas'), await token('--os-card'), await token('--os-blue'), await token('--mark-arch')]));
  check('the derived tokens follow: the primary button is the accent with readable text, the selection tint is the accent', (await token('--btn-primary-bg')) === '#f59e0b' && (await token('--btn-primary-fg')) === '#151515' && /^rgba\(245, 158, 11/.test(await token('--os-terminal-selection')), JSON.stringify([await token('--btn-primary-bg'), await token('--btn-primary-fg'), await token('--os-terminal-selection')]));
  await page.locator('[data-testid="custom-theme-rail-fill-type"] button', { hasText: 'Linear gradient' }).click();
  await typeHex('custom-theme-rail-stop-1', '#3B0764');
  await typeHex('custom-theme-rail-stop-2', '#111827');
  await page.waitForTimeout(300);
  check('a linear gradient rail: the navigation rail paints it (built from the two validated stops)', /linear-gradient\((180deg, )?rgb\(59, 7, 100\) 0%, rgb\(17, 24, 39\) 100%\)/.test(await railBg()), await railBg());
  await page.locator('[data-testid="custom-theme-color-accent-swatch"]').click();
  check('the swatch opens the shared colour picker (react-colorful) in a popover', await page.locator('[data-testid="custom-theme-editor"] .react-colorful').count() === 1);
  await page.locator('[data-testid="settings-modal"]').screenshot({ path: path.join(OUT, 'settings-editor-picker.png') });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check('Escape closes the picker, not the settings dialog', await page.locator('[data-testid="custom-theme-editor"] .react-colorful').count() === 0 && await page.locator('[data-testid="settings-modal"]').count() === 1);
  await typeHex('custom-theme-color-textMuted', '#1A2238');
  await page.waitForTimeout(200);
  check('muted text the colour of the card raises the contrast warning naming the pair, and Save stays enabled', await page.locator('[data-testid="custom-theme-warnings"]').count() === 1 && /Muted text on a card: 1:1, under 3:1/.test(await page.locator('[data-testid="custom-theme-warnings"]').textContent()) && !(await page.locator('[data-testid="custom-theme-save"]').isDisabled()));
  await typeHex('custom-theme-color-textMuted', '#9CA3AF');
  await page.waitForTimeout(200);
  check('...and that line goes away once the colour reads', !/Muted text on a card/.test((await page.locator('[data-testid="custom-theme-warnings"]').count()) ? await page.locator('[data-testid="custom-theme-warnings"]').textContent() : ''));
  await page.locator('[data-testid="custom-theme-save"]').click(); await page.waitForTimeout(500);
  let list = await stored();
  const scheme = await appTheme();
  check('Save as new theme: "Midnight" stored under a ct- id with the colours and the structured rail fill, chosen (custom-ct-...), its tile active under Your themes, Customize now the theme\'s own (Delete, Save as new, Save disabled until a change)', list.length === 1 && /^ct-/.test(list[0].id) && list[0].name === 'Midnight' && list[0].colors.accent === '#f59e0b' && list[0].fills.rail.type === 'linear' && list[0].fills.rail.stops[0].color === '#3b0764' && scheme === `custom-${list[0].id}` && (await active()) === `scheme-card-${scheme}` && (await page.locator('[data-testid="custom-theme-delete"]').count()) === 1 && (await page.locator('[data-testid="custom-theme-save-as-new"]').count()) === 1 && (await page.locator('[data-testid="custom-theme-save"]').isDisabled()) && (await nameValue()) === 'Midnight', JSON.stringify([list.map((t) => [t.id, t.name]), scheme, await active()]));
  check('...the theme is applied: the tokens stay, the dark class comes from the base, the seasonal decorations take the dark variant', (await token('--os-canvas')) === '#101827' && (await token('--decor-blade-edge')) === 'none' && await page.evaluate(() => document.documentElement.classList.contains('dark') && document.documentElement.getAttribute('data-theme').startsWith('custom-')));
  await closeSettings();
  await page.screenshot({ path: path.join(OUT, 'app-custom-dark.png') });

  // a theme of the user's: Save in place, Save as new, Reset
  await openThemeSettings();
  await page.locator('[data-testid="custom-theme-name"]').fill('Midnight blue'); await page.waitForTimeout(200);
  await page.locator('[data-testid="custom-theme-save"]').click(); await page.waitForTimeout(400);
  list = await stored();
  check('Save on a theme of yours saves it in place: the same id, the new name on its tile, Save disabled again', list.length === 1 && `custom-${list[0].id}` === scheme && list[0].name === 'Midnight blue' && /Midnight blue/.test(await page.locator(`[data-testid="scheme-card-${scheme}"]`).textContent()) && (await page.locator('[data-testid="custom-theme-save"]').isDisabled()), JSON.stringify(list.map((t) => [t.id, t.name])));
  await typeHex('custom-theme-color-accent', '#22C55E'); await page.waitForTimeout(200);
  await page.locator('[data-testid="custom-theme-save-as-new"]').click(); await page.waitForTimeout(400);
  list = await stored();
  const copyScheme = await appTheme();
  check('Save as new keeps the original and adds "Midnight blue (copy)" with the change, chosen', list.length === 2 && list[0].colors.accent === '#f59e0b' && list[1].name === 'Midnight blue (copy)' && list[1].colors.accent === '#22c55e' && copyScheme === `custom-${list[1].id}`, JSON.stringify(list.map((t) => [t.name, t.colors.accent])) + ' ' + copyScheme);
  await typeHex('custom-theme-color-canvas', '#000000'); await page.waitForTimeout(200);
  const previewed = await token('--os-canvas');
  await page.locator('[data-testid="custom-theme-reset"]').click(); await page.waitForTimeout(300);
  check('Reset returns to the theme\'s saved values: the previewed canvas (#000000) goes back to #101827, Reset disabled', previewed === '#000000' && (await token('--os-canvas')) === '#101827' && (await hexValue('canvas')) === '#101827' && (await page.locator('[data-testid="custom-theme-reset"]').isDisabled()), JSON.stringify([previewed, await token('--os-canvas'), await hexValue('canvas')]));
  // unsaved changes and another tile: a confirmation
  await typeHex('custom-theme-color-canvas', '#000000'); await page.waitForTimeout(200);
  await page.locator('[data-testid="scheme-card-light"]').click(); await page.waitForTimeout(300);
  const asked = (await page.getByText('Discard your changes?').count()) === 1;
  await confirmButton('Cancel').click(); await page.waitForTimeout(300);
  check('switching tiles with unsaved changes asks first; Cancel keeps the scheme and the changes', asked && (await appTheme()) === copyScheme && (await hexValue('canvas')) === '#000000' && (await page.locator('[data-testid="settings-modal"]').count()) === 1, JSON.stringify([asked, await appTheme(), await hexValue('canvas')]));
  await page.locator('[data-testid="scheme-card-light"]').click(); await page.waitForTimeout(300);
  await confirmButton('Discard and switch').click(); await page.waitForTimeout(400);
  check('"Discard and switch" applies Light and refills Customize from it ("Light (custom)", nothing dirty); the copy kept its saved canvas', (await appTheme()) === 'light' && !(await page.evaluate(() => document.documentElement.classList.contains('dark'))) && (await nameValue()) === 'Light (custom)' && (await page.locator('[data-testid="custom-theme-reset"]').isDisabled()) && (await stored())[1].colors.canvas === '#101827', JSON.stringify([await appTheme(), await nameValue()]));
  await page.locator('[data-testid="settings-modal"]').screenshot({ path: path.join(OUT, 'settings-theme-page-light.png') });
  await page.locator('[data-testid="scheme-card-starter-solarized-light"]').click(); await page.waitForTimeout(300);
  await closeSettings();
  await page.screenshot({ path: path.join(OUT, 'app-palette-solarized-light.png') });

  // Export: the modal with the JSON selected, Copy, Download; the round trip into Import JSON
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openThemeSettings();
  await page.locator(`[data-testid="scheme-card-${copyScheme}"]`).click(); await page.waitForTimeout(300);
  await page.locator('[data-testid="custom-theme-export"]').click();
  await page.locator('[data-testid="export-theme-modal"]').waitFor(); await page.waitForTimeout(200);
  const exportedText = await page.locator('[data-testid="export-json-text"]').inputValue();
  const exportedFile = JSON.parse(exportedText);
  const selection = await page.evaluate(() => { const t = document.querySelector('[data-testid="export-json-text"]'); return [t.selectionStart, t.selectionEnd, t.value.length, document.activeElement === t]; });
  check('Export JSON opens the export modal: the theme file as JSON in a read-only box, focused with everything selected', exportedFile.format === 'jacarium-theme' && exportedFile.formatVersion === 1 && exportedFile.theme.name === 'Midnight blue (copy)' && exportedFile.theme.colors.accent === '#22c55e' && selection[0] === 0 && selection[1] === selection[2] && selection[3] && (await page.locator('[data-testid="export-json-text"]').getAttribute('readonly')) !== null, JSON.stringify(selection));
  await page.locator('[data-testid="settings-modal"], [data-testid="export-theme-modal"]').last().screenshot({ path: path.join(OUT, 'settings-export-modal.png') });
  await page.locator('[data-testid="export-json-copy"]').click(); await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('Copy writes the JSON to the clipboard and says "Copied"', clip === exportedText && (await page.locator('[data-testid="export-json-copy"]').textContent()).trim() === 'Copied', clip.slice(0, 80));
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('[data-testid="export-json-text"]').click();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+c'); await page.waitForTimeout(200);
  check('Ctrl/Cmd+A and +C inside the box copy the whole JSON too', (await page.evaluate(() => navigator.clipboard.readText())) === exportedText);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('[data-testid="export-json-download"]').click()]);
  const downloaded = path.join(work, 'exported.json');
  await download.saveAs(downloaded);
  check('Download saves the same JSON as midnight-blue-copy.jacarium-theme.json', download.suggestedFilename().endsWith('.jacarium-theme.json') && fs.readFileSync(downloaded, 'utf8') === exportedText, download.suggestedFilename());
  await page.locator('[data-testid="export-json-close"]').click(); await page.waitForTimeout(200);
  check('Close leaves the settings dialog open', (await page.locator('[data-testid="export-theme-modal"]').count()) === 0 && (await page.locator('[data-testid="settings-modal"]').count()) === 1);
  // the round trip: what Copy wrote, pasted into Import JSON
  await page.locator('[data-testid="custom-theme-import"]').click();
  await page.locator('[data-testid="import-theme-modal"]').waitFor();
  await page.locator('[data-testid="import-json-input"]').fill(clip);
  await page.locator('[data-testid="import-footer"] button', { hasText: /^Dry Run$/ }).click(); await page.waitForTimeout(500);
  const dry = await page.locator('[data-testid="import-dry-run-lines"]').textContent();
  check('pasting the copied JSON: Dry Run says "1 theme would be added" as "Midnight blue (copy) (imported)" (the name exists), nothing written', /1 theme would be added/.test(dry) && /"Midnight blue \(copy\) \(imported\)" would be added \(renamed: "Midnight blue \(copy\)" exists\)/.test(dry) && (await stored()).length === 2, dry);
  await page.locator('[data-testid="import-theme-modal"]').screenshot({ path: path.join(OUT, 'settings-import-dry-run.png') });
  await page.locator('[data-testid="import-footer"] button', { hasText: /^Import Theme$/ }).click(); await page.waitForTimeout(600);
  list = await stored();
  const strip = (t) => JSON.stringify({ base: t.base, colors: t.colors, fills: t.fills, logoTone: t.logoTone });
  check('Import adds the identical theme under a new id, chosen and applied', list.length === 3 && list[2].name === 'Midnight blue (copy) (imported)' && list[2].id !== list[1].id && strip(list[2]) === strip(list[1]) && (await appTheme()) === `custom-${list[2].id}` && (await token('--os-blue')) === '#22c55e' && /Imported "Midnight blue \(copy\) \(imported\)"/.test(await page.locator('[data-testid="custom-theme-notice"]').textContent()), JSON.stringify(list.map((t) => [t.id, t.name])));
  // a tampered file on the Upload File tab, an oversize paste, Cancel
  const evil = { ...exportedFile, theme: { ...exportedFile.theme, colors: { ...exportedFile.theme.colors, card: 'url(javascript:alert(1))' }, background: 'linear-gradient(red, blue)' } };
  const evilPath = path.join(work, 'evil.json');
  fs.writeFileSync(evilPath, JSON.stringify(evil));
  await page.locator('[data-testid="custom-theme-import"]').click();
  await page.locator('[data-testid="import-theme-modal"]').waitFor();
  await page.locator('[data-testid="import-tab-file"]').click();
  await page.locator('[data-testid="import-file-input"]').setInputFiles(evilPath); await page.waitForTimeout(500);
  await page.locator('[data-testid="import-footer"] button', { hasText: /^Dry Run$/ }).click(); await page.waitForTimeout(500);
  const notice = await page.locator('[data-testid="import-theme-modal"]').textContent();
  check('a tampered file chosen on the Upload File tab (a url() colour, an unknown key) shows the Validation Error with the reasons and nothing changes', /Validation Error/.test(notice) && /Not imported: unknown keys: background/.test(notice) && /Card: not a colour/.test(notice) && (await stored()).length === 3, notice.slice(-400));
  await page.locator('[data-testid="import-theme-modal"]').screenshot({ path: path.join(OUT, 'settings-import-error.png') });
  await page.locator('[data-testid="import-tab-paste"]').click();
  await page.locator('[data-testid="import-json-input"]').fill(JSON.stringify({ ...exportedFile, exportedAt: 'x'.repeat(70 * 1024) }));
  await page.locator('[data-testid="import-footer"] button', { hasText: /^Import Theme$/ }).click(); await page.waitForTimeout(500);
  check('an oversize input is refused before it is parsed, the dialog stays', /larger than 64 KB/.test(await page.locator('[data-testid="import-theme-modal"]').textContent()) && (await page.locator('[data-testid="import-theme-modal"]').count()) === 1);
  await page.locator('[data-testid="import-footer"] button', { hasText: /^Cancel$/ }).click(); await page.waitForTimeout(300);
  check('Cancel closes the dialog without importing', (await page.locator('[data-testid="import-theme-modal"]').count()) === 0 && (await stored()).length === 3);
  // delete the imported one (chosen now)
  await page.locator('[data-testid="custom-theme-delete"]').click(); await page.waitForTimeout(300);
  await confirmButton('Delete').click(); await page.waitForTimeout(500);
  list = await stored();
  check('Delete (confirmed) removes the chosen theme; the scheme goes back to Auto and the others stay', list.length === 2 && list.map((t) => t.name).join() === 'Midnight blue,Midnight blue (copy)' && (await appTheme()) === 'auto' && (await active()) === 'scheme-card-auto', JSON.stringify(list.map((t) => t.name)) + ' ' + (await appTheme()));
  // Midnight blue for the Diagnostics part
  await page.locator(`[data-testid="scheme-card-${scheme}"]`).click(); await page.waitForTimeout(300);
  await closeSettings();

  // the Diagnostics frame takes the theme
  if (report) {
    await clickButton('Tools'); await sleep(300); await clickButton('Diagnostics'); await sleep(500);
    await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, report.name, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
    await sleep(300);
    await page.evaluate(() => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'System'); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) btn.click(); });
    await sleep(200);
    await page.evaluate(() => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = all.findIndex((el) => el.textContent.trim() === 'System') + 1; const s = all.slice(from).find((el) => el.textContent.trim() === 'Processes'); if (s) s.closest('div.cursor-pointer').click(); });
    let frame = null, srcdoc = null;
    for (let i = 0; i < 100 && !frame; i++) {
      const h = await page.$('iframe[title="Diagnostics content"][data-tab="processes"]');
      if (h) { srcdoc = srcdoc || await h.getAttribute('srcdoc'); const f = await h.contentFrame(); if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content .panel'))) frame = f; } catch { /* navigating */ } } }
      if (!frame) await sleep(150);
    }
    const inFrame = frame ? await frame.evaluate(() => ({ card: getComputedStyle(document.querySelector('#diagnostics-content .panel')).backgroundColor, token: getComputedStyle(document.documentElement).getPropertyValue('--os-card').trim(), dark: document.documentElement.classList.contains('dark') })) : null;
    check('the Diagnostics frame: its first document is baked with the custom tokens and the cards compute the theme\'s card colour inside the frame', !!frame && typeof srcdoc === 'string' && /--os-card: #1a2238/.test(srcdoc) && inFrame.token === '#1a2238' && inFrame.card === 'rgb(26, 34, 56)' && inFrame.dark, JSON.stringify({ inFrame, baked: srcdoc ? /--os-card: #1a2238/.test(srcdoc) : null }));
    await page.screenshot({ path: path.join(OUT, 'diagnostics-custom.png') });
  } else {
    console.log('SKIP: no backend/venv - the Diagnostics frame part needs the rendered fixture');
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`  screenshots: ${OUT}/`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await context.close().catch(() => {});
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
