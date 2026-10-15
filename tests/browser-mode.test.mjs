/**
 * The app in a plain browser (no window.electronAPI): Vite dev server +
 * headless Chrome, synthetic data on a fresh profile.
 *
 * Proves that
 *   - every main page opens without an uncaught exception;
 *   - what needs the desktop app is disabled with the uniform wording
 *     (src/utils/platform.js desktopOnly): the document context menu's
 *     Export PDF, the WHOIS tool's Lookup, the Integrations / AI Providers
 *     settings (read from and saved to the desktop's env file);
 *   - what has a browser equivalent works: the pop-out "Open in New Tab"
 *     opens the standalone page in a new tab, the Documents page's
 *     hamburger menu has a Settings entry (an Electron menu item otherwise)
 *     that opens the dialog over the Documents page - no sidebar button -
 *     and the Database export/import/wipe and What's New entries live in
 *     Settings > General.
 *
 * Skips (exit 0 with a SKIP line) without Chrome / with SKIP_BROWSER_TESTS,
 * like the other live tests. Port 5231 (SMOKE_PORT to override).
 */
import { launchDocumentsApp, createNewDocument, sleep } from './helpers/live-documents-app.mjs';
import { APP_PAGES, dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const port = Number(process.env.SMOKE_PORT || 5231);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failed++;
};
const clickNav = (app, label) => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const findButton = (app, text) => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); return b ? { disabled: b.disabled, title: b.title || '' } : null; })()`);
const clickButton = (app, text) => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);

const app = await launchDocumentsApp({ port, profilePrefix: 'browser-mode-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(0); }

try {
  // A defined viewport (the sidebar collapses buttons behind "More" below
  // ~850px of window height; headless Chrome's inner height is smaller than
  // its --window-size)
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await dismissWhatsNew(app);
  check('no window.electronAPI in the browser', (await app.evaluate('typeof window.electronAPI')) === 'undefined');

  // ---- every page, no exception ----
  for (const label of APP_PAGES) {
    const before = app.errors.length;
    const ok = await clickNav(app, label);
    await sleep(1800);
    check(`${label}: opens without an uncaught exception`, ok && app.errors.length === before, app.errors.slice(before).join(' || ').slice(0, 200));
  }

  // ---- pop-out -> new tab ----
  await app.evaluate(`window.__opened = []; window.open = (url, target) => { window.__opened.push({ url: String(url), target }); return null; };`);
  await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Tools'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5, view: window })); })()`);
  await sleep(400);
  const popLabel = await app.evaluate(`(Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).find((t) => /Open in New Tab/i.test(t)) || null)`);
  check('the page context menu offers "Open in New Tab" in the browser (the desktop app says "Open in External Window")', !!popLabel, popLabel || '(none)');
  if (popLabel) await clickButton(app, popLabel);
  await sleep(300);
  const opened = await app.evaluate('window.__opened');
  check('...which opens the standalone Tools page in a new tab', Array.isArray(opened) && opened.length === 1 && /\?standalone=tools$/.test(opened[0].url) && opened[0].target === '_blank', JSON.stringify(opened));
  await app.evaluate(`document.body.click()`);

  // ---- WHOIS: disabled with the message ----
  await clickNav(app, 'Tools');
  await sleep(1200);
  // The Tools list groups tools by category (collapsed): wait for the list,
  // open Networking, then click the tool name once its row is visible
  const categoryOpened = await app.waitFor(`(() => { const c = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim().startsWith('Networking')); if (!c) return false; c.click(); return true; })()`, 10000);
  const whoisOpened = categoryOpened && !!(await app.waitFor(`(() => { const span = Array.from(document.querySelectorAll('span')).find((e) => e.textContent.trim() === 'WHOIS Lookup' && e.offsetParent); if (!span) return false; span.click(); return true; })()`, 10000));
  await app.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Lookup')`, 10000);
  const lookup = await findButton(app, 'Lookup');
  check('Tools: the WHOIS Lookup button is disabled with the desktop-only message', whoisOpened && lookup && lookup.disabled && /only available in the desktop app/.test(lookup.title), JSON.stringify({ whoisOpened, lookup }));
  const whoisNotice = await app.evaluate(`(Array.from(document.querySelectorAll('p, div, span')).map((e) => e.textContent.trim()).find((t) => /WHOIS lookup is only available in the desktop app/.test(t)) || '')`);
  check('...and the notice is shown in the tool itself', whoisNotice.length > 0);

  // ---- Export PDF: disabled in the document context menu ----
  await clickNav(app, 'Documents');
  await sleep(1200);
  check('a new document can be created', await createNewDocument(app));
  await app.evaluate(`(() => { for (const b of document.querySelectorAll('button[title="Expand"]')) b.click(); })()`);
  await sleep(300);
  await app.evaluate(`(() => { const m = Array.from(document.querySelectorAll('span, div, p')).filter((e) => e.children.length === 0 && /Untitled/i.test(e.textContent)).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]; if (!m) return; const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 5, view: window })); })()`);
  await sleep(300);
  const exportPdf = await findButton(app, 'Export PDF');
  check('Documents: Export PDF is disabled with the desktop-only message', exportPdf && exportPdf.disabled && /PDF export is only available in the desktop app/.test(exportPdf.title), JSON.stringify(exportPdf));
  await app.evaluate(`document.body.click()`);

  // ---- Settings: no sidebar button; the Documents page's hamburger menu opens
  // the dialog over the Documents page, and closing it leaves the user there ----
  await clickNav(app, 'Documents');
  await sleep(800);
  const visibleSettingsButtons = await app.evaluate(`Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Settings' && el.offsetParent).length`);
  check('the sidebar has no Settings button in the browser', visibleSettingsButtons === 0, String(visibleSettingsButtons));
  // The Documents header's hamburger (lucide "menu" icon next to the DOCUMENTS title)
  const openDocumentsMenu = () => app.evaluate(`(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => /^documents$/i.test(e.textContent.trim())); const header = h && h.closest('div').parentElement; const b = header && Array.from(header.querySelectorAll('button')).find((el) => el.querySelector('svg.lucide-menu')); if (!b) return false; b.click(); return true; })()`);
  const openSettingsFromDocuments = async () => {
    if (!(await openDocumentsMenu())) return false;
    await sleep(300);
    const clicked = await clickButton(app, 'Settings');
    await sleep(800);
    return clicked;
  };
  const documentsStillShown = () => app.evaluate(`!!Array.from(document.querySelectorAll('h2')).find((e) => /^documents$/i.test(e.textContent.trim()) && e.offsetParent)`);
  const settingsOpened = await openSettingsFromDocuments();
  const generalText = await app.evaluate(`Array.from(document.querySelectorAll('h2, h3')).map((e) => e.textContent.trim())`);
  check('the Documents hamburger menu has a Settings entry that opens the Settings dialog', settingsOpened && generalText.some((t) => /Application Settings/i.test(t)), JSON.stringify(generalText.slice(0, 8)));
  check('...over the Documents page (still rendered behind the dialog)', await documentsStillShown());
  const dbButtons = await app.evaluate(`['Export Database', 'Import Database', 'Wipe Database', "What's New"].map((t) => !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === t))`);
  check('Settings > General offers Export / Import / Wipe Database and What\'s New (menu-only actions in the desktop app)', dbButtons.every(Boolean), JSON.stringify(dbButtons));
  check('...and What\'s New opens from there', (await clickButton(app, "What's New")) && (await app.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Got it!')`, 3000)));
  await dismissWhatsNew(app);
  // What's New closed the dialog: open it again for the Integrations tab
  await openSettingsFromDocuments();
  const tabClicked = await clickButton(app, 'Integrations');
  await sleep(400);
  const integrationsNotice = await app.evaluate(`(Array.from(document.querySelectorAll('p, div, span')).map((e) => e.textContent.trim()).find((t) => /only available in the desktop app/.test(t) && /settings|integration|env/i.test(t)) || '')`);
  const saveButton = await findButton(app, 'Save Settings');
  check('Settings > Integrations explains the env-file settings need the desktop app or the backend, and Save is disabled without either', tabClicked && integrationsNotice.length > 0 && saveButton && saveButton.disabled, JSON.stringify({ integrationsNotice: integrationsNotice.slice(0, 120), saveButton }));
  check('Cancel closes the dialog and the user is still on Documents', (await clickButton(app, 'Cancel')) && (await app.waitFor(`!Array.from(document.querySelectorAll('h2, h3')).some((e) => /Application Settings/i.test(e.textContent))`, 3000)) && (await documentsStillShown()));

  check('no uncaught exceptions during the whole run', app.errors.length === 0, app.errors.slice(0, 3).join(' || ').slice(0, 300));
} finally {
  await app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
