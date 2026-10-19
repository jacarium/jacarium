#!/usr/bin/env node
/**
 * GitHub-style callouts in the REAL PDF export.
 *
 * The desktop export (src/utils/pdfExportNative.js) renders the document
 * with the same processInteractiveMarkdown as the preview, collects the
 * app's stylesheets, forces folded callouts open, and hands { css,
 * bodyHtml } to the Electron main process, which wraps them with its
 * PRINT_CSS (electron/pdf-export.cjs buildHtmlDocument) and prints with
 * Chromium's printToPDF (printBackground on). This test runs the renderer
 * half for real in the app (window.electronAPI.exportPdf is stubbed to
 * capture the payload - the only Electron-side piece) and prints the
 * captured document with the same Chromium through Playwright's page.pdf
 * with the same options; then it rasterises the pages with pdf.js and
 * reads the pixels:
 *   - each of the five types paints its tinted background and its left bar
 *     in the type's colour, and its icon + title in that colour too;
 *   - the custom title is in the text; the folded (-) callout prints OPEN,
 *     its body in the text; the list, the code block and the table inside a
 *     callout are in the text;
 *   - a short callout near a page end is not split (break-inside: avoid):
 *     one tinted run per callout, none cut at a page's bottom edge;
 *   - the app in the dark theme exports the same (light) colours: the
 *     printed document carries no dark class, the tokens resolve to light.
 * Writes the first page as /tmp/jacarium-callouts/pdf-page-1.png.
 *
 * SKIPs like tests/mobile-ui.test.mjs (no Chromium, no port, Vite down).
 * Run: node tests/markdown-callouts-pdf.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CALLOUTS_PDF_TEST_PORT || 5195);
const OUT = '/tmp/jacarium-callouts';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CALLOUTS_PDF_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
const { buildHtmlDocument, computeMargins, PAGE_SIZES } = req(path.join(REPO, 'electron', 'pdf-export.cjs'));
fs.mkdirSync(OUT, { recursive: true });

// the document: the five types, a custom title, a fold, nesting, then filler and a short callout near a page end
const filler = Array.from({ length: 28 }, (_, i) => `Paragraph ${i + 1}: filler text that fills the first page line after line so that the last callout lands near the page end.`).join('\n\n');
const MD = [
  '# Callouts on paper',
  '> [!NOTE]\n> A note with **bold** text.',
  '> [!TIP]\n> A tip.',
  '> [!IMPORTANT]\n> Important.',
  '> [!WARNING] Before you run it\n> Back up first.',
  '> [!CAUTION]\n> Caution.',
  '> [!NOTE]- Folded details\n> The folded body prints too.',
  '> [!TIP] Everything inside\n> - first item\n> - second item\n>\n> ```bash\n> echo callout-code\n> ```\n>\n> | col-a | col-b |\n> |---|---|\n> | cell-1 | cell-2 |',
  filler,
  '> [!CAUTION] Near the page end\n> This short callout must move whole to the next page rather than split.',
  'The end.',
].join('\n\n');

// the light tokens the printed document resolves (src/index.css :root); the tint is 10% of the colour over white
const LIGHT = { note: [0x00, 0x66, 0xcc], tip: [0x3e, 0x86, 0x35], important: [0xcf, 0x22, 0x2e], warning: [0x85, 0x4d, 0x0e], caution: [0xb9, 0x1c, 0x1c] };
const tintOf = (c) => c.map((v) => Math.round(255 * 0.9 + v * 0.1));
const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

async function exportThrough(page, dark) {
  await page.evaluate((isDark) => { document.documentElement.classList.toggle('dark', isDark); document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light'); }, dark);
  await page.waitForTimeout(300);
  return page.evaluate(async (md) => {
    const captured = {};
    window.electronAPI = {
      exportPdf: async (payload) => { captured.payload = payload; return { ok: true, path: '/dev/null', pages: 1 }; },
      cancelExportPdf: () => {},
      onExportPdfProgress: () => () => {},
    };
    const { exportDocumentToPDFNative } = await import('/src/utils/pdfExportNative.js');
    try { await exportDocumentToPDFNative({ title: 'Callouts', content: md }, { report: () => {}, filename: 'callouts.pdf', pageSize: 'A4', landscape: false }); } catch (e) { captured.error = String(e?.message || e); }
    const p = captured.payload || {};
    return { css: p.css, bodyHtml: p.bodyHtml, error: captured.error || null, pageSize: p.pageSize };
  }, MD).catch((e) => ({ error: String(e) }));
}

async function printAndRender(payload, label) {
  const page = await browser.newPage();
  await page.setContent(buildHtmlDocument({ title: 'Callouts', css: payload.css, bodyHtml: payload.bodyHtml }), { waitUntil: 'load' });
  const details = await page.evaluate(() => Array.from(document.querySelectorAll('details.md-callout')).map((d) => d.open));
  const margins = computeMargins({ pageHeightPt: PAGE_SIZES.A4.heightPt || 842 });
  const px = (pt) => `${(pt / 72) * 96}px`;
  const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: false, margin: { top: px(margins.top), bottom: px(margins.bottom), left: px(margins.left), right: px(margins.right) } });
  await page.close();
  fs.writeFileSync(path.join(OUT, `callouts-${label}.pdf`), pdf);
  // rasterise with pdf.js (@napi-rs/canvas, both already in node_modules)
  const pdfjs = await import(path.join(REPO, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'));
  const { createCanvas } = await import(path.join(REPO, 'node_modules', '@napi-rs', 'canvas', 'index.js'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const vp = p.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    await p.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    // the page's text: items joined with a space only across a gap or a line end (a font's
    // "fi"/"fl" ligature can split a word into two items), ligatures mapped back (NFKC),
    // whitespace collapsed - so "first" is "first" whatever the font did
    const items = (await p.getTextContent()).items;
    let raw = '';
    let prevEnd = null;
    for (const it of items) {
      const x = it.transform ? it.transform[4] : null;
      const gap = prevEnd != null && x != null ? x - prevEnd : 0;
      if (raw && (it.hasEOL || gap > 1.5)) raw += ' ';
      raw += it.str;
      if (it.hasEOL) { raw += ' '; prevEnd = null; } else prevEnd = x != null ? x + (it.width || 0) : null;
    }
    const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    pages.push({ n, width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, text, png: canvas.toBuffer('image/png'), marginBottomPx: margins.bottom / 72 * 96 * 2 });
  }
  return { pages, details };
}

// per page: for a colour, the pixels matching it (count, leftmost x, the rows that hold it)
function scan(page, colour, tol) {
  const { width, height, data } = page;
  let count = 0; let minX = Infinity; const rows = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (near([data[i], data[i + 1], data[i + 2]], colour, tol)) { count++; if (x < minX) minX = x; rows.add(y); }
    }
  }
  return { count, minX, rows };
}
const runsOf = (rows) => { const ys = [...rows].sort((a, b) => a - b); let runs = 0; let prev = -10; for (const y of ys) { if (y - prev > 3) runs++; prev = y; } return runs; };

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }

  const light = await exportThrough(page, false);
  check('the real export path renders the document and hands { css, bodyHtml } to the (stubbed) Electron side', !light.error && typeof light.css === 'string' && /md-callout/.test(light.bodyHtml || ''), light.error || Object.keys(light).join());
  const { pages, details } = await printAndRender(light, 'light');
  fs.writeFileSync(path.join(OUT, 'pdf-page-1.png'), pages[0].png);
  check('the folded callout is open in the printed document (the export forces details open)', details.length === 1 && details[0] === true, JSON.stringify(details));
  check(`the document prints on more than one page (${pages.length})`, pages.length >= 2);
  const first = pages[0];
  for (const [type, colour] of Object.entries(LIGHT)) {
    const bar = scan(first, colour, 10);
    const tint = scan(first, tintOf(colour), 3);
    // the icon and the title are drawn in the colour too, anti-aliased: count the colour's
    // neighbourhood beyond the bar column (the bar is 3px wide, at scale 2 six columns)
    const nearColour = scan(first, colour, 48);
    const iconAndTitle = nearColour.count - nearColour.rows.size * 6;
    check(`${type}: the left bar and the tinted background are painted (bar ${bar.count}px, tint ${tint.count}px), the icon and title in the colour too (${iconAndTitle}px beyond the bar)`, bar.count >= 120 && tint.count >= 6000 && iconAndTitle >= 150, JSON.stringify({ bar: bar.count, tint: tint.count, iconAndTitle }));
  }
  const text = pages.map((p) => p.text).join(' ');
  const squash = (t) => t.replace(/\s+/g, '');
  const has = (phrase) => squash(text).includes(squash(phrase));
  check('the custom title, the folded body, the list, the code and the table are in the printed text', has('Before you run it') && has('The folded body prints too') && has('first item') && has('echo callout-code') && has('cell-1'), text.slice(0, 300));
  // the short callout near the page end is printed whole: its title and body on one page, and no
  // tinted block of any type is cut at a page's bottom edge (break-inside: avoid)
  const cut = pages.flatMap((p) => Object.entries(LIGHT).map(([type, colour]) => { const s = scan(p, tintOf(colour), 3); return { n: p.n, type, bottom: s.rows.size ? Math.max(...s.rows) : -1, edge: p.height - p.marginBottomPx, runs: runsOf(s.rows) }; })).filter((r) => r.bottom >= r.edge - 4);
  const lastPage = pages.find((p) => squash(p.text).includes(squash('Near the page end')));
  check('no callout is cut at a page bottom; the callout near the page end has its title and its body on one page', cut.length === 0 && !!lastPage && squash(lastPage.text).includes(squash('must move whole to the next page rather than split')), JSON.stringify({ cut, lastPage: lastPage?.n }));
  check('the last callout is on the last page with "The end." after it', squash(pages[pages.length - 1].text).includes(squash('Near the page end')) && squash(pages[pages.length - 1].text).includes('Theend.'));

  const dark = await exportThrough(page, true);
  const printedDark = await printAndRender(dark, 'dark');
  const darkBar = scan(printedDark.pages[0], LIGHT.note, 10);
  const darkTokenBar = scan(printedDark.pages[0], [0x4a, 0x9e, 0xff], 10);
  check('with the app in the dark theme the PDF uses the LIGHT colours (no dark class in the printed document): the note bar is #0066CC, not #4a9eff', darkBar.count >= 120 && darkTokenBar.count < 20, JSON.stringify({ darkBar: darkBar.count, darkTokenBar: darkTokenBar.count }));
  await context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
