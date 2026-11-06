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
import { docLinkChips } from './docLinkChips';
import { codeBlocks } from './codeBlocks';
import { codeColours } from './codeColours';

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

/**
 * CodeMirror draws the document at its real height up to 7,000,000 px
 * (@codemirror/view's VP.MaxDOMHeight); taller than that, it scales the
 * height map down to fit the browser's maximum element height and works
 * from estimates. In that regime drawSelection()'s cursor layer breaks
 * scrolling (@codemirror/view 6.43.15, the newest: measured in
 * tests/editor-huge-document-scroll.test.mjs - the view goes empty and the
 * scroll position jumps back towards the end, with the bare editor too):
 * its measure of the cursor with coordsAtPos() runs on every view update
 * whether or not the cursor is in the viewport, unlike the selection
 * layer, which stays inside the viewport. So the drawn selection is off
 * for a document that tall - the browser's own caret and selection colour
 * show instead - and on for everything else. The estimate uses the lines
 * and the default line height with room for wrapped lines, which are
 * taller than estimated.
 */
export const HUGE_DOCUMENT_HEIGHT = 5000000;
export function isHugeDocument(doc, lineHeight) {
  return doc.lines * (lineHeight > 0 ? lineHeight : 24) > HUGE_DOCUMENT_HEIGHT;
}

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
   * @param {Function} [options.docLinkResolver]  the [[doc:...]] chips' title resolver (src/utils/docLinks.js createDocLinkResolver)
   */
  constructor({ parent, doc = '', readOnly = false, placeholder = '', spellcheck = true, lineNumbers: showLineNumbers = true, handlers = {}, docLinkResolver = null, codeColours: withCodeColours = true }) {
    this.isCodeMirror = true;
    // the syntax colours of fenced code (codeColours.js); off only for the measurements in the tests
    this._codeColours = withCodeColours !== false;
    this.handlers = handlers;
    this._readOnly = new Compartment();
    this._placeholder = new Compartment();
    this._spellcheck = new Compartment();
    this._collab = new Compartment();
    // the document links' chips (docLinkChips.js) with the resolver of the moment
    this._docLinks = new Compartment();
    this._docLinkResolver = typeof docLinkResolver === 'function' ? docLinkResolver : null;
    // drawSelection(), off for a document too tall for CodeMirror's real-height rendering (isHugeDocument)
    this._selectionDrawing = new Compartment();
    this._hugeDocument = false;
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
        // the document crossed the height where the drawn selection must go (or come back): switch it after this update
        const huge = isHugeDocument(update.state.doc, update.view.defaultLineHeight);
        if (huge !== this._hugeDocument) {
          this._hugeDocument = huge;
          queueMicrotask(() => { if (this.view === update.view) this.view.dispatch({ effects: this._selectionDrawing.reconfigure(huge ? [] : drawSelection()) }); });
        }
      }
      if (update.selectionSet || update.docChanged) this.handlers.onSelect?.();
    });
    // (kept to build a fresh state for the next document: replaceDocument;
    // `text` is that document, for the drawn-selection decision)
    this._extensions = (text = doc) => [
      Prec.highest(domHandlers),
      listener,
      showLineNumbers ? lineNumbers() : [],
      highlightSpecialChars(),
      this._selectionDrawing.of(this._selectionDrawingFor(text)),
      markdownLanguage,
      spellcheckSkip,
      codeBlocks,
      this._codeColours ? codeColours : [],
      searchMatches,
      EditorView.lineWrapping,
      EditorView.editorAttributes.of({ class: 'sc-editor-surface sc-editor-cm' }),
      this._spellcheck.of(spellcheckAttributes(this._spellcheckValue)),
      this._placeholder.of(this._placeholderText ? placeholderExtension(this._placeholderText) : []),
      this._readOnly.of(readOnlyExtension(this._readOnlyValue)),
      this._collab.of(localHistory()),
      this._docLinks.of(docLinkChips(this._docLinkResolver)),
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
  /** drawSelection() for a document (a string: the one a state is built with), or nothing for a huge one (isHugeDocument). */
  _selectionDrawingFor(text) {
    const s = String(text ?? '');
    let lines = 1;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lines += 1;
    this._hugeDocument = isHugeDocument({ lines }, this.view ? this.view.defaultLineHeight : 0);
    return this._hugeDocument ? [] : drawSelection();
  }

  replaceDocument(text) {
    this._yjs = null;
    this._valueCache = { doc: null, text: '' };
    this.view.setState(EditorState.create({ doc: String(text ?? ''), extensions: this._extensions(String(text ?? '')) }));
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
  setSelectionRange(start, end, direction = 'none', { scrollIntoView = true } = {}) {
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    const selection = direction === 'backward' ? EditorSelection.single(to, from) : EditorSelection.single(from, to);
    this.view.dispatch({ selection, scrollIntoView });
  }

  // ---- the reader's place (DocumentEditor keeps it across Editor <-> Preview)
  /** The 1-based number of the line at the top of the scroller. */
  topVisibleLine() {
    const view = this.view;
    // (+1 px: a line scrolled exactly to the top edge is that line, not the one above it)
    const height = view.scrollDOM.scrollTop - view.documentPadding.top + 1;
    const block = view.lineBlockAtHeight(Math.max(0, height));
    return view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).number;
  }
  /** Scroll so that line `n` (1-based, clamped) is at the top; the selection stays where it is. */
  scrollToLine(n) {
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, Math.round(Number(n) || 1))));
    this.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
  }
  /** Is the caret (the main selection's head) inside the scroller's visible area? */
  isCursorVisible() {
    const coords = this.view.coordsAtPos(this.view.state.selection.main.head);
    if (!coords) return false;
    const rect = this.view.scrollDOM.getBoundingClientRect();
    return coords.bottom > rect.top && coords.top < rect.bottom;
  }
  /** Bring the caret into view with the least scrolling. */
  scrollCursorIntoView() {
    this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'nearest' }) });
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

  // ---- the document links' chips: the titles they show (a rename, a delete, a sync: a new resolver)
  get docLinkResolver() { return this._docLinkResolver; }
  setDocLinkResolver(resolve) {
    const next = typeof resolve === 'function' ? resolve : null;
    if (this._docLinkResolver === next) return;
    this._docLinkResolver = next;
    this.view.dispatch({ effects: this._docLinks.reconfigure(docLinkChips(next)) });
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
