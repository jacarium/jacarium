/**
 * Guards the Documents editor after a document switch while Preview is on
 * (src/components/features/documents/DocumentEditor.jsx: the gutter's
 * lineLayoutData memo and the textarea ResizeObserver effect).
 *
 * THE BUG: open document A, enable Preview, switch to document B (which has
 * text) - B opens in the editor but its line numbers are missing: the gutter
 * stays blank until you click into the document and press Enter. Same when
 * B also opens in preview and you toggle preview off. The text itself was
 * there; the gutter's numbers block is rendered with visibility:hidden until
 * the textarea has been measured ("calibrated"), and that measurement never
 * happened:
 *   - lineLayoutData (DocumentEditor.jsx ~483) returns an uncalibrated flat
 *     layout whenever the textarea is not mounted (preview pane shown) and is
 *     memoized on content/width only, not on the textarea element;
 *   - the only thing that re-runs it after the textarea (re)mounts is the
 *     ResizeObserver effect (~2045) calling setTextareaContentWidth(); when
 *     the new textarea has the SAME width as the last measured one, React
 *     bails out of that identical state update, nothing re-renders, and the
 *     memo keeps the stale uncalibrated layout. The next content change
 *     (Enter) finally recomputes it - hence the workaround.
 *
 * THE FIX: the effect also records the mounted textarea element in state, so
 * a (re)mounted textarea always triggers one re-render and the memo (which
 * now depends on it) measures the new element.
 *
 * What this proves in the REAL app (headless Chrome + Vite dev server,
 * synthetic content, throwaway profile), reading the editor state without
 * any keyboard or mouse input into the document:
 *   1. baseline: a freshly typed document shows its text with a visible
 *      gutter holding one row per line;
 *   2. A -> Preview on -> switch to B (editor mode): B's text is in the
 *      textarea AND the gutter is visible with B's line count, immediately;
 *   3. B -> Preview on, A (still in preview) -> B (opens in preview, shows
 *      B's preview) -> Preview off: textarea with B's text, gutter visible;
 *   4. same-document Preview on -> off: gutter visible;
 *   5. no uncaught exceptions.
 *
 * Skips (exit 0, "SKIP:" line) without Chrome/Chromium or when
 * SKIP_BROWSER_TESTS=1 is set - see tests/helpers/live-documents-app.mjs.
 * Run by hand:
 *
 *   node tests/documents-preview-switch-gutter.test.mjs
 *
 * Environment: CHROME_BIN, SMOKE_PORT (default 5209).
 * Exit code: 0 = all checks passed (or skipped), 1 = a check failed.
 */
import {
  launchDocumentsApp, createNewDocument, createDocumentViaSidebar, setEditorContent,
  clickTab, clickPreviewButton, readEditorState, openTabTitles, sleep,
} from './helpers/live-documents-app.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5209);

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- synthetic documents ----------
const DOC_A = ['# Alpha notes (synthetic)', '', 'First alpha line about the staging portal.', 'Second alpha line about the password reset.', '', '- alpha bullet one', '- alpha bullet two'].join('\n');
const DOC_B = ['# Bravo notes (synthetic)', '', 'Bravo line one: the on-call engineer reproduced the login loop.', 'Bravo line two: the case was handed over after triage.', 'Bravo line three.', '', '1. bravo step one', '2. bravo step two', '3. bravo step three'].join('\n');
const LINES_A = DOC_A.split('\n').length;
const LINES_B = DOC_B.split('\n').length;

const gutterOk = (s, lines) => !!s.gutter && s.gutter.visibility === 'visible' && s.gutter.rows === lines && s.gutter.numbers === '1,2,3';
const fmt = (s) => JSON.stringify({ previewOpen: s.previewOpen, hasTextarea: s.hasTextarea, lines: s.textareaLines, gutter: s.gutter, mode: s.previewTitle });

const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'doc-preview-switch-' });
if (app.skip) {
  console.log(`SKIP: ${app.skip}`);
  process.exit(0);
}

let exitCode = 1;
try {
  // ---------- 1. two documents ----------
  check('Documents page shows the empty-state New Document button on a fresh profile', await createNewDocument(app));
  check('typed document A', (await setEditorContent(app, DOC_A)) === DOC_A);
  const base = await readEditorState(app);
  check(`baseline: freshly typed document shows its text with a visible gutter of ${LINES_A} rows`,
    base.hasTextarea && base.textareaValue === DOC_A && gutterOk(base, LINES_A), fmt(base));

  check('created document B with the sidebar "+" button', await createDocumentViaSidebar(app));
  check('typed document B', (await setEditorContent(app, DOC_B)) === DOC_B);
  const tabs = await openTabTitles(app);
  check('both documents are open as tabs (A first, B second)', tabs.length === 2, JSON.stringify(tabs));
  const stateB0 = await readEditorState(app);
  check(`B shows its text with a visible gutter of ${LINES_B} rows`, stateB0.textareaValue === DOC_B && gutterOk(stateB0, LINES_B), fmt(stateB0));

  // ---------- 2. A -> Preview on -> switch to B (editor) ----------
  check('switched to tab A', await clickTab(app, 0));
  const stateA = await readEditorState(app);
  check('tab A shows document A in the editor', stateA.hasTextarea && stateA.textareaValue === DOC_A && gutterOk(stateA, LINES_A), fmt(stateA));
  check('Preview turned on for A', await clickPreviewButton(app));
  const previewA = await readEditorState(app);
  check('A is in preview (preview pane shows A, no textarea)', previewA.previewOpen && !previewA.hasTextarea && /Alpha notes/.test(previewA.previewText), fmt(previewA));
  await sleep(1200); // past the 1s "Preview (all documents)" escalation window
  check('switched to tab B while A was in preview', await clickTab(app, 1));
  const switched = await readEditorState(app);
  check('B opens in the editor (B has no saved preview mode) with B\'s text in the textarea',
    !switched.previewOpen && switched.hasTextarea && switched.textareaValue === DOC_B, fmt(switched));
  check(`THE BUG: B's line numbers are visible immediately - gutter visible with ${LINES_B} rows, no click or Enter needed`,
    gutterOk(switched, LINES_B), fmt(switched));
  // Still true a moment later (no delayed recovery is happening either way)
  await sleep(800);
  const switchedLater = await readEditorState(app);
  check('...and still visible a moment later (state is settled, not timing)', gutterOk(switchedLater, LINES_B), fmt(switchedLater));

  // ---------- 3. B preview on; A (preview) -> B (preview) -> preview off ----------
  check('Preview turned on for B', await clickPreviewButton(app));
  await sleep(1200);
  const previewB = await readEditorState(app);
  check('B is in preview', previewB.previewOpen && /Bravo notes/.test(previewB.previewText), fmt(previewB));
  check('switched to tab A (still in preview)', await clickTab(app, 0));
  const previewA2 = await readEditorState(app);
  check('A re-opens in preview (its saved mode)', previewA2.previewOpen && /Alpha notes/.test(previewA2.previewText), fmt(previewA2));
  check('switched to tab B (saved in preview)', await clickTab(app, 1));
  const previewB2 = await readEditorState(app);
  check('B re-opens in preview showing B\'s content', previewB2.previewOpen && /Bravo notes/.test(previewB2.previewText) && !/Alpha/.test(previewB2.previewText), fmt(previewB2));
  check('Preview turned off for B', await clickPreviewButton(app));
  const offB = await readEditorState(app);
  check('B returns to the editor with B\'s text', !offB.previewOpen && offB.hasTextarea && offB.textareaValue === DOC_B, fmt(offB));
  check(`THE BUG (toggle-off after switch): gutter visible with ${LINES_B} rows immediately`, gutterOk(offB, LINES_B), fmt(offB));

  // ---------- 4. same document: preview on -> off ----------
  await sleep(1200);
  check('Preview turned on for B again', await clickPreviewButton(app));
  await sleep(1200);
  check('Preview turned off for B again', await clickPreviewButton(app));
  const sameDoc = await readEditorState(app);
  check(`same-document preview on/off keeps the gutter visible with ${LINES_B} rows`, sameDoc.hasTextarea && sameDoc.textareaValue === DOC_B && gutterOk(sameDoc, LINES_B), fmt(sameDoc));

  check('no uncaught exceptions in the page', app.errors.length === 0, app.errors.slice(0, 3).join(' || '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  await app.close();
}
process.exit(exitCode);
