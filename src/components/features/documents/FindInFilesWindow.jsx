import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { FileSearch, CaseSensitive, WholeWord, Regex, X, Search, GripHorizontal } from 'lucide-react';
import FloatingWindow from '../../common/FloatingWindow';
import VerticalResizableDivider from '../../VerticalResizableDivider';
import { useLocalStorage } from '../../../hooks/useLocalStorage';
import { getDocuments } from '../../../utils/documents';
import {
  buildMatcher,
  searchDocumentsAsync,
  formatSummary,
  splitLines,
  MAX_RESULTS,
} from '../../../utils/findInFiles';

const SEARCH_DEBOUNCE_MS = 200;
/** Arrow-key repeats update the row highlight at once; the preview follows after this pause. */
const PREVIEW_DEBOUNCE_MS = 60;
/** Fixed preview row pitch (px): line N sits at (N - 1) * this, no measuring needed. */
export const PREVIEW_LINE_HEIGHT = 20;
/** localStorage key of the results/preview split (VerticalResizableDivider, % of the content area). */
export const PREVIEW_SPLIT_KEY = 'findInFilesSplit';

/**
 * FindInFilesWindow - JetBrains-style "Find in Files" over every document's
 * raw markdown (or one category when `scope.category` is set).
 *
 * One result row per matching LINE: the line text with every match
 * highlighted, and "title line" right-aligned in muted text. The preview
 * pane below (draggable split, persisted) shows the WHOLE selected document
 * with the same line numbers the editor's gutter shows, the matched line
 * highlighted and centered. "Open in New Tab" (and Enter / double-click on
 * a row) hands the document + line to the parent and closes the window.
 *
 * @param {boolean} open
 * @param {{ category: string }|null} scope - null = search everywhere; preset
 *   by whoever opened the window (a category's context menu scopes it)
 * @param {function} onScopeChange - (scope|null) when the user picks another
 *   entry in the category dropdown under the search input
 * @param {string[]} categories - the sidebar's category names (same list and
 *   order as the Documents sidebar shows, General and empty ones included)
 * @param {Array} documents - the page's document METADATA list (no content);
 *   only its ids/updatedAt are read, to reload content when something changed
 * @param {function} onClose
 * @param {function} onOpenDocument - (docId, line, range) => void
 * @param {function} [loadDocuments] - async () => documents WITH content
 *   (defaults to getDocuments(); injectable for tests)
 */
export default function FindInFilesWindow({
  open,
  scope = null,
  onScopeChange,
  categories = [],
  documents = [],
  onClose,
  onOpenDocument,
  loadDocuments = getDocuments,
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useLocalStorage('findInFilesOptions', { matchCase: false, wholeWord: false, regex: false });
  // Documents WITH content, tagged with the library signature they were
  // loaded for: `loaded.signature !== librarySignature` means "loading".
  const [loaded, setLoaded] = useState({ signature: null, docs: null });
  // Last finished search, tagged with the key it answered; a key mismatch
  // means a newer query is still being searched.
  const [search, setSearch] = useState(null); // { key, results, matchCount, fileCount, truncated }
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const searchSeqRef = useRef(0);

  // Reload content when the window opens or the library changed while open
  const librarySignature = useMemo(
    () => (documents || []).map((d) => `${d.id}:${d.updatedAt || 0}`).join('|'),
    [documents]
  );
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      let docs = [];
      try {
        const all = await loadDocuments();
        docs = [...(all || [])].sort((a, b) => {
          const ca = a.category || 'General';
          const cb = b.category || 'General';
          if (ca !== cb) return ca.localeCompare(cb);
          return String(a.title || '').localeCompare(String(b.title || ''));
        });
      } catch (err) {
        console.error('[FindInFiles] Failed to load documents:', err);
      }
      if (!cancelled) setLoaded({ signature: librarySignature, docs });
    })();
    return () => { cancelled = true; };
  }, [open, librarySignature, loadDocuments]);
  const docs = loaded.docs;
  const loading = open && loaded.signature !== librarySignature;

  // Focus the input when the window opens; the previous query is kept (like
  // JetBrains) but pre-selected, so typing replaces it
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  // The matcher (or the regex error) for the current query/options
  const matcherState = useMemo(() => {
    if (!query) return { matcher: null, error: null };
    try {
      return { matcher: buildMatcher({ query, ...options }), error: null };
    } catch (err) {
      return { matcher: null, error: err.message };
    }
  }, [query, options]);
  const error = matcherState.error;

  // Debounced search over the loaded content; the result is tagged with the
  // key of the inputs it answers so a stale answer is never shown
  const scopeCategory = scope?.category || null;
  // Dropdown entries: the sidebar's categories in the sidebar's order
  // (CategoryList sorts them with localeCompare), plus the preset category
  // should it not be listed (a document-less category from another source)
  const categoryOptions = useMemo(() => {
    const names = new Set((categories || []).filter((c) => typeof c === 'string' && c));
    if (scopeCategory) names.add(scopeCategory);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [categories, scopeCategory]);
  const searchKey = `${loaded.signature}|${scopeCategory || ''}|${options.matchCase ? 1 : 0}${options.wholeWord ? 1 : 0}${options.regex ? 1 : 0}|${query}`;
  useEffect(() => {
    if (!open || !query || !docs || !matcherState.matcher) return undefined;
    const seq = ++searchSeqRef.current;
    const key = searchKey;
    const matcher = matcherState.matcher;
    const timer = setTimeout(async () => {
      const result = await searchDocumentsAsync(docs, matcher, {
        scopeCategory,
        maxResults: MAX_RESULTS,
        isCancelled: () => searchSeqRef.current !== seq,
      });
      if (result === null || searchSeqRef.current !== seq) return;
      setSearch({ key, ...result });
      setSelectedIndex(result.results.length > 0 ? 0 : -1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, docs, matcherState, scopeCategory, searchKey]);

  const current = query && search && search.key === searchKey ? search : null;
  const searching = !!query && !error && !current;
  const results = useMemo(() => current?.results || [], [current]);

  // Keep the selected row visible
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-result-index="${selectedIndex}"]`);
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const docsById = useMemo(() => {
    const map = new Map();
    (docs || []).forEach((d) => map.set(d.id, d));
    return map;
  }, [docs]);

  const selected = selectedIndex >= 0 ? results[selectedIndex] : null;

  // The preview follows the selection after a short pause so holding an
  // arrow key only re-renders the row highlight, not the whole document
  const [previewTarget, setPreviewTarget] = useState(null); // { docId, line, ranges }
  useEffect(() => {
    const timer = setTimeout(() => {
      setPreviewTarget(selected ? { docId: selected.docId, line: selected.line, ranges: selected.ranges } : null);
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [selected]);
  const previewDoc = previewTarget ? docsById.get(previewTarget.docId) || null : null;

  const openResult = useCallback((result) => {
    if (!result) return;
    onOpenDocument && onOpenDocument(result.docId, result.line, result.ranges[0] || null);
    onClose && onClose();
  }, [onOpenDocument, onClose]);

  const moveSelection = useCallback((delta) => {
    if (results.length === 0) return;
    setSelectedIndex((i) => {
      const base = i < 0 ? 0 : i;
      return Math.max(0, Math.min(results.length - 1, base + delta));
    });
  }, [results.length]);

  function handleKeyDown(e) {
    if (e.target && e.target.tagName === 'SELECT') return; // the category dropdown keeps its native keys
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      moveSelection(10);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      moveSelection(-10);
    } else if (e.key === 'Home' && e.target !== inputRef.current) {
      e.preventDefault();
      setSelectedIndex(results.length ? 0 : -1);
    } else if (e.key === 'End' && e.target !== inputRef.current) {
      e.preventDefault();
      setSelectedIndex(results.length ? results.length - 1 : -1);
    } else if (e.key === 'Enter') {
      if (selected) {
        e.preventDefault();
        openResult(selected);
      }
    }
  }

  const toggle = (key) => setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  const summary = current ? formatSummary(current, MAX_RESULTS) : null;

  const headerExtra = (
    <>
      {summary && (
        <span className="text-xs text-os-text-secondary truncate" data-find-summary="true">{summary}</span>
      )}
    </>
  );

  return (
    <FloatingWindow
      open={open}
      onClose={onClose}
      title="Find in Files"
      icon={<FileSearch size={16} />}
      headerExtra={headerExtra}
      storageKey="findInFilesWindow"
      defaultSize={{ width: 920, height: 650 }}
      minWidth={480}
      minHeight={340}
    >
      <div className="flex flex-col h-full min-h-0" onKeyDown={handleKeyDown} data-find-in-files="true">
        {/* Search row */}
        <div className="px-3 pt-3 pb-2 shrink-0">
          <div className="relative flex items-center">
            <Search size={14} className="absolute left-2.5 text-os-text-muted pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              spellCheck={false}
              autoComplete="off"
              aria-label="Find in files"
              className={`w-full pl-8 pr-[132px] py-1.5 text-sm rounded-sm border bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted outline-hidden focus:border-os-blue focus:ring-1 focus:ring-os-blue font-mono ${error ?'border-red-500':'border-os-input-border'}`}
            />
            <div className="absolute right-1.5 flex items-center gap-0.5">
              {query && (
                <button
                  type="button"
                  onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                  className="p-1 rounded-sm text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary"
                  title="Clear"
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
              <OptionToggle active={options.matchCase} onClick={() => toggle('matchCase')} title="Match Case" shortLabel="Cc">
                <CaseSensitive size={16} />
              </OptionToggle>
              <OptionToggle active={options.wholeWord} onClick={() => toggle('wholeWord')} title="Words" shortLabel="W">
                <WholeWord size={16} />
              </OptionToggle>
              <OptionToggle active={options.regex} onClick={() => toggle('regex')} title="Regex" shortLabel=".*">
                <Regex size={16} />
              </OptionToggle>
            </div>
          </div>
          {/* Category scope, preset by the opener (category context menu ->
              that category, everything else -> All categories) */}
          <div className="mt-1.5 flex items-center gap-2">
            <select
              value={scopeCategory || ''}
              onChange={(e) => onScopeChange && onScopeChange(e.target.value ? { category: e.target.value } : null)}
              aria-label="Category"
              title="Search in"
              data-find-category="true"
              className="max-w-[260px] px-2 py-1 text-xs rounded-sm border border-os-input-border bg-os-input-bg text-os-text-primary outline-hidden focus:border-os-blue focus:ring-1 focus:ring-os-blue"
            >
              <option value="">All categories</option>
              {categoryOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          {error && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400" data-find-error="true">{error}</div>
          )}
        </div>

        {/* Results above, whole-document preview below, draggable split
            (percent of this area, so it keeps working when the window is
            resized; persisted like the window's own size/position) */}
        <div className="flex-1 min-h-0 border-t border-os-border" data-find-split="true">
          <VerticalResizableDivider
            defaultTopHeight={45}
            minTopHeight={20}
            maxTopHeight={80}
            storageKey={PREVIEW_SPLIT_KEY}
            topContent={
              <div
                ref={listRef}
                className="h-full overflow-y-auto outline-hidden focus:outline-hidden focus-visible:outline-hidden"
                tabIndex={0}
                role="listbox"
                aria-label="Search results"
                data-find-results="true"
              >
                {!query ? (
                  <EmptyState>Type search query to find in files</EmptyState>
                ) : error ? null : loading || searching ? (
                  <EmptyState>Searching...</EmptyState>
                ) : results.length === 0 ? (
                  <EmptyState>No matches{scope?.category ? ` in "${scope.category}"` : ''}</EmptyState>
                ) : (
                  results.map((result, index) => (
                    <ResultRow
                      key={`${result.docId}:${result.line}`}
                      result={result}
                      index={index}
                      selected={index === selectedIndex}
                      onSelect={() => setSelectedIndex(index)}
                      onOpen={() => openResult(result)}
                    />
                  ))
                )}
              </div>
            }
            // The band between the results and the preview: the preview's
            // title / line / category strip on the same surface as the
            // window's top bar, and the drag handle across its whole height
            handleClassName="border-t border-b border-os-border bg-os-card-secondary"
            handleContent={
              <div className="flex items-center gap-2 px-3 py-2 text-xs min-h-[34px]" data-find-band="true" data-preview-title="true">
                <GripHorizontal size={14} className="text-os-text-secondary shrink-0" aria-hidden="true" />
                {previewDoc ? (
                  <>
                    <span className="font-medium text-os-text-primary truncate" data-band-title="true">{previewDoc.title || 'Untitled'}</span>
                    <span className="text-os-text-secondary shrink-0" data-band-meta="true">line {previewTarget.line}</span>
                    <span className="text-os-text-secondary truncate" data-band-meta="true">{previewDoc.category || 'General'}</span>
                  </>
                ) : (
                  <span className="text-os-text-secondary" data-band-meta="true">Preview</span>
                )}
              </div>
            }
            bottomContent={
              <div className="flex-1 min-h-0 flex flex-col bg-os-card" data-find-preview="true">
                <div className="flex-1 min-h-0">
                  {previewDoc ? (
                    <DocumentPreview doc={previewDoc} line={previewTarget.line} ranges={previewTarget.ranges} />
                  ) : (
                    <EmptyState>Select a result to preview the document</EmptyState>
                  )}
                </div>
              </div>
            }
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-os-border shrink-0">
          <button
            type="button"
            onClick={() => openResult(selected)}
            disabled={!selected}
            className="px-3 py-1.5 text-sm rounded-sm bg-os-blue text-white hover:bg-os-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Open in New Tab
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}

function OptionToggle({ active, onClick, title, shortLabel, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={title}
      title={`${title} (${shortLabel})`}
      data-find-option={shortLabel}
      className={`p-1 transition-colors ${
 active
 ?'bg-[color-mix(in_srgb,var(--os-blue)_15%,transparent)] text-os-blue ring-1 ring-os-blue'
 :'text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary'
 }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ children }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-os-text-secondary px-4 text-center" data-find-empty="true">
      {children}
    </div>
  );
}

/** `text` with every [start, end) range (in `text` coordinates, shifted by -offset) wrapped in <mark>. */
function highlightSegments(text, ranges, offset = 0) {
  const segments = [];
  let cursor = 0;
  (ranges || []).forEach(([start, end], i) => {
    const s = Math.min(text.length, Math.max(cursor, start - offset));
    const e = Math.min(text.length, Math.max(s, end - offset));
    if (s > cursor) segments.push(<span key={`t${i}`}>{text.slice(cursor, s)}</span>);
    if (e > s) {
      segments.push(
        <mark key={`m${i}`} className="rounded-xs bg-yellow-200/90 dark:bg-yellow-400/30 text-os-text-primary">
          {text.slice(s, e)}
        </mark>
      );
    }
    cursor = e;
  });
  if (cursor < text.length) segments.push(<span key="tail">{text.slice(cursor)}</span>);
  return segments;
}

/**
 * Whole-document, read-only preview of the selected result's raw markdown.
 *
 * Kept cheap on purpose: the text is three text nodes inside ONE <pre>
 * (the lines before the match, the matched line with its <mark>s, the lines
 * after), the gutter is one <pre> of numbers, and every row has the same
 * fixed pitch (PREVIEW_LINE_HEIGHT, no wrapping), so the matched line's
 * position is (line - 1) * pitch - the highlight bar is positioned and the
 * line centered without measuring anything. Only the selected document is
 * ever rendered; a result in another document swaps the text, a result in
 * the same document only moves the highlight and the scroll position.
 */
/** Scroll `el` so preview line `line` (1-based) sits in the vertical middle. */
function centerPreviewLine(el, line) {
  if (!el) return;
  const top = (line - 1) * PREVIEW_LINE_HEIGHT - el.clientHeight / 2 + PREVIEW_LINE_HEIGHT / 2;
  el.scrollTop = Math.max(0, Math.round(top));
}

function DocumentPreview({ doc, line, ranges }) {
  const scrollRef = useRef(null);
  const lines = useMemo(() => splitLines(doc.content), [doc]);
  const numbers = useMemo(() => Array.from({ length: lines.length }, (_, i) => i + 1).join('\n'), [lines.length]);
  const target = Math.min(Math.max(1, line || 1), lines.length);

  // Center the matched line whenever the document or the line changes -
  // before paint, so the pane never flashes at the previous scroll position
  useLayoutEffect(() => {
    centerPreviewLine(scrollRef.current, target);
  }, [doc.id, target]);

  // ...and keep it centered when the pane itself changes height (divider
  // drag, window resize)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => centerPreviewLine(el, target));
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc.id, target]);

  const before = lines.slice(0, target - 1).join('\n');
  const matched = lines[target - 1] ?? '';
  const after = lines.slice(target).join('\n');

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto font-mono text-xs"
      style={{ lineHeight: `${PREVIEW_LINE_HEIGHT}px` }}
      data-preview-doc={doc.id}
      data-preview-line={target}
      data-preview-lines={lines.length}
    >
      <div className="relative flex min-w-max">
        <div
          className="absolute left-0 right-0 bg-[color-mix(in_srgb,var(--os-blue)_18%,transparent)] pointer-events-none"
          style={{ top: `${(target - 1) * PREVIEW_LINE_HEIGHT}px`, height: `${PREVIEW_LINE_HEIGHT}px` }}
          data-preview-highlight="true"
        />
        <pre className="sticky left-0 m-0 pl-2 pr-3 text-right text-os-text-secondary select-none bg-os-card border-r border-os-divider shrink-0 z-10" data-preview-gutter="true">
          {numbers}
        </pre>
        <pre className="m-0 pl-3 pr-4 text-os-text-primary" data-preview-text="true">
          {before}{target > 1 ? '\n' : ''}
          <span data-preview-match-line="true">{highlightSegments(matched, ranges)}</span>
          {target < lines.length ? '\n' : ''}{after}
        </pre>
      </div>
    </div>
  );
}

/** One matching line: highlighted text left, "title line" right. */
function ResultRow({ result, index, selected, onSelect, onOpen }) {
  const lead = result.text.length - result.text.trimStart().length;
  const text = result.text.slice(lead);
  const segments = highlightSegments(text, result.ranges, lead);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-result-index={index}
      data-result-doc={result.docId}
      data-result-line={result.line}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`flex items-center gap-4 px-3 py-1 text-xs font-mono cursor-default select-none outline-hidden ${
 // Tailwind cannot derive an os-blue opacity modifier (the os-* colours
 // are plain var() values without an <alpha-value>), so the tint is mixed here;
 // hover stays the neutral card-secondary so it reads differently
 selected ?'bg-[color-mix(in_srgb,var(--os-blue)_20%,transparent)]':'hover:bg-os-card-secondary'
 }`}
    >
      <span className="flex-1 min-w-0 truncate whitespace-pre text-os-text-primary" title={result.text}>{segments}</span>
      <span className={`shrink-0 truncate max-w-[45%] ${selected ?'text-os-text-primary':'text-os-text-secondary'}`} title={`${result.title} - line ${result.line}`}>
        {result.title} {result.line}
      </span>
    </div>
  );
}
