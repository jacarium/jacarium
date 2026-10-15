#!/usr/bin/env node
/**
 * Screenshot / measure the running app in Linux Chromium.
 *
 * Starts the Vite dev server, opens the app in headless Chromium (classic,
 * layout-taking scrollbars by default - what Linux users see), optionally
 * navigates to a page and runs a setup module, then writes a PNG and a JSON
 * of layout measurements to tests/linux/out/ (git-ignored).
 *
 * Usage (normally via tests/linux/run.sh screenshot ...):
 *   node tests/linux/screenshot.mjs [options]
 *
 * Options:
 *   --page <label>        click the left-rail nav item with this hover label
 *                         (Documents, Calendars, Kanban, Tasks, Workflow Builder,
 *                         Diagnostics, JQL Search, Tools). Default: none (app start page)
 *   --setup <file.mjs>    module whose default export is `async ({ evaluate, send,
 *                         sleep, screenshot, url }) => {}`, run after the page loads
 *                         (seed synthetic data, expand things, open a dialog ...)
 *   --selector <css>      clip the screenshot to this element (default: full window)
 *   --measure <css>       print + save scrollWidth/clientWidth/offsetWidth for this
 *                         element and every ancestor (finds horizontal overflow and
 *                         scrollbar gutters); may be repeated
 *   --out <name>          output basename (default: screenshot) -> out/<name>.png + .json
 *   --width/--height <px> window size (default 1400x900)
 *   --wait <ms>           extra settle time once the app has mounted / after setup (default 4000)
 *   --overlay-scrollbars  launch Chromium with --enable-features=OverlayScrollbar
 *                         (zero-width scrollbars, like macOS) for comparison
 *   --dark                add the `dark` class to <html> before capturing
 *
 * Exit code: 0 on success, 1 if the page could not be loaded/measured.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT_DIR, clickNavPage, connect, ensureOutDir, launchChromium, measureChainExpr, scrollbarProbeExpr, sleep, startVite, waitForApp } from './lib/harness.mjs';

function parseArgs(argv) {
  const opts = { measure: [], width: 1400, height: 900, wait: 4000, out: 'screenshot' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--page': opts.page = next(); break;
      case '--setup': opts.setup = next(); break;
      case '--selector': opts.selector = next(); break;
      case '--measure': opts.measure.push(next()); break;
      case '--out': opts.out = next(); break;
      case '--width': opts.width = Number(next()); break;
      case '--height': opts.height = Number(next()); break;
      case '--wait': opts.wait = Number(next()); break;
      case '--overlay-scrollbars': opts.overlay = true; break;
      case '--dark': opts.dark = true; break;
      case '--help': case '-h': opts.help = 0; break;
      default: console.error(`unknown option ${a}`); opts.help = 1;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help !== undefined) {
  // Print this file's header comment as the usage text
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  console.log(src.split('*/')[0].replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(opts.help);
}

ensureOutDir();
const vite = await startVite();
const chrome = await launchChromium({ width: opts.width, height: opts.height, overlayScrollbars: !!opts.overlay });
let exitCode = 1;
try {
  const cdp = await connect(chrome.page);
  const { send, evaluate, screenshot } = cdp;
  await send('Page.navigate', { url: vite.url });
  await waitForApp(evaluate);
  await sleep(opts.wait);
  if (opts.dark) await evaluate(`document.documentElement.classList.add('dark')`);
  if (opts.page) await clickNavPage(evaluate, opts.page);
  if (opts.setup) {
    const mod = await import(pathToFileURL(path.resolve(opts.setup)).href);
    await mod.default({ evaluate, send, sleep, screenshot, url: vite.url });
    await sleep(Math.min(opts.wait, 1500));
  }

  const result = {
    scrollbars: await evaluate(scrollbarProbeExpr),
    overlayScrollbarsFlag: !!opts.overlay,
    measurements: {},
  };
  for (const sel of opts.measure) {
    result.measurements[sel] = await evaluate(measureChainExpr(sel));
    const m = result.measurements[sel];
    if (m.error) { console.log(`measure ${sel}: ${m.error}`); continue; }
    console.log(`\nmeasure ${sel} (element first, then ancestors):`);
    for (const e of m.chain) {
      console.log(`  ${e.horizontalOverflow ? 'OVERFLOW ' : '         '}<${e.tag} class="${e.cls}"> scroll=${e.scrollWidth} client=${e.clientWidth} offset=${e.offsetWidth} gutter=${e.gutter} overflow-x=${e.overflowX}`);
    }
  }

  let clip;
  if (opts.selector) {
    const rect = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(opts.selector)}); return e ? e.getBoundingClientRect().toJSON() : null; })()`);
    if (!rect) throw new Error(`--selector ${opts.selector} matched nothing`);
    clip = { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }
  const png = await screenshot(opts.out, clip);
  const json = path.join(OUT_DIR, `${opts.out}.json`);
  writeFileSync(json, JSON.stringify(result, null, 2));
  console.log(`\nscrollbars: native gutter ${result.scrollbars.nativeGutter}px, thin ${result.scrollbars.thinGutter}px, with app styles ${result.scrollbars.appStylesGutter}px (${result.scrollbars.userAgent})`);
  console.log(`wrote ${png}\nwrote ${json}`);
  if (cdp.errors.length) console.log('page exceptions:\n  ' + cdp.errors.join('\n  '));
  cdp.close();
  exitCode = 0;
} catch (e) {
  console.error('FAIL:', e.message || e);
} finally {
  await chrome.stop();
  await vite.stop();
}
process.exit(exitCode);
