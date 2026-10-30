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
 *     the editor keeping the focus on open (its selection stays painted),
 *     Arrow keys moving the active item (data-active, announced through
 *     the textarea's aria-activedescendant), Enter activating it, Escape
 *     calling onClose, the textarea's attributes clean once the menu goes,
 *     the generic focus-return of a menu that did take the focus; also
 *     opener when the menu goes;
 *   - the actions on a textarea (jsdom has no execCommand: the fallback
 *     path): Copy writes the selection to the clipboard, Cut writes it and
 *     removes it with an `input` event (deleteByCut) the editor sees, Paste
 *     inserts the clipboard's text at the selection with an `input` event
 *     (insertFromPaste), an empty clipboard pastes nothing, a read-only
 *     textarea is left alone by Cut and Paste;
 *   - the editor opens the menu without a selection too, probes the
 *     clipboard when it opens, and shares one read-only expression between
 *     the textarea and the menu.
 *
 * Run: node tests/editor-context-clipboard.test.mjs   (needs jsdom:
 *                                                      npm install --no-save jsdom fake-indexeddb)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, waitFor, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { mod, window } = await setupDocumentsEnv('editor-context-clipboard', { entry: path.join(here, 'helpers', 'editor-context-menu-entry.mjs') });
const { check, summary } = makeChecker();
const { document } = window;
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
const opener = document.createElement('textarea');
document.body.appendChild(opener);
opener.focus();
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
check('the textarea keeps the focus on open (its selection stays painted) and names the menu', document.activeElement === opener && opener.getAttribute('aria-controls') === menu.id && !opener.getAttribute('aria-activedescendant'), document.activeElement && document.activeElement.outerHTML.slice(0, 80));
const key = (k) => { const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(ev); return ev.defaultPrevented; };
const activeItem = () => q('[data-testid="editor-context-menu"] [data-active="true"]');
check('ArrowDown (consumed) makes the first enabled item - Paste, the only one - the active item, named on the textarea', key('ArrowDown') && activeItem() === q('[data-testid="selection-paste"]') && opener.getAttribute('aria-activedescendant') === q('[data-testid="selection-paste"]').id && document.activeElement === opener);
key('ArrowDown');
check('ArrowDown wraps among the enabled items (Paste stays active)', activeItem() === q('[data-testid="selection-paste"]'));
key('ArrowUp'); key('End'); key('Home');
check('ArrowUp / End / Home on the one-item menu stay on Paste', activeItem() === q('[data-testid="selection-paste"]') && opener.getAttribute('aria-activedescendant') === q('[data-testid="selection-paste"]').id);
q('[data-testid="selection-paste"]').click();
check('clicking Paste calls onPaste', calls.paste === 1);
key('Enter');
check('Enter activates the active item (Paste again)', calls.paste === 2);
key('Escape');
check('Escape calls onClose', closed === 1);

mod.renderMenu({ visible: false });
await sleep(10);
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: 'some text', editable: true, clipboard: 'empty', mac: false, onClose: () => { closed += 1; }, onCut: () => { calls.cut += 1; }, onCopy: () => { calls.copy += 1; }, onPaste: () => { calls.paste += 1; }, onAskAI: () => { calls.ai += 1; }, onAddAsContext: () => {}, engineTemplates: [{ id: 'g', name: 'Engine', category: 'Web' }] });
await waitFor(() => q('[data-testid="selection-ask-ai"]'));
items = qa('[data-testid="editor-context-menu"] [role="menuitem"]');
check('with a selection: the clipboard items, a separator, then Ask AI, Add as AI Context, Search In', items.map((b) => b.getAttribute('data-testid')).join(',') === 'selection-cut,selection-copy,selection-paste,selection-ask-ai,selection-add-context,selection-search-in' && !!q('[data-testid="editor-context-menu"] [role="separator"]'));
check('Cut and Copy are enabled, Paste disabled (clipboard empty), Ctrl labels elsewhere', !q('[data-testid="selection-cut"]').disabled && !q('[data-testid="selection-copy"]').disabled && q('[data-testid="selection-paste"]').disabled && q('[data-testid="selection-cut"]').getAttribute('aria-keyshortcuts') === 'Ctrl+X');
check('no item is active on open, the textarea still focused', !activeItem() && document.activeElement === opener);
key('ArrowDown');
check('ArrowDown makes the first enabled item (Cut) active', activeItem() === q('[data-testid="selection-cut"]'));
key('ArrowDown'); key('ArrowDown');
check('ArrowDown twice more skips the disabled Paste and lands on Ask AI', activeItem() === q('[data-testid="selection-ask-ai"]'), activeItem() && activeItem().getAttribute('data-testid'));
key('End');
check('End goes to the last item (Search In)', activeItem() === q('[data-testid="selection-search-in"]'));
key('ArrowRight');
await sleep(10);
check('ArrowRight on Search In opens its submenu (the key is handed to the item); its entries join the list', q('[data-testid="selection-search-in"]').getAttribute('aria-expanded') === 'true' && qa('[data-testid="editor-context-menu"] [role="menuitem"]').length > items.length);
key('ArrowLeft');
await sleep(10);
check('ArrowLeft closes it again', q('[data-testid="selection-search-in"]').getAttribute('aria-expanded') === 'false');
key('ArrowDown');
check('ArrowDown from the last wraps to the first (Cut)', activeItem() === q('[data-testid="selection-cut"]'));
key('ArrowUp');
check('ArrowUp from the first wraps to the last', activeItem() === q('[data-testid="selection-search-in"]'));
key('Home');
check('Home goes to the first (Cut)', activeItem() === q('[data-testid="selection-cut"]'));
key('Enter');
check('Enter on Cut calls onCut', calls.cut === 1);
q('[data-testid="selection-copy"]').click();
check('clicking Copy calls onCopy', calls.copy === 1);
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
key('ArrowDown');
check('...the keys find nothing to activate (no enabled item), the textarea keeps the focus', !activeItem() && document.activeElement === opener);
key('Escape');
check('...and Escape closes it', roClosed === 1);
mod.renderMenu({ visible: false });
await sleep(10);
opener.focus();
opener.value = 'alpha bravo';
opener.setSelectionRange(6, 11);
mod.renderMenu({ visible: true, x: 10, y: 10, selectedText: 'bravo', editable: true, clipboard: 'text', onCut: () => {}, onCopy: () => {}, onPaste: () => {}, onAskAI: () => {}, onClose: () => {} });
await sleep(20);
check('the textarea keeps the focus and its selection while the menu is open', document.activeElement === opener && opener.selectionStart === 6 && opener.selectionEnd === 11 && !!opener.getAttribute('aria-controls'));
key('ArrowDown');
check('an arrow key reaches the menu, not the textarea (consumed; the selection untouched)', activeItem() === q('[data-testid="selection-cut"]') && opener.selectionStart === 6 && opener.selectionEnd === 11);
mod.renderMenu({ visible: false });
await sleep(20);
check('when the menu goes, the textarea still has the focus and its selection, and the menu attributes are gone', document.activeElement === opener && opener.selectionStart === 6 && opener.selectionEnd === 11 && !opener.getAttribute('aria-controls') && !opener.getAttribute('aria-activedescendant'), document.activeElement && document.activeElement.tagName);
// the generic menu (no keepFocus) still takes the focus and gives it back
const button = document.createElement('button');
document.body.appendChild(button);
button.focus();
mod.renderGenericMenu({ visible: true, x: 10, y: 10, onClose: () => {} });
await sleep(20);
check('a menu without keepFocus takes the focus (its first enabled item)', document.activeElement !== button && q('[data-testid="generic-menu"]').contains(document.activeElement), document.activeElement && document.activeElement.tagName);
mod.renderGenericMenu({ visible: false });
await sleep(20);
check('...and gives it back when it goes', document.activeElement === button, document.activeElement && document.activeElement.tagName);

// ---- the actions on a textarea (jsdom: the fallback path, no execCommand) ----
const ta = document.createElement('textarea');
document.body.appendChild(ta);
let clip = '';
const nav = { clipboard: { readText: async () => clip, writeText: async (t) => { clip = t; } } };
const events = [];
ta.addEventListener('input', (e) => events.push(e.inputType || 'input'));
ta.value = 'hello brave world';
check('Copy writes the selection to the clipboard and leaves the text', (await copySelection(ta, { start: 6, end: 11, nav })) === true && clip === 'brave' && ta.value === 'hello brave world');
check('Copy with nothing selected copies nothing', (await copySelection(ta, { start: 3, end: 3, nav })) === false);
clip = '';
check('Cut writes the selection, removes it, and the editor sees an input event (deleteByCut) with the caret at the cut', (await cutSelection(ta, { start: 6, end: 12, nav })) === true && clip === 'brave ' && ta.value === 'hello world' && events.includes('deleteByCut') && ta.selectionStart === 6);
clip = 'new ';
check('Paste inserts the clipboard text at the selection with an input event (insertFromPaste), caret after it', (await pasteInto(ta, { start: 6, end: 6, nav })) === 'new ' && ta.value === 'hello new world' && events.includes('insertFromPaste') && ta.selectionStart === 10);
clip = 'X';
check('Paste over a selection replaces it', (await pasteInto(ta, { start: 0, end: 5, nav })) === 'X' && ta.value === 'X new world');
clip = '';
check('an empty clipboard pastes nothing and changes nothing', (await pasteInto(ta, { start: 0, end: 0, nav })) === '' && ta.value === 'X new world');
check('a refused clipboard read pastes nothing', (await pasteInto(ta, { start: 0, end: 0, nav: { clipboard: { readText: async () => { throw new Error('denied'); } } } })) === '' && ta.value === 'X new world');
ta.readOnly = true;
clip = 'zzz';
check('a read-only textarea: Cut and Paste do nothing, Copy still copies', (await cutSelection(ta, { start: 0, end: 1, nav })) === false && (await pasteInto(ta, { start: 0, end: 0, nav })) === '' && ta.value === 'X new world' && (await copySelection(ta, { start: 0, end: 1, nav })) === true && clip === 'X');

// ---- the editor's wiring, statically ----
const editor = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
const handler = editor.slice(editor.indexOf('const handleTextSelectionContextMenu = (e) => {'), editor.indexOf('const handleSelectionCut'));
check('the editor opens the menu with or without a selection (preventDefault unconditionally) and probes the clipboard as it opens', /e\.preventDefault\(\);\n\s+const start = textarea\.selectionStart;/.test(handler) && /readClipboardState\(\)\.then/.test(handler) && !/if \(selectedText && selectedText\.trim\(\)\) \{\s*e\.preventDefault/.test(handler));
check('the textarea and the menu share one read-only expression (editorReadOnly)', /const editorReadOnly = locked \|\| !isOwner/.test(editor) && /readOnly=\{editorReadOnly\}/.test(editor) && /editable=\{!editorReadOnly\}/.test(editor));
check('the menu gets the clipboard state and the three handlers', /clipboard=\{selectionMenu\.clipboard\}/.test(editor) && /onCut=\{handleSelectionCut\}/.test(editor) && /onCopy=\{handleSelectionCopy\}/.test(editor) && /onPaste=\{handleSelectionPaste\}/.test(editor));
check('the handlers act on the selection the menu was opened on, through the shared helpers', /cutSelection\(textareaRef\.current, \{ start, end \}\)/.test(editor) && /copySelection\(textareaRef\.current, \{ start, end \}\)/.test(editor) && /pasteInto\(textareaRef\.current, \{ start, end \}\)/.test(editor));
const icons = fs.readFileSync(path.join(REPO, 'src', 'components', 'common', 'menus', 'menuIcons.js'), 'utf8');
check('the clipboard items have shared icons (cut, copy, paste in MENU_ICONS)', /cut: Scissors,/.test(icons) && /copy: Copy,/.test(icons) && /paste: ClipboardPaste,/.test(icons));

mod.unmountMenu();
summary();
