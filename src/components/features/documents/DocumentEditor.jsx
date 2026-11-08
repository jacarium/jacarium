import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react';
import { homeEndSelection } from '../../../utils/lineCaret';
import { Loader2, Bold, Italic,Info, Lightbulb, MessageSquareWarning, TriangleAlert, OctagonAlert, Code, List, ListOrdered, ListTodo, Link, Quote, Pilcrow, Heading1, Heading2, Heading3, Table, TableOfContents, FileSymlink, Image as ImageIcon, Strikethrough, IndentDecrease, IndentIncrease, Minus, SeparatorHorizontal, File, AlignCenter, PanelTop, PanelBottom, Ellipsis, Plus, Eye, Edit3, BookTemplate, Bot, X, RefreshCw, Check, Trash2, FileCode, Search, Replace, ChevronDown, ChevronUp, Square, Type, Download } from 'lucide-react';
import { CALLOUT_TYPES } from '../../../utils/callouts';
import ToolbarMenu from './ToolbarMenu';
import { useToolbarMenu, useRovingToolbar } from '../../../hooks/toolbarMenu';
import { useMobile } from '../../../contexts/MobileContext';
import { formatShortcut } from '../../../utils/shortcuts';
import { useShortcut, useShortcutHint, useShortcutLabel } from '../../../shortcuts/useShortcut';
import { hasChordModifier } from '../../../shortcuts/registry';
import { BUILTIN_COMMANDS, matchesSlashQuery, slashQueryAt, isInsideCode } from '../../../utils/slashCommands';
import { createDocLinkResolver, docLinkContextAt, searchDocuments, docLinkDirective } from '../../../utils/docLinks';
import { useCaretPopupPosition } from './useCaretPopup.js';
import { previewBlockForLine, previewTopVisibleLine, scrollPreviewToBlock } from '../../../utils/previewPlace';
import { placeKeyFor, rememberPlace, rememberedPlace } from '../../../utils/documentPlaces';

// The GitHub-style callouts the preview renders (src/utils/interactiveMarkdown.js),
// each with its lucide icon (the same drawings the preview paints), for the
// toolbar's Insert callout menu (the slash entries come in with the page's templates)
const CALLOUT_ICONS = { note: Info, tip: Lightbulb, important: MessageSquareWarning, warning: TriangleAlert, caution: OctagonAlert };

/**
 * The toolbar's buttons. ToolbarButton is an icon-only control (the icon
 * is the whole button; the title is the tooltip and aria-label names it).
 * ToolbarMenuButton opens one of the ToolbarMenu dropdowns: it carries the
 * menu's open state (aria-haspopup / aria-expanded) and is the anchor the
 * menu is placed from (`menu` comes from useToolbarMenu); `label`, when
 * given, is shown in place of (or next to) the icon - the Heading button
 * reads the caret line's level: "H2", or the pilcrow for a paragraph
 * (a labelled control shows no icon besides its chevron, the app's
 * text-button rule). Both are module-level so React keeps them mounted
 * across the editor's renders.
 */
const TOOLBAR_BUTTON = 'sc-toolbar-button p-1.5 rounded-sm transition-colors hover:bg-os-card-secondary disabled:opacity-50 inline-flex items-center justify-center gap-1 text-os-text-primary';

function ToolbarButton({ Icon, title, onClick, testId, disabled = false }) {
  return (
    <button type="button" onClick={onClick} className={TOOLBAR_BUTTON} title={title} aria-label={title} data-testid={testId} disabled={disabled}>
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

function ToolbarMenuButton({ Icon, title, label, menu, testId }) {
  // (destructured: a value handed to a `ref` attribute is a ref to the React
  // Compiler, and it would then flag every other read of `menu`)
  const { anchor, toggle, open } = menu;
  return (
    <button
      type="button"
      ref={anchor}
      onClick={toggle}
      className={`${TOOLBAR_BUTTON} ${open ? 'bg-os-card-secondary' : ''}`}
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid={testId}
    >
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      {label ? <span className="text-sm leading-none min-w-[1.25rem] text-center" data-testid={`${testId}-label`}>{label}</span> : null}
      <ChevronDown size={12} aria-hidden="true" className="text-os-text-muted" />
    </button>
  );
}

/** The caret line's block: its heading level (0 = none) and list kind (bullet | numbered | task | null). */
function describeLine(line) {
  const heading = (/^(#{1,6})\s/.exec(line) || ['', ''])[1].length;
  const list = /^\s*[-*+]\s+\[[ xX]\]\s/.test(line) ? 'task' : /^\s*[-*+]\s/.test(line) ? 'bullet' : /^\s*\d+[.)]\s/.test(line) ? 'numbered' : null;
  return { heading, list };
}

/** [start, end) of the whole lines a selection touches. */
function lineBounds(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', Math.max(end, start));
  if (lineEnd < 0) lineEnd = text.length;
  return [lineStart, lineEnd];
}
import { processInteractiveMarkdown, extractDocumentHeadings } from '../../../utils/interactiveMarkdown';
import {
  findMermaidTargets, renderMermaidDiagrams, mermaidThemeForApp, MERMAID_PENDING_SELECTOR,
  serializeDiagramSvg, diagramExportFilename,
} from '../../../utils/mermaidDiagrams';
import { findLatexTargets, renderLatexBlocks, LATEX_PENDING_SELECTOR } from '../../../utils/latexBlocks';
import { streamAiReply, truncationMessage, CONTINUE_PROMPT } from '../../../utils/aiStream';
import { chunkPreviewBlocks, previewRenderDelay, hugePreview } from '../../../utils/previewChunks';
import { useDeferredPreview } from '../../../hooks/useDeferredPreview';
import { Note } from '../../ui/primitives';

/** The preview HTML of a document's text (module-level; the editor binds the [[doc:...]] resolver with useCallback for useDeferredPreview). */
function renderPreviewHtml(text, resolveDocLink = null) {
  // sourceLines: every top-level block carries its source line, for the reader's place across Editor <-> Preview
  return text ? processInteractiveMarkdown(text, { resolveDocLink, sourceLines: true }) : '<p class="text-os-text-muted">No content to preview</p>';
}

const CLOSED_DOC_LINK_MENU = Object.freeze({ visible: false, position: { x: 0, y: 0 }, query: '', start: 0, end: 0, closed: false, selectedIndex: 0 });
import { downloadBlob } from '../../../utils/exportHelpers';
import { useContextMenu } from '../../../hooks/useContextMenu';
import ContextMenu, { ContextMenuItem } from '../../common/menus/ContextMenu';
import TextSelectionMenu from './TextSelectionMenu';
import { readClipboardState, copySelection, cutSelection, pasteInto } from '../../../utils/editorClipboard';
import QuickWorkflow from './QuickWorkflow';
import QuickTasks from './QuickTasks';
import { getUserColor } from '../../../utils/userColors';
import { useYjsText } from '../../../hooks/useYjsText';
import { LIVE_CONTENT_EVENT } from '../../../utils/aiContextSources';
import { getMachineId } from '../../../utils/cloudCentralSync';
import { getSocket } from '../../../utils/cloudWebSocket';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';
import { NO_AI_PROVIDER_MESSAGE, resolveAiRequestSettings, savedAiChatSettings } from '../../../utils/aiRequestSettings';
import MediaLibraryModal from '../../common/modals/MediaLibraryModal';
import { useLocalStorage } from '../../../hooks/useLocalStorage';
import { takePendingEditorFocus, takePendingEditorJump, DOCUMENT_JUMP_EVENT } from '../../../utils/openDocument';
import { lineStartOffset } from '../../../utils/findInFiles';
import { isSpellcheckEnabled, SPELLCHECK_CHANGED_EVENT } from '../../../utils/editorSurface';
import CodeMirrorEditor from './codemirror/CodeMirrorEditor';
import { wordAtPointer } from '../../../utils/editorWords';
import NoticeBanner, { NoticeBannerAction } from '../../common/NoticeBanner';
import { MENU_ICONS } from '../../common/menus/menuIcons';

/**
 * DocumentEditor - Sophisticated markdown editor with toolbar
 *
 * The text surface is CodeMirror 6 (./codemirror/: a virtualised
 * document, so a 50,000-line document types like a short one; the native
 * spell checker on, skipping code, URLs and the [[...]] directives; the
 * live document's Yjs binding and remote carets; its own line numbers,
 * undo history and find-match marks), behind the API of the textarea it
 * replaced (CodeMirrorSurface: value, selectionStart / End,
 * setSelectionRange, focus, ...), which everything below addresses.
 *
 * Features:
 * - Full markdown editing
 * - Rich toolbar with formatting options
 * - Preview mode
 * - Auto-focus
 * - Read-only and locked modes
 * - Slash commands for inserting templates
 * - /ai command for Quick AI
 * - /wf command for Quick Workflow
 * - /task command for Quick Tasks (create a TaskWarrior task)
 * - Collaborative cursors for cloud documents
 */
/**
 * The editor's view place from a document's remembered place (src/utils/documentPlaces.js): the preview opens at
 * the remembered line's block, the editor (when it mounts anew) at that line with the selection as it was; none
 * remembered - a document never opened - and both start at the top.
 */
function viewPlaceFrom(saved) {
  if (!saved) return { toPreview: null, toEditor: null, editorScrollTop: 0, previewScrollTop: 0 };
  // the line is the one currency: an offset put into a freshly built editor state, or a preview whose chunks
  // are still estimates, lands on another line; a line is settled by the view itself
  return {
    toPreview: saved.line ?? null,
    toEditor: saved.line != null || saved.selection ? { line: saved.line ?? null, selection: saved.selection || null, cursorVisible: false, leftAt: null } : null,
    editorScrollTop: saved.editorScrollTop || 0,
    previewScrollTop: saved.previewScrollTop || 0,
  };
}

export default function DocumentEditor({
  documentId,
  document,
  content = '',
  onContentChange,
  templates = BUILTIN_COMMANDS, // the page hands in the built-ins followed by its templates; alone, the built-ins
  locked = false,
  className = '',
  isOnline = true,
  engineTemplates = [],
  onSearchInEngine,
  // what the home-server sync did to THIS document (DocumentsPage):
  // { kind: 'info' | 'warning', text, copyId?, copyTitle? } or null
  syncNotice = null,
  onDismissSyncNotice,
  onOpenDocumentById,
  // the documents a [[doc:...]] link can point at (the page's metadata list:
  // id, stableId, title, category) - the preview's link titles, the editor's
  // chips and the "Link to document" picker read it (src/utils/docLinks.js)
  linkableDocuments = [],
}) {
  // console.log('=== DocumentEditor component rendered ===');
  // console.log('DocumentEditor props - documentId:', documentId, 'document.inCloud:', document?.inCloud, 'content.length:', content.length);

  // The editor surface: CodeMirror behind a ref that answers a textarea's
  // API (CodeMirrorSurface: value, selectionStart / End, setSelectionRange,
  // focus, scrollTop, ...), so the toolbar, the popups, the find bar and
  // the Yjs hook address it as they always did; `managesYjs` says when the
  // surface itself is bound to a live document.
  const [spellcheckOn, setSpellcheckOn] = useState(isSpellcheckEnabled);
  useEffect(() => {
    const onSpellcheck = () => setSpellcheckOn(isSpellcheckEnabled());
    window.addEventListener(SPELLCHECK_CHANGED_EVENT, onSpellcheck);
    return () => window.removeEventListener(SPELLCHECK_CHANGED_EVENT, onSpellcheck);
  }, []);
  const textareaRef = useRef(null);
  const previewRef = useRef(null);
  const slashMenuRef = useRef(null);
  const quickAIInputRef = useRef(null);
  const quickAIResponseRef = useRef(null);
  const quickAIDragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const selectionMenuRef = useRef(null);
  const previousDocumentIdRef = useRef(documentId);
  // the reader's place per document (src/utils/documentPlaces.js), by the document's stable id: recorded as the
  // reader scrolls either view and when a document is left; a document opened again - from the sidebar, a tab,
  // or after a page switch (this editor mounts anew) - shows that place in whichever view it opens
  const placeKey = placeKeyFor(document, documentId);
  const placeKeyRef = useRef(placeKey);
  useLayoutEffect(() => { placeKeyRef.current = placeKey; }, [placeKey]);
  const previousPlaceKeyRef = useRef(placeKey);
  const [previewMode, setPreviewMode] = useState(false);
  // The reader's place across Editor <-> Preview, per document: what was at
  // the top of the view being left (its source line), the view's own scroll
  // offset as the fallback, and the editor's selection (the editor is
  // remounted after a preview, so the caret would otherwise land at the top).
  // Applied by the preview's layout effect once its HTML is in (after the
  // deferred render of a huge document lands) and by onSurface when the
  // editor mounts again; a document switch clears it (a fresh document
  // opens at the top).
  const viewPlaceRef = useRef(viewPlaceFrom(rememberedPlace(placeKey)));   // a mount: the remembered place, if any
  // Leaving the editor for the preview: remember what is at the top (the
  // source line, from CodeMirror's line blocks), the scroll offset, the
  // selection and whether the caret was on screen
  const captureEditorPlace = useCallback(() => {
    const surface = textareaRef.current;
    const place = viewPlaceRef.current;
    if (!surface || !surface.isCodeMirror) return;
    try {
      place.editorScrollTop = surface.scrollTop;
      place.toPreview = surface.topVisibleLine();
      place.toEditor = {
        line: null,
        leftAt: place.toPreview,
        selection: { start: surface.selectionStart, end: surface.selectionEnd, direction: surface.selectionDirection },
        cursorVisible: surface.isCursorVisible(),
      };
      rememberPlace(placeKeyRef.current, { line: place.toPreview, editorScrollTop: place.editorScrollTop, selection: place.toEditor.selection });
    } catch { /* no place to keep */ }
  }, []);
  // Leaving the preview for the editor: the top visible block's source line
  // (the editor scrolls there, the selection untouched), the scroll offset
  const capturePreviewPlace = useCallback(() => {
    const container = previewRef.current;
    const place = viewPlaceRef.current;
    if (!container) return;
    try {
      place.previewScrollTop = container.scrollTop;
      const line = previewTopVisibleLine(container);
      place.toEditor = { ...(place.toEditor || { selection: null, cursorVisible: false }), line };
      rememberPlace(placeKeyRef.current, { line, previewScrollTop: container.scrollTop });
    } catch { /* no place to keep */ }
  }, []);
  // the place follows the reader through the preview: the top block's line and the offset on every scroll
  const previewScrollFrameRef = useRef(null);
  const handlePreviewScroll = useCallback((e) => {
    const container = e.currentTarget;
    if (previewScrollFrameRef.current !== null) return;
    previewScrollFrameRef.current = requestAnimationFrame(() => {
      previewScrollFrameRef.current = null;
      try { rememberPlace(placeKeyRef.current, { line: previewTopVisibleLine(container), previewScrollTop: container.scrollTop }); } catch { /* gone */ }
    });
  }, []);
  // Global override: when on, every document renders in preview mode regardless
  // of its own per-document sessionStorage entry (cycled via the preview button).
  const [previewAllDocuments, setPreviewAllDocuments] = useLocalStorage('previewAllDocuments', false);
  const isPreviewActive = previewMode || previewAllDocuments;

  // Slash command menu state for templates
  const [slashMenu, setSlashMenu] = useState({
    visible: false,
    position: { x: 0, y: 0 },
    query: '',
    slashPosition: 0,
    selectedIndex: 0,
  });

  // The "Link to document" picker ([[doc:...]], src/utils/docLinks.js): opens
  // while "[[doc:" is being typed (the text after it searches the titles)
  // or inside a title-form directive (to convert it to the id form), from
  // the slash command /link and from Insert > Link to document. Enter or a
  // click inserts [[doc:<stableId>]] over start..end; Escape leaves the text.
  const [docLinkMenu, setDocLinkMenu] = useState(CLOSED_DOC_LINK_MENU);
  const docLinkMenuRef = useRef(null);
  const docLinkResolver = useMemo(() => createDocLinkResolver(linkableDocuments), [linkableDocuments]);
  const docLinkResults = useMemo(
    () => (docLinkMenu.visible ? searchDocuments(linkableDocuments, docLinkMenu.query, { excludeId: documentId ?? null }) : []),
    [docLinkMenu.visible, docLinkMenu.query, linkableDocuments, documentId],
  );
  useEffect(() => {
    if (!docLinkMenu.visible || !docLinkMenuRef.current) return;
    docLinkMenuRef.current.querySelector(`[data-doc-link-entry]:nth-child(${docLinkMenu.selectedIndex + 1})`)?.scrollIntoView({ block: 'nearest' });
  }, [docLinkMenu.selectedIndex, docLinkMenu.visible]);
  const renderPreview = useCallback((text) => renderPreviewHtml(text, docLinkResolver), [docLinkResolver]);

  // Quick AI state
  const [showQuickAI, setShowQuickAI] = useState(false);
  const [quickAIInput, setQuickAIInput] = useState('');
  const [quickAIResponse, setQuickAIResponse] = useState('');
  const [quickAILoading, setQuickAILoading] = useState(false);
  // the stream's phase ('waiting' | 'thinking' | 'answering'), the request to cancel, and a reply the token limit
  // cut off (the limit it hit, so the note can name it) - src/utils/aiStream.js
  const [quickAIPhase, setQuickAIPhase] = useState(null);
  const [quickAITruncated, setQuickAITruncated] = useState(false);
  const quickAIAbortRef = useRef(null);
  const quickAIFirstChunkRef = useRef(true);
  const [quickAICursorPos, setQuickAICursorPos] = useState(null);
  const [quickAIPopupPos, setQuickAIPopupPos] = useState({ x: 0, y: 0 });
  const [quickAISelectedText, setQuickAISelectedText] = useState('');
  // "Ask AI About This" (the selection's context menu): the highlighted
  // text, sent with the question as context, and where it sits in the
  // document - the answer lands on a new line right below it
  const [quickAIContext, setQuickAIContext] = useState(null);   // { text, start, end } | null
  const [isDraggingQuickAI, setIsDraggingQuickAI] = useState(false);
  const [backendStatus] = useState('online'); // Assume online for now

  // Quick Workflow state
  const [showQuickWorkflow, setShowQuickWorkflow] = useState(false);
  const [quickWorkflowCursorPos, setQuickWorkflowCursorPos] = useState(null);
  const [quickWorkflowPopupPos, setQuickWorkflowPopupPos] = useState({ x: 0, y: 0 });

  // Quick Tasks state
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [quickTasksCursorPos, setQuickTasksCursorPos] = useState(null);
  const [quickTasksPopupPos, setQuickTasksPopupPos] = useState({ x: 0, y: 0 });

  // Auto-typer state (testing mode only)
  const [isAutoTyping, setIsAutoTyping] = useState(false);
  const autoTypeIntervalRef = useRef(null);

  // Media library state
  const [showMediaLibrary, setShowMediaLibrary] = useState(false);
  const mediaOpener = useRef(null);   // the toolbar button the Media Library was opened from
  // The toolbar (see the "Toolbar" markup below): four dropdowns rendered
  // by ToolbarMenu (Heading, List, Insert, and the phone's "More"), each
  // with its open state and anchor ref; the strip itself is a WAI-ARIA
  // toolbar with a roving tabindex. caretBlock is what the caret's line is
  // (heading level, list kind): the Heading button reads the level, the
  // menus check the current item.
  const headingMenu = useToolbarMenu();
  const listMenu = useToolbarMenu();
  const insertMenu = useToolbarMenu();
  const moreMenu = useToolbarMenu();
  const { isMobile } = useMobile();
  const [caretBlock, setCaretBlock] = useState({ heading: 0, list: null });
  const syncCaretBlock = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const [lineStart, lineEnd] = lineBounds(textarea.value, textarea.selectionStart, textarea.selectionStart);
    const next = describeLine(textarea.value.slice(lineStart, lineEnd));
    setCaretBlock((prev) => (prev.heading === next.heading && prev.list === next.list ? prev : next));
  }, []);

  // Text selection context menu state
  const [selectionMenu, setSelectionMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    text: '',
    clipboard: 'unknown',   // what the clipboard holds, for the menu's Paste: 'text' | 'empty' | 'unknown'
    word: null,             // the word under the pointer: { from, to, text } (what a spelling suggestion replaces)
    spell: null,            // the desktop app's spelling report for it: { misspelledWord, suggestions } (electron/spellcheck.cjs)
  });
  const closeSelectionMenu = useCallback(() => setSelectionMenu({ visible: false, x: 0, y: 0, text: '', clipboard: 'unknown', word: null, spell: null }), []);

  // The spelling suggestions of the desktop app arrive after the menu
  // opened (Chromium reports the right-click to the main process once the
  // page let it through): they join the open menu when they are about the
  // word it was opened on.
  useEffect(() => {
    const subscribe = window.electronAPI?.onEditorContextMenu;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((payload) => {
      if (!payload || typeof payload.misspelledWord !== 'string') return;
      setSelectionMenu((menu) => (menu.visible && menu.word && menu.word.text === payload.misspelledWord ? { ...menu, spell: { misspelledWord: payload.misspelledWord, suggestions: Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 6) : [] } } : menu));
    });
  }, []);

  // Cloud document ownership state
  const [isOwner, setIsOwner] = useState(true);

  // Search and Replace state
  const [showSearchReplace, setShowSearchReplace] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [searchMatches, setSearchMatches] = useState([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const searchInputRef = useRef(null);

  // Yjs collaborative editing (CRDT-based)
  // Use cloudDocumentId (UUID) so it's the same on all machines and unique
  const yjsEnabled = document && document.inCloud && documentId && document.cloudDocumentId;
  const yjsDocumentId = yjsEnabled ? document.cloudDocumentId : null;
  const yjs = useYjsText(
    yjsDocumentId,
    (yjsEnabled && isOnline) ? getSocket() : null,
    textareaRef,
    content,
    onContentChange,
    documentId // Pass local IndexedDB document ID for syncing
  );

  // The server reported it could NOT load this document's persisted Yjs state
  // (corrupted/undecryptable snapshot). We show the local IndexedDB copy
  // read-only with a banner instead of trusting - or re-seeding - the
  // server's empty placeholder. Only meaningful while online: the
  // fully-offline case is the separate, pre-existing read-only path guarded
  // by (document?.inCloud && !isOnline).
  const serverCopyUnavailable = !!(yjsEnabled && isOnline && yjs.serverLoadFailed);

  // The server refused this identity's edit (no Read & Write grant, or one
  // withdrawn while the document was open): read-only from here on, with the
  // same banner a known non-owner gets. The hook has already resynced the
  // document from the server, dropping the refused edit; DocumentsPage turns
  // this announcement into a notice so that does not happen silently.
  // "Add as AI Context" asks the open editors for the document's live text
  // (src/utils/aiContextSources.js): unsaved edits, and a cloud document's
  // Yjs text, which reaches IndexedDB only through a debounced mirror. The
  // editor holds the live text in both modes; the ytext / the prop stand
  // in while the preview hides it.
  useEffect(() => {
    const answer = (e) => {
      const d = e.detail;
      if (!d || d.content !== undefined || documentId == null || String(d.documentId) !== String(documentId)) return;
      const el = textareaRef.current;
      if (el && typeof el.value === 'string') d.content = el.value;
      else if (yjsEnabled && yjs.ytext) d.content = yjs.ytext.toString();
      else if (typeof content === 'string') d.content = content;
    };
    window.addEventListener(LIVE_CONTENT_EVENT, answer);
    return () => window.removeEventListener(LIVE_CONTENT_EVENT, answer);
  }, [documentId, yjsEnabled, yjs.ytext, content]);

  const writeRejected = !!(yjsEnabled && yjs.writeRejected);
  useEffect(() => {
    if (!writeRejected) return;
    window.dispatchEvent(new CustomEvent('sharedWriteRejected', {
      detail: { kind: 'document', title: document?.title || '' }
    }));
  }, [writeRejected, document?.title]);

  // Debug: log when content prop changes
  // useEffect(() => {
  //   console.log('[DocumentEditor] Content prop changed, new length:', content.length);
  // }, [content]);

  // Debug: log when Yjs cursors change
  // useEffect(() => {
  //   if (yjsEnabled && yjs.cursors) {
  //     console.log('[DocumentEditor] Yjs cursors changed:', yjs.cursors);
  //   }
  // }, [yjsEnabled, yjs.cursors]);

  // Filter the "/" popup's entries by the query (the list the page hands in
  // starts with the built-in commands, src/utils/slashCommands.js)
  // memoised: the scroll-into-view effect below depends on it, and a list rebuilt on every render would run that
  // effect on every render while the popup is open
  const filteredTemplates = useMemo(
    () => (slashMenu.query ? templates.filter(t => matchesSlashQuery(t, slashMenu.query)) : templates),
    [templates, slashMenu.query],
  );

  // Reset scroll position and restore preview mode when switching documents
  useEffect(() => {
    // Check if we actually switched documents (not just a re-render)
    const documentChanged = previousDocumentIdRef.current !== documentId;

    if (documentChanged && textareaRef.current) {
      // Sync the editor's text when switching documents (not during typing!)
      // For cloud documents: Set initial content from IndexedDB, then let Yjs override when synced
      // For local documents: always sync
      console.log('[DocumentEditor] Document changed - yjsEnabled:', yjsEnabled, 'yjs.ytext:', !!yjs.ytext, 'yjs.isReady:', yjs?.isReady, 'content.length:', content?.length || 0);

      // Always start with IndexedDB content when switching documents
      // Yjs will update the editor when it's ready with the server content
      const currentContent = content;

      // A fresh editor state for the new document (no undo history of the
      // previous one). Local documents and offline cloud documents show the
      // IndexedDB copy; a cloud document shows it too until the hook is
      // ready and the surface binds to the live text (CodeMirrorEditor).
      console.log('[DocumentEditor] Syncing document content to the editor (doc change):', currentContent?.length || 0, 'chars');
      textareaRef.current.replaceDocument(currentContent || '');
      // the document opened: back at its remembered place, the selection as it was; a new one starts at the top
      const saved = rememberedPlace(placeKeyRef.current);
      if (saved && textareaRef.current.isCodeMirror) {
        try {
          const s = textareaRef.current;
          if (saved.selection) s.setSelectionRange(saved.selection.start, saved.selection.end, saved.selection.direction, { scrollIntoView: false });
          if (saved.line != null) s.scrollToLine(saved.line);
        } catch { /* a place that no longer fits the document */ }
        // applied here, to the mounted editor: a later mount must not apply it again
        viewPlaceRef.current.toEditor = null;
      }
    }

    // Restore preview mode for this document from sessionStorage
    if (documentChanged) {
      if (documentId) {
        try {
          const savedStates = sessionStorage.getItem('documentPreviewModes');
          if (savedStates) {
            const previewModes = JSON.parse(savedStates);
            // Intentional restore of persisted per-document preview mode
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPreviewMode(previewModes[documentId] || false);
          } else {
            setPreviewMode(false);
          }
        } catch {
          setPreviewMode(false);
        }
      } else {
        setPreviewMode(false);
      }

      // Update the ref for next comparison
      previousDocumentIdRef.current = documentId;
      previousPlaceKeyRef.current = placeKey;
    }
    // content/yjsEnabled intentionally trigger re-evaluation; other reads are
    // per-document snapshots
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, content, yjsEnabled, yjs?.isReady]); // Include yjs.isReady to sync when Yjs loads

  // Resolve attachment: URLs in preview mode
  // Uses MutationObserver to catch re-renders that don't change content
  // (e.g. parent state changes like context menus that rebuild the DOM)
  useEffect(() => {
    if (!isPreviewActive || !previewRef.current) return;

    const resolveImages = () => {
      if (previewRef.current) {
        const unresolved = previewRef.current.querySelectorAll('img[data-attachment]');
        if (unresolved.length > 0) {
          import('../../../utils/interactiveMarkdown').then(({ resolveAttachmentImages }) => {
            resolveAttachmentImages(previewRef.current);
          });
        }
      }
    };

    // Resolve on initial render / content change
    const timer = setTimeout(resolveImages, 100);

    // Watch for DOM rebuilds that produce new unresolved attachment images
    const observer = new MutationObserver(() => {
      if (previewRef.current?.querySelector('img[data-attachment]')) {
        resolveImages();
      }
    });
    observer.observe(previewRef.current, { childList: true, subtree: true });

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [isPreviewActive, content]);

  // Add click handlers to images in preview to open lightbox
  useEffect(() => {
    if (isPreviewActive && previewRef.current) {
      const images = previewRef.current.querySelectorAll('img');

      const handleImageClick = (e) => {
        const img = e.target;
        if (img.tagName === 'IMG' && img.src) {
          // Create lightbox overlay
          const lightbox = window.document.createElement('div');
          lightbox.className = 'fixed inset-0 bg-black/90 flex items-center justify-center z-100';
          lightbox.style.cursor = 'pointer';

          // Create close button
          const closeBtn = window.document.createElement('button');
          closeBtn.innerHTML = '×';
          closeBtn.className = 'absolute top-4 right-4 text-white text-4xl font-bold hover:text-white/70 transition-colors';
          closeBtn.style.width = '50px';
          closeBtn.style.height = '50px';
          closeBtn.onclick = () => lightbox.remove();

          // Create image
          const lightboxImg = window.document.createElement('img');
          lightboxImg.src = img.src;
          lightboxImg.alt = img.alt;
          lightboxImg.className = 'max-w-[90vw] max-h-[90vh] object-contain';
          lightboxImg.style.cursor = 'default';
          lightboxImg.onclick = (e) => e.stopPropagation();

          // Add image info if available. The alt text is document content
          // (DOMPurify keeps the attribute verbatim, and documents are synced
          // from other machines), so it must be inserted as TEXT - never via
          // innerHTML, which would re-parse it as HTML (stored XSS).
          if (img.alt) {
            const info = window.document.createElement('div');
            info.className = 'absolute top-4 left-4 bg-black/50 px-4 py-2 rounded-sm text-white';
            const caption = window.document.createElement('p');
            caption.className = 'text-sm font-medium';
            caption.textContent = img.alt;
            info.appendChild(caption);
            lightbox.appendChild(info);
          }

          lightbox.appendChild(closeBtn);
          lightbox.appendChild(lightboxImg);
          lightbox.onclick = () => lightbox.remove();

          window.document.body.appendChild(lightbox);
        }
      };

      images.forEach(img => {
        img.style.cursor = 'pointer';
        img.addEventListener('click', handleImageClick);
      });

      return () => {
        images.forEach(img => {
          img.removeEventListener('click', handleImageClick);
        });
      };
    }
  }, [isPreviewActive, content]);

  // Check document ownership for cloud documents
  useEffect(() => {
    async function checkOwnership() {
      if (document && document.inCloud) {
        const { isDocumentOwner } = await import('../../../utils/cloudDocuments');
        const owner = await isDocumentOwner(document);
        // The server has the last word: a refused edit means no write access
        // whatever the local copy's permissions say
        setIsOwner(owner && !writeRejected);
      } else {
        setIsOwner(true); // Local documents are always editable
      }
    }
    checkOwnership();
  }, [document, writeRejected]);

  // Set user info for Yjs awareness (username and color)
  useEffect(() => {
    if (!yjsEnabled || !yjs.setUserInfo) {
      return;
    }

    getMachineId().then(machineId => {
      const userColor = getUserColor(machineId);
      // Extract just the username from machineId (e.g., "user1" from "user1@machine-alice")
      const username = machineId.split('@')[0] || machineId;

      // console.log('[DocumentEditor] Setting Yjs user info - username:', username, 'color:', userColor, 'full machineId:', machineId);
      yjs.setUserInfo(username, userColor);
    });
  }, [yjsEnabled, yjs]);

  // The caret moved (a click, a key, a selection change): the toolbar's
  // Heading / List state follows it. (A live document's peers see the
  // selection through y-codemirror.next, which publishes it itself.)
  const handleCursorMove = () => {
    syncCaretBlock();
  };

  // The caret line's block after any content change (toolbar actions move
  // the caret in a timeout, after the new content is in the editor)
  useEffect(() => {
    const timer = setTimeout(syncCaretBlock, 0);
    return () => clearTimeout(timer);
  }, [content, yjs.content, syncCaretBlock]);

  // Live version counter for the shared Yjs CRDT: bumped on every ytext change (local
  // keystrokes AND remote collaborators' edits). useYjsText intentionally never updates
  // React state after init (the surface is bound to the Y.Text), so for cloud docs neither the
  // content prop nor yjs.content reflects live typing - yjs.ytext.toString() is the
  // only live source. Since ytext is a mutable object with a stable reference, this
  // counter is the cache-buster that lets memos/effects recompute on CRDT changes.
  // Always on while Yjs is enabled: the gutter line numbers need it unconditionally,
  // and the markdown preview memo reuses it (its isPreviewActive early-exit keeps
  // the hidden-preview path cheap).
  const [yjsContentVersion, setYjsContentVersion] = useState(0);
  useEffect(() => {
    if (!yjsEnabled || !yjs.ytext) return;
    const ytext = yjs.ytext;
    const bumpVersion = () => setYjsContentVersion(v => v + 1);
    ytext.observe(bumpVersion);
    // Bump once on attach so consumers reflect any edits that happened before observing
    bumpVersion();
    return () => ytext.unobserve(bumpVersion);
  }, [yjsEnabled, yjs.ytext]);

  // Listen for toggle preview mode event (from context menu)
  useEffect(() => {
    function handleTogglePreviewMode(event) {
      if (event.detail.documentId === documentId) {
        const newPreviewMode = event.detail.enable !== undefined ? event.detail.enable : !previewMode;
        if (newPreviewMode && !isPreviewActive) captureEditorPlace();
        else if (!newPreviewMode && isPreviewActive) capturePreviewPlace();
        setPreviewMode(newPreviewMode);
        // Save to sessionStorage
        if (documentId) {
          try {
            const savedStates = sessionStorage.getItem('documentPreviewModes');
            const previewModes = savedStates ? JSON.parse(savedStates) : {};
            previewModes[documentId] = newPreviewMode;
            sessionStorage.setItem('documentPreviewModes', JSON.stringify(previewModes));
          } catch (error) {
            console.error('Error saving preview mode:', error);
          }
        }
      }
    }

    window.addEventListener('togglePreviewMode', handleTogglePreviewMode);
    return () => window.removeEventListener('togglePreviewMode', handleTogglePreviewMode);
  }, [documentId, previewMode, isPreviewActive, captureEditorPlace, capturePreviewPlace]);

  // Auto-focus content on mount
  const caretToEndAfterFocusRef = useRef(false);
  useEffect(() => {
    if (textareaRef.current && !locked && !isPreviewActive) {
      textareaRef.current.focus({ preventScroll: true });
      if (caretToEndAfterFocusRef.current) {
        // Deferred half of the open-from-elsewhere request below: the
        // editor only exists now that preview mode is off.
        caretToEndAfterFocusRef.current = false;
        const end = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(end, end);
      }
    }
  }, [locked, isPreviewActive]);

  // Open-from-elsewhere requests (Tasks page "Create Document In", see
  // src/utils/openDocument.js): when this editor mounts or switches to the
  // requested document, leave preview mode and focus the body with the caret
  // at the end so the user can type straight away. The request is consumed
  // exactly once, by whichever editor shows the document first.
  useEffect(() => {
    if (!documentId || !takePendingEditorFocus(documentId)) return;
    if (locked) return;
    if (isPreviewActive) {
      // Same as the toolbar's PREVIEW-ALL -> OFF / PREVIEW -> OFF clicks the
      // user would otherwise have to make before typing.
      capturePreviewPlace();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewMode(false);
      if (previewAllDocuments) setPreviewAllDocuments(false);
      try {
        const savedStates = sessionStorage.getItem('documentPreviewModes');
        const previewModes = savedStates ? JSON.parse(savedStates) : {};
        previewModes[documentId] = false;
        sessionStorage.setItem('documentPreviewModes', JSON.stringify(previewModes));
      } catch (error) {
        console.error('Error saving preview mode:', error);
      }
      // The editor mounts on the next render; the auto-focus effect above
      // focuses it when isPreviewActive flips and moves the caret to the end.
      caretToEndAfterFocusRef.current = true;
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    // Only a document switch can carry a new request; the mode flags are
    // read at that moment on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // Jump-to-line requests (Find in Files "Open in New Tab", see
  // src/utils/openDocument.js requestEditorJumpToLine): select the matched
  // range on the target line and center it, the way Ctrl+F's "find next"
  // does. A request for a document this editor is switching to is taken
  // from the pending store on the switch; a request for the document it is
  // ALREADY showing arrives as a window event (no switch happens then).
  const pendingJumpRef = useRef(null);
  const [jumpVersion, setJumpVersion] = useState(0);
  // scrollToMatch (the Ctrl+F centering helper) is declared further down;
  // the jump runs from a timeout, so it goes through a ref.
  const scrollToMatchRef = useRef(null);

  useEffect(() => {
    if (!documentId) return undefined;
    function handleJumpEvent(e) {
      const { documentId: id, line, range } = e.detail || {};
      if (id !== documentId) return;
      takePendingEditorJump(documentId); // consumed here, not by a later switch
      pendingJumpRef.current = { line, range };
      setJumpVersion((v) => v + 1);
    }
    window.addEventListener(DOCUMENT_JUMP_EVENT, handleJumpEvent);
    return () => window.removeEventListener(DOCUMENT_JUMP_EVENT, handleJumpEvent);
  }, [documentId]);

  useEffect(() => {
    if (!documentId) return undefined;
    const taken = takePendingEditorJump(documentId);
    if (taken) pendingJumpRef.current = taken;
    const target = pendingJumpRef.current;
    if (!target) return undefined;
    if (isPreviewActive) {
      // Leave preview mode first; this effect re-runs once the editor is
      // mounted (isPreviewActive flips) and applies the jump then.
      capturePreviewPlace();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewMode(false);
      if (previewAllDocuments) setPreviewAllDocuments(false);
      try {
        const savedStates = sessionStorage.getItem('documentPreviewModes');
        const previewModes = savedStates ? JSON.parse(savedStates) : {};
        previewModes[documentId] = false;
        sessionStorage.setItem('documentPreviewModes', JSON.stringify(previewModes));
      } catch (error) {
        console.error('Error saving preview mode:', error);
      }
      return undefined;
    }
    // The document-switch effect above has just synced the editor's text;
    // defer one tick so the position measurement sees the new content.
    const timer = setTimeout(() => {
      if (pendingJumpRef.current !== target) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const value = textarea.value;
      const lineStart = lineStartOffset(value, target.line);
      const newline = value.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? value.length : newline;
      const [rs, re] = Array.isArray(target.range) ? target.range : [0, 0];
      const selStart = Math.min(lineStart + Math.max(0, rs), lineEnd);
      const selEnd = Math.max(selStart, Math.min(lineStart + Math.max(0, re), lineEnd));
      pendingJumpRef.current = null;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selStart, selEnd);
      if (scrollToMatchRef.current) scrollToMatchRef.current({ start: selStart, end: selEnd });
    }, 0);
    return () => clearTimeout(timer);
    // scrollToMatch/the mode setters are stable per render; only a switch,
    // a preview toggle or a new request should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, isPreviewActive, jumpVersion]);

  // Sync the editor when cloud document goes offline (yjs.ytext becomes null)
  // OR when content changes while offline (e.g., loading from IndexedDB on mount)
  useEffect(() => {
    console.log('[DocumentEditor] Offline sync check - yjsEnabled:', yjsEnabled, 'yjs.ytext:', !!yjs.ytext, 'content.length:', content?.length || 0, 'hasTextarea:', !!textareaRef.current);
    if (yjsEnabled && !yjs.ytext && textareaRef.current) {
      // Cloud document is offline - sync content from IndexedDB to the editor
      // This handles: going offline, staying offline, and initial mount when offline
      const currentContent = content || '';
      const currentTextareaValue = textareaRef.current.value || '';
      console.log('[DocumentEditor] Cloud doc offline - syncing content. Current textarea:', currentTextareaValue.length, 'chars, new content:', currentContent.length, 'chars');
      if (textareaRef.current.value !== currentContent) {
        console.log('[DocumentEditor] ✓ Syncing offline cloud document content to the editor:', currentContent.length, 'chars');
        textareaRef.current.value = currentContent;
      } else {
        console.log('[DocumentEditor] Content already synced, skipping');
      }
    }
  }, [yjsEnabled, yjs.ytext, content]);

  // Sync the editor's text when switching from preview to edit mode for cloud documents
  useEffect(() => {
    if (!isPreviewActive && yjsEnabled && textareaRef.current) {
      // When switching to edit mode, sync the editor with the current content
      // (a new view: the binding re-attaches through CodeMirrorEditor once it mounts)
      // Online: use yjs.ytext (live CRDT), Offline: use content prop (from IndexedDB)
      // Server copy unavailable: ytext is the server's EMPTY degraded
      // placeholder, not real content - keep showing the IndexedDB copy.
      const currentContent = (yjs.ytext && !serverCopyUnavailable) ? yjs.ytext.toString() : content;
      if (textareaRef.current.value !== currentContent) {
        textareaRef.current.value = currentContent;
      }
    }
  }, [isPreviewActive, yjsEnabled, yjs.ytext, content, serverCopyUnavailable]);

  // Reset selected index when query changes
  useEffect(() => {
    // Intentional keyboard-selection reset when the slash-menu query changes
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlashMenu(prev => ({ ...prev, selectedIndex: 0 }));
  }, [slashMenu.query]);

  // Scroll selected item into view in slash menu
  useEffect(() => {
    if (!slashMenu.visible || !slashMenuRef.current) return;

    const popup = slashMenuRef.current;
    const selected = filteredTemplates[slashMenu.selectedIndex];
    const selectedButton = selected ? popup.querySelector(`[data-slash-entry="${selected.id}"]`) : null;

    if (selectedButton) {
      // instant, like the doc-link picker: a smooth scroll is an animation the next ArrowDown interrupts and a
      // slow or busy machine has not finished when the user (or a test) looks - the highlighted entry must be
      // in view the moment it is highlighted
      selectedButton.scrollIntoView({ block: 'nearest' });
    }
    // also when the list changes (the query typed): the selection resets to the first entry, which may sit above
    // a popup the user had scrolled - bring it back into view
  }, [slashMenu.selectedIndex, slashMenu.visible, filteredTemplates]);

  // The caret popups' placement (useCaretPopup.js): the caret's rect from the
  // surface, the editor's corner when the caret is scrolled out of view
  const caretRect = () => {
    const surface = textareaRef.current;
    if (!surface) return null;
    const coords = surface.coordsAtPos(surface.selectionStart);
    if (coords) return coords;
    const rect = surface.getBoundingClientRect();
    return { left: rect.left + 20, top: rect.top + 20, bottom: rect.top + 20 };
  };
  const slashMenuOpen = slashMenu.visible && !locked && !isPreviewActive;
  const docLinkMenuOpen = docLinkMenu.visible && !locked && !isPreviewActive;
  useCaretPopupPosition(slashMenuRef, { open: slashMenuOpen, caretRect, deps: [slashMenu.query, filteredTemplates.length] });
  useCaretPopupPosition(docLinkMenuRef, { open: docLinkMenuOpen, caretRect, deps: [docLinkMenu.query, docLinkMenu.closed, docLinkResults.length] });

  // Handle Quick AI popup dragging
  useEffect(() => {
    if (!isDraggingQuickAI) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - quickAIDragStartRef.current.x;
      const deltaY = e.clientY - quickAIDragStartRef.current.y;

      const newLeft = quickAIDragStartRef.current.left + deltaX;
      const newTop = quickAIDragStartRef.current.top + deltaY;

      setQuickAIPopupPos({ x: newLeft, y: newTop });
    }

    function handleMouseUp() {
      setIsDraggingQuickAI(false);
      window.document.body.style.cursor = '';
      window.document.body.style.userSelect = '';
    }

    window.document.addEventListener('mousemove', handleMouseMove);
    window.document.addEventListener('mouseup', handleMouseUp);

    window.document.body.style.cursor = 'grabbing';
    window.document.body.style.userSelect = 'none';

    return () => {
      window.document.removeEventListener('mousemove', handleMouseMove);
      window.document.removeEventListener('mouseup', handleMouseUp);
      window.document.body.style.cursor = '';
      window.document.body.style.userSelect = '';
    };
  }, [isDraggingQuickAI]);

  // Close selection menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (selectionMenuRef.current && !selectionMenuRef.current.contains(event.target)) {
        closeSelectionMenu();
      }
    }

    if (selectionMenu.visible) {
      window.document.addEventListener('mousedown', handleClickOutside);
      return () => window.document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [selectionMenu.visible, closeSelectionMenu]);

  // Every programmatic edit (the toolbar, the slash commands, the panels,
  // replace) ends here with the whole new text and where the caret goes:
  // a CodeMirror surface takes it as one transaction (its history and, for
  // a live document, the Y.Text through the binding), then the owner of
  // the document is told - the Y.Text through the hook for the textarea,
  // or the parent's state for a local document (no-op for a bound
  // CodeMirror surface, which already did the Yjs part)
  const applyEdit = (newText, caret) => {
    const surface = textareaRef.current;
    if (surface) {
      surface.value = newText;
      if (surface.managesYjs) return;
    }
    if (yjsEnabled && yjs.updateContent) {
      yjs.updateContent(newText, caret);
    } else if (onContentChange) {
      onContentChange({ target: { value: newText } });
    }
  };

  const insertMarkdown = (before, after = '', placeholder = '') => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selectedText = text.substring(start, end) || placeholder;

    const newText =
      text.substring(0, start) +
      before +
      selectedText +
      after +
      text.substring(end);

    const newPos = start + before.length + selectedText.length + after.length;

    applyEdit(newText, newPos);

    // Restore selection
    setTimeout(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const insertTable = () => {
    const tableMarkdown = '\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n';
    insertMarkdown(tableMarkdown, '');
  };

  const insertImage = (filename) => {
    if (locked || isPreviewActive) return;
    const markdown = `![${filename}](attachment:${filename})`;
    insertMarkdown(markdown, '', '');
  };

  // Indent / outdent every line the selection touches (a collapsed caret:
  // its line) by two spaces, keeping the selection on those lines. Also
  // what Tab / Shift+Tab do inside a list (handleKeyDown).
  const indentText = (increase = true) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const [lineStart, lineEnd] = lineBounds(text, start, end);
    const lines = text.substring(lineStart, lineEnd).split('\n');
    const modifiedLines = lines.map((line) => (increase ? '  ' + line : line.replace(/^ {1,2}/, '')));
    const replaced = modifiedLines.join('\n');
    const newText = text.substring(0, lineStart) + replaced + text.substring(lineEnd);
    const delta = replaced.length - (lineEnd - lineStart);
    const firstDelta = modifiedLines[0].length - lines[0].length;
    const newStart = Math.max(lineStart, start + firstDelta);
    const newEnd = Math.max(newStart, end + delta);

    applyEdit(newText, newEnd);
    setTimeout(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(newStart, newEnd);
    }, 0);
  };

  // Replace [from, to) of the text and put the caret (or a selection) after it
  const replaceRange = (from, to, replacement, selectStart, selectEnd = selectStart) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value;
    const newText = text.substring(0, from) + replacement + text.substring(to);
    applyEdit(newText, selectEnd);
    setTimeout(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selectStart, selectEnd);
    }, 0);
  };

  // The caret line's heading level (0 = a paragraph): an existing "#" prefix
  // is replaced, not stacked. The Heading menu (no keyboard chord: typing
  // "#", "##" or "###" is the shortcut).
  const setHeadingLevel = (level) => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value;
    const [lineStart, lineEnd] = lineBounds(text, textarea.selectionStart, textarea.selectionStart);
    const line = text.substring(lineStart, lineEnd);
    const stripped = line.replace(/^#{1,6}\s+/, '');
    const body = stripped || (level ? `Heading ${level}` : '');
    const newLine = level ? `${'#'.repeat(level)} ${body}` : body;
    const caret = lineStart + newLine.length;
    // an empty line gets a placeholder title, selected so typing replaces it
    replaceRange(lineStart, lineEnd, newLine, stripped ? caret : lineStart + newLine.length - body.length, caret);
  };

  // The list kind of every line the selection touches: an existing marker
  // (bullet, numbered, task) is replaced; choosing the line's current kind
  // removes the marker. List menu.
  const setListKind = (kind) => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const [lineStart, lineEnd] = lineBounds(text, start, end);
    const lines = text.substring(lineStart, lineEnd).split('\n');
    const marker = (n) => (kind === 'bullet' ? '- ' : kind === 'numbered' ? `${n}. ` : '- [ ] ');
    const allAlready = lines.every((line) => describeLine(line).list === kind);
    const newLines = lines.map((line, i) => {
      const indent = (/^\s*/.exec(line) || [''])[0];
      const rest = line.slice(indent.length).replace(/^(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '');
      if (allAlready) return indent + rest;
      return indent + marker(i + 1) + (rest || (lines.length === 1 && !rest ? '' : rest));
    });
    const replaced = newLines.join('\n');
    const caret = lineStart + replaced.length;
    replaceRange(lineStart, lineEnd, replaced, lines.length === 1 ? caret : lineStart, caret);
  };

  // Inline code for a selection on one line, a fenced block for one that
  // spans lines (or an empty selection at a line's start): the toolbar's one
  // "Code" button; the Insert menu still offers the block explicitly.
  const insertCode = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const selected = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    if (selected.includes('\n')) insertCodeBlock();
    else insertMarkdown('`', '`', 'code');
  };

  // The PDF layout directives (src/utils/interactiveMarkdown.js: the
  // preview shows an inert marker, the PDF export acts on them).
  // A standalone one ([[pagebreak]], [[blankpage]]) goes on a paragraph of
  // its own; a wrapping one ([[centerpage]], [[header]], [[footer]]) wraps
  // the selection, or a placeholder to type over, each tag on its own line.
  const insertPdfDirective = (directive) => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value;
    const start = textarea.selectionStart;
    const before = text.substring(0, start);
    const after = text.substring(textarea.selectionEnd);
    const prefix = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const block = `${prefix}${directive}${suffix}`;
    replaceRange(start, textarea.selectionEnd, block, start + block.length);
  };
  const wrapPdfDirective = (kind, placeholder) => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = text.substring(start, end);
    const body = selected || placeholder;
    const before = text.substring(0, start);
    const after = text.substring(end);
    const prefix = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const open = `${prefix}[[${kind}]]\n`;
    const block = `${open}${body}\n[[/${kind}]]${suffix}`;
    // no selection: the placeholder is selected, so typing replaces it
    const bodyStart = start + open.length;
    replaceRange(start, end, block, selected ? start + block.length : bodyStart, selected ? start + block.length : bodyStart + body.length);
  };

  const insertLink = () => {
    insertMarkdown('[', '](url)', 'link text');
  };

  const insertHorizontalRule = () => {
    insertMarkdown('\n---\n', '');
  };

  // A GitHub-style callout around the selection (each selected line quoted),
  // or an empty one to type into; on its own paragraph. The preview renders
  // it (src/utils/interactiveMarkdown.js); the text stays plain GitHub syntax.
  const insertCallout = (type) => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.substring(start, end);
    const body = (selected || `${CALLOUT_TYPES.find((c) => c.type === type)?.label || 'Note'} text`).split('\n').map((line) => `> ${line}`).join('\n');
    const before = text.substring(0, start);
    const after = text.substring(end);
    const prefix = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const block = `${prefix}> [!${type.toUpperCase()}]\n${body}${suffix}`;
    const newText = before + block + after;
    // the body selected, so typing replaces the placeholder
    const bodyStart = before.length + prefix.length + `> [!${type.toUpperCase()}]\n> `.length;
    const bodyEnd = before.length + block.length - suffix.length;
    applyEdit(newText, bodyEnd);
    setTimeout(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selected ? bodyEnd : bodyStart, bodyEnd);
    }, 0);
  };

  const insertTableOfContents = () => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const text = textarea.value;

    // Make sure the ToC heading starts on its own line
    const atLineStart = start === 0 || text.charAt(start - 1) === '\n';
    const prefix = atLineStart ? '' : '\n\n';
    const tocHeading = '# Table of Contents\n\n';

    // Derive the anchor ids by actually running the render pipeline on the
    // document as it will exist AFTER insertion: splice the ToC heading in at
    // the cursor position (so it participates in slug duplicate-counting at
    // its real document position) and read the ids the renderer assigns.
    // Never re-implement the slug logic here - it would drift from
    // interactiveMarkdown.js and produce links that don't match the rendered
    // heading ids.
    const splicedText =
      text.substring(0, start) + prefix + tocHeading + text.substring(start);
    const headings = extractDocumentHeadings(splicedText);

    // The ToC must only list headings that come AFTER its own insertion
    // point - not itself, and not e.g. a [[centerpage]] cover title placed
    // above it. Locate our spliced-in heading by counting the headings that
    // already exist strictly before the cursor: the pre-cursor text is
    // byte-identical between this isolated render and the spliced render,
    // so that count is exactly the index of our "Table of Contents" heading
    // in `headings` (duplicate-slug disambiguation only changes ids, never
    // how many headings render). Guard on the entry actually being ours:
    // in pathological spots (cursor inside an unclosed code fence) the
    // spliced heading never renders as a heading, and then there is no
    // self-entry to drop.
    const headingsBeforeCursor = extractDocumentHeadings(text.substring(0, start)).length;
    const selfHeading = headings[headingsBeforeCursor];
    const isSelfHeading =
      selfHeading && selfHeading.level === 1 && selfHeading.text === 'Table of Contents';
    const tocEntries = headings.slice(headingsBeforeCursor + (isSelfHeading ? 1 : 0));

    // Escape characters that would break the markdown link label
    const escapeLabel = (label) => label.replace(/([\\[\]])/g, '\\$1');

    const listLines = tocEntries.map(({ level, text: headingText, id }) => {
      const indent = '  '.repeat(Math.max(0, level - 1));
      return `${indent}- [${escapeLabel(headingText)}](#${id})`;
    });

    // Blank line after the list so following content isn't absorbed into it
    const rest = text.substring(textarea.selectionEnd);
    const suffix = rest.startsWith('\n\n') ? '' : rest.startsWith('\n') ? '\n' : '\n\n';

    // The [[toc]] wrapper marks this block as a generated Table of
    // Contents: the PDF export finds the wrapper and adds right-aligned
    // target page numbers to its entries (export-only; the preview shows
    // the plain link list). Deliberately a marker, not a heuristic - the
    // export must never guess which lists are ToCs.
    // No headings after the insertion point -> just the heading, no list
    // (and no stray extra blank line).
    const listBlock = listLines.length > 0 ? listLines.join('\n') + '\n\n' : '';
    insertMarkdown(
      prefix + '[[toc]]\n\n' + tocHeading + listBlock + '[[/toc]]' + suffix,
      ''
    );
  };

  const insertCodeBlock = () => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);

    // Insert code block with selected text or placeholder
    const codeContent = selectedText || 'code here';
    const before = '\n```\n';
    const after = '\n```\n';

    insertMarkdown(before, after, codeContent);
  };

  // Save the per-document preview mode to the sessionStorage map
  const savePreviewModeForDocument = (newPreviewMode) => {
    if (!documentId) return;
    try {
      const savedStates = sessionStorage.getItem('documentPreviewModes');
      const previewModes = savedStates ? JSON.parse(savedStates) : {};
      previewModes[documentId] = newPreviewMode;
      sessionStorage.setItem('documentPreviewModes', JSON.stringify(previewModes));
    } catch (error) {
      console.error('Error saving preview mode:', error);
    }
  };

  // 3-state cycle: OFF -> PREVIEW (per-document) -> PREVIEW-ALL (global) -> OFF
  // The PREVIEW -> PREVIEW-ALL step is time-gated: only a second click within
  // 1s of entering PREVIEW escalates to the global override; a later click
  // just toggles back to code view (OFF).
  const previewEnteredAtRef = useRef(0);

  const togglePreview = () => {
    if (previewAllDocuments) {
      // PREVIEW-ALL -> OFF: disable the global override and explicitly reset
      // the current document to code view so it doesn't re-enable on switch
      capturePreviewPlace();
      setPreviewAllDocuments(false);
      setPreviewMode(false);
      savePreviewModeForDocument(false);
    } else if (previewMode) {
      if (Date.now() - previewEnteredAtRef.current < 1000) {
        // PREVIEW -> PREVIEW-ALL: quick second click turns on the global override
        setPreviewAllDocuments(true);
      } else {
        // PREVIEW -> OFF: too late for the escalation, act as a plain toggle
        capturePreviewPlace();
        setPreviewMode(false);
        savePreviewModeForDocument(false);
      }
    } else {
      // OFF -> PREVIEW: per-document preview, persisted per document
      captureEditorPlace();
      previewEnteredAtRef.current = Date.now();
      setPreviewMode(true);
      savePreviewModeForDocument(true);
    }
  };

  // The "/" popup: one list of the built-in commands (the callouts, Quick
  // Workflow / AI / Task - src/utils/slashCommands.js) and the templates,
  // filtered by what follows the slash. It opens only where "/" starts a
  // word (the line's start or after whitespace) and not inside code, closes
  // when nothing matches, when a second "/" or a space is typed (a path like
  // /usr/local/note is text), and NOTHING runs on typing alone: Enter or a
  // click runs the highlighted entry (handleKeyDown / insertTemplate),
  // Escape closes it and leaves the text as typed. The old immediate
  // triggers (typing "/wf", "/ai" or "/task" opened their panel at once, so
  // a path containing them could not be typed) are gone.
  // Where a popup opened from the caret anchors (the surface knows the
  // caret's screen position; the editor's corner when the caret is scrolled
  // out of view). useCaretPopupPosition places the popup from the live
  // caret: below its line, above it near the bottom of the window, capped
  // and scrolling when neither side has the room.
  const caretPopupAnchor = (surface, cursorPos) => {
    const coords = surface.coordsAtPos(cursorPos);
    if (coords) return { x: coords.left, y: coords.bottom + 10 };
    const rect = surface.getBoundingClientRect();
    return { x: rect.left + 20, y: rect.top + 30 };
  };

  // The document picker at the caret, over the directive at start..end
  // (closed: a title-form directive to convert; open: "[[doc:" plus what is typed after it)
  const openDocLinkMenu = (surface, cursorPos, { start, end, query, closed }) => {
    setDocLinkMenu((prev) => ({
      visible: true,
      position: caretPopupAnchor(surface, cursorPos),
      query, start, end, closed,
      selectedIndex: prev.visible && prev.query === query ? prev.selectedIndex : 0,
    }));
  };

  // Insert the id-form directive of `doc` over the picker's range (the typed
  // "[[doc:query", or the whole title-form directive it converts); the caret
  // lands after the link, which the editor then shows as a chip
  const insertDocLink = (doc) => {
    if (!doc || !docLinkMenu.visible) return;
    const directive = docLinkDirective(doc.stableId);
    const { start, end } = docLinkMenu;
    setDocLinkMenu(CLOSED_DOC_LINK_MENU);
    replaceRange(start, end, directive, start + directive.length);
  };

  // Insert > Link to document and the /link command: "[[doc:" goes in at the
  // caret (over the selection) and the picker opens with every document listed
  const insertDocLinkPrompt = () => {
    if (locked || isPreviewActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const opener = '[[doc:';
    replaceRange(start, end, opener, start + opener.length);
    setTimeout(() => {
      const surface = textareaRef.current;
      if (!surface) return;
      openDocLinkMenu(surface, start + opener.length, { start, end: start + opener.length, query: '', closed: false });
    }, 1);
  };

  const handleContentInput = (e) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const value = e.target.value;
    // a document link being typed ("[[doc:" on the caret's line, unclosed, or
    // a title-form directive around the caret): the picker, not the slash popup
    const docLinkContext = docLinkContextAt(value, cursorPos, { isInsideCode });
    if (docLinkContext) {
      if (slashMenu.visible) setSlashMenu(prev => ({ ...prev, visible: false }));
      openDocLinkMenu(textarea, cursorPos, docLinkContext);
      return;
    }
    if (docLinkMenu.visible) setDocLinkMenu(CLOSED_DOC_LINK_MENU);
    // the caret's line first (cheap on any document); the whole text before
    // the caret only when a command is being typed (slashQueryAt looks for
    // an open code fence above)
    const lineText = value.slice(value.lastIndexOf('\n', cursorPos - 1) + 1, cursorPos);
    const textBeforeCursor = /(?:^|\s)\/\w*$/.test(lineText) ? value.substring(0, cursorPos) : lineText;
    const query = slashQueryAt(textBeforeCursor);
    const matching = query != null && templates.some((t) => matchesSlashQuery(t, query));

    if (!matching) {
      // no command here (a path, a space, code, no match): the popup goes
      if (slashMenu.visible) {
        setSlashMenu(prev => ({ ...prev, visible: false }));
      }
      return;
    }

    setSlashMenu({
      visible: true,
      position: caretPopupAnchor(textarea, cursorPos),
      query,
      slashPosition: textBeforeCursor.lastIndexOf('/'),
      selectedIndex: 0,
    });
  };

  // Open the Find bar (with the Replace row when asked and the document
  // is editable), from the editor.find / editor.replace shortcuts
  const openFind = (withReplace) => {
    const isEditable = !locked && isOwner && !(document?.inCloud && !isOnline) && !serverCopyUnavailable;
    setShowSearchReplace(true);
    setShowReplace(withReplace && isEditable);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // The editor's shortcuts (src/shortcuts/registry.js: Find and Italic
  // bound by default; Find and replace, Bold and Insert link unassigned
  // until the user binds them in Settings > Shortcuts). They fire only
  // while the editor has focus (scope 'editor'); the dispatcher
  // consumes the event, so the browser's own Ctrl+F never opens.
  useShortcut('editor.find', () => openFind(false));
  useShortcut('editor.replace', () => openFind(true));
  useShortcut('editor.bold', () => insertMarkdown('**', '**', 'bold'));
  useShortcut('editor.italic', () => insertMarkdown('*', '*', 'italic'));
  useShortcut('editor.insertLink', () => insertLink());
  const boldHint = useShortcutHint('editor.bold');
  const italicHint = useShortcutHint('editor.italic');
  const linkHint = useShortcutHint('editor.insertLink');
  // the Find bar's own hint line names the bound chords ('' when unassigned)
  const findLabel = useShortcutLabel('editor.find');
  const replaceLabel = useShortcutLabel('editor.replace');

  // Handle keyboard navigation in slash menu
  const handleKeyDown = (e) => {
    // a shortcut the dispatcher already ran (it stops propagation, so this
    // is only a guard against a synthetic re-dispatch)
    if (e.defaultPrevented) return;
    // the keys of a composition (an IME choosing characters) are the IME's: Enter commits, arrows pick
    if (e.isComposing || e.keyCode === 229) return;
    // Don't interfere if search panel is open (unless it's a shortcut)
    if (showSearchReplace && !hasChordModifier(e)) {
      return;
    }

    // Tab / Shift+Tab inside a list indent / outdent the lines (outside a
    // list Tab keeps moving the focus, as it did in the textarea). A fixed
    // shortcut (editor.indent / editor.outdent in the registry): not a
    // chord a user can move, so it stays here rather than in the dispatcher.
    if (e.key === 'Tab' && !hasChordModifier(e) && !e.altKey && !slashMenu.visible && !docLinkMenu.visible && textareaRef.current) {
      const textarea = textareaRef.current;
      const [lineStart, lineEnd] = lineBounds(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      const lines = textarea.value.substring(lineStart, lineEnd).split('\n');
      if (lines.every((line) => describeLine(line).list)) {
        e.preventDefault();
        indentText(!e.shiftKey);
        return;
      }
    }

    // Home / End: the start / end of the current line (smart Home: the first
    // non-blank character first), Shift extending the selection - not the
    // whole document, as a macOS textarea would; Cmd/Ctrl+Home/End keep the
    // document start / end (src/utils/lineCaret.js). The right-click menu
    // routes its own Home/End before this handler sees them.
    if ((e.key === 'Home' || e.key === 'End') && !hasChordModifier(e) && !e.altKey && !slashMenu.visible && !docLinkMenu.visible && textareaRef.current) {
      const textarea = textareaRef.current;
      const next = homeEndSelection(textarea.value, e.key, e.shiftKey, {
        start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection,
      });
      e.preventDefault();
      textarea.setSelectionRange(next.start, next.end, next.direction);
      return;
    }

    // the document picker's keys (the same model as the slash popup below)
    if (docLinkMenu.visible) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setDocLinkMenu(prev => ({ ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, Math.max(0, docLinkResults.length - 1)) }));
          return;
        case 'ArrowUp':
          e.preventDefault();
          setDocLinkMenu(prev => ({ ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }));
          return;
        case 'Enter':
        case 'Tab':
          if (docLinkResults.length === 0) return;
          e.preventDefault();
          insertDocLink(docLinkResults[docLinkMenu.selectedIndex] || docLinkResults[0]);
          return;
        case 'Escape':
          e.preventDefault();
          setDocLinkMenu(CLOSED_DOC_LINK_MENU);
          return;
        default:
          return;
      }
    }

    if (!slashMenu.visible) return;

    if (filteredTemplates.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSlashMenu(prev => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, filteredTemplates.length - 1),
        }));
        break;

      case 'ArrowUp':
        e.preventDefault();
        setSlashMenu(prev => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        break;

      case 'Enter':
        e.preventDefault();
        insertTemplate(filteredTemplates[slashMenu.selectedIndex]);
        break;

      case 'Escape':
        e.preventDefault();
        setSlashMenu(prev => ({ ...prev, visible: false, selectedIndex: 0 }));
        break;

      default:
        break;
    }
  };

  // Insert a template at cursor position - or, for a built-in action entry
  // (Quick Workflow / AI / Task), open its panel at the cursor: the typed
  // command stays in the text until the panel's result replaces it, and a
  // cancelled panel leaves it, as before.
  const BLOCK_ACTIONS = {
    hr: insertHorizontalRule,
    quote: () => insertMarkdown('> ', '', 'quote'),
    toc: insertTableOfContents,
    codeblock: insertCodeBlock,
    // /link: "[[doc:" at the caret and the document picker (src/utils/docLinks.js)
    doclink: insertDocLinkPrompt,
    // the PDF directives (/pagebreak, /blankpage, /centerpage, /header, /footer)
    pagebreak: () => insertPdfDirective('[[pagebreak]]'),
    blankpage: () => insertPdfDirective('[[blankpage]]'),
    centerpage: () => wrapPdfDirective('centerpage', 'Example Title'),
    'pdf-header': () => wrapPdfDirective('header', 'Example Header'),
    'pdf-footer': () => wrapPdfDirective('footer', 'Example Footer'),
  };

  const insertTemplate = (template) => {
    if (!template || locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;

    // Get current content (from Yjs or local state)
    const currentContent = yjsEnabled && yjs.ytext ? yjs.ytext.toString() : content;

    if (template.action) {
      setSlashMenu({ visible: false, position: { x: 0, y: 0 }, query: '', slashPosition: 0, selectedIndex: 0 });
      if (template.action === 'workflow') handleTriggerQuickWorkflow(cursorPos);
      else if (template.action === 'ai') handleTriggerQuickAI(cursorPos);
      else if (template.action === 'task') handleTriggerQuickTasks(cursorPos);
      else if (BLOCK_ACTIONS[template.action]) {
        // /hr, /quote, /toc, /code and the PDF directives: the typed command goes, then the
        // toolbar's own helper runs at that spot (after the content update
        // has reached the editor, which the helpers read)
        const typed = /(?:^|\s)(\/\w*)$/.exec(currentContent.substring(0, cursorPos));
        const slashStart = typed ? cursorPos - typed[1].length : cursorPos;
        const run = BLOCK_ACTIONS[template.action];
        if (typed) {
          replaceRange(slashStart, cursorPos, '', slashStart);
          setTimeout(() => run(), 1);
        } else {
          run();
        }
      }
      return;
    }

    // Find the slash command to replace
    const textBeforeCursor = currentContent.substring(0, cursorPos);
    const slashMatch = textBeforeCursor.match(/(?:^|\s)(\/\w*)$/);

    if (slashMatch) {
      const slashCommand = slashMatch[1];
      const slashStart = cursorPos - slashCommand.length;

      // Replace slash command with template content
      const newContent =
        currentContent.substring(0, slashStart) +
        template.content +
        currentContent.substring(cursorPos);

      const newCursorPos = slashStart + template.content.length;

      applyEdit(newContent, newCursorPos);

      // Set cursor position after template insertion
      setTimeout(() => {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }

    setSlashMenu({ visible: false, position: { x: 0, y: 0 }, query: '', slashPosition: 0, selectedIndex: 0 });
  };

  // Handle content change
  const handleContentChange = (e) => {
    const newContent = e.target.value;
    const cursorPos = textareaRef.current?.selectionStart || 0;

    // Handle slash commands for both local and cloud docs
    handleContentInput(e);

    // For Yjs documents when ONLINE, update Yjs (not parent state)
    // For cloud documents when OFFLINE, update parent state (falls through to else)
    // Yjs manages content via DOM, not React state
    if (yjsEnabled && yjs.updateContent) {
      if (textareaRef.current?.managesYjs) return;   // y-codemirror.next synced the keystroke
      console.log('[DocumentEditor] Online cloud doc - calling yjs.updateContent');
      yjs.updateContent(newContent, cursorPos);
    } else {
      console.log('[DocumentEditor] Local doc or offline cloud doc - updating parent state. yjsEnabled:', yjsEnabled, 'yjs.updateContent:', !!yjs.updateContent);
      // For local documents OR cloud documents when offline, update parent component's React state
      // Parent will save to IndexedDB
      if (onContentChange) {
        onContentChange(e);
      }
    }
  };

  // Quick AI handlers
  const handleTriggerQuickAI = (cursorPos) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Calculate popup position near cursor
    const { x, y } = caretPopupAnchor(textarea, cursorPos);

    // Adjust position to keep popup within window bounds
    const popupWidth = 400;
    const popupHeight = 500;
    const adjustedX = Math.min(x, window.innerWidth - popupWidth - 20);
    const adjustedY = Math.min(y, window.innerHeight - popupHeight - 20);

    setQuickAIPopupPos({ x: Math.max(20, adjustedX), y: Math.max(20, adjustedY) });
    setQuickAICursorPos(cursorPos);
    setShowQuickAI(true);

    // Focus input after a brief delay
    setTimeout(() => {
      if (quickAIInputRef.current) {
        quickAIInputRef.current.focus();
      }
    }, 100);
  };

  const handleQuickAISubmit = async () => {
    if (!quickAIInput.trim()) return;

    setQuickAILoading(true);
    setQuickAIResponse('');

    // The provider and model from Settings > Default AI (through
    // /api/ai/models, so the desktop and the web agree); nothing
    // configured -> a plain message, not the backend's key error
    let aiSettings = null;
    try {
      aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() });
    } catch (error) {
      setQuickAIResponse('Error: ' + error.message);
      setQuickAILoading(false);
      return;
    }
    if (!aiSettings) {
      setQuickAIResponse(NO_AI_PROVIDER_MESSAGE);
      setQuickAILoading(false);
      return;
    }

    // The highlighted text ("Ask AI About This") goes with the question as
    // context, as highlighted - no sanitising, no trimming
    const message = quickAIContext ? `Selected text:\n${quickAIContext.text}\n\nQuestion: ${quickAIInput}` : quickAIInput;

    // Call backend with concise prompt
    const systemPrompt = 'You are a code assistant. Respond ONLY with the requested code, command, or text. Do NOT include explanations, markdown formatting, or comments unless specifically requested. Be extremely concise.';

    const backendUrl = await getBackendUrl();
    await runQuickAI({ backendUrl, aiSettings, message, systemPrompt });
  };

  // One Quick AI request, streamed (src/utils/aiStream.js): the reply grows in the response box as it arrives,
  // a reasoning model's thinking shows as "Thinking...", Cancel aborts it, and there is no total timeout - only
  // the idle one (nothing received for minutes). `append` keeps what is there (Continue after a cut-off).
  const runQuickAI = async ({ backendUrl, aiSettings, message, systemPrompt, append = false }) => {
    const controller = new AbortController();
    quickAIAbortRef.current = controller;
    setQuickAILoading(true);
    setQuickAIPhase('waiting');
    setQuickAITruncated(false);
    if (!append) setQuickAIResponse('');
    const prefix = append ? '\n\n' : '';
    quickAIFirstChunkRef.current = true;
    try {
      const result = await streamAiReply({
        url: `${backendUrl}/api/ai/ask`,
        fetchImpl: apiFetch,   // the app's fetch: the auth token on the web
        signal: controller.signal,
        body: { message, systemPrompt, provider: aiSettings.provider, model: aiSettings.model, temperature: aiSettings.temperature, maxTokens: aiSettings.maxTokens, stream: true },
        onEvent: (ev) => {
          if (ev.type === 'thinking_start' || ev.type === 'thinking') setQuickAIPhase('thinking');
          else if (ev.type === 'content' && ev.content) {
            setQuickAIPhase('answering');
            const piece = (quickAIFirstChunkRef.current ? prefix : '') + ev.content;
            quickAIFirstChunkRef.current = false;
            setQuickAIResponse((prev) => prev + piece);
          }
        },
      });
      if (!result.content && !append) setQuickAIResponse(result.thinking ? '(The model only reasoned and gave no answer - the token limit may be too low for its thinking.)' : 'Error: No response from AI');
      setQuickAITruncated(result.truncated ? (aiSettings.maxTokens || true) : false);
    } catch (err) {
      // Cancel keeps what arrived (or says so); an error goes under what arrived
      const cancelled = !!(err && err.name === 'AbortError');
      const note = cancelled ? 'Cancelled.' : 'Error: ' + (err && err.message ? err.message : String(err));
      setQuickAIResponse((prev) => (cancelled ? (prev || note) : (prev ? prev + '\n\n' + note : note)));
    } finally {
      if (quickAIAbortRef.current === controller) quickAIAbortRef.current = null;
      setQuickAIPhase(null);
      setQuickAILoading(false);
    }
  };
  const handleQuickAICancel = () => { quickAIAbortRef.current?.abort(); };
  // Continue a reply the token limit cut off: the same question with the partial answer, asked to go on
  const handleQuickAIContinue = async () => {
    if (quickAILoading || !quickAIResponse) return;
    let aiSettings = null;
    try { aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() }); } catch { aiSettings = null; }
    if (!aiSettings) return;
    const question = quickAIContext ? `Selected text:\n${quickAIContext.text}\n\nQuestion: ${quickAIInput}` : quickAIInput;
    const message = `${question}\n\nYour answer so far (cut off at the token limit):\n${quickAIResponse}\n\n${CONTINUE_PROMPT}`;
    const systemPrompt = 'You are a code assistant. Respond ONLY with the requested code, command, or text. Do NOT include explanations, markdown formatting, or code fences.';
    await runQuickAI({ backendUrl: await getBackendUrl(), aiSettings, message, systemPrompt, append: true });
  };

  const handleAcceptAIResponse = (useSelection = false) => {
    const textToInsert = useSelection && quickAISelectedText ? quickAISelectedText : quickAIResponse;

    if (!textToInsert || quickAICursorPos === null || quickAICursorPos === undefined) {
      setShowQuickAI(false);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Get current content (from Yjs or local state)
    const currentContent = yjsEnabled && yjs.ytext ? yjs.ytext.toString() : content;

    let insertPos = quickAICursorPos;
    let baseContent = currentContent;
    let inserted = textToInsert;

    if (quickAIContext) {
      // "Ask AI About This": the answer starts on its own line directly
      // below the highlighted text, which stays as it is. A selection that
      // ends mid-line: the answer goes after that line, on a new one; a
      // selection that already ends with a line break: the answer takes the
      // line right below it (its own newline keeps what followed on its
      // line), with no blank line in between.
      const end = Math.min(quickAIContext.end, currentContent.length);
      if (currentContent[end - 1] === '\n') {
        insertPos = end;
        inserted = textToInsert + '\n';
      } else {
        const lineEnd = currentContent.indexOf('\n', end);
        insertPos = lineEnd === -1 ? currentContent.length : lineEnd;
        inserted = '\n' + textToInsert;
      }
    } else {
      // Check if /ai is still at the cursor position and remove it
      const textBeforeCursor = currentContent.substring(0, quickAICursorPos);
      if (textBeforeCursor.endsWith('/ai')) {
        // Remove /ai
        baseContent = currentContent.substring(0, quickAICursorPos - 3) + currentContent.substring(quickAICursorPos);
        insertPos = quickAICursorPos - 3;
      }
    }

    // Insert response at cursor position
    const newContent = baseContent.substring(0, insertPos) + inserted + baseContent.substring(insertPos);
    const newPos = insertPos + inserted.length;

    applyEdit(newContent, newPos);

    // Focus and set cursor position after inserted text
    setTimeout(() => {
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus({ preventScroll: true });
    }, 0);

    // Reset and close
    setShowQuickAI(false);
    setQuickAIInput('');
    setQuickAIResponse('');
    setQuickAICursorPos(null);
    setQuickAISelectedText('');
    setQuickAIContext(null);
  };

  const handleQuickAIResponseSelection = () => {
    if (!quickAIResponseRef.current) return;

    const textarea = quickAIResponseRef.current;
    const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    setQuickAISelectedText(selectedText);
  };

  const handleCancelQuickAI = () => {
    setShowQuickAI(false);
    setQuickAIInput('');
    setQuickAIResponse('');
    setQuickAICursorPos(null);
    setQuickAISelectedText('');
    setQuickAIContext(null);
  };

  // Handle clicks in preview mode (for external links and interactive
  // markdown buttons generated by interactiveMarkdown.js)
  // Right-click on a RENDERED ```mermaid diagram in the preview opens the
  // app's standard context menu (same hook/component as the sidebars) with
  // "Download SVG". Error boxes, the source block and ordinary preview text
  // are not matched and keep the browser's default menu.
  const {
    contextMenu: diagramMenu,
    contextMenuRef: diagramMenuRef,
    openContextMenu: openDiagramMenu,
    handleContextMenuAction: handleDiagramMenuAction,
    isContextMenuType: isDiagramMenu,
  } = useContextMenu();

  const handlePreviewContextMenu = (e) => {
    const diagram = e.target.closest?.('.mermaid-diagram[data-mermaid="rendered"]');
    if (!diagram || !previewRef.current) return;
    if (!diagram.querySelector('.mermaid-diagram-output > svg')) return;
    // 1-based position among the document's diagrams: names the file, and
    // re-resolves the element when the item is clicked (the preview DOM is
    // rebuilt whenever its HTML changes, e.g. a collaborative edit while the
    // menu is open, which would leave a stored element detached).
    const index = Array.from(previewRef.current.querySelectorAll('.mermaid-diagram')).indexOf(diagram) + 1;
    openDiagramMenu(e, 'diagram', { index });
  };

  // Export the diagram exactly as displayed (the live element, so a dark
  // render carries its label-contrast overrides) as a standalone SVG file
  // on a background matching the preview pane, through the same blob +
  // <a download> hand-off every other export uses (OS save dialog in the
  // Electron shell; no network, works offline).
  const downloadDiagramSvg = ({ index } = {}) => {
    const diagram = previewRef.current?.querySelectorAll('.mermaid-diagram')[index - 1];
    const svg = diagram?.getAttribute('data-mermaid') === 'rendered'
      ? diagram.querySelector('.mermaid-diagram-output > svg')
      : null;
    if (!svg) return;
    const theme = mermaidThemeForApp();
    const background = previewRef.current
      ? window.getComputedStyle(previewRef.current).backgroundColor
      : undefined;
    const markup = serializeDiagramSvg(svg, { theme, background });
    downloadBlob(new Blob([markup], { type: 'image/svg+xml' }), diagramExportFilename(document?.title, index));
  };

  const handlePreviewClick = (e) => {
    // a link to another document ([[doc:...]]): open it in a tab through the
    // page's own open-document path (what the tabs and the search use); a
    // "not found" / ambiguous link is an inert span and never gets here
    const docLink = e.target.closest('a[data-doc-link]');
    if (docLink) {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(docLink.getAttribute('data-doc-id'));
      if (Number.isFinite(id) && onOpenDocumentById) onOpenDocumentById(id);
      return;
    }

    const openUrlBtn = e.target.closest('button[data-action="open-url"]');
    if (openUrlBtn) {
      e.preventDefault();
      e.stopPropagation();
      let url = atob(openUrlBtn.getAttribute('data-url-b64') || '');
      if (url.includes('{{')) {
        const container = e.currentTarget;
        const values = {};
        container.querySelectorAll('.interactive-input').forEach((input) => {
          values[input.getAttribute('data-input-id')] = input.value || '';
        });
        container.querySelectorAll('.interactive-textarea').forEach((ta) => {
          values[ta.getAttribute('data-textarea-id')] = ta.value || '';
        });
        container.querySelectorAll('.interactive-checkbox').forEach((cb) => {
          values[cb.getAttribute('data-checkbox-id')] = cb.checked ? '✓' : '✗';
        });
        url = url.replace(/\{\{([^}]+)\}\}/g, (m, varName) => (
          values[varName] !== undefined ? encodeURIComponent(values[varName]) : m
        ));
      }
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(url);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
      return;
    }

    const submitBtn = e.target.closest('button[data-action="submit-template"]');
    if (submitBtn) {
      e.preventDefault();
      e.stopPropagation();
      const templateName = atob(submitBtn.getAttribute('data-template-b64') || '');
      const container = e.currentTarget;
      const values = {};
      container.querySelectorAll('.interactive-input').forEach((input) => {
        values[input.getAttribute('data-input-id')] = input.value || '';
      });
      container.querySelectorAll('.interactive-textarea').forEach((ta) => {
        values[ta.getAttribute('data-textarea-id')] = ta.value || '';
      });
      container.querySelectorAll('.interactive-checkbox').forEach((cb) => {
        values[cb.getAttribute('data-checkbox-id')] = cb.checked ? '✓' : '✗';
      });
      window.dispatchEvent(new CustomEvent('createDocumentFromTemplate', { detail: { templateName, values } }));
      return;
    }

    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    console.log('[DocumentEditor] Link clicked:', href);
    console.log('[DocumentEditor] Is external link:', href.startsWith('http://') || href.startsWith('https://'));
    console.log('[DocumentEditor] Electron API available:', !!window.electronAPI?.openExternal);

    // Only handle external links (http, https, mailto, etc.)
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
      e.preventDefault();
      e.stopPropagation();

      console.log('[DocumentEditor] Opening in external browser');

      // Use Electron API to open in external browser if available
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(href);
      } else {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    }
  };

  // Quick Workflow handlers
  const handleTriggerQuickWorkflow = (cursorPos) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Calculate popup position near cursor
    let { x, y } = caretPopupAnchor(textarea, cursorPos);

    // Adjust position to keep popup within window bounds
    const popupWidth = 500;
    const popupHeight = 600;

    if (x + popupWidth > window.innerWidth) {
      x = window.innerWidth - popupWidth - 20;
    }

    if (y + popupHeight > window.innerHeight) {
      y = window.innerHeight - popupHeight - 20;
    }

    setQuickWorkflowPopupPos({ x, y });
    setQuickWorkflowCursorPos(cursorPos);
    setShowQuickWorkflow(true);
  };

  const handleInsertWorkflowResult = (resultText) => {
    if (!resultText) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Get current content (from Yjs or local state)
    const currentContent = yjsEnabled && yjs.ytext ? yjs.ytext.toString() : content;

    // Check if /wf is still at the cursor position and remove it
    let insertPos = quickWorkflowCursorPos;
    let baseContent = currentContent;

    const textBeforeCursor = currentContent.substring(0, quickWorkflowCursorPos);
    if (textBeforeCursor.endsWith('/wf')) {
      // Remove /wf
      baseContent = currentContent.substring(0, quickWorkflowCursorPos - 3) + currentContent.substring(quickWorkflowCursorPos);
      insertPos = quickWorkflowCursorPos - 3;
    }

    // Insert result at cursor position
    const newContent = baseContent.substring(0, insertPos) + resultText + baseContent.substring(insertPos);
    const newPos = insertPos + resultText.length;

    applyEdit(newContent, newPos);

    // Focus and set cursor position after inserted text
    setTimeout(() => {
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus({ preventScroll: true });
    }, 0);

    // Close popup
    setShowQuickWorkflow(false);
    setQuickWorkflowCursorPos(null);
  };

  // Quick Tasks handlers
  const handleTriggerQuickTasks = (cursorPos) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Calculate popup position near cursor
    let { x, y } = caretPopupAnchor(textarea, cursorPos);

    // Adjust position to keep popup within window bounds
    const popupWidth = 480;
    const popupHeight = 520;

    if (x + popupWidth > window.innerWidth) {
      x = window.innerWidth - popupWidth - 20;
    }

    if (y + popupHeight > window.innerHeight) {
      y = window.innerHeight - popupHeight - 20;
    }

    setQuickTasksPopupPos({ x: Math.max(0, x), y: Math.max(0, y) });
    setQuickTasksCursorPos(cursorPos);
    setShowQuickTasks(true);
  };

  // A task was created: like /wf and /ai, the slash command itself never
  // ends up in the document - remove the "/task" that opened the popup.
  // Nothing is inserted (the task lives on the Tasks page); cancelling the
  // popup leaves the text untouched, like the other commands.
  const handleQuickTaskCreated = () => {
    setShowQuickTasks(false);

    const textarea = textareaRef.current;
    if (!textarea || quickTasksCursorPos === null || quickTasksCursorPos === undefined) {
      setQuickTasksCursorPos(null);
      return;
    }

    // Get current content (from Yjs or local state)
    const currentContent = yjsEnabled && yjs.ytext ? yjs.ytext.toString() : content;

    // Check if /task is still at the cursor position and remove it
    const textBeforeCursor = currentContent.substring(0, quickTasksCursorPos);
    let newPos = quickTasksCursorPos;
    if (textBeforeCursor.endsWith('/task')) {
      const newContent = currentContent.substring(0, quickTasksCursorPos - 5) + currentContent.substring(quickTasksCursorPos);
      newPos = quickTasksCursorPos - 5;

      applyEdit(newContent, newPos);
    }

    // Focus and restore the cursor position
    setTimeout(() => {
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus({ preventScroll: true });
    }, 0);

    setQuickTasksCursorPos(null);
  };

  const handleQuickAIDragStart = (e) => {
    setIsDraggingQuickAI(true);
    quickAIDragStartRef.current = {
      left: quickAIPopupPos.x,
      top: quickAIPopupPos.y,
      x: e.clientX,
      y: e.clientY
    };
  };

  // Auto-typer function (testing mode only)
  const loremIpsumText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";

  const handleStartAutoTyper = () => {
    if (locked || isPreviewActive || isAutoTyping) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Focus the editor to simulate user interaction
    textarea.focus({ preventScroll: true });

    setIsAutoTyping(true);
    let charIndex = 0;

    autoTypeIntervalRef.current = setInterval(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        clearInterval(autoTypeIntervalRef.current);
        setIsAutoTyping(false);
        return;
      }

      if (charIndex >= loremIpsumText.length) {
        // Finished typing
        clearInterval(autoTypeIntervalRef.current);
        setIsAutoTyping(false);
        return;
      }

      const char = loremIpsumText[charIndex];

      if (yjsEnabled && yjs.ytext) {
        // For Yjs documents, read current cursor position from the editor
        // This accounts for any changes made by other users
        const currentPos = textarea.selectionStart;

        // Insert directly into the Yjs text at current cursor position
        yjs.ytext.insert(currentPos, char);

        // Update local cursor position immediately (for smooth local UX)
        const newPos = currentPos + 1;
        setTimeout(() => {
          if (textarea) {
            textarea.setSelectionRange(newPos, newPos);
          }
        }, 0);

        // (the caret itself reaches the peers through the surface's binding)
      } else {
        // For local documents, read current cursor position
        const currentPos = textarea.selectionStart;
        const currentContent = content;
        const newContent = currentContent.substring(0, currentPos) + char + currentContent.substring(currentPos);

        if (onContentChange) {
          onContentChange({ target: { value: newContent } });
        }

        // Update cursor position
        setTimeout(() => {
          if (textarea) {
            textarea.setSelectionRange(currentPos + 1, currentPos + 1);
          }
        }, 0);
      }

      charIndex++;
    }, 100); // Type one character every 100ms (10 chars/second - more human-like)
  };

  const handleStopAutoTyper = () => {
    if (autoTypeIntervalRef.current) {
      clearInterval(autoTypeIntervalRef.current);
      autoTypeIntervalRef.current = null;
    }
    setIsAutoTyping(false);
  };

  // Cleanup auto-typer on unmount
  useEffect(() => {
    return () => {
      if (autoTypeIntervalRef.current) {
        clearInterval(autoTypeIntervalRef.current);
      }
    };
  }, []);

  // Live document content for the search/replace subsystem. For Yjs documents
  // the surface is bound to the CRDT, so yjs.content (React state) is frozen at
  // load time and must NOT be used here: searching against it misplaces every
  // match once the document has been edited. The surface's value is the
  // authoritative source for what is actually rendered; ytext is the fallback
  // before the ref mounts.
  const getSearchContent = () => {
    if (!yjsEnabled) return content;
    if (textareaRef.current) return textareaRef.current.value;
    if (yjs.ytext && yjs.isReady && !serverCopyUnavailable) return yjs.ytext.toString();
    return yjs.content !== undefined ? yjs.content : content;
  };

  // Search and Replace handlers
  // Centre a match in the view (the match marks themselves are decorations: the effect below)
  const scrollToMatch = (match) => {
    if (!textareaRef.current || !match) return;
    textareaRef.current.scrollToPos(match.start, { center: true });
  };
  // Keep the jump-to-line effect's ref pointed at the latest scrollToMatch
  useEffect(() => {
    scrollToMatchRef.current = scrollToMatch;
  });

  // The find bar's matches: decorations in the view (re-applied when the
  // editor comes back from the preview pane, a new view)
  useEffect(() => {
    const surface = textareaRef.current;
    if (!surface) return;
    surface.setSearchMatches(showSearchReplace ? searchMatches : [], currentMatchIndex);
  }, [searchMatches, currentMatchIndex, showSearchReplace, isPreviewActive]);

  // Debounce timer for search
  const searchDebounceTimer = useRef(null);
  const searchInputFocusedRef = useRef(false);

  const lastMatchSignatureRef = useRef('');

  const performSearch = (query, content, skipScrollToMatch = false) => {
    if (!query || query.length < 2) {
      setSearchMatches([]);
      setCurrentMatchIndex(-1);
      lastMatchSignatureRef.current = '';
      return;
    }

    const matches = [];
    const searchContent = caseSensitive ? content : content.toLowerCase();
    const searchTerm = caseSensitive ? query : query.toLowerCase();

    let index = 0;
    while ((index = searchContent.indexOf(searchTerm, index)) !== -1) {
      matches.push({ start: index, end: index + query.length });
      index += query.length;
    }

    // Only reset match index when results actually changed (avoids resetting during navigation)
    const signature = matches.map(m => m.start).join(',');
    const resultsChanged = signature !== lastMatchSignatureRef.current;
    lastMatchSignatureRef.current = signature;

    setSearchMatches(matches);
    if (resultsChanged) {
      if (matches.length > 0) {
        setCurrentMatchIndex(0);
        if (!skipScrollToMatch && matches[0]) {
          setTimeout(() => scrollToMatch(matches[0]), 0);
        }
      } else {
        setCurrentMatchIndex(-1);
      }
    }
  };

  const handleSearchChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);

    // Clear previous debounce timer
    if (searchDebounceTimer.current) {
      clearTimeout(searchDebounceTimer.current);
    }

    // Debounce search to avoid lag on typing
    searchDebounceTimer.current = setTimeout(() => {
      performSearch(query, getSearchContent());
    }, 300); // 300ms debounce delay
  };

  const handleFindNext = () => {
    if (searchMatches.length === 0) return;

    const nextIndex = (currentMatchIndex + 1) % searchMatches.length;
    setCurrentMatchIndex(nextIndex);
    scrollToMatch(searchMatches[nextIndex]);
  };

  const handleFindPrevious = () => {
    if (searchMatches.length === 0) return;

    const prevIndex = currentMatchIndex <= 0
      ? searchMatches.length - 1
      : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIndex);
    scrollToMatch(searchMatches[prevIndex]);
  };

  const handleReplace = () => {
    // Check if document is editable
    if (locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) {
      console.log('[DocumentEditor] Replace blocked - document is read-only');
      return;
    }

    if (searchMatches.length === 0 || currentMatchIndex < 0) return;

    const currentContent = getSearchContent();
    const match = searchMatches[currentMatchIndex];

    const newContent =
      currentContent.substring(0, match.start) +
      replaceText +
      currentContent.substring(match.end);

    applyEdit(newContent, match.start + replaceText.length);

    // Re-run search after replacement (skip scrolling to keep focus in search panel)
    setTimeout(() => {
      performSearch(searchQuery, newContent, true);
    }, 0);
  };

  const handleReplaceAll = () => {
    // Check if document is editable
    if (locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) {
      console.log('[DocumentEditor] Replace All blocked - document is read-only');
      return;
    }

    if (searchMatches.length === 0 || !searchQuery) return;

    const currentContent = getSearchContent();
    const flags = caseSensitive ? 'g' : 'gi';
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, flags);

    const newContent = currentContent.replace(regex, replaceText);

    applyEdit(newContent, textareaRef.current ? textareaRef.current.selectionStart : 0);

    // Clear search after replace all
    setSearchMatches([]);
    setCurrentMatchIndex(-1);
  };

  const handleCloseSearch = () => {
    // Clear any pending debounce timer
    if (searchDebounceTimer.current) {
      clearTimeout(searchDebounceTimer.current);
    }

    setShowSearchReplace(false);
    setSearchQuery('');
    setReplaceText('');
    setSearchMatches([]);
    setCurrentMatchIndex(-1);
    lastMatchSignatureRef.current = '';

    textareaRef.current?.focus({ preventScroll: true });
  };

  // Update search when case sensitivity changes
  useEffect(() => {
    if (searchQuery && searchQuery.length >= 2 && showSearchReplace) {
      // Skip scrolling when toggling case sensitivity to avoid stealing focus
      // eslint-disable-next-line react-hooks/set-state-in-effect
      performSearch(searchQuery, getSearchContent(), true);
    }
    // Only the case-sensitivity toggle should re-run this; searchQuery etc.
    // are handled by the content-change effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive]);

  // Re-run search when content changes (if search is active)
  useEffect(() => {
    if (searchQuery && showSearchReplace && !locked && !searchInputFocusedRef.current) {
      // Only re-search if user is not actively typing in search box
      // Skip scrolling to match during automatic re-search to avoid stealing focus
      performSearch(searchQuery, getSearchContent(), true);
    }
    // Re-search only when the document content changes; query/flags are
    // guards handled by their own effects/handlers. yjsContentVersion is the
    // cache-buster for live CRDT edits (yjs.content is frozen at load time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, yjsContentVersion]);

  // Handle ESC key to close search panel
  useEffect(() => {
    const handleEscKey = (e) => {
      if (e.key === 'Escape' && showSearchReplace) {
        handleCloseSearch();
      }
    };

    if (showSearchReplace) {
      window.addEventListener('keydown', handleEscKey);
      return () => window.removeEventListener('keydown', handleEscKey);
    }
  }, [showSearchReplace]);

  // Cleanup the search debounce timer on component unmount
  useEffect(() => {
    return () => {
      if (searchDebounceTimer.current) {
        clearTimeout(searchDebounceTimer.current);
      }
    };
  }, []);

  // The Y.Text and awareness a CodeMirror surface binds to (y-codemirror.next) once the hook is ready and
  // the server's copy is real - null keeps it a local document (its own undo history)
  const yjsBinding = useMemo(
    () => (yjsEnabled && yjs.ytext && yjs.isReady && !serverCopyUnavailable ? { ytext: yjs.ytext, awareness: yjs.awareness || null } : null),
    [yjsEnabled, yjs.ytext, yjs.awareness, yjs.isReady, serverCopyUnavailable],
  );
  const onSurface = useCallback((surface) => {
    textareaRef.current = surface;
    if (surface && surface.isCodeMirror) {
      // the place follows the reader through the editor: the top line and the offset on every scroll
      let frame = null;
      surface.addEventListener('scroll', () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          try { rememberPlace(placeKeyRef.current, { line: surface.topVisibleLine(), editorScrollTop: surface.scrollTop }); } catch { /* gone */ }
        });
      });
    }
    // the editor mounted again after a preview: the selection back where it
    // was (without scrolling to it), the view at the preview's top block -
    // or, without a mapping, at the editor's own last offset - and the caret
    // kept on screen when it was on screen before
    const place = viewPlaceRef.current;
    if (!surface || !surface.isCodeMirror || !place.toEditor) return;
    const { line, selection, cursorVisible, leftAt } = place.toEditor;
    // cleared after this tick, not now: React's StrictMode (the dev build) mounts the editor twice in
    // one commit, and the second, surviving surface must get the place too
    setTimeout(() => { if (viewPlaceRef.current.toEditor === place.toEditor) viewPlaceRef.current.toEditor = null; }, 0);
    try {
      if (selection) surface.setSelectionRange(selection.start, selection.end, selection.direction, { scrollIntoView: false });
      if (line != null) surface.scrollToLine(line);
      else if (place.editorScrollTop > 0) surface.scrollTop = place.editorScrollTop;
      // the caret was on screen and the preview was not scrolled elsewhere
      // (its top is still where the editor was left): keep the caret on screen
      const navigated = line != null && leftAt != null && Math.abs(line - leftAt) > 3;
      if (cursorVisible && selection && !navigated) {
        // after the line scroll has been measured and applied: only a caret that is then off screen is brought
        // back (a second scroll target dispatched now would replace the first and put the caret at an edge)
        requestAnimationFrame(() => { try { if (textareaRef.current === surface && !surface.isCursorVisible()) surface.scrollCursorIntoView(); } catch { /* gone */ } });
      }
    } catch { /* a place that no longer fits the document */ }
  }, []);

  // When the editor takes no typing: a locked or foreign cloud document, offline for a cloud document, the
  // server copy unavailable, auto-typing in progress - the editor is read-only and the menu's Cut / Paste are off
  const editorReadOnly = locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable || isAutoTyping;

  // The editor's right-click menu: always ours (Cut / Copy / Paste with or
  // without a selection; the AI and Search items with one). The clipboard is
  // asked what it holds while the menu opens, so Paste can be greyed when it
  // is known to be empty (src/utils/editorClipboard.js: 'unknown' keeps it on).
  const handleTextSelectionContextMenu = (e) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // The desktop app lets Chromium see the click: its context-menu event
    // (no native menu is shown) brings the word it flagged and the
    // suggestions, which join this menu. A browser keeps the menu ours;
    // Shift + right-click there opens the browser's own, with its suggestions.
    if (typeof window.electronAPI?.onEditorContextMenu !== 'function') e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    const opened = { visible: true, x: e.clientX, y: e.clientY, text: selectedText, start, end, clipboard: 'unknown', word: wordAtPointer(textarea, e), spell: null };
    setSelectionMenu(opened);
    readClipboardState().then((clipboard) => {
      setSelectionMenu((menu) => (menu.visible && menu.start === start && menu.end === end && menu.x === opened.x && menu.y === opened.y ? { ...menu, clipboard } : menu));
    });
  };

  // A spelling suggestion replaces the word the menu was opened on: an
  // ordinary edit (one CodeMirror transaction, so the live document and the
  // undo history see it); "Add to dictionary" asks the main process, which
  // only takes the word of the last menu.
  const handleSpellReplace = (suggestion) => {
    const { word } = selectionMenu;
    closeSelectionMenu();
    if (!word || editorReadOnly || typeof suggestion !== 'string') return;
    const textarea = textareaRef.current;
    if (!textarea || textarea.value.slice(word.from, word.to) !== word.text) return;
    replaceRange(word.from, word.to, suggestion, word.from + suggestion.length);
  };
  const handleSpellAddWord = (word) => {
    closeSelectionMenu();
    const api = window.electronAPI?.spellcheck;
    if (!api || typeof word !== 'string') return;
    api.addWord(word).catch(() => {});
  };

  // The clipboard items do what the keys do, on the selection the menu was opened on
  const handleSelectionCut = async () => {
    const { start, end } = selectionMenu;
    closeSelectionMenu();
    await cutSelection(textareaRef.current, { start, end });
  };
  const handleSelectionCopy = async () => {
    const { start, end } = selectionMenu;
    closeSelectionMenu();
    await copySelection(textareaRef.current, { start, end });
  };
  const handleSelectionPaste = async () => {
    const { start, end } = selectionMenu;
    closeSelectionMenu();
    await pasteInto(textareaRef.current, { start, end });
  };

  // Detect and replace IPs and hostnames
  const detectSensitiveData = (text) => {
    let sanitized = text;
    let replacementCount = 0;

    // Common valid TLDs (not exhaustive, but covers most cases)
    const validTLDs = new Set([
      'com', 'org', 'net', 'edu', 'gov', 'mil', 'int',
      'io', 'ai', 'app', 'dev', 'cloud', 'tech', 'info', 'biz',
      'co', 'us', 'uk', 'ca', 'au', 'de', 'fr', 'jp', 'cn', 'ru', 'br', 'in',
      'local', 'internal', 'corp', 'lan'
    ]);

    // IP address pattern (IPv4) - with validation
    const ipv4Pattern = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
    sanitized = sanitized.replace(ipv4Pattern, (match, oct1, oct2, oct3, oct4, offset) => {
      // Validate each octet is 0-255
      const octets = [oct1, oct2, oct3, oct4].map(o => parseInt(o, 10));
      if (octets.some(o => o > 255)) {
        return match; // Not a valid IP
      }

      // Check if this is part of a version number (e.g., "4.14" or "1.2.3.4" in version context)
      // Look for version indicators before or after
      const before = sanitized.substring(Math.max(0, offset - 20), offset);
      const after = sanitized.substring(offset + match.length, offset + match.length + 20);

      // Common version contexts
      const versionIndicators = [
        /v\s*$/i,           // "v 192.168.1.1" or "v4.14"
        /version\s*$/i,     // "version 4.14"
        /kernel\s*$/i,      // "kernel 4.14"
        /\d+\.\d+\s*→/,     // "4.14 →" or "4.14 ->"
        /→\s*$/,            // "→ 4.14"
        /->\s*$/,           // "-> 4.14"
      ];

      if (versionIndicators.some(pattern => pattern.test(before)) || /^\s*→/.test(after) || /^\s*->/.test(after)) {
        return match; // Likely a version number
      }

      // If only 2 or 3 octets (like "4.14" or "1.2.3"), treat as version number unless it looks like a private IP range
      const octetCount = match.split('.').length;
      if (octetCount < 4) {
        return match; // Version number
      }

      // If it's a public IP or private IP, sanitize it (a 4-octet match is
      // always sanitized; the old private-range check changed nothing)
      replacementCount++;
      return `<IP_${replacementCount}>`;
    });

    // IPv6 pattern (simplified) - more strict
    const ipv6Pattern = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
    sanitized = sanitized.replace(ipv6Pattern, () => {
      replacementCount++;
      return `<IP_${replacementCount}>`;
    });

    // Hostname pattern (common formats like hostname.domain.com)
    // More restrictive to avoid matching file extensions and JSON/K8s paths
    const hostnamePattern = /\b[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(?:\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\b/g;
    sanitized = sanitized.replace(hostnamePattern, (match, offset) => {
      // Skip common words that look like hostnames but aren't
      if (match.includes('example.') || match.includes('localhost')) {
        return match;
      }

      // Check if this is part of a Kubernetes annotation/label (has / before or after)
      const charAfter = sanitized[offset + match.length];
      const charBefore = offset > 0 ? sanitized[offset - 1] : '';
      if (charAfter === '/' || charBefore === '/') {
        return match;
      }

      // Get the last part (TLD)
      const parts = match.split('.');
      const tld = parts[parts.length - 1].toLowerCase();

      // Skip if it looks like a file extension
      const fileExtensions = ['json', 'yaml', 'yml', 'xml', 'txt', 'md', 'log', 'conf', 'config', 'ini', 'properties', 'toml', 'cfg'];
      if (fileExtensions.includes(tld)) {
        return match;
      }

      // Only sanitize if TLD is in our valid list or looks like a real domain
      // This avoids false positives like "something.something"
      const hasValidTLD = validTLDs.has(tld);
      const looksLikeDomain = tld.length >= 2 && parts.length >= 2;

      if (!hasValidTLD && !looksLikeDomain) {
        return match; // Not a real domain
      }

      // Additional check: if all parts are numbers, it might be a version
      const allNumbers = parts.every(part => /^\d+$/.test(part));
      if (allNumbers) {
        return match; // Version number like "4.14.0"
      }

      replacementCount++;
      return `<HOSTNAME_${replacementCount}>`;
    });

    return sanitized;
  };

  // "Add as AI Context": a new AI Chat with the highlighted passage attached
  // (redacted, editable in the chip's eye dialog - src/utils/aiContext.js)
  const handleAddSelectionAsAIContext = () => {
    if (!selectionMenu.text) return;
    const text = selectionMenu.text;
    closeSelectionMenu();
    window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } }));
    setTimeout(async () => {
      const { selectionContextPayload } = await import('../../../utils/aiContext');
      window.dispatchEvent(new CustomEvent('addAIContext', { detail: { contextData: selectionContextPayload(document, text) } }));
    }, 100);
  };

  // "Ask AI About This": open Quick AI (the same floating panel as "/ai")
  // with the highlighted text, exactly as highlighted, as the question's
  // context. The panel opens by the menu; the answer is inserted on a new
  // line below the selection (handleAcceptAIResponse), never over it.
  const handleAskQuickAIAboutSelection = () => {
    if (!selectionMenu.text) return;
    const { text, start, end, x, y } = selectionMenu;
    closeSelectionMenu();
    if (locked) return;
    const popupWidth = 400;
    const popupHeight = 500;
    setQuickAIPopupPos({ x: Math.max(20, Math.min(x, window.innerWidth - popupWidth - 20)), y: Math.max(20, Math.min(y, window.innerHeight - popupHeight - 20)) });
    setQuickAIContext({ text, start, end });
    setQuickAICursorPos(end);
    setQuickAIInput('');
    setQuickAIResponse('');
    setQuickAISelectedText('');
    setShowQuickAI(true);
    setTimeout(() => quickAIInputRef.current?.focus(), 100);
  };

  // Handle search in engine template
  const handleSearchInEngine = (template) => {
    if (!selectionMenu.text) return;

    const sanitized = detectSensitiveData(selectionMenu.text);
    if (onSearchInEngine) {
      onSearchInEngine(template, sanitized);
    }
    closeSelectionMenu();
  };

  // For preview, use live content from Yjs (ytext.toString()) for cloud docs, content prop for local docs.
  // NOTE: yjs.ytext.toString() (not yjs.content) is required for live correctness — useYjsText never
  // updates React state after init. Recomputation on CRDT changes (local or remote) is driven by the
  // always-on yjsContentVersion observer declared above lineLayoutData, which also serves the gutter.
  // Memoized and skipped entirely while the preview pane is hidden, so typing doesn't pay for
  // an O(doc) toString + full markdown parse on every keystroke.
  // A collaborator's edits re-render the preview through yjsContentVersion;
  // on a big document that is the whole pipeline per keystroke, so the
  // version the preview follows lags the live one by a delay that grows
  // with the document (src/utils/previewChunks.js previewRenderDelay: none
  // for an ordinary document). The first render of a preview, and the
  // user's own switch into it, are not delayed: they go through `content`.
  const previewDelay = isPreviewActive && yjsEnabled && yjs.ytext ? previewRenderDelay(yjs.ytext.length) : 0;
  const [laggedVersion, setLaggedVersion] = useState(yjsContentVersion);
  useEffect(() => {
    if (!previewDelay) return undefined;
    const timer = setTimeout(() => setLaggedVersion(yjsContentVersion), previewDelay);
    return () => clearTimeout(timer);
  }, [previewDelay, yjsContentVersion]);
  const previewVersion = previewDelay ? laggedVersion : yjsContentVersion;

  const previewSource = useMemo(() => {
    if (!isPreviewActive) return '';
    // If yjs has content, use it; otherwise fall back to content prop
    return yjsEnabled && yjs.ytext ? (yjs.ytext.toString() || content) : content;
    // previewVersion is a deliberate cache-buster for Yjs CRDT changes (ytext is mutable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreviewActive, yjsEnabled, yjs.ytext, content, previewVersion]);
  // A huge document (src/utils/previewChunks.js HUGE_PREVIEW_LINES / _CHARS) renders after the
  // "Rendering preview of N lines..." state below has been painted (src/hooks/useDeferredPreview.js);
  // every other document renders here, synchronously, as it always did.
  const previewSize = useMemo(() => (isPreviewActive ? hugePreview(previewSource) : { huge: false, lines: 0 }), [isPreviewActive, previewSource]);
  const { html: deferredPreviewHtml, pending: previewPending } = useDeferredPreview({
    active: isPreviewActive, source: previewSource, huge: previewSize.huge, documentKey: documentId, render: renderPreview, version: previewVersion,
  });
  const previewHtml = deferredPreviewHtml ?? '';

  // React re-applies dangerouslySetInnerHTML whenever the {__html} OBJECT
  // changes identity, not when the string inside it changes (react-dom
  // updateProperties compares the prop values with !== and then setProp
  // does `domElement.innerHTML = value.__html` unconditionally). An object
  // literal built inline on every render therefore rebuilt the entire
  // preview DOM on any unrelated editor state change while in preview
  // (context menu open/close, search/replace state, ...), which detached the
  // rendered mermaid SVGs and made the mermaid effect redraw them from the
  // cache. Memoise the object on the HTML string so the preview DOM - and
  // the SVGs inside it - is only touched when the preview HTML really
  // changes. Diagram scaling on resize is pure CSS (index.css
  // .mermaid-diagram-output svg { max-width: 100% }) and never needed a
  // rebuild.
  const previewInnerHtml = useMemo(() => ({ __html: previewHtml }), [previewHtml]);

  // A big document's preview: its top-level blocks grouped into chunks the
  // browser lays out and paints only near the viewport
  // (src/utils/previewChunks.js, index.css .md-chunk) - after React has set
  // the HTML and before the first paint, so the layout of the whole
  // document is never done. Nothing happens below the size where it pays.
  // a document switch (the sidebar, a tab): the view's place becomes the opened document's remembered one, set
  // here so the preview effect below reads it in this same commit; a document without one starts at the top. The
  // editor is not remounted on a switch: the effect that swaps its text applies the place there.
  const placeSwitchRef = useRef(documentId);
  useLayoutEffect(() => {
    if (placeSwitchRef.current === documentId) return;
    placeSwitchRef.current = documentId;
    // the document being left: its place and selection, from the editor still showing it (the surface swaps
    // its text in a later effect; a preview records its place as it scrolls)
    const leaving = previousPlaceKeyRef.current;
    const s = textareaRef.current;
    if (leaving && leaving !== placeKey && !isPreviewActive && s && s.isCodeMirror) {
      try { rememberPlace(leaving, { line: s.topVisibleLine(), editorScrollTop: s.scrollTop, selection: { start: s.selectionStart, end: s.selectionEnd, direction: s.selectionDirection } }); } catch { /* no place to keep */ }
    }
    const saved = rememberedPlace(placeKey);
    // toEditor stays set: the editor is usually still mounted (the text-swap effect applies the place and clears
    // it), but when the document left was in Preview the editor is mounted anew for this one, and onSurface is
    // the only path that can place it - with toEditor cleared here it opened at the top
    viewPlaceRef.current = viewPlaceFrom(saved);
    if (!saved && previewRef.current) previewRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the switch only; the view mode is read as it is then
  }, [documentId, placeKey]);
  useLayoutEffect(() => {
    if (!isPreviewActive || !previewRef.current) return;
    chunkPreviewBlocks(previewRef.current);
    // the reader's place: the block of the line that was at the top of the
    // editor (the nearest preceding one), else the preview's own last offset
    const place = viewPlaceRef.current;
    if (place.toPreview != null) {
      const container = previewRef.current;
      const block = place.toPreview > 1 ? previewBlockForLine(container, place.toPreview) : null;   // line 1: the top itself
      const top = place.toPreview <= 1;
      place.toPreview = null;
      if (top) {
        container.scrollTop = 0;
      } else if (block) {
        scrollPreviewToBlock(container, block);
        // once more after the paint: the chunks' estimated sizes become real ones and the block may have moved
        requestAnimationFrame(() => { if (previewRef.current === container && container.isConnected) scrollPreviewToBlock(container, block); });
      } else if (place.previewScrollTop > 0) {
        container.scrollTop = place.previewScrollTop;
      }
    }
  }, [isPreviewActive, previewInnerHtml]);

  // Mermaid theme follows the app's light/dark state. ThemeContext toggles a
  // `dark` class on <html>; watch it (only while the preview is open) so a
  // theme switch re-renders the diagrams below with the matching palette.
  const [mermaidTheme, setMermaidTheme] = useState(() => mermaidThemeForApp());
  useEffect(() => {
    if (!isPreviewActive) return;
    const root = window.document.documentElement;
    const sync = () => setMermaidTheme(mermaidThemeForApp());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [isPreviewActive]);

  // Render ```mermaid fences in the preview. processInteractiveMarkdown
  // emits inert placeholders (source kept as a code block); this effect
  // turns them into SVG diagrams after the HTML is in the DOM, lazily
  // loading mermaid the first time a document actually contains one.
  // Rendered SVGs are memoized by source+theme inside mermaidDiagrams.js,
  // so re-opening the preview costs nothing. The AbortController makes
  // closing the preview or switching documents mid-render a no-op for the
  // in-flight work (no DOM writes into a stale/unmounted tree); the
  // MutationObserver mirrors the attachment-image effect above and catches
  // DOM rebuilds that leave fresh placeholders behind without a content
  // change. A render error never throws out of the effect: bad diagram
  // source becomes an inline error box next to the still-visible source.
  useEffect(() => {
    if (!isPreviewActive || !previewRef.current) return;
    const container = previewRef.current;
    if (!findMermaidTargets(container, mermaidTheme).length) return;

    const controller = new AbortController();
    let scheduled = null;
    const run = () => {
      scheduled = null;
      renderMermaidDiagrams(container, { theme: mermaidTheme, signal: controller.signal }).catch((err) => {
        console.error('[DocumentEditor] Mermaid rendering failed:', err);
      });
    };
    run();
    const observer = new MutationObserver(() => {
      if (!scheduled && container.querySelector(MERMAID_PENDING_SELECTOR)) {
        scheduled = setTimeout(run, 0);
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      controller.abort();
      observer.disconnect();
      if (scheduled) clearTimeout(scheduled);
    };
  }, [isPreviewActive, previewHtml, mermaidTheme]);

  // Render ```latex fences in the preview as display maths (src/utils/latexBlocks.js): the same pattern as the
  // mermaid effect above - placeholders filled in after the HTML is in the DOM, KaTeX and its stylesheet loaded
  // the first time a document has one, aborted on unmount or a document change, the observer catching DOM
  // rebuilds that bring back fresh placeholders. The maths take the preview's text colour (any theme).
  useEffect(() => {
    if (!isPreviewActive || !previewRef.current) return;
    const container = previewRef.current;
    if (!findLatexTargets(container).length) return;
    const controller = new AbortController();
    let scheduled = null;
    const run = () => {
      scheduled = null;
      renderLatexBlocks(container, { signal: controller.signal }).catch((err) => {
        console.error('[DocumentEditor] LaTeX rendering failed:', err);
      });
    };
    run();
    const observer = new MutationObserver(() => {
      if (!scheduled && container.querySelector(LATEX_PENDING_SELECTOR)) scheduled = setTimeout(run, 0);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      controller.abort();
      observer.disconnect();
      if (scheduled) clearTimeout(scheduled);
    };
  }, [isPreviewActive, previewHtml]);

  // ---- the toolbar's derived bits (see the Toolbar markup) ----
  const canEdit = !locked && isOwner;
  const { attach: attachToolbar, onKeyDown: onToolbarKeyDown, onFocus: onToolbarFocus } = useRovingToolbar([canEdit, isMobile]);
  const headingLabel = caretBlock.heading ? `H${caretBlock.heading}` : '\u00b6';
  // Shortcut labels: the bound chords for this device and platform (⌘I /
  // Ctrl+I; Bold and Insert link show one only once the user binds them in
  // Settings > Shortcuts), the fixed Tab / Shift+Tab of the list indent.
  const shortcuts = {
    bold: boldHint,
    italic: italicHint,
    link: linkHint,
    indent: formatShortcut('Tab'),
    outdent: formatShortcut('Shift+Tab'),
  };
  const ListIcon = caretBlock.list === 'numbered' ? ListOrdered : caretBlock.list === 'task' ? ListTodo : List;
  const headingItems = [
    { id: 'paragraph', kind: 'radio', checked: caretBlock.heading === 0, Icon: Pilcrow, label: 'Paragraph', onSelect: () => setHeadingLevel(0) },
    { id: 'heading-1', kind: 'radio', checked: caretBlock.heading === 1, Icon: Heading1, label: 'Heading 1', onSelect: () => setHeadingLevel(1) },
    { id: 'heading-2', kind: 'radio', checked: caretBlock.heading === 2, Icon: Heading2, label: 'Heading 2', onSelect: () => setHeadingLevel(2) },
    { id: 'heading-3', kind: 'radio', checked: caretBlock.heading === 3, Icon: Heading3, label: 'Heading 3', onSelect: () => setHeadingLevel(3) },
  ];
  const listItems = [
    { id: 'list-bullet', kind: 'radio', checked: caretBlock.list === 'bullet', Icon: List, label: 'Bullet list', onSelect: () => setListKind('bullet') },
    { id: 'list-numbered', kind: 'radio', checked: caretBlock.list === 'numbered', Icon: ListOrdered, label: 'Numbered list', onSelect: () => setListKind('numbered') },
    { id: 'list-task', kind: 'radio', checked: caretBlock.list === 'task', Icon: ListTodo, label: 'Task list', onSelect: () => setListKind('task') },
  ];
  // (the item objects are built once and listed in both menus: calling an
  // array method on a list of helpers that read the editor ref reads, to
  // the React Compiler, a ref during render)
  const tableItem = { id: 'table', Icon: Table, label: 'Table', onSelect: insertTable };
  // (the library gives the focus back to the toolbar button whose menu listed the item)
  const imageItem = { id: 'image', Icon: ImageIcon, label: 'Image', onSelect: () => { mediaOpener.current = (isMobile ? moreMenu : insertMenu).anchor.current; setShowMediaLibrary(true); } };
  const tocItem = { id: 'toc', Icon: TableOfContents, label: 'Table of contents', onSelect: insertTableOfContents };
  const docLinkItem = { id: 'doc-link', Icon: FileSymlink, label: 'Link to document', onSelect: insertDocLinkPrompt };
  const calloutItems = CALLOUT_TYPES.map((c) => ({ id: `callout-${c.type}`, Icon: CALLOUT_ICONS[c.type], label: c.label, onSelect: () => insertCallout(c.type) }));
  const quoteItem = { id: 'quote', Icon: Quote, label: 'Quote', onSelect: () => insertMarkdown('> ', '', 'quote') };
  const ruleItem = { id: 'rule', Icon: Minus, label: 'Horizontal rule', onSelect: insertHorizontalRule };
  const codeBlockItem = { id: 'code-block', Icon: FileCode, label: 'Code block', onSelect: insertCodeBlock };
  // PDF export only (the preview just marks them): see insertPdfDirective
  const pdfItems = [
    { id: 'pagebreak', Icon: SeparatorHorizontal, label: 'Page break', onSelect: () => insertPdfDirective('[[pagebreak]]') },
    { id: 'blankpage', Icon: File, label: 'Blank page', onSelect: () => insertPdfDirective('[[blankpage]]') },
    { id: 'centerpage', Icon: AlignCenter, label: 'Centered page', onSelect: () => wrapPdfDirective('centerpage', 'Example Title') },
    { id: 'pdf-header', Icon: PanelTop, label: 'Page header', onSelect: () => wrapPdfDirective('header', 'Example Header') },
    { id: 'pdf-footer', Icon: PanelBottom, label: 'Page footer', onSelect: () => wrapPdfDirective('footer', 'Example Footer') },
  ];
  const insertItems = [
    tableItem, imageItem, tocItem, docLinkItem,
    { heading: 'Callouts' }, ...calloutItems,
    { heading: 'Blocks' }, quoteItem, ruleItem, codeBlockItem,
    { heading: 'PDF' }, ...pdfItems,
  ];
  const moreItems = [
    { heading: 'Text' },
    { id: 'strike', Icon: Strikethrough, label: 'Strikethrough', onSelect: () => insertMarkdown('~~', '~~', 'strikethrough') },
    { id: 'code', Icon: Code, label: 'Code', onSelect: insertCode },
    { heading: 'List' },
    { id: 'outdent', Icon: IndentDecrease, label: 'Decrease indent', onSelect: () => indentText(false) },
    { id: 'indent', Icon: IndentIncrease, label: 'Increase indent', onSelect: () => indentText(true) },
    { heading: 'Insert' },
    tableItem, imageItem, tocItem,
    { heading: 'Callouts' }, ...calloutItems,
    { heading: 'Blocks' }, quoteItem, ruleItem, codeBlockItem,
    { heading: 'PDF' }, ...pdfItems,
  ];

  return (
    <div className={`flex flex-col h-full bg-os-card ${className}`}>

      {/* Toolbar: one strip, grouped (text | heading | list | link + insert),
          then the edit/preview toggle right after the last group - never
          pushed to the far edge. role="toolbar" with a roving tabindex (one
          tab stop; Left/Right move, Home/End jump), the dropdowns are
          WAI-ARIA menus (ToolbarMenu). On the phone the strip is seven
          controls wide so nothing scrolls: Bold, Italic, Heading, List,
          Link, More (the rest), the toggle. */}
      <div
        ref={attachToolbar}
        onKeyDown={onToolbarKeyDown}
        onFocus={onToolbarFocus}
        role="toolbar"
        aria-label="Editor toolbar"
        data-testid="editor-toolbar"
        className="sc-editor-toolbar border-b border-os-border p-2 flex items-center gap-1 flex-wrap shrink-0 max-md:flex-nowrap max-md:overflow-x-auto"
      >
        {canEdit && !isMobile && (
          <>
            <span className="sc-toolbar-group contents" data-testid="toolbar-group-text">
              <ToolbarButton Icon={Bold} title={`Bold${shortcuts.bold}`} onClick={() => insertMarkdown('**', '**', 'bold')} testId="tb-bold" />
              <ToolbarButton Icon={Italic} title={`Italic${shortcuts.italic}`} onClick={() => insertMarkdown('*', '*', 'italic')} testId="tb-italic" />
              <ToolbarButton Icon={Strikethrough} title="Strikethrough" onClick={() => insertMarkdown('~~', '~~', 'strikethrough')} testId="tb-strike" />
              <ToolbarButton Icon={Code} title="Code (inline, or a block for a multi-line selection)" onClick={insertCode} testId="tb-code" />
            </span>
            <div className="w-px h-6 bg-os-border mx-1" role="separator" aria-orientation="vertical" />
            <ToolbarMenuButton title="Heading" label={headingLabel} menu={headingMenu} testId="heading-menu-button" />
            <div className="w-px h-6 bg-os-border mx-1" role="separator" aria-orientation="vertical" />
            <span className="sc-toolbar-group contents" data-testid="toolbar-group-list">
              <ToolbarMenuButton Icon={ListIcon} title="List" menu={listMenu} testId="list-menu-button" />
              <ToolbarButton Icon={IndentDecrease} title={`Decrease indent (${shortcuts.outdent} in a list)`} onClick={() => indentText(false)} testId="tb-outdent" />
              <ToolbarButton Icon={IndentIncrease} title={`Increase indent (${shortcuts.indent} in a list)`} onClick={() => indentText(true)} testId="tb-indent" />
            </span>
            <div className="w-px h-6 bg-os-border mx-1" role="separator" aria-orientation="vertical" />
            <span className="sc-toolbar-group contents" data-testid="toolbar-group-insert">
              <ToolbarButton Icon={Link} title={`Insert link${shortcuts.link}`} onClick={insertLink} testId="tb-link" />
              <ToolbarMenuButton Icon={Plus} title="Insert" menu={insertMenu} testId="insert-menu-button" />
            </span>
            <div className="w-px h-6 bg-os-border mx-1" role="separator" aria-orientation="vertical" />
          </>
        )}
        {canEdit && isMobile && (
          <>
            <ToolbarButton Icon={Bold} title={`Bold${shortcuts.bold}`} onClick={() => insertMarkdown('**', '**', 'bold')} testId="tb-bold" />
            <ToolbarButton Icon={Italic} title={`Italic${shortcuts.italic}`} onClick={() => insertMarkdown('*', '*', 'italic')} testId="tb-italic" />
            <ToolbarMenuButton title="Heading" label={headingLabel} menu={headingMenu} testId="heading-menu-button" />
            <ToolbarMenuButton Icon={ListIcon} title="List" menu={listMenu} testId="list-menu-button" />
            <ToolbarButton Icon={Link} title={`Insert link${shortcuts.link}`} onClick={insertLink} testId="tb-link" />
            <ToolbarMenuButton Icon={Ellipsis} title="More" menu={moreMenu} testId="more-menu-button" />
            <div className="w-px h-6 bg-os-border mx-1" role="separator" aria-orientation="vertical" />
          </>
        )}
        {canEdit && (
          <>
            <ToolbarMenu open={headingMenu.open} onClose={headingMenu.close} anchorRef={headingMenu.anchor} items={headingItems} label="Heading" testId="heading-menu" />
            <ToolbarMenu open={listMenu.open} onClose={listMenu.close} anchorRef={listMenu.anchor} items={listItems} label="List" testId="list-menu" />
            {!isMobile && <ToolbarMenu open={insertMenu.open} onClose={insertMenu.close} anchorRef={insertMenu.anchor} items={insertItems} label="Insert" testId="insert-menu" />}
            {isMobile && <ToolbarMenu open={moreMenu.open} onClose={moreMenu.close} anchorRef={moreMenu.anchor} items={moreItems} label="More" testId="more-menu" />}
          </>
        )}

        {/* Auto-Typer Button (Testing Mode Only) */}
        {typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'testing' && canEdit && (
          <>
            <button
              onClick={isAutoTyping ? handleStopAutoTyper : handleStartAutoTyper}
              className={`p-1.5 transition-colors ${
 isAutoTyping
 ?'btn btn-danger-solid'
 :'btn btn-success'
 }`}
              title={isAutoTyping ? 'Stop Auto-Typer' : 'Start Auto-Typer (Lorem Ipsum)'}
            >
              {isAutoTyping ? (
                <Square size={16} className="text-white" />
              ) : (
                <Type size={16} className="text-white" />
              )}
            </button>
            <div className="w-px h-6 bg-os-border mx-1" />
          </>
        )}

        {/* Preview Toggle: OFF -> PREVIEW (blue, this document) -> PREVIEW-ALL (orange, global) -> OFF.
            Left-aligned: it follows the last group like any other control (no spacer). */}
        <button
          onClick={togglePreview}
          data-testid="editor-mode-toggle"
          className={`sc-editor-mode p-1.5 rounded-sm transition-colors ${
 previewAllDocuments
 ?'bg-orange-500 text-white'
 : previewMode
 ?'btn-selected'
 :'hover:bg-os-card-secondary'
 }`}
          title={
            previewAllDocuments
              ? 'Preview (all documents) - click to turn off'
              : previewMode
                ? 'Edit'
                : 'Preview'
          }
          aria-label={
            previewAllDocuments
              ? 'Preview (all documents) - click to turn off'
              : previewMode
                ? 'Edit'
                : 'Preview'
          }
          aria-pressed={isPreviewActive}
        >
          {isPreviewActive ? (
            <Edit3 size={16} className="text-white" />
          ) : (
            <Eye size={16} className="text-os-text-primary" />
          )}
        </button>

      </div>

      {/* Offline banner for shared documents (shared NoticeBanner strip) */}
      {document?.inCloud && !isOnline && (
        <NoticeBanner tone="offline" title="Offline - Read Only" testId="document-offline-banner">
          <span>Shared documents require an online connection for editing. Reconnect to make changes.</span>
        </NoticeBanner>
      )}

      {/* Read-only banner for documents shared by someone else */}
      {document?.inCloud && !isOwner && (
        <NoticeBanner tone="readonly" title="Read-only:" testId="document-readonly-banner">
          <span>This document is shared by another team member. You can view but not edit.</span>
        </NoticeBanner>
      )}

      {/* Server-copy-unavailable banner: the server could not load this
          document's persisted state (corrupted/undecryptable snapshot), so we
          render the local IndexedDB copy read-only instead of trusting - or
          silently re-seeding - the server's empty placeholder. */}
      {serverCopyUnavailable && (
        <NoticeBanner tone="warning" title="Server copy unavailable:" testId="document-server-copy-banner">
          <span>
            This document could not be loaded from the server (its stored copy is
            corrupted or unreadable). You are viewing your local cached copy,
            read-only. To restore it, right-click the document and choose
            &quot;Sync Changes&quot; to re-upload a local copy.
          </span>
        </NoticeBanner>
      )}

      {/* What the home-server sync did to this document: updated in place,
          or a concurrent edit resolved (the other version kept as a conflict
          copy) - the same strip as the notices above, never a pop-up. */}
      {syncNotice && (
        <NoticeBanner tone={syncNotice.kind === 'warning' ? 'warning' : 'info'} testId="document-sync-banner" onDismiss={onDismissSyncNotice}>
          <span>{syncNotice.text}</span>
          {syncNotice.copyId != null && onOpenDocumentById && (
            <NoticeBannerAction onClick={() => onOpenDocumentById(syncNotice.copyId)} testId="document-sync-open-copy">
              Open conflict copy
            </NoticeBannerAction>
          )}
        </NoticeBanner>
      )}

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {isPreviewActive && previewPending ? (
          // a huge document: painted first, the render follows (useDeferredPreview)
          <div className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card" data-testid="preview-rendering" aria-busy="true">
            <Note tone="info" icon={null} testId="preview-rendering-note">
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Rendering preview of {previewSize.lines.toLocaleString()} lines&hellip;
              </span>
            </Note>
          </div>
        ) : isPreviewActive ? (
          <div
            ref={previewRef}
            onClick={handlePreviewClick}
            onContextMenu={handlePreviewContextMenu}
            onScroll={handlePreviewScroll}
            className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card"
            dangerouslySetInnerHTML={previewInnerHtml}
          />
        ) : (
          <div className="h-full overflow-hidden flex">
            <div className="relative flex-1 h-full overflow-hidden">
            {/* Auto-typing indicator */}
            {isAutoTyping && (
              <div className="absolute top-2 right-2 z-10 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-sm shadow-lg flex items-center gap-2">
                <Type size={14} className="animate-pulse" />
                Auto-typing...
              </div>
            )}
            <CodeMirrorEditor
              value={yjsEnabled ? undefined : content}
              defaultValue={content}
              yjs={yjsBinding}
              onSurface={onSurface}
              onChange={handleContentChange}
              onContextMenu={handleTextSelectionContextMenu}
              onMouseUp={handleCursorMove}
              onSelect={handleCursorMove}
              onClick={(e) => { if (isAutoTyping) e.preventDefault(); }}
              onKeyDown={(e) => { if (isAutoTyping) { e.preventDefault(); return; } handleKeyDown(e); }}
              readOnly={editorReadOnly}
              spellcheck={spellcheckOn}
              docLinkResolver={docLinkResolver}
              placeholder={
                locked
                  ? 'This document is locked'
                  : !isOwner
                ? 'This document is read-only (owned by another user)'
                  : (document?.inCloud && !isOnline)
                ? 'Shared documents are read-only when offline'
                : serverCopyUnavailable
                ? 'Read-only: the server could not load this document - viewing your local copy'
                : isAutoTyping
                ? 'Auto-typing in progress...'
                : 'Type / for commands and templates (callouts, Quick Workflow, Quick AI, Quick Task)...'
              }
              className={`h-full ${locked || !isOwner || isAutoTyping ? 'cursor-default' : ''}`}
            />
            </div>
          </div>
        )}
      </div>

      {/* Quick AI Command Popup */}
      {showQuickAI && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={handleCancelQuickAI}
          />

          {/* Floating Popup */}
          <div
            className="fixed z-50 bg-os-card rounded-lg shadow-2xl border border-os-border"
            style={{
              left: `${quickAIPopupPos.x}px`,
              top: `${quickAIPopupPos.y}px`,
              width: '400px',
              maxHeight: '500px'
            }}
          >
            {/* Header */}
            <div
              className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-linear-to-r from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 cursor-grab active:cursor-grabbing"
              onMouseDown={handleQuickAIDragStart}
            >
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-purple-600 dark:text-purple-300" />
                <span className="text-sm font-semibold text-purple-900 dark:text-purple-200">Quick AI</span>
              </div>
              <div className="flex items-center gap-1">
                {quickAIResponse && !quickAILoading && (
                  <button
                    onClick={() => {
                      setQuickAIResponse('');
                      setQuickAIInput('');
                      setQuickAISelectedText('');
                      setTimeout(() => quickAIInputRef.current?.focus(), 0);
                    }}
                    className="btn btn-brand-ghost p-1"
                    title="Clear response"
                  >
                    <Trash2 size={14} className="text-purple-700 dark:text-purple-300" />
                  </button>
                )}
                <button
                  onClick={handleCancelQuickAI}
                  className="btn btn-brand-ghost p-1"
                  title="Close"
                >
                  <X size={14} className="text-purple-700 dark:text-purple-300" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-3 py-3 space-y-3">
              {/* "Ask AI About This": the highlighted text travels with the question (a one-line preview) */}
              {quickAIContext && (
                <div data-testid="quick-ai-context-note">
                  <p className="text-xs text-os-text-secondary">Your highlighted text is included with the question.</p>
                  <p className="text-xs text-os-text-muted truncate font-mono" data-testid="quick-ai-context-preview">{quickAIContext.text.split('\n')[0].slice(0, 80)}{quickAIContext.text.length > 80 || quickAIContext.text.includes('\n') ? '\u2026' : ''}</p>
                </div>
              )}
              {/* Input */}
              <div>
                <input
                  ref={quickAIInputRef}
                  type="text"
                  value={quickAIInput}
                  onChange={(e) => setQuickAIInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !quickAILoading && backendStatus === 'online') {
                      e.preventDefault();
                      handleQuickAISubmit();
                    } else if (e.key === 'Escape') {
                      handleCancelQuickAI();
                    }
                  }}
                  placeholder="for loop in bash, sort function..."
                  disabled={quickAILoading || backendStatus === 'offline'}
                  className="w-full px-2 py-1.5 text-sm border border-purple-300 rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <p className="text-xs text-os-text-secondary mt-1">Enter to submit • Esc to cancel</p>
              </div>

              {/* Response */}
              {(quickAIResponse || quickAILoading) && (
                <div>
                  <div className="relative">
                    <textarea
                      ref={quickAIResponseRef}
                      value={quickAILoading && !quickAIResponse ? (quickAIPhase === 'thinking' ? 'Thinking...' : 'Waiting for the model...') : quickAIResponse}
                      readOnly={quickAILoading}
                      onSelect={handleQuickAIResponseSelection}
                      onMouseUp={handleQuickAIResponseSelection}
                      className="w-full h-48 px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden cursor-text text-os-text-primary"
                    />
                    {quickAILoading && !quickAIResponse && (
                      <div className="absolute inset-0 flex items-center justify-center bg-os-card/75 rounded-sm">
                        <RefreshCw size={20} className="text-purple-600 animate-spin" />
                      </div>
                    )}
                  </div>
                  {quickAILoading && (
                    <p className="text-xs text-os-text-secondary mt-1 flex items-center justify-between gap-2" data-testid="quick-ai-status">
                      <span>{quickAIPhase === 'thinking' ? 'The model is thinking...' : quickAIPhase === 'answering' ? 'Answering...' : 'Waiting for the model...'}</span>
                      <button type="button" onClick={handleQuickAICancel} className="btn btn-secondary px-2 py-0.5 text-xs" data-testid="quick-ai-cancel">Cancel</button>
                    </p>
                  )}
                  {quickAITruncated && !quickAILoading && (
                    <p className="text-xs text-os-text-secondary mt-1 flex items-center justify-between gap-2" data-testid="quick-ai-truncated">
                      <span>{truncationMessage(typeof quickAITruncated === 'number' ? quickAITruncated : null)}</span>
                      <button type="button" onClick={handleQuickAIContinue} className="btn btn-secondary px-2 py-0.5 text-xs shrink-0" data-testid="quick-ai-continue">Continue</button>
                    </p>
                  )}
                  {quickAISelectedText && !quickAILoading && (
                    <p className="text-xs text-purple-600 mt-1">
                      {quickAISelectedText.length} characters selected
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-os-border flex justify-end gap-2 bg-os-card-secondary">
              {!quickAIResponse ? (
                <button
                  onClick={handleQuickAISubmit}
                  disabled={!quickAIInput.trim() || quickAILoading || backendStatus === 'offline'}
                  className="btn btn-brand flex-1 px-3 py-1.5 text-xs flex items-center justify-center gap-1.5"
                  title={backendStatus === 'offline' ? 'Backend service is not running' : 'Generate (Enter)'}
                >
                  {quickAILoading ? 'Generating...' : 'Generate'}
                </button>
              ) : (
                !quickAILoading && (
                  <button
                    onClick={() => handleAcceptAIResponse(true)}
                    disabled={!quickAISelectedText}
                    className="btn btn-success flex-1 px-3 py-1.5 text-xs flex items-center justify-center gap-1.5"
                    title={quickAISelectedText ? 'Insert selected text' : 'Select text in the response to insert'}
                  >
                    <Check size={14} />
                    Insert Selected
                  </button>
                )
              )}
            </div>
          </div>
        </>
      )}

      {/* Quick Workflow Popup */}
      <QuickWorkflow
        visible={showQuickWorkflow}
        position={quickWorkflowPopupPos}
        onClose={() => setShowQuickWorkflow(false)}
        onInsert={handleInsertWorkflowResult}
      />

      {/* Quick Tasks Popup (/task) - only mounted while open; it needs the
          app's NotificationProvider for its success/error feedback */}
      {showQuickTasks && (
        <QuickTasks
          visible={showQuickTasks}
          position={quickTasksPopupPos}
          onClose={() => {
            setShowQuickTasks(false);
            setQuickTasksCursorPos(null);
          }}
          onCreated={handleQuickTaskCreated}
        />
      )}

      {/* Link to document - the picker ([[doc:...]]) */}
      {docLinkMenu.visible && !locked && !isPreviewActive && (
        <>
          <div className="fixed inset-0" onClick={() => setDocLinkMenu(CLOSED_DOC_LINK_MENU)} style={{ zIndex: 2147483646 }} />
          <div
            ref={docLinkMenuRef}
            role="listbox"
            aria-label="Link to document"
            data-testid="doc-link-menu"
            className="fixed w-96 flex flex-col bg-os-card border border-os-border rounded-lg shadow-2xl overflow-hidden"
            style={{ zIndex: 2147483647 }}
          >
            <div className="px-3 py-2 bg-os-card-secondary">
              <div className="flex items-center gap-2">
                <FileSymlink size={14} className="text-os-blue" />
                <span className="text-xs font-medium text-os-text-primary">
                  {docLinkMenu.closed ? 'Convert to a permanent link' : 'Link to document'}{docLinkMenu.query && ` - "${docLinkMenu.query}"`}
                </span>
              </div>
            </div>
            <div className="overflow-y-auto max-h-80 min-h-0" data-caret-popup-list>
              {docLinkResults.length === 0 ? (
                <div className="p-6 text-center">
                  <FileSymlink size={32} className="text-os-text-muted mx-auto mb-2" />
                  <p className="text-sm text-os-text-secondary">{docLinkMenu.query ? `No document titled "${docLinkMenu.query}"` : 'No other documents to link to'}</p>
                  <p className="text-xs text-os-text-muted mt-1">Keep typing a title, or Escape to leave the text as it is</p>
                </div>
              ) : (
                docLinkResults.map((doc, idx) => (
                  <div
                    key={doc.stableId}
                    role="option"
                    aria-selected={idx === docLinkMenu.selectedIndex}
                    data-doc-link-entry={doc.stableId}
                    onMouseEnter={() => setDocLinkMenu(prev => ({ ...prev, selectedIndex: idx }))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertDocLink(doc)}
                    className={`w-full px-3 py-2 text-left transition-colors border-b border-os-border last:border-b-0 cursor-pointer ${idx === docLinkMenu.selectedIndex ? 'bg-os-card-secondary' : 'hover:bg-os-card-secondary'}`}
                  >
                    <div className="text-sm font-medium text-os-text-primary truncate">{doc.title}</div>
                    <div className="text-xs text-os-text-muted mt-0.5 truncate">{doc.category}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Slash Command Menu - Template Picker */}
      {slashMenu.visible && !locked && !isPreviewActive && (
        <>
          <div
            className="fixed inset-0"
            onClick={() => setSlashMenu({ visible: false, position: { x: 0, y: 0 }, query: '', slashPosition: 0, selectedIndex: 0 })}
            style={{ zIndex: 2147483646 }}
          />
          <div
            ref={slashMenuRef}
            data-testid="slash-menu"
            className="fixed w-96 flex flex-col bg-os-card border border-os-border rounded-lg shadow-2xl overflow-hidden"
            style={{ zIndex: 2147483647 }}
          >
            <div className="px-3 py-2 bg-purple-50 dark:bg-purple-900/20">
              <div className="flex items-center gap-2">
                <BookTemplate size={14} className="text-purple-600 dark:text-purple-300" />
                <span className="text-xs font-medium text-purple-900 dark:text-purple-200">
                  Commands and templates {slashMenu.query && `- "${slashMenu.query}"`}
                </span>
              </div>
            </div>
            <div className="overflow-y-auto max-h-80 min-h-0" data-caret-popup-list>
              {filteredTemplates.length === 0 ? (
                <div className="p-6 text-center">
                  <BookTemplate size={32} className="text-os-text-muted mx-auto mb-2" />
                  <p className="text-sm text-os-text-secondary">No templates found</p>
                  <p className="text-xs text-os-text-secondary mt-1">
                    {slashMenu.query ? `No matches for "${slashMenu.query}"` : 'Create templates to use them here'}
                  </p>
                </div>
              ) : (
                filteredTemplates.map((template, idx) => (
                  <div key={template.id}>
                  {(idx === 0 || !!filteredTemplates[idx - 1].builtin !== !!template.builtin) && (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-os-text-muted" data-slash-group={template.builtin ? 'builtin' : 'templates'}>
                      {template.builtin ? 'BUILT-IN' : 'TEMPLATES'}
                    </div>
                  )}
                  <div
                    data-slash-entry={template.id}
                    onMouseEnter={() => setSlashMenu(prev => ({ ...prev, selectedIndex: idx }))}
                    onClick={() => insertTemplate(template)}
                    className={`w-full px-3 py-2 text-left transition-colors border-b border-os-border dark:border-os-sidebar-hover last:border-b-0 cursor-pointer ${
 idx === slashMenu.selectedIndex
 ?'bg-purple-100 dark:bg-purple-900/30'
 :'hover:bg-purple-50 dark:hover:bg-purple-900/20'
 }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-os-text-primary truncate">
                          {template.builtin ? `${template.label} (${template.name})` : template.name}
                        </div>
                        {template.description && (
                          <div className="text-xs text-os-text-muted mt-0.5 truncate">
                            {template.description}
                          </div>
                        )}
                        {template.tags && template.tags.length > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {template.tags.slice(0, 3).map((tag, i) => (
                              <span
                                key={i}
                                className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-sm"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-os-text-muted shrink-0">
                        {template.category}
                      </div>
                    </div>
                  </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Text Selection Context Menu */}
      <TextSelectionMenu
        ref={selectionMenuRef}
        visible={selectionMenu.visible}
        x={selectionMenu.x}
        y={selectionMenu.y}
        selectedText={selectionMenu.text}
        editable={!editorReadOnly}
        clipboard={selectionMenu.clipboard}
        onCut={handleSelectionCut}
        onCopy={handleSelectionCopy}
        onPaste={handleSelectionPaste}
        onAskAI={handleAskQuickAIAboutSelection}
        onAddAsContext={handleAddSelectionAsAIContext}
        onSearchIn={handleSearchInEngine}
        engineTemplates={engineTemplates}
        spell={selectionMenu.spell}
        onReplaceWord={handleSpellReplace}
        onAddWord={handleSpellAddWord}
        onClose={closeSelectionMenu}
      />

      {/* Search and Replace Panel */}
      {showSearchReplace && (
        <div className="absolute top-16 right-4 bg-os-card border border-os-border rounded-lg shadow-lg p-3 z-50 w-80">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {showReplace ? (
                <Replace size={16} className="text-os-text-primary" />
              ) : (
                <Search size={16} className="text-os-text-primary" />
              )}
              <span className="text-sm font-semibold text-os-text-primary">
                {showReplace ? 'Find & Replace' : 'Find'}
              </span>
            </div>
            <button
              onClick={handleCloseSearch}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
              title="Close (Esc)"
            >
              <X size={14} className="text-os-text-primary" />
            </button>
          </div>

          {/* Read-only warning for replace mode */}
          {showReplace && (locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) && (
            <div className="mb-2 px-2 py-1.5 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-200 text-xs rounded-sm flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>
                {locked
                  ? 'Document is locked'
                  : !isOwner
                  ? 'Read-only (not owner)'
                  : (document?.inCloud && !isOnline)
                  ? 'Offline - shared documents are read-only'
                  : 'Read-only - server copy unavailable'}
              </span>
            </div>
          )}

          {/* Search Input */}
          <div className="mb-2">
            <div className="flex gap-1">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={() => {
                  searchInputFocusedRef.current = true;
                }}
                onBlur={() => {
                  searchInputFocusedRef.current = false;
                  // Only trigger immediate search if there's a pending debounce (user was still typing)
                  if (searchDebounceTimer.current) {
                    clearTimeout(searchDebounceTimer.current);
                    searchDebounceTimer.current = null;
                    performSearch(searchQuery, getSearchContent(), true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleFindNext();
                  } else if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    handleFindPrevious();
                  } else if (e.key === 'Escape') {
                    handleCloseSearch();
                  }
                }}
                placeholder="Search..."
                className="flex-1 px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue focus:ring-1 focus:ring-os-blue"
              />
              <button
                onClick={handleFindPrevious}
                disabled={searchMatches.length === 0}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Previous (Shift+Enter)"
              >
                <ChevronUp size={16} className="text-os-text-primary" />
              </button>
              <button
                onClick={handleFindNext}
                disabled={searchMatches.length === 0}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Next (Enter)"
              >
                <ChevronDown size={16} className="text-os-text-primary" />
              </button>
            </div>
            {searchQuery && (
              <div className="text-xs text-os-text-muted mt-1">
                {searchMatches.length === 0
                  ? 'No matches found'
                  : `${currentMatchIndex + 1} of ${searchMatches.length} matches`}
              </div>
            )}
          </div>

          {/* Replace Input (if showReplace) */}
          {showReplace && (
            <div className="mb-2">
              <input
                type="text"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleReplace();
                  } else if (e.key === 'Escape') {
                    handleCloseSearch();
                  }
                }}
                disabled={locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable}
                placeholder="Replace with..."
                className="w-full px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue focus:ring-1 focus:ring-os-blue disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          )}

          {/* Options */}
          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="flex items-center gap-1.5 text-xs text-os-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="w-3.5 h-3.5 rounded-sm border-os-border"
              />
              <span>Case sensitive</span>
            </label>
            {!showReplace && !(locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) && (
              <button
                onClick={() => setShowReplace(true)}
                className="text-xs text-os-blue hover:underline"
              >
                + Replace
              </button>
            )}
          </div>

          {/* Action Buttons */}
          {showReplace && (
            <div className="flex gap-2">
              <button
                onClick={handleReplace}
                disabled={
                  searchMatches.length === 0 ||
                  currentMatchIndex < 0 ||
                  locked ||
                  !isOwner ||
                  (document?.inCloud && !isOnline) ||
                  serverCopyUnavailable
                }
                className="btn btn-primary flex-1 px-3 py-1.5 text-xs"
                title={
                  locked
                    ? 'Document is locked'
                    : !isOwner
                    ? 'Read-only (not owner)'
                    : (document?.inCloud && !isOnline)
                    ? 'Offline - shared documents are read-only'
                    : serverCopyUnavailable
                    ? 'Read-only - server copy unavailable'
                    : 'Replace current match'
                }
              >
                Replace
              </button>
              <button
                onClick={handleReplaceAll}
                disabled={
                  searchMatches.length === 0 ||
                  locked ||
                  !isOwner ||
                  (document?.inCloud && !isOnline) ||
                  serverCopyUnavailable
                }
                className="flex-1 px-3 py-1.5 text-xs bg-os-red hover:bg-os-red/90 text-white rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={
                  locked
                    ? 'Document is locked'
                    : !isOwner
                    ? 'Read-only (not owner)'
                    : (document?.inCloud && !isOnline)
                    ? 'Offline - shared documents are read-only'
                    : serverCopyUnavailable
                    ? 'Read-only - server copy unavailable'
                    : 'Replace all matches'
                }
              >
                Replace All
              </button>
            </div>
          )}

          <div className="text-xs text-os-text-muted mt-2 pt-2 border-t border-os-border">
            {(findLabel || replaceLabel) && (
              <div data-testid="find-bar-hint">{[findLabel && `${findLabel}: Find`, replaceLabel && !(locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) && `${replaceLabel}: Replace`].filter(Boolean).join(' \u2022 ')}</div>
            )}
            <div>Enter: Next • Shift+Enter: Previous</div>
          </div>
        </div>
      )}

      {/* Media Library Modal */}
      <MediaLibraryModal
        isOpen={showMediaLibrary}
        onClose={() => setShowMediaLibrary(false)}
        onSelectImage={insertImage}
        returnFocusTo={() => mediaOpener.current}
      />

      {/* Diagram context menu (right-click on a rendered mermaid diagram in the preview) */}
      <ContextMenu
        ref={diagramMenuRef}
        isVisible={isDiagramMenu('diagram')}
        x={diagramMenu.x}
        y={diagramMenu.y}
      >
        <ContextMenuItem
          icon={MENU_ICONS.download}
          label="Download SVG"
          onClick={() => handleDiagramMenuAction(downloadDiagramSvg)}
        />
      </ContextMenu>
    </div>
  );
}
