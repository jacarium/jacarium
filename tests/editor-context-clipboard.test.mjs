/**
 * Cut / Copy / Paste in the Documents editor's right-click menu, statically
 * and in jsdom (the real TextSelectionMenu on the shared ContextMenu, the
 * real src/utils/editorClipboard.js):
 *
 *   - the enable logic (clipboardMenuState): Copy with a selection only;
 *     Cut with a selection in an editable editor; Paste in an editable
 *     editor unless the clipboard is known empty - 'unknown' keeps it on;
 *   - the shortcut labels: ⌘X / ⌘C / ⌘V on a Mac, Ctrl+X / C / V elsewhere;
 *   - the clipboard probe: text -> 'text', '' -> 'empty', a refusal or a
 *     missing API -> 'unknown';
 *   - the menu: always the three clipboard items (with or without a
 *     selection) with role menuitem, aria-disabled and aria-keyshortcuts;
 *     the AI and Search items after a separator only with a selection;
 *     the first enabled item takes the focus on open, Arrow keys / Home /
 *     End move it (skipping disabled items, wrapping), Enter activates it,
 *     Escape calls onClose, and the editor gets the focus back - with its
 *     selection intact (CodeMirror draws the selection from its state, so
 *     it stays painted while the menu has the focus);
 *   - the actions on the editor surface (jsdom has no execCommand: the
 *     surface's own insertText does the edit): Copy writes the selection to
 *     the clipboard, Cut writes it and removes it as a typed change the
 *     editor's onChange sees, Paste inserts the clipboard's text at the
 *     selection the same way, an empty clipboard pastes nothing, a
 *     read-only editor is left alone by Cut and Paste;
 *   - the editor opens the menu without a selection too, probes the
 *     clipboard when it opens, and shares one read-only expression between
 *     the surface and the menu.
 *
 * Run: node tests/editor-context-clipboard.test.mjs   (needs jsdom:
 *                                                      npm install --no-save jsdom fake-indexeddb)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, waitFor, sleep } from './helpers/jsdom-documents-env.mjs';
import { installEditorSurfaceInJsdom } from './helpers/editor-surface.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { mod, window } = await setupDocumentsEnv('editor-context-clipboard', { entry: path.join(here, 'helpers', 'editor-context-menu-entry.mjs') });
const { check, summary } = makeChecker();
const { document } = window;
installEditorSurfaceInJsdom(window);   // what CodeMirror needs of jsdom
const { clipboardMenuState, clipboardShortcuts, readClipboardState, copySelection, cutSelection, pasteInto } = mod.editorClipboard;

// ---- the enable logic ----
const S = clipboardMenuState;
check('no selection, editable, clipboard unknown: Paste only', JSON.stringify(S({ hasSelection: false, editable: true, clipboard: 'unknown' })) === '{"copy":false,"cut":false,"paste":true}');
check('a selection, editable, clipboard unknown: all three', JSON.stringify(S({ hasSelection: true, editable: true, clipboard: 'unknown' })) === '{"copy":true,"cut":true,"paste":true}');
check('a selection, read-only: Copy only (no Cut, no Paste)', JSON.stringify(S({ hasSelection: true, editable: false, clipboard: 'text' })) === '{"copy":true,"cut":false,"paste":false}');
check('no selection, editable, clipboard empty: nothing', JSON.stringify(S({ hasSelection: false, editable: true, clipboard: 'empty' })) === '{"copy":false,"cut":false,"paste":false}');
check('a selection, editable, clipboard with text: all three', JSON.stringify(S({ hasSelection: true, editable: true, clipboard: 'text' })) === '{"copy":true,"cut":true,"paste":true}');
check('defaults: nothing selected, editable, unknown clipboard -> Paste only', JSON.stringify(S()) === '{"copy":false,"cut":false,"paste":true}');

// ---- the shortcut labels ----
check('Mac labels are ⌘X / ⌘C / ⌘V', JSON.stringify(clipboardShortcuts(true)) === '{"cut":"⌘X","copy":"⌘C","paste":"⌘V"}', JSON.stringify(clipboardShortcuts(true)));
check('other platforms: Ctrl+X / Ctrl+C / Ctrl+V', JSON.stringify(clipboardShortcuts(false)) === '{"cut":"Ctrl+X","copy":"Ctrl+C","paste":"Ctrl+V"}', JSON.stringify(clipboardShortcuts(false)));

// ---- the clipboard probe ----
const navWith = (readText) => ({ clipboard: { readText } });
check("text on the clipboard -> 'text'", (await readClipboardState(navWith(async () => 'hello'))) === 'text');
check("nothing on the clipboard -> 'empty'", (await readClipboardState(navWith(async () => ''))) === 'empty');
check("a refused read -> 'unknown' (Paste stays on)", (await readClipboardState(navWith(async () => { throw new window.DOMException('denied', 'NotAllowedError'); }))) === 'unknown');
check("no Clipboard API -> 'unknown'", (await readClipboardState({})) === 'unknown' && (await readClipboardState(null)) === 'unknown');

// ---- the menu in jsdom ----
const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
// the opener: the real editor surface, with a selection
const host = document.createElement('div');
document.body.appendChild(host);
const opener = new mod.CodeMirrorSurface({ parent: host, doc: 'alpha bravo', handlers: {} });
opener.focus();
opener.setSelectionRange(6, 11);
let closed = 0;
const calls = { cut: 0, copy: 0, paste: 0, ai: 0 };
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: '', editable: true, clipboard: 'unknown', mac: true, onClose: () => { closed += 1; }, onCut: () => { calls.cut += 1; }, onCopy: () => { calls.copy += 1; }, onPaste: () => { calls.paste += 1; }, onAskAI: () => { calls.ai += 1; }, onAddAsContext: () => {}, engineTemplates: [{ id: 'g', name: 'Engine', category: 'Web' }] });
await waitFor(() => q('[data-testid="editor-context-menu"]'));
const menu = q('[data-testid="editor-context-menu"]');
check('the menu is a role=menu with an accessible name', menu.getAttribute('role') === 'menu' && menu.getAttribute('aria-label') === 'Editor');
let items = qa('[data-testid="editor-context-menu"] [role="menuitem"]');
check('without a selection: Paste only - no Cut, no Copy, no AI, no Search, no separator', items.map((b) => b.textContent.trim().replace(/⌘./, '').trim()).join(',') === 'Paste' && !q('[data-testid="selection-cut"]') && !q('[data-testid="selection-copy"]') && !q('[data-testid="selection-ask-ai"]') && !q('[data-testid="editor-context-menu"] [role="separator"]'), items.map((b) => b.textContent.trim()).join(','));
check('Paste is enabled (clipboard unknown), not announced as disabled', !q('[data-testid="selection-paste"]').disabled && q('[data-testid="selection-paste"]').getAttribute('aria-disabled') === null);
check('the shortcut is shown and announced (⌘V on a Mac)', q('[data-testid="selection-paste"]').getAttribute('aria-keyshortcuts') === '⌘V' && /⌘V/.test(q('[data-testid="selection-paste"]').textContent));
check('the first enabled item (Paste) takes the focus on open; the editor keeps its selection', document.activeElement === q('[data-testid="selection-paste"]') && opener.selectionStart === 6 && opener.selectionEnd === 11, document.activeElement && document.activeElement.outerHTML.slice(0, 80));
const key = (k) => { const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(ev); return ev.defaultPrevented; };
const focused = () => document.activeElement;
key('ArrowDown');
check('ArrowDown wraps among the enabled items (Paste stays focused)', focused() === q('[data-testid="selection-paste"]'));
key('ArrowUp'); key('End'); key('Home');
check('ArrowUp / End / Home on the one-item menu stay on Paste', focused() === q('[data-testid="selection-paste"]'));
q('[data-testid="selection-paste"]').click();
check('clicking Paste calls onPaste', calls.paste === 1);
key('Escape');
check('Escape calls onClose', closed === 1);

mod.renderMenu({ visible: false });
await sleep(10);
check('when the menu goes, the editor has the focus and its selection again', document.activeElement === opener.contentDOM && opener.selectionStart === 6 && opener.selectionEnd === 11, document.activeElement && document.activeElement.className);
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: 'some text', editable: true, clipboard: 'empty', mac: false, onClose: () => { closed += 1; }, onCut: () => { calls.cut += 1; }, onCopy: () => { calls.copy += 1; }, onPaste: () => { calls.paste += 1; }, onAskAI: () => { calls.ai += 1; }, onAddAsContext: () => {}, engineTemplates: [{ id: 'g', name: 'Engine', category: 'Web' }] });
await waitFor(() => q('[data-testid="selection-ask-ai"]'));
items = qa('[data-testid="editor-context-menu"] [role="menuitem"]');
check('with a selection: the clipboard items, a separator, then Ask AI, Add as AI Context, Search In', items.map((b) => b.getAttribute('data-testid')).join(',') === 'selection-cut,selection-copy,selection-paste,selection-ask-ai,selection-add-context,selection-search-in' && !!q('[data-testid="editor-context-menu"] [role="separator"]'));
check('Cut and Copy are enabled, Paste disabled (clipboard empty), Ctrl labels elsewhere', !q('[data-testid="selection-cut"]').disabled && !q('[data-testid="selection-copy"]').disabled && q('[data-testid="selection-paste"]').disabled && q('[data-testid="selection-cut"]').getAttribute('aria-keyshortcuts') === 'Ctrl+X');
check('the first enabled item (Cut) has the focus on open', focused() === q('[data-testid="selection-cut"]'));
key('ArrowDown'); key('ArrowDown');
check('ArrowDown twice skips the disabled Paste and lands on Ask AI', focused() === q('[data-testid="selection-ask-ai"]'), focused() && focused().getAttribute('data-testid'));
key('End');
check('End goes to the last item (Search In)', focused() === q('[data-testid="selection-search-in"]'));
key('ArrowRight');
await sleep(10);
check('ArrowRight on Search In opens its submenu; its entries join the list', q('[data-testid="selection-search-in"]').getAttribute('aria-expanded') === 'true' && qa('[data-testid="editor-context-menu"] [role="menuitem"]').length > items.length);
key('ArrowLeft');
await sleep(10);
check('ArrowLeft closes it again', q('[data-testid="selection-search-in"]').getAttribute('aria-expanded') === 'false');
key('ArrowDown');
check('ArrowDown from the last wraps to the first (Cut)', focused() === q('[data-testid="selection-cut"]'));
key('ArrowUp');
check('ArrowUp from the first wraps to the last', focused() === q('[data-testid="selection-search-in"]'));
key('Home');
check('Home goes to the first (Cut)', focused() === q('[data-testid="selection-cut"]'));
q('[data-testid="selection-cut"]').click();
check('clicking Cut calls onCut', calls.cut === 1);
q('[data-testid="selection-copy"]').click();
check('clicking Copy calls onCopy', calls.copy === 1);
check('the editor\'s selection is untouched by all that', opener.selectionStart === 6 && opener.selectionEnd === 11);
mod.renderMenu({ visible: false });
await sleep(10);
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: 'some text', editable: false, clipboard: 'text', onCut: () => {}, onCopy: () => {}, onPaste: () => {}, onAskAI: () => {}, onClose: () => {} });
await sleep(20);
check('read-only editor with a selection: Copy on, Cut shown but off, Paste off', !q('[data-testid="selection-copy"]').disabled && q('[data-testid="selection-cut"]').disabled && q('[data-testid="selection-paste"]').disabled);
mod.renderMenu({ visible: false });
await sleep(10);
let roClosed = 0;
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: '', editable: false, clipboard: 'text', onCut: () => {}, onCopy: () => {}, onPaste: () => {}, onAskAI: () => {}, onClose: () => { roClosed += 1; } });
await sleep(20);
check('read-only editor without a selection: the menu still opens, with its one disabled Paste', qa('[data-testid="editor-context-menu"] [role="menuitem"]').length === 1 && q('[data-testid="selection-paste"]').disabled && !q('[data-testid="selection-cut"]') && !q('[data-testid="selection-copy"]'));
check('...with no enabled item the menu itself takes the focus, so the keys still reach it', focused() === q('[data-testid="editor-context-menu"]'));
key('Escape');
check('...and Escape closes it', roClosed === 1);
mod.renderMenu({ visible: false });
await sleep(10);

// the generic menu behaves the same (it is the same component)
const button = document.createElement('button');
document.body.appendChild(button);
button.focus();
mod.renderGenericMenu({ visible: true, x: 10, y: 10, onClose: () => {} });
await sleep(20);
check('a menu takes the focus (its first enabled item)', document.activeElement !== button && q('[data-testid="generic-menu"]').contains(document.activeElement), document.activeElement && document.activeElement.tagName);
mod.renderGenericMenu({ visible: false });
await sleep(20);
check('...and gives it back when it goes', document.activeElement === button, document.activeElement && document.activeElement.tagName);

// ---- the actions on the editor surface (jsdom: no execCommand, the surface's insertText) ----
const changes = [];
const host2 = document.createElement('div');
document.body.appendChild(host2);
const ta = new mod.CodeMirrorSurface({ parent: host2, doc: 'hello brave world', handlers: { onChange: (e) => changes.push(e.target.value) } });
let clip = '';
const nav = { clipboard: { readText: async () => clip, writeText: async (t) => { clip = t; } } };
check('Copy writes the selection to the clipboard and leaves the text', (await copySelection(ta, { start: 6, end: 11, nav })) === true && clip === 'brave' && ta.value === 'hello brave world');
check('Copy with nothing selected copies nothing', (await copySelection(ta, { start: 3, end: 3, nav })) === false);
clip = '';
check('Cut writes the selection, removes it as a change the editor sees, the caret at the cut', (await cutSelection(ta, { start: 6, end: 12, nav })) === true && clip === 'brave ' && ta.value === 'hello world' && changes.includes('hello world') && ta.selectionStart === 6, JSON.stringify({ value: ta.value, changes }));
clip = 'new ';
check('Paste inserts the clipboard text at the selection as a change, caret after it', (await pasteInto(ta, { start: 6, end: 6, nav })) === 'new ' && ta.value === 'hello new world' && changes.includes('hello new world') && ta.selectionStart === 10, JSON.stringify({ value: ta.value, caret: ta.selectionStart }));
clip = 'X';
check('Paste over a selection replaces it', (await pasteInto(ta, { start: 0, end: 5, nav })) === 'X' && ta.value === 'X new world');
clip = '';
check('an empty clipboard pastes nothing and changes nothing', (await pasteInto(ta, { start: 0, end: 0, nav })) === '' && ta.value === 'X new world');
check('a refused clipboard read pastes nothing', (await pasteInto(ta, { start: 0, end: 0, nav: { clipboard: { readText: async () => { throw new Error('denied'); } } } })) === '' && ta.value === 'X new world');
ta.readOnly = true;
clip = 'zzz';
check('a read-only editor: Cut and Paste do nothing, Copy still copies', (await cutSelection(ta, { start: 0, end: 1, nav })) === false && (await pasteInto(ta, { start: 0, end: 0, nav })) === '' && ta.value === 'X new world' && (await copySelection(ta, { start: 0, end: 1, nav })) === true && clip === 'X');
ta.readOnly = false;
ta.undo();
check('Cmd/Ctrl+Z undoes the last paste like typing (the surface\'s history)', ta.value === 'hello new world', JSON.stringify(ta.value));
opener.destroy(); ta.destroy();

// ---- the editor's wiring, statically ----
const editor = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
const handler = editor.slice(editor.indexOf('const handleTextSelectionContextMenu = (e) => {'), editor.indexOf('const handleSelectionCut'));
check('the editor opens the menu with or without a selection (the browser\'s own menu only on Shift+right-click, the desktop app lets the click through for its spelling report) and probes the clipboard as it opens', /if \(typeof window\.electronAPI\?\.onEditorContextMenu !== 'function'\) e\.preventDefault\(\);\n\s+const start = textarea\.selectionStart;/.test(handler) && /readClipboardState\(\)\.then/.test(handler) && !/if \(selectedText && selectedText\.trim\(\)\) \{\s*e\.preventDefault/.test(handler));
check('the surface and the menu share one read-only expression (editorReadOnly)', /const editorReadOnly = locked \|\| !isOwner/.test(editor) && /readOnly=\{editorReadOnly\}/.test(editor) && /editable=\{!editorReadOnly\}/.test(editor));
check('the menu gets the clipboard state and the three handlers', /clipboard=\{selectionMenu\.clipboard\}/.test(editor) && /onCut=\{handleSelectionCut\}/.test(editor) && /onCopy=\{handleSelectionCopy\}/.test(editor) && /onPaste=\{handleSelectionPaste\}/.test(editor));
check('the handlers act on the selection the menu was opened on, through the shared helpers', /cutSelection\(textareaRef\.current, \{ start, end \}\)/.test(editor) && /copySelection\(textareaRef\.current, \{ start, end \}\)/.test(editor) && /pasteInto\(textareaRef\.current, \{ start, end \}\)/.test(editor));
const icons = fs.readFileSync(path.join(REPO, 'src', 'components', 'common', 'menus', 'menuIcons.js'), 'utf8');
check('the clipboard items have shared icons (cut, copy, paste in MENU_ICONS)', /cut: Scissors,/.test(icons) && /copy: Copy,/.test(icons) && /paste: ClipboardPaste,/.test(icons));

mod.unmountMenu();
summary();
