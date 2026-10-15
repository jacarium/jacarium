/**
 * Unit tests for electron/pdf-export.cjs, the main-process half of the
 * Documents PDF export (printToPDF), with plain Node - no Electron window:
 *
 *   - the IPC payload validator only lets plain strings/booleans within the
 *     size limits through (the renderer is the only caller, but the handler
 *     never trusts it);
 *   - computeMargins implements the band geometry: margins
 *     grow by band + edge + gap, and bands that would leave < 200pt of body
 *     are dropped back to the base margins;
 *   - readNamedDestinations resolves a PDF's /Dests dictionary (what
 *     Chromium writes for every link target with an id) to 1-based pages;
 *   - stampPages draws a band page and the "i / n" page number onto every
 *     page (bottom-centre, or the right corner beside a footer band);
 *   - the hidden window's request filter admits only file:// reads inside
 *     the temp directory; the HTML wrapper escapes the title.
 *
 * Run: node tests/pdf-export-main.test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPdf } from './helpers/pdf-inspect.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = require(path.join(REPO, 'electron', 'pdf-export.cjs'));
const pdfLib = await import('pdf-lib');
const { PDFDocument, PDFName, PDFArray, PDFNumber, StandardFonts } = pdfLib;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failed++;
};
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---------- validatePayload ----------
const good = { jobId: 'abcdef12-3456', title: 'Doc', css: 'body{}', bodyHtml: '<p>x</p>', headerHtml: '<div>h</div>', footerHtml: null, hasToc: true };
const v = mod.validatePayload(good);
check('a valid payload passes with its fields', v.jobId === good.jobId && v.title === 'Doc' && v.css === 'body{}' && v.bodyHtml === '<p>x</p>' && v.headerHtml === '<div>h</div>' && v.footerHtml === null && v.hasToc === true);
check('hasToc is only true for boolean true', mod.validatePayload({ ...good, hasToc: 'yes' }).hasToc === false);
check('missing title falls back to Untitled', mod.validatePayload({ ...good, title: undefined }).title === 'Untitled');
check('rejects a non-object', throwsWith(() => mod.validatePayload('x'), /must be an object/));
check('rejects a missing jobId', throwsWith(() => mod.validatePayload({ ...good, jobId: undefined }), /jobId is required/));
check('rejects a malformed jobId', throwsWith(() => mod.validatePayload({ ...good, jobId: '../x' }), /malformed jobId/));
check('rejects a non-string body', throwsWith(() => mod.validatePayload({ ...good, bodyHtml: { toString: () => 'x' } }), /must be a string/));
check('rejects an oversized title', throwsWith(() => mod.validatePayload({ ...good, title: 'x'.repeat(301) }), /exceeds/));
check('rejects a missing stylesheet', throwsWith(() => mod.validatePayload({ ...good, css: '' }), /css is required/));
check('page options default to A4 portrait', mod.validatePayload(good).pageSize === 'A4' && mod.validatePayload(good).landscape === false);
check('accepts Letter / Legal and a boolean landscape', mod.validatePayload({ ...good, pageSize: 'Letter', landscape: true }).pageSize === 'Letter' && mod.validatePayload({ ...good, pageSize: 'Legal', landscape: true }).landscape === true);
check('rejects an unknown page size', throwsWith(() => mod.validatePayload({ ...good, pageSize: 'Tabloid' }), /unknown pageSize/) && throwsWith(() => mod.validatePayload({ ...good, pageSize: { toString: () => 'A4' } }), /unknown pageSize/));
check('rejects a non-boolean landscape', throwsWith(() => mod.validatePayload({ ...good, landscape: 'yes' }), /landscape must be a boolean/));
const dimsA4 = mod.pageDimensions({ pageSize: 'A4', landscape: false });
const dimsLetterL = mod.pageDimensions({ pageSize: 'Letter', landscape: true });
const dimsLegal = mod.pageDimensions({ pageSize: 'Legal' });
check('pageDimensions: A4 portrait, Letter landscape (swapped), Legal', dimsA4.widthPt === 595.92 && dimsA4.heightPt === 842.88 && dimsLetterL.widthPt === 792 && dimsLetterL.heightPt === 612 && dimsLegal.heightPt === 1008, JSON.stringify([dimsA4, dimsLetterL, dimsLegal]));
check('pageDimensions falls back to A4 for an unknown size', mod.pageDimensions({ pageSize: 'nope' }).widthPt === 595.92);

// ---------- computeMargins ----------
const base = mod.computeMargins({});
check('no bands: base 32pt margins all round', base.top === 32 && base.bottom === 32 && base.left === 32 && base.right === 32 && base.bandsUsable === true);
const withBands = mod.computeMargins({ headerBandPt: 20, footerBandPt: 30 });
check('bands grow top/bottom by edge + band + gap (18 + h + 14)', withBands.top === 18 + 20 + 14 && withBands.bottom === 18 + 30 + 14 && withBands.bandsUsable === true, JSON.stringify(withBands));
const tooTall = mod.computeMargins({ headerBandPt: 320, footerBandPt: 320 });
check('bands leaving < 200pt of body are skipped: base margins, bandsUsable false', tooTall.top === 32 && tooTall.bottom === 32 && tooTall.bandsUsable === false);
const edge = mod.computeMargins({ headerBandPt: 300, footerBandPt: 0 });
check('a single tall band is kept while 200pt of body remain', edge.bandsUsable === (mod.PAGE_HEIGHT_PT - (18 + 300 + 14) - 32 >= 200));
// The same bands on a shorter page (Letter landscape, 612pt high) leave less
// than 200pt of body and are skipped; on A4 landscape (595pt) likewise
const short = mod.computeMargins({ headerBandPt: 200, footerBandPt: 200, pageHeightPt: 612 });
const tall = mod.computeMargins({ headerBandPt: 200, footerBandPt: 200, pageHeightPt: 1008 });
check('the skip rule uses the chosen page height (Letter landscape skips, Legal keeps)', short.bandsUsable === false && short.top === 32 && tall.bandsUsable === true && tall.top === 18 + 200 + 14, JSON.stringify([short, tall]));

// ---------- readNamedDestinations on a pdf-lib built /Dests dictionary ----------
async function buildDocWithDests() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [doc.addPage([595.28, 841.89]), doc.addPage([595.28, 841.89]), doc.addPage([595.28, 841.89])];
  pages.forEach((p, i) => p.drawText(`Body page ${i + 1}`, { x: 40, y: 800, size: 14, font }));
  const dests = doc.context.obj({});
  const xyz = (page) => doc.context.obj([page.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(800), PDFNumber.of(0)]);
  dests.set(PDFName.of('intro'), xyz(pages[0]));
  dests.set(PDFName.of('details'), xyz(pages[2]));
  // the /D-wrapped form some producers use
  dests.set(PDFName.of('wrapped'), doc.context.obj({ D: xyz(pages[1]) }));
  doc.catalog.set(PDFName.of('Dests'), dests);
  return doc;
}
const destDoc = await buildDocWithDests();
const destBytes = await destDoc.save();
const resolved = await mod.readNamedDestinations(pdfLib, destBytes);
check('named destinations resolve to 1-based pages (direct and /D-wrapped)', resolved.intro === 1 && resolved.wrapped === 2 && resolved.details === 3, JSON.stringify(resolved));
check('a PDF without destinations yields an empty map', Object.keys(await mod.readNamedDestinations(pdfLib, await (await PDFDocument.create()).save())).length === 0);

// ---------- stampPages ----------
async function buildBand(widthPt, heightPt, text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([widthPt, heightPt]);
  page.drawText(text, { x: 2, y: heightPt / 2 - 4, size: 10, font });
  return { bytes: await doc.save(), widthPt, heightPt };
}
const header = await buildBand(531.28, 24, 'Header band text');
const footer = await buildBand(491.28, 20, 'Footer band text');
const margins = mod.computeMargins({ headerBandPt: 24, footerBandPt: 20 });
const stamped = await mod.stampPages(pdfLib, destBytes, { headerBand: header, footerBand: footer, margins });
const info = await inspectPdf(stamped.bytes);
check('stampPages keeps every page', stamped.pages === 3 && info.pages === 3);
check('the header and footer bands appear on every page', info.pageTexts.every((t) => t.includes('Header band text') && t.includes('Footer band text')), info.pageTexts.map((t) => t.slice(0, 60)).join(' | '));
check('every page carries its "i / n" page number', info.pageTexts.every((t, i) => t.includes(`${i + 1} / 3`)));
const stampedNoBands = await mod.stampPages(pdfLib, destBytes, { headerBand: null, footerBand: null, margins: mod.computeMargins({}) });
const info2 = await inspectPdf(stampedNoBands.bytes);
check('without bands the page number is still drawn (bottom-centre)', info2.pageTexts.every((t, i) => t.includes(`${i + 1} / 3`)) && !info2.pageTexts[0].includes('Header band'));
const skipped = await mod.stampPages(pdfLib, destBytes, { headerBand: header, footerBand: footer, margins: mod.computeMargins({ headerBandPt: 320, footerBandPt: 320 }) });
check('bands are not drawn when the margins rule skipped them', !(await inspectPdf(skipped.bytes)).pageTexts[0].includes('Header band text'));
check('named destinations survive stamping', (await mod.readNamedDestinations(pdfLib, stamped.bytes)).details === 3);
// Bands embedded once: a 3-page doc should not carry three copies of the band page
const sizeOne = (await mod.stampPages(pdfLib, destBytes, { headerBand: header, footerBand: null, margins })).bytes.length;
check('stamped output stays small (bands are shared XObjects, not per-page copies)', stamped.bytes.length < destBytes.length + header.bytes.length + footer.bytes.length + 4000, `${stamped.bytes.length} bytes vs ${destBytes.length} + ${header.bytes.length} + ${footer.bytes.length} (one band: ${sizeOne})`);

// ---------- request filter + HTML wrapper ----------
const tmp = path.join(REPO, 'tmp-pdf-export-test');
const filter = mod.makeRequestFilter(tmp);
const decide = (url) => new Promise((resolve) => filter({ url }, (r) => resolve(!r.cancel)));
check('file:// inside the temp dir is allowed', await decide(`file://${tmp}/document.html`));
check('file:// outside the temp dir is cancelled', !(await decide(`file://${REPO}/package.json`)));
check('a sibling directory with the same prefix is cancelled', !(await decide(`file://${tmp}-other/x.html`)));
check('http(s) is cancelled', !(await decide('https://example.com/x')) && !(await decide('http://127.0.0.1:8080/health')));
check('the app dev server is cancelled too', !(await decide('http://localhost:5173/')));
const html = mod.buildHtmlDocument({ title: '<script>alert(1)</script>', css: 'body{}', bodyHtml: '<p>ok</p>' });
check('the title is HTML-escaped in the wrapper', html.includes('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>') && !html.includes('<script>'));
check('the wrapper carries a no-network CSP and the print stylesheet', /Content-Security-Policy/.test(html) && /default-src 'none'/.test(html) && html.includes('break-after: page'));
const band = mod.buildBandDocument({ css: 'body{}', bandHtml: '<div class="pdf-header">H</div>', widthPx: 708 });
check('band documents wrap the band in the measured-width band container', band.includes('class="markdown-preview pdf-export-root pdf-margin-band" style="width: 708px"'));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
