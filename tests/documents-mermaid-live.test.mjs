/**
 * Real-browser check of Mermaid diagrams in the Documents preview and the
 * PDF export (src/utils/mermaidDiagrams.js, DocumentEditor.jsx preview
 * effect, useImportExport.js exportDocumentToPDF).
 *
 * tests/documents-mermaid-preview.test.mjs proves the routing, sanitizing,
 * error and lifecycle logic against a FAKE mermaid (jsdom has no layout, and
 * mermaid needs getBBox). This file drives the REAL app in headless Chrome
 * against a Vite dev server, with the real bundled mermaid, and proves:
 *   - first preview of a brand-new document (typed, never closed or
 *     reopened, mermaid chunk not yet loaded in the session): a document
 *     with two valid ```mermaid fences and one invalid one shows two
 *     rendered SVG diagrams (labels as SVG <text>, no <foreignObject>, no
 *     <script>, distinct ids, source <pre> hidden) and one inline error box
 *     with the source still visible; a ```js fence in the same document
 *     stays a plain code block; the mermaid chunk was fetched by that
 *     preview and not before;
 *   - toggling the app theme (the `dark` class ThemeContext puts on <html>)
 *     re-renders the diagrams with mermaid's dark theme, and toggling back
 *     is served from the cache; closing and re-opening the preview works;
 *   - editing a diagram in place and pressing Preview again shows the
 *     UPDATED diagram, not a cached one;
 *   - "Export PDF" straight after that edit produces a PDF whose drawn text
 *     contains the valid diagrams' labels (inline SVG printed as vectors)
 *     but none of their source, DOES contain the invalid
 *     diagram's error box and its source (the fallback), embeds at least
 *     two images (the diagrams), and the export container rendered the
 *     edited diagram (observed via MutationObserver) before printing;
 *   - unrelated editor state changes while in preview (menu open/close,
 *     clicks on text, resize events) leave the same rendered <svg> elements
 *     connected with no mutations, a viewport width cycle keeps every
 *     diagram inside its pane and scales it back up (pure CSS), and theme
 *     toggles / content edits still re-render;
 *   - each export opened STANDALONE in a fresh page (no app, then with its
 *     own stylesheet removed, as a CSS-less viewer such as Illustrator sees
 *     it): every edge keeps a visible stroke equal to the in-app one,
 *     markers resolve and arrowheads keep their fill, shapes/labels match,
 *     every leaf's computed paint equals the in-app value with NO stylesheet
 *     in the file, the file passes strict-importer rules (no <style>/style
 *     attributes/filters/data-*, explicit hex stroke + fill + width on every
 *     edge, no dash pattern on solid edges, no marker references - Adobe
 *     Illustrator collapses any path with one - arrowheads baked as plain
 *     shapes with the in-app fill), librsvg draws the edges (when
 *     rsvg-convert is installed), sequence actors are painted, light+dark;
 *   - no uncaught exception in the page throughout.
 *
 * Synthetic content only, fresh throwaway Chrome profile (its own empty
 * IndexedDB - never the user's documents).
 *
 * Needs a Chrome/Chromium binary. When none is found (or
 * SKIP_BROWSER_TESTS=1 is set) the test SKIPS with exit code 0 so
 * ./tests/run-all.sh stays green on machines without a browser; set
 * Run by hand (SKIP_ELECTRON_TESTS=1 skips it):
 *
 *   node tests/documents-mermaid-live.test.mjs
 *
 * Environment: SKIP_ELECTRON_TESTS, PDF_OUT (optional path
 * to also write the generated PDF to for inspection).
 * Exit code: 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { inspectPdf } from './helpers/pdf-inspect.mjs';
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(path.join(REPO, 'node_modules', 'mermaid'))) {
  console.error('FAIL: node_modules/mermaid missing - run npm install');
  process.exit(1);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- synthetic document ----------
// Label words are deliberately unusual so their absence/presence in the
// PDF's drawn text is unambiguous.
const FLOW = ['graph TD', '  Intakeq[Intakeq queue] --> Triagex[Triagex step]', '  Triagex --> Resolvedz[Resolvedz]'].join('\n');
const SEQ = ['sequenceDiagram', '  participant Clientq', '  participant Serverq', '  Clientq->>Serverq: pingq', '  Serverq-->>Clientq: pongq'].join('\n');
const BAD = ['graph TD', '  Brokenq --> boomq oops --> [['].join('\n');
const MARKDOWN = [
  '# Diagram notes (synthetic)',
  '',
  'Intro paragraph before the first diagram.',
  '',
  '```mermaid', FLOW, '```',
  '',
  'Paragraph between the diagrams.',
  '',
  '```mermaid', SEQ, '```',
  '',
  'This one is deliberately invalid:',
  '',
  '```mermaid', BAD, '```',
  '',
  '```js', 'const untouchedq = 1;', '```',
  '',
  'Closing paragraph.',
  '',
].join('\n');

// ---------- 1+2. The real Electron app (Vite dev server + Playwright) ----------
// Same driver shape the headless-Chrome version used (evaluate / send /
// waitFor / errors), now against the real app on a throwaway profile - the
// PDF export only exists there (printToPDF in the main process).
const electronApp = await launchElectronDocumentsApp({ profilePrefix: 'doc-mermaid-live-' });
if (electronApp.skip) {
  console.log(`SKIP: ${electronApp.skip}`);
  process.exit(0);
}
const { evaluate, send, waitFor, errors } = electronApp;
const cleanup = () => electronApp.close();
let exitCode = 1;
try {

  // The preview button cycles OFF -> Preview -> Preview (all documents) -> OFF,
  // so "close" means clicking until the preview pane is gone.
  const closePreview = async () => {
    for (let i = 0; i < 3; i++) {
      const open = await evaluate(`!!document.querySelector('.markdown-preview')`);
      if (!open) return true;
      await evaluate(`(() => { const b = document.querySelector('button[title="Edit"], button[title^="Preview (all documents)"]'); if (b) b.click(); })()`);
      await sleep(400);
    }
    return !(await evaluate(`!!document.querySelector('.markdown-preview')`));
  };

  // ---------- 3. Create the document and fill it ----------
  check('Documents page shows the empty-state New Document button on a fresh profile',
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'New Document'); if (!b) return false; b.click(); return true; })()`));
  await sleep(1500);
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await send('Input.insertText', { text: MARKDOWN });
  await sleep(1500); // autosave
  const typed = await evaluate(`document.querySelector('textarea') && document.querySelector('textarea').value`);
  check('the editor holds the synthetic markdown verbatim (no auto-pairing mangled the fences)', typed === MARKDOWN, typed ? `${typed.length} chars` : 'no textarea');

  // ---------- 4. Preview: real mermaid renders (first preview ever, fresh document) ----------
  // The mermaid chunk must not have been loaded by merely opening the app or
  // typing: it is fetched when the FIRST preview containing a diagram opens,
  // and that first render must still complete (no "chunk arrived after the
  // preview mounted" race).
  const MERMAID_LOADS = `performance.getEntriesByType('resource').filter(e => /node_modules\\/(\\.vite\\/deps\\/)?mermaid/.test(e.name)).length`;
  // the dev server serves the app as hundreds of module files: widen the
  // resource-timing buffer (default 250 entries) so the mermaid chunks
  // loaded by the first preview are still recorded
  await evaluate(`performance.setResourceTimingBufferSize(20000)`);
  const mermaidBefore = await evaluate(MERMAID_LOADS);
  check('the mermaid chunk is NOT loaded before the first preview (app start + typing paid nothing for it)', mermaidBefore === 0, `loads=${mermaidBefore}`);
  const previewOpened = await evaluate(`(() => { const b = document.querySelector('button[title="Preview"]'); if (!b) return false; b.click(); return true; })()`);
  check('the editor toolbar offers the Preview toggle', previewOpened);
  // First diagram ever: mermaid's lazy chunks load now (dev server may
  // also optimize the dependency on first use), so allow generous time.
  const STATE = `(() => {
    const els = Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram'));
    return { rendered: els.filter(e => e.dataset.mermaid === 'rendered').length, error: els.filter(e => e.dataset.mermaid === 'error').length, pending: els.filter(e => e.dataset.mermaid === 'pending' || e.dataset.mermaid === 'rendering').length, total: els.length };
  })()`;
  let state = null;
  for (let i = 0; i < 240; i++) { // up to 60s
    state = await evaluate(STATE);
    if (state && state.total === 3 && state.pending === 0) break;
    await sleep(250);
  }
  check('first preview of a brand-new, never-reopened document: all three ```mermaid fences became placeholders and finished (2 rendered + 1 error)',
    state && state.total === 3 && state.rendered === 2 && state.error === 1, JSON.stringify(state));
  const mermaidAfter = await evaluate(MERMAID_LOADS);
  check('the mermaid chunk was loaded lazily by that first preview', mermaidAfter > 0, `loads=${mermaidAfter}`);

  const inspect = await evaluate(`(() => {
    const els = Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram'));
    const svgs = els.map(e => e.querySelector('.mermaid-diagram-output > svg'));
    const texts = (svg) => svg ? Array.from(svg.querySelectorAll('text, tspan')).map(t => t.textContent).join(' ') : '';
    const bad = els.find(e => e.dataset.mermaid === 'error');
    const preview = document.querySelector('.markdown-preview');
    return {
      ids: svgs.map(s => s && s.id),
      themes: els.map(e => e.dataset.mermaidTheme),
      labels: svgs.map(texts),
      foreignObjects: preview.querySelectorAll('foreignObject').length,
      scripts: preview.querySelectorAll('script').length,
      handlers: Array.from(preview.querySelectorAll('*')).filter(n => Array.from(n.attributes).some(a => /^on/i.test(a.name))).length,
      renderedPreHidden: els.filter(e => e.dataset.mermaid === 'rendered').every(e => getComputedStyle(e.querySelector('pre')).display === 'none'),
      svgWidthsOk: svgs.filter(Boolean).every(s => s.getBoundingClientRect().width > 50 && s.getBoundingClientRect().width <= preview.clientWidth),
      errorTitle: bad ? bad.querySelector('.mermaid-diagram-error-title')?.textContent : null,
      errorMessage: bad ? bad.querySelector('.mermaid-diagram-error-message')?.textContent : null,
      errorSourceVisible: bad ? getComputedStyle(bad.querySelector('pre')).display !== 'none' && bad.querySelector('code').textContent.includes('boomq') : false,
      errorHasSvg: bad ? !!bad.querySelector('svg') : null,
      jsFence: (preview.querySelector('pre > code.language-js') || {}).textContent || null,
      jsFenceInDiagram: !!(preview.querySelector('pre > code.language-js') && preview.querySelector('pre > code.language-js').closest('.mermaid-diagram')),
      darkClass: document.documentElement.classList.contains('dark'),
      flowStyle: svgs[0] ? svgs[0].querySelector('style')?.textContent.slice(0, 4000) : null,
    };
  })()`);
  check('flowchart labels are SVG text (Intakeq / Triagex / Resolvedz)', /Intakeq/.test(inspect.labels[0]) && /Triagex/.test(inspect.labels[0]) && /Resolvedz/.test(inspect.labels[0]), inspect.labels[0]);
  check('sequence diagram labels are SVG text (Clientq / Serverq / pingq / pongq)', /Clientq/.test(inspect.labels[1]) && /pingq/.test(inspect.labels[1]) && /pongq/.test(inspect.labels[1]), inspect.labels[1]);
  check('the two rendered SVGs have distinct ids', inspect.ids[0] && inspect.ids[1] && inspect.ids[0] !== inspect.ids[1], inspect.ids.join(', '));
  check('no <foreignObject>, <script> or on* handler attributes anywhere in the preview',
    inspect.foreignObjects === 0 && inspect.scripts === 0 && inspect.handlers === 0, JSON.stringify({ fo: inspect.foreignObjects, scripts: inspect.scripts, handlers: inspect.handlers }));
  check('rendered diagrams hide their source block; SVGs fit the preview width', inspect.renderedPreHidden && inspect.svgWidthsOk);
  check('the invalid diagram shows an inline error box with a parse error and keeps its source visible (no SVG)',
    inspect.errorTitle && /could not be rendered/i.test(inspect.errorTitle) && inspect.errorMessage && inspect.errorMessage.length > 5 && inspect.errorSourceVisible && inspect.errorHasSvg === false,
    JSON.stringify({ title: inspect.errorTitle, message: (inspect.errorMessage || '').slice(0, 120) }));
  check('the ```js fence in the same document stays a plain code block', inspect.jsFence === 'const untouchedq = 1;\n' && !inspect.jsFenceInDiagram, JSON.stringify(inspect.jsFence));
  check('diagrams rendered with the light theme while the app is light', !inspect.darkClass && inspect.themes.slice(0, 2).every((t) => t === 'default'), JSON.stringify(inspect.themes));

  // ---------- 5. Theme toggle re-renders ----------
  await evaluate(`document.documentElement.classList.add('dark')`);
  const darkState = await waitFor(`(() => { const els = Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram[data-mermaid="rendered"]')); return els.length === 2 && els.every(e => e.dataset.mermaidTheme === 'dark') ? { ids: els.map(e => e.querySelector('svg').id), style: els[0].querySelector('svg style').textContent.slice(0, 4000), outputs: els.map(e => e.querySelectorAll('.mermaid-diagram-output').length) } : null; })()`, 20000);
  check('switching the app to dark re-renders both diagrams with mermaid\'s dark theme (new SVGs, different stylesheet)',
    darkState && darkState.ids[0] !== inspect.ids[0] && darkState.style !== inspect.flowStyle && darkState.outputs.every((n) => n === 1), JSON.stringify(darkState && { ids: darkState.ids, outputs: darkState.outputs }));
  const errorUntouched = await evaluate(`(() => { const b = document.querySelector('.markdown-preview .mermaid-diagram[data-mermaid="error"]'); return !!b && !!b.querySelector('.mermaid-diagram-error') && !b.querySelector('svg'); })()`);
  check('the error block survives the theme change untouched', errorUntouched);
  await evaluate(`document.documentElement.classList.remove('dark')`);
  const lightAgain = await waitFor(`(() => { const els = Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram[data-mermaid="rendered"]')); return els.length === 2 && els.every(e => e.dataset.mermaidTheme === 'default'); })()`, 20000);
  check('switching back to light re-renders with the light theme again', lightAgain === true);

  // ---------- 6. Preview off / on ----------
  const closed = await closePreview();
  const editorBack = closed && await evaluate(`!!document.querySelector('textarea') && !document.querySelector('.markdown-preview')`);
  check('closing the preview returns to the editor (no leftover preview DOM, no exception from the aborted render)', editorBack);
  await evaluate(`document.querySelector('button[title="Preview"]').click()`);
  const reopened = await waitFor(`(() => { const s = ${STATE}; return s.total === 3 && s.rendered === 2 && s.error === 1; })()`, 20000);
  check('re-opening the preview renders all diagrams again (cache hit)', reopened === true);

  // ---------- 6b. Edit the diagram, preview again: the UPDATED diagram, not a cached one ----------
  check('preview closed again for editing', await closePreview());
  const EDITED = MARKDOWN.replace('Triagex --> Resolvedz[Resolvedz]', 'Triagex --> Escalatedq[Escalatedq]');
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await send('Input.insertText', { text: EDITED });
  await sleep(1500); // autosave
  const edited = await evaluate(`document.querySelector('textarea').value`);
  check('editing the document in place replaced the flowchart\'s last node (Resolvedz -> Escalatedq)', edited === EDITED && edited.includes('Escalatedq'));
  await evaluate(`document.querySelector('button[title="Preview"]').click()`);
  const updated = await waitFor(`(() => {
    const s = ${STATE};
    if (!(s.total === 3 && s.rendered === 2 && s.error === 1)) return null;
    const svg = document.querySelector('.markdown-preview .mermaid-diagram[data-mermaid="rendered"] svg');
    const labels = Array.from(svg.querySelectorAll('text, tspan')).map(t => t.textContent).join(' ');
    return { labels, id: svg.id };
  })()`, 20000);
  check('preview after the edit shows the UPDATED flowchart (Escalatedq present, Resolvedz gone) without reopening the document',
    updated && /Escalatedq/.test(updated.labels) && !/Resolvedz/.test(updated.labels), JSON.stringify(updated));

  // ---------- 7. Export PDF (straight after the edit, document never reopened) ----------
  // Watch the export's off-screen container so the test can prove the PDF
  // was rasterized from finished, UPDATED diagrams: record the SVG labels
  // of every diagram rendered inside .pdf-export-root before printing.
  await evaluate(`(() => {
    window.__exportDiagrams = [];
    window.__exportErrors = 0;
    const seen = new WeakSet();
    new MutationObserver(() => {
      const root = document.querySelector('.pdf-export-root');
      if (!root) return;
      for (const svg of root.querySelectorAll('.mermaid-diagram[data-mermaid="rendered"] svg')) {
        if (seen.has(svg)) continue;
        seen.add(svg);
        window.__exportDiagrams.push(Array.from(svg.querySelectorAll('text, tspan')).map(t => t.textContent).join(' '));
      }
      window.__exportErrors = Math.max(window.__exportErrors, root.querySelectorAll('.mermaid-diagram[data-mermaid="error"] .mermaid-diagram-error').length);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-mermaid'] });
  })()`);
  await evaluate(`(() => {
    window.__pdfBlobs = [];
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { if (blob && blob.type === 'application/pdf') window.__pdfBlobs.push(blob); return origCreate(blob); };
    HTMLAnchorElement.prototype.click = function () { /* no download in headless */ };
  })()`);
  await evaluate(`(() => { for (const b of document.querySelectorAll('button[title="Expand"]')) b.click(); })()`);
  await sleep(400);
  const opened = await evaluate(`(() => {
    const matches = Array.from(document.querySelectorAll('span, div, p')).filter(e => e.children.length === 0 && /Untitled/i.test(e.textContent));
    if (!matches.length) return 'no sidebar item';
    const target = matches.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 5, view: window }));
    return 'contextmenu@' + Math.round(r.left);
  })()`);
  await sleep(300);
  const clicked = await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Export PDF'); if (!b) return false; b.click(); return true; })()`);
  check('the sidebar context menu offers Export PDF for the document', opened.startsWith('contextmenu') && clicked, opened);
  // The export options dialog (page size / orientation; A4 portrait by
  // default): its Export button starts the export
  const started = await waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Export' && el.closest('.bg-os-modal') && document.getElementById('pdf-export-page-size')); if (!b) return false; b.click(); return true; })()`, 10000);
  check('the export options dialog opened and its Export button started the export', !!started);

  let pdfB64 = null;
  for (let i = 0; i < 180 && !pdfB64; i++) {
    await sleep(500);
    pdfB64 = await evaluate(`(async () => { const b = window.__pdfBlobs && window.__pdfBlobs[0]; if (!b) return null; const buf = await b.arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); })()`);
  }
  check('the export produced a PDF blob (export never fails on an invalid diagram)', !!pdfB64);
  const pdf = Buffer.from(pdfB64 || '', 'base64');
  if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, pdf);

  const info = await inspectPdf(pdf);
  const pages = info.pages;
  check('the PDF is valid and has at least one page', pdf.subarray(0, 5).toString() === '%PDF-' && pages >= 1, `pages=${pages}`);
  const flowOneLine = info.pageTexts.join(' ');
  if (process.env.PDF_OUT) console.log(flowOneLine.slice(0, 1500));
  check('body paragraphs are in the PDF as text (sanity: text extraction works)',
    flowOneLine.includes('Intro paragraph before the first diagram.') && flowOneLine.includes('Closing paragraph.'));
  const leakedSource = ['sequenceDiagram', 'participant', 'Clientq->>Serverq', 'Serverq-->>Clientq', 'Intakeq[Intakeq', '--> Triagex', 'Resolvedz[', 'graph TD Intakeq'].filter((t) => flowOneLine.includes(t));
  check('the valid diagrams\' SOURCE is not drawn as text in the PDF (their <pre> stays hidden)', leakedSource.length === 0, `leaked: ${leakedSource.join(' | ')}`);
  // The print engine prints the inline SVG diagrams itself: their labels
  // ARE text in the PDF (selectable, searchable); the node shapes come out
  // as a mix of vector paths and rasterized fragments.
  const labels = ['Intakeq', 'Triagex', 'Escalatedq', 'Clientq', 'Serverq', 'pingq', 'pongq'].filter((t) => flowOneLine.includes(t));
  check('the valid diagrams\' LABELS are in the PDF as text (inline SVG printed by the engine, labels kept as text)', labels.length === 7, `found: ${labels.join(' | ')}`);
  const diagramPage = info.pageTexts.findIndex((t) => t.includes('Intakeq')) + 1;
  check('the diagram page carries the drawn diagrams (paths or image fragments) next to their text labels',
    diagramPage > 0 && info.paints[diagramPage - 1].paths + info.paints[diagramPage - 1].images > 0, JSON.stringify(info.paints));
  const exportDiagrams = await evaluate(`({ diagrams: window.__exportDiagrams, errors: window.__exportErrors })`);
  check('the export rendered both diagrams from the CURRENT (edited) content before printing: Escalatedq present, Resolvedz gone',
    exportDiagrams.diagrams.length === 2 && exportDiagrams.diagrams.some((l) => /Escalatedq/.test(l)) && !exportDiagrams.diagrams.some((l) => /Resolvedz/.test(l))
      && exportDiagrams.diagrams.some((l) => /pingq/.test(l)) && exportDiagrams.errors === 1,
    JSON.stringify(exportDiagrams));
  check('the invalid diagram falls back to its error box + source text in the PDF',
    /could not be rendered/i.test(flowOneLine) && flowOneLine.includes('boomq'), (flowOneLine.match(/Mermaid[\s\S]{0,80}/) || ['(missing)'])[0]);
  check('the ```js fence is exported as plain code text', flowOneLine.includes('const untouchedq = 1;'));

  // ---------- 8. Dark mode label contrast with author-styled (pastel) nodes ----------
  // mermaid's dark theme paints labels light; classDef/style fills replace only
  // the fill, so pastel boxes got light-grey text (1.4:1). The contrast pass in
  // mermaidDiagrams.js (dark renders only) must make every label readable
  // while keeping an author's explicit `color:` and leaving light mode alone.
  const PASTEL = [
    'flowchart TD',
    '  classDef default fill:#f4f4f5,stroke:#9ca3af',
    '  classDef ok fill:#dcfce7,stroke:#16a34a',
    '  classDef warn fill:#fef9c3,stroke:#ca8a04',
    '  classDef bad fill:#fee2e2,stroke:#dc2626',
    '  classDef pinned fill:#1e3a8a,stroke:#93c5fd,color:#fde68a',
    '  subgraph lane [Intake lane]',
    '    P1[Ticket arrives<br/>from portal] --> P2{Severity<br/>known?}',
    '  end',
    '  P2 -->|yes| P3[Assign owner]:::ok',
    '  P2 -.->|unknown, ask| P4[Request details]:::warn',
    '  P4 --> P5[Escalate to duty lead]:::bad',
    '  P3 --> P6[Archive case]:::pinned',
    '  P5 --> P7[Postmortem note]',
    '  style P7 fill:#e0e7ff,stroke:#4f46e5',
  ].join('\n');
  const PASTEL_DOC = ['# Contrast probe (synthetic)', '', 'Intro paragraph for the contrast probe.', '', '```mermaid', PASTEL, '```', '', '```mermaid', 'graph TD', '  Brokenq --> boomq oops --> [[', '```', '', '```mermaid', 'sequenceDiagram', '  participant Clientq', '  participant Serverq', '  Clientq->>Serverq: pingq', '  Serverq-->>Clientq: pongq', '```', ''].join('\n');
  // In-page WCAG contrast over getComputedStyle() colours, per node/cluster/edge label
  const CONTRAST_REPORT = `(() => {
    const lum = ([r, g, b]) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const rgb = (s) => { const v = ${COLOR_PROBE}.parse(s); return v ? v.slice(0, 3) : null; };   // any syntax (the shared helper), not only rgb()
    const contrast = (a, b) => { const x = rgb(a), y = rgb(b); if (!x || !y) return null; const la = lum(x), lb = lum(y); return +(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2)); };
    const el = document.querySelector('.markdown-preview .mermaid-diagram');
    const svg = el && el.querySelector('svg');
    if (!svg || el.dataset.mermaid !== 'rendered') return null;
    const cs = (n) => getComputedStyle(n);
    const nodes = Array.from(svg.querySelectorAll('g.node')).map((n) => {
      const shape = Array.from(n.querySelectorAll(':scope > rect, :scope > polygon, :scope > path')).find((s) => !s.closest('.label'));
      const texts = Array.from(n.querySelectorAll('.label text, .label tspan'));
      const fills = new Set(texts.map((t) => cs(t).fill));
      return { cls: (n.getAttribute('class') || '').replace('node default', '').trim() || '(default)', fill: cs(shape).fill, text: cs(texts[0]).fill, uniformText: fills.size === 1, contrast: contrast(cs(shape).fill, cs(texts[0]).fill), marked: texts.some((t) => t.hasAttribute('data-contrast-fill')), label: texts[0].textContent.slice(0, 20) };
    });
    const clusters = Array.from(svg.querySelectorAll('g.cluster')).map((c) => { const r = c.querySelector(':scope > rect'); const t = c.querySelector('.cluster-label text'); return { contrast: contrast(cs(r).fill, cs(t).fill), marked: t.hasAttribute('data-contrast-fill') }; });
    // mermaid emits an .edgeLabel group for EVERY edge; only the labelled ones have a chip and text
    const edges = Array.from(svg.querySelectorAll('.edgeLabel')).filter((e) => e.querySelector('rect') && e.querySelector('text') && e.textContent.trim()).map((e) => { const r = e.querySelector('rect'); const t = e.querySelector('text'); return { text: e.textContent.trim(), contrast: contrast(cs(r).fill, cs(t).fill), marked: t.hasAttribute('data-contrast-fill') }; });
    return { theme: el.dataset.mermaidTheme, nodes, clusters, edges, markers: svg.querySelectorAll('[data-contrast-fill]').length };
  })()`;
  const contrastOk = (r, min = 4.5) => r && r.nodes.length === 7 && r.nodes.every((n) => n.contrast !== null && n.contrast >= min && n.uniformText) && r.clusters.every((c) => c.contrast >= min) && r.edges.every((e) => e.contrast >= min);
  const worst = (r) => r ? Math.min(...r.nodes.map((n) => n.contrast ?? 0), ...r.clusters.map((c) => c.contrast ?? 0), ...r.edges.map((e) => e.contrast ?? 0)) : null;

  check('preview closed to type the pastel-classDef document', await closePreview());
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await send('Input.insertText', { text: PASTEL_DOC });
  await sleep(1200);
  await evaluate(`document.documentElement.classList.remove('dark')`);
  await evaluate(`document.querySelector('button[title="Preview"]').click()`);
  const light = await waitFor(`(() => { const r = ${CONTRAST_REPORT}; return r && r.theme === 'default' ? r : null; })()`, 30000);
  check('light mode: pastel diagram renders with 7 nodes and no contrast markers (light output untouched)',
    light && light.nodes.length === 7 && light.markers === 0, light ? JSON.stringify({ markers: light.markers, n: light.nodes.length }) : 'not rendered');
  check(`light mode: every node/cluster/edge label already meets 4.5:1 with mermaid's own colours (worst ${worst(light)})`, contrastOk(light), light ? JSON.stringify(light.nodes.map((n) => [n.cls, n.contrast])) : '');

  await evaluate(`document.documentElement.classList.add('dark')`);
  const dark = await waitFor(`(() => { const r = ${CONTRAST_REPORT}; return r && r.theme === 'dark' ? r : null; })()`, 30000);
  check('dark mode: the diagram re-rendered with the dark theme', dark && dark.theme === 'dark' && dark.nodes.length === 7, dark ? '' : 'not re-rendered');
  check(`dark mode: EVERY node label has >= 4.5:1 contrast against its own fill (pastel classDefs, classDef default, style, multi-line) - worst ${worst(dark)}`,
    contrastOk(dark), dark ? JSON.stringify(dark.nodes.map((n) => [n.cls, n.fill, n.text, n.contrast])) : '');
  const pinned = dark && dark.nodes.find((n) => n.cls === 'pinned');
  check('dark mode: the node with an explicit classDef color: keeps it (#fde68a, no marker)',
    pinned && pinned.text === 'rgb(253, 230, 138)' && !pinned.marked, JSON.stringify(pinned));
  check('dark mode: pastel nodes were recoloured by the pass (dark text, markers present), dark-fill nodes left to the theme',
    dark && dark.nodes.filter((n) => n.cls !== 'pinned').every((n) => n.marked && n.text === 'rgb(17, 24, 39)') && dark.markers >= 6, dark ? `markers=${dark.markers}` : '');
  // The cluster title (#F9FFFE on the dark cluster fill, ~9:1) is left to the
  // theme. The edge chips are mermaid's #ccc on an rgb(88,88,88) fill = 4.3:1,
  // just under the minimum, so the pass nudges them to light text (6.8:1).
  check('dark mode: cluster title untouched (already ~9:1) and the two edge-label chips readable (>= 4.5:1)',
    dark && dark.clusters.length === 1 && dark.edges.length === 2 && dark.clusters.every((c) => c.contrast >= 4.5 && !c.marked) && dark.edges.every((e) => e.contrast >= 4.5),
    dark ? JSON.stringify({ clusters: dark.clusters, edges: dark.edges }) : '');

  await evaluate(`document.documentElement.classList.remove('dark')`);
  const lightAfterDark = await waitFor(`(() => { const r = ${CONTRAST_REPORT}; return r && r.theme === 'default' ? r : null; })()`, 30000);
  check('back to light mode (cache hit): no markers, mermaid\'s light colours, contrast still fine - no dark post-processing leaked through the cache',
    lightAfterDark && lightAfterDark.markers === 0 && contrastOk(lightAfterDark) && lightAfterDark.nodes.every((n) => n.text === light.nodes.find((m) => m.cls === n.cls)?.text));
  await evaluate(`document.documentElement.classList.add('dark')`);
  const darkAgain = await waitFor(`(() => { const r = ${CONTRAST_REPORT}; return r && r.theme === 'dark' && r.markers > 0 ? r : null; })()`, 30000);
  check('dark again (cache hit): the pass re-runs on the cached dark render, labels readable', contrastOk(darkAgain), darkAgain ? `worst ${worst(darkAgain)}` : 'no markers');
  await evaluate(`document.documentElement.classList.remove('dark')`);

  // ---------- 9. Right-click a rendered diagram -> "Download SVG" ----------
  // The export goes through the same blob + <a download> hand-off as every
  // other export (src/utils/exportHelpers.js downloadBlob), so capture it the way the PDF
  // was captured: hook URL.createObjectURL for image/svg+xml blobs and
  // record the anchor's download name instead of downloading.
  await evaluate(`(() => {
    window.__svgDownloads = [];
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { if (blob && blob.type === 'image/svg+xml') window.__svgDownloads.push({ blob, name: null }); return origCreate(blob); };
    HTMLAnchorElement.prototype.click = function () { const last = window.__svgDownloads[window.__svgDownloads.length - 1]; if (last && !last.name) last.name = this.download; };
  })()`);
  const rightClick = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.min(20, r.width / 2), clientY: r.top + Math.min(20, r.height / 2), view: window })); return true; })()`);
  const menuItem = () => evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Download SVG'); return b ? { visible: true, rect: b.getBoundingClientRect().toJSON() } : { visible: false }; })()`);
  const readSvg = async (i) => {
    const got = await evaluate(`(async () => { const d = window.__svgDownloads[${i}]; if (!d || !d.name) return null; return { name: d.name, type: d.blob.type, text: await d.blob.text() }; })()`);
    return got;
  };
  const { JSDOM } = (await import(req.resolve('jsdom')));
  const parseSvgFile = (text) => {
    const w = new JSDOM('<!doctype html><body></body>').window;
    const parsed = new w.DOMParser().parseFromString(text, 'image/svg+xml');
    const err = parsed.querySelector('parsererror');
    return { root: err ? null : parsed.documentElement, error: err && err.textContent.slice(0, 120) };
  };

  const lightState = await waitFor(`(() => { const e = document.querySelector('.markdown-preview .mermaid-diagram'); return e && e.dataset.mermaid === 'rendered' && e.dataset.mermaidTheme === 'default'; })()`, 20000);
  check('section 9: the pastel diagram is rendered in the light theme (starting point)', lightState === true);
  check('section 9: right-click on the rendered diagram opens a context menu with "Download SVG"',
    (await rightClick('.markdown-preview .mermaid-diagram[data-mermaid="rendered"] svg')) && (await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Download SVG')`, 3000)) === true);
  const item = await menuItem();
  check('section 9: the menu is positioned on screen (clamped inside the viewport)', item.visible && item.rect.left >= 0 && item.rect.top >= 0 && item.rect.right <= 1400 && item.rect.bottom <= 900, JSON.stringify(item.rect));
  await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Download SVG').click()`);
  const dl1 = await (async () => { for (let i = 0; i < 20; i++) { const r = await readSvg(0); if (r) return r; await sleep(200); } return null; })();
  check('section 9: clicking it hands one image/svg+xml file to the download machinery and closes the menu',
    dl1 && dl1.type === 'image/svg+xml' && (await menuItem()).visible === false && (await evaluate('window.__svgDownloads.length')) === 1, dl1 ? dl1.name : 'no download');
  check('section 9: the file is named after the document title plus the diagram index (Untitled Document -> Untitled_Document-diagram-1.svg)',
    dl1 && dl1.name === 'Untitled_Document-diagram-1.svg', dl1 && dl1.name);
  const light1 = dl1 ? parseSvgFile(dl1.text) : { root: null, error: 'no file' };
  check('section 9: the file parses as SVG (XML declaration, xmlns, numeric width/height, viewBox; self-describing - no embedded <style>)',
    light1.root && dl1.text.startsWith('<?xml version="1.0"') && light1.root.namespaceURI === 'http://www.w3.org/2000/svg'
      && /^\d+(\.\d+)?$/.test(light1.root.getAttribute('width')) && /^\d+(\.\d+)?$/.test(light1.root.getAttribute('height')) && /^[-\d. ]+$/.test(light1.root.getAttribute('viewBox')) && !light1.root.querySelector('style'),
    light1.error || `${light1.root && light1.root.getAttribute('width')}x${light1.root && light1.root.getAttribute('height')} viewBox=${light1.root && light1.root.getAttribute('viewBox')}`);
  check('section 9: the file contains the diagram\'s labels and a white background rect (light export)',
    light1.root && ['Ticket arrives', 'Severity', 'Assign owner', 'Request details', 'Escalate to duty', 'Archive case', 'Postmortem'].every((l) => light1.root.textContent.includes(l))
      && light1.root.querySelector('rect.mermaid-export-background') && /^(#ffffff|#fff|rgb\(255, 255, 255\))$/i.test(light1.root.querySelector('rect.mermaid-export-background').getAttribute('fill')),
    light1.root ? `bg=${light1.root.querySelector('rect.mermaid-export-background')?.getAttribute('fill')}` : '');
  check('section 9: no script, event handlers, foreignObject or remote references in the file',
    dl1 && !/<script|<foreignObject|\son\w+=|javascript:|@import|url\(http/i.test(dl1.text) && !/https?:\/\/(?!www\.w3\.org\/)/.test(dl1.text));

  // Dark: the export must carry the dark render (contrast overrides) on a dark background
  await evaluate(`document.documentElement.classList.add('dark')`);
  const darkReady = await waitFor(`(() => { const e = document.querySelector('.markdown-preview .mermaid-diagram'); return e && e.dataset.mermaid === 'rendered' && e.dataset.mermaidTheme === 'dark' && e.querySelector('[data-contrast-fill]') ? true : false; })()`, 20000);
  check('section 9: dark theme re-rendered with contrast overrides', darkReady === true);
  await rightClick('.markdown-preview .mermaid-diagram[data-mermaid="rendered"] svg');
  await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Download SVG')`, 3000);
  await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Download SVG').click()`);
  const dl2 = await (async () => { for (let i = 0; i < 20; i++) { const r = await readSvg(1); if (r) return r; await sleep(200); } return null; })();
  const dark2 = dl2 ? parseSvgFile(dl2.text) : { root: null };
  const darkBg = dark2.root && dark2.root.querySelector('rect.mermaid-export-background')?.getAttribute('fill');
  const darkBgRgb = darkBg && darkBg.match(/\d+/g)?.map(Number);
  check('section 9: dark export has a DARK background rect (the preview pane\'s colour) and keeps the label-contrast overrides as displayed (label text fill="#111827" attributes)',
    dark2.root && darkBg && (darkBgRgb ? darkBgRgb.slice(0, 3).every((c) => c < 80) : /^#[0-3]/i.test(darkBg)) && Array.from(dark2.root.querySelectorAll('g.node .label text')).filter((t) => t.getAttribute('fill') === '#111827').length >= 6,
    `bg=${darkBg} darkLabels=${dark2.root && dark2.root.querySelectorAll('g.node .label text[fill="#111827"]').length}`);
  check('section 9: the dark file is a different, complete export of the same diagram (index still 1, labels present)', dl2 && dl2.name === 'Untitled_Document-diagram-1.svg' && dl2.text !== dl1.text && dark2.root.textContent.includes('Request details'));
  await evaluate(`document.documentElement.classList.remove('dark')`);

  // No menu elsewhere: normal preview text, the diagram's error box
  await rightClick('.markdown-preview p');
  await sleep(300);
  check('section 9: right-click on normal preview text does NOT offer "Download SVG"', (await menuItem()).visible === false);
  await rightClick('.markdown-preview .mermaid-diagram[data-mermaid="error"] .mermaid-diagram-error');
  await sleep(300);
  check('section 9: right-click on a diagram error box does NOT offer "Download SVG"', (await menuItem()).visible === false && (await evaluate(`!!document.querySelector('.markdown-preview .mermaid-diagram[data-mermaid="error"] .mermaid-diagram-error')`)));
  // Escape closes an open menu
  await rightClick('.markdown-preview .mermaid-diagram[data-mermaid="rendered"] svg');
  await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Download SVG')`, 3000);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  check('section 9: Escape closes the diagram menu without downloading', (await menuItem()).visible === false && (await evaluate('window.__svgDownloads.length')) === 2);

  // ---------- 10. Preview DOM stability and resize ----------
  // The preview's dangerouslySetInnerHTML object is memoised on the HTML
  // string (DocumentEditor previewInnerHtml): unrelated editor state changes
  // while in preview must leave the DOM - and the rendered <svg> elements -
  // untouched (no rebuild, no redraw from cache), while diagram scaling on
  // resize stays pure CSS and content/theme changes still re-render.
  const SVG_SEL = '.markdown-preview .mermaid-diagram[data-mermaid="rendered"] .mermaid-diagram-output > svg';
  await evaluate(`(() => {
    window.__stableSvg = document.querySelector(${JSON.stringify(SVG_SEL)});
    window.__diagramMutations = 0;
    const mo = new MutationObserver((ms) => { for (const m of ms) if (m.type === 'childList') window.__diagramMutations += m.addedNodes.length + m.removedNodes.length; });
    mo.observe(document.querySelector('.markdown-preview'), { childList: true });
    for (const d of document.querySelectorAll('.markdown-preview .mermaid-diagram')) mo.observe(d, { childList: true, subtree: true });
    window.__stabilityObserver = mo;
  })()`);
  const stability = () => evaluate(`({ connected: window.__stableSvg.isConnected, same: document.querySelector(${JSON.stringify(SVG_SEL)}) === window.__stableSvg, mutations: window.__diagramMutations })`);
  // Unrelated state changes: the diagram menu opened and closed twice, a
  // click on plain preview text, a synthetic window resize event.
  for (let i = 0; i < 2; i++) {
    await rightClick(SVG_SEL);
    await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Download SVG')`, 3000);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  await evaluate(`document.querySelector('.markdown-preview p').click(); window.dispatchEvent(new Event('resize'));`);
  await sleep(800);
  const stable1 = await stability();
  check('section 10: opening/closing the context menu, clicking preview text and a resize event leave the SAME <svg> connected (identity preserved, no childList mutations on the diagram containers)',
    stable1.connected && stable1.same && stable1.mutations === 0, JSON.stringify(stable1));

  // Viewport resize cycle: every diagram fits its pane and scales back up.
  const measure = () => evaluate(`(() => Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram-output')).map((out) => { const svg = out.querySelector('svg'); const pane = document.querySelector('.markdown-preview'); const paneInner = pane.clientWidth - parseFloat(getComputedStyle(pane).paddingLeft) - parseFloat(getComputedStyle(pane).paddingRight); const intrinsic = parseFloat(svg.style.maxWidth) || parseFloat(svg.getAttribute('viewBox').split(/\\s+/)[2]); return { width: Math.round(svg.getBoundingClientRect().width), height: Math.round(svg.getBoundingClientRect().height), out: Math.round(out.clientWidth), paneInner: Math.round(paneInner), intrinsic: Math.round(intrinsic), overflow: out.scrollWidth > out.clientWidth + 1 }; }))()`);
  const sizes = {};
  for (const width of [1400, 640, 1400, 520, 1400]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    sizes[width] = sizes[width] ? sizes[width].concat([await measure()]) : [await measure()];
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  const fits = (m) => m.every((d) => d.width <= d.out + 1 && d.width <= d.paneInner + 1 && !d.overflow && d.height > 0);
  const fills = (m) => m.every((d) => d.width >= Math.min(d.intrinsic, d.out) - 2);
  const allMeasures = Object.values(sizes).flat();
  check('section 10: at every viewport width (1400 -> 640 -> 1400 -> 520 -> 1400) each diagram stays within its pane (no overflow)', allMeasures.every(fits), JSON.stringify(sizes));
  check('section 10: diagrams scale DOWN in a narrow pane and back UP when widened (CSS max-width, no rebuild needed)',
    sizes[640][0][0].width < sizes[1400][0][0].width && sizes[1400][1][0].width === sizes[1400][0][0].width && sizes[520][0][0].width < sizes[640][0][0].width && sizes[1400][2][0].width === sizes[1400][0][0].width && allMeasures.every(fills),
    JSON.stringify({ wide: sizes[1400].map((m) => m[0].width), narrow640: sizes[640][0][0].width, narrow520: sizes[520][0][0].width }));
  const stable2 = await stability();
  check('section 10: the resize cycle did not rebuild the preview (same <svg>, no mutations)', stable2.connected && stable2.same && stable2.mutations === 0, JSON.stringify(stable2));

  // Theme toggle still re-renders (a new SVG) ...
  await evaluate(`document.documentElement.classList.add('dark')`);
  const rerenderedDark = await waitFor(`(() => { const e = document.querySelector('.markdown-preview .mermaid-diagram'); const svg = document.querySelector(${JSON.stringify(SVG_SEL)}); return e && e.dataset.mermaidTheme === 'dark' && svg && svg !== window.__stableSvg ? { mutations: window.__diagramMutations } : null; })()`, 20000);
  check('section 10: a theme toggle still re-renders the diagram (new dark <svg>, container mutated)', rerenderedDark && rerenderedDark.mutations > 0, JSON.stringify(rerenderedDark));
  await evaluate(`document.documentElement.classList.remove('dark')`);
  await waitFor(`(() => { const e = document.querySelector('.markdown-preview .mermaid-diagram'); return e && e.dataset.mermaidTheme === 'default'; })()`, 20000);
  await evaluate(`window.__stabilityObserver.disconnect()`);

  // ... and so does a content edit.
  check('section 10: preview closed to edit the diagram', await closePreview());
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await send('Input.insertText', { text: PASTEL_DOC.replace('P6[Archive case]', 'P6[Archived caseq]') });
  await sleep(1200);
  await evaluate(`document.querySelector('button[title="Preview"]').click()`);
  const editedLabel = await waitFor(`(() => { const svg = document.querySelector(${JSON.stringify(SVG_SEL)}); return svg && /Archived caseq/.test(svg.textContent) ? true : null; })()`, 20000);
  check('section 10: a content edit still re-renders the diagram with the new label', editedLabel === true);

  // ---------- 11. The exported SVG opened STANDALONE, outside the app ----------
  // Earlier checks parsed the export but never rendered it on its own. Open
  // each export in a fresh Chrome page (a new CDP target navigated to a
  // data: URL - no app, no app CSS) and compare the edge paths, markers,
  // node shapes and labels with the in-app computed styles; then remove the
  // embedded stylesheet and compare again, which is what a consumer that
  // ignores CSS (Adobe Illustrator's importer) effectively sees.
  const STYLE_REPORT = `(() => {
    const cs = (el) => getComputedStyle(el);
    const svg = document.querySelector('svg');
    if (!svg) return null;
    // In-app: the marker definition the edge references. Standalone export: the
    // arrowhead baked as a plain group right after the edge (Illustrator
    // collapses any path that carries a marker reference).
    const markerOf = (el) => { const a = el.getAttribute('marker-end') || el.getAttribute('marker-start'); if (a) { const id = a.replace(/^url\\((['"]?)#?/, '').replace(/['"]?\\)$/, ''); const m = document.getElementById(id); const p = m && m.querySelector('path, circle'); return { resolves: !!m, fill: p ? cs(p).fill : null }; } const g = el.nextElementSibling; if (g && g.classList.contains('mermaid-export-marker')) { const p = g.querySelector('path, circle'); return { resolves: true, baked: true, fill: p ? cs(p).fill : null }; } return null; };
    const edges = Array.from(svg.querySelectorAll('path.flowchart-link, line.messageLine0, line.messageLine1')).map((el) => ({ cls: (el.getAttribute('class') || '').replace(/edge-thickness-normal edge-pattern-solid /, '').slice(0, 40), stroke: cs(el).stroke, width: cs(el).strokeWidth, fill: cs(el).fill, marker: markerOf(el) }));
    const shapes = Array.from(svg.querySelectorAll('g.node > rect, g.node > polygon, g.node > path, rect.actor')).map((el) => ({ fill: cs(el).fill, stroke: cs(el).stroke }));
    const labels = Array.from(svg.querySelectorAll('g.node .label text, text.actor')).map((el) => cs(el).fill);
    const actorsPainted = Array.from(svg.querySelectorAll('rect.actor')).map((r) => { const b = r.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 3); return !!hit && (hit === r || r.contains(hit) || (hit.closest && hit.closest('g') === r.closest('g'))); });
    // Every leaf's computed paint, for a whole-tree equivalence check
    // (marker definitions exist only in-app, baked arrowheads only in the export - both left out so the lists pair up)
    // Dash arrays are compared after the normalisation the export applies:
    // mermaid's draw-in animation pattern "0 0 <length> 4" IS a solid line,
    // "dash 0" is solid, and a repeated two-value unit with a tail is the unit.
    const normDash = (d) => { if (!d || d === 'none') return 'none'; const parts = d.split(/[\\s,]+/).filter(Boolean).map(parseFloat); let zeros = 0; while (parts.length >= 2 && parts[0] === 0 && parts[1] === 0) { parts.splice(0, 2); zeros++; } if (!parts.length || parts.every((v) => v === 0)) return 'none'; if (parts.length === 2 && (parts[1] === 0 || zeros)) return 'none'; if (parts.length >= 4) { const [a, b] = parts; const body = parts.length % 2 ? parts.slice(0, -1) : parts; if (body.every((v, i) => v === (i % 2 ? b : a))) return a + ' ' + b; } return parts.join(' '); };
    // Paint is compared as EFFECTIVE colour: the export folds an rgba() alpha
    // into fill-opacity / stroke-opacity (rgba(232,232,232,.8) -> #e8e8e8 + 0.8).
    const paint = (colour, opacity) => { const m = String(colour).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/); if (!m) return colour + '@' + opacity; return 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')@' + ((m[4] === undefined ? 1 : parseFloat(m[4])) * parseFloat(opacity)).toFixed(3); };
    const leaves = Array.from(svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text, tspan')).filter((el) => !el.classList.contains('mermaid-export-background') && !el.closest('marker') && !el.closest('g.mermaid-export-marker')).map((el) => { const c = cs(el); return [el.tagName, paint(c.fill, c.fillOpacity), paint(c.stroke, c.strokeOpacity), c.strokeWidth, normDash(c.strokeDasharray), c.opacity, c.fontSize, c.fontWeight, c.textAnchor].join('|'); });
    const strict = { styleElements: svg.querySelectorAll('style').length, styleAttrs: svg.querySelectorAll('[style]').length, filters: svg.querySelectorAll('filter, [filter]').length, dataAttrs: Array.from(svg.querySelectorAll('*')).filter((el) => Array.from(el.attributes).some((a) => /^data-/.test(a.name))).length,
      markerRefs: svg.querySelectorAll('[marker-end], [marker-start], [marker-mid]').length, markerDefs: svg.querySelectorAll('marker').length, bakedArrowheads: svg.querySelectorAll('g.mermaid-export-marker').length,
      edgeAttrs: Array.from(svg.querySelectorAll('path.flowchart-link, line.messageLine0, line.messageLine1')).map((el) => ({ cls: el.getAttribute('class') || '', stroke: el.getAttribute('stroke'), fill: el.getAttribute('fill'), width: el.getAttribute('stroke-width'), dash: el.getAttribute('stroke-dasharray'), offset: el.getAttribute('stroke-dashoffset') })) };
    return { edges, shapes, labels, actorsPainted, leaves, strict };
  })()`;
  const visibleStroke = (e) => e.stroke && e.stroke !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(e.stroke) && parseFloat(e.width) > 0;
  const sameStyles = (a, b) => a && b && a.edges.length === b.edges.length && a.edges.every((e, i) => e.stroke === b.edges[i].stroke && e.width === b.edges[i].width && e.fill === b.edges[i].fill && (!e.marker || (b.edges[i].marker && e.marker.fill === b.edges[i].marker.fill)))
    && a.shapes.length === b.shapes.length && a.shapes.every((s, i) => s.fill === b.shapes[i].fill && s.stroke === b.shapes[i].stroke)
    && a.labels.length === b.labels.length && a.labels.every((l, i) => l === b.labels[i]);
  const inAppReport = (i) => evaluate(STYLE_REPORT.replace("document.querySelector('svg')", `document.querySelectorAll('.markdown-preview .mermaid-diagram')[${i}].querySelector('svg')`));
  const exportNth = async (i) => {
    const count = await evaluate('window.__svgDownloads.length');
    await evaluate(`(() => { const el = document.querySelectorAll('.markdown-preview .mermaid-diagram')[${i}].querySelector('svg'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 20, view: window })); })()`);
    await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Download SVG')`, 3000);
    await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Download SVG').click()`);
    for (let k = 0; k < 20; k++) { const r = await readSvg(count); if (r) return r; await sleep(200); }
    return null;
  };
  // A second, app-free page for the standalone render
  const openStandalone = async (svgText) => electronApp.app.evaluate(async ({ BrowserWindow }, { svgText: svg, report }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await w.loadURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      await new Promise((r) => setTimeout(r, 800));
      const withCss = await w.webContents.executeJavaScript(report, true);
      await w.webContents.executeJavaScript(`document.querySelectorAll('style').forEach((s) => s.remove()); true`, true);
      await new Promise((r) => setTimeout(r, 200));
      const withoutCss = await w.webContents.executeJavaScript(report, true);
      const isSvgDoc = await w.webContents.executeJavaScript(`document.documentElement.tagName === 'svg' && !document.querySelector('parsererror')`, true);
      return { withCss, withoutCss, isSvgDoc };
    } finally {
      w.destroy();
    }
  }, { svgText, report: STYLE_REPORT });

  const RSVG = ['/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert', '/usr/bin/rsvg-convert'].find((p) => existsSync(p)) || null;
  let rsvgNoted = false;
  const DIAGRAMS = [[0, 'flowchart'], [2, 'sequence']];
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`);
    const ready = await waitFor(`(() => { const els = Array.from(document.querySelectorAll('.markdown-preview .mermaid-diagram')); return els.length === 3 && [0, 2].every((i) => els[i].dataset.mermaid === 'rendered' && els[i].dataset.mermaidTheme === '${theme === 'dark' ? 'dark' : 'default'}'); })()`, 30000);
    check(`section 11 (${theme}): flowchart and sequence diagrams rendered in the ${theme} theme`, ready === true);
    for (const [i, kind] of DIAGRAMS) {
      const inApp = await inAppReport(i);
      const file = await exportNth(i);
      check(`section 11 (${theme}, ${kind}): exported via the menu`, !!file && file.type === 'image/svg+xml', file ? file.name : 'no download');
      if (!file) continue;
      const standalone = await openStandalone(file.text);
      const w = standalone.withCss, wo = standalone.withoutCss;
      check(`section 11 (${theme}, ${kind}): opens standalone as an SVG document with ${inApp.edges.length} edges`, standalone.isSvgDoc && w && w.edges.length === inApp.edges.length && inApp.edges.length >= 2, w ? `${w.edges.length} edges` : 'no report');
      check(`section 11 (${theme}, ${kind}): every edge has a visible stroke standalone (not none/transparent, width > 0) equal to the in-app stroke/width/fill`,
        w && w.edges.every(visibleStroke) && sameStyles(inApp, w), JSON.stringify(w && w.edges.map((e) => [e.cls, e.stroke, e.width, e.fill])));
      check(`section 11 (${theme}, ${kind}): every in-app marker reference became a baked arrowhead group standalone, with the in-app marker fill`,
        w && inApp.edges.filter((e) => e.marker).length >= 1 && w.edges.every((e, k) => (!inApp.edges[k].marker && !e.marker) || (e.marker && e.marker.baked && e.marker.fill === inApp.edges[k].marker.fill && e.marker.fill !== 'none')), JSON.stringify(w && w.edges.map((e) => e.marker)));
      check(`section 11 (${theme}, ${kind}): with the embedded stylesheet REMOVED (CSS-less viewer) edges, arrowheads, shapes and labels still match the in-app styles`,
        wo && wo.edges.every(visibleStroke) && sameStyles(inApp, wo), JSON.stringify(wo && { edges: wo.edges.map((e) => [e.stroke, e.width, e.fill]), labels: wo.labels.slice(0, 3) }));
      if (kind === 'sequence') {
        check(`section 11 (${theme}, sequence): the actor boxes are painted standalone (not hidden under the background rect)`, w && w.actorsPainted.length === 4 && w.actorsPainted.every(Boolean), JSON.stringify(w && w.actorsPainted));
      }
      // Whole-tree equivalence: every leaf's computed paint/text values
      // standalone (no stylesheet at all in the file) equal the in-app ones.
      const leafDiff = w ? w.leaves.map((l, k) => [l, inApp.leaves[k]]).filter(([a, b]) => a !== b) : null;
      check(`section 11 (${theme}, ${kind}): EVERY leaf's computed fill/stroke/width/dash/opacity/font standalone equals the in-app value (${inApp.leaves.length} leaves) - browser rendering unchanged without the stylesheet`,
        leafDiff && leafDiff.length === 0 && w.leaves.length === inApp.leaves.length, leafDiff ? `${leafDiff.length} differ, e.g. ${JSON.stringify(leafDiff.slice(0, 2))}` : '');
      // Strict-importer facts about the file itself
      const st = w && w.strict;
      const solid = st ? st.edgeAttrs.filter((e) => !/dotted|dashed|messageLine1/.test(e.cls)) : [];
      const dotted = st ? st.edgeAttrs.filter((e) => /dotted|dashed|messageLine1/.test(e.cls)) : [];
      check(`section 11 (${theme}, ${kind}): strict importer - no <style>, no style attributes, no filters, no data-* attributes, no marker references or <marker> definitions (arrowheads are plain baked shapes)`,
        st && st.styleElements === 0 && st.styleAttrs === 0 && st.filters === 0 && st.dataAttrs === 0 && st.markerRefs === 0 && st.markerDefs === 0 && st.bakedArrowheads >= inApp.edges.filter((e) => e.marker).length,
        JSON.stringify(st && { style: st.styleElements, styleAttrs: st.styleAttrs, filters: st.filters, data: st.dataAttrs, markerRefs: st.markerRefs, markerDefs: st.markerDefs, baked: st.bakedArrowheads }));
      check(`section 11 (${theme}, ${kind}): strict importer - every edge carries explicit hex stroke, fill="none" and stroke-width attributes`,
        st && st.edgeAttrs.length >= 2 && st.edgeAttrs.every((e) => /^#[0-9a-f]{6}$/i.test(e.stroke || '') && e.fill === 'none' && parseFloat(e.width) > 0), JSON.stringify(st && st.edgeAttrs.map((e) => [e.stroke, e.fill, e.width])));
      check(`section 11 (${theme}, ${kind}): strict importer - solid edges have NO dasharray/dashoffset; dotted/dashed ones a plain repeating pattern`,
        st && solid.length >= 1 && solid.every((e) => e.dash === null && e.offset === null) && dotted.every((e) => /^\d+(\.\d+)?( \d+(\.\d+)?)*$/.test(e.dash || '')), JSON.stringify(st && st.edgeAttrs.map((e) => [e.cls.slice(0, 26), e.dash, e.offset])));
      // Independent renderer (librsvg): the edges must contribute pixels.
      if (RSVG) {
        const dir = mkdtempSync(path.join(tmpdir(), 'mermaid-rsvg-'));
        try {
          const withEdges = path.join(dir, 'a.svg');
          const noEdges = path.join(dir, 'b.svg');
          writeFileSync(withEdges, file.text);
          writeFileSync(noEdges, file.text.replace(/<path[^>]*flowchart-link[^>]*\/>|<path[^>]*flowchart-link[^>]*>[\s\S]*?<\/path>|<line[^>]*messageLine[01][^>]*\/>/g, ''));
          const pngA = execFileSync(RSVG, ['-b', theme === 'dark' ? '#1e1e1e' : 'white', withEdges]);
          const pngB = execFileSync(RSVG, ['-b', theme === 'dark' ? '#1e1e1e' : 'white', noEdges]);
          check(`section 11 (${theme}, ${kind}): librsvg (rsvg-convert) renders the file, and removing the edge elements changes the raster (the lines are drawn)`,
            pngA.length > 1000 && pngB.length > 1000 && !pngA.equals(pngB), `png ${pngA.length} vs ${pngB.length} bytes`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } else if (!rsvgNoted) {
        rsvgNoted = true;
        console.log('SKIP: rsvg-convert not installed - independent librsvg render check skipped (brew install librsvg / apt install librsvg2-bin)');
      }
    }
  }
  await evaluate(`document.documentElement.classList.remove('dark')`);

  check('no uncaught exceptions in the page', errors.length === 0, errors.slice(0, 3).join(' || '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
