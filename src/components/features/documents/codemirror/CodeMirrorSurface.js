/**
 * The CodeMirror 6 editor surface behind DocumentEditor's `textareaRef`.
 *
 * DocumentEditor was written against a <textarea>: it reads `.value`,
 * `.selectionStart` / `.selectionEnd`, calls `.setSelectionRange()`,
 * `.focus()`, scrolls `.scrollTop`, measures `.clientHeight`, listens to
 * `scroll`, and its helpers (src/utils/editorClipboard.js,
 * src/utils/lineCaret.js) do the same. This class is that interface over
 * an EditorView, so the toolbar, the slash commands, the find bar, the
 * right-click menu and the Yjs hook keep working on either surface:
 *
 *   - `.value` is the document (cached per document version, so the two
 *     reads a keystroke costs are one toString); setting it dispatches ONE
 *     change covering the differing middle (common prefix and suffix kept),
 *     so the selection, the scroll position and the undo history survive a
 *     toolbar insert or a document reload;
 *   - the selection is the main selection, in character offsets, with the
 *     `direction` a textarea reports;
 *   - `isCodeMirror` / `managesYjs` tell the callers what they hold: with a
 *     live document bound (bindYjs: y-codemirror.next's yCollab), the
 *     binding pushes local edits into the Y.Text and applies remote ones to
 *     the view, so the hook's own DOM writes and diffs must stand down;
 *   - the native spell checker runs on the content (spellcheck="true" on
 *     the contenteditable; spellcheckSkip.js marks what it must skip),
 *     switchable (Settings > Editor);
 *   - the find bar's matches are decorations (setSearchMatches), the
 *     popups' positions come from coordsAtPos(), line numbers from
 *     CodeMirror's own gutter.
 *
 * The event handlers (keydown, contextmenu, the selection) go to the
 * callbacks the constructor was given, as DOM events; a handler that calls
 * preventDefault() wins over CodeMirror's own key bindings.
 */
import { EditorState, Compartment, StateEffect, StateField, EditorSelection, Annotation, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as placeholderExtension, Decoration, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory, undo as historyUndo, redo as historyRedo } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap, ySyncAnnotation } from 'y-codemirror.next';
import { UndoManager } from 'yjs';
import { markdownLanguage } from './markdownLanguage';
import { spellcheckSkip } from './spellcheckSkip';

/** A change made through `.value =` (a document switch, a toolbar insert): not typed, so no onChange. */
export const externalChange = Annotation.define();

// The find bar's matches
const setMatches = StateEffect.define();
const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const currentMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-current' });
const searchMatches = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMatches)) {
        const { matches, current } = effect.value;
        const marks = [];
        matches.forEach((m, i) => {
          if (m.end > m.start && m.end <= tr.newDoc.length) marks.push((i === current ? currentMatchMark : matchMark).range(m.start, m.end));
        });
        return Decoration.set(marks, true);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The common-prefix / common-suffix diff of two strings as one CodeMirror change, or null when equal. */
export function diffChange(oldText, newText) {
  if (oldText === newText) return null;
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) };
}

export class CodeMirrorSurface {
  /**
   * @param {object} options
   * @param {HTMLElement} options.parent   where the editor's DOM goes
   * @param {string} [options.doc]
   * @param {boolean} [options.readOnly]
   * @param {string} [options.placeholder]
   * @param {boolean} [options.spellcheck]
   * @param {boolean} [options.lineNumbers]
   * @param {object} [options.handlers]   { onChange, onKeyDown, onKeyUp, onContextMenu, onSelect, onClick, onMouseUp, onFocus, onBlur }
   */
  constructor({ parent, doc = '', readOnly = false, placeholder = '', spellcheck = true, lineNumbers: showLineNumbers = true, handlers = {} }) {
    this.isCodeMirror = true;
    this.handlers = handlers;
    this._readOnly = new Compartment();
    this._placeholder = new Compartment();
    this._spellcheck = new Compartment();
    this._collab = new Compartment();
    this._placeholderText = placeholder;
    this._readOnlyValue = !!readOnly;
    this._spellcheckValue = !!spellcheck;
    this._yjs = null;
    this._valueCache = { doc: null, text: '' };

    const self = this;
    const domHandlers = EditorView.domEventHandlers({
      keydown(event) { self.handlers.onKeyDown?.(event); return event.defaultPrevented; },
      keyup(event) { self.handlers.onKeyUp?.(event); self.handlers.onSelect?.(); return false; },
      contextmenu(event) { self.handlers.onContextMenu?.(event); return event.defaultPrevented; },
      mouseup(event) { self.handlers.onMouseUp?.(event); self.handlers.onSelect?.(); return false; },
      click(event) { self.handlers.onClick?.(event); return event.defaultPrevented; },
      focus(event) { self.handlers.onFocus?.(event); return false; },
      blur(event) { self.handlers.onBlur?.(event); return false; },
      // macOS "Add period with double-space" (System Settings > Keyboard >
      // Text Input, on by default): AppKit asks the focused editor to replace
      // the space just typed with ". ", which Chromium delivers as an
      // insertText of ". " over a selected run of spaces (nothing in the
      // page's key handling sees it; autocorrect="off" does not cover it).
      // Two trailing spaces are Markdown's hard line break, and code blocks
      // and tables rely on runs of spaces, so that one substitution is
      // cancelled and the space it stood for inserted instead (a typed
      // character: on the history like any other). A user typing "." then
      // " " arrives as two events with a collapsed selection and is left
      // alone, as is any composition.
      beforeinput(event, view) {
        if (event.inputType !== 'insertText' || event.isComposing || event.data !== '. ') return false;
        const { from, to } = view.state.selection.main;
        if (to <= from || !/^ +$/.test(view.state.sliceDoc(from, to))) return false;
        event.preventDefault();
        view.dispatch({ changes: { from: to, to, insert: ' ' }, selection: { anchor: to + 1 }, userEvent: 'input.type' });
        return true;
      },
    });
    const listener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        this._valueCache = { doc: null, text: '' };
        // (y-codemirror.next marks the changes it applies from the Y.Text with its annotation: remote text,
        // which the textarea took through `.value`, silently - not typing)
        const typed = update.transactions.some((tr) => !tr.annotation(externalChange) && !tr.annotation(ySyncAnnotation));
        if (typed) this.handlers.onChange?.({ target: this, type: 'input' });
      }
      if (update.selectionSet || update.docChanged) this.handlers.onSelect?.();
    });
    // (kept to build a fresh state for the next document: replaceDocument)
    this._extensions = () => [
      Prec.highest(domHandlers),
      listener,
      showLineNumbers ? lineNumbers() : [],
      highlightSpecialChars(),
      drawSelection(),
      markdownLanguage,
      spellcheckSkip,
      searchMatches,
      EditorView.lineWrapping,
      EditorView.editorAttributes.of({ class: 'sc-editor-surface sc-editor-cm' }),
      this._spellcheck.of(spellcheckAttributes(this._spellcheckValue)),
      this._placeholder.of(this._placeholderText ? placeholderExtension(this._placeholderText) : []),
      this._readOnly.of(readOnlyExtension(this._readOnlyValue)),
      this._collab.of(localHistory()),
      keymap.of(defaultKeymap),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc, extensions: this._extensions() }) });
    // the DOM the callers may reach (the right-click menu's focus guard, the tests)
    this.view.dom.editorSurface = this;
  }

  /**
   * Another document: a fresh state with its text - no undo history of the
   * previous one, no selection, no find marks, no binding (a live document
   * binds again through bindYjs), the scroll at the top.
   */
  replaceDocument(text) {
    this._yjs = null;
    this._valueCache = { doc: null, text: '' };
    this.view.setState(EditorState.create({ doc: String(text ?? ''), extensions: this._extensions() }));
    this.view.scrollDOM.scrollTop = 0;
  }

  get dom() { return this.view.dom; }
  get contentDOM() { return this.view.contentDOM; }
  get scrollDOM() { return this.view.scrollDOM; }
  get ownerDocument() { return this.view.dom.ownerDocument; }
  get managesYjs() { return !!this._yjs; }
  get disabled() { return false; }
  get tagName() { return 'CM-EDITOR'; }

  // ---- the document
  get value() {
    const doc = this.view.state.doc;
    if (this._valueCache.doc !== doc) this._valueCache = { doc, text: doc.toString() };
    return this._valueCache.text;
  }
  set value(text) {
    const next = String(text ?? '');
    const change = diffChange(this.value, next);
    if (!change) return;
    // its own undo step (a toolbar insert, a replace): never joined with the typing around it
    if (this._yjs) this._yjs.undoManager.stopCapturing();
    this.view.dispatch({ changes: change, annotations: [externalChange.of(true), isolateHistory.of('full')] });
    if (this._yjs) this._yjs.undoManager.stopCapturing();
  }

  // ---- the selection, as a textarea reports it
  get selectionStart() { return this.view.state.selection.main.from; }
  get selectionEnd() { return this.view.state.selection.main.to; }
  get selectionDirection() {
    const { anchor, head } = this.view.state.selection.main;
    return anchor === head ? 'none' : (head < anchor ? 'backward' : 'forward');
  }
  setSelectionRange(start, end, direction = 'none') {
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    const selection = direction === 'backward' ? EditorSelection.single(to, from) : EditorSelection.single(from, to);
    this.view.dispatch({ selection, scrollIntoView: true });
  }
  select() { this.setSelectionRange(0, this.view.state.doc.length); }
  /** Type `text` over the selection, as input would (onChange fires; one undo step with the typing around it). */
  insertText(text) {
    const { from, to } = this.view.state.selection.main;
    const insert = String(text ?? '');
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type', scrollIntoView: true });
  }

  // ---- focus
  focus() { this.view.focus(); }
  blur() { this.view.contentDOM.blur(); }
  get hasFocus() { return this.view.hasFocus; }

  // ---- read-only, placeholder, spell checking
  get readOnly() { return this._readOnlyValue; }
  set readOnly(on) {
    if (this._readOnlyValue === !!on) return;
    this._readOnlyValue = !!on;
    this.view.dispatch({ effects: this._readOnly.reconfigure(readOnlyExtension(this._readOnlyValue)) });
  }
  get placeholder() { return this._placeholderText; }
  set placeholder(text) {
    const next = String(text || '');
    if (this._placeholderText === next) return;
    this._placeholderText = next;
    this.view.dispatch({ effects: this._placeholder.reconfigure(next ? placeholderExtension(next) : []) });
  }
  get spellcheck() { return this._spellcheckValue; }
  set spellcheck(on) {
    if (this._spellcheckValue === !!on) return;
    this._spellcheckValue = !!on;
    this.view.dispatch({ effects: this._spellcheck.reconfigure(spellcheckAttributes(this._spellcheckValue)) });
  }

  // ---- scrolling and geometry (the scroller is what scrolls)
  get scrollTop() { return this.view.scrollDOM.scrollTop; }
  set scrollTop(v) { this.view.scrollDOM.scrollTop = v; }
  get scrollLeft() { return this.view.scrollDOM.scrollLeft; }
  set scrollLeft(v) { this.view.scrollDOM.scrollLeft = v; }
  get scrollHeight() { return this.view.scrollDOM.scrollHeight; }
  get clientHeight() { return this.view.scrollDOM.clientHeight; }
  get clientWidth() { return this.view.scrollDOM.clientWidth; }
  getBoundingClientRect() { return this.view.dom.getBoundingClientRect(); }
  /** The screen coordinates of a character offset ({ left, right, top, bottom }), or null when it is not rendered. */
  coordsAtPos(pos) {
    const length = this.view.state.doc.length;
    return this.view.coordsAtPos(Math.max(0, Math.min(length, pos)));
  }
  /** Scroll a character offset into view (centred when asked). */
  scrollToPos(pos, { center = false } = {}) {
    const length = this.view.state.doc.length;
    this.view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(length, pos)), { y: center ? 'center' : 'nearest' }) });
  }

  // ---- events (scroll on the scroller, the rest on the content)
  addEventListener(type, fn, options) { (type === 'scroll' ? this.view.scrollDOM : this.view.contentDOM).addEventListener(type, fn, options); }
  removeEventListener(type, fn, options) { (type === 'scroll' ? this.view.scrollDOM : this.view.contentDOM).removeEventListener(type, fn, options); }
  dispatchEvent(event) { return this.view.contentDOM.dispatchEvent(event); }
  closest(selector) { return this.view.dom.closest(selector); }
  contains(node) { return this.view.dom.contains(node); }

  // ---- the find bar
  setSearchMatches(matches, current = -1) {
    this.view.dispatch({ effects: setMatches.of({ matches: matches || [], current }) });
  }

  // ---- a live document (y-codemirror.next)
  /** Bind a Y.Text (and its awareness: remote carets): the view takes the text's content, local edits go to the text. */
  bindYjs(ytext, awareness, { undoManager = null } = {}) {
    if (this._yjs && this._yjs.ytext === ytext && this._yjs.awareness === awareness) return;
    this._yjs = null;
    this.value = ytext.toString();
    // the undo manager tracks this surface's own edits only (y-codemirror.next adds its origin to it)
    const manager = undoManager || new UndoManager(ytext);
    this._yjs = { ytext, awareness, undoManager: manager };
    this.view.dispatch({ effects: this._collab.reconfigure([yCollab(ytext, awareness, { undoManager: manager }), keymap.of(yUndoManagerKeymap)]) });
  }
  /** Back to a local document with its own undo history. */
  unbindYjs() {
    if (!this._yjs) return;
    this._yjs = null;
    this.view.dispatch({ effects: this._collab.reconfigure(localHistory()) });
  }

  // ---- undo / redo: the local history, or the Y.UndoManager of a bound document (what Cmd/Ctrl+Z runs)
  undo() { return this.managesYjs ? yUndoManagerKeymap.find((k) => k.key === 'Mod-z').run(this.view) : historyUndo(this.view); }
  redo() { return this.managesYjs ? yUndoManagerKeymap.find((k) => k.key === 'Mod-y').run(this.view) : historyRedo(this.view); }

  destroy() {
    this.view.destroy();
  }
}

function spellcheckAttributes(on) {
  return EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' });
}

function readOnlyExtension(on) {
  return [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
}

function localHistory() {
  return [history(), keymap.of(historyKeymap)];
}
