#!/usr/bin/env node

/**
 * Real-browser check that the shared notice strip
 * (src/components/common/NoticeBanner.jsx: the Documents editor's offline /
 * read-only / server-copy notices and the Tasks page's orphaned-tasks
 * notice with its "Clean it?" action) is readable in BOTH themes.
 *
 * What this proves, in headless Chrome against
 * tests/helpers/notice-banner-harness.html (the REAL component, synthetic
 * text, served by a Vite dev server; nothing touches IndexedDB or the
 * network), for the light AND the dark theme:
 *   - every banner's message, bold lead-in and the "Clean it?" action
 *     measure >= 4.5:1 (WCAG AA) against the surface they actually sit on
 *     (ancestor backgrounds alpha-composited);
 *   - each strip's tint is visible against the card it sits in;
 *   - the action is a text-style button (no border, no background of its
 *     own, underlined), reachable with Tab, and shows a visible focus ring
 *     when focused from the keyboard; clicking it fires once; the busy
 *     state stays readable.
 * Saves a screenshot per theme (see below) for eyeballing.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/notice-banner-theme.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5226),
 *   THEME_SHOTS_DIR (where PNGs go; default <os tmpdir>/jacarium-theme-shots)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5226);
const SHOTS_DIR = process.env.THEME_SHOTS_DIR || path.join(tmpdir(), 'jacarium-theme-shots');
const MIN_RATIO = 4.5;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

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
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
    }
    let bg = [255, 255, 255, 1];
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (root && root[3] > 0) bg = root;
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const measure = (el) => {
    const color = parse(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    return { ratio: +contrast(color, bg).toFixed(2), color: color.slice(0, 3), bg: bg.slice(0, 3) };
  };
  window.__probe = { parse, lum, contrast, effectiveBg, measure };
  return true;
})()`;

function checkText(theme, label, m) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${MIN_RATIO}:1`, m.ratio >= MIN_RATIO, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
}

async function screenshot(app, name) {
  const r = await app.send('Page.captureScreenshot', { format: 'png' });
  const data = r.result?.data;
  if (!data) return null;
  const file = path.join(SHOTS_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const BANNERS = [
  ['orphaned-tasks-banner', 'Tasks orphaned-tasks notice'],
  ['document-offline-banner', 'Documents offline notice'],
  ['document-readonly-banner', 'Documents read-only notice'],
  ['document-server-copy-banner', 'Documents server-copy notice'],
];

async function runTheme(app, theme) {
  const dark = theme === 'dark';
  await app.evaluate(`window.__harness.setDark(${dark})`);
  await sleep(150);

  for (const [id, label] of BANNERS) {
    const m = await app.evaluate(`(() => {
      const b = document.querySelector('[data-testid="${id}"]');
      if (!b) return null;
      const spans = Array.from(b.querySelectorAll('span'));
      const card = b.parentElement;
      const bBg = window.__probe.effectiveBg(b), cardBg = window.__probe.effectiveBg(card);
      return {
        texts: spans.map((s) => ({ text: s.textContent.trim().slice(0, 30), ...window.__probe.measure(s) })),
        tintVsCard: +window.__probe.contrast(bBg, cardBg).toFixed(2),
      };
    })()`);
    if (!m) { check(`${theme}: ${label} rendered`, false); continue; }
    for (const t of m.texts) checkText(theme, `${label} "${t.text}"`, t);
    // The tints are the Documents editor's own (Tailwind *-50 in light, *-900/20
    // in dark); amber-50 on the white card is only a faint 1.04:1 warm tint by
    // design, so this guards "there is a tint", not a strong one.
    check(`${theme}: ${label} has a tint against the card`, m.tintVsCard > 1.02, `${m.tintVsCard}:1`);
  }

  // The action: text-style, underlined, focusable by keyboard with a ring.
  const action = await app.evaluate(`(() => {
    const b = document.querySelector('[data-testid="orphaned-tasks-clean"]');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { ...window.__probe.measure(b), tag: b.tagName, text: b.textContent.trim(), underline: cs.textDecorationLine,
      border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow, outline: cs.outlineStyle };
  })()`);
  checkText(theme, '"Clean it?" action', action);
  check(`${theme}: the action is an underlined text-style button (no border, transparent background)`,
    !!action && action.tag === 'BUTTON' && action.text === 'Clean it?' && /underline/.test(action.underline) && action.border === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(action.bg),
    action && `${action.underline} border ${action.border} bg ${action.bg}`);
  // Keyboard focus: click the page body then Tab to the first focusable = the action.
  await app.evaluate(`(() => { document.activeElement && document.activeElement.blur(); document.body.focus(); return true; })()`);
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(100);
  const focused = await app.evaluate(`(() => {
    const b = document.querySelector('[data-testid="orphaned-tasks-clean"]');
    const cs = getComputedStyle(b);
    return { isActive: document.activeElement === b, focusVisible: b.matches(':focus-visible'), shadow: cs.boxShadow, outline: cs.outlineStyle + ' ' + cs.outlineWidth };
  })()`);
  check(`${theme}: Tab reaches the action`, !!focused && focused.isActive);
  check(`${theme}: keyboard focus shows a visible ring (box-shadow ring, :focus-visible)`,
    !!focused && focused.focusVisible && focused.shadow && focused.shadow !== 'none', focused && `${focused.shadow} / outline ${focused.outline}`);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-notice-banners-focused`)}`);

  // Enter activates it once.
  const clicksBefore = await app.evaluate(`window.__harness.clicks`);
  // `text` is what makes Chrome run the key's default action (the click).
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(100);
  check(`${theme}: Enter on the focused action activates it once`, (await app.evaluate(`window.__harness.clicks`)) === clicksBefore + 1);

  // Busy state stays readable.
  await app.evaluate(`window.__harness.setBusy(true)`);
  await sleep(100);
  const busy = await app.evaluate(`(() => { const b = document.querySelector('[data-testid="orphaned-tasks-clean"]'); return b ? { ...window.__probe.measure(b), text: b.textContent.trim(), disabled: b.disabled } : null; })()`);
  check(`${theme}: busy state disables the action and says "Cleaning..."`, !!busy && busy.disabled && busy.text === 'Cleaning...');
  check(`${theme}: busy action still >= 3:1 (disabled, dimmed)`, !!busy && busy.ratio >= 3, busy && `${busy.ratio}:1`);
  await app.evaluate(`window.__harness.setBusy(false)`);
  await app.evaluate(`document.activeElement && document.activeElement.blur()`);
  await sleep(50);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'notice-banner-theme-' });
  if (app.skip) { console.log(`SKIP: ${app.skip}`); return 0; }
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await app.send('Page.navigate', { url: `http://localhost:${PORT}/tests/helpers/notice-banner-harness.html` });
    const ready = await app.waitFor(`window.__harnessReady === true`, 30000);
    check('harness page loaded', !!ready);
    if (!ready) throw new Error('notice banner harness did not load');
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
