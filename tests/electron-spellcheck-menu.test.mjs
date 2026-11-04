/**
 * The spelling items of the editor's right-click menu, main-process side
 * (electron/spellcheck.cjs: the context-menu forwarding and the IPC behind
 * "Add to dictionary" and Settings > Editor), with the preload
 * bridge and the main.cjs wiring.
 *
 * THE RULES: the renderer only ever receives the word Chromium flagged
 * under the pointer and at most six suggestions, each at most 64
 * characters, from an editable field; "Add to dictionary" is honoured only
 * for the word the last menu of that webContents was about; a custom word
 * can only be removed when it is in the custom dictionary; the languages
 * can only be set to shipped ones (and not at all on macOS, where the
 * system checker chooses).
 *
 * What this test proves (plain Node, the real module, fake webContents /
 * ipcMain / session):
 *   - isWord: 1..64 characters, no control characters, no surrounding space;
 *   - sanitizeMenuParams: null outside an editable field or without a
 *     flagged word; the word, the suggestions capped at six, deduplicated,
 *     the word itself and invalid entries dropped, the position rounded;
 *   - watchContextMenu: forwards the sanitized report over the channel and
 *     remembers the word per webContents (null when nothing was flagged);
 *   - spellcheck:add-word takes only that word (not another, not a long
 *     one, not from a webContents without a menu); spellcheck:remove-word
 *     only a listed word; spellcheck:list-words sorted and filtered;
 *     spellcheck:languages reports native on macOS and the shipped
 *     choices on Windows / Linux; spellcheck:set-languages accepts shipped
 *     codes only, at least one, never on macOS;
 *   - preload.cjs exposes onEditorContextMenu and the spellcheck calls on
 *     the right channels, nothing wider (no raw ipcRenderer);
 *   - main.cjs watches every window's webContents and installs the IPC;
 *   - the renderer lets the desktop app see the click (no preventDefault
 *     when the bridge exists), replaces through replaceRange, and the menu
 *     lists the suggestions before "Add to dictionary".
 *
 * Run: node tests/electron-spellcheck-menu.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');
const spellcheck = require(path.join(REPO, 'electron', 'spellcheck.cjs'));
const manifest = JSON.parse(read('electron/spellcheck-dictionaries.json'));

// ---------------------------------------------------------------- isWord / sanitizeMenuParams
check('isWord: ordinary words, up to 64 characters', spellcheck.isWord('sentense') && spellcheck.isWord('x'.repeat(64)) && spellcheck.isWord("don't") && spellcheck.isWord('Łódź'));
check('isWord refuses empty, over-long, control characters, surrounding space, non-strings', !spellcheck.isWord('') && !spellcheck.isWord('x'.repeat(65)) && !spellcheck.isWord('a\nb') && !spellcheck.isWord(' a') && !spellcheck.isWord(42) && !spellcheck.isWord(null));
check('MAX_WORD_LENGTH 64, MAX_SUGGESTIONS 6', spellcheck.MAX_WORD_LENGTH === 64 && spellcheck.MAX_SUGGESTIONS === 6);
check('sanitizeMenuParams: null outside an editable field, or with no flagged word', spellcheck.sanitizeMenuParams({ isEditable: false, misspelledWord: 'x', dictionarySuggestions: ['y'] }) === null && spellcheck.sanitizeMenuParams({ isEditable: true, misspelledWord: '', dictionarySuggestions: [] }) === null && spellcheck.sanitizeMenuParams(null) === null);
const safe = spellcheck.sanitizeMenuParams({ isEditable: true, misspelledWord: 'sentense', dictionarySuggestions: ['sentence', 'sentence', 'sentense', 'x'.repeat(65), '', 42, 'sen tense', 'sen-tense', 'intense', 'tenseness', 'seventh', 'eighth'], x: 12.6, y: 30.2 });
check('the word, six valid deduplicated suggestions (not the word itself), the rounded position', JSON.stringify(safe) === JSON.stringify({ misspelledWord: 'sentense', suggestions: ['sentence', 'sen tense', 'sen-tense', 'intense', 'tenseness', 'seventh'], x: 13, y: 30 }), JSON.stringify(safe));
check('a long flagged word is not reported', spellcheck.sanitizeMenuParams({ isEditable: true, misspelledWord: 'x'.repeat(65), dictionarySuggestions: [] }) === null);

// ---------------------------------------------------------------- watchContextMenu + the IPC
function fakeWebContents() {
  const handlers = {};
  return { sent: [], on(event, fn) { handlers[event] = fn; }, emit(event, ...args) { handlers[event]?.(...args); }, send(channel, payload) { this.sent.push({ channel, payload }); } };
}
const wc = fakeWebContents();
spellcheck.watchContextMenu(wc);
wc.emit('context-menu', {}, { isEditable: true, misspelledWord: 'wrold', dictionarySuggestions: ['world', 'word'], x: 1, y: 2 });
check('a flagged word is forwarded on the editor-context-menu channel', wc.sent.length === 1 && wc.sent[0].channel === spellcheck.CONTEXT_MENU_CHANNEL && wc.sent[0].payload.misspelledWord === 'wrold' && wc.sent[0].payload.suggestions.join(',') === 'world,word', JSON.stringify(wc.sent));

const handlers = new Map();
const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
const sessionCalls = [];
let customWords = ['zebra', 'alpha', 'bad\nword'];
let languages = ['en-US'];
const session = { defaultSession: {
  addWordToSpellCheckerDictionary: (w) => { sessionCalls.push(['add', w]); customWords.push(w); return true; },
  removeWordFromSpellCheckerDictionary: (w) => { sessionCalls.push(['remove', w]); customWords = customWords.filter((x) => x !== w); return true; },
  listWordsInSpellCheckerDictionary: async () => customWords.slice(),
  getSpellCheckerLanguages: () => languages,
  setSpellCheckerLanguages: (l) => { sessionCalls.push(['languages', l]); languages = l; },
  isSpellCheckerEnabled: () => true,
} };
spellcheck.installIpc({ ipcMain, session, platform: 'linux', manifest, log: () => {} });
const call = (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args);
check('the five handlers are installed', ['spellcheck:add-word', 'spellcheck:list-words', 'spellcheck:remove-word', 'spellcheck:languages', 'spellcheck:set-languages'].every((c) => handlers.has(c)));
check('add-word takes the word of the last menu of that webContents', (await call('spellcheck:add-word', wc, 'wrold')).ok === true && sessionCalls.some((c) => c[0] === 'add' && c[1] === 'wrold'));
check('add-word refuses another word, a long one, and a webContents without a menu', (await call('spellcheck:add-word', wc, 'world')).ok === false && (await call('spellcheck:add-word', wc, 'x'.repeat(65))).ok === false && (await call('spellcheck:add-word', fakeWebContents(), 'wrold')).ok === false && sessionCalls.filter((c) => c[0] === 'add').length === 1);
wc.emit('context-menu', {}, { isEditable: true, misspelledWord: '', dictionarySuggestions: [] });
check('after a menu with nothing flagged, add-word refuses the earlier word', (await call('spellcheck:add-word', wc, 'wrold')).ok === false && wc.sent.length === 1);
check('list-words is sorted and keeps valid words only', (await call('spellcheck:list-words', wc)).join(',') === 'alpha,wrold,zebra');
check('remove-word only removes a listed word', (await call('spellcheck:remove-word', wc, 'nope')).ok === false && (await call('spellcheck:remove-word', wc, 'zebra')).ok === true && !customWords.includes('zebra'));
// import-words (Settings > Editor's Import custom words, the database import): a list, merged, each word checked
sessionCalls.length = 0;
const imported = await call('spellcheck:import-words', wc, ['alpha', 'gamma', 'two words', 'x'.repeat(65), 7, 'gamma', 'ctrl\u0001']);
check('import-words merges a list: the new word added once (its repeat counted as present), the present one counted, the four invalid entries (two words, too long, a number, a control character) skipped and counted, the added words returned', imported.ok === true && imported.added === 1 && imported.existing === 2 && imported.skipped === 4 && imported.words.join() === 'gamma' && spellcheck.isDictionaryWord('gamma') && !spellcheck.isDictionaryWord('two words') && spellcheck.isWord('two words') && sessionCalls.filter((c) => c[0] === 'add').map((c) => c[1]).join() === 'gamma', JSON.stringify(imported));
check('import-words refuses what is not a list and a list beyond MAX_IMPORT_WORDS', (await call('spellcheck:import-words', wc, 'alpha')).ok === false && (await call('spellcheck:import-words', wc, Array.from({ length: spellcheck.MAX_IMPORT_WORDS + 1 }, () => 'w'))).ok === false && handlers.has('spellcheck:import-words'));
const langs = await call('spellcheck:languages', wc);
check('languages: the shipped choices with their labels and the selected ones (Linux)', langs.native === false && langs.available.length === manifest.dictionaries.length && langs.available.some((l) => l.code === 'cs-CZ' && /Czech/.test(l.label)) && langs.selected.join(',') === 'en-US', JSON.stringify(langs));
check('set-languages accepts shipped codes only, at least one', (await call('spellcheck:set-languages', wc, ['cs-CZ', 'de-DE', 'en-GB', 'cs-CZ'])).selected.join(',') === 'cs-CZ,en-GB' && languages.join(',') === 'cs-CZ,en-GB' && (await call('spellcheck:set-languages', wc, ['de-DE'])).ok === false && (await call('spellcheck:set-languages', wc, 'en-US')).ok === false);
const macHandlers = new Map();
spellcheck.installIpc({ ipcMain: { handle: (c, fn) => macHandlers.set(c, fn) }, session, platform: 'darwin', manifest, log: () => {} });
const macLangs = await macHandlers.get('spellcheck:languages')({ sender: wc });
check('on macOS: native, no choices, and set-languages is refused', macLangs.native === true && macLangs.available.length === 0 && (await macHandlers.get('spellcheck:set-languages')({ sender: wc }, ['en-US'])).ok === false, JSON.stringify(macLangs));
check('languageChoices lists the shipped languages on Windows / Linux and none on macOS', spellcheck.languageChoices(manifest, 'win32').map((l) => l.code).join(',') === manifest.dictionaries.map((d) => d.language).join(',') && spellcheck.languageChoices(manifest, 'darwin').length === 0);

// ---------------------------------------------------------------- the bridge and the wiring
const preload = read('electron/preload.cjs');
check('preload exposes onEditorContextMenu on the editor-context-menu channel with an unsubscribe', /onEditorContextMenu: \(callback\) => \{\n\s*const listener = \(event, payload\) => callback\(payload\);\n\s*ipcRenderer\.on\('editor-context-menu', listener\);\n\s*return \(\) => ipcRenderer\.removeListener\('editor-context-menu', listener\);/.test(preload));
check('preload exposes the six spellcheck calls on their channels', ['add-word', 'remove-word', 'list-words', 'import-words', 'languages', 'set-languages'].every((c) => preload.includes(`ipcRenderer.invoke('spellcheck:${c}'`)));
const main = read('electron/main.cjs');
check('main.cjs watches the main window and the standalone windows, and installs the IPC once', (main.match(/spellcheck\.watchContextMenu\(/g) || []).length === 2 && /spellcheck\.installIpc\(\{ ipcMain, session: require\('electron'\)\.session/.test(main) && (main.match(/spellcheck\.installIpc\(/g) || []).length === 1);
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('the editor lets the desktop app see the right-click (preventDefault only without the bridge) and takes the word under the pointer', /if \(typeof window\.electronAPI\?\.onEditorContextMenu !== 'function'\) e\.preventDefault\(\);/.test(editor) && /word: wordAtPointer\(textarea, e\)/.test(editor));
check('a suggestion replaces the word through replaceRange (an ordinary edit) and only when the text still matches', /if \(!textarea \|\| textarea\.value\.slice\(word\.from, word\.to\) !== word\.text\) return;\n\s*replaceRange\(word\.from, word\.to, suggestion, word\.from \+ suggestion\.length\);/.test(editor));
check('the suggestions join the open menu only when they are about its word', /menu\.visible && menu\.word && menu\.word\.text === payload\.misspelledWord/.test(editor));
const menu = read('src/components/features/documents/TextSelectionMenu.jsx');
check('the menu lists the suggestions, then Add to dictionary, then a separator, before the clipboard items', menu.indexOf('testId="spell-suggestion"') < menu.indexOf('testId="spell-add-word"') && menu.indexOf('testId="spell-add-word"') < menu.indexOf('testId="selection-cut"') && /spell\.suggestions\.map/.test(menu));
check('the menu icons for the spelling items exist', /spelling: SpellCheck/.test(read('src/components/common/menus/menuIcons.js')) && /addWord: BookPlus/.test(read('src/components/common/menus/menuIcons.js')));

// Settings: the spell-check options are their own category, "Editor", after General
const modal = read('src/components/common/modals/SettingsModal.jsx');
const general = read('src/components/common/modals/settings/GeneralSettings.jsx');
const editorSettings = read('src/components/common/modals/settings/EditorSettings.jsx');
check('Settings has an "Editor" category right after General, rendering EditorSettings',
  /\{ id: 'general', label: 'General' \},\s*\{ id: 'editor', label: 'Editor' \}/.test(modal) && /activeTab === 'editor' && <EditorSettings \/>/.test(modal));
check('the Editor category holds the spell-check toggle, the languages and the custom words; General no longer does',
  /editor-spellcheck-toggle/.test(editorSettings) && /spellcheck-languages/.test(editorSettings) && /spellcheck-words/.test(editorSettings)
  && !/EditorSection|editor-spellcheck-toggle/.test(general));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
