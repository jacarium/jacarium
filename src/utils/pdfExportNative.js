/**
 * Documents PDF export through Electron's print engine (printToPDF in the
 * main process, electron/pdf-export.cjs). Used by useImportExport's
 * exportDocumentToPDF (desktop app only: without window.electronAPI.exportPdf
 * - the plain-browser dev server - the export is unavailable and says so).
 *
 * The renderer side prepares the document the way the preview shows it -
 * processInteractiveMarkdown, attachment images resolved to data: URLs,
 * Mermaid diagrams rendered to inline SVG (kept as vectors, not
 * rasterized), the [[header]]/[[footer]] bands lifted out of the flow - and
 * sends it with the app's stylesheet (every parsed rule serialized back to
 * text, @font-face sources fetched and inlined as data: URLs, since the
 * export window may read nothing but its own temp directory). Page setup,
 * page breaks, ToC numbers, bands and page numbers are the main process's
 * job.
 */
import { downloadBlob } from './exportHelpers';
import { BUNDLED_FONT_CSS, isBundledFamily, describeBundledFonts } from './bundledFonts';

export function isNativePdfExportAvailable() {
  return typeof window !== 'undefined' && typeof window.electronAPI?.exportPdf === 'function';
}

/** Page sizes the export offers (points, portrait); mirrors electron/pdf-export.cjs. */
export const PDF_PAGE_SIZES = {
  A4: { label: 'A4', widthPt: 595.92, heightPt: 842.88 },
  Letter: { label: 'US Letter', widthPt: 612, heightPt: 792 },
  Legal: { label: 'US Legal', widthPt: 612, heightPt: 1008 },
};
export const PDF_MARGIN_PT = 32;
const PT_PER_PX = 0.75;
export const PDF_OPTIONS_STORAGE_KEY = 'pdfExportOptions';
export const DEFAULT_PDF_OPTIONS = { pageSize: 'A4', landscape: false };

/** Normalize export options (unknown values fall back to A4 portrait). */
export function normalizePdfOptions(options) {
  const pageSize = Object.prototype.hasOwnProperty.call(PDF_PAGE_SIZES, options?.pageSize) ? options.pageSize : 'A4';
  return { pageSize, landscape: options?.landscape === true };
}

/** The last options the user chose (per-browser-profile convenience), or the defaults. */
export function loadPdfOptions() {
  try {
    return normalizePdfOptions(JSON.parse(localStorage.getItem(PDF_OPTIONS_STORAGE_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_PDF_OPTIONS };
  }
}

export function savePdfOptions(options) {
  try {
    localStorage.setItem(PDF_OPTIONS_STORAGE_KEY, JSON.stringify(normalizePdfOptions(options)));
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

/** Width of the page's text column in CSS px for the chosen page/orientation. */
export function pdfContentWidthPx({ pageSize, landscape }) {
  const size = PDF_PAGE_SIZES[pageSize] || PDF_PAGE_SIZES.A4;
  const widthPt = landscape ? size.heightPt : size.widthPt;
  return Math.floor((widthPt - 2 * PDF_MARGIN_PT) / PT_PER_PX);
}

const MAX_IMG_WIDTH = 1600;

/**
 * Re-encode every non-JPEG raster image to JPEG (q 0.85, at most 1600px
 * wide, flattened on white) and freeze its rendered size, so exported files
 * stay small whatever the source images were.
 */
export async function reencodeImagesAsJpeg(container, report) {
  const images = Array.from(container.querySelectorAll('img'));
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    report({ current: i + 1, total: images.length });
    const src = img.currentSrc || img.src || '';
    if (!img.complete || !img.naturalWidth || /^data:image\/jpe?g/i.test(src)) continue;
    try {
      const rect = img.getBoundingClientRect();
      const scaleDown = Math.min(1, MAX_IMG_WIDTH / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scaleDown));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scaleDown));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const jpegUrl = canvas.toDataURL('image/jpeg', 0.85);
      img.style.width = `${rect.width}px`;
      img.style.height = `${rect.height}px`;
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        img.src = jpegUrl;
      });
    } catch {
      // Tainted canvas or decode failure - keep the original image
    }
  }
}

const waitForImages = (container) => Promise.all(
  Array.from(container.querySelectorAll('img')).map((img) => (img.complete
    ? Promise.resolve()
    : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))),
);

const fontDataUrlCache = new Map();

/**
 * The URL a @font-face url() source really points at: as the stylesheet
 * wrote it, resolved against THE STYLESHEET - not against the document, which
 * is what fetch(url) does with a relative string. The difference is the
 * whole bug this guards: the built stylesheet lives in dist/assets/ and says
 * url(./red-hat-text-...woff2), the document is dist/index.html, so the
 * packaged app's fetch looked one directory too high, found nothing, and
 * the export silently printed in the OS fallback font (Helvetica on macOS).
 * In dev the sources are absolute and nothing changes.
 */
export function resolveFontSourceUrl(url, sheetHref, baseURI) {
  if (/^(data|blob):/i.test(url)) return url;
  try {
    return new URL(url, sheetHref || baseURI || undefined).href;
  } catch {
    return url;
  }
}

/**
 * Turn one @font-face rule into the same rule with every url() source
 * fetched (same origin: the Vite dev server or the packaged file://
 * bundle; the url resolved against the rule's stylesheet) and inlined as a
 * data: URL, so the export window - which may only read its own temp
 * directory - can use the font. Returns '' when no source could be fetched
 * (the rule is then left out and the fallback font applies). The app's own
 * bundled families never come through here (collectExportStyles uses their
 * build-time data: URLs); this serves any other @font-face the page has.
 */
export async function inlineFontFace(rule, baseURI = typeof document !== 'undefined' ? document.baseURI : undefined) {
  const src = rule.style.getPropertyValue('src');
  const urls = [...src.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]);
  if (!urls.length) return '';
  let inlined = src;
  for (const url of urls) {
    if (/^data:/i.test(url)) continue;
    const resolved = resolveFontSourceUrl(url, rule.parentStyleSheet && rule.parentStyleSheet.href, baseURI);
    let dataUrl = fontDataUrlCache.get(resolved);
    if (!dataUrl) {
      try {
        const res = await fetch(resolved);
        if (!res.ok) return '';
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        fontDataUrlCache.set(resolved, dataUrl);
      } catch {
        return '';
      }
    }
    inlined = inlined.split(url).join(dataUrl);
  }
  const decl = (name) => { const v = rule.style.getPropertyValue(name); return v ? `${name}: ${v};` : ''; };
  return `@font-face { ${decl('font-family')} ${decl('font-style')} ${decl('font-weight')} ${decl('font-display')} ${decl('unicode-range')} src: ${inlined}; }`;
}

/**
 * The app's stylesheet for the export document: every already-parsed rule
 * serialized back to text (so nothing needs fetching - same approach as
 * the Diagnostics frames), the app's bundled fonts (Red Hat Text, Red Hat
 * Mono, Sora) as the build-time data: URLs of src/utils/bundledFonts.js -
 * so the export embeds exactly those faces on every OS, whatever the app's
 * origin - and any other @font-face the page has with its sources fetched
 * and inlined. Returns { css, fonts } with what was embedded, for the
 * export log; collectExportStyles() returns the css alone.
 */
export async function collectExportStylesWithFonts(doc = document) {
  const rules = [];
  const otherFaces = [];
  let bundledFaces = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let list;
    try { list = Array.from(sheet.cssRules); } catch { continue; } // cross-origin sheet
    for (const rule of list) {
      if (rule.type === 5 || /^\s*@font-face\b/i.test(rule.cssText || '')) {
        if (isBundledFamily(rule.style && rule.style.getPropertyValue('font-family'))) bundledFaces += 1;
        else otherFaces.push(rule);
      } else {
        rules.push(rule.cssText);
      }
    }
  }
  const inlined = await Promise.all(otherFaces.map((rule) => inlineFontFace(rule, doc.baseURI).catch(() => '')));
  const others = inlined.filter(Boolean);
  const fonts = {
    bundled: describeBundledFonts(),
    bundledFacesReplaced: bundledFaces,
    otherInlined: others.length,
    otherDropped: otherFaces.length - others.length,
  };
  return { css: `${rules.join('\n')}\n${BUNDLED_FONT_CSS}\n${others.join('\n')}`, fonts };
}

export async function collectExportStyles(doc = document) {
  return (await collectExportStylesWithFonts(doc)).css;
}

/**
 * Lift the first [[header]] / [[footer]] block out of the flow (extras are
 * dropped: only one band of each kind is stamped) and return its HTML.
 */
function extractBand(container, selector) {
  const els = container.querySelectorAll(selector);
  if (!els.length) return null;
  const first = els[0];
  for (let i = 1; i < els.length; i++) els[i].remove();
  first.remove();
  return first.outerHTML;
}

/**
 * @param {object} doc - the document (fresh from the database)
 * @param {object} options
 * @param {(update: object) => void} options.report - progress reporter (see useImportExport's makeReporter)
 * @param {string} options.filename - download name
 * @param {AbortSignal} [options.signal] - cancel: aborts the main-process job and rejects with an AbortError
 * @param {'A4'|'Letter'|'Legal'} [options.pageSize] - page size (default A4)
 * @param {boolean} [options.landscape] - orientation (default portrait)
 * @returns {Promise<{ pages: number, bytes: number }>}
 */
export async function exportDocumentToPDFNative(doc, { report, filename, signal = null, pageSize, landscape } = {}) {
  const STEPS = 5;
  const page = normalizePdfOptions({ pageSize, landscape });
  // Lay the document out at the exact width the print page gives the text
  // column, so Mermaid's measurements and image sizes match the print pass
  const contentWidthPx = pdfContentWidthPx(page);
  const abortError = () => {
    const err = new Error('PDF export cancelled');
    err.name = 'AbortError';
    return err;
  };
  if (signal?.aborted) throw abortError();

  const { processInteractiveMarkdown, resolveAttachmentImages } = await import('./interactiveMarkdown');
  const { renderMermaidDiagrams } = await import('./mermaidDiagrams');

  report({ step: 1, steps: STEPS, label: 'Rendering preview', indeterminate: true });
  // Off-screen, attached to the document: Mermaid measures labels and images
  // need layout. Same width the print page gives the text column.
  const shell = document.createElement('div');
  shell.style.cssText = `position: fixed; left: -10000px; top: 0; width: ${contentWidthPx}px;`;
  const container = document.createElement('div');
  container.className = 'markdown-preview pdf-export-root';
  container.style.cssText = `box-sizing: border-box; width: ${contentWidthPx}px; background-color: #ffffff;`;
  container.innerHTML = processInteractiveMarkdown(doc.content || '');
  // a folded callout (> [!NOTE]-) prints open: nothing of the document is hidden on paper
  for (const folded of container.querySelectorAll('details.md-callout')) folded.open = true;
  shell.appendChild(container);
  document.body.appendChild(shell);

  let unsubscribe = null;
  try {
    report({ step: 2, steps: STEPS, label: 'Loading images', indeterminate: true });
    await resolveAttachmentImages(container);
    if (signal?.aborted) throw abortError();

    report({ step: 2, steps: STEPS, label: 'Rendering diagrams', indeterminate: true });
    // Light theme, whatever the app is in: the PDF is dark-on-white
    // the diagrams' labels in the reading font, which the export embeds, so a
    // diagram reads the same on every OS (Mermaid's default stack is Trebuchet
    // MS, which macOS has and Linux has not)
    await renderMermaidDiagrams(container, { theme: 'default', fontFamily: '"Red Hat Text", "trebuchet ms", verdana, arial, sans-serif', signal: signal || undefined });
    await waitForImages(container);
    if (signal?.aborted) throw abortError();

    const images = container.querySelectorAll('img').length;
    if (images > 0) report({ step: 2, steps: STEPS, label: 'Optimizing images', current: 0, total: images });
    await reencodeImagesAsJpeg(container, (u) => report({ step: 2, steps: STEPS, label: 'Optimizing images', ...u }));
    if (signal?.aborted) throw abortError();

    // Directive markers: the print stylesheet turns them into breaks; the
    // blank page carries the conventional notice
    for (const marker of container.querySelectorAll('[data-pdf-directive]')) {
      const kind = marker.getAttribute('data-pdf-directive');
      marker.textContent = kind === 'blankpage' ? 'This page is intentionally left blank' : '';
    }
    const headerHtml = extractBand(container, '.pdf-header');
    const footerHtml = extractBand(container, '.pdf-footer');
    const hasToc = !!container.querySelector('.pdf-toc li a[href^="#"]');

    const jobId = (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const styles = await collectExportStylesWithFonts(document);
    report({ step: 3, steps: STEPS, label: 'Laying out pages', indeterminate: true, log: `Fonts embedded from the app's bundle: ${styles.fonts.bundled}${styles.fonts.otherInlined ? `; ${styles.fonts.otherInlined} other face(s) inlined` : ''}${styles.fonts.otherDropped ? `; ${styles.fonts.otherDropped} other face(s) could not be read and fall back` : ''}` });
    const payload = {
      jobId,
      title: doc.title || 'Untitled',
      css: styles.css,
      bodyHtml: container.outerHTML,
      headerHtml,
      footerHtml,
      hasToc,
      pageSize: page.pageSize,
      landscape: page.landscape,
    };

    const phaseStep = { layout: 3, render: 3, toc: 4, stamp: 5 };
    unsubscribe = window.electronAPI.onExportPdfProgress((update) => {
      if (update?.jobId !== jobId) return;
      const { phase, ...rest } = update;
      report({ step: phaseStep[phase] || 3, steps: STEPS, ...rest });
    });
    const onAbort = () => { window.electronAPI.cancelExportPdf(jobId); };
    signal?.addEventListener('abort', onAbort, { once: true });

    report({ step: 3, steps: STEPS, label: 'Laying out pages', indeterminate: true, log: `Handing ${Math.round(payload.bodyHtml.length / 1024)} KB of content to the print engine (${PDF_PAGE_SIZES[page.pageSize].label}, ${page.landscape ? 'landscape' : 'portrait'})` });
    let result;
    try {
      result = await window.electronAPI.exportPdf(payload);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (!result || !result.ok) {
      if (result?.cancelled || signal?.aborted) throw abortError();
      throw new Error(result?.error || 'PDF export failed');
    }

    report({ step: 5, steps: STEPS, label: 'Saving file', indeterminate: true, log: `Rendered ${result.pages} page${result.pages === 1 ? '' : 's'}${result.bandsUsable === false ? ' (header/footer skipped: too tall for the page)' : ''}` });
    const bytes = result.pdf instanceof Uint8Array ? result.pdf : new Uint8Array(result.pdf);
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    report({ step: STEPS, steps: STEPS, label: 'Saved', percent: 100, log: `Saved ${filename}`, logType: 'success' });
    return { pages: result.pages, bytes: bytes.length };
  } finally {
    if (unsubscribe) unsubscribe();
    shell.remove();
  }
}
