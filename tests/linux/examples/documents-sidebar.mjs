#!/usr/bin/env node
/**
 * Example / regression check: the Documents sidebar on Linux.
 *
 * THE BUG: on Linux, expanding a category whose documents have long titles
 * showed an empty strip down the right-hand side of the Documents sidebar
 * that macOS never showed. Linux Chromium lays out classic scrollbars that
 * take horizontal space (~10px for the app's `scrollbar-width: thin`), macOS
 * overlay scrollbars take none - so as soon as the list overflows vertically
 * (an expanded category), every row lost 10px on the right. The title text
 * itself already truncated correctly (`min-w-0` + `truncate`); nothing in
 * the row chain overflowed horizontally. The fix opts Linux into Chromium's
 * overlay scrollbars from the Electron main process.
 *
 * What this proves in a REAL Linux Chromium against the REAL app, on a
 * throwaway profile with synthetic titles only:
 *   - the sidebar's scroll container has no horizontal overflow, in the
 *     default state, with a document open, in selection mode and while renaming;
 *   - every document row is exactly as wide as the scroll container;
 *   - long titles are ellipsized and carry the full title as a tooltip;
 *   - it reports the scrollbar gutter (offsetWidth - clientWidth) of the list:
 *     ~10px with the platform's classic scrollbars, 0 with
 *     `--overlay-scrollbars` (what the Electron fix turns on for Linux).
 *
 * Run (inside the container):
 *   tests/linux/run.sh example documents-sidebar
 *   tests/linux/run.sh example documents-sidebar --overlay-scrollbars
 * Or anywhere with Chrome:  CHROME_BIN=... node tests/linux/examples/documents-sidebar.mjs
 *
 * Outputs tests/linux/out/documents-sidebar[-overlay].png and .json.
 * Exit code: 0 = all checks passed, 1 = a check failed.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, connect, ensureOutDir, evaluateWithRetry, launchChromium, makeChecker, scrollbarProbeExpr, sleep, startVite, waitFor, waitForApp } from '../lib/harness.mjs';

const overlay = process.argv.includes('--overlay-scrollbars');
const suffix = overlay ? '-overlay' : '';
const { check, summary } = makeChecker();

// Synthetic fixture titles (no real documents): short -> very long.
const TITLES = [
  'Short',
  'Medium length document title here',
  'A considerably longer document title that will certainly not fit in the sidebar width',
  'An extremely long document title ' + 'lorem ipsum dolor sit amet consectetur '.repeat(6),
];

ensureOutDir();
const vite = await startVite();
const chrome = await launchChromium({ overlayScrollbars: overlay });
let exitCode = 1;
try {
  const cdp = await connect(chrome.page);
  const { send, evaluate, screenshot } = cdp;
  await send('Page.navigate', { url: vite.url });
  await waitForApp(evaluate);

  // Seed documents through the app's own IndexedDB layer, expand both
  // categories, then reload so the sidebar renders them from a cold start.
  const SIDEBAR_READY = `!!document.querySelector('input[placeholder="Search documents..."]')`;
  await evaluateWithRetry(evaluate, `(async () => {
    const m = await import('/src/utils/documents.js');
    if ((await m.getDocuments()).length) return; // a retry after a partial first attempt
    for (const t of ${JSON.stringify(TITLES)}) await m.createDocument({ title: t, content: 'synthetic', category: 'General' });
    for (let i = 0; i < 12; i++) await m.createDocument({ title: 'Ops doc ' + i + ' ' + 'padding words '.repeat(i), content: 'synthetic', category: 'Ops' });
    localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General', 'Ops']));
    localStorage.setItem('innerSidebarVisible', 'true');
  })()`);
  await send('Page.reload');
  await waitFor(evaluate, SIDEBAR_READY, { label: 'documents sidebar' });
  await waitFor(evaluate, `document.querySelectorAll('div.group.relative span.truncate').length >= ${TITLES.length}`, { label: 'seeded rows' });
  await sleep(1000);

  const measureExpr = `(() => {
    const scroller = Array.from(document.querySelectorAll('div.flex-1.overflow-y-auto')).find(d => d.querySelector('input[placeholder="Search documents..."]'));
    if (!scroller) return { error: 'documents sidebar scroll container not found' };
    const chain = [];
    for (let e = scroller; e && e !== document.body; e = e.parentElement) {
      chain.push({ cls: (e.className || '').toString().trim().slice(0, 60), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, offsetWidth: e.offsetWidth });
    }
    const sRect = scroller.getBoundingClientRect();
    // Right edge of the scroll container's CONTENT box (excludes a classic scrollbar's gutter)
    const contentRight = sRect.left + scroller.clientLeft + scroller.clientWidth;
    const rows = Array.from(scroller.querySelectorAll('div.group.relative')).map(r => {
      const span = r.querySelector('span.truncate');
      const cs = span ? getComputedStyle(span) : null;
      return {
        title: span?.textContent || '', tooltip: span?.getAttribute('title') || null,
        rowWidth: r.getBoundingClientRect().width, rowRightGap: contentRight - r.getBoundingClientRect().right,
        rowOverflow: r.scrollWidth > r.clientWidth,
        spanClipped: span ? span.scrollWidth > span.clientWidth : null,
        ellipsis: cs ? cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' && cs.overflowX === 'hidden' : null,
      };
    });
    const sidebar = scroller.closest('[style*="width"]');
    return {
      scroller: { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, offsetWidth: scroller.offsetWidth, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, gutter: scroller.offsetWidth - scroller.clientWidth },
      chain, rows, sidebarRect: sidebar ? sidebar.getBoundingClientRect().toJSON() : null,
    };
  })()`;

  const clickRow = async (i, clickCount = 1) => {
    const pt = await evaluate(`(() => { const r = Array.from(document.querySelectorAll('div.group.relative'))[${i}].getBoundingClientRect(); return { x: r.x + 60, y: r.y + r.height / 2 }; })()`);
    for (let c = 1; c <= clickCount; c++) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: c });
    }
  };
  const noOverflow = (m) => !m.error && m.scroller.scrollWidth <= m.scroller.clientWidth && m.chain.every((c) => c.scrollWidth <= c.clientWidth) && m.rows.every((r) => !r.rowOverflow);
  const detail = (m) => m.error || `scroller scrollWidth=${m.scroller.scrollWidth} clientWidth=${m.scroller.clientWidth} offsetWidth=${m.scroller.offsetWidth}`;

  const states = {};
  states.default = await evaluate(measureExpr);
  check('sidebar renders the seeded categories and rows', !states.default.error && states.default.rows.length === TITLES.length + 12, detail(states.default));
  check('default state: no horizontal overflow in the sidebar chain', noOverflow(states.default), detail(states.default));
  check('the list overflows vertically (so a vertical scrollbar is in play)', states.default.scroller.scrollHeight > states.default.scroller.clientHeight);
  check('every row is exactly as wide as the scroll container', states.default.rows.every((r) => Math.abs(r.rowWidth - states.default.scroller.clientWidth) < 1 && Math.abs(r.rowRightGap) < 1),
    'row widths: ' + [...new Set(states.default.rows.map((r) => Math.round(r.rowWidth)))].join(',') + ' vs clientWidth ' + states.default.scroller.clientWidth);
  const long = states.default.rows.filter((r) => r.title.length > 40);
  check('long titles are ellipsized (nowrap + hidden + ellipsis) and clipped', long.length > 0 && long.every((r) => r.ellipsis && r.spanClipped));
  check('truncated rows expose the full title as a tooltip', long.every((r) => r.tooltip === r.title));
  if (states.default.sidebarRect) {
    const r = states.default.sidebarRect;
    await screenshot(`documents-sidebar${suffix}`, { x: r.x, y: r.y, width: r.width + 8, height: Math.min(r.height, 700) });
  }

  await clickRow(0); await sleep(1500);
  states.documentOpen = await evaluate(measureExpr);
  check('with the longest document open: no horizontal overflow', noOverflow(states.documentOpen), detail(states.documentOpen));

  await evaluate(`document.querySelector('button[title="Select multiple"]').click()`); await sleep(500);
  await clickRow(0); await sleep(300);
  states.selectionMode = await evaluate(measureExpr);
  check('selection mode with a selected row: no horizontal overflow', noOverflow(states.selectionMode), detail(states.selectionMode));
  await evaluate(`document.querySelector('button[title="Exit selection mode"]').click()`); await sleep(500);

  await clickRow(0, 2); await sleep(600);
  states.rename = await evaluate(measureExpr);
  check('rename (inline input) on the longest title: no horizontal overflow', noOverflow(states.rename), detail(states.rename));
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  const gutter = states.default.scroller.gutter;
  const probe = await evaluate(scrollbarProbeExpr);
  console.log(`\nscrollbar gutter on the document list: ${gutter}px (native ${probe.nativeGutter}px, thin ${probe.thinGutter}px) - ${probe.userAgent}`);
  if (overlay) {
    check('with overlay scrollbars (the Linux fix) the list has no scrollbar gutter', gutter === 0, `gutter=${gutter}`);
  } else {
    console.log(gutter > 0
      ? `INFO: classic scrollbars take ${gutter}px on the right of the list - this is the "gap"; rerun with --overlay-scrollbars to see the fixed layout`
      : 'INFO: this Chromium uses overlay scrollbars (no gutter)');
  }

  writeFileSync(path.join(OUT_DIR, `documents-sidebar${suffix}.json`), JSON.stringify({ probe, states }, null, 2));
  if (cdp.errors.length) console.log('page exceptions:\n  ' + cdp.errors.join('\n  '));
  cdp.close();
  exitCode = summary();
} catch (e) {
  console.error('ERROR:', e);
} finally {
  await chrome.stop();
  await vite.stop();
}
process.exit(exitCode);
