#!/usr/bin/env node
/**
 * The keyboard shortcut registry (src/shortcuts/registry.js) and its rules:
 *   - ids unique, every default a valid chord (or null), defaults identical
 *     to the chords the app bound before the registry (Mod+F, Mod+I,
 *     Mod+Shift+F, Mod+K, Mod+Enter, Mod+Z / Mod+Shift+Z (+Ctrl+Y), F /
 *     Shift+1, Tab, Mod+C / Mod+V, Mod+, Mod+B, zoom, reload); Pages,
 *     Bold, Insert link and Replace unassigned; Tab/Shift+Tab and the
 *     roles fixed;
 *   - menu-owned and renderer-owned actions are disjoint, and the menu
 *     items of electron/main.cjs carry no accelerator literal (they take
 *     them from the registry);
 *   - chordFromEvent / matchesChord: by code, Option characters on a Mac,
 *     Shift+Digit1, lone modifiers, NumpadEnter; formatChord on a Mac
 *     (⌃⌥⇧⌘, Apple's order) and elsewhere, with a keyboard layout map;
 *     legacyToChord keeps the old "Mod+B" spelling working; toAccelerator;
 *   - resolve / diff / normalize of overrides (only differences stored,
 *     unknown ids and bad chords dropped);
 *   - validateChord: plain keys, Super, OS-reserved per OS, browser-
 *     reserved in the web build only, fixed roles, conflicts within
 *     overlapping scopes (and menu-wide on the desktop), Linux terminal /
 *     GTK habits as warnings (not for the action's own default);
 *   - the source guard: no hard-coded chord (a ctrlKey/metaKey test next to
 *     a key test) outside src/shortcuts, except the documented idioms;
 *   - electron/shortcuts-registry.cjs is the generated twin, in sync.
 * Run: node tests/shortcuts-registry.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };

const R = await import(new URL('../src/shortcuts/registry.js', import.meta.url).href);
const { ACTIONS, GROUPS, SCOPES, actionById, chordFromEvent, matchesChord, formatChord, legacyToChord, toAccelerator, resolveBindings, diffOverrides, normalizeOverrides, validateChord, isChord, isRebindable, aliasesOf, scopesOverlap } = R;

console.log('\n--- 1. the actions ---');
const ids = ACTIONS.map((a) => a.id);
check('ids are unique and every action has a label, a known group and a known scope', new Set(ids).size === ids.length && ACTIONS.every((a) => a.label && GROUPS.some((g) => g.id === a.group) && a.scope in SCOPES), ids.join());
check('every default (mac and other) is a valid chord or null', ACTIONS.every((a) => ['mac', 'other'].every((p) => a.defaults[p] === null || isChord(a.defaults[p]))), ACTIONS.filter((a) => !['mac', 'other'].every((p) => a.defaults[p] === null || isChord(a.defaults[p]))).map((a) => a.id).join());
check('every alias is a valid chord', ACTIONS.every((a) => !a.aliases || ['mac', 'other'].every((p) => (a.aliases[p] || []).every(isChord))));
const other = resolveBindings({}, 'other'); const mac = resolveBindings({}, 'mac');
const expectOther = { 'app.palette': 'Mod+KeyK', 'app.findInFiles': 'Mod+Shift+KeyF', 'app.settings': 'Mod+Comma', 'app.toggleSidebar': 'Mod+KeyB', 'app.zoomIn': 'Mod+Equal', 'app.zoomOut': 'Mod+Minus', 'app.zoomReset': 'Mod+Digit0', 'app.reload': 'Mod+KeyR', 'app.forceReload': 'Mod+Shift+KeyR', 'app.fullscreen': 'F11', 'editor.find': 'Mod+KeyF', 'editor.italic': 'Mod+KeyI', 'editor.indent': 'Tab', 'editor.outdent': 'Shift+Tab', 'workflow.undo': 'Mod+KeyZ', 'workflow.redo': 'Mod+Shift+KeyZ', 'workflow.fit': 'KeyF', 'workflow.quickAdd': 'Tab', 'workflow.copyNodes': 'Mod+KeyC', 'workflow.pasteNodes': 'Mod+KeyV', 'jql.openInJira': 'Mod+Enter' };
check('the defaults are the chords the app bound before (Linux/Windows column)', Object.entries(expectOther).every(([id, c]) => other[id] === c), JSON.stringify(Object.fromEntries(Object.keys(expectOther).filter((id) => other[id] !== expectOther[id]).map((id) => [id, other[id]]))));
check('...and on a Mac the same, except Full screen (⌃⌘F)', Object.entries(expectOther).every(([id, c]) => mac[id] === (id === 'app.fullscreen' ? 'Mod+Ctrl+KeyF' : c)) && formatChord(mac['app.fullscreen'], { mac: true }) === '⌃⌘F');
check('Pages, Bold, Insert link and Replace are unassigned by default', ACTIONS.filter((a) => a.group === 'pages').length === 8 && ACTIONS.filter((a) => a.group === 'pages').every((a) => other[a.id] === null && mac[a.id] === null) && other['editor.bold'] === null && other['editor.insertLink'] === null && other['editor.replace'] === null);
check('Tab / Shift+Tab in lists and the Reload / Force reload / Full screen roles are fixed; everything else is rebindable', !isRebindable(actionById('editor.indent')) && !isRebindable(actionById('editor.outdent')) && !isRebindable(actionById('app.reload')) && !isRebindable(actionById('app.forceReload')) && !isRebindable(actionById('app.fullscreen')) && ACTIONS.filter((a) => !isRebindable(a)).length === 5);
check('the fixed aliases: Redo also Ctrl+Y off the Mac, Fit also Shift+1, Zoom in also Mod+Shift+=', aliasesOf(actionById('workflow.redo'), 'other').join() === 'Mod+KeyY' && aliasesOf(actionById('workflow.redo'), 'mac').length === 0 && aliasesOf(actionById('workflow.fit'), 'mac').join() === 'Shift+Digit1' && aliasesOf(actionById('app.zoomIn'), 'other').join() === 'Mod+Shift+Equal');
const menuOwned = ACTIONS.filter((a) => a.owner === 'menu').map((a) => a.id);
const rendererOwned = ACTIONS.filter((a) => a.owner === 'renderer').map((a) => a.id);
check('owners: Settings, Toggle sidebar, zoom, the roles and the Pages belong to the menu; the editor, canvas, palette, Find in Files, Open in Jira and the three panel actions to the renderer', menuOwned.length === 16 && rendererOwned.length === 19 && ACTIONS.filter((a) => a.desktopOnly).length === 8 && R.actionsForBuild('web').length === 27 && ACTIONS.filter((a) => a.group === 'panels').every((a) => a.owner === 'renderer' && a.scope === 'global' && R.defaultChord(a, 'mac') === null && R.defaultChord(a, 'other') === null) && menuOwned.includes('app.toggleSidebar') && menuOwned.includes('page.calendars') && rendererOwned.includes('app.palette') && rendererOwned.includes('editor.find'), `${menuOwned.length} / ${rendererOwned.length}`);

console.log('\n--- 2. chords from events ---');
const ev = (o) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: '', code: '', ...o });
check('Command+K on a Mac is Mod+KeyK; Control+K there is Ctrl+KeyK; Control+K elsewhere is Mod+KeyK; the Windows key elsewhere is Meta', chordFromEvent(ev({ metaKey: true, key: 'k', code: 'KeyK' }), 'mac') === 'Mod+KeyK' && chordFromEvent(ev({ ctrlKey: true, key: 'k', code: 'KeyK' }), 'mac') === 'Ctrl+KeyK' && chordFromEvent(ev({ ctrlKey: true, key: 'k', code: 'KeyK' }), 'other') === 'Mod+KeyK' && chordFromEvent(ev({ metaKey: true, key: 'k', code: 'KeyK' }), 'other') === 'Meta+KeyK');
check('Option+1 on a Mac (key "¡") is Mod+Alt+Digit1 by code; Shift+1 (key "!") is Shift+Digit1', chordFromEvent(ev({ metaKey: true, altKey: true, key: '¡', code: 'Digit1' }), 'mac') === 'Mod+Alt+Digit1' && chordFromEvent(ev({ shiftKey: true, key: '!', code: 'Digit1' }), 'other') === 'Shift+Digit1');
check('a lone modifier is no chord; NumpadEnter is Enter; a space is Space; Escape by key', chordFromEvent(ev({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }), 'other') === null && chordFromEvent(ev({ ctrlKey: true, key: 'Enter', code: 'NumpadEnter' }), 'other') === 'Mod+Enter' && chordFromEvent(ev({ key: ' ', code: 'Space' }), 'other') === 'Space' && chordFromEvent(ev({ key: 'Escape', code: 'Escape' }), 'mac') === 'Escape');
check('without KeyboardEvent.code (older browsers, jsdom) the letter falls back to the key', chordFromEvent(ev({ ctrlKey: true, shiftKey: true, key: 'F' }), 'other') === 'Mod+Shift+KeyF');
check('matchesChord is exact: Mod+Shift+F does not match Mod+F', matchesChord(ev({ ctrlKey: true, key: 'f', code: 'KeyF' }), 'Mod+KeyF', 'other') && !matchesChord(ev({ ctrlKey: true, shiftKey: true, key: 'F', code: 'KeyF' }), 'Mod+KeyF', 'other'));

console.log('\n--- 3. labels ---');
check('a Mac shows the symbols in Apple\'s order: ⌃⌥⇧⌘K, ⌘⇧ keeps ⇧ before ⌘, ⇧⇥, ↩, ⌘,', formatChord('Mod+Ctrl+Alt+Shift+KeyK', { mac: true }) === '⌃⌥⇧⌘K' && formatChord('Mod+Shift+KeyF', { mac: true }) === '⇧⌘F' && formatChord('Shift+Tab', { mac: true }) === '⇧⇥' && formatChord('Mod+Enter', { mac: true }) === '⌘↩' && formatChord('Mod+Comma', { mac: true }) === '⌘,', [formatChord('Mod+Ctrl+Alt+Shift+KeyK', { mac: true }), formatChord('Mod+Shift+KeyF', { mac: true })].join());
check('elsewhere: Ctrl+Alt+Shift+K, Ctrl+Shift+F, Shift+Tab, Ctrl+Enter, Ctrl+,, Ctrl+=, F11', formatChord('Mod+Alt+Shift+KeyK', { mac: false }) === 'Ctrl+Alt+Shift+K' && formatChord('Mod+Shift+KeyF', { mac: false }) === 'Ctrl+Shift+F' && formatChord('Shift+Tab', { mac: false }) === 'Shift+Tab' && formatChord('Mod+Enter', { mac: false }) === 'Ctrl+Enter' && formatChord('Mod+Comma', { mac: false }) === 'Ctrl+,' && formatChord('Mod+Equal', { mac: false }) === 'Ctrl+=' && formatChord('F11', { mac: false }) === 'F11');
const azerty = new Map([['KeyA', 'q'], ['KeyQ', 'a'], ['KeyW', 'z'], ['Digit1', '&'], ['Comma', ';']]);
check('with a keyboard layout map the letter follows the layout (AZERTY: KeyQ shows A), digits stay digits', formatChord('Mod+KeyQ', { mac: false, layout: azerty }) === 'Ctrl+A' && formatChord('Mod+Digit1', { mac: false, layout: azerty }) === 'Ctrl+1' && formatChord('Mod+Comma', { mac: false, layout: azerty }) === 'Ctrl+;');
check('legacyToChord keeps the old spelling: Mod+B, Shift+Tab, Mod+Alt+1, Shift+Ctrl+Mod+Alt+K', legacyToChord('Mod+B') === 'Mod+KeyB' && legacyToChord('Shift+Tab') === 'Shift+Tab' && legacyToChord('Mod+Alt+1') === 'Mod+Alt+Digit1' && legacyToChord('Shift+Ctrl+Mod+Alt+K') === 'Mod+Ctrl+Alt+Shift+KeyK');
check('toAccelerator: CommandOrControl+Shift+F, CommandOrControl+,, CommandOrControl+=, Control+CommandOrControl+F, Alt+Return', toAccelerator('Mod+Shift+KeyF') === 'CommandOrControl+Shift+F' && toAccelerator('Mod+Comma') === 'CommandOrControl+,' && toAccelerator('Mod+Equal') === 'CommandOrControl+=' && toAccelerator('Mod+Ctrl+KeyF') === 'CommandOrControl+Control+F' && toAccelerator('Alt+Enter') === 'Alt+Return' && toAccelerator('bogus') === null);
const utils = await import(new URL('../src/utils/shortcuts.js', import.meta.url).href);
check('src/utils/shortcuts.js still formats the old spellings (⌘B / Ctrl+B, ⇧⇥, Ctrl+Alt+1)', utils.formatShortcut('Mod+B', true) === '⌘B' && utils.formatShortcut('Mod+B', false) === 'Ctrl+B' && utils.formatShortcut('Shift+Tab', true) === '⇧⇥' && utils.formatShortcut('Mod+Alt+1', false) === 'Ctrl+Alt+1');

console.log('\n--- 4. overrides ---');
check('an override replaces a default, null unassigns, a fixed action ignores overrides', resolveBindings({ 'editor.find': 'Mod+KeyJ', 'editor.italic': null, 'editor.indent': 'Mod+KeyQ' }, 'other')['editor.find'] === 'Mod+KeyJ' && resolveBindings({ 'editor.italic': null }, 'other')['editor.italic'] === null && resolveBindings({ 'editor.indent': 'Mod+KeyQ' }, 'other')['editor.indent'] === 'Tab');
check('diffOverrides stores only the differences (a default back in place drops out)', JSON.stringify(diffOverrides({ ...other, 'editor.find': 'Mod+KeyJ', 'editor.bold': 'Mod+Alt+KeyB' }, 'other')) === JSON.stringify({ 'editor.find': 'Mod+KeyJ', 'editor.bold': 'Mod+Alt+KeyB' }) && Object.keys(diffOverrides(other, 'other')).length === 0, JSON.stringify(diffOverrides({ ...other, 'editor.find': 'Mod+KeyJ' }, 'other')));
const norm = normalizeOverrides({ 'editor.find': 'Mod+KeyJ', 'editor.bold': null, 'nope.x': 'Mod+KeyA', 'editor.italic': 'Ctrl-I', 'app.reload': 'Mod+KeyP', 7: 'x' });
check('normalizeOverrides moves an override stored under a former id to the current one (panel.quickNotesRight -> panel.quickNotes)', JSON.stringify(normalizeOverrides({ 'panel.quickNotesRight': 'Mod+KeyU' }).overrides) === JSON.stringify({ 'panel.quickNotes': 'Mod+KeyU' }) && normalizeOverrides({ 'panel.quickNotesRight': 'Mod+KeyU' }).dropped.length === 0);
check('normalizeOverrides keeps valid chords and explicit nulls, drops unknown ids, bad chords and fixed actions', JSON.stringify(norm.overrides) === JSON.stringify({ 'editor.find': 'Mod+KeyJ', 'editor.bold': null }) && norm.dropped.sort().join() === '7,app.reload,editor.italic,nope.x', JSON.stringify(norm));

console.log('\n--- 5. validation ---');
const v = (chord, actionId, os, build, bindings = resolveBindings({}, os === 'mac' ? 'mac' : 'other')) => validateChord(chord, { actionId, os, build, bindings });
check('a plain letter is blocked for an editor action, allowed where plain keys are (the canvas), F-keys allowed anywhere', v('KeyB', 'editor.bold', 'linux', 'web').level === 'block' && v('KeyG', 'workflow.fit', 'linux', 'web').ok && v('F9', 'editor.bold', 'linux', 'web').ok, v('KeyB', 'editor.bold', 'linux', 'web').message);
check('the Super / Windows key is blocked', v('Meta+KeyB', 'editor.bold', 'linux', 'desktop').level === 'block' && /Super/.test(v('Meta+KeyB', 'editor.bold', 'linux', 'desktop').message) && /Windows/.test(v('Meta+KeyB', 'editor.bold', 'win', 'desktop').message));
check('OS-reserved: ⌘Q ⌘W ⌘H ⌘M ⌘Tab on a Mac, Alt+F4 / Alt+Tab elsewhere - blocked in both builds; ⌘W is free on Linux', v('Mod+KeyQ', 'editor.bold', 'mac', 'desktop').level === 'block' && v('Mod+KeyW', 'editor.bold', 'mac', 'web').level === 'block' && v('Mod+KeyH', 'editor.bold', 'mac', 'desktop').level === 'block' && v('Alt+F4', 'editor.bold', 'linux', 'desktop').level === 'block' && v('Alt+Tab', 'editor.bold', 'win', 'web').level === 'block' && v('Mod+KeyW', 'editor.bold', 'linux', 'desktop').ok);
check('browser-reserved only in the web build: Ctrl+T/W/N/L, Ctrl+Shift+T/N/W/K/J/I/C, F12 blocked there, allowed on the desktop', ['Mod+KeyT', 'Mod+KeyW', 'Mod+KeyN', 'Mod+KeyL', 'Mod+Shift+KeyT', 'Mod+Shift+KeyK', 'Mod+Shift+KeyI', 'F12'].every((c) => v(c, 'editor.bold', 'linux', 'web').level === 'block' && /browser/.test(v(c, 'editor.bold', 'linux', 'web').message)) && v('Mod+KeyT', 'editor.bold', 'linux', 'desktop').ok && v('Mod+KeyN', 'editor.bold', 'win', 'desktop').ok);
check('a fixed role\'s chord (⌘R reload, ⌘⇧R, F11) is blocked with its name, a fixed alias (Ctrl+Y redo on the canvas) too', /Reload/.test(v('Mod+KeyR', 'editor.bold', 'mac', 'desktop').message) && v('Mod+KeyR', 'editor.bold', 'mac', 'desktop').level === 'block' && v('F11', 'app.palette', 'linux', 'desktop').level === 'block' && v('Mod+KeyY', 'workflow.fit', 'linux', 'web').level === 'block', v('Mod+KeyR', 'editor.bold', 'mac', 'desktop').message);
check('a conflict within overlapping scopes is replaceable: ⌘B for Bold meets Toggle sidebar (menu-wide on the desktop); ⌘F for Find in files meets the editor\'s Find (same page); ⌘I for Find in files meets Italic', v('Mod+KeyB', 'editor.bold', 'mac', 'desktop').level === 'conflict' && v('Mod+KeyB', 'editor.bold', 'mac', 'desktop').conflictId === 'app.toggleSidebar' && v('Mod+KeyF', 'app.findInFiles', 'mac', 'web').conflictId === 'editor.find' && v('Mod+KeyI', 'app.findInFiles', 'linux', 'web').conflictId === 'editor.italic');
check('in a browser ⌘B for Bold is free (no menu there; Toggle sidebar is only the desktop\'s); the canvas\'s ⌘Z does not conflict with an editor binding (disjoint scopes)', v('Mod+KeyB', 'editor.bold', 'mac', 'web').ok && v('Mod+KeyZ', 'editor.bold', 'mac', 'web').ok && scopesOverlap('editor', 'page:documents') && !scopesOverlap('editor', 'workflow-canvas') && scopesOverlap('global', 'editor'));
check('a global action meets everything: ⌘I for the palette conflicts with Italic', v('Mod+KeyI', 'app.palette', 'mac', 'web').conflictId === 'editor.italic');
check('Linux habits warn (allowed): Ctrl+Shift+C "copy in Linux terminals" for Open Calendars; Ctrl+Shift+V paste; not on a Mac or Windows; not for the action\'s own default (Ctrl+Shift+F Find in files)', v('Mod+Shift+KeyC', 'page.calendars', 'linux', 'desktop').level === 'warn' && v('Mod+Shift+KeyC', 'page.calendars', 'linux', 'desktop').ok && /copy in Linux terminals/.test(v('Mod+Shift+KeyC', 'page.calendars', 'linux', 'desktop').message) && v('Mod+Shift+KeyV', 'page.tasks', 'linux', 'desktop').level === 'warn' && v('Mod+Shift+KeyC', 'page.calendars', 'mac', 'desktop').ok && v('Mod+Shift+KeyC', 'page.calendars', 'mac', 'desktop').level === null && v('Mod+Shift+KeyF', 'app.findInFiles', 'linux', 'desktop').level === null, JSON.stringify(v('Mod+Shift+KeyC', 'page.calendars', 'linux', 'desktop')));
check('a fixed action cannot be given a chord; a malformed chord is refused', v('Mod+KeyQ', 'editor.indent', 'linux', 'web').level === 'block' && v('Ctrl-F', 'editor.find', 'linux', 'web').level === 'block' && v('Mod+KeyF', 'nope', 'linux', 'web').level === 'block');

console.log('\n--- 6. the source guard ---');
const srcFiles = [];
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(e.name)) srcFiles.push(p); } })(path.join(REPO, 'src'));
// a hard-coded chord: a modifier test and a key test on one line. Allowed: a
// negative modifier test ("not a chord"), the Ctrl+Enter submit idiom of the
// form dialogs, and FloatingDraft.jsx (not mounted by the app).
const hardCoded = [];
for (const f of srcFiles) {
  const rel = path.relative(REPO, f);
  if (rel.startsWith('src/shortcuts/') || /FloatingDraft\.jsx$/.test(rel)) continue;
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!/(ctrlKey|metaKey)/.test(line) || !/\.(key|code)\b/.test(line)) return;
    if (/!\s*\w+\.(ctrlKey|metaKey)/.test(line) && !/[^!]\b\w+\.(ctrlKey|metaKey)\b(?!\s*\))/.test(line.replace(/!\s*\w+\.(ctrlKey|metaKey)/g, ''))) return;
    if (/key === 'Enter' && \w+\.ctrlKey/.test(line)) return;
    hardCoded.push(`${rel}:${i + 1}`);
  });
}
check('no hard-coded chord outside src/shortcuts (the editor, Documents page, workflow canvas and shell subscribe by action id)', hardCoded.length === 0, hardCoded.join(' ; '));
const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
check('the renderer never registers a menu-owned action as a window handler on the desktop (useShortcut skips owner "menu" there) - the dispatcher says so', /desktop && action\.owner === 'menu'\) continue/.test(fs.readFileSync(path.join(REPO, 'src', 'shortcuts', 'useShortcut.js'), 'utf8')));
check('the workflow help popover and the toolbars take their chords from the bindings', /useShortcutBindings/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'workflow', 'ShortcutsHelp.jsx'), 'utf8')) && /useShortcutHint/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'workflow', 'ExecutionToolbar.jsx'), 'utf8')));

console.log('\n--- 7. the main process twin ---');
const sync = await import(new URL('../scripts/sync-shortcuts-registry.mjs', import.meta.url).href);
const twin = fs.readFileSync(sync.TARGET, 'utf8');
check('electron/shortcuts-registry.cjs is the generated twin of src/shortcuts/registry.js (node scripts/sync-shortcuts-registry.mjs)', twin === sync.generate());
const cjs = req(sync.TARGET);
check('...and exports the same actions and helpers', JSON.stringify(cjs.ACTIONS) === JSON.stringify(ACTIONS) && typeof cjs.validateChord === 'function' && typeof cjs.toAccelerator === 'function' && cjs.formatChord('Mod+KeyB', { mac: true }) === '⌘B');
void main;

console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
