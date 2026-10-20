/**
 * Guards the Documents page's "Find in Files" feature:
 *   - src/components/features/documents/DocumentSidebar.jsx: the title-filter
 *     input ("Search documents...") is gone; "Find in Files" is offered by
 *     the document context menu (search everywhere), the category context
 *     menu (scoped to that category) and the hamburger menu (everywhere);
 *   - src/components/features/documents/FindInFilesWindow.jsx (on the shared
 *     src/components/common/FloatingWindow.jsx): empty state, debounced
 *     search over the raw markdown, "N matches in M files" summary, one row
 *     per matching line with <mark> highlights and "title line" on the
 *     right, Match Case / Words / Regex toggles, clear button, invalid-regex
 *     message, the "in: <category>" scope chip, keyboard navigation, the
 *     preview pane, "Open in New Tab" / Enter / double-click (which hand the
 *     document + line + range to the page and close the window), the
 *     1000-row cap and Escape;
 *   - src/utils/openDocument.js + DocumentEditor.jsx: the jump-to-line
 *     request selects the matched range in the real editor, both for a
 *     document the editor already shows (window event) and for one it is
 *     switched to afterwards (pending request);
 *   - DocumentsPage.jsx wiring and the editor's Ctrl+F handler ignoring the
 *     shifted (Find in Files) chord - checked at source level.
 *
 * Runs the REAL components in jsdom over a fake IndexedDB with the synthetic
 * fixture tests/fixtures/find-in-files/documents.json; nothing touches the
 * user's data or the network. Real layout (scrolling the editor to the
 * line, theme contrast) lives in tests/documents-find-in-files-live.test.mjs.
 *
 * Run:  node tests/documents-find-in-files.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, typeInto, byText, click, waitFor, sleep, REPO } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('documents-find-in-files', { entry: path.join(here, 'helpers', 'find-in-files-entry.mjs') });
const { documents, openDocument, findInFiles, db, renderSidebar, unmountSidebar, renderFindWindow, unmountFindWindow, renderEditor, unmountEditor, switchEditor } = mod;
const { document } = window;

const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'find-in-files', 'documents.json'), 'utf8'));
const DOCS = FIXTURE.map((d, i) => ({ id: i + 1, updatedAt: 1000 + i, ...d }));
const META = DOCS.map(({ content, ...rest }) => { void content; return rest; });
const CATEGORIES = ['Runbooks', 'Notes', 'General'];
const loadFixture = async () => DOCS;

const keydown = (el, key, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const contextmenu = (el) => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
const dblclick = (el) => el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
const rows = () => Array.from(document.querySelectorAll('[data-result-index]'));
const rowKey = (r) => `${r.getAttribute('data-result-doc')}:${r.getAttribute('data-result-line')}`;
const summaryText = () => document.querySelector('[data-find-summary]')?.textContent || null;
const waitRows = (n) => waitFor(() => { const r = rows(); return r.length === n ? r : null; }, 4000);
const findInput = () => document.querySelector('input[aria-label="Find in files"]');
const menuItem = () => byText(document, /^Find in Files$/, 'button');

/* ================================================================== */
console.log('\n--- 1. sidebar: no title filter, three ways into Find in Files ---');
/* ================================================================== */
{
  window.localStorage.setItem('expandedDocumentCategories', JSON.stringify(CATEGORIES));
  const calls = [];
  renderSidebar({ documents: META, categories: CATEGORIES, onFindInFiles: (scope) => calls.push(scope) });
  await sleep(30);
  check('the "Search documents..." title filter is gone from the sidebar', !document.querySelector('input[placeholder="Search documents..."]'));
  check('every document row is listed (no filter in the way)', DOCS.every((d) => byText(document, new RegExp(`^${d.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'span')));

  // document context menu -> everywhere (scope null)
  const row = byText(document, /^Alpha Notes$/, 'span');
  contextmenu(row);
  await sleep(30);
  let item = menuItem();
  check('right-click on a document offers "Find in Files"', !!item);
  item && click(window, item);
  await sleep(30);
  check('...and opens it searching EVERYWHERE (scope null)', calls.length === 1 && calls[0] === null, JSON.stringify(calls));
  check('the context menu closed', !menuItem());

  // category context menu -> scoped
  const header = Array.from(document.querySelectorAll('span, div')).filter((e) => e.children.length === 0 && e.textContent.trim() === 'Runbooks')[0];
  contextmenu(header);
  await sleep(30);
  item = menuItem();
  check('right-click on a category offers "Find in Files"', !!item);
  item && click(window, item);
  await sleep(30);
  check('...scoped to that category', calls.length === 2 && JSON.stringify(calls[1]) === JSON.stringify({ category: 'Runbooks' }), JSON.stringify(calls));

  // hamburger -> everywhere
  const addButton = document.querySelector('button[title="Add new"]');
  const menuButton = addButton && addButton.nextElementSibling;
  check('the sidebar header has the hamburger button next to "+"', !!menuButton && menuButton.tagName === 'BUTTON');
  menuButton && click(window, menuButton);
  await sleep(30);
  item = menuItem();
  check('the hamburger menu offers "Find in Files"', !!item);
  item && click(window, item);
  await sleep(30);
  check('...searching everywhere', calls.length === 3 && calls[2] === null, JSON.stringify(calls));
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 2. window: empty state, search, rows, summary ---');
/* ================================================================== */
{
  const opened = [];
  let closed = 0;
  const props = { documents: META, loadDocuments: loadFixture, onOpenDocument: (...a) => opened.push(a), onClose: () => { closed += 1; } };
  window.localStorage.removeItem('findInFilesSplit');
  window.localStorage.removeItem('findInFilesWindow');
  renderFindWindow(props);
  await sleep(30);
  const win = document.querySelector('[data-floating-window="findInFilesWindow"]');
  check('the window is a floating (portaled, fixed) window titled "Find in Files"', !!win && win.classList.contains('fixed') && /Find in Files/.test(win.textContent) && win.parentElement === document.body);
  check('default size is 920 x 650 (viewport 1024 x 768 here, so unclamped)', win.style.width === '920px' && win.style.height === '650px', `${win.style.width} x ${win.style.height}`);
  check('it uses the shared FloatingWindow chrome (drag header + close)', !!win.querySelector('[data-floating-window-header]') && !!win.querySelector('button[aria-label="Close"]'));
  check('empty state: "Type search query to find in files", no summary', /Type search query to find in files/.test(document.querySelector('[data-find-results] [data-find-empty]')?.textContent || '') && summaryText() === null);
  check('the preview pane is there from the start, with its own empty state', /Select a result to preview/.test(document.querySelector('[data-find-preview] [data-find-empty]')?.textContent || '') && !document.querySelector('[data-preview-doc]'));
  const input = findInput();
  check('the search input exists with the three toggles (Cc, W, .*) and no clear button yet',
    !!input && ['Cc', 'W', '.*'].every((o) => document.querySelector(`[data-find-option="${o}"]`)) && !document.querySelector('button[aria-label="Clear search"]'));
  await sleep(20);
  check('the input is focused when the window opens', document.activeElement === input);

  typeInto(window, input, 'widget');
  check('typing shows the clear (x) button', !!document.querySelector('button[aria-label="Clear search"]'));
  const got = await waitRows(12);
  check('12 result rows (one per matching line) after the debounce', !!got, rows().length);
  check('summary reads "15 matches in 4 files"', summaryText() === '15 matches in 4 files', summaryText());
  const first = rows()[0];
  check('the first row is selected (keyboard-navigable list)', first && first.getAttribute('aria-selected') === 'true');
  check('rows are grouped like the sidebar: category A-Z, then title A-Z, then line order', rows().map(rowKey).join(',') === '4:1,3:2,3:3,3:4,2:7,1:1,1:3,1:6,1:7,1:10,1:11,1:12', rows().map(rowKey).join(','));
  const marks = Array.from(first.querySelectorAll('mark')).map((m) => m.textContent);
  check('the match is highlighted with <mark> in the line text', marks.length === 1 && marks[0] === 'widget', JSON.stringify(marks));
  const triple = rows().find((r) => rowKey(r) === '1:12');
  check('a line with three hits shows three highlights', triple && triple.querySelectorAll('mark').length === 3);
  const suffix = first.lastElementChild;
  check('"title line" sits right of the text; on the SELECTED row it uses the primary text colour (readable on the blue tint)', suffix && suffix.textContent === 'Uncategorized Scratch 1' && /text-os-text-primary/.test(suffix.className) && !/text-os-text-secondary/.test(suffix.className), suffix && suffix.className);
  check('...and in muted (secondary) text on unselected rows', /text-os-text-secondary/.test(rows()[1].lastElementChild.className));
  check('the selected row carries a colour-mixed blue tint class (os-blue has no alpha slot for Tailwind modifiers)', /color-mix\(in_srgb,var\(--os-blue\)_20%,transparent\)/.test(first.className) && !/color-mix/.test(rows()[1].className), first.className);
  const caseRow = rows().find((r) => rowKey(r) === '1:1');
  check('highlights keep the document\'s own casing ("Widget")', caseRow && caseRow.querySelector('mark').textContent === 'Widget');
  const indented = rows().find((r) => rowKey(r) === '1:11');
  check('leading whitespace is trimmed for display and the highlight still lands on the word',
    indented && indented.firstElementChild.textContent.startsWith('indented') && indented.querySelector('mark').textContent === 'widget');

  // preview pane: the WHOLE selected document (it follows the selection after a short debounce)
  const previewDoc = () => document.querySelector('[data-preview-doc]');
  const highlight = () => document.querySelector('[data-preview-highlight]');
  const gutter = () => (document.querySelector('[data-preview-gutter]')?.textContent || '').split('\n').join(',');
  const previewText = () => document.querySelector('[data-preview-text]')?.textContent;
  await sleep(120);
  check('the preview shows the WHOLE selected document (doc 4: 2 lines) with a line-number gutter and the exact raw markdown',
    previewDoc()?.getAttribute('data-preview-doc') === '4' && previewDoc().getAttribute('data-preview-lines') === '2' && gutter() === '1,2' && previewText() === DOCS[3].content, `${previewDoc()?.getAttribute('data-preview-doc')} ${gutter()}`);
  check('the matched line is highlighted at (line - 1) * 20px and its match is <mark>ed',
    highlight()?.style.top === '0px' && highlight().style.height === '20px' && document.querySelector('[data-preview-match-line] mark')?.textContent === 'widget');
  check('the preview title names the document, line and category', /Uncategorized Scratch/.test(document.querySelector('[data-preview-title]')?.textContent || '') && /line 1/.test(document.querySelector('[data-preview-title]').textContent) && /General/.test(document.querySelector('[data-preview-title]').textContent));
  check('only ONE document is rendered in the preview', document.querySelectorAll('[data-preview-doc]').length === 1 && document.querySelectorAll('[data-preview-text]').length === 1);

  // keyboard navigation from the input
  keydown(input, 'ArrowDown');
  keydown(input, 'ArrowDown');
  await sleep(20);
  check('ArrowDown moves the selection', rows()[2].getAttribute('aria-selected') === 'true' && rows()[0].getAttribute('aria-selected') === 'false');
  check('the preview has not swapped yet right after the key (debounced)', previewDoc()?.getAttribute('data-preview-doc') === '4');
  await sleep(120);
  check('arrow keys swap the preview to the newly selected document (doc 3 "Alpha Notes", all 5 lines, CR-less)',
    previewDoc()?.getAttribute('data-preview-doc') === '3' && previewDoc().getAttribute('data-preview-lines') === '5' && gutter() === '1,2,3,4,5' && previewText() === DOCS[2].content.replace(/\r/g, '') && document.querySelectorAll('[data-preview-doc]').length === 1, `${previewDoc()?.getAttribute('data-preview-doc')} ${gutter()}`);
  check('the highlight moved to line 3 (top = 40px) and marks "Widget"', highlight()?.style.top === '40px' && document.querySelector('[data-preview-match-line] mark')?.textContent === 'Widget', highlight()?.style.top);
  const textElement = document.querySelector('[data-preview-text]');
  keydown(input, 'ArrowUp');
  await sleep(20);
  check('ArrowUp moves back', rows()[1].getAttribute('aria-selected') === 'true');
  await sleep(120);
  check('a result in the SAME document keeps the rendered text element and only moves the highlight (line 2, top = 20px)',
    document.querySelector('[data-preview-text]') === textElement && previewDoc()?.getAttribute('data-preview-doc') === '3' && previewDoc().getAttribute('data-preview-line') === '2' && highlight()?.style.top === '20px' && document.querySelector('[data-preview-match-line]').textContent === 'The widget team meets on Mondays.', highlight()?.style.top);
  keydown(input, 'End');
  await sleep(20);
  check('End in the input is left to the input (caret), the selection stays', rows()[1].getAttribute('aria-selected') === 'true');
  keydown(document.querySelector('[data-find-results]'), 'End');
  await sleep(20);
  check('End on the list selects the last row', rows()[11].getAttribute('aria-selected') === 'true');
  keydown(document.querySelector('[data-find-results]'), 'Home');
  await sleep(20);
  check('Home on the list selects the first row', rows()[0].getAttribute('aria-selected') === 'true');

  // click selects, double-click opens
  click(window, rows()[7]);
  await sleep(20);
  check('clicking a row selects it', rows()[7].getAttribute('aria-selected') === 'true');
  await sleep(120);
  check('a click updates the preview too (doc 1, line 6 highlighted at 100px, 14 lines)', previewDoc()?.getAttribute('data-preview-doc') === '1' && previewDoc().getAttribute('data-preview-lines') === '14' && highlight()?.style.top === '100px' && previewText() === DOCS[0].content, `${previewDoc()?.getAttribute('data-preview-doc')} ${highlight()?.style.top}`);

  // results/preview split: a visible band (preview title strip) is the drag handle
  const handle = document.querySelector('[data-find-split] [title="Drag to resize"]');
  check('a draggable band separates the results from the preview', !!handle && handle.getAttribute('data-resize-handle') === 'band');
  const splitContainer = handle.closest('[data-find-split]').firstElementChild;
  const topSection = splitContainer.firstElementChild;
  const bottomSection = splitContainer.lastElementChild;
  const band = document.querySelector('[data-find-band]');
  check('the band sits at the top of the preview pane and carries the preview title, line and category', !!band && handle.contains(band) && handle.parentElement === bottomSection && bottomSection.firstElementChild === handle
    && /Runbook: Widget Restart/.test(band.querySelector('[data-band-title]')?.textContent || '') && /^line 6$/.test(band.querySelectorAll('[data-band-meta]')[0]?.textContent || '') && /^Runbooks$/.test(band.querySelectorAll('[data-band-meta]')[1]?.textContent || ''), band && band.textContent);
  const headerBg = document.querySelector('[data-floating-window-header]').classList.contains('bg-os-card-secondary');
  check('the band uses the window top bar\'s surface (bg-os-card-secondary) with a top and bottom border', headerBg && handle.classList.contains('bg-os-card-secondary') && handle.classList.contains('border-t') && handle.classList.contains('border-b'), handle.className);
  check('the results list and the preview stay on the plain card surface (distinct from the band)', !document.querySelector('[data-find-results]').className.includes('bg-os-card-secondary') && document.querySelector('[data-find-preview]').classList.contains('bg-os-card') && !document.querySelector('[data-find-preview]').classList.contains('bg-os-card-secondary'));
  check('the band is padded taller than the old strip (py-2, min height 34px)', band.classList.contains('py-2') && band.classList.contains('min-h-[34px]'));
  check('default split: results 45% / preview 55% of the area (percentages, so a window resize keeps it)', topSection.style.height === '45%' && bottomSection.style.height === '55%', `${topSection.style.height} / ${bottomSection.style.height}`);
  check('the results list and the preview fill their panes', document.querySelector('[data-find-results]').parentElement === topSection && document.querySelector('[data-find-preview]').parentElement === bottomSection && document.querySelector('[data-find-preview]').classList.contains('flex-1'));
  splitContainer.getBoundingClientRect = () => ({ top: 0, left: 0, width: 600, height: 400, right: 600, bottom: 400 });
  const mouse = (type, clientY, target = document) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
  mouse('mousedown', 180, band.querySelector('[data-band-title]')); // anywhere on the band starts the drag
  await sleep(20);
  mouse('mousemove', 120);
  await sleep(20);
  check('dragging from the band resizes both panes (120px of 400px -> 30% / 70%)', topSection.style.height === '30%' && bottomSection.style.height === '70%', `${topSection.style.height} / ${bottomSection.style.height}`);
  mouse('mousemove', 10);
  await sleep(20);
  check('the results pane cannot shrink below its minimum (20%)', topSection.style.height === '20%', topSection.style.height);
  mouse('mousemove', 395);
  await sleep(20);
  check('the preview pane cannot shrink below its minimum (results capped at 80%)', topSection.style.height === '80%', topSection.style.height);
  mouse('mousemove', 240);
  mouse('mouseup', 240);
  await sleep(20);
  check('the split is persisted like the window geometry (findInFilesSplit = 60)', window.localStorage.getItem('findInFilesSplit') === '60', window.localStorage.getItem('findInFilesSplit'));
  unmountFindWindow();
  renderFindWindow(props);
  await sleep(30);
  check('a re-opened window restores the saved split', document.querySelector('[data-find-split]').firstElementChild.firstElementChild.style.height === '60%');
  typeInto(window, findInput(), 'widget');
  await waitRows(12);
  dblclick(rows()[7]);
  await sleep(20);
  check('double-click opens the document at that line with the matched range and closes the window',
    opened.length === 1 && JSON.stringify(opened[0]) === JSON.stringify([1, 6, [18, 24]]) && closed === 1, JSON.stringify({ opened, closed }));

  // Enter opens, button opens
  renderFindWindow(props); // still open (the harness keeps it mounted; the page would unmount it)
  click(window, rows()[3]);
  await sleep(20);
  keydown(findInput(), 'Enter'); // the window was re-mounted above; `input` is the old element
  await sleep(20);
  check('Enter opens the selected row', opened.length === 2 && JSON.stringify(opened[1]) === JSON.stringify([3, 4, [15, 21]]) && closed === 2, JSON.stringify(opened[1]));
  click(window, rows()[9]);
  await sleep(20);
  const openButton = byText(document, /^Open in New Tab$/, 'button');
  check('the footer has "Open in New Tab"', !!openButton && !openButton.disabled);
  click(window, openButton);
  await sleep(20);
  check('"Open in New Tab" opens the selected row (first range of a multi-hit line) and closes the window', opened.length === 3 && JSON.stringify(opened[2]) === JSON.stringify([1, 10, [4, 10]]) && closed === 3, JSON.stringify(opened[2]));

  // clear
  click(window, document.querySelector('button[aria-label="Clear search"]'));
  await sleep(20);
  check('the clear button empties the query and returns to the empty state', findInput().value === '' && !!document.querySelector('[data-find-results] [data-find-empty]') && rows().length === 0 && summaryText() === null);
  await sleep(120);
  check('...and the preview empties too', !document.querySelector('[data-preview-doc]') && /Select a result/.test(document.querySelector('[data-find-preview] [data-find-empty]')?.textContent || ''));
  check('"Open in New Tab" is disabled with nothing selected', byText(document, /^Open in New Tab$/, 'button').disabled === true);

  // no matches
  typeInto(window, findInput(), 'no-such-token-anywhere');
  await waitFor(() => /No matches/.test(document.querySelector('[data-find-empty]')?.textContent || ''), 3000);
  check('no hits -> "No matches" and the summary says so', /No matches/.test(document.querySelector('[data-find-results] [data-find-empty]')?.textContent || '') && summaryText() === 'No matches');
  unmountFindWindow();
}

/* ================================================================== */
console.log('\n--- 3. window: toggles, regex errors, scope chip, cap, Escape ---');
/* ================================================================== */
{
  window.localStorage.removeItem('findInFilesOptions');
  let closed = 0;
  let scopeChanges = [];
  const props = { documents: META, categories: [...CATEGORIES, 'Empty Shelf'], loadDocuments: loadFixture, onClose: () => { closed += 1; }, onScopeChange: (s) => scopeChanges.push(s) };
  // A user who already moved/resized the window keeps that geometry over the new default
  window.localStorage.setItem('findInFilesWindow', JSON.stringify({ top: 20, left: 30, width: 500, height: 400 }));
  renderFindWindow(props);
  await sleep(30);
  {
    const win = document.querySelector('[data-floating-window="findInFilesWindow"]');
    check('saved window geometry wins over the default size', win.style.width === '500px' && win.style.height === '400px' && win.style.top === '20px' && win.style.left === '30px', `${win.style.width} x ${win.style.height} @ ${win.style.left},${win.style.top}`);
  }
  const input = findInput();
  const toggle = (label) => click(window, document.querySelector(`[data-find-option="${label}"]`));
  const pressed = (label) => document.querySelector(`[data-find-option="${label}"]`).getAttribute('aria-pressed') === 'true';
  typeInto(window, input, 'widget');
  await waitRows(12);

  toggle('Cc');
  await sleep(20);
  check('Match Case toggle shows as pressed', pressed('Cc'));
  await waitFor(() => summaryText() === '11 matches in 4 files', 3000);
  check('Match Case: "11 matches in 4 files"', summaryText() === '11 matches in 4 files', summaryText());
  toggle('Cc');
  toggle('W');
  await waitFor(() => summaryText() === '13 matches in 3 files', 3000);
  check('Words: "13 matches in 3 files" ("widgets", "WIDGET_OK" excluded)', summaryText() === '13 matches in 3 files' && pressed('W') && !pressed('Cc'), summaryText());
  toggle('W');
  toggle('.*');
  typeInto(window, findInput(), 'widget\\.service');
  await waitFor(() => summaryText() === '2 matches in 1 file', 3000);
  check('Regex: widget\\.service -> "2 matches in 1 file"', summaryText() === '2 matches in 1 file' && pressed('.*'), summaryText());
  check('toggle state is remembered (localStorage findInFilesOptions)', JSON.parse(window.localStorage.getItem('findInFilesOptions') || '{}').regex === true);

  typeInto(window, findInput(), '(');
  await sleep(50);
  const err = document.querySelector('[data-find-error]');
  check('an invalid regex shows an error under the input and no rows', !!err && /Invalid regular expression/.test(err.textContent) && rows().length === 0 && summaryText() === null, err && err.textContent);
  typeInto(window, findInput(), 'gadget[-_]cache');
  await waitFor(() => summaryText() === '2 matches in 1 file', 3000);
  check('fixing the pattern clears the error', !document.querySelector('[data-find-error]') && summaryText() === '2 matches in 1 file');
  toggle('.*');

  // category dropdown under the input (replaces the old "in: <category>" chip)
  const selectEl = () => document.querySelector('[data-find-category]');
  const optionTexts = () => Array.from(selectEl().options).map((o) => o.textContent);
  const pick = (value) => {
    const el = selectEl();
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  check('no "in: <category>" chip in the title bar any more', !document.querySelector('[data-find-scope-chip]') && !/in: /.test(document.querySelector('[data-floating-window-header]').textContent));
  check('a compact category dropdown sits directly under the search input, aligned left',
    !!selectEl() && selectEl().tagName === 'SELECT' && findInput().compareDocumentPosition(selectEl()) & window.Node.DOCUMENT_POSITION_FOLLOWING && selectEl().closest('[data-find-in-files]') && findInput().parentElement.parentElement === selectEl().parentElement.parentElement && /text-xs/.test(selectEl().className) && /bg-os-input-bg/.test(selectEl().className) && /text-os-text-primary/.test(selectEl().className));
  check('it lists "All categories" plus the sidebar\'s categories in the sidebar\'s order (A-Z, General and the empty one included)',
    optionTexts().join('|') === 'All categories|Empty Shelf|General|Notes|Runbooks', optionTexts().join('|'));
  check('opened without a scope (document context menu / hamburger / Ctrl+Shift+F) it is preset to "All categories"', selectEl().value === '' && selectEl().selectedOptions[0].textContent === 'All categories');
  renderFindWindow({ ...props, scope: { category: 'Notes' } });
  check('opened from a category\'s context menu it is preset to that category', selectEl().value === 'Notes');
  typeInto(window, findInput(), 'widget');
  await waitFor(() => summaryText() === '3 matches in 1 file', 3000);
  check('the preset scope limits the search: "3 matches in 1 file", only Notes rows', summaryText() === '3 matches in 1 file' && rows().every((r) => r.getAttribute('data-result-doc') === '3'), summaryText());
  renderFindWindow({ ...props, scope: { category: 'Runbooks' } });
  check('a later "Find in Files" on another category (window still open) switches the dropdown', selectEl().value === 'Runbooks');
  await waitFor(() => summaryText() === '11 matches in 2 files', 3000);
  check('...and re-runs the search: "11 matches in 2 files"', summaryText() === '11 matches in 2 files', summaryText());
  pick('');
  check('picking "All categories" asks the page for scope null', scopeChanges.length === 1 && scopeChanges[0] === null, JSON.stringify(scopeChanges));
  renderFindWindow({ ...props, scope: null });
  await waitFor(() => summaryText() === '15 matches in 4 files', 3000);
  check('...and every category is searched again on the current query: "15 matches in 4 files"', summaryText() === '15 matches in 4 files' && rows().length === 12, summaryText());
  pick('General');
  check('picking a category asks the page for that scope', scopeChanges.length === 2 && JSON.stringify(scopeChanges[1]) === JSON.stringify({ category: 'General' }), JSON.stringify(scopeChanges));
  renderFindWindow({ ...props, scope: { category: 'General' } });
  await waitFor(() => summaryText() === '1 match in 1 file', 3000);
  check('...General: "1 match in 1 file" (the uncategorized document)', summaryText() === '1 match in 1 file' && rows().length === 1 && rows()[0].getAttribute('data-result-doc') === '4', summaryText());
  renderFindWindow({ ...props, scope: { category: 'Archive Attic' } });
  check('a preset category the sidebar does not list is still offered and selected', selectEl().value === 'Archive Attic' && optionTexts().includes('Archive Attic'));
  renderFindWindow({ ...props, scope: null });
  await waitFor(() => summaryText() === '15 matches in 4 files', 3000);
  keydown(selectEl(), 'ArrowDown');
  await sleep(20);
  check('arrow keys on the dropdown are left to the dropdown (the results selection does not move)', rows()[0].getAttribute('aria-selected') === 'true' && rows()[1].getAttribute('aria-selected') === 'false');
  keydown(findInput(), 'ArrowDown');
  await sleep(20);
  check('keyboard navigation from the input still works with the dropdown in between', rows()[1].getAttribute('aria-selected') === 'true');

  // cap
  const big = { id: 50, title: 'Big Log', category: 'Logs', updatedAt: 5, content: Array.from({ length: 1200 }, (_, i) => `row ${i} zzz`).join('\n') };
  const bigLoad = async () => [big, ...DOCS];
  renderFindWindow({ ...props, documents: [...META, { id: 50, title: 'Big Log', category: 'Logs', updatedAt: 5 }], loadDocuments: bigLoad });
  typeInto(window, findInput(), 'zzz');
  await waitFor(() => rows().length === 1000, 6000);
  check('at most 1000 rows are rendered and the summary reads "1000+ matches in 1 file"', rows().length === 1000 && summaryText() === '1000+ matches in 1 file', `${rows().length} rows, ${summaryText()}`);

  // Escape closes
  keydown(findInput(), 'Escape');
  await sleep(20);
  check('Escape closes the window', closed === 1);
  unmountFindWindow();
}

/* ================================================================== */
console.log('\n--- 4. window: loads content from the database by default ---');
/* ================================================================== */
{
  await db.documents.clear();
  const ids = [];
  for (const d of FIXTURE) ids.push(await documents.createDocument(d));
  const meta = await documents.getDocumentsMetadata();
  check('fixture seeded (metadata rows carry no content)', meta.length === 4 && meta.every((m) => !('content' in m)));
  renderFindWindow({ documents: meta });
  await sleep(30);
  typeInto(window, findInput(), 'alpha-notes');
  const got = await waitRows(2);
  check('with no loader injected, the window reads the real documents table: "2 matches in 2 files"', !!got && summaryText() === '2 matches in 2 files', summaryText());
  check('rows reference the stored ids', rows().every((r) => ids.includes(Number(r.getAttribute('data-result-doc')))));
  unmountFindWindow();
  await db.documents.clear();
}

/* ================================================================== */
console.log('\n--- 5. editor: jump to line ---');
/* ================================================================== */
{
  const { requestEditorJumpToLine, takePendingEditorJump, peekPendingEditorJump, DOCUMENT_JUMP_EVENT } = openDocument;
  const { lineStartOffset } = findInFiles;
  check('DOCUMENT_JUMP_EVENT is the window event name', DOCUMENT_JUMP_EVENT === 'documentJumpToLine');
  // pending store semantics
  requestEditorJumpToLine(7, { line: 3, range: [1, 4], broadcast: false });
  check('a request is stored for its document only', takePendingEditorJump(8) === null && JSON.stringify(peekPendingEditorJump()) === JSON.stringify({ documentId: 7, line: 3, range: [1, 4] }));
  check('...and consumed exactly once', JSON.stringify(takePendingEditorJump(7)) === JSON.stringify({ line: 3, range: [1, 4] }) && takePendingEditorJump(7) === null);
  let events = 0;
  const listener = () => { events += 1; };
  window.addEventListener(DOCUMENT_JUMP_EVENT, listener);
  requestEditorJumpToLine(7, { line: 1, broadcast: false });
  requestEditorJumpToLine(7, { line: 1 });
  window.removeEventListener(DOCUMENT_JUMP_EVENT, listener);
  takePendingEditorJump(7);
  check('broadcast (default) fires the window event; broadcast:false does not', events === 1);
  check('a request without a line is ignored', (requestEditorJumpToLine(7, { line: 0 }), peekPendingEditorJump() === null));

  const content1 = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the first document`).join('\n');
  const content2 = 'other\nsecond needle here\nthird';
  renderEditor({ documentId: 1, title: 'First', content: content1 });
  const textarea = await waitFor(() => document.querySelector('textarea'), 4000);
  check('the real DocumentEditor mounted in jsdom showing document 1', !!textarea && textarea.value === content1);

  // already-showing path: the window event
  requestEditorJumpToLine(1, { line: 12, range: [5, 7] });
  const expectStart = lineStartOffset(content1, 12) + 5;
  await waitFor(() => textarea.selectionStart === expectStart, 2000);
  check('a jump for the document the editor already shows selects the matched range on that line',
    textarea.selectionStart === expectStart && textarea.selectionEnd === expectStart + 2 && content1.slice(textarea.selectionStart, textarea.selectionEnd) === '12', `${textarea.selectionStart}-${textarea.selectionEnd}`);
  check('the pending request was consumed by that editor', peekPendingEditorJump() === null);
  check('the editor body has focus', document.activeElement === textarea);

  // switch path: pending request, taken when the editor switches to the document
  requestEditorJumpToLine(2, { line: 2, range: [7, 13], broadcast: false });
  await sleep(30);
  check('a request for another document leaves the current editor alone', textarea.selectionStart === expectStart && peekPendingEditorJump()?.documentId === 2);
  switchEditor({ documentId: 2, title: 'Second', content: content2 });
  const ta2 = await waitFor(() => { const t = document.querySelector('textarea'); return t && t.value === content2 ? t : null; }, 2000);
  await waitFor(() => ta2 && ta2.selectionStart === 6 + 7, 2000);
  check('after the switch the editor jumps to line 2 and selects "needle"',
    !!ta2 && ta2.selectionStart === 13 && ta2.selectionEnd === 19 && content2.slice(ta2.selectionStart, ta2.selectionEnd) === 'needle', ta2 && `${ta2.selectionStart}-${ta2.selectionEnd}`);
  check('the request is gone afterwards', peekPendingEditorJump() === null);

  // a range past the end of the line is clamped to the line
  requestEditorJumpToLine(2, { line: 3, range: [2, 50] });
  await waitFor(() => ta2.selectionStart === lineStartOffset(content2, 3) + 2, 2000);
  check('a range past the line end is clamped to the line', ta2.selectionStart === lineStartOffset(content2, 3) + 2 && ta2.selectionEnd === content2.length);
  unmountEditor();
}

/* ================================================================== */
console.log('\n--- 6. source-level wiring ---');
/* ================================================================== */
{
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const page = read('src/components/DocumentsPage.jsx');
  const sidebar = read('src/components/features/documents/DocumentSidebar.jsx');
  const editor = read('src/components/features/documents/DocumentEditor.jsx');
  const win = read('src/components/features/documents/FindInFilesWindow.jsx');
  check('DocumentsPage renders FindInFilesWindow and passes onFindInFiles to the sidebar', /<FindInFilesWindow\b/.test(page) && /onFindInFiles=\{openFindInFiles\}/.test(page));
  check('DocumentsPage opens the document in the left pane and requests the jump (requestEditorJumpToLine)', /requestEditorJumpToLine\(docId, \{ line, range, broadcast: alreadyActive \}\)/.test(page) && /await handleSelectDocument\(\{ id: docId \}\)/.test(page));
  // the chords live in the shortcut registry now (src/shortcuts/registry.js), remappable in Settings > Shortcuts
  const registry = fs.readFileSync(path.join(REPO, 'src', 'shortcuts', 'registry.js'), 'utf8');
  check('DocumentsPage binds Find in Files through the registry (default Ctrl/Cmd+Shift+F)', /useShortcut\('app\.findInFiles', \(\) => openFindInFiles\(null\)\)/.test(page) && /id: 'app\.findInFiles'[^\n]*defaults: same\('Mod\+Shift\+KeyF'\)/.test(registry));
  check('the editor\'s Find is its own action (Ctrl/Cmd+F), distinct from the shifted chord', /useShortcut\('editor\.find'/.test(editor) && /id: 'editor\.find'[^\n]*defaults: same\('Mod\+KeyF'\)/.test(registry));
  check('the editor consumes jump requests (takePendingEditorJump + the window event)', /takePendingEditorJump\(documentId\)/.test(editor) && /DOCUMENT_JUMP_EVENT/.test(editor));
  check('the sidebar no longer has the title filter state or the lucide Search icon', !/searchQuery|filteredDocuments|Search documents\.\.\./.test(sidebar) && !/\bSearch,|\bSearch \}/.test(sidebar));
  check('the window is built on the shared FloatingWindow and the pure findInFiles util', /from '\.\.\/\.\.\/common\/FloatingWindow'/.test(win) && /from '\.\.\/\.\.\/\.\.\/utils\/findInFiles'/.test(win));
  check('DocumentsPage hands the sidebar\'s category list to the window and the window sorts it like CategoryList (localeCompare)', /categories=\{categories\}/.test(page) && /\.sort\(\(a, b\) => a\.localeCompare\(b\)\)/.test(win) && /sortCategories=\{\(a, b\) => a\.localeCompare\(b\)\}/.test(sidebar));
  check('the scope chip is gone from the window', !/data-find-scope-chip|Remove category scope/.test(win));
  // `os-blue/15` and friends generate NO CSS: the os-* colours are plain var() values without an <alpha-value>
  // placeholder, so Tailwind 3.4 cannot apply an opacity modifier - the selected row used to be invisible.
  const opacityModifier = /\bos-[a-z-]+\/\d+/;
  const dividerSrc = read('src/components/VerticalResizableDivider.jsx');
  check('no os-*/NN opacity-modifier classes in the window, the shared chrome or the divider', !opacityModifier.test(win) && !opacityModifier.test(read('src/components/common/FloatingWindow.jsx')) && !opacityModifier.test(dividerSrc),
    [win, read('src/components/common/FloatingWindow.jsx'), dividerSrc].map((t) => (t.match(/\bos-[a-z-]+\/\d+/g) || []).join(',')).join(' | '));
  check('the results list and rows opt out of the browser focus outline (the blue row is the selection indicator)', /data-find-results="true"/.test(win) && /className="h-full overflow-y-auto outline-hidden focus:outline-hidden focus-visible:outline-hidden"/.test(win) && /cursor-default select-none outline-hidden/.test(win));
  check('the selected row is highlighted with a tint that actually renders (color-mix over --os-blue)', /aria-selected=\{selected\}/.test(win) && /selected\s*\?\s*'[^']*color-mix\(in_srgb,var\(--os-blue\)/.test(win));
  check('the results/preview split reuses the app\'s VerticalResizableDivider with a persisted key', /import VerticalResizableDivider from '\.\.\/\.\.\/VerticalResizableDivider'/.test(win) && /storageKey=\{PREVIEW_SPLIT_KEY\}/.test(win) && /PREVIEW_SPLIT_KEY = 'findInFilesSplit'/.test(win));
  const winCode = win.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const divider = read('src/components/VerticalResizableDivider.jsx');
  check('the band is the divider\'s optional handleContent (other callers keep the invisible strip)', /handleContent=\{/.test(win) && /handleClassName="[^"]*bg-os-card-secondary/.test(win) && /!bottomCollapsed && !handleContent &&/.test(divider) && /handleContent = null/.test(divider));
  check('the default window size grew to 920 x 650 and is clamped to the viewport', /defaultSize=\{\{ width: 920, height: 650 \}\}/.test(win) && /Math\.min\(defaultSize\.width, vw - 32\)/.test(read('src/components/common/FloatingWindow.jsx')));
  check('the preview uses a fixed 20px row pitch, one <pre> of text and one of numbers (no per-line elements)', /PREVIEW_LINE_HEIGHT = 20/.test(win) && (winCode.match(/<pre\b/g) || []).length === 2 && !/lines\.map\(/.test(winCode), String((winCode.match(/<pre\b/g) || []).length));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the window and the shared chrome use no hard-coded colours (theme tokens only)', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(strip(win)) && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(strip(read('src/components/common/FloatingWindow.jsx'))));
}

process.exit(summary());
