/**
 * The Documents editor's surface, for the tests that drive it in a real
 * browser or the Electron app (tests/helpers/live-documents-app.mjs /
 * electron-app.mjs) and for the jsdom tests that mount DocumentEditor:
 * CodeMirror behind a textarea's API
 * (src/components/features/documents/codemirror/CodeMirrorSurface.js -
 * `value`, `selectionStart` / `selectionEnd`, `setSelectionRange`, `focus`,
 * `select`, ...). A test drives "the editor" through these, never through
 * CodeMirror's internals: EDITOR_EXPR evaluates to the surface object, the
 * key events go to the element that has the focus (EDITOR_DOM_EXPR /
 * EDITOR_SELECTOR), and `Input.insertText` types into it.
 */
import { sleep } from './live-documents-app.mjs';

/** An expression: the editor surface (the CodeMirrorSurface of the mounted editor), or null. */
export const EDITOR_EXPR = "((document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface) || null)";

/** An expression: the element that takes the keys (CodeMirror's contenteditable). */
export const EDITOR_DOM_EXPR = "(document.querySelector('.sc-editor-cm .cm-content') || null)";

/** A selector that matches the focusable editor element. */
export const EDITOR_SELECTOR = '.sc-editor-cm .cm-content';

/** Wait until the editor surface is mounted. */
export async function waitForEditor(app, timeoutMs = 15000) {
  return app.waitFor(`!!${EDITOR_EXPR}`, timeoutMs);
}

/**
 * For the jsdom tests that mount the real DocumentEditor: the globals
 * CodeMirror needs that jsdom does not put on globalThis (the Window
 * constructor its measure step checks, rects on ranges - jsdom lays nothing
 * out). Call it once the test has installed `window`.
 */
export function installEditorSurfaceInJsdom(window) {
  const define = (name, value) => { try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); } catch { /* read-only */ } };
  if (typeof globalThis.Window === 'undefined') define('Window', window.Window);
  if (typeof globalThis.Range === 'undefined') define('Range', window.Range);
  if (typeof globalThis.Selection === 'undefined') define('Selection', window.Selection);
  if (typeof globalThis.Text === 'undefined') define('Text', window.Text);
  if (typeof globalThis.NodeFilter === 'undefined') define('NodeFilter', window.NodeFilter);
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
  if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = rect;
}

/** In jsdom: the mounted editor's surface object (waits for the mount). */
export async function jsdomEditor(document, timeoutMs = 5000) {
  const find = () => (document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface) || null;
  const t0 = Date.now();
  for (;;) {
    const el = find();
    if (el) return el;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(20);
  }
}

export const editorValue = (app) => app.evaluate(`(${EDITOR_EXPR}) ? (${EDITOR_EXPR}).value : null`);
export const editorSelection = (app) => app.evaluate(`(() => { const e = ${EDITOR_EXPR}; return e ? { start: e.selectionStart, end: e.selectionEnd, direction: e.selectionDirection } : null; })()`);
export const focusEditor = (app) => app.evaluate(`(() => { const e = ${EDITOR_EXPR}; if (!e) return false; e.focus(); return true; })()`);
export const setEditorSelection = (app, start, end = start, direction = 'none') => app.evaluate(`(() => { const e = ${EDITOR_EXPR}; if (!e) return false; e.focus(); e.setSelectionRange(${start}, ${end}, ${JSON.stringify(direction)}); return true; })()`);

// ---- the same for a Playwright page (tests that drive Chrome through playwright-core)
/** The focusable editor element as a Playwright locator (keys, taps, focus). */
export const pwEditor = (page) => page.locator(EDITOR_SELECTOR);
/** The editor's text. */
export const pwEditorValue = (page) => page.evaluate((expr) => eval(expr).value, EDITOR_EXPR);
/** Put `text` in the editor (as a document switch would: not typing) with the caret at its end, focused. */
export const pwSetEditorText = (page, text) => page.evaluate(([expr, value]) => { const s = eval(expr); s.focus(); s.value = value; s.setSelectionRange(value.length, value.length); }, [EDITOR_EXPR, text]);
/** Select a range of the editor's text, focused. */
export const pwSelect = (page, start, end = start) => page.evaluate(([expr, a, b]) => { const s = eval(expr); s.focus(); s.setSelectionRange(a, b); }, [EDITOR_EXPR, start, end]);

/** Replace the editor's whole text with real input (select all + insertText) and let autosave run. */
export async function setEditorText(app, text) {
  await app.evaluate(`(() => { const e = ${EDITOR_EXPR}; e.focus(); e.select(); })()`);
  await app.send('Input.insertText', { text });
  await sleep(1500);
  return editorValue(app);
}
