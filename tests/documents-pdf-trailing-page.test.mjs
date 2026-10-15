/**
 * Page-fill behaviour of the Documents PDF export (electron/pdf-export.cjs,
 * Chromium printToPDF via src/utils/pdfExportNative.js), in the real
 * Electron app:
 *
 *   - a document whose content ends just short of the page bottom exports
 *     as EXACTLY one page - no empty trailing page (the bug class the old
 *     jsPDF/html2canvas exporter had: its canvas box, not the content,
 *     decided the page count);
 *   - a document that just overflows exports as two pages, with the last
 *     paragraph moved WHOLE onto page 2 (break-inside: avoid) and
 *     paragraphs 1-5 still on page 1;
 *   - the same two cases for a Mermaid diagram at the page bottom: it is
 *     never split, it either stays on page 1 (nearly full) or moves whole to
 *     page 2 (overflow), drawn there with its labels as text, and no page follows it.
 *
 * The fixtures carry a raw-HTML filler block of exact height, so the test
 * first exports a calibration document, reads where its content ends in
 * the export's off-screen container (the same CSS px the print engine lays
 * out, 0.75pt each), and then sizes the filler to land the content a few
 * px above / below the first page's bottom.
 *
 * Run:  node tests/documents-pdf-trailing-page.test.mjs
 * Environment: SKIP_ELECTRON_TESTS, PDF_OUT_DIR (optional: keep the PDFs).
 * Skips (exit 0) when the Electron app cannot be launched here.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import { createNewDocument, setEditorContent, exportDocumentPdf } from './helpers/live-documents-app.mjs';
import { inspectPdf } from './helpers/pdf-inspect.mjs';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// The export's own geometry (electron/pdf-export.cjs): Chromium's A4 =
// 595.92 x 842.88pt, 32pt margins, CSS px -> pt at 0.75 (printToPDF scale 1).
const PT_PER_PX = 0.75;
const PAGE_CSS_HEIGHT = (842.88 - 32 * 2) / PT_PER_PX; // ~1038px of content per page

// ---------- synthetic documents ----------
const FILLER = 'The synthetic ticket describes a login loop on the staging portal after a password reset, reproduced twice by the reporter and once by the on-call engineer before the case was handed over to the platform team for a closer look at the session store.';
const PARAGRAPHS = 6;
// A raw-HTML block of exact height right after the heading shifts everything
// below it by exactly H px (no margins of its own, so nothing collapses).
const textDoc = (fillerPx) => [
  '# Trailing page probe (synthetic)',
  '',
  `<div class="probe-filler" style="height:${fillerPx}px"></div>`,
  '',
  ...Array.from({ length: PARAGRAPHS }, (_, i) => [`Paragraph ${i + 1}: ${FILLER}`, '']).flat(),
].join('\n');
const DIAGRAM = ['graph TD', '  Intakeq[Intakeq queue] --> Triagex[Triagex step]', '  Triagex --> Escalatedq[Escalatedq]'].join('\n');
const diagramDoc = (fillerPx) => [
  '# Diagram trailing page probe (synthetic)',
  '',
  `<div class="probe-filler" style="height:${fillerPx}px"></div>`,
  '',
  `Paragraph before the diagram: ${FILLER}`,
  '',
  '```mermaid', DIAGRAM, '```',
  '',
].join('\n');

// ---------- PDF inspection ----------
async function summarize(pdf) {
  const info = await inspectPdf(pdf);
  const perPage = info.pageTexts.map((text, i) => ({
    // strip the automatic "n / m" page number the export stamps on every page
    body: text.replace(new RegExp(`\\s*${i + 1} / ${info.pages}\\s*$`), '').trim(),
    // Chromium prints the Mermaid SVG as a mix of vector paths and rasterized
    // node shapes; either counts as "drawn"
    drawn: info.paints[i].paths + info.paints[i].images,
  }));
  return { pages: info.pages, perPage };
}

// ---------- run ----------
const app = await launchElectronDocumentsApp({ profilePrefix: 'doc-pdf-trailing-page-' });
if (app.skip) {
  console.log(`SKIP: ${app.skip}`);
  process.exit(0);
}

let exitCode = 1;
try {
  check('Documents page shows the empty-state New Document button on a fresh profile', await createNewDocument(app));

  // Observe the export's off-screen container while it exists: where the
  // content ends (max bottom of anything that is not a directive marker,
  // container-relative) and where the diagram starts. Last mutation wins,
  // so the recorded values are the ones handed to the print engine.
  await app.evaluate(`(() => {
    window.__exportGeom = {};
    new MutationObserver(() => {
      const root = document.querySelector('.pdf-export-root');
      if (!root) return;
      const top = root.getBoundingClientRect().top;
      let contentBottom = 0;
      let diagram = null;
      for (const el of root.querySelectorAll('*')) {
        if (el.hasAttribute('data-pdf-directive')) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.width > 0) contentBottom = Math.max(contentBottom, r.bottom - top);
        if (el.classList.contains('mermaid-diagram') && el.dataset.mermaid === 'rendered') diagram = { top: r.top - top, bottom: r.bottom - top };
      }
      window.__exportGeom.contentBottom = contentBottom;
      window.__exportGeom.diagram = diagram;
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  })()`);
  let exportIndex = 0;
  const exportAndInspect = async (label) => {
    await app.evaluate(`window.__exportGeom = {}`);
    const pdf = await exportDocumentPdf(app);
    if (pdf && process.env.PDF_OUT_DIR) writeFileSync(path.join(process.env.PDF_OUT_DIR, `trailing-page-${++exportIndex}-${label}.pdf`), pdf);
    const geom = await app.evaluate(`window.__exportGeom`);
    return { pdf, geom, summary: pdf ? await summarize(pdf) : null };
  };
  const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
  const hasLast = (s, p) => s.perPage[p - 1].body.includes(`Paragraph ${PARAGRAPHS}:`);

  // ---------- 1. calibration: where does the text document's content end at filler 0? ----------
  check('typed the calibration document', (await setEditorContent(app, textDoc(0))) === textDoc(0));
  const cal = await exportAndInspect('calibration');
  check('calibration export produced a 1-page PDF with a measured content bottom',
    cal.pdf && cal.summary.pages === 1 && cal.geom.contentBottom > 100 && cal.geom.contentBottom < PAGE_CSS_HEIGHT - 200,
    cal.summary ? `pages=${cal.summary.pages} contentBottom=${cal.geom.contentBottom}` : 'no PDF');
  const base = cal.geom.contentBottom;

  // ---------- 2. nearly full page -> exactly 1 page ----------
  const nearTarget = PAGE_CSS_HEIGHT - 12;
  await setEditorContent(app, textDoc(Math.round(nearTarget - base)));
  const nearly = await exportAndInspect('nearly-full');
  check(`nearly-full fixture landed where intended: content ends ~${Math.round(nearTarget)}px into a ${Math.round(PAGE_CSS_HEIGHT)}px page`,
    nearly.pdf && near(nearly.geom.contentBottom, nearTarget), `contentBottom=${nearly.geom.contentBottom}`);
  check('a document that nearly fills one page exports as EXACTLY 1 page (no empty trailing page)',
    nearly.summary && nearly.summary.pages === 1, nearly.summary ? `pages=${nearly.summary.pages}` : 'no PDF');
  check('...and that page carries all six paragraphs', nearly.summary && hasLast(nearly.summary, 1) && nearly.summary.perPage[0].body.includes('Paragraph 1:'));

  // ---------- 3. just overflowing -> 2 pages, last paragraph whole on page 2 ----------
  const overTarget = PAGE_CSS_HEIGHT + 40;
  await setEditorContent(app, textDoc(Math.round(overTarget - base)));
  const over = await exportAndInspect('overflow');
  check('overflow fixture landed where intended (content would straddle the page bottom)',
    over.pdf && near(over.geom.contentBottom, overTarget, 4), `contentBottom=${over.geom.contentBottom}`);
  check('a document that just overflows exports as 2 pages', over.summary && over.summary.pages === 2, over.summary ? `pages=${over.summary.pages}` : 'no PDF');
  check('...with the last paragraph moved WHOLE onto page 2 (not split across the boundary)',
    over.summary && over.summary.pages === 2 && hasLast(over.summary, 2) && !hasLast(over.summary, 1)
      && over.summary.perPage[1].body.includes(FILLER.slice(-40)),
    over.summary ? `p2: ${over.summary.perPage[1]?.body.slice(0, 60)}` : '');
  check('...and paragraphs 1-5 stay on page 1', over.summary && over.summary.perPage[0].body.includes('Paragraph 5:'));

  // ---------- 4. diagram: nearly full page -> 1 page, diagram on it ----------
  check('typed the diagram calibration document', (await setEditorContent(app, diagramDoc(0))) === diagramDoc(0));
  const dcal = await exportAndInspect('diagram-calibration');
  check('diagram calibration export: 1 page, the diagram drawn with its labels as text',
    dcal.pdf && dcal.summary.pages === 1 && dcal.geom.diagram && dcal.summary.perPage[0].drawn > 0 && /Intakeq/.test(dcal.summary.perPage[0].body),
    dcal.summary ? `pages=${dcal.summary.pages} diagram=${JSON.stringify(dcal.geom.diagram)} drawn=${dcal.summary.perPage[0].drawn}` : 'no PDF');
  const dBase = dcal.geom.diagram ? dcal.geom.diagram.bottom : 0;
  const dNear = PAGE_CSS_HEIGHT - 16;
  await setEditorContent(app, diagramDoc(Math.round(dNear - dBase)));
  const dnearly = await exportAndInspect('diagram-nearly-full');
  check('diagram nearly-full fixture landed where intended (diagram ends ~16px above the page bottom)',
    dnearly.pdf && dnearly.geom.diagram && near(dnearly.geom.diagram.bottom, dNear, 4), `diagramBottom=${dnearly.geom.diagram?.bottom}`);
  check('a diagram ending just above the page bottom exports as EXACTLY 1 page with the diagram drawn on it',
    dnearly.summary && dnearly.summary.pages === 1 && dnearly.summary.perPage[0].drawn > 0 && /Intakeq/.test(dnearly.summary.perPage[0].body),
    dnearly.summary ? `pages=${dnearly.summary.pages}` : 'no PDF');

  // ---------- 5. diagram straddling the boundary -> whole diagram on page 2, nothing after ----------
  const dOver = PAGE_CSS_HEIGHT + 60;
  await setEditorContent(app, diagramDoc(Math.round(dOver - dBase)));
  const dover = await exportAndInspect('diagram-overflow');
  check('diagram overflow fixture landed where intended (diagram would straddle the page bottom)',
    dover.pdf && dover.geom.diagram && dover.geom.diagram.top < PAGE_CSS_HEIGHT && dover.geom.diagram.bottom > PAGE_CSS_HEIGHT,
    `diagram=${JSON.stringify(dover.geom.diagram)}`);
  check('a diagram that would straddle the boundary exports as 2 pages with the whole diagram on page 2 and no page after it',
    dover.summary && dover.summary.pages === 2 && dover.summary.perPage[1].drawn > 0 && /Intakeq/.test(dover.summary.perPage[1].body)
      && dover.summary.perPage[0].drawn === 0 && !/Intakeq/.test(dover.summary.perPage[0].body),
    dover.summary ? `pages=${dover.summary.pages} drawn=${dover.summary.perPage.map((p) => p.drawn).join(',')}` : 'no PDF');
  check('...and the paragraph before it stays on page 1', dover.summary && dover.summary.perPage[0].body.includes('Paragraph before the diagram'));

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
