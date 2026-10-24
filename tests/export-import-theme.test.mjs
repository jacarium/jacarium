#!/usr/bin/env node

/**
 * Real-browser check that the export progress window and the global DB
 * import modal are readable in BOTH themes
 * (src/components/common/ExportProgressModal.jsx,
 * src/components/common/modals/ImportDBModal.jsx, the shared .os-terminal
 * pane + --os-terminal-* tokens in src/index.css).
 *
 * THE BUG: the export log pane was a hard-coded dark "terminal" (#1e1e1e)
 * in both themes - in the light theme it sat as a black block in a white
 * modal, its timestamps/placeholder used the light-theme muted grey
 * (#8A8D93) on near-black, and the light-theme scrollbar (dark thumb) was
 * invisible on it. The import modal's notes/hints used the muted token
 * (3.3:1 on white) and its "Import Error" / "Warning" titles had no dark
 * variant (near-black red/yellow on a dark tinted box).
 *
 * THE FIX: the pane follows the theme like every other surface in the app
 * (light pane / dark text in the light theme, the classic dark pane in the
 * dark theme) through one shared .os-terminal definition driven by CSS
 * tokens on :root / .dark - the same mechanism as the --os-* tokens. The
 * import modal's help text uses the secondary text token and the callout
 * titles got dark: variants.
 *
 * What this proves, in headless Chrome against tests/helpers/theme-harness.html
 * (the REAL modals with synthetic data, served by a Vite dev server; nothing
 * touches IndexedDB or the network), for the light AND the dark theme:
 *   - the export log pane's surface matches the theme (light in light, dark
 *     in dark) and has a visible border against the modal;
 *   - every log line (info, warning, success, error), every timestamp and
 *     the "Export Log" label measure >= 4.5:1 (WCAG AA) against the surface
 *     they actually sit on (ancestor backgrounds alpha-composited);
 *   - the failed-export error box text is >= 4.5:1;
 *   - in the import modal: the drop-zone text, the merge-mode option label
 *     and its hint, the summary rows and "Exported on" line, the Warning and
 *     Merge Mode callouts (title + body) and the Import Error callout (title
 *     + message) all measure >= 4.5:1.
 * It also saves a screenshot of every state in every theme (see below) for
 * eyeballing.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/export-import-theme.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5217),
 *   THEME_SHOTS_DIR (where PNGs go; default <os tmpdir>/jacarium-theme-shots)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5217);
const SHOTS_DIR = process.env.THEME_SHOTS_DIR || path.join(tmpdir(), 'jacarium-theme-shots');
const MIN_RATIO = 4.5;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// Installed once in the page: colour parsing, WCAG contrast and an
// "effective background" that composites every ancestor's background.
const PROBE = `(() => {
  if (window.__probe) return true;
  // every colour syntax Chrome reports (rgb, oklch, oklab, color(), color-mix results) through the shared helper
  const parse = ${COLOR_PROBE}.parse;
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))).concat([1]); };
  const effectiveBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
    }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const measure = (el) => {
    const color = parse(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    return { color: color.slice(0, 3), bg: bg.slice(0, 3), ratio: Number(contrast(over(color, bg), bg).toFixed(2)) };
  };
  const leaf = (re, root = document) => Array.from(root.querySelectorAll('*'))
    .filter((e) => e.children.length === 0 && re.test(e.textContent || '')
      && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0)
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  window.__probe = { parse, lum, contrast, effectiveBg, measure, leaf };
  return true;
})()`;

/** Contrast of the first visible leaf element matching `re` against what it sits on. */
async function textContrast(app, re, root = 'document') {
  return app.evaluate(`(() => { const el = window.__probe.leaf(${re.toString()}, ${root}); if (!el) return null; return window.__probe.measure(el); })()`);
}

function checkText(theme, label, m) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${MIN_RATIO}:1`, m.ratio >= MIN_RATIO, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
}

async function screenshot(app, name) {
  // The import modal body scrolls (max-h-[70vh]); show its lower part (merge
  // toggle + callouts) rather than the summary list
  await app.evaluate(`document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = el.scrollHeight; })`);
  await sleep(100);
  const r = await app.send('Page.captureScreenshot', { format: 'png' });
  const data = r.result?.data;
  if (!data) return null;
  const file = path.join(SHOTS_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function waitText(app, re, timeoutMs = 10000) {
  return app.waitFor(`!!window.__probe.leaf(${re.toString()})`, timeoutMs);
}

async function dropFile(app, { json, name, type }) {
  return app.evaluate(`(() => {
    const zone = Array.from(document.querySelectorAll('div')).find((d) => d.classList.contains('border-dashed') && /Drag and drop your database export file here/.test(d.textContent));
    if (!zone) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(json)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function runTheme(app, theme) {
  const dark = theme === 'dark';
  await app.evaluate(`window.__harness.setDark(${dark})`);
  await sleep(150);

  // ---- Export: successful job (info + warning + success lines) ----
  await app.evaluate(`window.__harness.showExport('ok')`);
  const done = await waitText(app, /^Export Complete$/);
  check(`${theme}: export modal reached "Export Complete"`, !!done);

  const pane = await app.evaluate(`(() => {
    const p = document.querySelector('.os-terminal');
    if (!p) return null;
    const cs = getComputedStyle(p);
    const bg = window.__probe.parse(cs.backgroundColor);
    const border = window.__probe.parse(cs.borderTopColor);
    const modalBg = window.__probe.effectiveBg(p.parentElement);
    const lines = Array.from(p.children).filter((c) => c.textContent.trim()).map((c) => ({ text: c.textContent.trim().slice(0, 60), cls: c.className, ...window.__probe.measure(c) }));
    const stamps = Array.from(p.querySelectorAll('.os-terminal-muted')).map((c) => window.__probe.measure(c));
    return {
      bgLum: window.__probe.lum(bg), bg: bg.slice(0, 3),
      borderVsModal: window.__probe.contrast(border, modalBg), borderVsPane: window.__probe.contrast(border, bg), borderWidth: cs.borderTopWidth,
      colorScheme: cs.colorScheme, lines, stamps,
      types: { warning: !!p.querySelector('.os-terminal-warning'), success: !!p.querySelector('.os-terminal-success') },
    };
  })()`);
  if (!pane) {
    check(`${theme}: .os-terminal pane rendered`, false);
  } else {
    check(`${theme}: log pane surface follows the theme`, dark ? pane.bgLum < 0.1 : pane.bgLum > 0.5, `rgb(${pane.bg}), luminance ${pane.bgLum.toFixed(3)}`);
    check(`${theme}: log pane has a visible border`, pane.borderWidth !== '0px' && pane.borderVsPane > 1.15, `${pane.borderWidth}, border/pane ${pane.borderVsPane.toFixed(2)}:1`);
    check(`${theme}: log pane color-scheme matches theme`, pane.colorScheme === (dark ? 'dark' : 'light'), pane.colorScheme);
    check(`${theme}: warning and success lines rendered`, pane.types.warning && pane.types.success);
    for (const l of pane.lines) {
      check(`${theme}: log line "${l.text}" >= ${MIN_RATIO}:1`, l.ratio >= MIN_RATIO, `${l.ratio}:1, rgb(${l.color}) on rgb(${l.bg})`);
    }
    check(`${theme}: timestamps >= ${MIN_RATIO}:1`, pane.stamps.length > 0 && pane.stamps.every((s) => s.ratio >= MIN_RATIO), pane.stamps.map((s) => s.ratio).join(', '));
  }
  checkText(theme, '"Export Log" label', await textContrast(app, /^Export Log$/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-export-ok`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Export: failing job (error box + error log line) ----
  await app.evaluate(`window.__harness.showExport('fail')`);
  check(`${theme}: export modal reached "Export Failed"`, !!(await waitText(app, /^Export Failed$/)));
  const errLine = await app.evaluate(`(() => { const e = document.querySelector('.os-terminal .os-terminal-error'); return e ? window.__probe.measure(e) : null; })()`);
  checkText(theme, 'error log line', errLine);
  checkText(theme, 'error summary box', await textContrast(app, /Synthetic failure/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-export-fail`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Import: drop zone, preview, warning callout ----
  await app.evaluate(`window.__harness.showImport()`);
  check(`${theme}: import modal opened`, !!(await waitText(app, /^Import Database$/)));
  checkText(theme, 'drop-zone text', await textContrast(app, /Drag and drop your database export file here/));
  checkText(theme, 'drop-zone "or"', await textContrast(app, /^or$/));
  const json = await app.evaluate(`window.__harness.importFixtureJson`);
  check(`${theme}: dropped synthetic backup`, await dropFile(app, { json, name: 'backup.json', type: 'application/json' }));
  check(`${theme}: preview shown`, !!(await waitText(app, /^Import Summary:$/)));
  checkText(theme, 'summary row', await textContrast(app, /\bdocuments$/));
  checkText(theme, '"Exported on" line', await textContrast(app, /^Exported on:/));
  checkText(theme, 'merge option label', await textContrast(app, /^Keep existing data and merge newer records$/));
  checkText(theme, 'merge option hint', await textContrast(app, /Nothing is deleted\./));
  checkText(theme, 'Warning callout title', await textContrast(app, /^Warning$/));
  checkText(theme, 'Warning callout body', await textContrast(app, /This will replace all existing data/));
  checkText(theme, 'summary TaskWarrior tasks row', await textContrast(app, /TaskWarrior tasks in 2 instances/));
  checkText(theme, 'Warning callout TaskWarrior line', await textContrast(app, /only the app's local task cache is replaced/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-preview`)}`);

  // ---- Import: merge mode callout ----
  await app.evaluate(`document.querySelector('input[type="checkbox"]').click()`);
  check(`${theme}: merge callout shown`, !!(await waitText(app, /^Merge Mode$/)));
  checkText(theme, 'Merge Mode callout title', await textContrast(app, /^Merge Mode$/));
  checkText(theme, 'Merge Mode callout body', await textContrast(app, /Your existing data will be kept/));
  checkText(theme, 'Merge Mode callout TaskWarrior line', await textContrast(app, /applied\s+through the TaskWarrior CLI/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-merge`)}`);

  // ---- Import: Dry Run statistics block ----
  // The harness's onDryRun resolves with a synthetic runImport() result that
  // has counts, sample labels and two invalid rows with reasons; every text
  // in the block must clear AA on the card surface it sits on.
  const clickedDryRun = await app.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^Dry Run$/.test(x.textContent.trim()));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  check(`${theme}: Dry Run button present and enabled beside Import`, clickedDryRun);
  check(`${theme}: dry-run statistics shown`, !!(await waitText(app, /nothing was written/)));
  const statsRoot = `document.querySelector('[data-testid="import-stats"]')`;
  checkText(theme, 'dry-run title', await textContrast(app, /nothing was written/, statsRoot));
  checkText(theme, 'dry-run headline', await textContrast(app, /would be added/, statsRoot));
  checkText(theme, 'dry-run review hint', await textContrast(app, /Review the numbers below/, statsRoot));
  checkText(theme, 'stats table header', await textContrast(app, /^Type$/, statsRoot));
  checkText(theme, 'stats type label', await textContrast(app, /^Documents$/, statsRoot));
  checkText(theme, 'stats sample line', await textContrast(app, /^e\.g\. /, statsRoot));
  checkText(theme, 'stats non-zero count cell', await textContrast(app, /^1$/, statsRoot));
  checkText(theme, 'stats zero count cell', await textContrast(app, /^0$/, statsRoot));
  // Per-instance TaskWarrior rows (format-2 backups): label, the transport +
  // breakdown line, the "needs a data path" line and the status note.
  checkText(theme, 'tasks row label (Work)', await textContrast(app, /^Tasks: Work$/, statsRoot));
  checkText(theme, 'tasks row label (Remote)', await textContrast(app, /^Tasks: Remote$/, statsRoot));
  const taskDetails = await app.evaluate(`(() => Array.from(${statsRoot}.querySelectorAll('[data-testid="import-stats-task-detail"]')).map((el) => ({ text: el.textContent, ...window.__probe.measure(el) })))()`);
  check(`${theme}: two task detail lines rendered (CLI + needs-a-data-path)`,
    Array.isArray(taskDetails) && taskDetails.length === 2 && /via TaskWarrior CLI: 3 new, 1 updated \(newer\), 4 unchanged, 1 deleted \(tombstone would be applied\), 1 skipped \(deleted here\)/.test(taskDetails[0]?.text || '') && /needs a data path/.test(taskDetails[1]?.text || ''),
    JSON.stringify(taskDetails?.map((d) => d.text)));
  for (const d of taskDetails || []) {
    checkText(theme, `task detail line "${d.text.slice(0, 40)}..."`, d);
  }
  const noteLine = await app.evaluate(`(() => { const el = ${statsRoot}.querySelector('[data-testid="import-stats-note"]'); return el ? window.__probe.measure(el) : null; })()`);
  checkText(theme, 'tasks status note', noteLine);
  // The title <p> holds an icon plus text, so it is not a leaf: measure it directly.
  const invalidTitle = await app.evaluate(`(() => {
    const p = Array.from(${statsRoot}.querySelectorAll('p')).find((x) => /cannot be imported$/.test(x.textContent.trim()));
    return p ? window.__probe.measure(p) : null;
  })()`);
  checkText(theme, 'invalid records title', invalidTitle);
  checkText(theme, 'invalid record type prefix', await textContrast(app, /^Kanban cards:$/, statsRoot));
  checkText(theme, 'invalid record label', await textContrast(app, /^Orphan Card$/, statsRoot));
  const reasonLine = await app.evaluate(`(() => {
    const li = Array.from(${statsRoot}.querySelectorAll('li')).find((l) => /not in the import file/.test(l.textContent));
    return li ? window.__probe.measure(li) : null;
  })()`);
  checkText(theme, 'invalid record reason', reasonLine);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-dry-run`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Import: error callout ----
  await app.evaluate(`window.__harness.showImport()`);
  await waitText(app, /^Import Database$/);
  check(`${theme}: dropped a non-JSON file`, await dropFile(app, { json: 'not json', name: 'notes.txt', type: 'text/plain' }));
  check(`${theme}: error callout shown`, !!(await waitText(app, /^Import Error$/)));
  checkText(theme, 'Import Error title', await textContrast(app, /^Import Error$/));
  checkText(theme, 'Import Error message', await textContrast(app, /Please drop a JSON file/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-error`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'theme-harness-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await app.send('Page.navigate', { url: `http://localhost:${PORT}/tests/helpers/theme-harness.html` });
    const ready = await app.waitFor(`window.__harnessReady === true`, 30000);
    check('harness page loaded', !!ready);
    if (!ready) throw new Error('theme harness did not load');
    await app.evaluate(PROBE);

    for (const theme of ['light', 'dark']) {
      console.log(`\n--- ${theme} theme ---`);
      await runTheme(app, theme);
    }

    const pageErrors = app.errors.filter((e) => !/ResizeObserver loop/.test(e));
    check('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS_DIR}`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
