// Documents PDF export through Chromium's own print engine
// (webContents.printToPDF). The renderer prepares the document; this module
// prints it. Desktop app only (see src/utils/pdfExportNative.js).
//
// The renderer prepares the document exactly as the preview renders it
// (markdown -> sanitized HTML, attachment images as data: URLs, Mermaid
// diagrams as inline SVG) plus the app's stylesheet, and hands it over the
// 'export-pdf' IPC channel. This module:
//
//   1. writes it to a private temp directory and loads it in a HIDDEN
//      BrowserWindow that can do nothing else: sandboxed, no preload, no
//      node integration, an in-memory session whose only permitted
//      requests are file:// reads of that temp directory (everything else -
//      http(s), the app's own backend, other files - is cancelled), the
//      shared navigation guards, every permission request refused;
//   2. measures the [[header]]/[[footer]] bands (if any) in that window to
//      size the page margins, then prints the body with printToPDF
//      (A4, printBackground, tagged + document outline);
//   3. [[toc]]: resolves every entry's target page from the PDF's own
//      named destinations (/Dests - Chromium emits one per link target with
//      an id), writes the numbers into the DOM and prints again (CSS
//      target-counter() is not supported by Chromium);
//   4. prints each band as its own small vector PDF page and, with pdf-lib,
//      draws it onto every page (embedded once) together with the automatic
//      page number, with the export's geometry rules:
//      bottom-centre, or the right corner beside a footer band, and bands
//      too tall to leave 200pt of content are skipped;
//   5. returns the bytes to the renderer (which downloads them like every
//      other export) and removes the temp files and the window - on
//      success, on error and on cancel ('export-pdf-cancel').
//
// Progress is streamed back on 'export-pdf-progress' for the shared
// ExportProgressModal.
//
// Kept free of top-level Electron imports (the caller passes them in) so
// the geometry/validation helpers are unit-testable with plain Node.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { installNavigationGuards } = require('./navigation-guard.cjs');

// Page sizes in PostScript points (portrait) as Chromium's print engine
// defines them (its A4 is 8.2767 x 11.7067 in, not the ISO 595.28 x 841.89),
// and the export's geometry constants. The renderer picks
// pageSize/landscape (A4 portrait by default). The page box comes from
// printToPDF's pageSize/landscape options only: an @page { size } rule in
// the stylesheet would override the orientation even with
// preferCSSPageSize off.
const PAGE_SIZES = {
  A4: { widthPt: 595.92, heightPt: 842.88 },
  Letter: { widthPt: 612, heightPt: 792 },
  Legal: { widthPt: 612, heightPt: 1008 },
};
const PAGE_WIDTH_PT = PAGE_SIZES.A4.widthPt;
const PAGE_HEIGHT_PT = PAGE_SIZES.A4.heightPt;
const MARGIN_PT = 32; // left/right, and the base top/bottom margin
const BAND_EDGE_PT = 18; // band offset from the page's top/bottom edge
const BAND_GAP_PT = 14; // breathing room between a band and the body
const PAGE_NUMBER_RESERVE_PT = 40; // right-corner strip beside a footer band
const MIN_CONTENT_PT = 200; // below this, bands are skipped
const PT_PER_PX = 0.75; // CSS px -> pt at 96 dpi (printToPDF scale 1)

const LIMITS = {
  html: 64 * 1024 * 1024,
  css: 16 * 1024 * 1024,
  band: 8 * 1024 * 1024,
  title: 300,
};
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Print stylesheet appended after the app's own CSS. Everything the old
 * exporter did with spacer divs and measured pushes is a fragmentation
 * rule here. --pdf-page-h (the page's content height in CSS px) is set on
 * <html> by the job once the margins are known.
 */
const PRINT_CSS = `
html, body { margin: 0; padding: 0; background: #ffffff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-export-root { padding: 0; width: auto; background: #ffffff; }
/* Code: never clip a line at the box edge (the preview hides overflow); wrap it */
.pdf-export-root pre { overflow: visible !important; white-space: pre-wrap; word-break: break-word; }
.pdf-export-root table { overflow: visible !important; }
.pdf-export-root .mermaid-diagram svg { max-width: 100%; height: auto; }
/* Atomic blocks: pushed whole onto the next page rather than split */
.pdf-export-root p, .pdf-export-root li, .pdf-export-root pre, .pdf-export-root hr,
.pdf-export-root table, .pdf-export-root img, .pdf-export-root .mermaid-diagram,
.pdf-export-root blockquote { break-inside: avoid; }
.pdf-export-root tr { break-inside: avoid; }
.pdf-export-root h1, .pdf-export-root h2, .pdf-export-root h3,
.pdf-export-root h4, .pdf-export-root h5, .pdf-export-root h6 { break-inside: avoid; break-after: avoid; }
/* [[pagebreak]] / [[blankpage]] markers: no preview chrome (dashed rule + label), just the break */
.pdf-export-root [data-pdf-directive] { display: block; visibility: hidden; height: 0; margin: 0; padding: 0; border: none; font-size: 0; line-height: 0; }
.markdown-preview.pdf-export-root [data-pdf-directive]::before,
.markdown-preview.pdf-export-root [data-pdf-directive]::after { content: none; display: none; border: none; }
.pdf-export-root [data-pdf-directive="pagebreak"] { break-after: page; }
.pdf-export-root [data-pdf-directive="blankpage"] {
  break-before: page; break-after: page; break-inside: avoid; visibility: visible;
  height: calc(var(--pdf-page-h) - 2px); display: flex; align-items: center; justify-content: center;
  font-style: italic; font-size: 14px; line-height: 1.4; color: #9ca3af;
}
/* [[centerpage]]: a page of its own, content vertically centred; taller content just flows */
.pdf-export-root .pdf-centerpage {
  break-before: page; break-after: page; break-inside: avoid; box-sizing: border-box;
  min-height: calc(var(--pdf-page-h) - 2px); display: flex; flex-direction: column; justify-content: center;
  text-align: center; margin: 0; padding: 0; border: none; border-radius: 0;
}
.pdf-export-root .pdf-centerpage::before { content: none; }
/* [[toc]]: indentation only, page numbers right-aligned on the entry line */
.pdf-export-root .pdf-toc ul, .pdf-export-root .pdf-toc ol { list-style: none; }
.pdf-export-root .pdf-toc > ul, .pdf-export-root .pdf-toc > ol { padding-left: 0; }
.pdf-export-root .pdf-toc-page { float: right; color: #57606a; }
/* Band documents: same text column as the body (both start at the page margin), no preview box chrome */
.pdf-margin-band { box-sizing: border-box; padding: 0; overflow: hidden; background: #ffffff; }
.pdf-margin-band .pdf-header, .pdf-margin-band .pdf-footer { margin: 0; padding: 0; border: none; border-radius: 0; }
.pdf-margin-band .pdf-header::before, .pdf-margin-band .pdf-footer::before { content: none; }
`;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildHtmlDocument({ title, css, bodyHtml }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>${PRINT_CSS}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function buildBandDocument({ css, bandHtml, widthPx }) {
  return buildHtmlDocument({
    title: 'band',
    css,
    bodyHtml: `<div class="markdown-preview pdf-export-root pdf-margin-band" style="width: ${widthPx}px">${bandHtml}</div>`,
  });
}

class PayloadError extends Error {}

/** Validate the renderer's payload; only plain strings/booleans within size limits get through. */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new PayloadError('export-pdf: payload must be an object');
  const str = (key, limit, required) => {
    const v = payload[key];
    if (v == null || v === '') {
      if (required) throw new PayloadError(`export-pdf: ${key} is required`);
      return null;
    }
    if (typeof v !== 'string') throw new PayloadError(`export-pdf: ${key} must be a string`);
    if (v.length > limit) throw new PayloadError(`export-pdf: ${key} exceeds ${limit} characters`);
    return v;
  };
  const jobId = str('jobId', 64, true);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) throw new PayloadError('export-pdf: malformed jobId');
  const pageSize = payload.pageSize == null ? 'A4' : payload.pageSize;
  if (typeof pageSize !== 'string' || !Object.prototype.hasOwnProperty.call(PAGE_SIZES, pageSize)) throw new PayloadError(`export-pdf: unknown pageSize (${Object.keys(PAGE_SIZES).join(', ')})`);
  if (payload.landscape != null && typeof payload.landscape !== 'boolean') throw new PayloadError('export-pdf: landscape must be a boolean');
  return {
    jobId,
    title: str('title', LIMITS.title, false) || 'Untitled',
    css: str('css', LIMITS.css, true),
    bodyHtml: str('bodyHtml', LIMITS.html, true),
    headerHtml: str('headerHtml', LIMITS.band, false),
    footerHtml: str('footerHtml', LIMITS.band, false),
    hasToc: payload.hasToc === true,
    pageSize,
    landscape: payload.landscape === true,
  };
}

/** Page box in points for a size name + orientation. */
function pageDimensions({ pageSize = 'A4', landscape = false } = {}) {
  const size = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
  return landscape ? { widthPt: size.heightPt, heightPt: size.widthPt } : { ...size };
}

/**
 * Page margins from the measured band heights (pt), with the
 * exporter's rule: bands that would leave less than MIN_CONTENT_PT of body
 * are dropped and the base margins apply.
 */
function computeMargins({ headerBandPt = 0, footerBandPt = 0, pageHeightPt = PAGE_HEIGHT_PT }) {
  let top = headerBandPt > 0 ? BAND_EDGE_PT + headerBandPt + BAND_GAP_PT : MARGIN_PT;
  let bottom = footerBandPt > 0 ? BAND_EDGE_PT + footerBandPt + BAND_GAP_PT : MARGIN_PT;
  let bandsUsable = pageHeightPt - top - bottom >= MIN_CONTENT_PT;
  if (!bandsUsable) { top = MARGIN_PT; bottom = MARGIN_PT; }
  return { top, bottom, left: MARGIN_PT, right: MARGIN_PT, bandsUsable };
}

/** Named destinations of a Chromium-generated PDF: anchor id -> 1-based page. */
async function readNamedDestinations(pdfLib, pdfBytes) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = pdfLib;
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const pages = doc.getPages();
  const pageIndexOf = (ref) => (ref instanceof PDFRef
    ? pages.findIndex((p) => p.ref.objectNumber === ref.objectNumber && p.ref.generationNumber === ref.generationNumber)
    : -1);
  const out = {};
  const record = (key, value) => {
    const arr = value instanceof PDFDict ? value.lookup(PDFName.of('D')) : value;
    if (!(arr instanceof PDFArray) || arr.size() === 0) return;
    const index = pageIndexOf(arr.get(0));
    if (index >= 0) out[key] = index + 1;
  };
  // Classic /Dests dictionary (what Chromium writes)
  const dests = doc.catalog.lookup(PDFName.of('Dests'));
  if (dests instanceof PDFDict) {
    for (const [key] of dests.entries()) record(key.decodeText ? key.decodeText() : String(key).replace(/^\//, ''), dests.lookup(key));
  }
  // Name tree (/Names /Dests), for completeness
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const tree = names instanceof PDFDict ? names.lookup(PDFName.of('Dests')) : null;
  const walk = (node) => {
    if (!(node instanceof PDFDict)) return;
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i));
    const arr = node.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const k = arr.lookup(i);
        const key = (k instanceof PDFString || k instanceof PDFHexString) ? k.decodeText() : String(k);
        record(key, arr.lookup(i + 1));
      }
    }
  };
  walk(tree);
  return out;
}

/**
 * Draw the band pages and the page number onto every page of the body PDF.
 * Bands are embedded once (an XObject) and referenced from each page.
 */
async function stampPages(pdfLib, bodyBytes, { headerBand, footerBand, margins }) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.load(bodyBytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const embed = async (band) => (band ? (await doc.embedPdf(band.bytes, [0]))[0] : null);
  const header = margins.bandsUsable ? await embed(headerBand) : null;
  const footer = margins.bandsUsable ? await embed(footerBand) : null;
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    if (header) {
      page.drawPage(header, { x: margins.left, y: height - BAND_EDGE_PT - headerBand.heightPt, width: headerBand.widthPt, height: headerBand.heightPt });
    }
    if (footer) {
      page.drawPage(footer, { x: margins.left, y: BAND_EDGE_PT, width: footerBand.widthPt, height: footerBand.heightPt });
    }
    // Automatic page number: bottom-centre, or the right corner beside a footer band
    const label = `${i + 1} / ${total}`;
    const size = 9;
    const textWidth = font.widthOfTextAtSize(label, size);
    const color = rgb(140 / 255, 140 / 255, 140 / 255);
    if (footer) {
      page.drawText(label, { x: width - margins.right - textWidth, y: BAND_EDGE_PT + footerBand.heightPt / 2 - 3, size, font, color });
    } else {
      page.drawText(label, { x: (width - textWidth) / 2, y: 18, size, font, color });
    }
  });
  return { bytes: await doc.save(), pages: total };
}

/** Allow only file:// reads inside `dir`; everything else is cancelled. */
function makeRequestFilter(dir) {
  const root = pathToFileURL(dir + path.sep).href;
  return (details, callback) => {
    callback({ cancel: !(typeof details.url === 'string' && details.url.startsWith(root)) });
  };
}

/**
 * Wire the IPC handlers. `electron` is the module (or a test double with
 * the same members): ipcMain, BrowserWindow, session, app.
 */
function installPdfExport(electron, { log = () => {} } = {}) {
  const { ipcMain, BrowserWindow, session, app } = electron;
  const jobs = new Map(); // jobId -> { cancelled, win, sender }

  const pdfLibPromise = () => import('pdf-lib');

  ipcMain.handle('export-pdf', async (event, rawPayload) => {
    let payload;
    try {
      payload = validatePayload(rawPayload);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const { jobId } = payload;
    if (jobs.has(jobId)) return { ok: false, error: 'export-pdf: duplicate jobId' };
    for (const other of jobs.values()) {
      if (other.sender === event.sender) return { ok: false, error: 'A PDF export is already running' };
    }
    const job = { cancelled: false, win: null, sender: event.sender };
    jobs.set(jobId, job);

    const progress = (update) => {
      if (job.cancelled || event.sender.isDestroyed()) return;
      event.sender.send('export-pdf-progress', { jobId, ...update });
    };
    const checkCancelled = () => {
      if (job.cancelled) {
        const err = new Error('PDF export cancelled');
        err.cancelled = true;
        throw err;
      }
    };

    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'jacarium-pdf-'));
    const partition = `pdf-export-${jobId}`; // no "persist:" prefix: in-memory, gone with the window
    let timer = null;
    try {
      const result = await Promise.race([
        runJob(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF export timed out')), JOB_TIMEOUT_MS); }),
      ]);
      return { ok: true, ...result };
    } catch (e) {
      if (job.cancelled || e?.cancelled) return { ok: false, cancelled: true };
      log(`[pdf-export] failed: ${e?.stack || e}`);
      return { ok: false, error: e?.message || String(e) };
    } finally {
      if (timer) clearTimeout(timer);
      jobs.delete(jobId);
      try { if (job.win && !job.win.isDestroyed()) job.win.destroy(); } catch { /* gone */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    async function runJob() {
      const pdfLib = await pdfLibPromise();
      const ses = session.fromPartition(partition);
      ses.webRequest.onBeforeRequest(makeRequestFilter(tmpDir));
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);

      const docFile = path.join(tmpDir, 'document.html');
      const headerFile = payload.headerHtml ? path.join(tmpDir, 'header.html') : null;
      const footerFile = payload.footerHtml ? path.join(tmpDir, 'footer.html') : null;
      const page = pageDimensions(payload);
      const contentWidthPt = page.widthPt - 2 * MARGIN_PT;
      const bandWidthPx = (reservePt) => Math.floor((contentWidthPt - reservePt) / PT_PER_PX);
      fs.writeFileSync(docFile, buildHtmlDocument(payload));
      if (headerFile) fs.writeFileSync(headerFile, buildBandDocument({ css: payload.css, bandHtml: payload.headerHtml, widthPx: bandWidthPx(0) }));
      if (footerFile) fs.writeFileSync(footerFile, buildBandDocument({ css: payload.css, bandHtml: payload.footerHtml, widthPx: bandWidthPx(PAGE_NUMBER_RESERVE_PT) }));

      const win = new BrowserWindow({
        show: false,
        width: 794,
        height: 1123,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
      job.win = win;
      installNavigationGuards(win.webContents, {
        appEntryUrl: pathToFileURL(docFile).href,
        openExternal: async () => {}, // nothing leaves the export window
        log,
      });
      win.webContents.on('will-attach-webview', (e) => e.preventDefault());

      const load = async (file) => {
        checkCancelled();
        await win.loadFile(file);
        // Fonts (data: @font-face) and images (data: URLs) must be in before printing
        await win.webContents.executeJavaScript(`Promise.all([
          document.fonts ? document.fonts.ready : Promise.resolve(),
          ...Array.from(document.images).map((img) => img.decode().catch(() => {})),
        ]).then(() => true)`, true);
        checkCancelled();
      };

      // 1. Bands: measure each, then print it as its own vector page sized
      // to the band. The page size goes in as an @page rule
      // (preferCSSPageSize): Chromium's print compositor rejects small
      // custom sizes passed through printToPDF's pageSize object
      // ("Page reading failed").
      progress({ phase: 'layout', label: 'Laying out pages', indeterminate: true });
      const bands = {};
      for (const [key, file, reservePt] of [['header', headerFile, 0], ['footer', footerFile, PAGE_NUMBER_RESERVE_PT]]) {
        if (!file) continue;
        await load(file);
        const heightPx = await win.webContents.executeJavaScript(`document.querySelector('.pdf-margin-band').getBoundingClientRect().height`, true);
        const heightPt = Math.ceil(Number(heightPx) * PT_PER_PX);
        if (!(heightPt > 0)) continue;
        const widthPt = contentWidthPt - reservePt;
        await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = '@page { size: ${widthPt.toFixed(2)}pt ${heightPt}pt; margin: 0; }'; document.head.appendChild(s); return true; })()`, true);
        const bytes = await win.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        });
        checkCancelled();
        bands[key] = { widthPt, heightPt, bytes };
      }
      const margins = computeMargins({ headerBandPt: bands.header?.heightPt || 0, footerBandPt: bands.footer?.heightPt || 0, pageHeightPt: page.heightPt });

      // 2. Body
      await load(docFile);
      const pageContentHeightPx = (page.heightPt - margins.top - margins.bottom) / PT_PER_PX;
      await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--pdf-page-h', '${pageContentHeightPx.toFixed(2)}px'); true`, true);
      const printOptions = {
        printBackground: true,
        preferCSSPageSize: false,
        pageSize: payload.pageSize,
        landscape: payload.landscape,
        margins: { top: margins.top / 72, bottom: margins.bottom / 72, left: margins.left / 72, right: margins.right / 72 },
        generateTaggedPDF: true,
        generateDocumentOutline: true,
      };
      progress({ phase: 'render', label: 'Rendering pages', indeterminate: true });
      let bodyBytes = await win.webContents.printToPDF(printOptions);
      checkCancelled();

      // 3. [[toc]] page numbers: second pass with the numbers in the DOM
      if (payload.hasToc) {
        progress({ phase: 'toc', label: 'Numbering the table of contents', indeterminate: true });
        const dests = await readNamedDestinations(pdfLib, bodyBytes);
        await win.webContents.executeJavaScript(`(() => {
          const pages = ${JSON.stringify(dests)};
          let n = 0;
          for (const li of document.querySelectorAll('.pdf-toc li')) {
            const a = li.querySelector('a[href^="#"]');
            if (!a || a.closest('li') !== li) continue;
            let id = a.getAttribute('href').slice(1);
            try { id = decodeURIComponent(id); } catch {}
            const page = pages[id];
            if (!page) continue;
            const span = document.createElement('span');
            span.className = 'pdf-toc-page';
            span.textContent = String(page);
            // Right after the anchor, so the float sits on the entry's own
            // line - not after a nested list the li may also contain
            a.insertAdjacentElement('afterend', span);
            n++;
          }
          return n;
        })()`, true);
        checkCancelled();
        bodyBytes = await win.webContents.printToPDF(printOptions);
        checkCancelled();
      }

      // 4. Bands + page numbers
      progress({ phase: 'stamp', label: 'Finishing pages', indeterminate: true });
      const stamped = await stampPages(pdfLib, bodyBytes, { headerBand: bands.header?.bytes ? bands.header : null, footerBand: bands.footer?.bytes ? bands.footer : null, margins });
      checkCancelled();
      return { pdf: Buffer.from(stamped.bytes), pages: stamped.pages, bandsUsable: margins.bandsUsable };
    }
  });

  ipcMain.handle('export-pdf-cancel', async (event, jobId) => {
    const job = typeof jobId === 'string' ? jobs.get(jobId) : null;
    if (!job || job.sender !== event.sender) return false;
    job.cancelled = true;
    try { if (job.win && !job.win.isDestroyed()) job.win.destroy(); } catch { /* gone */ }
    return true;
  });

  return { jobs };
}

module.exports = {
  installPdfExport,
  validatePayload,
  pageDimensions,
  PAGE_SIZES,
  computeMargins,
  readNamedDestinations,
  stampPages,
  buildHtmlDocument,
  buildBandDocument,
  makeRequestFilter,
  PRINT_CSS,
  PAGE_WIDTH_PT,
  PAGE_HEIGHT_PT,
  MARGIN_PT,
  BAND_EDGE_PT,
  BAND_GAP_PT,
  PAGE_NUMBER_RESERVE_PT,
  MIN_CONTENT_PT,
};
