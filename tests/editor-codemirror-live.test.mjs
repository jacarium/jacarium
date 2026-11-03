/**
 * The Documents editor - CodeMirror 6 behind a textarea's API
 * (src/components/features/documents/codemirror/) - in a real browser (Vite
 * dev server + headless Chrome, tests/helpers/live-documents-app.mjs;
 * LIVE_BUILD=production runs the same against the production build).
 * What this test proves, with real input events on a local document:
 *   - the editor mounts with its own line-number gutter (no textarea), in
 *     the mono face on the theme's card background;
 *   - typing lands in the document (and in the parent's state: the value
 *     survives a reload);
 *   - the spell checker's scope: the content is spellcheck="true" and the
 *     fenced code, the inline code, the URL and the [[toc]] directive sit in
 *     spellcheck="false" marks while the prose does not; the Settings
 *     toggle turns the content's spellcheck attribute off and on;
 *   - the toolbar: Bold wraps the selection and the caret lands after it;
 *     Cmd/Ctrl+Z undoes it (the surface's history);
 *   - Home / End: the logical line's text start, then column 0, the line's
 *     end, Shift extending (src/utils/lineCaret.js on the surface);
 *   - Tab / Shift+Tab in a list line indent and outdent it;
 *   - the slash popup opens on "/" at a line start and Escape closes it;
 *   - Find (Cmd/Ctrl+F): the matches are marked in the view
 *     (.cm-searchMatch) and the current one is distinct;
 *   - the right-click menu opens on the editor with Cut / Copy / Paste,
 *     its first item takes the focus while the editor's selection stays
 *     painted, and Escape closes it with the focus back in the editor.
 *
 * Environment: CHROME_BIN, SMOKE_PORT (default 5241), LIVE_BUILD=production.
 * Run: node tests/editor-codemirror-live.test.mjs
 */
import { launchDocumentsApp, createNewDocument, sleep } from './helpers/live-documents-app.mjs';
import { waitForEditor, editorValue, editorSelection, setEditorSelection, setEditorText, EDITOR_EXPR } from './helpers/editor-surface.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5241);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const mac = process.platform === 'darwin';
const MOD = mac ? 4 : 2;   // CDP modifiers: Meta on a Mac, Ctrl elsewhere
const SHIFT = 8;

const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'editor-cm-live-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); process.exit(0); }
const key = async (key, code, vk, modifiers = 0, text) => {
  await app.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(120);
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const click = async (sel) => { const ok = await app.evaluate(`(() => { const b = ${q(sel)}; if (!b) return false; b.click(); return true; })()`); await sleep(300); return ok; };

try {
  check('a document was created', await createNewDocument(app));
  check('the editor surface mounted', await waitForEditor(app));
  const dom = await app.evaluate(`(() => ({ textarea: !!document.querySelector('.sc-editor-cm-host textarea'), cm: !!document.querySelector('.sc-editor-cm.cm-editor'), gutter: !!document.querySelector('.sc-editor-cm .cm-lineNumbers'), font: getComputedStyle(document.querySelector('.sc-editor-cm')).fontFamily, bg: getComputedStyle(document.querySelector('.sc-editor-cm')).backgroundColor }))()`);
  check('CodeMirror with its own line numbers, no textarea', !dom.textarea && dom.cm && dom.gutter, JSON.stringify(dom));
  check('the editor uses the mono face and the theme\'s card background', /Red Hat Mono|monospace/i.test(dom.font) && /rgb\(255, 255, 255\)/.test(dom.bg), JSON.stringify({ font: dom.font, bg: dom.bg }));

  // typing with real input
  const TEXT = 'Hello wrold of prose.\n```\nkubectl get podz -n openshift\n```\nInline `kubectl cde` and https://exmaple.com/wrld here, then [[toc]] and\n  - item one\n  - item two\nLast prose lne.';
  check('the text typed into the surface is its value', (await setEditorText(app, TEXT)) === TEXT, JSON.stringify(await editorValue(app)).slice(0, 120));
  await app.send('Page.reload');
  await sleep(4000);
  await app.evaluate(`document.documentElement.classList.remove('dark')`);
  await waitForEditor(app);
  check('the value survived a reload (autosave through the parent\'s state)', (await editorValue(app)) === TEXT, JSON.stringify(await editorValue(app)).slice(0, 120));

  // the spell checker's scope
  const spell = await app.evaluate(`(() => {
    const content = document.querySelector('.sc-editor-cm .cm-content');
    const marks = Array.from(document.querySelectorAll('.sc-editor-cm .cm-nospell')).map((m) => [m.textContent, m.getAttribute('spellcheck')]);
    const inProse = (needle) => { const el = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line')).find((l) => l.textContent.includes(needle)); if (!el) return 'missing'; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (n.textContent.includes(needle)) return n.parentElement.closest('.cm-nospell') ? 'nospell' : 'prose'; } return 'missing'; };
    return { contentSpellcheck: content.getAttribute('spellcheck'), marks, wrold: inProse('wrold'), podz: inProse('podz'), cde: inProse('cde'), url: inProse('exmaple.com'), toc: inProse('[[toc]]'), lne: inProse('lne') };
  })()`);
  check('the content is spellcheck="true" and every mark is spellcheck="false"', spell.contentSpellcheck === 'true' && spell.marks.length >= 4 && spell.marks.every((m) => m[1] === 'false'), JSON.stringify(spell));
  check('the fenced code, the inline code, the URL and [[toc]] are marked; the prose is not', spell.podz === 'nospell' && spell.cde === 'nospell' && spell.url === 'nospell' && spell.toc === 'nospell' && spell.wrold === 'prose' && spell.lne === 'prose', JSON.stringify(spell));
  await app.evaluate(`(() => { localStorage.setItem('documentsSpellcheck', 'false'); window.dispatchEvent(new CustomEvent('documentsSpellcheckChanged')); })()`);
  await sleep(300);
  check('the Settings toggle turns the content\'s spellcheck attribute off', (await app.evaluate(`document.querySelector('.sc-editor-cm .cm-content').getAttribute('spellcheck')`)) === 'false');
  await app.evaluate(`(() => { localStorage.setItem('documentsSpellcheck', 'true'); window.dispatchEvent(new CustomEvent('documentsSpellcheckChanged')); })()`);
  await sleep(300);
  check('and on again', (await app.evaluate(`document.querySelector('.sc-editor-cm .cm-content').getAttribute('spellcheck')`)) === 'true');

  // the toolbar: Bold on a selection, then undo
  await setEditorSelection(app, 0, 5);
  check('Bold wraps the selection and puts the caret after it', await click('[data-testid="tb-bold"]') && (await editorValue(app)).startsWith('**Hello** wrold') && (await (async () => { await sleep(100); const s = await editorSelection(app); return s.start === 9 && s.end === 9; })()), JSON.stringify(await editorSelection(app)));
  await app.evaluate(`(${EDITOR_EXPR}).focus()`);
  await key('z', 'KeyZ', 90, MOD);
  check('Cmd/Ctrl+Z undoes the toolbar edit (the surface\'s history)', (await editorValue(app)) === TEXT, JSON.stringify(await editorValue(app)).slice(0, 60));

  // Home / End on the indented list line
  const lineStart = TEXT.indexOf('  - item one');
  await setEditorSelection(app, lineStart + 8, lineStart + 8);
  await key('Home', 'Home', 36);
  let sel = await editorSelection(app);
  check('Home goes to the line\'s first non-blank character', sel.start === lineStart + 2 && sel.end === lineStart + 2, JSON.stringify(sel));
  await key('Home', 'Home', 36);
  sel = await editorSelection(app);
  check('a second Home goes to column 0', sel.start === lineStart, JSON.stringify(sel));
  await key('End', 'End', 35);
  sel = await editorSelection(app);
  check('End goes to the line\'s end', sel.start === lineStart + '  - item one'.length, JSON.stringify(sel));
  await key('Home', 'Home', 36, SHIFT);
  sel = await editorSelection(app);
  check('Shift+Home extends the selection back to the text start', sel.start === lineStart + 2 && sel.end === lineStart + '  - item one'.length && sel.direction === 'backward', JSON.stringify(sel));

  // Tab / Shift+Tab in a list line
  await setEditorSelection(app, lineStart + 4, lineStart + 4);
  await key('Tab', 'Tab', 9);
  check('Tab in a list line indents it by two spaces', (await editorValue(app)).includes('\n    - item one\n'), JSON.stringify(await editorValue(app)).slice(0, 200));
  await key('Tab', 'Tab', 9, SHIFT);
  check('Shift+Tab outdents it again', (await editorValue(app)) === TEXT);

  // the slash popup
  await setEditorSelection(app, TEXT.length, TEXT.length);
  await app.send('Input.insertText', { text: '\n/' });
  await sleep(400);
  check('"/" at a line start opens the commands popup', await has('[data-slash-entry]'));
  await key('Escape', 'Escape', 27);
  check('Escape closes it and leaves the text', !(await has('[data-slash-entry]')) && (await editorValue(app)).endsWith('\n/'));
  await key('Backspace', 'Backspace', 8);
  await key('Backspace', 'Backspace', 8);
  check('Backspace removes what was typed', (await editorValue(app)) === TEXT, JSON.stringify(await editorValue(app)).slice(-40));

  // Find: the matches are marks in the view
  await app.evaluate(`(${EDITOR_EXPR}).focus()`);
  await key('f', 'KeyF', 70, MOD);
  await sleep(300);
  check('Cmd/Ctrl+F opens the find bar', await has('input[placeholder="Search..."]'));
  await app.evaluate(`(() => { const i = document.querySelector('input[placeholder="Search..."]'); i.focus(); })()`);
  await app.send('Input.insertText', { text: 'kubectl' });
  await sleep(900);
  const matches = await app.evaluate(`(() => ({ all: document.querySelectorAll('.sc-editor-cm .cm-searchMatch').length, current: document.querySelectorAll('.sc-editor-cm .cm-searchMatch-current').length, count: (document.body.textContent.match(/\\d+ of \\d+ matches/) || [''])[0] }))()`);
  check('the matches are marked in the view, one of them current', matches.all === 2 && matches.current === 1 && /1 of 2/.test(matches.count), JSON.stringify(matches));
  await key('Escape', 'Escape', 27);
  await sleep(300);
  check('Escape closes the find bar and clears the marks', !(await has('input[placeholder="Search..."]')) && (await app.evaluate(`document.querySelectorAll('.sc-editor-cm .cm-searchMatch').length`)) === 0);

  // the right-click menu keeps the editor focused
  await setEditorSelection(app, 0, 5);
  const point = await app.evaluate(`(() => { const c = (${EDITOR_EXPR}).coordsAtPos(2); return { x: Math.round(c.left), y: Math.round((c.top + c.bottom) / 2) }; })()`);
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  await sleep(400);
  const menu = await app.evaluate(`(() => ({ menu: !!document.querySelector('[data-testid="editor-context-menu"]'), cut: !!document.querySelector('[data-testid="selection-cut"]'), copy: !!document.querySelector('[data-testid="selection-copy"]'), paste: !!document.querySelector('[data-testid="selection-paste"]'), focused: document.activeElement && document.activeElement.getAttribute('data-testid'), selection: (${EDITOR_EXPR}).value.slice((${EDITOR_EXPR}).selectionStart, (${EDITOR_EXPR}).selectionEnd), painted: document.querySelectorAll('.sc-editor-cm .cm-selectionBackground').length }))()`);
  check('right-click opens the editor menu with Cut / Copy / Paste; its first item takes the focus, the editor keeps (and paints) the selection', menu.menu && menu.cut && menu.copy && menu.paste && menu.focused === 'selection-cut' && menu.selection === 'Hello' && menu.painted > 0, JSON.stringify(menu));
  await key('Escape', 'Escape', 27);
  check('Escape closes the menu and the editor has the focus again with the selection', !(await has('[data-testid="editor-context-menu"]')) && (await app.evaluate(`document.activeElement === document.querySelector('.sc-editor-cm .cm-content')`)) && (await editorSelection(app)).end === 5);

  check('no page error during the run', app.errors.length === 0, app.errors.join(' | '));
} catch (error) {
  check('the test ran to the end', false, error?.stack || String(error));
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
