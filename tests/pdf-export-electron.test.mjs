/**
 * Real-app test of the Documents PDF export under Electron
 * (electron/pdf-export.cjs + src/utils/pdfExportNative.js, Chromium's
 * printToPDF), driven with Playwright _electron through
 * tests/helpers/electron-app.mjs on a throwaway userData directory, and
 * read back with the pdfjs-based tests/helpers/pdf-inspect.mjs.
 *
 * Section 1 - the full-feature synthetic document
 * (tests/helpers/pdf-export-fixtures.mjs): page count, cover page
 * ([[centerpage]]), [[pagebreak]], [[blankpage]], [[header]]/[[footer]]
 * bands and the "i / n" page number on every page, [[toc]] numbers that
 * match the pages the headings landed on (resolved from the PDF's named
 * destinations), internal / external / mailto link annotations, the
 * document outline, highlighted code, inline-SVG Mermaid (rendered and the
 * parse-error fallback), an image, a form control, file size.
 *
 * Section 2 - a one-page document, and the IPC surface (validation of a
 * bad payload, cancel of an unknown job).
 *
 * Skips (exit 0 with a SKIP line) when the Electron app cannot be launched
 * here (SKIP_ELECTRON_TESTS, no playwright-core, :5173 busy). No real data: the
 * fixtures are synthetic and the app runs on an empty profile.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchElectronApp, createNewDocument, setEditorText, exportDocumentPdf } from './helpers/electron-app.mjs';
import { inspectPdf, pageOf } from './helpers/pdf-inspect.mjs';
import { FULL_FEATURE_DOC, SIMPLE_DOC } from './helpers/pdf-export-fixtures.mjs';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failed++;
};
const HEADER = 'Example Runbook · internal copy';
const FOOTER = 'Generated for the example team';

const electronApp = await launchElectronApp({ profilePrefix: 'pdf-export-electron-' });
if (electronApp.skip) { console.log('SKIP: ' + electronApp.skip); process.exit(0); }
const keep = process.env.PDF_EXPORT_KEEP_DIR || null;
const outDir = keep || mkdtempSync(path.join(tmpdir(), 'pdf-export-electron-'));

try {
  const { page } = electronApp;
  check('the Electron app exposes electronAPI.exportPdf', await page.evaluate(() => typeof window.electronAPI?.exportPdf === 'function'));

  // ---------------- section 1: full-feature document ----------------
  check('a new document opens on the empty profile', await createNewDocument(page));
  await setEditorText(page, FULL_FEATURE_DOC);
  const t0 = Date.now();
  const nativeFull = await exportDocumentPdf(page, { timeoutMs: 120000 });
  const elapsed = Date.now() - t0;
  check('Export PDF produced a PDF through the Electron exporter', !!nativeFull, nativeFull ? `${nativeFull.length} bytes in ${elapsed} ms` : 'no blob captured');
  if (nativeFull) {
    writeFileSync(path.join(outDir, 'electron-full.pdf'), nativeFull);
    const info = await inspectPdf(nativeFull);
    const n = info.pages;
    check('the document spans several pages (cover, body, blank page, appendix)', n >= 5, `pages=${n}`);
    check('[[centerpage]]: page 1 is the cover alone (title, no body text)', /Example Runbook/.test(info.pageTexts[0]) && /Cover page for the export tests/.test(info.pageTexts[0]) && !/Paragraph 1:/.test(info.pageTexts[0]));
    check('[[header]] band is stamped on every page', info.pageTexts.every((t) => t.includes(HEADER)), info.pageTexts.map((t, i) => t.includes(HEADER) ? '' : `p${i + 1} missing`).filter(Boolean).join(','));
    check('[[footer]] band is stamped on every page', info.pageTexts.every((t) => t.includes(FOOTER)));
    check('every page carries its "i / n" page number', info.pageTexts.every((t, i) => t.includes(`${i + 1} / ${n}`)));
    const tocPage = pageOf(info, 'Table of Contents');
    const overviewPage = pageOf(info, 'Paragraph 1:');
    const procedurePage = pageOf(info, 'def restart');
    const diagramsPage = pageOf(info, 'Intake queue');
    const appendixPage = pageOf(info, 'Paragraph 10:');
    check('named destinations exist for every ToC target', ['overview', 'procedure', 'diagrams', 'appendix'].every((k) => info.dests[k] > 0), JSON.stringify(info.dests));
    check('[[toc]] numbers resolve to the pages the headings landed on', info.dests.overview === overviewPage && info.dests.procedure === procedurePage && info.dests.diagrams === diagramsPage && info.dests.appendix === appendixPage, `dests=${JSON.stringify(info.dests)} headings=${JSON.stringify({ overviewPage, procedurePage, diagramsPage, appendixPage })}`);
    const tocText = info.pageTexts[tocPage - 1] || '';
    check('the ToC page shows those numbers next to the entries', [overviewPage, procedurePage, diagramsPage, appendixPage].every((p) => new RegExp(`(^|\\s)${p}(\\s|$)`).test(tocText)), tocText.slice(0, 80));
    check('[[pagebreak]]: "Procedure" starts a fresh page after the Overview', procedurePage > overviewPage && /^Procedure\b/.test(info.pageTexts[procedurePage - 1]), `p${procedurePage}: ${(info.pageTexts[procedurePage - 1] || '').slice(0, 40)}`);
    const blankPage = pageOf(info, 'This page is intentionally left blank');
    check('[[blankpage]]: a page of its own with only the notice, the bands and the number', blankPage > 0 && info.pageTexts[blankPage - 1].replace(HEADER, '').replace(FOOTER, '').replace(/\d+ \/ \d+/, '').trim() === 'This page is intentionally left blank', `p${blankPage}`);
    check('the Appendix follows the blank page', appendixPage === blankPage + 1, `blank=${blankPage} appendix=${appendixPage}`);
    const urls = info.links.filter((l) => l.url).map((l) => l.url);
    check('external and mailto links are URI annotations', urls.includes('https://docs.example.com/runbook?id=1') && urls.includes('mailto:team@example.com'), urls.join(', '));
    const internal = info.links.filter((l) => l.dest).map((l) => l.dest);
    check('internal links are GoTo annotations (ToC entries + the inline "Appendix" link)', internal.filter((d) => d === 'appendix').length >= 2 && ['overview', 'procedure', 'diagrams'].every((d) => internal.includes(d)), internal.join(', '));
    check('a document outline (bookmarks) is generated from the headings', info.outline.length >= 1 && info.outline.reduce((s, o) => s + 1 + o.items, 0) >= 4, JSON.stringify(info.outline));
    check('the highlighted code block is exported as text', /def restart/.test(info.pageTexts[procedurePage - 1]) && /systemctl/.test(info.pageTexts[procedurePage - 1]));
    check('the Mermaid diagram is vector text (node labels extractable)', /Intake queue/.test(info.pageTexts[diagramsPage - 1]) && /Triage/.test(info.pageTexts[diagramsPage - 1]) && /Escalated/.test(info.pageTexts[diagramsPage - 1]));
    check('the invalid diagram falls back to its error box + source', /Mermaid diagram could not be rendered/.test(info.pageTexts[diagramsPage - 1]) && /graph TD/.test(info.pageTexts[diagramsPage - 1]));
    check('the image is embedded on the Overview page', (info.paints[overviewPage - 1]?.images || 0) >= 1, JSON.stringify(info.paints[overviewPage - 1]));
    check('the table and lists are there', /example-a\.service/.test(info.pageTexts[overviewPage - 1]) && /Nested item two/.test(info.pageTexts[overviewPage - 1]));
    check('the form control label is exported', /Acknowledged/.test(info.pageTexts[overviewPage - 1]));
    check('file size stays reasonable (< 1.5 MB with fonts embedded)', nativeFull.length < 1.5 * 1024 * 1024, `${nativeFull.length} bytes`);
  }

  // ---------------- section 1b: page size and orientation ----------------
  // Letter portrait and A4 landscape of the same full-feature document:
  // page box, bands + page numbers on every page, ToC destinations, blank
  // page and cover page must all hold on the other page geometries. The
  // choice is remembered (localStorage) and offered again next time.
  for (const [label, opts, expect] of [
    ['Letter portrait', { pageSize: 'Letter', landscape: false }, { width: 612, height: 792 }],
    ['A4 landscape', { pageSize: 'A4', landscape: true }, { width: 842.88, height: 595.92 }],
  ]) {
    const bytes = await exportDocumentPdf(page, { timeoutMs: 120000, ...opts });
    check(`${label}: the export produced a PDF`, !!bytes, bytes ? `${bytes.length} bytes` : 'no blob');
    if (!bytes) continue;
    writeFileSync(path.join(outDir, `electron-full-${opts.pageSize.toLowerCase()}-${opts.landscape ? 'landscape' : 'portrait'}.pdf`), bytes);
    const info = await inspectPdf(bytes);
    const n = info.pages;
    const sizeOk = info.pageSizes.every((s) => Math.abs(s.width - expect.width) < 1 && Math.abs(s.height - expect.height) < 1);
    check(`${label}: every page has the ${expect.width}x${expect.height}pt page box`, sizeOk, JSON.stringify(info.pageSizes[0]));
    check(`${label}: cover page alone on page 1`, /Cover page for the export tests/.test(info.pageTexts[0]) && !/Paragraph 1:/.test(info.pageTexts[0]));
    check(`${label}: header and footer bands on every page`, info.pageTexts.every((t) => t.includes(HEADER) && t.includes(FOOTER)));
    check(`${label}: "i / n" page numbers on every page`, info.pageTexts.every((t, i) => t.includes(`${i + 1} / ${n}`)));
    check(`${label}: [[toc]] destinations resolve to the headings' pages`,
      info.dests.overview === pageOf(info, 'Paragraph 1:') && info.dests.procedure === pageOf(info, 'def restart') && info.dests.appendix === pageOf(info, 'Paragraph 10:'), JSON.stringify(info.dests));
    const blank = pageOf(info, 'This page is intentionally left blank');
    check(`${label}: the blank page is a page of its own followed by the Appendix`, blank > 0 && pageOf(info, 'Paragraph 10:') === blank + 1, `blank=${blank}`);
    check(`${label}: links, outline and diagram labels present`, info.links.some((l) => l.url === 'mailto:team@example.com') && info.outline.length >= 1 && info.pageTexts.some((t) => /Intake queue/.test(t)));
    check(`${label}: the choice was remembered for next time`, JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('pdfExportOptions') || 'null'))) === JSON.stringify(opts));
  }
  // Back to the defaults for the rest (and the next run)
  await page.evaluate(() => localStorage.setItem('pdfExportOptions', JSON.stringify({ pageSize: 'A4', landscape: false })));

  // ---------------- section 2: simple document + IPC surface ----------------
  await setEditorText(page, SIMPLE_DOC);
  const simple = await exportDocumentPdf(page, { timeoutMs: 60000 });
  check('a short document exports', !!simple);
  if (simple) {
    const info = await inspectPdf(simple);
    check('...as exactly one page with its number and link', info.pages === 1 && info.pageTexts[0].includes('1 / 1') && info.links.some((l) => l.url === 'https://example.com/simple'), `pages=${info.pages}`);
    check('...without bands or a ToC pass (no header/footer text)', !info.pageTexts[0].includes(HEADER));
  }
  const badPayload = await page.evaluate(() => window.electronAPI.exportPdf({ jobId: 'nope', css: 'x', bodyHtml: 'y' }));
  check('the main process rejects a malformed payload instead of printing', badPayload && badPayload.ok === false && /jobId/.test(badPayload.error || ''), JSON.stringify(badPayload));
  const badSize = await page.evaluate(() => window.electronAPI.exportPdf({ jobId: 'abcdefgh-1234', css: 'x', bodyHtml: 'y', pageSize: 'Tabloid' }));
  check('the main process rejects an unknown page size', badSize && badSize.ok === false && /pageSize/.test(badSize.error || ''), JSON.stringify(badSize));
  check('cancelling an unknown job is refused', (await page.evaluate(() => window.electronAPI.cancelExportPdf('does-not-exist-1'))) === false);
} finally {
  await electronApp.close();
}

if (!keep) rmSync(outDir, { recursive: true, force: true });
else console.log(`PDFs kept in ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
