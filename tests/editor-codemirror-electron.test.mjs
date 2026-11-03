/**
 * The CodeMirror editor surface in the REAL Electron app: the spell checker
 * that skips code, and the right-click menu's suggestions
 * (tests/helpers/electron-app.mjs: Vite dev server + the app via Playwright
 * on a throwaway profile).
 *
 * THE GOAL of the surface: a spell checker that ignores everything in code.
 * The textarea could not (one element, one spellcheck attribute); the
 * CodeMirror surface marks the code ranges spellcheck="false" from the
 * Markdown tree (src/components/features/documents/codemirror/spellcheckSkip.js),
 * and Chromium's checker honours the mark.
 *
 * What this test proves, with real key and mouse events:
 *   - typed prose with a misspelling is flagged: right-clicking it, the
 *     main process' context-menu event names the word (misspelledWord) -
 *     the page let the click through - and the editor's own menu shows the
 *     spelling items (the suggestions, or "No suggestions", then "Add to
 *     dictionary") above Cut / Copy / Paste;
 *   - the same misspelling inside a ``` fence and inside inline `code` is
 *     NOT flagged: no misspelledWord, no spelling items in the menu;
 *   - a suggestion replaces exactly the word as an editor transaction
 *     (the main process' report is what the menu takes; the test sends one
 *     through the same channel so the check does not depend on the
 *     platform's suggestions), and Cmd/Ctrl+Z undoes it;
 *   - "Add to dictionary" reaches the session's custom dictionary (the word
 *     is removed again afterwards: on macOS and Windows the OS dictionary
 *     takes it too), and only for the word of the last menu;
 *   - the preload's spellcheck.getLanguages() answers: native on macOS, the
 *     shipped languages elsewhere.
 *
 * SKIPs (exit 0) when the app cannot be launched (SKIP_ELECTRON_TESTS, no
 * playwright-core, no GUI).
 * Run: node tests/editor-codemirror-electron.test.mjs
 */
import { launchElectronApp, createNewDocument, sleep } from './helpers/electron-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const TEST_WORD = 'zqxjvtestwrd';   // never a real word; added to the dictionary and removed again

const launched = await launchElectronApp({ profilePrefix: 'electron-cm-' });
if (launched.skip) { console.log(`SKIP: ${launched.skip}`); process.exit(0); }
const { app, page, close } = launched;
const SURFACE = "document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface";
const value = () => page.evaluate(`(${SURFACE}).value`);
const menuState = () => page.evaluate(() => ({
  open: !!document.querySelector('[data-testid="editor-context-menu"]'),
  suggestions: Array.from(document.querySelectorAll('[data-testid="spell-suggestion"]')).map((b) => b.textContent.trim()),
  noSuggestions: !!document.querySelector('[data-testid="spell-no-suggestions"]'),
  addWord: !!document.querySelector('[data-testid="spell-add-word"]'),
  paste: !!document.querySelector('[data-testid="selection-paste"]'),
}));
// right-click the character at a document offset; resolves to the main process' report of that click
const rightClickAt = async (offset) => {
  await app.evaluate(() => { global.__cmMenu = null; });
  const point = await page.evaluate((pos) => { const s = document.querySelector('.sc-editor-cm').editorSurface; s.scrollToPos(pos, { center: true }); const c = s.coordsAtPos(pos); return c ? { x: Math.round((c.left + c.right) / 2 + 3), y: Math.round((c.top + c.bottom) / 2) } : null; }, offset);
  if (!point) return { point: null, params: null };
  await page.mouse.click(point.x, point.y, { button: 'right' });
  let params = null;
  for (let i = 0; i < 20 && !params; i++) { await sleep(150); params = await app.evaluate(() => global.__cmMenu); }
  await sleep(300);   // the menu's state update with the forwarded report
  return { point, params };
};
const pressEscape = async () => { await page.keyboard.press('Escape'); await sleep(200); };
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

try {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.on('context-menu', (_e, params) => { global.__cmMenu = { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions, isEditable: params.isEditable }; });
    }
  });
  check('a document was created', await createNewDocument(page));
  await page.waitForFunction(() => !!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface), null, { timeout: 20000 });
  check('the CodeMirror surface is up with spellcheck on', (await page.evaluate(() => document.querySelector('.sc-editor-cm .cm-content').getAttribute('spellcheck'))) === 'true');

  // typed with real keys: prose, a fence, inline code, prose again
  await page.click('.sc-editor-cm .cm-content');
  const LINES = ['This sentense is prose.', '```', 'kubectl get podz -n sentense', '```', 'Inline `sentense here` then prose wrold.', `A ${TEST_WORD} to add.`];
  for (let i = 0; i < LINES.length; i++) {
    await page.keyboard.type(LINES[i], { delay: 15 });
    if (i < LINES.length - 1) await page.keyboard.press('Enter');
  }
  const TEXT = LINES.join('\n');
  await sleep(3000);   // the checker's idle pass
  check('the typed text is the document', (await value()) === TEXT, JSON.stringify(await value()));
  const marks = await page.evaluate(() => Array.from(document.querySelectorAll('.sc-editor-cm .cm-nospell')).map((m) => m.textContent));
  check('the fence and the inline code are spellcheck="false" marks', marks.includes('kubectl get podz -n sentense') && marks.includes('`sentense here`'), JSON.stringify(marks));

  // prose: flagged, the menu carries the spelling items
  let r = await rightClickAt(TEXT.indexOf('sentense') + 3);
  let menu = await menuState();
  check('right-click on the misspelled prose word: Chromium reports it (the page let the click through)', r.params && r.params.misspelledWord === 'sentense' && r.params.isEditable === true, JSON.stringify(r.params));
  check('the editor\'s menu shows the spelling items (suggestions or "No suggestions", then Add to dictionary) with Paste below', menu.open && (menu.suggestions.length > 0 || menu.noSuggestions) && menu.addWord && menu.paste, JSON.stringify(menu));
  console.log(`INFO: ${process.platform} suggestions for "sentense": ${JSON.stringify(menu.suggestions)}`);
  await pressEscape();

  // the fenced code: not flagged, no spelling items
  r = await rightClickAt(TEXT.indexOf('podz') + 2);
  menu = await menuState();
  check('right-click in the fenced code: nothing flagged, the menu has no spelling items', r.params && r.params.misspelledWord === '' && menu.open && menu.suggestions.length === 0 && !menu.noSuggestions && !menu.addWord, JSON.stringify({ params: r.params, menu }));
  await pressEscape();
  r = await rightClickAt(TEXT.indexOf('`sentense here`') + 4);
  menu = await menuState();
  check('right-click in the inline code: nothing flagged either', r.params && r.params.misspelledWord === '' && menu.open && !menu.addWord, JSON.stringify({ params: r.params, menu }));
  await pressEscape();
  r = await rightClickAt(TEXT.indexOf('wrold') + 2);
  check('the prose after the code is still checked ("wrold")', r.params && r.params.misspelledWord === 'wrold', JSON.stringify(r.params));
  await pressEscape();

  // a suggestion replaces the word as a transaction, undone by Cmd/Ctrl+Z (the report sent through the real channel)
  r = await rightClickAt(TEXT.indexOf('wrold') + 2);
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('editor-context-menu', { misspelledWord: 'wrold', suggestions: ['world', 'word'], x: 0, y: 0 }); });
  await sleep(400);
  menu = await menuState();
  check('the forwarded suggestions appear in the open menu', menu.open && menu.suggestions.join(',') === 'world,word', JSON.stringify(menu));
  await page.click('[data-testid="spell-suggestion"]');
  await sleep(300);
  const replaced = TEXT.replace('prose wrold.', 'prose world.');
  check('choosing a suggestion replaces exactly that word', (await value()) === replaced, JSON.stringify(await value()).slice(-80));
  await page.keyboard.press(`${mod}+z`);
  await sleep(300);
  check('Cmd/Ctrl+Z undoes the replacement', (await value()) === TEXT, JSON.stringify(await value()).slice(-80));

  // Add to dictionary: only the word of the last menu reaches the session
  const wordsBefore = await app.evaluate(({ session }) => session.defaultSession.listWordsInSpellCheckerDictionary());
  r = await rightClickAt(TEXT.indexOf(TEST_WORD) + 3);
  check(`"${TEST_WORD}" is flagged`, r.params && r.params.misspelledWord === TEST_WORD, JSON.stringify(r.params));
  const refused = await page.evaluate(() => window.electronAPI.spellcheck.addWord('sentense'));
  check('addWord for another word than the last menu\'s is refused', refused && refused.ok === false, JSON.stringify(refused));
  await page.click('[data-testid="spell-add-word"]');
  await sleep(500);
  const wordsAfter = await app.evaluate(({ session }) => session.defaultSession.listWordsInSpellCheckerDictionary());
  check('Add to dictionary puts the word in the session\'s custom dictionary', !wordsBefore.includes(TEST_WORD) && wordsAfter.includes(TEST_WORD), JSON.stringify(wordsAfter));
  const listed = await page.evaluate(() => window.electronAPI.spellcheck.listWords());
  check('Settings sees it through the bridge', listed.includes(TEST_WORD), JSON.stringify(listed));
  const removed = await page.evaluate((w) => window.electronAPI.spellcheck.removeWord(w), TEST_WORD);
  check('and can remove it', removed && removed.ok === true && !(await page.evaluate(() => window.electronAPI.spellcheck.listWords())).includes(TEST_WORD));

  const languages = await page.evaluate(() => window.electronAPI.spellcheck.getLanguages());
  check(process.platform === 'darwin' ? 'languages: native (the system checker) on macOS' : 'languages: the shipped choices on this platform', process.platform === 'darwin' ? languages.native === true && languages.available.length === 0 : languages.native === false && languages.available.length === 4 && languages.selected.length > 0, JSON.stringify(languages));
} catch (error) {
  check('the test ran to the end', false, error?.stack || String(error));
} finally {
  try { await app.evaluate(({ session }, w) => { try { session.defaultSession.removeWordFromSpellCheckerDictionary(w); } catch { /* not there */ } }, TEST_WORD); } catch { /* closed */ }
  await close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
