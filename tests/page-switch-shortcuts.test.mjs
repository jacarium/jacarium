#!/usr/bin/env node
/**
 * No keyboard chord switches pages any more. The desktop menu's Pages items
 * carried Ctrl/Cmd+Shift+D/C/K/T/W/A/S/O (Documents, Calendars, Kanban,
 * Tasks, Workflow Builder, Diagnostics, JQL Search, Tools): on Linux
 * Ctrl+Shift+C is copy in terminals and many GTK apps, so a mistyped copy
 * jumped to the Calendars page. The menu items stay, without accelerators;
 * the renderer never had chords of its own for pages.
 *
 * Source checks (electron/main.cjs, the renderer):
 *   - the Pages submenu lists the eight pages and no `accelerator`;
 *     Settings (Cmd/Ctrl+,) and Toggle Sidebar (Cmd/Ctrl+B) keep theirs,
 *     Reload / Force Reload stay the plain roles;
 *   - the only Ctrl/Cmd+Shift+<letter> chords in the renderer are the
 *     Documents page's Find in Files (F) and the workflow canvas's redo (Z);
 *   - the editor binds no Ctrl/Cmd+K (link), +B (bold) or +R (Replace):
 *     Find (F) and Italic (I) stay, Replace is the Find bar's "+ Replace";
 *     Bold and Link tooltips carry no chord;
 *   - Quick Notes saves on Ctrl+S and on Cmd+S;
 *   - the Home page's shortcut hint names the palette only (Cmd/Ctrl+K);
 *     no help text or doc lists a page chord.
 * Live (Chrome, tests/helpers/live-documents-app.mjs; SKIP without one), as
 * a mocked Linux and a mocked Mac (navigator.platform through CDP):
 *   - each former page chord (Ctrl+Shift+<letter>, Cmd+Shift+<letter> on
 *     the Mac) leaves the Documents page where it is - and the rail's
 *     Calendars entry still switches, so the probe is real;
 *   - Ctrl/Cmd+K opens the command palette outside the editor, and inside
 *     the editor textarea too (inserting no link); Ctrl/Cmd+Shift+F opens
 *     Find in Files; Ctrl/Cmd+F opens the editor's Find; Ctrl/Cmd+B and +R
 *     in the editor change nothing; Ctrl/Cmd+I italicises;
 *   (FloatingDraft.jsx, whose save chord now accepts Cmd+S too, is not
 *   mounted by the app - the rail's Quick Notes is common/DraftSidebar.jsx,
 *   which has no save chord - so that one is a source check only.)
 * Run: node tests/page-switch-shortcuts.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDocumentsApp, createNewDocument, sleep } from './helpers/live-documents-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const done = () => { console.log(`\n${total - failed}/${total} checks passed`); process.exit(failed ? 1 : 0); };

const registry = await import(new URL('../src/shortcuts/registry.js', import.meta.url).href);

/* ---------- 1. the Electron menu ---------- */
console.log('\n--- 1. electron/main.cjs ---');
const main = read('electron/main.cjs');
const pagesStart = main.indexOf("label: 'Pages'");
const pagesEnd = main.indexOf('// Edit Menu', pagesStart);
const pages = main.slice(pagesStart, pagesEnd);
const pageLabels = [...pages.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).filter((l) => l !== 'Pages');
check('the Pages submenu still lists Documents, Calendars, Kanban, Tasks, Workflow Builder, Diagnostics, JQL Search, Tools', pageLabels.join() === 'Documents,Calendars,Kanban,Tasks,Workflow Builder,Diagnostics,JQL Search,Tools', pageLabels.join());
check('...and none of them has an accelerator', !/accelerator\s*:/.test(pages), (pages.match(/accelerator[^\n]*/g) || []).join(' ; '));
check('no CommandOrControl+Shift+<letter> accelerator is left anywhere in the menu', !/CommandOrControl\+Shift\+[A-Z]'/.test(main), (main.match(/CommandOrControl\+Shift\+[A-Z]'/g) || []).join());
check('Settings keeps Cmd/Ctrl+, and Toggle Sidebar keeps Cmd/Ctrl+B (the registry\'s defaults, applied to the menu by accel(id))', /label: 'Settings',\s*\.\.\.accel\('app\.settings'\)/.test(main) && /label: 'Toggle Sidebar',\s*\.\.\.accel\('app\.toggleSidebar'\)/.test(main) && registry.resolveBindings({}, 'other')['app.settings'] === 'Mod+Comma' && registry.resolveBindings({}, 'other')['app.toggleSidebar'] === 'Mod+KeyB');
check('Reload / Force Reload are the plain roles (their default accelerators untouched)', /\{ role: 'reload' \}/.test(main) && /\{ role: 'forceReload' \}/.test(main));

/* ---------- 2. the renderer's chords ---------- */
console.log('\n--- 2. the renderer ---');
const srcFiles = [];
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(e.name)) srcFiles.push(p); } })(path.join(REPO, 'src'));
const shiftChords = [];
for (const f of srcFiles) {
  const src = fs.readFileSync(f, 'utf8');
  // a chord needs a key: a Shift+Ctrl/Meta test without a key/code comparison is not one
  // (e.g. the tab strips leaving Shift/Ctrl+wheel to the browser, src/hooks/useWheelScrollsStrip.js)
  src.split('\n').forEach((line, i) => { if (/shiftKey/.test(line) && /(ctrlKey|metaKey)/.test(line) && /\b(key|code)\b\s*(===|==|\.toLowerCase)|\.(key|code)\s*===/.test(line) && !/^\s*(\/\/|\*)/.test(line)) shiftChords.push(`${path.relative(REPO, f)}:${i + 1}`); });
}
check('no Ctrl/Cmd+Shift+<letter> chord is tested anywhere outside the shortcut registry (src/shortcuts): Find in Files and the canvas redo come from it', shiftChords.every((l) => /^src\/shortcuts\//.test(l)), shiftChords.join(' ; '));
check('no renderer code switches pages on a key chord (no navigate/setCurrentPage next to a key handler)', !srcFiles.some((f) => { const s = fs.readFileSync(f, 'utf8'); return /(ctrlKey|metaKey)[^\n]*\n[^\n]*(setCurrentPage|navigate-to-page|onNavigate\()/.test(s); }));
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('the editor binds no Ctrl/Cmd+K link, +B bold or +R Replace chord', !/e\.key === 'k'/.test(editor) && !/e\.key === 'b'/.test(editor) && !/e\.key === 'r'/.test(editor));
check('...but subscribes to Find and Italic in the registry (editor.find, editor.italic), with Replace, Bold and Insert link registered too (unassigned by default)', /useShortcut\('editor\.find'/.test(editor) && /useShortcut\('editor\.italic'/.test(editor) && /useShortcut\('editor\.replace'/.test(editor) && /useShortcut\('editor\.bold'/.test(editor) && /useShortcut\('editor\.insertLink'/.test(editor));
const defaults = registry.resolveBindings({}, 'other');
check('the registry\'s defaults: Find Mod+F and Italic Mod+I bound; Bold, Insert link, Replace and every Open <page> unassigned', defaults['editor.find'] === 'Mod+KeyF' && defaults['editor.italic'] === 'Mod+KeyI' && defaults['editor.bold'] === null && defaults['editor.insertLink'] === null && defaults['editor.replace'] === null && registry.ACTIONS.filter((a) => a.group === 'pages').every((a) => defaults[a.id] === null), JSON.stringify(defaults));
check('the toolbar tooltips take their chords from the bindings (useShortcutHint), so Bold and Link show none until bound', /bold: boldHint/.test(editor) && /link: linkHint/.test(editor) && /italic: italicHint/.test(editor));
check('the Find bar offers "+ Replace" (how Replace opens without the chord)', /\+ Replace\n/.test(editor) && /onClick=\{\(\) => setShowReplace\(true\)\}/.test(editor));
const draft = read('src/components/FloatingDraft.jsx');
check('Quick Notes saves on Ctrl+S and on Cmd+S', /\(e\.ctrlKey \|\| e\.metaKey\) && \(e\.key === 's' \|\| e\.key === 'S'\)/.test(draft));
const home = read('src/components/HomePage.jsx');
check('the Home page hint names the palette chord only (no page chords, no Shift)', /to open the command palette/.test(home) && !/Shift/.test(home));
const docs = fs.readdirSync(path.join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => read(path.join('docs', f))).concat(read('README.md'));
check('no doc lists a Ctrl/Cmd+Shift page chord (a chord named next to a page on one line)', !docs.some((d) => /(Ctrl|Cmd|⌘)\+?(Shift|⇧)\+?[CDKTWASO]\b[^\n]*\b(Documents|Calendars?|Kanban|Tasks|Workflow Builder|Diagnostics|JQL Search|Tools) page/.test(d)));

/* ---------- 3. live: a mocked Linux and a mocked Mac ---------- */
console.log('\n--- 3. live ---');
const app = await launchDocumentsApp({ port: 5283, profilePrefix: 'page-shortcuts-' });
if (app.skip) { console.log('SKIP: ' + app.skip); done(); }
const ev = (s) => app.evaluate(s);
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function press(key, code, vk, mods) {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(350);
}
const letter = (k) => ({ key: k.toUpperCase(), code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0) });
const onDocuments = () => ev(`!!document.querySelector('.sc-editor-textarea') && !document.querySelector('[data-testid="calendar-connect-state"]')`);
const onCalendars = () => ev(`!!document.querySelector('[data-testid="calendar-connect-state"]')`);
const clickRail = (label) => ev(`(() => { const want = ${JSON.stringify(label)}; const b = Array.from(document.querySelectorAll('button')).find((x) => [x.getAttribute('title'), x.getAttribute('aria-label'), x.textContent.trim()].some((t) => t === want)) || Array.from(document.querySelectorAll('button, [role="button"]')).find((x) => [x.getAttribute('title'), x.getAttribute('aria-label'), x.getAttribute('data-tooltip'), x.textContent].some((t) => t && t.toLowerCase().includes(want.toLowerCase()))); if (!b) return false; b.click(); return true; })()`);
const dismiss = async () => { for (let i = 0; i < 6; i++) { const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^Got it!$/.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; })()`); if (ok) break; await sleep(300); } };
const PAGE_KEYS = ['d', 'c', 'k', 't', 'w', 'a', 's', 'o'];
// a controlled React textarea: the value through the prototype setter, then an input event
const setTa = (sel, text, start, end) => ev(`(() => { const ta = ${sel}; if (!ta) return false; ta.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.setSelectionRange(${start}, ${end}); ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); return true; })()`);
const EDITOR = `document.querySelector('.sc-editor-textarea')`;
try {
  for (const platform of ['Linux', 'Mac']) {
    const mac = platform === 'Mac';
    await app.send('Emulation.setUserAgentOverride', {
      userAgent: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      platform: mac ? 'MacIntel' : 'Linux x86_64',
      userAgentMetadata: { brands: [{ brand: 'Chromium', version: '130' }], fullVersion: '130.0.0.0', platform: mac ? 'macOS' : 'Linux', platformVersion: '14.0.0', architecture: 'x86', model: '', mobile: false },
    });
    await ev(`localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify('light')); location.reload()`);
    await sleep(3500);
    await dismiss();
    const reported = await ev('navigator.platform');
    check(`${platform}: navigator.platform reads ${mac ? 'MacIntel' : 'Linux x86_64'}`, reported === (mac ? 'MacIntel' : 'Linux x86_64'), reported);
    if (!(await ev(`!!document.querySelector('.sc-editor-textarea')`))) { await createNewDocument(app); await sleep(1200); }
    if (!(await ev(`!!document.querySelector('.sc-editor-textarea')`))) { await clickRail('Documents'); await sleep(800); await createNewDocument(app); await sleep(1200); }
    check(`${platform}: the Documents page with an open document`, await onDocuments());
    // the control: the rail still switches pages
    const switched = await clickRail('Calendars'); await sleep(900);
    check(`${platform}: the rail's Calendars entry switches to Calendars (the probe is real)`, switched && await onCalendars());
    await clickRail('Documents'); await sleep(900);
    check(`${platform}: ...and back to Documents`, await onDocuments());
    await ev(`document.activeElement && document.activeElement.blur()`);
    const chord = (mac ? MOD.meta : MOD.ctrl) | MOD.shift;
    const stayed = [];
    for (const k of PAGE_KEYS) { const { key, code, vk } = letter(k); await press(key, code, vk, chord); stayed.push(`${k}:${await onDocuments()}`); }
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+Shift+D/C/K/T/W/A/S/O all leave the Documents page where it is`, stayed.every((s) => s.endsWith(':true')), stayed.join());
    const palette = () => ev(`!!document.querySelector('[role="combobox"][placeholder="Type a command or search..."]')`);
    const mod = mac ? MOD.meta : MOD.ctrl;
    await press('k', 'KeyK', 75, mod);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+K outside the editor opens the command palette`, await palette());
    await press('Escape', 'Escape', 27, 0);
    check(`${platform}: Escape closes it`, !(await palette()));
    // Find in Files
    await press('F', 'KeyF', 70, chord);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+Shift+F opens Find in Files (kept)`, await ev(`!!document.querySelector('[data-find-category]')`));
    await press('Escape', 'Escape', 27, 0); await sleep(300);
    await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /Close/.test(x.getAttribute('title') || '') && x.closest('[data-find-category]') === null); })()`);
    // inside the editor
    await setTa(EDITOR, 'see ', 4, 4);
    await sleep(300);
    await press('k', 'KeyK', 75, mod);
    const afterK = await ev(`({ content: document.querySelector('.sc-editor-textarea').value, palette: !!document.querySelector('[role="combobox"][placeholder="Type a command or search..."]') })`);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+K in the editor textarea inserts no link (the palette opens, as everywhere)`, afterK.content === 'see ' && afterK.palette, JSON.stringify(afterK));
    await press('Escape', 'Escape', 27, 0); await sleep(200);
    await setTa(EDITOR, 'x', 0, 1);
    await sleep(200);
    await press('b', 'KeyB', 66, mod);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+B in the editor changes nothing`, (await ev(`document.querySelector('.sc-editor-textarea').value`)) === 'x');
    const findBar = () => ev(`Array.from(document.querySelectorAll('span')).some((s) => /^Find( & Replace)?$/.test(s.textContent.trim()))`);
    await press('r', 'KeyR', 82, mod);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+R in the editor opens no Find/Replace bar`, !(await findBar()) && (await ev(`document.querySelector('.sc-editor-textarea').value`)) === 'x');
    await press('f', 'KeyF', 70, mod);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+F in the editor opens Find, with "+ Replace"`, (await findBar()) && (await ev(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '+ Replace')`)));
    await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Close (Esc)'); b && b.click(); })()`); await sleep(200);
    await setTa(EDITOR, 'x', 0, 1);
    await sleep(200);
    await press('i', 'KeyI', 73, mod);
    check(`${platform}: ${mac ? 'Cmd' : 'Ctrl'}+I in the editor italicises the selection`, (await ev(`document.querySelector('.sc-editor-textarea').value`)) === '*x*', await ev(`document.querySelector('.sc-editor-textarea').value`));
  }
  check('no page exception during the live run', app.errors.length === 0, app.errors.join(' ; '));
} finally {
  await app.close();
}
done();
