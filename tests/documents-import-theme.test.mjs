#!/usr/bin/env node

/**
 * Real-browser check that the Documents "Import from JSON" flow
 * (src/components/common/ImportFlow.jsx -> ImportInputModal.jsx and
 * ImportModal.jsx under src/components/features/documents/) is readable in
 * BOTH themes.
 *
 * THE BUGS: the paste textarea had no surface/text colour of its own (it
 * inherited the modal's, with Tailwind's default grey placeholder), the
 * "N lines" badge used the muted text token (3.3:1 on white), the upload
 * drop zone was permanently blue-tinted in the dark theme (a `dark:bg-`
 * class where a `dark:hover:bg-` was meant) and its "or drag and drop"
 * promise had no drop handler, the validation error/success callouts had
 * no dark variants for their body text (near-black red/green on a dark
 * tinted box), the header icon circles stayed light blue in the dark theme,
 * and in the progress modal the result counts (green-600 / red-600 at 18px)
 * fell short of 4.5:1 on the light card and the in-progress bar fill was
 * under 3:1 against its track in the dark theme.
 *
 * What this proves, in headless Chrome against
 * tests/helpers/documents-import-harness.html (the REAL modals driven by the
 * real useImportFlow hook and the real validateDocumentsImport, synthetic
 * data, served by a Vite dev server; nothing touches IndexedDB or the
 * network), for the light AND the dark theme:
 *   - input modal, paste mode: title, help text, both tabs, the "JSON Data"
 *     label, "Paste Example", the textarea's placeholder and typed text, the
 *     textarea's line-count badge, Cancel - all >= 4.5:1 (the former
 *     "Expected Format" sample section is gone)
 *     against what they sit on; the textarea surface follows the theme and
 *     has a visible border against the modal;
 *   - validation feedback: the error callout (single-object paste, invalid
 *     JSON) title + message;
 *   - Dry Run: the shared statistics block (title, headline, hint, table
 *     headers, Documents / per-category / Images rows, sample lines, count
 *     cells, the same-title and renamed-image notes, invalid records with
 *     reasons) in the input modal, cleared again when the input changes;
 *   - the real hand-over: "Import Documents" reaches the progress modal,
 *     "Import Complete" and the same statistics block, then Close;
 *   - input modal, file mode: the drop-zone texts (idle and while a file is
 *     dragged over), the chosen file's chip (name, size, "Choose different
 *     file", Remove) and the non-JSON drop error - there is no content
 *     preview any more;
 *   - the merge checkbox (shared with the database import): its label and
 *     hint in both states, and a merge-mode dry run with the Replaced /
 *     Completed / Unchanged columns and the locked note;
 *   - progress modal: header, subtitle, progress label/counts, Import Log
 *     label, every log line and timestamp, the statistics block (with the
 *     invalid-records list after a partial failure), Close/Cancel - in the
 *     all-ok, partial-failure, all-failed and still-running states; the
 *     bar fill is >= 3:1 against its track.
 * Primary (blue) buttons are measured and printed as INFO only: white on
 * the app-wide --os-blue is an app-wide token choice, not this modal's.
 * It also saves a screenshot of every state in every theme for eyeballing.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/documents-import-theme.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5232),
 *   THEME_SHOTS_DIR (where PNGs go; default <os tmpdir>/jacarium-theme-shots)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5232);
const SHOTS_DIR = process.env.THEME_SHOTS_DIR || path.join(tmpdir(), 'jacarium-theme-shots');
const MIN_RATIO = 4.5;
const MIN_UI_RATIO = 3;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function info(name, detail) {
  console.log(`INFO  ${name}  (${detail})`);
}

// Installed once in the page: colour parsing, WCAG contrast, an "effective
// background" that composites every ancestor's background, and element
// finders (same recipe as tests/export-import-theme.test.mjs).
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
  const measure = (el, color = parse(getComputedStyle(el).color)) => {
    const bg = effectiveBg(el);
    return { color: color.slice(0, 3), bg: bg.slice(0, 3), ratio: Number(contrast(over(color, bg), bg).toFixed(2)) };
  };
  const visible = (e) => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  const leaf = (re, root = document) => Array.from(root.querySelectorAll('*'))
    .filter((e) => e.children.length === 0 && re.test(e.textContent || '') && visible(e))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  // Smallest visible element of the given tag whose own text matches
  // (buttons carry an icon, so they are never leaves).
  const byText = (re, tag = '*', root = document) => Array.from(root.querySelectorAll(tag))
    .filter((e) => re.test((e.textContent || '').trim()) && visible(e))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  window.__probe = { parse, lum, contrast, over, effectiveBg, measure, leaf, byText };
  return true;
})()`;

async function textContrast(app, re, root = 'document') {
  return app.evaluate(`(() => { const el = window.__probe.leaf(${re.toString()}, ${root}); if (!el) return null; return window.__probe.measure(el); })()`);
}
async function elementContrast(app, re, tag = '*') {
  return app.evaluate(`(() => { const el = window.__probe.byText(${re.toString()}, ${JSON.stringify(tag)}); if (!el) return null; return window.__probe.measure(el); })()`);
}
function checkText(theme, label, m, min = MIN_RATIO) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${min}:1`, m.ratio >= min, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
}
function infoText(theme, label, m) {
  info(`${theme}: ${label}`, m ? `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})` : 'element not found');
}

async function screenshot(app, name) {
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
async function clickButton(app, re) {
  return app.evaluate(`(() => { const b = window.__probe.byText(${re.toString()}, 'button'); if (!b || b.disabled) return false; b.click(); return true; })()`);
}
/** Type into the paste textarea the way React sees it (native setter + input event). */
async function setTextarea(app, text) {
  return app.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function dropOnZone(app, { text, name, type }) {
  return app.evaluate(`(() => {
    const zone = document.querySelector('[data-testid="import-drop-zone"]');
    if (!zone) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
}

/** The .os-terminal pane inside the open modal: surface, border, every line. */
async function readPane(app, selector = '.os-terminal') {
  return app.evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(selector)});
    if (!p) return null;
    const cs = getComputedStyle(p);
    const bg = window.__probe.parse(cs.backgroundColor);
    const border = window.__probe.parse(cs.borderTopColor);
    const outside = window.__probe.effectiveBg(p.parentElement);
    const lines = Array.from(p.children).filter((c) => c.textContent.trim()).map((c) => ({ text: c.textContent.trim().slice(0, 70), ...window.__probe.measure(c) }));
    const stamps = Array.from(p.querySelectorAll('.os-terminal-muted')).map((c) => window.__probe.measure(c));
    return {
      bgLum: window.__probe.lum(bg), bg: bg.slice(0, 3),
      borderVsPane: window.__probe.contrast(border, bg), borderVsOutside: window.__probe.contrast(border, outside), borderWidth: cs.borderTopWidth,
      colorScheme: cs.colorScheme, lines, stamps,
      text: window.__probe.measure(p),
    };
  })()`);
}

async function checkProgressModal(app, theme, tag, { expectHeader, expectFailed = false }) {
  checkText(theme, `${tag}: header "${expectHeader}"`, await textContrast(app, new RegExp(`^${expectHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)));
  checkText(theme, `${tag}: subtitle "N documents to import"`, await textContrast(app, /documents? to import$/));
  checkText(theme, `${tag}: "Import Log" label`, await textContrast(app, /^Import Log$/));
  const pane = await readPane(app);
  if (!pane) {
    check(`${theme}: ${tag}: log pane rendered`, false);
  } else {
    const dark = theme === 'dark';
    check(`${theme}: ${tag}: log pane surface follows the theme`, dark ? pane.bgLum < 0.1 : pane.bgLum > 0.5, `rgb(${pane.bg})`);
    check(`${theme}: ${tag}: log pane has a visible border`, pane.borderWidth !== '0px' && pane.borderVsPane > 1.15, `${pane.borderWidth}, border/pane ${pane.borderVsPane.toFixed(2)}:1`);
    check(`${theme}: ${tag}: log has lines`, pane.lines.length > 0, String(pane.lines.length));
    for (const l of pane.lines) {
      check(`${theme}: ${tag}: log line "${l.text}" >= ${MIN_RATIO}:1`, l.ratio >= MIN_RATIO, `${l.ratio}:1, rgb(${l.color}) on rgb(${l.bg})`);
    }
    check(`${theme}: ${tag}: timestamps >= ${MIN_RATIO}:1`, pane.stamps.length > 0 && pane.stamps.every((s) => s.ratio >= MIN_RATIO), pane.stamps.map((s) => s.ratio).join(', '));
  }
  const bar = await app.evaluate(`(() => {
    const fill = document.querySelector('[data-testid="import-progress-fill"]');
    if (!fill) return null;
    const fillBg = window.__probe.parse(getComputedStyle(fill).backgroundColor);
    const track = window.__probe.effectiveBg(fill.parentElement);
    return { ratio: Number(window.__probe.contrast(window.__probe.over(fillBg, track), track).toFixed(2)), fill: fillBg.slice(0, 3), track: track.slice(0, 3), width: fill.style.width };
  })()`);
  if (bar) {
    check(`${theme}: ${tag}: progress bar fill >= ${MIN_UI_RATIO}:1 against its track`, bar.ratio >= MIN_UI_RATIO, `${bar.ratio}:1, rgb(${bar.fill}) on rgb(${bar.track}), width ${bar.width}`);
    checkText(theme, `${tag}: "Progress" label`, await textContrast(app, /^Progress$/));
    checkText(theme, `${tag}: progress counts`, await textContrast(app, /^\d+ \/ \d+ \(\d+%\)$/));
  }
  if (expectHeader !== 'Importing Documents...') {
    await checkStatsBlock(app, theme, tag, { dry: false, expectInvalid: expectFailed });
  }
}

/** Every text in the (shared) statistics block must clear AA on the card it sits on. */
async function checkStatsBlock(app, theme, tag, { dry, expectInvalid = false, expectImages = false }) {
  const root = `document.querySelector('[data-testid="import-stats"]')`;
  check(`${theme}: ${tag}: statistics block rendered`, !!(await app.evaluate(`!!${root}`)));
  checkText(theme, `${tag}: stats title`, await textContrast(app, dry ? /^Dry run \(.*\) - nothing was written$/ : /^Import complete \(.*\)$/, root));
  checkText(theme, `${tag}: stats headline`, await textContrast(app, dry ? /would be (created|added)/ : /(created|added).* in \d+ categor/, root));
  if (dry) checkText(theme, `${tag}: stats hint`, await textContrast(app, /click Import Documents to apply exactly this plan/, root));
  checkText(theme, `${tag}: stats "Type" header`, await textContrast(app, /^Type$/, root));
  checkText(theme, `${tag}: stats "New" header`, await textContrast(app, /^New$/, root));
  checkText(theme, `${tag}: Documents row`, await textContrast(app, /^Documents$/, root));
  checkText(theme, `${tag}: new-category row`, await textContrast(app, /^Category "Runbooks" \(new\)$/, root));
  checkText(theme, `${tag}: existing-category row`, await textContrast(app, /^Category "Notes"$/, root));
  checkText(theme, `${tag}: sample line`, await textContrast(app, /^e\.g\. /, root));
  checkText(theme, `${tag}: non-zero count cell`, await textContrast(app, /^[1-9]\d*$/, root));
  const notes = await app.evaluate(`Array.from(${root}.querySelectorAll('[data-testid="import-stats-note"]')).map((el) => ({ text: el.textContent.slice(0, 50), ...window.__probe.measure(el) }))`);
  check(`${theme}: ${tag}: documents note present`, Array.isArray(notes) && notes.some((n) => /same title as an existing document|locked document/.test(n.text)), JSON.stringify(notes.map((n) => n.text)));
  for (const n of notes) checkText(theme, `${tag}: note "${n.text.slice(0, 30)}..."`, n);
  if (expectImages) {
    checkText(theme, `${tag}: Images row`, await textContrast(app, /^Images$/, root));
    check(`${theme}: ${tag}: renamed-image note present`, notes.some((n) => /renamed because a different local image/.test(n.text)));
  }
  if (expectInvalid) {
    const invalidTitle = await app.evaluate(`(() => { const p = Array.from(${root}.querySelectorAll('p')).find((x) => /cannot be imported$/.test(x.textContent.trim())); return p ? window.__probe.measure(p) : null; })()`);
    checkText(theme, `${tag}: invalid records title`, invalidTitle);
    checkText(theme, `${tag}: invalid record label`, await textContrast(app, /^FAIL: /, root));
    const reason = await app.evaluate(`(() => { const li = Array.from(${root}.querySelectorAll('li')).find((l) => /Synthetic failure/.test(l.textContent)); return li ? window.__probe.measure(li) : null; })()`);
    checkText(theme, `${tag}: invalid record reason`, reason);
  }
}

async function runTheme(app, theme) {
  const dark = theme === 'dark';
  await app.evaluate(`window.__harness.setDark(${dark})`);
  await sleep(150);

  // ---- Input modal: paste mode ----
  await app.evaluate(`window.__harness.showInput()`);
  check(`${theme}: input modal opened`, !!(await waitText(app, /^Import Documents$/)));
  checkText(theme, 'input: title', await textContrast(app, /^Import Documents$/));
  checkText(theme, 'input: help text', await textContrast(app, /Upload a JSON file or paste JSON data/));
  checkText(theme, 'input: active tab "Paste JSON"', await elementContrast(app, /^Paste JSON$/, 'button'));
  checkText(theme, 'input: inactive tab "Upload File"', await elementContrast(app, /^Upload File$/, 'button'));
  checkText(theme, 'input: "JSON Data" label', await textContrast(app, /^JSON Data$/));
  checkText(theme, 'input: "Paste Example" link', await textContrast(app, /^Paste Example$/));
  checkText(theme, 'input: textarea placeholder', await app.evaluate(`(() => { const ta = document.querySelector('textarea'); if (!ta) return null; return window.__probe.measure(ta, window.__probe.parse(getComputedStyle(ta, '::placeholder').color)); })()`));
  const ta = await app.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return null;
    const cs = getComputedStyle(ta);
    const bg = window.__probe.parse(cs.backgroundColor);
    const border = window.__probe.parse(cs.borderTopColor);
    const modal = window.__probe.effectiveBg(ta.parentElement);
    return { bgLum: window.__probe.lum(bg), bg: bg.slice(0, 3), borderVsPane: window.__probe.contrast(border, bg), borderWidth: cs.borderTopWidth, colorScheme: cs.colorScheme, bgVsModal: window.__probe.contrast(bg, modal) };
  })()`);
  if (!ta) {
    check(`${theme}: input: textarea rendered`, false);
  } else {
    check(`${theme}: input: textarea surface follows the theme`, dark ? ta.bgLum < 0.1 : ta.bgLum > 0.5, `rgb(${ta.bg})`);
    check(`${theme}: input: textarea has a visible border`, ta.borderWidth !== '0px' && ta.borderVsPane > 1.15, `${ta.borderWidth}, border/pane ${ta.borderVsPane.toFixed(2)}:1`);
    check(`${theme}: input: textarea color-scheme matches theme`, ta.colorScheme === (dark ? 'dark' : 'light'), ta.colorScheme);
  }
  checkText(theme, 'input: line-count badge', await textContrast(app, /^\d+ lines$/));
  check(`${theme}: input: no "Expected Format" section any more`, !(await app.evaluate(`!!window.__probe.leaf(/^Expected Format$/) || !!document.querySelector('details')`)));
  checkText(theme, 'input: Cancel button', await elementContrast(app, /^Cancel$/, 'button'));
  infoText(theme, 'input: "Import Documents" (disabled, app-wide --os-blue button)', await elementContrast(app, /^Import Documents$/, 'button'));
  check(`${theme}: input: Import Documents + Dry Run disabled while empty`, await app.evaluate(`(() => { const b = window.__probe.byText(/^Import Documents$/, 'button'); const d = window.__probe.byText(/^Dry Run$/, 'button'); return !!b && b.disabled && !!d && d.disabled; })()`));
  checkText(theme, 'input: Dry Run button (disabled)', await elementContrast(app, /^Dry Run$/, 'button'), MIN_UI_RATIO);

  check(`${theme}: input: "Paste Example" fills the textarea`, await clickButton(app, /^Paste Example$/) && !!(await app.waitFor(`document.querySelector('textarea') && document.querySelector('textarea').value.includes('Example Document 1')`, 2000)));
  checkText(theme, 'input: textarea typed text', await app.evaluate(`(() => { const ta = document.querySelector('textarea'); return ta ? window.__probe.measure(ta) : null; })()`));
  infoText(theme, 'input: "Import Documents" (enabled, app-wide --os-blue button)', await elementContrast(app, /^Import Documents$/, 'button'));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-paste`)}`);

  // ---- Validation error: single object (clear, pointed message) ----
  await setTextarea(app, '{"title":"Solo","content":"not wrapped in an array"}');
  check(`${theme}: input: validate a single object`, await clickButton(app, /^Import Documents$/));
  check(`${theme}: input: single-object error shown`, !!(await waitText(app, /^Validation Error$/, 3000)));
  checkText(theme, 'input: "Validation Error" title', await textContrast(app, /^Validation Error$/));
  checkText(theme, 'input: single-object error message', await textContrast(app, /wrap it in \[ \.\.\. \]/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-error`)}`);
  // ---- Validation error: invalid JSON ----
  await setTextarea(app, '[{"title": "Broken"');
  await clickButton(app, /^Import Documents$/);
  check(`${theme}: input: invalid-JSON error shown`, !!(await waitText(app, /^Invalid JSON: /, 3000)));
  checkText(theme, 'input: invalid-JSON error message', await textContrast(app, /^Invalid JSON: /));

  // ---- Validation success + the real hand-over to the progress modal ----
  await setTextarea(app, JSON.stringify([
    { title: 'Runbook: Alpha', content: '# Alpha', category: 'Runbooks' },
    { title: 'Notes Beta', content: 'body', category: 'Notes', locked: true },
    { title: 'Gamma', content: 'x' },
  ]));
  // Dry Run: the statistics block appears in the input modal, no hand-over
  checkText(theme, 'input: Dry Run button (enabled)', await elementContrast(app, /^Dry Run$/, 'button'));
  check(`${theme}: input: Dry Run clicked`, await clickButton(app, /^Dry Run$/));
  check(`${theme}: input: dry-run statistics shown in place`, !!(await app.waitFor(`!!document.querySelector('[data-testid="import-stats"]')`, 8000)));
  check(`${theme}: input: no progress modal after a dry run`, !(await app.evaluate(`!!window.__probe.leaf(/^Importing Documents/)`)) && !(await app.evaluate(`!!window.__probe.leaf(/^Import Complete$/)`)));
  await app.evaluate(`document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = el.scrollHeight; })`);
  await checkStatsBlock(app, theme, 'input dry run', { dry: true });
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-dryrun`)}`);
  // Merge checkbox (shared MergeModeOption): label + hint readable in both states
  const optionRoot = `document.querySelector('[data-testid="merge-mode-option"]')`;
  check(`${theme}: input: merge checkbox present and unchecked by default`, await app.evaluate(`(() => { const o = ${optionRoot}; const b = o && o.querySelector('input[type="checkbox"]'); return !!b && !b.checked; })()`));
  checkText(theme, 'input: merge checkbox label', await textContrast(app, /^Keep existing documents and merge newer copies$/, optionRoot));
  checkText(theme, 'input: merge hint (add as new)', await textContrast(app, /^Every document in the file is added as a new document/, optionRoot));
  await app.evaluate(`${optionRoot}.querySelector('input[type="checkbox"]').click()`);
  check(`${theme}: input: ticking the checkbox clears the dry-run statistics`, !!(await app.waitFor(`!document.querySelector('[data-testid="import-stats"]')`, 2000)));
  checkText(theme, 'input: merge hint (merge on)', await textContrast(app, /^Documents already here/, optionRoot));
  check(`${theme}: input: merge Dry Run clicked`, await clickButton(app, /^Dry Run$/));
  check(`${theme}: input: merge dry-run statistics shown`, !!(await app.waitFor(`!!document.querySelector('[data-testid="import-stats"]')`, 8000)));
  await app.evaluate(`document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = el.scrollHeight; })`);
  const statsRoot = `document.querySelector('[data-testid="import-stats"]')`;
  checkText(theme, 'input merge dry run: title', await textContrast(app, /^Dry run \(merge into existing documents\) - nothing was written$/, statsRoot));
  // The synthetic merge matches every pasted document (none created), so
  // the "New" column is hidden like the DB stats hide empty columns
  const mergeHeaders = await app.evaluate(`Array.from(${statsRoot}.querySelectorAll('th')).map((t) => t.textContent).join('|')`);
  check(`${theme}: input merge dry run: Replaced / Completed / Unchanged columns`, mergeHeaders === 'Type|Replaced|Completed|Unchanged', mergeHeaders);
  checkText(theme, 'input merge dry run: "Replaced" header', await textContrast(app, /^Replaced$/, statsRoot));
  checkText(theme, 'input merge dry run: "Unchanged" header', await textContrast(app, /^Unchanged$/, statsRoot));
  checkText(theme, 'input merge dry run: locked note', await app.evaluate(`(() => { const el = Array.from(${statsRoot}.querySelectorAll('[data-testid="import-stats-note"]')).find((n) => /locked document/.test(n.textContent)); return el ? window.__probe.measure(el) : null; })()`));
  checkText(theme, 'input merge dry run: zero count cell', await textContrast(app, /^0$/, statsRoot));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-merge-dryrun`)}`);
  await app.evaluate(`${optionRoot}.querySelector('input[type="checkbox"]').click()`);
  check(`${theme}: input: unticking clears the statistics again`, !!(await app.waitFor(`!document.querySelector('[data-testid="import-stats"]')`, 2000)));
  check(`${theme}: input: Dry Run again (merge off) before editing`, await clickButton(app, /^Dry Run$/) && !!(await app.waitFor(`!!document.querySelector('[data-testid="import-stats"]')`, 8000)));
  // Editing the input clears the stale statistics
  await setTextarea(app, JSON.stringify([
    { title: 'Runbook: Alpha', content: '# Alpha', category: 'Runbooks' },
    { title: 'Notes Beta', content: 'body', category: 'Notes', locked: true },
    { title: 'Gamma', content: 'x' },
  ]) + ' ');
  check(`${theme}: input: editing clears the dry-run statistics`, !!(await app.waitFor(`!document.querySelector('[data-testid="import-stats"]')`, 2000)));
  // Import Documents: validates and hands over to the progress modal
  check(`${theme}: input: Import Documents clicked`, await clickButton(app, /^Import Documents$/));
  check(`${theme}: valid paste hands over to the progress modal`, !!(await waitText(app, /^Import Complete$/, 8000)));
  const importedTitles = await app.evaluate(`window.__harness.imported.slice(-3).join('|')`);
  check(`${theme}: the three pasted documents reached onImportItem in order`, importedTitles === 'Runbook: Alpha|Notes Beta|Gamma', importedTitles);
  await checkProgressModal(app, theme, 'progress ok', { expectHeader: 'Import Complete' });
  checkText(theme, 'progress ok: Close button', await elementContrast(app, /^Close$/, 'button'));
  check(`${theme}: progress ok: the post-import footer is only Close`, (await app.evaluate(`Array.from(document.querySelector('[data-testid="import-footer"]').querySelectorAll('button')).map((b) => b.textContent.trim()).join('|')`)) === 'Close');
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-progress-ok`)}`);
  check(`${theme}: Close closes the progress modal`, await clickButton(app, /^Close$/) && !!(await app.waitFor(`!window.__probe.leaf(/^Import Complete$/)`, 2000)));
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Input modal: file mode ----
  await app.evaluate(`window.__harness.showInput()`);
  await waitText(app, /^Import Documents$/);
  check(`${theme}: file tab opened`, await clickButton(app, /^Upload File$/) && !!(await waitText(app, /^Click to select a JSON file$/, 3000)));
  checkText(theme, 'file: "Upload JSON File" label', await textContrast(app, /^Upload JSON File$/));
  checkText(theme, 'file: drop-zone text', await textContrast(app, /^Click to select a JSON file$/));
  checkText(theme, 'file: "or drag and drop"', await textContrast(app, /^or drag and drop$/));
  const idleZone = await app.evaluate(`(() => { const z = document.querySelector('[data-testid="import-drop-zone"]'); return z ? { bg: window.__probe.effectiveBg(z).slice(0, 3), border: window.__probe.parse(getComputedStyle(z).borderTopColor).slice(0, 3) } : null; })()`);
  // Drag over: the zone highlights and must stay readable while it does
  await app.evaluate(`(() => { const z = document.querySelector('[data-testid="import-drop-zone"]'); z.dispatchEvent(new DragEvent('dragover', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })); })()`);
  await sleep(100);
  const dragZone = await app.evaluate(`(() => { const z = document.querySelector('[data-testid="import-drop-zone"]'); return z ? { bg: window.__probe.effectiveBg(z).slice(0, 3), border: window.__probe.parse(getComputedStyle(z).borderTopColor).slice(0, 3) } : null; })()`);
  check(`${theme}: file: drag-over highlights the drop zone`, !!idleZone && !!dragZone && (idleZone.bg.join() !== dragZone.bg.join() || idleZone.border.join() !== dragZone.border.join()), `idle rgb(${idleZone?.bg})/${idleZone?.border} -> drag rgb(${dragZone?.bg})/${dragZone?.border}`);
  checkText(theme, 'file: drop-zone text while dragging', await textContrast(app, /^Click to select a JSON file$/));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-dragover`)}`);
  await app.evaluate(`(() => { const z = document.querySelector('[data-testid="import-drop-zone"]'); z.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true })); })()`);
  await sleep(50);
  // Non-JSON drop -> error
  check(`${theme}: file: dropped a .txt`, await dropOnZone(app, { text: 'not json', name: 'notes.txt', type: 'text/plain' }));
  check(`${theme}: file: non-JSON drop error shown`, !!(await waitText(app, /^Please drop a JSON file$/, 3000)));
  checkText(theme, 'file: non-JSON drop error', await textContrast(app, /^Please drop a JSON file$/));
  // JSON drop -> file info + preview
  const fileJson = JSON.stringify([{ title: 'Dropped doc', content: 'line one\nline two', category: 'Drops' }], null, 2);
  check(`${theme}: file: dropped a .json`, await dropOnZone(app, { text: fileJson, name: 'documents-drops.json', type: 'application/json' }));
  check(`${theme}: file: chip shown, no content preview`, !!(await app.waitFor(`!!document.querySelector('[data-testid="import-file-chip"]')`, 3000)) && !(await app.evaluate(`!!document.querySelector('pre.os-terminal') || !!window.__probe.leaf(/^File Preview$/)`)));
  const chipRoot = `document.querySelector('[data-testid="import-file-chip"]')`;
  checkText(theme, 'file: chip file name', await textContrast(app, /^documents-drops\.json$/, chipRoot));
  checkText(theme, 'file: chip file size', await textContrast(app, /^\d+\.\d+ KB$/, chipRoot));
  checkText(theme, 'file: chip "Choose different file"', await textContrast(app, /^Choose different file$/, chipRoot));
  const chipBorder = await app.evaluate(`(() => { const c = ${chipRoot}; const cs = getComputedStyle(c); const border = window.__probe.parse(cs.borderTopColor); const bg = window.__probe.parse(cs.backgroundColor); return { width: cs.borderTopWidth, ratio: window.__probe.contrast(border, window.__probe.over(bg, window.__probe.effectiveBg(c.parentElement))) }; })()`);
  check(`${theme}: file: chip has a visible border`, chipBorder.width !== '0px' && chipBorder.ratio > 1.15, `${chipBorder.width}, ${chipBorder.ratio.toFixed(2)}:1`);
  const removeIcon = await app.evaluate(`(() => { const b = ${chipRoot}.querySelector('button[aria-label="Remove file"]'); return b ? window.__probe.measure(b) : null; })()`);
  checkText(theme, 'file: chip Remove button (icon)', removeIcon, MIN_UI_RATIO);
  check(`${theme}: file: Import Documents + Dry Run enabled after a drop`, await app.evaluate(`(() => { const b = window.__probe.byText(/^Import Documents$/, 'button'); const d = window.__probe.byText(/^Dry Run$/, 'button'); return !!b && !b.disabled && !!d && !d.disabled; })()`));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-input-file`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Progress modal: all ok, with an embedded image (subtitle preview + importer log lines) ----
  await app.evaluate(`window.__harness.showProgress('ok')`);
  check(`${theme}: ok import with image finished`, !!(await waitText(app, /^Import Complete$/, 8000)));
  check(`${theme}: subtitle previews the embedded image count`, !!(await app.evaluate(`!!window.__probe.leaf(/^3 documents, 1 image to import$/)`)));
  checkText(theme, 'progress ok+image: subtitle', await textContrast(app, /^3 documents, 1 image to import$/));
  const imageLog = await app.evaluate(`(() => { const p = document.querySelector('.os-terminal'); if (!p) return null; const info = Array.from(p.children).find((l) => /1 image \\(1 renamed\\)/.test(l.textContent)); const warn = Array.from(p.querySelectorAll('.os-terminal-warning')).find((l) => /stored as "dot-2.png"/.test(l.textContent)); return { info: info ? window.__probe.measure(info) : null, warn: warn ? window.__probe.measure(warn.parentElement.classList.contains('os-terminal-warning') ? warn.parentElement : warn) : null }; })()`);
  checkText(theme, 'progress ok+image: image info line', imageLog && imageLog.info);
  checkText(theme, 'progress ok+image: renamed-image warning line', imageLog && imageLog.warn);
  await app.evaluate(`document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = 0; })`);
  await checkStatsBlock(app, theme, 'progress ok+image', { dry: false, expectImages: true });
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-progress-images`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Progress modal: partial failure ----
  await app.evaluate(`window.__harness.showProgress('partial')`);
  check(`${theme}: partial import finished`, !!(await waitText(app, /^Import Complete$/, 8000)));
  await checkProgressModal(app, theme, 'progress partial', { expectHeader: 'Import Complete', expectFailed: true });
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-progress-partial`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Progress modal: everything failed ----
  await app.evaluate(`window.__harness.showProgress('fail')`);
  check(`${theme}: failed import finished`, !!(await waitText(app, /^Import Failed$/, 8000)));
  checkText(theme, 'progress failed: header', await textContrast(app, /^Import Failed$/));
  checkText(theme, 'progress failed: Close button', await elementContrast(app, /^Close$/, 'button'));
  const failedStats = await app.evaluate(`(() => { const r = document.querySelector('[data-testid="import-stats"]'); return r ? r.textContent : null; })()`);
  check(`${theme}: progress failed: statistics list both invalid records`, !!failedStats && /2 records cannot be imported/.test(failedStats), failedStats && failedStats.slice(0, 200));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-progress-failed`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);

  // ---- Progress modal: still running ----
  await app.evaluate(`window.__harness.showProgress('running')`);
  // Log lines are "<span>[time]</span> message" (not leaves): match the line div
  check(`${theme}: running import reached its second document`, !!(await app.waitFor(`!!window.__probe.byText(/Importing "HANG: never finishes"\\.\\.\\.$/, 'div')`, 8000)));
  await checkProgressModal(app, theme, 'progress running', { expectHeader: 'Importing Documents...' });
  checkText(theme, 'progress running: Cancel button', await elementContrast(app, /^Cancel$/, 'button'));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-import-progress-running`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(200);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'documents-import-harness-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await app.send('Page.navigate', { url: `http://localhost:${PORT}/tests/helpers/documents-import-harness.html` });
    const ready = await app.waitFor(`window.__harnessReady === true`, 30000);
    check('harness page loaded', !!ready);
    if (!ready) throw new Error('documents import harness did not load');
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
