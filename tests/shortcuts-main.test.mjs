#!/usr/bin/env node
/**
 * The main process's side of the keyboard shortcuts (electron/shortcuts.cjs,
 * Electron-free, run here under plain Node against a temp ui-settings.json):
 *   - a missing / corrupt file or another schema version yields no
 *     overrides; writing stores { version, overrides } under "shortcuts"
 *     and keeps the other UI settings (zoom, the debug bar) - the
 *     read-merge-write of ui-settings.cjs;
 *   - validateShortcutOverrides refuses an unknown id, a fixed action, an
 *     OS-reserved chord, a conflict between two overrides and a malformed
 *     map, and accepts a clean map (including explicit nulls);
 *   - menuAccelerators: Settings ⌘,, Toggle Sidebar ⌘B, zoom (with the
 *     hidden Shift+= twin) by default; no Pages until bound; an override
 *     moves one; roles are not listed;
 *   - electron/main.cjs: the menu takes every accelerator from the registry
 *     (no accelerator literal left), get-/set-shortcuts IPC, the broadcast,
 *     the preload bridge; the shell loads the overrides.
 * Run: node tests/shortcuts-main.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const S = req(path.join(REPO, 'electron', 'shortcuts.cjs'));
const { readUiSettings, persistUiSettings } = req(path.join(REPO, 'electron', 'ui-settings.cjs'));
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcuts-main-'));
const file = path.join(dir, 'ui-settings.json');

console.log('\n--- 1. storage ---');
check('no file: no overrides, schema version 1', JSON.stringify(S.readShortcutOverrides(file)) === JSON.stringify({ version: 1, overrides: {} }));
fs.writeFileSync(file, '{ not json');
check('a corrupt file: no overrides, no throw', JSON.stringify(S.readShortcutOverrides(file).overrides) === '{}');
fs.writeFileSync(file, JSON.stringify({ zoomFactor: 1.25, shortcuts: { version: 99, overrides: { 'editor.find': 'Mod+KeyJ' } } }));
check('another schema version is ignored (defaults apply)', JSON.stringify(S.readShortcutOverrides(file).overrides) === '{}');
persistUiSettings(file, { zoomFactor: 1.25, debugBarEnabled: true });
const written = S.writeShortcutOverrides(file, { 'editor.find': 'Mod+KeyJ', 'editor.bold': null, 'nope.x': 'Mod+KeyA', 'app.reload': 'Mod+KeyP' });
const onDisk = readUiSettings(file);
check('writing stores only the valid overrides under "shortcuts" with the version, and keeps zoom and the debug bar', JSON.stringify(written) === JSON.stringify({ 'editor.find': 'Mod+KeyJ', 'editor.bold': null }) && onDisk.zoomFactor === 1.25 && onDisk.debugBarEnabled === true && onDisk.shortcuts.version === 1 && JSON.stringify(onDisk.shortcuts.overrides) === JSON.stringify(written), JSON.stringify(onDisk));
check('reading gives them back', JSON.stringify(S.readShortcutOverrides(file).overrides) === JSON.stringify(written));
S.writeShortcutOverrides(file, {});
check('an empty map (Reset all) clears the overrides and keeps the rest', JSON.stringify(readUiSettings(file).shortcuts.overrides) === '{}' && readUiSettings(file).zoomFactor === 1.25);

console.log('\n--- 2. validation ---');
const v = (o, platform = 'linux') => S.validateShortcutOverrides(o, platform);
check('a clean map is accepted, nulls included', v({ 'editor.find': 'Mod+KeyJ', 'editor.bold': 'Mod+Alt+KeyB', 'editor.italic': null, 'page.calendars': 'Mod+Alt+KeyC' }).ok);
check('an unknown id is refused', !v({ 'nope.x': 'Mod+KeyA' }).ok && v({ 'nope.x': 'Mod+KeyA' }).errors[0].id === 'nope.x');
check('a fixed action is refused', !v({ 'app.reload': 'Mod+KeyP' }).ok);
check('an OS-reserved chord is refused (⌘Q on a Mac, Alt+F4 on Linux)', !v({ 'editor.bold': 'Mod+KeyQ' }, 'darwin').ok && !v({ 'editor.bold': 'Alt+F4' }, 'linux').ok && v({ 'editor.bold': 'Mod+KeyQ' }, 'linux').ok);
check('a browser-reserved chord is fine on the desktop (Ctrl+T)', v({ 'editor.bold': 'Mod+KeyT' }).ok);
check('two overrides on one chord in overlapping scopes are refused; a chord taken by a default too (⌘B Toggle Sidebar)', !v({ 'editor.bold': 'Mod+Alt+KeyB', 'editor.italic': 'Mod+Alt+KeyB' }).ok && !v({ 'editor.bold': 'Mod+KeyB' }).ok && /Toggle sidebar/.test(v({ 'editor.bold': 'Mod+KeyB' }).errors[0].message));
check('...but the same chord freed by an explicit null is accepted (the renderer\'s Replace)', v({ 'editor.bold': 'Mod+KeyB', 'app.toggleSidebar': null }).ok, JSON.stringify(v({ 'editor.bold': 'Mod+KeyB', 'app.toggleSidebar': null }).errors));
check('a malformed map is refused', !v(null).ok && !v([1]).ok && !v('x').ok);

console.log('\n--- 3. the menu accelerators ---');
const acc = S.menuAccelerators({}, 'darwin');
check('defaults: Settings CommandOrControl+,, Toggle Sidebar CommandOrControl+B, zoom 0 / = (+ hidden Shift+= twin) / -', acc['app.settings'].accelerator === 'CommandOrControl+,' && acc['app.toggleSidebar'].accelerator === 'CommandOrControl+B' && acc['app.zoomReset'].accelerator === 'CommandOrControl+0' && acc['app.zoomIn'].accelerator === 'CommandOrControl+=' && acc['app.zoomIn'].aliases.join() === 'CommandOrControl+Shift+=' && acc['app.zoomOut'].accelerator === 'CommandOrControl+-', JSON.stringify(acc));
check('no Pages item has an accelerator by default; roles are not listed', !Object.keys(acc).some((id) => id.startsWith('page.')) && !acc['app.reload'] && !acc['app.fullscreen']);
const acc2 = S.menuAccelerators({ 'page.calendars': 'Mod+Alt+KeyC', 'app.toggleSidebar': null, 'app.settings': 'Mod+Shift+Comma' }, 'linux');
check('an override binds Open Calendars (CommandOrControl+Alt+C), unassigns Toggle Sidebar, moves Settings', acc2['page.calendars'].accelerator === 'CommandOrControl+Alt+C' && !acc2['app.toggleSidebar'] && acc2['app.settings'].accelerator === 'CommandOrControl+Shift+,', JSON.stringify(acc2));

console.log('\n--- 4. main.cjs, preload, the shell ---');
const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
check('main.cjs has no accelerator literal left: every one comes from the registry (accel(id) / aliasItems)', !/accelerator:\s*'/.test(main) && (main.match(/\.\.\.accel\('/g) || []).length === 13 && /aliasItems\('app\.zoomIn'/.test(main), (main.match(/accelerator:\s*'[^']*'/g) || []).join());
check('the Pages items take theirs from page.<id>', ['documents', 'calendars', 'kanban', 'tasks', 'workflow', 'diagnostics', 'search', 'tools'].every((p) => main.includes(`...accel('page.${p}')`)));
check('get-shortcuts / set-shortcuts IPC: validate, persist, rebuild the menu, broadcast shortcuts-changed', /ipcMain\.handle\('get-shortcuts'/.test(main) && /ipcMain\.handle\('set-shortcuts'/.test(main) && /validateShortcutOverrides\(raw, process\.platform\)/.test(main) && /writeShortcutOverrides\(uiSettingsPath\(\)/.test(main) && /createApplicationMenu\(\);\n  for \(const win of BrowserWindow\.getAllWindows\(\)\)/.test(main) && /send\('shortcuts-changed'/.test(main));
check('the overrides are read from ui-settings.json at startup, before the first menu build', main.indexOf('readShortcutOverrides(uiSettingsPath())') < main.indexOf('function createApplicationMenu()'));
const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.cjs'), 'utf8');
check('the preload exposes getShortcuts, setShortcuts and onShortcutsChanged', /getShortcuts: \(\) => ipcRenderer\.invoke\('get-shortcuts'\)/.test(preload) && /setShortcuts: \(overrides\) => ipcRenderer\.invoke\('set-shortcuts', overrides\)/.test(preload) && /onShortcutsChanged/.test(preload) && /ipcRenderer\.on\('shortcuts-changed'/.test(preload));
check('the shell loads this device\'s overrides once (JQLBuilder)', /loadOverrides\(\);/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'JQLBuilder.jsx'), 'utf8')));
const store = fs.readFileSync(path.join(REPO, 'src', 'shortcuts', 'store.js'), 'utf8');
check('the renderer store: desktop through the bridge (getShortcuts / setShortcuts / onShortcutsChanged), browser through localStorage with the schema version; never the settings store', /api\.getShortcuts\(\)/.test(store) && /api\.setShortcuts\(cleaned\)/.test(store) && /onShortcutsChanged/.test(store) && /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(\{ version: SCHEMA_VERSION, overrides: next \}\)\)/.test(store) && !/settingsStore|writeSettings|homeServerFetch/.test(store));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
