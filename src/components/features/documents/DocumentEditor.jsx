import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Bold, Italic, Info, Lightbulb, MessageSquareWarning, TriangleAlert, OctagonAlert, Code, List, ListOrdered, ListTodo, Link, Quote, Pilcrow, Heading1, Heading2, Heading3, Table, TableOfContents, Image as ImageIcon, Strikethrough, IndentDecrease, IndentIncrease, Minus, SeparatorHorizontal, File, AlignCenter, PanelTop, PanelBottom, Ellipsis, Plus, Eye, Edit3, BookTemplate, Bot, X, RefreshCw, Check, Trash2, FileCode, Search, Replace, ChevronDown, ChevronUp, Square, Type, Download } from 'lucide-react';
import { CALLOUT_TYPES } from '../../../utils/callouts';
import ToolbarMenu from './ToolbarMenu';
import { useToolbarMenu, useRovingToolbar } from '../../../hooks/toolbarMenu';
import { useMobile } from '../../../contexts/MobileContext';
import { formatShortcut } from '../../../utils/shortcuts';
import { BUILTIN_COMMANDS, matchesSlashQuery, slashQueryAt } from '../../../utils/slashCommands';

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
import { downloadBlob } from '../../../utils/exportHelpers';
import { useContextMenu } from '../../../hooks/useContextMenu';
import ContextMenu, { ContextMenuItem } from '../../common/menus/ContextMenu';
import TextSelectionMenu from './TextSelectionMenu';
import QuickWorkflow from './QuickWorkflow';
import QuickTasks from './QuickTasks';
import { getUserColor, hexToRgba } from '../../../utils/userColors';
import { useYjsText } from '../../../hooks/useYjsText';
import { getMachineId } from '../../../utils/cloudCentralSync';
import { getSocket } from '../../../utils/cloudWebSocket';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';
import { NO_AI_PROVIDER_MESSAGE, resolveAiRequestSettings, savedAiChatSettings } from '../../../utils/aiRequestSettings';
import MediaLibraryModal from '../../common/modals/MediaLibraryModal';
import { useLocalStorage } from '../../../hooks/useLocalStorage';
import { takePendingEditorFocus, takePendingEditorJump, DOCUMENT_JUMP_EVENT } from '../../../utils/openDocument';
import { lineStartOffset } from '../../../utils/findInFiles';
import { attachMacPeriodSubstitutionGuard } from '../../../utils/macPeriodSubstitution';
import { computeLineLayout, flatLineLayout, measureLinesWithMirror, measureTextareaRowPitch } from './gutterLineLayout';
import NoticeBanner, { NoticeBannerAction } from '../../common/NoticeBanner';
import { MENU_ICONS } from '../../common/menus/menuIcons';

/**
 * DocumentEditor - Sophisticated markdown editor with toolbar
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
}) {
  // console.log('=== DocumentEditor component rendered ===');
  // console.log('DocumentEditor props - documentId:', documentId, 'document.inCloud:', document?.inCloud, 'content.length:', content.length);

  const textareaRef = useRef(null);
  const previewRef = useRef(null);
  const slashMenuRef = useRef(null);
  const quickAIInputRef = useRef(null);
  const quickAIResponseRef = useRef(null);
  const quickAIDragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const selectionMenuRef = useRef(null);
  const previousDocumentIdRef = useRef(documentId);
  const [previewMode, setPreviewMode] = useState(false);
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

  // Quick AI state
  const [showQuickAI, setShowQuickAI] = useState(false);
  const [quickAIInput, setQuickAIInput] = useState('');
  const [quickAIResponse, setQuickAIResponse] = useState('');
  const [quickAILoading, setQuickAILoading] = useState(false);
  const [quickAICursorPos, setQuickAICursorPos] = useState(null);
  const [quickAIPopupPos, setQuickAIPopupPos] = useState({ x: 0, y: 0 });
  const [quickAISelectedText, setQuickAISelectedText] = useState('');
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
    text: ''
  });

  // Cloud document ownership state
  const [isOwner, setIsOwner] = useState(true);

  // Track scroll position to update cursor positions
  const [scrollPosition, setScrollPosition] = useState({ top: 0, left: 0 });

  // Cached character width for search highlights
  const charWidthRef = useRef(null);
  const measureDivRef = useRef(null);
  const matchPositionCache = useRef(new Map()); // Cache for match positions

  // Performance mode detection
  const [performanceMode, setPerformanceMode] = useState(false);
  const documentSizeRef = useRef(0);

  // Line numbers gutter
  const [textareaContentWidth, setTextareaContentWidth] = useState(0);
  // The textarea element currently mounted (null while the preview pane is
  // shown). The gutter's lineLayoutData memo below measures the live
  // textarea, but it is memoized on content/width: after preview mode (or a
  // document switch that lands back in the editor) swaps in a NEW textarea
  // of the same width, no dependency changed, the memo kept the uncalibrated
  // flat layout it computed while no textarea existed, and the line numbers
  // stayed hidden until the next keystroke. Tracking the element itself makes
  // every (re)mount one guaranteed re-render with the new element measurable.
  const [textareaElement, setTextareaElement] = useState(null);
  const gutterRef = useRef(null);

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
  const filteredTemplates = slashMenu.query
    ? templates.filter(t => matchesSlashQuery(t, slashMenu.query))
    : templates;

  // Reset scroll position and restore preview mode when switching documents
  useEffect(() => {
    // Check if we actually switched documents (not just a re-render)
    const documentChanged = previousDocumentIdRef.current !== documentId;

    if (documentChanged && textareaRef.current) {
      // Sync textarea value when switching documents (not during typing!)
      // For cloud documents: Set initial content from IndexedDB, then let Yjs override when synced
      // For local documents: always sync
      console.log('[DocumentEditor] Document changed - yjsEnabled:', yjsEnabled, 'yjs.ytext:', !!yjs.ytext, 'yjs.isReady:', yjs?.isReady, 'content.length:', content?.length || 0);

      // Always start with IndexedDB content when switching documents
      // Yjs will update the textarea when it's ready with the server content
      const currentContent = content;

      if (!yjsEnabled || (yjsEnabled && !yjs.ytext)) {
        // Local documents OR cloud documents when offline
        console.log('[DocumentEditor] Syncing document content to textarea (doc change):', currentContent?.length || 0, 'chars');
        if (textareaRef.current.value !== currentContent) {
          textareaRef.current.value = currentContent;
        }
      } else {
        // Cloud document - always show IndexedDB content initially
        // Yjs will update it when synced (via useYjsText's textarea update)
        console.log('[DocumentEditor] Cloud doc - showing IndexedDB content (Yjs will update when ready):', currentContent?.length || 0, 'chars');
        if (textareaRef.current.value !== currentContent) {
          textareaRef.current.value = currentContent;
        }
      }

      textareaRef.current.scrollTop = 0;
      textareaRef.current.setSelectionRange(0, 0);
    }

    if (documentChanged && previewRef.current) {
      previewRef.current.scrollTop = 0;
    }

    // Cleanup measure div when document changes
    if (documentChanged && measureDivRef.current) {
      window.document.body.removeChild(measureDivRef.current);
      measureDivRef.current = null;
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

  // Send cursor position and selection updates (for Yjs awareness)
  const handleCursorMove = () => {
    syncCaretBlock();
    if (!yjsEnabled || !yjs.updateCursor || !textareaRef.current) {
      return;
    }

    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;

    // Update Yjs awareness with cursor position
    yjs.updateCursor(start, end);
  };

  // The caret line's block after any content change (toolbar actions move
  // the caret in a timeout, after the new content is in the textarea)
  useEffect(() => {
    const timer = setTimeout(syncCaretBlock, 0);
    return () => clearTimeout(timer);
  }, [content, yjs.content, syncCaretBlock]);

  // Detect document size and enable performance mode for large documents
  useEffect(() => {
    const currentContent = yjsEnabled && yjs.content !== undefined ? yjs.content : content;
    const lineCount = currentContent.split('\n').length;
    const charCount = currentContent.length;

    documentSizeRef.current = lineCount;

    const shouldUsePerformanceMode = lineCount > 1000 || charCount > 50000;
    if (shouldUsePerformanceMode !== performanceMode) {
      // Guarded flip of the derived performance flag (no cascade: only fires
      // when the threshold is actually crossed)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPerformanceMode(shouldUsePerformanceMode);
    }
    // performanceMode is only compared, not a trigger; ytext identity is
    // covered by content/yjs.content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, yjs.content]);

  // Calibrate monospace character width and textarea content width
  useEffect(() => {
    if (!textareaRef.current) return;
    const textarea = textareaRef.current;
    const cs = window.getComputedStyle(textarea);

    const span = window.document.createElement('span');
    span.style.font = cs.font;
    span.style.lineHeight = cs.lineHeight;
    span.style.visibility = 'hidden';
    span.style.position = 'absolute';
    span.style.whiteSpace = 'pre';
    span.textContent = 'MMMMMMMMMM';
    window.document.body.appendChild(span);
    charWidthRef.current = span.getBoundingClientRect().width / 10;
    window.document.body.removeChild(span);

    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    setTextareaContentWidth(textarea.clientWidth - padLeft - padRight);
    // Re-run when preview mode swaps the textarea out and back in (new element)
  }, [documentId, isPreviewActive]);

  // Live version counter for the shared Yjs CRDT: bumped on every ytext change (local
  // keystrokes AND remote collaborators' edits). useYjsText intentionally never updates
  // React state after init (uncontrolled textarea), so for cloud docs neither the
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

  // Gutter line heights are measured, never estimated (see gutterLineLayout.js):
  // every distinct logical line is measured once against a hidden mirror of the
  // textarea and cached by its text, so a keystroke only measures the line it
  // changed and the gutter is exact on the same render as the keystroke. The
  // earlier design (character-count estimate while typing, real measurement
  // 200ms after the last keystroke) made numbers jump and then "fix" on every
  // Enter in a wrapped line.
  const lineHeightCacheRef = useRef({ key: '', map: new Map() });
  // The textarea's real px-per-row (Chrome lays textarea rows out on its 1/64px
  // grid slightly differently from a div), calibrated once per layout key
  const rowPitchRef = useRef({ key: '', value: 0 });

  // Web fonts (the editor's monospace face is Red Hat Mono with font-display:
  // swap) can land after the first measurement and move every wrap point; bump
  // a version so the cache is dropped and the gutter re-measured when that
  // happens.
  const [fontsVersion, setFontsVersion] = useState(0);
  useEffect(() => {
    const fonts = window.document.fonts;
    if (!fonts) return undefined;
    const bump = () => setFontsVersion((v) => v + 1);
    fonts.addEventListener('loadingdone', bump);
    fonts.ready.then(bump).catch(() => {});
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);

  // Measure per-line visual heights for gutter line numbers
  /* eslint-disable react-hooks/refs -- deliberate render-time DOM measurement:
     the gutter layout must read the live textarea geometry (clientWidth,
     computed styles) to compute wrap-aware line heights; every read has a
     non-DOM fallback for the first render. */
  const lineLayoutData = useMemo(() => {
    // For cloud docs read the live CRDT (see yjsContentVersion above); before Yjs is
    // ready - or while the server copy is unavailable (ytext is an empty degraded
    // placeholder) - fall back to the content prop, which is what the textarea shows.
    const currentContent = yjsEnabled && yjs.ytext && yjs.isReady && !serverCopyUnavailable ? yjs.ytext.toString() : content;
    const lines = currentContent.split('\n');

    // Not calibrated yet (first paint) or the textarea is hidden / zero-width:
    // keep a flat layout for stability and let the gutter hide its numbers
    // (calibrated: false) rather than show one-row-per-line numbers that are
    // wrong for every wrapped line.
    const textarea = textareaRef.current;
    if (!textarea || textareaContentWidth <= 0 || textarea.clientWidth <= 0) {
      return flatLineLayout(lines.length);
    }

    const cs = window.getComputedStyle(textarea);
    // Everything that can change where lines wrap invalidates the cache
    const cacheKey = [
      textarea.clientWidth, cs.padding, cs.font, cs.letterSpacing, cs.wordSpacing,
      cs.tabSize, cs.wordBreak, cs.textTransform, fontsVersion
    ].join('|');

    if (rowPitchRef.current.key !== cacheKey) {
      rowPitchRef.current = { key: cacheKey, value: measureTextareaRowPitch(textarea, cs) };
    }

    return computeLineLayout(
      lines,
      lineHeightCacheRef.current,
      cacheKey,
      (missing) => measureLinesWithMirror(missing, textarea, cs),
      rowPitchRef.current.value
    );
    // yjsContentVersion is a deliberate cache-buster for Yjs CRDT changes (ytext is mutable);
    // textareaElement re-runs the measurement for a newly mounted textarea (see its declaration)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, yjs?.ytext, yjs?.isReady, yjsEnabled, serverCopyUnavailable, textareaElement, textareaContentWidth, yjsContentVersion, fontsVersion]);
  /* eslint-enable react-hooks/refs */

  // Memoize gutter line number elements so they don't rebuild on scroll
  const gutterElements = useMemo(() => {
    const { lineCount, heights, rowHeight } = lineLayoutData;
    const rowLineHeight = `${rowHeight}px`;
    const elements = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) {
      elements[i] = (
        <div
          key={i}
          className="text-os-text-muted font-mono text-xs flex items-start justify-center"
          style={{ height: heights[i], lineHeight: rowLineHeight }}
        >
          {i + 1}
        </div>
      );
    }
    return elements;
  }, [lineLayoutData]);

  // Wrap-aware visual position (in textarea content space, before the
  // padding/scroll adjustments) for a character index. Reuses lineLayoutData's
  // cumulative per-line heights - the SAME system the gutter uses - so a
  // logical line that soft-wraps across multiple visual rows pushes everything
  // below it down here too. The naive (lineNumber - 1) * lineHeight math this
  // replaces ignored wrapping entirely, which made remote-cursor overlays
  // drift ever further from the real text the deeper into a wrapped document
  // the cursor sat, until viewport culling silently dropped them ("the other
  // user's cursor doesn't show at all" in large documents).
  const getWrapAwarePosition = (charIndex, contentStr) => {
    const baseLineHeight = lineLayoutData.rowHeight || 22.4; // textarea's calibrated px per row
    const charWidth = charWidthRef.current || 8.4;
    const beforeLines = contentStr.substring(0, charIndex).split('\n');
    const lineIndex = beforeLines.length - 1;
    const column = beforeLines[lineIndex].length;

    const { cumulative, heights, lineCount } = lineLayoutData;
    let lineTop;
    let rowsInLine;
    if (lineIndex < lineCount) {
      lineTop = lineIndex === 0 ? 0 : cumulative[lineIndex - 1];
      rowsInLine = Math.max(1, Math.round(heights[lineIndex] / baseLineHeight));
    } else {
      // Layout data momentarily behind the live content - extrapolate flat
      // rows past the last measured line rather than rendering nothing.
      lineTop = (lineCount > 0 ? cumulative[lineCount - 1] : 0) + (lineIndex - lineCount) * baseLineHeight;
      rowsInLine = 1;
    }

    // Estimate which wrapped visual row of this logical line the column falls
    // on (character-count estimate; the row COUNT itself comes from the
    // measured lineLayoutData), clamped to the rows the line actually has.
    const charsPerRow = textareaContentWidth > 0
      ? Math.max(1, Math.floor(textareaContentWidth / charWidth))
      : 0;
    const row = charsPerRow > 0 ? Math.min(Math.floor(column / charsPerRow), rowsInLine - 1) : 0;
    const columnInRow = column - row * charsPerRow;

    return {
      top: lineTop + row * baseLineHeight,
      left: columnInRow * charWidth,
      lineHeight: baseLineHeight
    };
  };

  // Track scroll position for cursor rendering and search highlights
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    let rafId = null;
    let fallbackTimerId = null;
    let lastUpdateTime = 0;
    // Adjust update interval based on performance mode and search state
    const UPDATE_INTERVAL = performanceMode ? 100 : (showSearchReplace ? 50 : 16);
    // Performance mode: 10fps, Search mode: 20fps, Normal: 60fps

    const syncScrollPosition = () => {
      if (textarea) {
        setScrollPosition({
          top: textarea.scrollTop,
          left: textarea.scrollLeft
        });
        lastUpdateTime = performance.now();
      }
    };

    const syncGutter = () => {
      if (gutterRef.current) {
        gutterRef.current.scrollTop = textarea.scrollTop;
      }
    };

    const handleScroll = () => {
      // Sync gutter immediately — direct DOM, no React render needed
      syncGutter();

      // Cancel any pending update
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (fallbackTimerId) {
        clearTimeout(fallbackTimerId);
        fallbackTimerId = null;
      }

      // Schedule update for next animation frame
      rafId = requestAnimationFrame((timestamp) => {
        if (textarea && timestamp - lastUpdateTime >= UPDATE_INTERVAL) {
          syncScrollPosition();
        } else {
          // Throttled — schedule a fallback so we don't drop the final position
          fallbackTimerId = setTimeout(syncScrollPosition, UPDATE_INTERVAL);
        }
      });
    };

    // Set initial scroll position
    syncScrollPosition();
    syncGutter();

    textarea.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      textarea.removeEventListener('scroll', handleScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (fallbackTimerId) {
        clearTimeout(fallbackTimerId);
      }
    };
  }, [documentId, showSearchReplace, performanceMode, isPreviewActive]);

  // Listen for toggle preview mode event (from context menu)
  useEffect(() => {
    function handleTogglePreviewMode(event) {
      if (event.detail.documentId === documentId) {
        const newPreviewMode = event.detail.enable !== undefined ? event.detail.enable : !previewMode;
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
  }, [documentId, previewMode]);

  // Auto-focus content on mount
  const caretToEndAfterFocusRef = useRef(false);
  useEffect(() => {
    if (textareaRef.current && !locked && !isPreviewActive) {
      textareaRef.current.focus({ preventScroll: true });
      if (caretToEndAfterFocusRef.current) {
        // Deferred half of the open-from-elsewhere request below: the
        // textarea only exists now that preview mode is off.
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
      // The textarea mounts on the next render; the auto-focus effect above
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
      // Leave preview mode first; this effect re-runs once the textarea is
      // mounted (isPreviewActive flips) and applies the jump then.
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
    // The document-switch effect above has just synced the textarea's value;
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

  // Sync textarea when cloud document goes offline (yjs.ytext becomes null)
  // OR when content changes while offline (e.g., loading from IndexedDB on mount)
  useEffect(() => {
    console.log('[DocumentEditor] Offline sync check - yjsEnabled:', yjsEnabled, 'yjs.ytext:', !!yjs.ytext, 'content.length:', content?.length || 0, 'hasTextarea:', !!textareaRef.current);
    if (yjsEnabled && !yjs.ytext && textareaRef.current) {
      // Cloud document is offline - sync content from IndexedDB to textarea
      // This handles: going offline, staying offline, and initial mount when offline
      const currentContent = content || '';
      const currentTextareaValue = textareaRef.current.value || '';
      console.log('[DocumentEditor] Cloud doc offline - syncing content. Current textarea:', currentTextareaValue.length, 'chars, new content:', currentContent.length, 'chars');
      if (textareaRef.current.value !== currentContent) {
        console.log('[DocumentEditor] ✓ Syncing offline cloud document content to textarea:', currentContent.length, 'chars');
        textareaRef.current.value = currentContent;
      } else {
        console.log('[DocumentEditor] Content already synced, skipping');
      }
    }
  }, [yjsEnabled, yjs.ytext, content]);

  // Sync textarea value when switching from preview to edit mode for cloud documents
  useEffect(() => {
    if (!isPreviewActive && yjsEnabled && textareaRef.current) {
      // When switching to edit mode, sync textarea with current content
      // Cloud documents use uncontrolled textarea, so we manually sync the value
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
      selectedButton.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [slashMenu.selectedIndex, slashMenu.visible]);

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
        setSelectionMenu({ visible: false, x: 0, y: 0, text: '' });
      }
    }

    if (selectionMenu.visible) {
      window.document.addEventListener('mousedown', handleClickOutside);
      return () => window.document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [selectionMenu.visible]);

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

    // Update content based on document type
    if (yjsEnabled && yjs.updateContent) {
      // For Yjs documents, use Yjs update
      yjs.updateContent(newText, newPos);
    } else {
      // For local documents, update React state
      if (onContentChange) {
        onContentChange({ target: { value: newText } });
      }
    }

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

    if (yjsEnabled && yjs.updateContent) {
      yjs.updateContent(newText, newEnd);
    } else if (onContentChange) {
      onContentChange({ target: { value: newText } });
    }
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
    if (yjsEnabled && yjs.updateContent) {
      yjs.updateContent(newText, selectEnd);
    } else if (onContentChange) {
      onContentChange({ target: { value: newText } });
    }
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
    if (yjsEnabled && yjs.updateContent) {
      yjs.updateContent(newText, bodyEnd);
    } else if (onContentChange) {
      onContentChange({ target: { value: newText } });
    }
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
    const selectedText = content.substring(start, end);

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
      setPreviewAllDocuments(false);
      setPreviewMode(false);
      savePreviewModeForDocument(false);
    } else if (previewMode) {
      if (Date.now() - previewEnteredAtRef.current < 1000) {
        // PREVIEW -> PREVIEW-ALL: quick second click turns on the global override
        setPreviewAllDocuments(true);
      } else {
        // PREVIEW -> OFF: too late for the escalation, act as a plain toggle
        setPreviewMode(false);
        savePreviewModeForDocument(false);
      }
    } else {
      // OFF -> PREVIEW: per-document preview, persisted per document
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
  const handleContentInput = (e) => {
    if (locked || isPreviewActive) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = e.target.value.substring(0, cursorPos);
    const query = slashQueryAt(textBeforeCursor);
    const matching = query != null && templates.some((t) => matchesSlashQuery(t, query));

    if (!matching) {
      // no command here (a path, a space, code, no match): the popup goes
      if (slashMenu.visible) {
        setSlashMenu(prev => ({ ...prev, visible: false }));
      }
      return;
    }

    // Calculate popup position near cursor
    const rect = textarea.getBoundingClientRect();
    const textareaStyle = window.getComputedStyle(textarea);
    const fontSize = parseFloat(textareaStyle.fontSize);
    const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.6;

    const lines = textBeforeCursor.split('\n');
    const currentLineNum = lines.length - 1;

    let x = rect.left + 20;
    let y = rect.top + (currentLineNum * lineHeight) + lineHeight + 10;

    // Adjust position to keep popup within window bounds
    const popupWidth = 400;
    const popupHeight = 300;
    const adjustedX = Math.min(x, window.innerWidth - popupWidth - 20);
    const adjustedY = Math.min(y, window.innerHeight - popupHeight - 20);

    setSlashMenu({
      visible: true,
      position: {
        x: Math.max(20, adjustedX),
        y: Math.max(20, adjustedY),
      },
      query,
      slashPosition: textBeforeCursor.lastIndexOf('/'),
      selectedIndex: 0,
    });
  };

  // Handle keyboard navigation in slash menu
  const handleKeyDown = (e) => {
    // Don't interfere if search panel is open (unless it's a shortcut)
    if (showSearchReplace && !(e.ctrlKey || e.metaKey)) {
      return;
    }

    // Tab / Shift+Tab inside a list indent / outdent the lines (outside a
    // list Tab keeps moving the focus, as a textarea does)
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !slashMenu.visible && textareaRef.current) {
      const textarea = textareaRef.current;
      const [lineStart, lineEnd] = lineBounds(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      const lines = textarea.value.substring(lineStart, lineEnd).split('\n');
      if (lines.every((line) => describeLine(line).list)) {
        e.preventDefault();
        indentText(!e.shiftKey);
        return;
      }
    }

    // Global shortcuts for Search/Replace (Ctrl/Cmd+F, +R) and formatting (Ctrl/Cmd+B, +I, +K link).
    // Ctrl/Cmd+Shift+F is the Documents page's "Find in Files" - leave it alone.
    if (e.ctrlKey || e.metaKey) {
      if ((e.key === 'k' || e.key === 'K') && !e.altKey) {
        e.preventDefault();
        insertLink();
        return;
      }
      if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        e.preventDefault();

        // Cleanup old measure div for fresh measurements
        if (measureDivRef.current) {
          window.document.body.removeChild(measureDivRef.current);
          measureDivRef.current = null;
        }

        setShowSearchReplace(true);
        setShowReplace(false);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();

        // Only open replace mode if document is editable
        const isEditable = !locked && isOwner && !(document?.inCloud && !isOnline) && !serverCopyUnavailable;

        // Cleanup old measure div for fresh measurements
        if (measureDivRef.current) {
          window.document.body.removeChild(measureDivRef.current);
          measureDivRef.current = null;
        }

        setShowSearchReplace(true);
        setShowReplace(isEditable); // Only show replace if editable
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        insertMarkdown('**', '**', 'bold');
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        insertMarkdown('*', '*', 'italic');
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
        // has reached the textarea, which the helpers read)
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

      // Update content based on document type
      if (yjsEnabled && yjs.updateContent) {
        // For Yjs documents, use Yjs update
        yjs.updateContent(newContent, newCursorPos);
      } else {
        // For local documents, update React state
        if (onContentChange) {
          onContentChange({ target: { value: newContent } });
        }
      }

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
    const rect = textarea.getBoundingClientRect();
    const textareaStyle = window.getComputedStyle(textarea);
    const fontSize = parseFloat(textareaStyle.fontSize);
    const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.6;

    const textBeforeCursor = content.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const currentLineNum = lines.length - 1;

    let x = rect.left + 20;
    let y = rect.top + (currentLineNum * lineHeight) + lineHeight + 10;

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

    // Call backend with concise prompt
    const systemPrompt = 'You are a code assistant. Respond ONLY with the requested code, command, or text. Do NOT include explanations, markdown formatting, or comments unless specifically requested. Be extremely concise.';

    const backendUrl = await getBackendUrl();

    apiFetch(`${backendUrl}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: quickAIInput,
        systemPrompt: systemPrompt,
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      }),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    })
      .then(res => res.json())
      .then(data => {
        if (data.response) {
          setQuickAIResponse(data.response);
        } else if (data.error) {
          setQuickAIResponse('Error: ' + data.error);
        }
      })
      .catch(err => {
        setQuickAIResponse('Error: ' + err.message);
      })
      .finally(() => {
        setQuickAILoading(false);
      });
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

    // Check if /ai is still at the cursor position and remove it
    let insertPos = quickAICursorPos;
    let baseContent = currentContent;

    const textBeforeCursor = currentContent.substring(0, quickAICursorPos);
    if (textBeforeCursor.endsWith('/ai')) {
      // Remove /ai
      baseContent = currentContent.substring(0, quickAICursorPos - 3) + currentContent.substring(quickAICursorPos);
      insertPos = quickAICursorPos - 3;
    }

    // Insert response at cursor position
    const newContent = baseContent.substring(0, insertPos) + textToInsert + baseContent.substring(insertPos);
    const newPos = insertPos + textToInsert.length;

    // Update content based on document type
    if (yjsEnabled && yjs.updateContent) {
      // For Yjs documents, use Yjs update
      yjs.updateContent(newContent, newPos);
    } else {
      // For local documents, update React state
      if (onContentChange) {
        onContentChange({ target: { value: newContent } });
      }
    }

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
    const rect = textarea.getBoundingClientRect();
    const textareaStyle = window.getComputedStyle(textarea);
    const fontSize = parseFloat(textareaStyle.fontSize);
    const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.6;

    const textBeforeCursor = content.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const currentLineNum = lines.length - 1;

    let x = rect.left + 20;
    let y = rect.top + (currentLineNum * lineHeight) + lineHeight + 10;

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

    // Update content based on document type
    if (yjsEnabled && yjs.updateContent) {
      // For Yjs documents, use Yjs update
      yjs.updateContent(newContent, newPos);
    } else {
      // For local documents, update React state
      if (onContentChange) {
        onContentChange({ target: { value: newContent } });
      }
    }

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
    const rect = textarea.getBoundingClientRect();
    const textareaStyle = window.getComputedStyle(textarea);
    const fontSize = parseFloat(textareaStyle.fontSize);
    const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.6;

    const textBeforeCursor = content.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const currentLineNum = lines.length - 1;

    let x = rect.left + 20;
    let y = rect.top + (currentLineNum * lineHeight) + lineHeight + 10;

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

      // Update content based on document type
      if (yjsEnabled && yjs.updateContent) {
        // For Yjs documents, use Yjs update
        yjs.updateContent(newContent, newPos);
      } else {
        // For local documents, update React state
        if (onContentChange) {
          onContentChange({ target: { value: newContent } });
        }
      }
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

    // Focus the textarea to simulate user interaction
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
        // For Yjs documents, read current cursor position from textarea
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

        // Update cursor awareness every 3 characters (not every character)
        // This reduces race conditions between text and cursor updates
        // and makes the cursor movement smoother on other clients' screens
        if (charIndex % 3 === 0 || charIndex === loremIpsumText.length - 1) {
          setTimeout(() => {
            if (textarea && yjs.updateCursor) {
              // Re-read cursor position in case other users edited meanwhile
              const finalPos = textarea.selectionStart;
              yjs.updateCursor(finalPos, finalPos);
            }
          }, 30); // Small delay to let text update propagate
        }
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

  // Get or create the measurement div
  const getMeasureDiv = () => {
    if (!textareaRef.current) {
      return null;
    }

    const textarea = textareaRef.current;
    const computedStyle = window.getComputedStyle(textarea);
    // Use clientWidth (excludes border and scrollbar) so the div's text wrapping
    // area exactly matches the textarea's, regardless of scrollbar width differences
    const contentWidth = textarea.clientWidth;

    if (measureDivRef.current) {
      measureDivRef.current.style.width = `${contentWidth}px`;
      return measureDivRef.current;
    }

    const div = window.document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '-9999px';
    div.style.left = '-9999px';
    div.style.visibility = 'hidden';
    div.style.pointerEvents = 'none';
    div.style.overflowX = 'hidden';
    div.style.overflowY = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.overflowWrap = 'break-word';
    div.style.boxSizing = 'border-box';
    div.style.width = `${contentWidth}px`;
    div.style.padding = computedStyle.padding;
    div.style.border = 'none';
    div.style.font = computedStyle.font;
    // CRITICAL: copy the textarea's SPECIFIED line-height (unitless "1.6" from its
    // inline style), not the computed pixel string ("22.4px"). Chromium rounds the
    // two forms to different 1/64px layout units (22.390625 vs 22.40625 per row),
    // which makes the div drift ~1 full line taller per ~1400 rows and misplaces
    // every highlight below the drift. With the specified value copied verbatim,
    // both elements produce identical row heights and wrapping (verified against
    // live Chromium), so measured positions need no correction factor.
    div.style.lineHeight = textarea.style.lineHeight || computedStyle.lineHeight;
    div.style.letterSpacing = computedStyle.letterSpacing;
    div.style.wordSpacing = computedStyle.wordSpacing;
    div.style.textIndent = computedStyle.textIndent;
    div.style.textTransform = computedStyle.textTransform;
    div.style.wordBreak = computedStyle.wordBreak;
    div.style.tabSize = computedStyle.tabSize;
    div.style.textRendering = computedStyle.textRendering;
    // Glyph-width-affecting properties: any mismatch here changes where lines
    // soft-wrap, which would shift every measurement below the divergent line.
    div.style.fontKerning = computedStyle.fontKerning;
    div.style.fontFeatureSettings = computedStyle.fontFeatureSettings;
    div.style.fontVariantLigatures = computedStyle.fontVariantLigatures;
    div.style.direction = computedStyle.direction;
    div.style.unicodeBidi = computedStyle.unicodeBidi;
    div.style.zIndex = '-1';

    window.document.body.appendChild(div);
    measureDivRef.current = div;

    return div;
  };

  // Live document content for the search/replace/highlight subsystem. For Yjs
  // documents the textarea is uncontrolled and kept in sync with the CRDT via
  // direct DOM updates, so yjs.content (React state) is frozen at load time and
  // must NOT be used here: searching or measuring against it misplaces every
  // match once the document has been edited. The textarea's value is the
  // authoritative source for what is actually rendered (same pattern as the
  // collaborative cursor overlay); ytext is the fallback before the ref mounts.
  const getSearchContent = () => {
    if (!yjsEnabled) return content;
    if (textareaRef.current) return textareaRef.current.value;
    if (yjs.ytext && yjs.isReady && !serverCopyUnavailable) return yjs.ytext.toString();
    return yjs.content !== undefined ? yjs.content : content;
  };

  // Measure the position of a character index accounting for line wrapping
  const measureTextPosition = (charIndex) => {
    // Check cache first
    const cacheKey = `${charIndex}`;
    if (matchPositionCache.current.has(cacheKey)) {
      return matchPositionCache.current.get(cacheKey);
    }

    const measureDiv = getMeasureDiv();
    if (!measureDiv || !textareaRef.current) {
      return { top: 0, left: 0, lineHeight: 22.4 };
    }

    const textBefore = getSearchContent().substring(0, charIndex);

    // Use a span with a zero-width space for reliable getBoundingClientRect
    const span = window.document.createElement('span');
    span.textContent = '​';
    measureDiv.textContent = textBefore;
    measureDiv.appendChild(span);

    const rect = span.getBoundingClientRect();
    const divRect = measureDiv.getBoundingClientRect();
    const lineHeight = parseFloat(window.getComputedStyle(measureDiv).lineHeight) || 22.4;

    const top = rect.top - divRect.top;
    const left = rect.left - divRect.left;

    measureDiv.removeChild(span);

    const position = { top, left, lineHeight };

    // Cache the result
    matchPositionCache.current.set(cacheKey, position);

    return position;
  };

  // Search and Replace handlers
  const scrollToMatch = (match) => {
    if (!textareaRef.current || !match) return;

    const textarea = textareaRef.current;

    // Use measureTextPosition to get the actual visual position (accounts for line wrapping)
    const pos = measureTextPosition(match.start);
    const matchTop = pos.top;
    const lineHeight = pos.lineHeight;
    const textareaHeight = textarea.clientHeight;

    // Center the match vertically in the viewport
    const scrollTop = matchTop - (textareaHeight / 2) + (lineHeight / 2);
    textarea.scrollTop = Math.max(0, scrollTop);

    // Sync gutter immediately
    if (gutterRef.current) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }

    // Force an immediate scroll position sync so highlights align right away
    setScrollPosition({
      top: textarea.scrollTop,
      left: textarea.scrollLeft
    });
  };
  // Keep the jump-to-line effect's ref pointed at the latest scrollToMatch
  useEffect(() => {
    scrollToMatchRef.current = scrollToMatch;
  });

  // Debounce timer for search
  const searchDebounceTimer = useRef(null);
  const searchInputFocusedRef = useRef(false);

  const lastMatchSignatureRef = useRef('');

  const performSearch = (query, content, skipScrollToMatch = false) => {
    if (!query || query.length < 2) {
      setSearchMatches([]);
      setCurrentMatchIndex(-1);
      matchPositionCache.current.clear();
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

    // Clear position cache when search results change
    matchPositionCache.current.clear();

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

    // Update content based on document type
    if (yjsEnabled && yjs.updateContent && textareaRef.current) {
      // For Yjs documents, use Yjs update
      yjs.updateContent(newContent, match.start + replaceText.length);
    } else {
      // For local documents, update React state
      if (onContentChange) {
        onContentChange({ target: { value: newContent } });
      }
    }

    // Clear position cache since content changed
    matchPositionCache.current.clear();

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

    // Update content based on document type
    if (yjsEnabled && yjs.updateContent && textareaRef.current) {
      // For Yjs documents, use Yjs update
      const cursorPos = textareaRef.current.selectionStart;
      yjs.updateContent(newContent, cursorPos);
    } else {
      // For local documents, update React state
      if (onContentChange) {
        onContentChange({ target: { value: newContent } });
      }
    }

    // Clear position cache since content changed
    matchPositionCache.current.clear();

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

    // Clear position cache
    matchPositionCache.current.clear();
    lastMatchSignatureRef.current = '';

    // Cleanup measure div
    if (measureDivRef.current) {
      window.document.body.removeChild(measureDivRef.current);
      measureDivRef.current = null;
    }

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

  // Invalidate position cache on textarea resize (window resize, sidebar toggle, etc.)
  useEffect(() => {
    const textarea = textareaRef.current;
    // Record the (re)mounted element so the gutter re-measures it even when
    // the ResizeObserver's width update below is identical to the last one
    // (React skips identical state updates, so it alone could not re-render).
    setTextareaElement(textarea || null);
    if (!textarea) return;

    const observer = new ResizeObserver(() => {
      matchPositionCache.current.clear();
      if (measureDivRef.current) {
        window.document.body.removeChild(measureDivRef.current);
        measureDivRef.current = null;
      }
      const cs = window.getComputedStyle(textarea);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      setTextareaContentWidth(textarea.clientWidth - padLeft - padRight);
    });
    observer.observe(textarea);

    return () => observer.disconnect();
    // The textarea is a different element after preview mode toggles, so the
    // observer must re-attach to the current one
  }, [isPreviewActive, documentId]);

  // macOS "Add period with double-space" turns `a␣␣` into `a.␣` in every
  // Chromium text field, which destroys Markdown hard line breaks (two
  // trailing spaces). Cancel that one OS substitution on the editor textarea
  // and keep the two spaces - see utils/macPeriodSubstitution.js. Keyed on
  // the mounted element so it re-attaches after preview/document switches.
  useEffect(() => {
    if (!textareaElement) return undefined;
    return attachMacPeriodSubstitutionGuard(textareaElement);
  }, [textareaElement]);

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

  // Cleanup measure div and debounce timer on component unmount
  useEffect(() => {
    return () => {
      if (measureDivRef.current) {
        window.document.body.removeChild(measureDivRef.current);
        measureDivRef.current = null;
      }
      if (searchDebounceTimer.current) {
        clearTimeout(searchDebounceTimer.current);
      }
    };
  }, []);

  // Update scroll position when search is opened to ensure highlights render correctly
  useEffect(() => {
    if (showSearchReplace && textareaRef.current) {
      setScrollPosition({
        top: textareaRef.current.scrollTop,
        left: textareaRef.current.scrollLeft
      });
    }
  }, [showSearchReplace]);

  // Text selection context menu handler
  const handleTextSelectionContextMenu = (e) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);

    if (selectedText && selectedText.trim()) {
      e.preventDefault();
      setSelectionMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        text: selectedText
      });
    }
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

  // Add selection as AI Context
  const handleAddSelectionAsContext = () => {
    if (!selectionMenu.text) return;

    const sanitized = detectSensitiveData(selectionMenu.text);

    // Open AI Chat sidebar first
    window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
      detail: { isOpen: true }
    }));

    // Add context after a short delay to ensure sidebar is mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('addAIContext', {
        detail: {
          contextType: 'Text Selection',
          contextData: { selectedText: sanitized }
        }
      }));
    }, 100);

    setSelectionMenu({ visible: false, x: 0, y: 0, text: '' });
  };

  // Handle search in engine template
  const handleSearchInEngine = (template) => {
    if (!selectionMenu.text) return;

    const sanitized = detectSensitiveData(selectionMenu.text);
    if (onSearchInEngine) {
      onSearchInEngine(template, sanitized);
    }
    setSelectionMenu({ visible: false, x: 0, y: 0, text: '' });
  };

  // For preview, use live content from Yjs (ytext.toString()) for cloud docs, content prop for local docs.
  // NOTE: yjs.ytext.toString() (not yjs.content) is required for live correctness — useYjsText never
  // updates React state after init. Recomputation on CRDT changes (local or remote) is driven by the
  // always-on yjsContentVersion observer declared above lineLayoutData, which also serves the gutter.
  // Memoized and skipped entirely while the preview pane is hidden, so typing doesn't pay for
  // an O(doc) toString + full markdown parse on every keystroke.
  const previewHtml = useMemo(() => {
    if (!isPreviewActive) return '';
    let previewContent;
    if (yjsEnabled && yjs.ytext) {
      // If yjs has content, use it; otherwise fall back to content prop
      previewContent = yjs.ytext.toString() || content;
    } else {
      previewContent = content;
    }
    return previewContent ? processInteractiveMarkdown(previewContent) : '<p class="text-os-text-muted">No content to preview</p>';
    // yjsContentVersion is a deliberate cache-buster for Yjs CRDT changes (ytext is mutable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreviewActive, yjsEnabled, yjs.ytext, content, yjsContentVersion]);

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

  // ---- the toolbar's derived bits (see the Toolbar markup) ----
  const canEdit = !locked && isOwner;
  const { attach: attachToolbar, onKeyDown: onToolbarKeyDown, onFocus: onToolbarFocus } = useRovingToolbar([canEdit, isMobile]);
  const headingLabel = caretBlock.heading ? `H${caretBlock.heading}` : '\u00b6';
  // Shortcut labels for this platform (⌘B / ⌘I / ⌘K / ⇧⇥ on a Mac, Ctrl+B /
  // Ctrl+I / Ctrl+K / Shift+Tab elsewhere - src/utils/shortcuts.js). The
  // desktop app's own menu takes Cmd/Ctrl+B for "Toggle Sidebar" before
  // the page sees it, so Bold shows no shortcut there rather than one that
  // does not work.
  const inDesktopApp = typeof window !== 'undefined' && !!window.electronAPI;
  const shortcuts = {
    bold: inDesktopApp ? '' : ` (${formatShortcut('Mod+B')})`,
    italic: ` (${formatShortcut('Mod+I')})`,
    link: ` (${formatShortcut('Mod+K')})`,
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
  // array method on a list of helpers that read the textarea ref reads, to
  // the React Compiler, a ref during render)
  const tableItem = { id: 'table', Icon: Table, label: 'Table', onSelect: insertTable };
  const imageItem = { id: 'image', Icon: ImageIcon, label: 'Image', onSelect: () => setShowMediaLibrary(true) };
  const tocItem = { id: 'toc', Icon: TableOfContents, label: 'Table of contents', onSelect: insertTableOfContents };
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
    tableItem, imageItem, tocItem,
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
 ?'bg-red-600 text-white hover:bg-red-700'
 :'bg-green-600 text-white hover:bg-green-700'
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
 ?'bg-os-blue text-white'
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
        {isPreviewActive ? (
          <div
            ref={previewRef}
            onClick={handlePreviewClick}
            onContextMenu={handlePreviewContextMenu}
            className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card"
            dangerouslySetInnerHTML={previewInnerHtml}
          />
        ) : (
          <div className="h-full overflow-hidden flex">
            {/* Line Numbers Gutter */}
            <div
              ref={gutterRef}
              className="shrink-0 overflow-hidden select-none bg-os-card-secondary border-r border-os-border"
              style={{ width: 48 }}
            >
              <div style={{ paddingTop: 16, paddingBottom: 16, visibility: lineLayoutData.calibrated ? 'visible' : 'hidden' }}>
                {gutterElements}
              </div>
            </div>

            <div className="relative flex-1 h-full overflow-hidden">
            {/* Auto-typing indicator */}
            {isAutoTyping && (
              <div className="absolute top-2 right-2 z-10 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-sm shadow-lg flex items-center gap-2">
                <Type size={14} className="animate-pulse" />
                Auto-typing...
              </div>
            )}
            <textarea
              ref={textareaRef}
              {...(yjsEnabled
                ? { defaultValue: content } // For Yjs docs, use defaultValue (uncontrolled) - content is managed via ref
                : { value: content } // For local docs, use value (controlled)
              )}
              onChange={handleContentChange}
              onContextMenu={handleTextSelectionContextMenu}
              onMouseUp={handleCursorMove}
              onClick={(e) => {
                // Prevent clicking elsewhere during auto-typing
                if (isAutoTyping) {
                  e.preventDefault();
                  return;
                }
                handleCursorMove();
              }}
              onKeyDown={(e) => {
                // Prevent typing during auto-typing
                if (isAutoTyping) {
                  e.preventDefault();
                  return;
                }
                handleKeyDown(e);
              }}
              onKeyUp={handleCursorMove}
              readOnly={locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable || isAutoTyping}
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
            className={`sc-editor-textarea w-full h-full px-6 py-4 font-mono resize-none outline-hidden border-0 text-sm bg-os-card text-os-text-primary ${
 locked || !isOwner || isAutoTyping ?'cursor-default':''
 }`}
            style={{
              lineHeight: '1.6',
              willChange: performanceMode ? 'scroll-position' : 'auto',
              transform: performanceMode ? 'translateZ(0)' : 'none',
            }}
          />

          {/* eslint-disable react-hooks/refs -- deliberate render-time viewport
              culling: search-match and collaborative-cursor overlays read the
              live textarea geometry/value so culling can never disagree with
              what is painted; each read falls back gracefully when null. */}
          {/* Search Match Highlights */}
          {showSearchReplace && searchMatches.length > 0 && textareaRef.current && (
            <div
              className="absolute top-0 left-0 pointer-events-none w-full h-full overflow-hidden"
              style={{
                pointerEvents: 'none',
                userSelect: 'none',
                touchAction: 'none'
              }}
            >
              {searchMatches.filter((match, idx) => {
                // Always render the current match
                if (idx === currentMatchIndex) return true;

                const textarea = textareaRef.current;
                if (!textarea) return true;

                // Use measureTextPosition for accurate position (accounts for line wrapping)
                const pos = measureTextPosition(match.start);
                const matchTop = pos.top;
                const viewportTop = scrollPosition.top;
                const viewportBottom = scrollPosition.top + textarea.clientHeight;

                // Buffer of 5 lines above and below viewport for smooth scrolling
                const buffer = pos.lineHeight * 5;
                return matchTop >= (viewportTop - buffer) && matchTop <= (viewportBottom + buffer);
              }).map((match) => {
                const idx = searchMatches.indexOf(match);
                const currentContent = getSearchContent();

                // Measure actual position accounting for line wrapping
                const startPos = measureTextPosition(match.start);
                const endPos = measureTextPosition(match.end);

                const top = startPos.top - scrollPosition.top;
                const left = startPos.left - scrollPosition.left;
                const width = endPos.left - startPos.left;
                const height = startPos.lineHeight;

                const isCurrentMatch = idx === currentMatchIndex;

                // Only render if on the same visual line (multi-line matches are complex)
                const onSameLine = Math.abs(endPos.top - startPos.top) < 2;

                if (!onSameLine) {
                  // For matches that span multiple lines, just highlight the first line
                  const matchText = currentContent.substring(match.start, match.end);
                  const firstLineEnd = matchText.indexOf('\n');
                  const firstLineLength = firstLineEnd === -1 ? matchText.length : firstLineEnd;
                  const firstLineEndPos = measureTextPosition(match.start + firstLineLength);
                  const firstLineWidth = firstLineEndPos.left - startPos.left;

                  return (
                    <div
                      key={`search-match-${idx}`}
                      className="absolute"
                      style={{
                        top: `${top}px`,
                        left: `${left}px`,
                        width: `${firstLineWidth}px`,
                        height: `${height}px`,
                        backgroundColor: isCurrentMatch ? 'rgba(255, 165, 0, 0.4)' : 'rgba(255, 255, 0, 0.3)',
                        border: isCurrentMatch ? '1px solid rgba(255, 165, 0, 0.8)' : 'none',
                        pointerEvents: 'none',
                        zIndex: 1
                      }}
                    />
                  );
                }

                return (
                  <div
                    key={`search-match-${idx}`}
                    className="absolute"
                    style={{
                      top: `${top}px`,
                      left: `${left}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                      backgroundColor: isCurrentMatch ? 'rgba(255, 165, 0, 0.4)' : 'rgba(255, 255, 0, 0.3)',
                      border: isCurrentMatch ? '1px solid rgba(255, 165, 0, 0.8)' : 'none',
                      pointerEvents: 'none',
                      zIndex: 1
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* Collaborative Cursors and Selections (via Yjs) */}
          {yjsEnabled && yjs.cursors && Object.keys(yjs.cursors).length > 0 && (
            <div className="absolute top-0 left-0 pointer-events-none w-full h-full overflow-hidden">
              {Object.entries(yjs.cursors).filter(([userId, cursorData]) => {
                if (!cursorData || cursorData.position === undefined) {
                  return false;
                }

                // Viewport culling for performance
                const textarea = textareaRef.current;
                if (!textarea) return true;

                const position = cursorData.position || 0;
                // CRITICAL: Use textarea.value (actual DOM) instead of yjs.content (stale React state)
                // For collaborative docs, we update DOM directly without React re-renders
                const currentContent = textarea.value || '';

                // Defensive check: Don't render cursor if position is beyond content length
                // This prevents cursor jumping when cursor updates arrive before text updates
                if (position > currentContent.length) {
                  console.log(`[DocumentEditor] Skipping cursor render for ${userId} - position ${position} beyond content length ${currentContent.length}`);
                  return false;
                }

                // Wrap-aware top (same math as the render below) so culling
                // and rendering can never disagree about where a cursor is.
                const cursorTop = getWrapAwarePosition(position, currentContent).top;
                const viewportTop = scrollPosition.top;
                const viewportBottom = scrollPosition.top + textarea.clientHeight;

                // Add buffer for smooth scrolling
                const buffer = 22.4 * 10;
                return cursorTop >= (viewportTop - buffer) && cursorTop <= (viewportBottom + buffer);
              }).map(([userId, cursorData]) => {
                console.log('[DocumentEditor] Rendering Yjs cursor for user:', userId, 'data:', cursorData);

                const position = cursorData.position || 0;
                const selectionEnd = cursorData.selectionEnd || position;
                const hasSelection = selectionEnd !== position;

                // Get current content for cursor calculation
                // CRITICAL: Use textarea.value (actual DOM) instead of stale React state
                const textarea = textareaRef.current;
                const currentContent = textarea ? textarea.value : '';

                // Wrap-aware pixel position (accounting for soft line
                // wrapping via lineLayoutData, plus padding and scroll).
                // charWidth uses the measured width of the actual rendered
                // font (charWidthRef) like the gutter does, with the old 8.4
                // approximation only as a fallback.
                const vis = getWrapAwarePosition(position, currentContent);
                const lineHeight = vis.lineHeight;
                const charWidth = charWidthRef.current || 8.4;
                const top = vis.top + 16 - scrollPosition.top; // 16px padding, minus scroll
                const left = vis.left + 24 - scrollPosition.left; // 24px padding, minus scroll

                const userColor = cursorData.color || getUserColor(userId);

                return (
                  <div key={userId}>
                    {/* Selection highlight */}
                    {hasSelection && (
                      <div className="absolute inset-0">
                        {(() => {
                          const start = Math.min(position, selectionEnd);
                          const end = Math.max(position, selectionEnd);
                          const selectedText = currentContent.substring(start, end);
                          const selectionLines = selectedText.split('\n');

                          // Viewport culling for selection lines (only render visible lines)
                          const textarea = textareaRef.current;
                          const viewportTop = textarea ? scrollPosition.top : 0;
                          const viewportBottom = textarea ? scrollPosition.top + textarea.clientHeight : Infinity;

                          // Character index where the current selection line
                          // segment begins; positions come from the same
                          // wrap-aware helper the cursor itself uses.
                          let segmentStart = start;
                          return selectionLines.map((line, idx) => {
                            const segPos = getWrapAwarePosition(segmentStart, currentContent);
                            segmentStart += line.length + 1; // step past this line and its '\n'

                            // Only render if line is likely visible
                            const buffer = lineHeight * 5;
                            if (segPos.top < (viewportTop - buffer) || segPos.top > (viewportBottom + buffer)) {
                              return null;
                            }

                            const highlightTop = segPos.top + 16 - scrollPosition.top;
                            const highlightLeft = segPos.left + 24 - scrollPosition.left;
                            const highlightWidth = line.length * charWidth;

                            return (
                              <div
                                key={`${userId}-sel-${idx}`}
                                className="absolute"
                                style={{
                                  top: `${highlightTop}px`,
                                  left: `${highlightLeft}px`,
                                  width: `${highlightWidth}px`,
                                  height: `${lineHeight}px`,
                                  backgroundColor: hexToRgba(userColor, 0.25),
                                  pointerEvents: 'none'
                                }}
                              />
                            );
                          });
                        })()}
                      </div>
                    )}

                    {/* Cursor line */}
                    <div
                      className="absolute"
                      style={{
                        top: `${top}px`,
                        left: `${left}px`,
                        zIndex: 10
                      }}
                    >
                      <div
                        className="w-0.5 h-5 animate-pulse"
                        style={{
                          backgroundColor: userColor,
                        }}
                      />
                      {/* User label */}
                      <div
                        className="absolute -top-5 left-0 px-1.5 py-0.5 rounded-sm text-xs text-white whitespace-nowrap shadow-xs"
                        style={{
                          backgroundColor: userColor,
                          fontSize: '10px'
                        }}
                      >
                        {cursorData.name || userId}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* eslint-enable react-hooks/refs */}
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
                    className="p-1 hover:bg-purple-200 dark:hover:bg-purple-800/30 rounded-sm transition-colors"
                    title="Clear response"
                  >
                    <Trash2 size={14} className="text-purple-700 dark:text-purple-300" />
                  </button>
                )}
                <button
                  onClick={handleCancelQuickAI}
                  className="p-1 hover:bg-purple-200 dark:hover:bg-purple-800/30 rounded-sm transition-colors"
                  title="Close"
                >
                  <X size={14} className="text-purple-700 dark:text-purple-300" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-3 py-3 space-y-3">
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
                      value={quickAILoading ? 'Generating response...' : quickAIResponse}
                      readOnly={quickAILoading}
                      onSelect={handleQuickAIResponseSelection}
                      onMouseUp={handleQuickAIResponseSelection}
                      className="w-full h-48 px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden cursor-text text-os-text-primary"
                    />
                    {quickAILoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-os-card/75 rounded-sm">
                        <RefreshCw size={20} className="text-purple-600 animate-spin" />
                      </div>
                    )}
                  </div>
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
                  className="flex-1 px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={backendStatus === 'offline' ? 'Backend service is not running' : 'Generate (Enter)'}
                >
                  {quickAILoading ? 'Generating...' : 'Generate'}
                </button>
              ) : (
                !quickAILoading && (
                  <button
                    onClick={() => handleAcceptAIResponse(true)}
                    disabled={!quickAISelectedText}
                    className="flex-1 px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
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
            className="fixed w-96 bg-os-card border border-os-border rounded-lg shadow-2xl overflow-hidden"
            style={{
              left: `${slashMenu.position.x}px`,
              top: `${slashMenu.position.y}px`,
              maxHeight: '400px',
              zIndex: 2147483647,
            }}
          >
            <div className="px-3 py-2 bg-purple-50 dark:bg-purple-900/20">
              <div className="flex items-center gap-2">
                <BookTemplate size={14} className="text-purple-600 dark:text-purple-300" />
                <span className="text-xs font-medium text-purple-900 dark:text-purple-200">
                  Commands and templates {slashMenu.query && `- "${slashMenu.query}"`}
                </span>
              </div>
            </div>
            <div className="overflow-y-auto max-h-80">
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
        onAddAsContext={handleAddSelectionAsContext}
        onSearchIn={handleSearchInEngine}
        engineTemplates={engineTemplates}
        onClose={() => setSelectionMenu({ visible: false, x: 0, y: 0, text: '' })}
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
                  // Handle Ctrl+R to toggle replace mode
                  if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
                    e.preventDefault();
                    // Only allow toggling replace if document is editable
                    const isEditable = !locked && isOwner && !(document?.inCloud && !isOnline) && !serverCopyUnavailable;
                    if (isEditable || showReplace) {
                      // Allow turning off replace even if read-only, but not turning it on
                      setShowReplace(!showReplace && isEditable);
                    }
                    return;
                  }

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
                  // Handle Ctrl+R to toggle replace mode (can always close replace mode)
                  if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
                    e.preventDefault();
                    setShowReplace(false); // Close replace mode
                    return;
                  }

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
                className="flex-1 px-3 py-1.5 text-xs bg-os-blue hover:bg-os-blue/90 text-white rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div>Ctrl+F: Find{!(locked || !isOwner || (document?.inCloud && !isOnline) || serverCopyUnavailable) && ' • Ctrl+R: Replace'}</div>
            <div>Enter: Next • Shift+Enter: Previous</div>
          </div>
        </div>
      )}

      {/* Media Library Modal */}
      <MediaLibraryModal
        isOpen={showMediaLibrary}
        onClose={() => setShowMediaLibrary(false)}
        onSelectImage={insertImage}
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
