#!/usr/bin/env node

/**
 * Real-browser check that the Tasks page's task right-click menu and its
 * "Create Document In" category submenu (src/components/tasks/TaskContextMenu.jsx
 * over the shared src/components/common/menus/CategorySubmenu.jsx, the same
 * component the Documents sidebar's "Move to Category" row renders) are
 * readable and correctly placed in BOTH themes. Companion of
 * tests/tasks-create-document-in.test.mjs (behaviour in jsdom); same
 * approach as tests/documents-quick-tasks-theme.test.mjs.
 *
 * What this proves, in headless Chrome against
 * tests/helpers/task-context-menu-harness.html (REAL TaskItem rows and the
 * REAL menu over synthetic tasks/categories; nothing touches the user's
 * data or the network), for the light AND the dark theme:
 *   - right-click on a task row opens the menu at the cursor, on a surface
 *     that follows the theme with a visible border;
 *   - the "Create Document In" label measures >= 4.5:1 (WCAG AA) against
 *     the surface it sits on (ancestor backgrounds alpha-composited);
 *   - hovering it opens the submenu to the RIGHT of the row, fully inside
 *     the viewport and on top (elementFromPoint at its centre lands inside
 *     it); its surface follows the theme; every category entry and typed
 *     search text measure >= 4.5:1; the search placeholder and the
 *     "No categories found" note (text-os-text-muted, exactly as on the
 *     Documents page) are held to >= 3:1;
 *   - opened near the right edge of the window, the submenu flips to the
 *     LEFT of the row and still stays inside the viewport;
 *   - picking a category records the pick and closes the menu; Escape and
 *     a click outside close it without picking.
 * It also saves a screenshot of every state in every theme for eyeballing.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/tasks-create-document-in-theme.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5224),
 *   THEME_SHOTS_DIR (where PNGs go; default <os tmpdir>/jacarium-theme-shots)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const PORT = Number(process.env.SMOKE_PORT || 5224);
const SHOTS_DIR = process.env.THEME_SHOTS_DIR || path.join(tmpdir(), 'jacarium-theme-shots');
const MIN_RATIO = 4.5;
const MIN_MUTED_RATIO = 3;

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
  const measure = (el, colorProp = 'color') => {
    const cs = getComputedStyle(el, colorProp === 'placeholder' ? '::placeholder' : null);
    const color = parse(cs.color);
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

const MENU = `document.querySelector('[data-testid="task-context-menu"]')`;
const ENTRY = `document.querySelector('[data-testid="task-create-document-in"]')`;
const SUBMENU = `document.querySelector('[data-testid="task-create-document-in-submenu"]')`;

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

const SET_INPUT = (selectorExpr, value) => `(() => {
  const el = ${selectorExpr};
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function surfaceOf(app, expr) {
  return app.evaluate(`(() => {
    const el = ${expr};
    if (!el) return null;
    const box = el.closest('.fixed') || el;
    const cs = getComputedStyle(box);
    const bg = window.__probe.parse(cs.backgroundColor);
    const border = window.__probe.parse(cs.borderTopColor);
    const pageBg = window.__probe.effectiveBg(document.body);
    return { bgLum: window.__probe.lum(bg), bg: bg.slice(0, 3), borderWidth: cs.borderTopWidth,
      borderVsCard: window.__probe.contrast(border, bg), borderVsPage: window.__probe.contrast(border, pageBg) };
  })()`);
}

async function runTheme(app, theme) {
  const dark = theme === 'dark';
  await app.evaluate(`window.__harness.setDark(${dark})`);
  await sleep(150);
  await app.evaluate(`window.__harness.setCategories(['Runbooks', 'Ops', 'Archive', 'General'])`);

  // ---- open the menu on the first row ----
  check(`${theme}: right-click dispatched on a task row`, !!(await app.evaluate(`window.__harness.openMenu(0)`)));
  check(`${theme}: the context menu opened`, !!(await app.waitFor(`!!${MENU}`, 5000)));
  const menuBox = await app.evaluate(`(() => { const m = ${MENU} && ${MENU}.closest('.fixed'); if (!m) return null; const r = m.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  check(`${theme}: the menu is inside the viewport with a real size`, !!menuBox && menuBox.inViewport && menuBox.w >= 200 && menuBox.h >= 30, menuBox && `${Math.round(menuBox.left)},${Math.round(menuBox.top)} ${Math.round(menuBox.w)}x${Math.round(menuBox.h)}`);
  const menuSurface = await surfaceOf(app, MENU);
  if (!menuSurface) {
    check(`${theme}: menu surface rendered`, false);
  } else {
    check(`${theme}: menu surface follows the theme`, dark ? menuSurface.bgLum < 0.1 : menuSurface.bgLum > 0.5, `rgb(${menuSurface.bg}), luminance ${menuSurface.bgLum.toFixed(3)}`);
    check(`${theme}: menu has a visible border`, menuSurface.borderWidth !== '0px' && menuSurface.borderVsCard > 1.15, `${menuSurface.borderWidth}, border/card ${menuSurface.borderVsCard.toFixed(2)}:1`);
  }
  // The row is icon + text node + chevron, so measure the button itself
  checkText(theme, '"Create Document In" label', await app.evaluate(`(() => { const el = ${ENTRY} && ${ENTRY}.querySelector('button'); return el && el.textContent.trim() === 'Create Document In' ? window.__probe.measure(el) : null; })()`));
  check(`${theme}: the submenu is closed until hovered`, !(await app.evaluate(`!!${SUBMENU}`)));
  console.log(`  screenshot: ${await screenshot(app, `${theme}-task-menu`)}`);

  // ---- hover opens the submenu to the right, inside the viewport, on top ----
  check(`${theme}: hover dispatched on the entry`, !!(await app.evaluate(`window.__harness.hoverEntry()`)));
  check(`${theme}: the category submenu opened`, !!(await app.waitFor(`!!${SUBMENU}`, 5000)));
  const sub = await app.evaluate(`(() => {
    const s = ${SUBMENU}; const row = ${ENTRY};
    if (!s || !row) return null;
    const r = s.getBoundingClientRect(); const rr = row.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      rowRight: Math.round(rr.right), rowLeft: Math.round(rr.left), rowTop: Math.round(rr.top),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width >= 180 && r.height > 60,
      onTop: !!hit && s.contains(hit),
      entries: Array.from(s.querySelectorAll('button[role="menuitem"]')).map((b) => b.textContent.trim()),
      entryContrast: (() => { const el = window.__probe.leaf(/^Runbooks$/, s); return el ? window.__probe.measure(el) : null; })(),
      placeholder: (() => { const i = s.querySelector('input'); return i ? window.__probe.measure(i, 'placeholder') : null; })(),
    };
  })()`);
  if (!sub) {
    check(`${theme}: submenu rendered`, false);
  } else {
    check(`${theme}: the submenu opens to the RIGHT of the row, aligned with its top`, sub.rect[0] >= sub.rowRight - 1 && Math.abs(sub.rect[1] - sub.rowTop) <= 2, `submenu at ${sub.rect.join(',')}, row right ${sub.rowRight} top ${sub.rowTop}`);
    check(`${theme}: the submenu is fully inside the viewport`, sub.inViewport, `rect ${sub.rect.join(',')}`);
    check(`${theme}: the submenu is on top (elementFromPoint hits it)`, sub.onTop);
    check(`${theme}: the submenu lists the categories in order`, JSON.stringify(sub.entries) === JSON.stringify(['Runbooks', 'Ops', 'Archive', 'General']), JSON.stringify(sub.entries));
    checkText(theme, 'category entry', sub.entryContrast);
    checkText(theme, 'search placeholder (muted, as on the Documents page)', sub.placeholder, MIN_MUTED_RATIO);
  }
  const subSurface = await surfaceOf(app, SUBMENU);
  if (subSurface) {
    check(`${theme}: submenu surface follows the theme`, dark ? subSurface.bgLum < 0.1 : subSurface.bgLum > 0.5, `rgb(${subSurface.bg})`);
    check(`${theme}: submenu has a visible border`, subSurface.borderWidth !== '0px' && subSurface.borderVsCard > 1.15, `${subSurface.borderWidth}, border/card ${subSurface.borderVsCard.toFixed(2)}:1`);
  }
  console.log(`  screenshot: ${await screenshot(app, `${theme}-task-menu-submenu`)}`);

  // ---- search text + empty state ----
  await app.evaluate(SET_INPUT(`${SUBMENU}.querySelector('input')`, 'Ops'));
  check(`${theme}: the search filters the list`, !!(await app.waitFor(`(() => { const s = ${SUBMENU}; return !!s && Array.from(s.querySelectorAll('button[role="menuitem"]')).map((b) => b.textContent.trim()).join() === 'Ops'; })()`, 3000)));
  checkText(theme, 'typed search text', await app.evaluate(`(() => { const i = ${SUBMENU} && ${SUBMENU}.querySelector('input'); return i ? window.__probe.measure(i) : null; })()`));
  await app.evaluate(SET_INPUT(`${SUBMENU}.querySelector('input')`, 'zzz'));
  check(`${theme}: no match shows "No categories found"`, !!(await app.waitFor(`!!window.__probe.leaf(/No categories found/, ${SUBMENU})`, 3000)));
  checkText(theme, '"No categories found" note (muted)', await app.evaluate(`(() => { const el = window.__probe.leaf(/No categories found/, ${SUBMENU}); return el ? window.__probe.measure(el) : null; })()`), MIN_MUTED_RATIO);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-task-menu-submenu-empty`)}`);
  await app.evaluate(SET_INPUT(`${SUBMENU}.querySelector('input')`, ''));
  await app.waitFor(`(() => { const s = ${SUBMENU}; return !!s && s.querySelectorAll('button[role="menuitem"]').length === 4; })()`, 3000);

  // ---- picking a category records it and closes the menu ----
  const pickedBefore = await app.evaluate(`window.__harness.picked.length`);
  await app.evaluate(`Array.from(${SUBMENU}.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Ops').click()`);
  check(`${theme}: picking a category closes the menu and submenu`, !!(await app.waitFor(`!${MENU} && !${SUBMENU}`, 3000)));
  const picked = await app.evaluate(`JSON.stringify(window.__harness.picked)`);
  check(`${theme}: ... and hands the task + category to the page`, JSON.parse(picked).length === pickedBefore + 1 && JSON.parse(picked).at(-1).taskId === 1 && JSON.parse(picked).at(-1).category === 'Ops', picked);

  // ---- near the right edge: the submenu flips to the left of the row ----
  await app.evaluate(`window.__harness.openMenu(1, innerWidth - 40, 120)`);
  await app.waitFor(`!!${MENU}`, 3000);
  await app.evaluate(`window.__harness.hoverEntry()`);
  await app.waitFor(`!!${SUBMENU}`, 3000);
  const edge = await app.evaluate(`(() => {
    const s = ${SUBMENU}; const row = ${ENTRY};
    if (!s || !row) return null;
    const r = s.getBoundingClientRect(); const rr = row.getBoundingClientRect();
    return { subLeft: Math.round(r.left), subRight: Math.round(r.right), rowLeft: Math.round(rr.left), rowRight: Math.round(rr.right),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, innerWidth };
  })()`);
  check(`${theme}: near the right edge the submenu opens to the LEFT of the row and stays inside the viewport`,
    !!edge && edge.subRight <= edge.rowLeft + 1 && edge.inViewport, edge && `submenu ${edge.subLeft}-${edge.subRight}, row ${edge.rowLeft}-${edge.rowRight}, width ${edge.innerWidth}`);
  console.log(`  screenshot: ${await screenshot(app, `${theme}-task-menu-submenu-edge`)}`);

  // ---- Escape closes; click outside closes; neither picks ----
  const pickedNow = await app.evaluate(`window.__harness.picked.length`);
  await app.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check(`${theme}: Escape closes the menu`, !!(await app.waitFor(`!${MENU}`, 3000)));
  await app.evaluate(`window.__harness.openMenu(0)`);
  await app.waitFor(`!!${MENU}`, 3000);
  await app.evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }))`);
  check(`${theme}: a click outside closes the menu`, !!(await app.waitFor(`!${MENU}`, 3000)));
  check(`${theme}: closing without choosing picks nothing`, (await app.evaluate(`window.__harness.picked.length`)) === pickedNow);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'task-menu-theme-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await app.send('Page.navigate', { url: `http://localhost:${PORT}/tests/helpers/task-context-menu-harness.html` });
    const ready = await app.waitFor(`window.__harnessReady === true`, 30000);
    check('harness page loaded', !!ready);
    if (!ready) throw new Error('task context menu harness did not load');
    await app.evaluate(PROBE);
    check('two synthetic task rows mounted', (await app.evaluate(`window.__harness.rows()`)) === 2);

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

main().then((code) => process.exit(code)).catch((err) => {
  console.error('UNEXPECTED ERROR:', err && err.stack || err);
  process.exit(1);
});
