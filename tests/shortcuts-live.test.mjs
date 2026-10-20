#!/usr/bin/env node
/**
 * A rebinding in the real browser (Chrome, tests/helpers/live-documents-app.mjs;
 * SKIP without one), the web build on a mocked Linux:
 *   - Settings > Shortcuts lists the bindings; Change on "Find in document",
 *     Ctrl+J, Use;
 *   - in the editor Ctrl+F no longer opens Find and Ctrl+J does; the Find
 *     bar's chord is consumed (the browser's own find never opens);
 *   - Open Calendars bound to Ctrl+Alt+C switches the page (the renderer
 *     owns the Pages in a browser);
 *   - a reload keeps both (localStorage, schema 1), and Reset all clears them.
 * Run: node tests/shortcuts-live.test.mjs
 */
import { launchDocumentsApp, createNewDocument, sleep } from './helpers/live-documents-app.mjs';

let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const done = () => { console.log(`\n${total - failed}/${total} checks passed`); process.exit(failed ? 1 : 0); };

const app = await launchDocumentsApp({ port: 5285, profilePrefix: 'shortcuts-live-' });
if (app.skip) { console.log('SKIP: ' + app.skip); done(); }
const ev = (s) => app.evaluate(s);
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function press(key, code, vk, mods) {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(350);
}
const clickTestId = (id) => ev(`(() => { const b = document.querySelector('[data-testid="${id}"]'); if (!b) return false; b.click(); return true; })()`);
const dismiss = async () => { for (let i = 0; i < 6; i++) { const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^Got it!$/.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; })()`); if (ok) break; await sleep(300); } };
const chordText = (id) => ev(`document.querySelector('[data-testid="shortcut-chord-${id}"]')?.textContent.trim()`);
const findBar = () => ev(`Array.from(document.querySelectorAll('span')).some((s) => /^Find( & Replace)?$/.test(s.textContent.trim()))`);
const EDITOR = `document.querySelector('.sc-editor-textarea')`;
const focusEditor = () => ev(`(() => { const ta = ${EDITOR}; if (!ta) return false; ta.focus(); return true; })()`);
async function openShortcuts() {
  await ev(`window.dispatchEvent(new Event('openAppSettings'))`);
  await app.waitFor(`!!document.querySelector('[data-testid="settings-modal"]')`, 8000);
  await ev(`(() => { const t = Array.from(document.querySelectorAll('[data-testid="settings-modal"] .sc-rail-tab')).find((x) => x.textContent.trim() === 'Shortcuts'); t && t.click(); })()`);
  await app.waitFor(`!!document.querySelector('[data-testid="shortcuts-settings"]')`, 5000);
}
const closeSettings = async () => { await ev(`(() => { const b = Array.from(document.querySelectorAll('[data-testid="settings-modal"] button')).find((x) => /close/i.test(x.getAttribute('aria-label') || x.getAttribute('title') || '')); b && b.click(); })()`); await sleep(400); };

try {
  await app.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Linux x86_64', userAgentMetadata: { brands: [{ brand: 'Chromium', version: '130' }], fullVersion: '130.0.0.0', platform: 'Linux', platformVersion: '6.0', architecture: 'x86', model: '', mobile: false } });
  await ev(`localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify('light')); localStorage.removeItem('jacarium.shortcuts'); location.reload()`);
  await sleep(3500); await dismiss();
  if (!(await ev(`!!${EDITOR}`))) { await createNewDocument(app); await sleep(1200); }
  check('the Documents page with an open document on a mocked Linux', await ev(`!!${EDITOR}`) && (await ev('navigator.platform')) === 'Linux x86_64');

  await openShortcuts();
  check('Settings > Shortcuts lists Find in document as Ctrl+F and Open Calendars unassigned', (await chordText('editor.find')) === 'Ctrl+F' && (await chordText('page.calendars')) === 'Unassigned', `${await chordText('editor.find')} / ${await chordText('page.calendars')}`);
  await clickTestId('shortcut-change-editor.find');
  await app.waitFor(`!!document.querySelector('[data-testid="shortcut-recorder"]')`, 3000);
  await press('j', 'KeyJ', 74, MOD.ctrl);
  check('the recorder shows Ctrl+J', (await ev(`document.querySelector('[data-testid="recorder-preview"]')?.textContent.trim()`)) === 'Ctrl+J');
  await clickTestId('recorder-use');
  await app.waitFor(`document.querySelector('[data-testid="shortcut-chord-editor.find"]')?.textContent.trim() === 'Ctrl+J'`, 3000);
  check('Use binds Find in document to Ctrl+J; localStorage holds the one override with the schema version', (await chordText('editor.find')) === 'Ctrl+J' && (await ev(`localStorage.getItem('jacarium.shortcuts')`)) === JSON.stringify({ version: 1, overrides: { 'editor.find': 'Mod+KeyJ' } }), await ev(`localStorage.getItem('jacarium.shortcuts')`));
  await clickTestId('shortcut-change-page.calendars');
  await app.waitFor(`!!document.querySelector('[data-testid="shortcut-recorder"]')`, 3000);
  await press('c', 'KeyC', 67, MOD.ctrl | MOD.alt);
  await clickTestId('recorder-use');
  await app.waitFor(`document.querySelector('[data-testid="shortcut-chord-page.calendars"]')?.textContent.trim() === 'Ctrl+Alt+C'`, 3000);
  check('Open Calendars bound to Ctrl+Alt+C', (await chordText('page.calendars')) === 'Ctrl+Alt+C');
  await closeSettings();

  await focusEditor();
  await press('f', 'KeyF', 70, MOD.ctrl);
  check('in the editor Ctrl+F no longer opens Find', !(await findBar()));
  await press('j', 'KeyJ', 74, MOD.ctrl);
  check('...and Ctrl+J does', await findBar());
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Close (Esc)'); b && b.click(); })()`); await sleep(200);
  await ev(`document.activeElement && document.activeElement.blur()`);
  await press('c', 'KeyC', 67, MOD.ctrl | MOD.alt);
  await sleep(600);
  check('Ctrl+Alt+C switches to Calendars (the renderer owns the Pages in a browser)', await ev(`!!document.querySelector('[data-testid="calendar-connect-state"]')`));

  await ev('location.reload()'); await sleep(3500); await dismiss();
  await openShortcuts();
  check('after a reload both bindings are still there', (await chordText('editor.find')) === 'Ctrl+J' && (await chordText('page.calendars')) === 'Ctrl+Alt+C', `${await chordText('editor.find')} / ${await chordText('page.calendars')}`);
  await clickTestId('shortcuts-reset-all');
  await sleep(300);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Reset all' && x.getAttribute('data-testid') !== 'shortcuts-reset-all'); b && b.click(); })()`);
  await app.waitFor(`document.querySelector('[data-testid="shortcut-chord-editor.find"]')?.textContent.trim() === 'Ctrl+F'`, 3000);
  const storedAfter = await ev(`localStorage.getItem('jacarium.shortcuts')`);
  check('Reset all restores the defaults and empties the stored overrides', (await chordText('editor.find')) === 'Ctrl+F' && (await chordText('page.calendars')) === 'Unassigned' && storedAfter === JSON.stringify({ version: 1, overrides: {} }), storedAfter);
  check('no page exception during the live run', app.errors.length === 0, app.errors.join(' ; '));
} finally {
  await app.close();
}
done();
