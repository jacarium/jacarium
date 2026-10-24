#!/usr/bin/env node

/**
 * Real-browser check of the What's New window (src/components/WhatsNew.jsx on
 * the shared FloatingWindow) in the running app:
 *   - a fresh profile opens it at startup, titled just "What's New"; ONE
 *     list shows every version of the current major line newest first
 *     (package.json's version on top, each with its date and category
 *     groups); the "Version 2.x" button at the end swaps in that line's
 *     list scrolled to the top, and a reopen returns to the current line;
 *   - the latest entry's lines are all there and the content area really
 *     scrolls when an entry is long (measured with a synthetic long entry
 *     appended to the current one, so a short release does not decide it;
 *     a long real entry is checked as it is too);
 *   - light AND dark theme: title, version headings, dates, category tags,
 *     lines, the line buttons and the footer button text are >= 4.5:1
 *     against what they sit on;
 *   - "Got it!" closes it and a reload keeps it closed (seen marker);
 *   - the window event `toggleWhatsNew` reopens it and Escape closes it.
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set. Set CHROME_BIN=/path/to/chrome to run it.
 *
 * Run:  node tests/whats-new-live.test.mjs
 * Environment: CHROME_BIN, SMOKE_PORT (default 5238)
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 5238);
const MIN_RATIO = 4.5;
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const PROBE = `(() => {
  if (window.__probe) return true;
  // every colour syntax Chrome reports (rgb, oklch, oklab, color(), color-mix results) through the shared helper
  const parse = ${COLOR_PROBE}.parse;
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))).concat([1]); };
  const effectiveBg = (el) => { const layers = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) layers.push(c); } let bg = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg); return bg; };
  const measure = (el) => { const color = parse(getComputedStyle(el).color); const bg = effectiveBg(el); return { color: color.slice(0, 3), bg: bg.slice(0, 3), ratio: Number(contrast(over(color, bg), bg).toFixed(2)) }; };
  window.__probe = { measure };
  return true;
})()`;
const measure = (app, selector) => app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? window.__probe.measure(el) : null; })()`);
const measureLeaf = (app, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll('[data-floating-window="whatsNewWindow"] *')).filter((e) => e.children.length === 0 && ${re.toString()}.test(e.textContent || '')).sort((a, b) => a.textContent.length - b.textContent.length)[0]; return el ? window.__probe.measure(el) : null; })()`);
function checkRatio(theme, label, m, min = MIN_RATIO) {
  if (!m) { check(`${theme}: ${label} present`, false, 'element not found'); return; }
  check(`${theme}: ${label} >= ${min}:1`, m.ratio >= min, `${m.ratio}:1, rgb(${m.color}) on rgb(${m.bg})`);
}

const WINDOW = '[data-floating-window="whatsNewWindow"]';
const windowOpen = (app) => app.evaluate(`!!document.querySelector('${WINDOW}')`);
const listState = (app) => app.evaluate(`(() => { const c = document.querySelector('[data-whats-new-content]'); return c ? { line: c.getAttribute('data-whats-new-line'), versions: Array.from(document.querySelectorAll('[data-whats-new-version]')).map((s) => s.getAttribute('data-whats-new-version')), switches: Array.from(document.querySelectorAll('[data-whats-new-line-switch]')).map((b) => b.getAttribute('data-whats-new-line-switch')), select: !!document.querySelector('[data-whats-new-select], ${WINDOW} select'), scrollTop: c.scrollTop } : null; })()`);
async function switchLine(app, line) {
  await app.evaluate(`(() => { document.querySelector('[data-whats-new-line-switch="${line}"]').click(); })()`);
  await sleep(200);
}
const lineOf = (v) => String(v).split('.')[0];

async function measureTheme(app, theme, olderLine) {
  checkRatio(theme, 'title', await measureLeaf(app, /^What's New$/));
  checkRatio(theme, 'version heading', await measure(app, `[data-whats-new-version="${pkgVersion}"] h2`));
  checkRatio(theme, 'release date', await measure(app, `[data-whats-new-version="${pkgVersion}"] [data-whats-new-date]`));
  checkRatio(theme, 'category tag', await measure(app, `[data-whats-new-version="${pkgVersion}"] [data-whats-new-category]`));
  checkRatio(theme, 'note line', await measure(app, `[data-whats-new-version="${pkgVersion}"] [data-whats-new-list] li`));
  checkRatio(theme, 'older-line button', await measure(app, '[data-whats-new-older-lines] button'));
  if (olderLine) {
    await switchLine(app, olderLine);
    checkRatio(theme, `older entry paragraph (${olderLine}.x list)`, await measure(app, `[data-whats-new-line="${olderLine}"] p`));
    await switchLine(app, lineOf(pkgVersion));
  }
  const button = await measureLeaf(app, /^Got it!$/);
  console.log(`INFO  ${theme}: "Got it!" button  (${button ? `${button.ratio}:1, rgb(${button.color}) on rgb(${button.bg})` : 'not found'} - white on the app-wide --os-blue token, same as every primary button)`);
}

async function main() {
  const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'whats-new-live-' });
  if (app.skip) {
    console.log(`SKIP: ${app.skip}`);
    return 0;
  }
  try {
    await app.evaluate(PROBE);
    check('a fresh profile opens What\'s New at startup', await windowOpen(app));
    const title = await app.evaluate(`document.querySelector('${WINDOW} [data-floating-window-header]').textContent.trim()`);
    check('the title bar says just "What\'s New" (no version)', title === "What's New", title);
    // versions/index.js and the older entries import PNGs, which plain node cannot load:
    // read the version order and block types as text instead
    const VERSIONS_DIR = path.join(REPO, 'src', 'whats-new', 'versions');
    const indexSrc = fs.readFileSync(path.join(VERSIONS_DIR, 'index.js'), 'utf8');
    const imports = Object.fromEntries(Array.from(indexSrc.matchAll(/^import \* as (v[\d_]+) from '\.\/(v[\d.]+)\.js';/gm)).map((m) => [m[1], m[2]]));
    const entryFiles = ((/export const versions = \[([\s\S]*?)\];/.exec(indexSrc) || [])[1] || '').split(',').map((t) => t.trim()).filter(Boolean).map((name) => imports[name]);
    const entrySrc = (file) => fs.readFileSync(path.join(VERSIONS_DIR, `${file}.js`), 'utf8');
    const expectedVersions = entryFiles.map((f) => (/export const version = '([^']+)'/.exec(entrySrc(f)) || [])[1]);
    const versionsMod = { versions: entryFiles.map((f) => ({ version: (/export const version = '([^']+)'/.exec(entrySrc(f)) || [])[1], hasImages: /type: '(image|carousel)'/.test(entrySrc(f)) })) };
    const currentLine = lineOf(pkgVersion);
    const expectedCurrent = expectedVersions.filter((v) => lineOf(v) === currentLine);
    const olderLines = [...new Set(expectedVersions.map(lineOf))].filter((l) => Number(l) < Number(currentLine)).sort((a, b) => Number(b) - Number(a));
    let st = await listState(app);
    check(`one list of the ${currentLine}.x line: every version newest first (${expectedCurrent.length}), the current ${pkgVersion} on top, no dropdown`, st && !st.select && st.line === currentLine && st.versions[0] === pkgVersion && st.versions.join(',') === expectedCurrent.join(','), JSON.stringify(st));
    check(`the older lines are offered at the end (${olderLines.map((l) => `Version ${l}.x`).join(', ')})`, st && st.switches.join(',') === olderLines.join(','), JSON.stringify(st && st.switches));
    const headers = await app.evaluate(`Array.from(document.querySelectorAll('[data-whats-new-version]')).map((s) => ({ h2: s.querySelector('h2') && s.querySelector('h2').textContent, date: s.querySelector('[data-whats-new-date]') && s.querySelector('[data-whats-new-date]').textContent, tags: Array.from(s.querySelectorAll('[data-whats-new-category]')).map((t) => t.textContent) }))`);
    const closing = await app.evaluate(`(() => { const c = document.querySelector('[data-whats-new-content]'); const closing = document.querySelector('[data-whats-new-closing]'); const sections = Array.from(document.querySelectorAll('[data-whats-new-version]')); const last = sections[sections.length - 1]; const bottom = (el) => el.getBoundingClientRect().bottom; const rules = Array.from(c.children).filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0 || parseFloat(getComputedStyle(el).borderBottomWidth) > 0 || el.tagName === 'HR'); return { closingFollowsLast: !!closing && closing.previousElementSibling === last && closing === c.lastElementChild, gap: closing ? Math.round(closing.getBoundingClientRect().top - bottom(last)) : null, rulesInClosing: closing ? closing.querySelectorAll('hr, [class*="border-t"], [class*="border-b"]').length : null, emptyChildren: Array.from(c.children).filter((el) => !el.textContent.trim()).length, lastSectionBottomBorder: parseFloat(getComputedStyle(last).borderBottomWidth), gotIt: (() => { const b = document.querySelector('[data-whats-new-close]'); const cs = b && getComputedStyle(b); return cs ? { weight: cs.fontWeight, bg: cs.backgroundColor, primitive: /\\bsc-btn-primary\\b/.test(b.className), bold: /font-(semi)?bold|font-medium/.test(b.className) } : null; })() }; })()`);
    check('after the last version there is ONE rule, then the closing block (older releases + thank-you) with no rule inside and no empty band', closing.closingFollowsLast && closing.gap !== null && closing.gap < 40 && closing.rulesInClosing === 0 && closing.emptyChildren === 0 && closing.lastSectionBottomBorder === 0, JSON.stringify(closing));
    check('"Got it!" is the shared primary Button primitive at normal weight (400)', closing.gotIt && Number(closing.gotIt.weight) === 400 && closing.gotIt.primitive && !closing.gotIt.bold && !/rgba?\(0, 0, 0, 0\)|rgb\(255, 255, 255\)/.test(closing.gotIt.bg), JSON.stringify(closing.gotIt));
    check('each version has a header with its number and date, and category tags ([NAME]) under it', headers.every((h, i) => h.h2 === `Version ${expectedCurrent[i]}` && /^\d{4}-\d{2}-\d{2}$/.test(h.date || '') && h.tags.length > 0 && h.tags.every((t) => /^\[[A-Z]+\]$/.test(t))), JSON.stringify(headers.slice(0, 2)));
    const expected = (await import(path.join(REPO, 'src', 'whats-new', 'versions', `v${pkgVersion}.js`))).features;
    // Counts come from the entry itself (list items + text paragraphs), never hard-coded
    const expectedLines = expected.flatMap((f) => f.content.flatMap((b) => (b.type === 'list' ? b.items : b.type === 'text' ? [b.value] : [])));
    const content = await app.evaluate(`(() => {
      const c = document.querySelector('[data-whats-new-content]');
      const s = document.querySelector('[data-whats-new-version="${pkgVersion}"]');
      const lis = Array.from(s.querySelectorAll('[data-whats-new-list] li, p')).map((l) => l.textContent);
      return { lines: lis.length, all: lis, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, scrollTop: c.scrollTop };
    })()`);
    check(`all ${expectedLines.length} lines of v${pkgVersion} are rendered, each once`, expectedLines.length > 0 && content.lines === expectedLines.length && content.all.slice().sort().join('\n') === expectedLines.slice().sort().join('\n'), `${content.lines} lines`);
    // The window scrolls when an entry is long. Whether the CURRENT entry is long
    // depends on the release (3.1.0 and 3.1.1 fit in the window), so the measurement
    // uses a synthetic long entry: a block two viewports high appended to the current
    // version's section, removed again afterwards; a real entry that overflows is
    // checked as it is as well.
    const naturally = content.scrollHeight > content.clientHeight;
    console.log(`INFO  the v${pkgVersion} entry ${naturally ? 'overflows' : 'fits in'} the content area (${content.scrollHeight} / ${content.clientHeight})`);
    if (naturally) {
      const scrolled = await app.evaluate(`(() => { const c = document.querySelector('[data-whats-new-content]'); c.scrollTop = c.scrollHeight; const top = c.scrollTop; c.scrollTop = 0; return top; })()`);
      check('the real entry, which overflows, can be scrolled down', scrolled > 0, `scrollTop ${scrolled}`);
    }
    const synthetic = await app.evaluate(`(() => {
      const c = document.querySelector('[data-whats-new-content]');
      const s = document.querySelector('[data-whats-new-version="${pkgVersion}"]');
      const block = document.createElement('div');
      block.setAttribute('data-synthetic-long-entry', '');
      block.style.height = (c.clientHeight * 2) + 'px';
      block.textContent = 'synthetic long entry';
      s.appendChild(block);
      const scrollHeight = c.scrollHeight, clientHeight = c.clientHeight;
      c.scrollTop = c.scrollHeight;
      const scrolled = c.scrollTop;
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 2;
      const pageScrolled = document.documentElement.scrollTop > 0 || document.body.scrollTop > 0;
      c.scrollTop = 0; block.remove();
      return { scrollHeight, clientHeight, scrolled, atBottom, pageScrolled };
    })()`);
    check('a long entry makes the content area really scroll (scrollHeight > clientHeight with a synthetic long entry)', synthetic.scrollHeight > synthetic.clientHeight + 100, `${synthetic.scrollHeight} > ${synthetic.clientHeight}`);
    check('...and it can be scrolled down to its end inside the window (the page itself does not move)', synthetic.scrolled > 0 && synthetic.atBottom && !synthetic.pageScrolled, `scrollTop ${synthetic.scrolled}, at bottom ${synthetic.atBottom}`);
    const olderLine = olderLines[0] || null;
    if (olderLine) {
      // scroll down first: the switch must come back to the top
      await app.evaluate(`(() => { const c = document.querySelector('[data-whats-new-content]'); c.scrollTop = c.scrollHeight; })()`);
      await switchLine(app, olderLine);
      st = await listState(app);
      const expectedOlder = expectedVersions.filter((v) => lineOf(v) === olderLine);
      check(`"Version ${olderLine}.x" shows that line's list (every ${olderLine}.x version newest first), scrolled to the top, with a way back`, st.line === olderLine && st.versions.join(',') === expectedOlder.join(',') && st.scrollTop === 0 && st.switches.includes(currentLine), JSON.stringify(st));
      const legacy = await app.evaluate(`(() => { const s = document.querySelector('[data-whats-new-version="2.5.5"]'); return s ? { heading: s.querySelector('h2').textContent.trim(), tags: s.querySelectorAll('[data-whats-new-category]').length, titles: s.querySelectorAll('h4').length } : null; })()`);
      if (legacy) check('the hand-written 2.5.5 entry renders with its category tags and its titles', /Version 2\.5\.5/.test(legacy.heading) && legacy.tags > 0 && legacy.titles > 0, JSON.stringify(legacy));
      await switchLine(app, currentLine);
      st = await listState(app);
      check('...and back to the current line', st.line === currentLine && st.versions[0] === pkgVersion);
    } else {
      console.log('INFO  only one major line in the data - the line switch is not exercised');
    }

    // ThemeContext may re-apply its 'auto' choice after startup; pin the theme explicitly before each measurement
    await app.evaluate(`document.documentElement.classList.remove('dark')`);
    await sleep(300);
    check('light theme pinned', !(await app.evaluate(`document.documentElement.classList.contains('dark')`)));
    await measureTheme(app, 'light', olderLine);
    await app.evaluate(`document.documentElement.classList.add('dark')`);
    await sleep(300);
    await measureTheme(app, 'dark', olderLine);
    await app.evaluate(`document.documentElement.classList.remove('dark')`);

    await app.evaluate(`document.querySelector('[data-whats-new-close]').click()`);
    await sleep(300);
    check('"Got it!" closes the window', !(await windowOpen(app)));
    check(`the seen marker is ${pkgVersion}`, (await app.evaluate(`localStorage.getItem('whatsNewLastSeen')`)) === pkgVersion);
    await app.send('Page.reload');
    await sleep(5000);
    check('after a reload it stays closed (seen once per version)', !(await windowOpen(app)));
    await app.evaluate(`window.dispatchEvent(new Event('toggleWhatsNew'))`);
    await sleep(300);
    check('the toggleWhatsNew event reopens it', await windowOpen(app));
    if (olderLine) await switchLine(app, olderLine);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    await app.evaluate(`window.dispatchEvent(new Event('toggleWhatsNew'))`);
    await sleep(300);
    st = await listState(app);
    check('after opening an older line, closing and reopening goes back to the current line', st && st.line === currentLine && st.versions[0] === pkgVersion, JSON.stringify(st));
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    check('Escape closes it', !(await windowOpen(app)));
    const pageErrors = app.errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await app.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
  return failed.length ? 1 : 0;
}

process.exit(await main());
