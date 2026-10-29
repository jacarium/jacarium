/**
 * PDF inspection for tests, on pdfjs-dist (devDependency): page count,
 * text per page, link annotations (URI / internal destination), named
 * destinations resolved to pages, document outline, and the number of
 * image / vector-path paint operations per page. Works for both exporters
 * (Chromium's subset-font output; it also read the old jsPDF output), unlike
 * the WinAnsi-only text-run parser the jsPDF exporter's tests used.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<{
 *   pages: number,
 *   pageTexts: string[],            // 1 entry per page, whitespace-normalized
 *   links: Array<{ page: number, url?: string, dest?: string }>,
 *   dests: Record<string, number>,  // named destination -> 1-based page
 *   outline: Array<{ title: string, items: number }>,
 *   paints: Array<{ page: number, images: number, paths: number }>,
 * }>}
 */
export async function inspectPdf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pageTexts = [];
  const links = [];
  const paints = [];
  const pageSizes = [];
  const destNames = new Set();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    pageSizes.push({ page: p, width: +vp.width.toFixed(2), height: +vp.height.toFixed(2) });
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    pageTexts.push(text);
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      if (a.url) links.push({ page: p, url: a.url });
      else if (typeof a.dest === 'string') { links.push({ page: p, dest: a.dest }); destNames.add(a.dest); }
      else if (Array.isArray(a.dest)) {
        // Explicit destination: resolve its page
        let target = null;
        try { target = (await doc.getPageIndex(a.dest[0])) + 1; } catch { /* unresolved */ }
        links.push({ page: p, dest: target != null ? `page:${target}` : 'page:?' });
      }
    }
    const ops = await page.getOperatorList();
    let images = 0; let paths = 0;
    for (const fn of ops.fnArray) {
      if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintJpegXObject) images++;
      else if (fn === pdfjs.OPS.fill || fn === pdfjs.OPS.stroke || fn === pdfjs.OPS.eoFill || fn === pdfjs.OPS.fillStroke) paths++;
    }
    paints.push({ page: p, images, paths });
  }
  const dests = {};
  for (const name of destNames) {
    try {
      const d = await doc.getDestination(name);
      if (d) dests[name] = (await doc.getPageIndex(d[0])) + 1;
    } catch { /* dangling */ }
  }
  const rawOutline = await doc.getOutline();
  const outline = (rawOutline || []).map((o) => ({ title: o.title, items: o.items ? o.items.length : 0 }));
  await task.destroy();
  return { pages: doc.numPages, pageTexts, links, dests, outline, paints, pageSizes };
}

/** Text of page N (1-based) or '' */
export const pageText = (info, n) => info.pageTexts[n - 1] || '';

/** 1-based page on which `needle` first appears, or 0 */
export const pageOf = (info, needle) => info.pageTexts.findIndex((t) => t.includes(needle)) + 1;

/**
 * The fonts a PDF carries, from its font dictionaries (pdf-lib, like
 * `pdffonts`): [{ name, embedded, type }] - `name` without the subset
 * prefix (RedHatText-SemiBold, Helvetica), `embedded` true when a
 * descriptor carries a FontFile (a viewer substitutes the others), sorted
 * and unique. A Type0 font's descriptor sits under its descendant font.
 * @param {Buffer|Uint8Array} bytes
 */
export async function pdfFonts(bytes) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = await import('pdf-lib');
  const pdf = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, updateMetadata: false });
  const ctx = pdf.context;
  const deref = (obj) => (obj instanceof PDFRef ? ctx.lookup(obj) : obj);
  const fonts = new Map();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = obj.get(PDFName.of('Type'));
    if (!type || type.toString() !== '/Font') continue;
    const subtype = (obj.get(PDFName.of('Subtype')) || '').toString().replace(/^\//, '');
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;   // described through its Type0 parent
    const base = (obj.get(PDFName.of('BaseFont')) || '').toString().replace(/^\//, '');
    if (!base) continue;
    let descriptor = deref(obj.get(PDFName.of('FontDescriptor')));
    if (!descriptor && subtype === 'Type0') {
      const desc = deref(obj.get(PDFName.of('DescendantFonts')));
      const child = desc instanceof PDFArray ? deref(desc.get(0)) : null;
      descriptor = child instanceof PDFDict ? deref(child.get(PDFName.of('FontDescriptor'))) : null;
    }
    const embedded = !!(descriptor instanceof PDFDict && (descriptor.get(PDFName.of('FontFile')) || descriptor.get(PDFName.of('FontFile2')) || descriptor.get(PDFName.of('FontFile3'))));
    const name = base.replace(/^[A-Z]{6}\+/, '');
    const prev = fonts.get(name);
    fonts.set(name, { name, embedded: prev ? prev.embedded || embedded : embedded, type: subtype });
  }
  return Array.from(fonts.values()).sort((a, b) => a.name.localeCompare(b.name));
}
