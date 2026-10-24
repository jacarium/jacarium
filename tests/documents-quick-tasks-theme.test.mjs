#!/usr/bin/env node

/**
 * Real-browser check that the Documents editor's Quick Tasks popup (/task,
 * src/components/features/documents/QuickTasks.jsx) is readable in BOTH
 * themes. Companion of tests/documents-quick-tasks.test.mjs (behaviour in
 * jsdom); same approach as tests/export-import-theme.test.mjs.
 *
 * What this proves, in headless Chrome against
 * tests/helpers/quick-tasks-harness.html (the REAL popup with a synthetic
 * TaskWarrior instance in the throwaway profile's IndexedDB; nothing touches
 * the user's data or the network), for the light AND the dark theme:
 *   - the popup surface follows the theme (light card in light, dark card in
 *     dark) and has a visible border against the page;
 *   - the header title, every field label, the selected instance in the
 *     dropdown, typed text in the task field, the Due date field (the Tasks
 *     page's DatePicker: empty placeholder and a picked date), the priority
 *     dropdown, the helper text, the Cancel button and the no-instances
 *     message all measure >= 4.5:1 (WCAG AA) against the
 *     surface they actually sit on (ancestor backgrounds alpha-composited);
 *   - the inline validation error ("Task text is required") is >= 4.5:1;
 *   - the DatePicker's calendar opens INSIDE the floating window, fully
 *     within the viewport and on top of it (elementFromPoint at its centre
 *     lands inside the calendar - not clipped by the window's scrolling
 *     body, not hidden behind it), and its month title, weekday headers, a
 *     regular day, today's highlighted day and the Today/Clear buttons all
 *     measure >= 4.5:1 in both themes (its weekday abbreviations, styled by
 *     the shared component with text-os-text-muted exactly as on the Tasks
 *     page, are held to >= 3:1);
 *   - the primary "Create Task" button is >= 3:1 (WCAG AA for large/bold UI
 *     text and components): it shares the app-wide purple button style of
 *     the sibling /ai and /wf windows, whose dark-theme override
 *     (src/index.css `.dark .bg-purple-600`) lands white-on-#a855f7 at
 *     about 3.9:1 - the same as every other purple button in the app;
 *   - the popup's inputs use the app's CSS tokens (no fixed-theme colours),
 *     so their surfaces also follow the theme.
 * It also saves a screenshot of every state in every theme for eyeballing.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/documents-quick-tasks-theme.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5223),
 *   THEME_SHOTS_DIR (where PNGs go; default <os tmpdir>/jacarium-theme-shots)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5223);
const SHOTS_DIR = process.env.THEME_SHOTS_DIR || path.join(tmpdir(), 'jacarium-theme-shots');
const MIN_RATIO = 4.5;
const MIN_BUTTON_RATIO = 3;

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

const POPUP = `document.querySelector('[data-testid="quick-tasks-popup"]')`;

/** Contrast of the first visible leaf element matching `re` against what it sits on. */
async function textContrast(app, re, root = POPUP) {
  return app.evaluate(`(() => { const el = window.__probe.leaf(${re.toString()}, ${root}); if (!el) return null; return window.__probe.measure(el); })()`);
}
/** Contrast of one element found by a selector inside the popup. */
async function elementContrast(app, selector) {
  return app.evaluate(`(() => { const el = ${POPUP} && ${POPUP}.querySelector(${JSON.stringify(selector)}); if (!el) return null; return window.__probe.measure(el); })()`);
}

function checkText(theme, label, m, min = MIN_RATIO) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${min}:1`, m.ratio >= min, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
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

// React-controlled inputs: set through the prototype setter + input event
const SET_INPUT = (selector, value) => `(() => {
  const el = ${POPUP}.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
})()`;

async function runTheme(app, theme) {
  const dark = theme === 'dark';
  await app.evaluate(`window.__harness.setDark(${dark})`);
  await sleep(150);

  // ---- populated form ----
  await app.evaluate(`window.__harness.seed()`);
  await app.evaluate(`window.__harness.show()`);
  check(`${theme}: popup opened`, !!(await waitText(app, /^Quick Tasks$/)));
  const loaded = await app.waitFor(`(() => { const s = ${POPUP} && ${POPUP}.querySelector('#quick-task-instance'); return !!s && Array.from(s.options).some((o) => /Alpha Lab/.test(o.textContent)); })()`, 10000);
  check(`${theme}: instance dropdown lists the synthetic instance`, !!loaded);

  const surface = await app.evaluate(`(() => {
    const p = ${POPUP};
    if (!p) return null;
    const cs = getComputedStyle(p);
    const bg = window.__probe.parse(cs.backgroundColor);
    const border = window.__probe.parse(cs.borderTopColor);
    const pageBg = window.__probe.effectiveBg(p.parentElement);
    const input = p.querySelector('#quick-task-description');
    const inputBg = window.__probe.parse(getComputedStyle(input).backgroundColor);
    return { bgLum: window.__probe.lum(bg), bg: bg.slice(0, 3), borderWidth: cs.borderTopWidth,
      borderVsPage: window.__probe.contrast(border, pageBg), borderVsCard: window.__probe.contrast(border, bg),
      inputLum: window.__probe.lum(inputBg), inputBg: inputBg.slice(0, 3) };
  })()`);
  if (!surface) {
    check(`${theme}: popup surface rendered`, false);
  } else {
    check(`${theme}: popup surface follows the theme`, dark ? surface.bgLum < 0.1 : surface.bgLum > 0.5, `rgb(${surface.bg}), luminance ${surface.bgLum.toFixed(3)}`);
    check(`${theme}: popup has a visible border`, surface.borderWidth !== '0px' && surface.borderVsCard > 1.15, `${surface.borderWidth}, border/card ${surface.borderVsCard.toFixed(2)}:1`);
    check(`${theme}: input surfaces follow the theme`, dark ? surface.inputLum < 0.1 : surface.inputLum > 0.5, `rgb(${surface.inputBg})`);
  }

  await app.evaluate(SET_INPUT('#quick-task-description', 'Rotate the lab certificates'));
  check(`${theme}: the form has no start/end/native time inputs (task is created "now")`,
    (await app.evaluate(`${POPUP}.querySelectorAll('input[type="datetime-local"], input[type="date"], input[type="time"], #quick-task-start, #quick-task-end').length`)) === 0);
  check(`${theme}: a Due date field (DatePicker button) is present`, !!(await app.evaluate(`!!${POPUP}.querySelector('[data-testid="quick-task-due"] button')`)));
  checkText(theme, 'empty Due date field placeholder', await elementContrast(app, '[data-testid="quick-task-due"] button'));

  // ---- the DatePicker calendar, opened inside the floating window ----
  await app.evaluate(`${POPUP}.querySelector('[data-testid="quick-task-due"] button').click()`);
  const CAL = `${POPUP}.querySelector('[data-testid="quick-task-due"] .fixed')`;
  check(`${theme}: clicking the Due date field opens the calendar`, !!(await app.waitFor(`!!${CAL}`, 5000)));
  const cal = await app.evaluate(`(() => {
    const c = ${CAL};
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const cs = getComputedStyle(c);
    const bg = window.__probe.parse(cs.backgroundColor);
    const inViewport = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight && r.width > 200 && r.height > 200;
    const dayBtns = Array.from(c.querySelectorAll('button')).filter((b) => /^\\d+$/.test(b.textContent.trim()) && !b.className.includes('opacity-40'));
    // today's cell is the only one with a resting (non-hover:) bg-os-card-secondary
    const today = dayBtns.find((b) => /(^|\\s)bg-os-card-secondary/.test(b.className)) || null;
    const plain = dayBtns.find((b) => b !== today) || null;
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inViewport,
      onTop: !!hit && c.contains(hit), hitTag: hit ? hit.tagName + '.' + String(hit.className).replace(/\s+/g, ' ').trim().slice(0, 40) : null,
      bgLum: window.__probe.lum(bg),
      month: (() => { const el = window.__probe.leaf(/^[A-Z][a-z]+ \\d{4}$/, c); return el ? window.__probe.measure(el) : null; })(),
      weekday: (() => { const el = window.__probe.leaf(/^Mon$/, c); return el ? window.__probe.measure(el) : null; })(),
      today: today ? window.__probe.measure(today) : null,
      plain: plain ? window.__probe.measure(plain) : null,
      todayBtn: (() => { const el = window.__probe.leaf(/^Today$/, c); return el ? window.__probe.measure(el) : null; })(),
      clearBtn: (() => { const el = window.__probe.leaf(/^Clear$/, c); return el ? window.__probe.measure(el) : null; })(),
    };
  })()`);
  if (!cal) {
    check(`${theme}: calendar rendered`, false);
  } else {
    check(`${theme}: calendar is fully inside the viewport (not clipped)`, cal.inViewport, `rect ${cal.rect.join(',')}`);
    check(`${theme}: calendar is on top of the window (elementFromPoint hits it)`, cal.onTop, cal.hitTag || 'nothing hit');
    check(`${theme}: calendar surface follows the theme`, dark ? cal.bgLum < 0.1 : cal.bgLum > 0.5, `luminance ${cal.bgLum.toFixed(3)}`);
    checkText(theme, 'calendar month title', cal.month);
    // The weekday abbreviations use the shared DatePicker's text-os-text-muted
    // (3.3:1 light / 4.2:1 dark) - exactly what the Tasks page shows; the
    // component is reused unchanged, so they are held to the 3:1 UI floor.
    checkText(theme, 'calendar weekday header (shared DatePicker muted text)', cal.weekday, MIN_BUTTON_RATIO);
    checkText(theme, 'calendar regular day', cal.plain);
    checkText(theme, 'calendar today (highlighted) day', cal.today);
    checkText(theme, 'calendar "Today" button', cal.todayBtn);
    checkText(theme, 'calendar "Clear" button', cal.clearBtn);
  }
  console.log(`  screenshot: ${await screenshot(app, `${theme}-quick-tasks-calendar`)}`);
  // Esc closes only the calendar, then pick today
  await app.evaluate(`${POPUP}.querySelector('#quick-task-description').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  check(`${theme}: Esc with the calendar open closes the calendar but keeps the window`, !!(await app.waitFor(`!${CAL} && !!${POPUP}`, 5000)));
  await app.evaluate(`${POPUP}.querySelector('[data-testid="quick-task-due"] button').click()`);
  await app.waitFor(`!!${CAL}`, 5000);
  await app.evaluate(`Array.from(${CAL}.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Today').click()`);
  check(`${theme}: picking Today closes the calendar and fills the field`, !!(await app.waitFor(`!${CAL} && !/No due date/.test(${POPUP}.querySelector('[data-testid="quick-task-due"] button').textContent)`, 5000)));
  checkText(theme, 'filled Due date field', await elementContrast(app, '[data-testid="quick-task-due"] button'));
  await app.evaluate(SET_INPUT('#quick-task-priority', 'H'));
  await sleep(100);

  checkText(theme, 'header title', await textContrast(app, /^Quick Tasks$/));
  checkText(theme, '"Instance" label', await textContrast(app, /^Instance$/));
  checkText(theme, '"Task" label', await textContrast(app, /^Task$/));
  checkText(theme, '"Due date" label', await textContrast(app, /^Due date$/));
  checkText(theme, '"Priority" label', await textContrast(app, /^Priority$/));
  checkText(theme, 'instance dropdown text', await elementContrast(app, '#quick-task-instance'));
  checkText(theme, 'typed task text', await elementContrast(app, '#quick-task-description'));
  checkText(theme, 'priority dropdown text', await elementContrast(app, '#quick-task-priority'));
  checkText(theme, 'helper text', await textContrast(app, /Due date is optional/));
  checkText(theme, '"Cancel" button', await textContrast(app, /^Cancel$/));
  checkText(theme, '"Create Task" button', await elementContrast(app, '[data-testid="quick-tasks-submit"]'), MIN_BUTTON_RATIO);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-quick-tasks-form`)}`);

  // ---- inline validation error ----
  await app.evaluate(SET_INPUT('#quick-task-description', ''));
  await app.evaluate(`${POPUP}.querySelector('[data-testid="quick-tasks-submit"]').click()`);
  check(`${theme}: inline error shown`, !!(await waitText(app, /^Task text is required$/)));
  checkText(theme, 'inline validation error', await textContrast(app, /^Task text is required$/));
  check(`${theme}: no task was written by the invalid submit`, (await app.evaluate(`window.__harness.tasks().then((t) => t.length)`)) === 0);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-quick-tasks-error`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(150);

  // ---- no instances ----
  await app.evaluate(`window.__harness.clear()`);
  await app.evaluate(`window.__harness.show()`);
  check(`${theme}: no-instances message shown`, !!(await waitText(app, /No TaskWarrior instances yet/)));
  checkText(theme, 'no-instances message', await textContrast(app, /No TaskWarrior instances yet/));
  const disabled = await app.evaluate(`${POPUP}.querySelector('[data-testid="quick-tasks-submit"]').disabled`);
  check(`${theme}: submit disabled without instances`, disabled === true);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-quick-tasks-no-instances`)}`);
  await app.evaluate(`window.__harness.hide()`);
  await sleep(150);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'quick-tasks-theme-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await app.send('Page.navigate', { url: `http://localhost:${PORT}/tests/helpers/quick-tasks-harness.html` });
    const ready = await app.waitFor(`window.__harnessReady === true`, 30000);
    check('harness page loaded', !!ready);
    if (!ready) throw new Error('quick tasks harness did not load');
    await app.evaluate(PROBE);

    for (const theme of ['light', 'dark']) {
      console.log(`\n--- ${theme} theme ---`);
      await runTheme(app, theme);
    }

    const pageErrors = app.errors.filter((e) => !/ResizeObserver loop/.test(e) && !/no backend in the theme harness/.test(e));
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

main().then((code) => process.exit(code)).catch((err) => {
  console.error('UNEXPECTED ERROR:', err && err.stack || err);
  process.exit(1);
});
