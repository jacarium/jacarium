#!/usr/bin/env node
/**
 * ```latex blocks in the exported PDF, in the real desktop app (the native
 * PDF export lives in Electron's main process): a document with two
 * formulas is typed, previewed (the maths render) and exported; the PDF's
 * text carries the formulas' glyphs (the letters and digits KaTeX lays out
 * as text) and its fonts include a KaTeX face (the export inlined the
 * bundled fonts, no network), and a broken formula's error box prints as
 * its message.
 *
 * SKIPs (exit 0) when the Electron app cannot be launched here
 * (SKIP_ELECTRON_TESTS=1, no display, no build). Run:
 *   node tests/latex-pdf-electron.test.mjs
 * PDF_OUT=<path> also writes the PDF for inspection.
 */
import { writeFileSync } from 'node:fs';
import { inspectPdf, pdfFonts } from './helpers/pdf-inspect.mjs';
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import { createNewDocument, setEditorContent, clickPreviewButton, exportDocumentPdf, sleep } from './helpers/live-documents-app.mjs';

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`); }

const DOC = [
  '# Maths in print', '', 'Before the maths.', '',
  '```latex', 'E = mc^2', '```', '',
  '```latex', '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', '```', '',
  '```latex', '\\frac{1}{', '```', '',
  'After the maths.', '',
].join('\n');

const app = await launchElectronDocumentsApp({ profilePrefix: 'doc-latex-pdf-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); process.exit(0); }
let exitCode = 1;
try {
  check('a new document on a fresh profile', await createNewDocument(app));
  check('the synthetic document typed', (await setEditorContent(app, DOC)) === DOC);
  check('Preview on', await clickPreviewButton(app));
  const rendered = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('.markdown-preview .latex-block')); return b.length === 3 && b.every((x) => x.dataset.latex === 'rendered' || x.dataset.latex === 'error') ? b.map((x) => x.dataset.latex) : null; })()`, 30000);
  check('the preview rendered the three blocks (two maths, one error)', !!rendered && rendered.join() === 'rendered,rendered,error', JSON.stringify(rendered));
  const katexFontLoaded = await app.evaluate(`(() => Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => /KaTeX_Main/.test(r.cssText)); } catch { return false; } }))()`);
  check('KaTeX\'s stylesheet (with its @font-face rules) is in the page once a block rendered', katexFontLoaded === true);
  const pdf = await exportDocumentPdf(app, { timeoutMs: 120000 });
  check('Export PDF produced a file', !!pdf && pdf.length > 1000, pdf ? `${pdf.length} bytes` : 'no PDF');
  if (pdf) {
    if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, pdf);
    const info = await inspectPdf(pdf);
    const text = info.pageTexts.join('\n');
    check('the PDF text carries the first formula\'s glyphs (E, m, c, 2) and the second\'s (n, 1, 2, 6, pi)', /E/.test(text) && /mc/.test(text.replace(/\s+/g, '')) && /6/.test(text) && /π|π/.test(text), text.slice(0, 200).replace(/\n/g, ' | '));
    check('...and the paragraphs around them', text.includes('Before the maths.') && text.includes('After the maths.'));
    check('the broken formula prints as its error box message, with its source', /LaTeX/.test(text) && /Expected|Unexpected|group/i.test(text) && text.includes('\\frac{1}{'), text.slice(0, 300).replace(/\n/g, ' | '));
    const fonts = await pdfFonts(pdf);
    const names = (fonts || []).map((f) => (typeof f === 'string' ? f : f.name || JSON.stringify(f)));
    check('the PDF embeds a KaTeX font (the maths are drawn with the bundled faces, not a fallback)', names.some((n) => /KaTeX/i.test(n)), names.join(', ').slice(0, 300));
  }
  check('no uncaught exception in the page', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
  exitCode = results.some((r) => !r.pass) ? 1 : 0;
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await sleep(200);
  await app.close();
}
console.log(exitCode ? `\n${results.filter((r) => !r.pass).length} check(s) failed` : '\nAll checks passed');
process.exit(exitCode);
