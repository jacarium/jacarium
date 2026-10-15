/**
 * Guards the What's New window (src/components/WhatsNew.jsx), on the shared
 * FloatingWindow chrome (src/components/common/FloatingWindow.jsx), with the
 * REAL version data (src/whats-new/versions):
 *   - on a fresh profile it opens by itself, titled "What's New";
 *   - ONE scrollable list of the current major line (3.x): every version
 *     newest first, each a header with its number and release date followed
 *     by its changes; no version dropdown anywhere;
 *   - within a version the changes are grouped by category under tag-style
 *     headings ([DOCUMENTS], [SECURITY], ...) in the fixed order of
 *     src/whats-new/categories.js (MISC last), every line exactly once;
 *   - the end of the list offers "Version 2.x" (and older lines); the switch
 *     shows that line's list the same way, with a way back; a reopen starts
 *     at the current line again;
 *   - versions newer than the last one seen carry a "new" badge;
 *   - "Got it!", the x button and Escape close it and record the version as
 *     seen; a remount then stays closed; the `toggleWhatsNew` event reopens
 *     it; a different seen version opens it again (show once per version);
 *   - the `whatsNewStateChange` event is broadcast; no hard-coded colours;
 *     the content region is keyboard-focusable.
 *
 * Run:  node tests/whats-new-window.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, byText, click, sleep, REPO } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('whats-new-window', { entry: path.join(here, 'helpers', 'whats-new-entry.mjs') });
const { renderWhatsNew, unmountWhatsNew, versionsData, categoriesData, WHATS_NEW_SEEN_KEY } = mod;
const { document } = window;
const { versions, latestVersion } = versionsData;
const { CATEGORIES } = categoriesData;
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

const win = () => document.querySelector('[data-floating-window="whatsNewWindow"]');
const content = () => document.querySelector('[data-whats-new-content]');
const sections = () => Array.from(document.querySelectorAll('[data-whats-new-version]'));
const sectionVersions = () => sections().map((s) => s.getAttribute('data-whats-new-version'));
const lineOf = (v) => String(v).split('.')[0];
const currentLine = lineOf(latestVersion);
const lines = [...new Set(versions.map((v) => lineOf(v.version)))].sort((a, b) => Number(b) - Number(a));
const ofLine = (line) => versions.filter((v) => lineOf(v.version) === line);
const stateEvents = [];
window.addEventListener('whatsNewStateChange', (e) => stateEvents.push(e.detail.isOpen));
// lines of an entry as the data has them (list items + text paragraphs), in category order
const categoryOf = (f) => (CATEGORIES.includes(f.category) ? f.category : 'MISC');
const linesOf = (v) => CATEGORIES.flatMap((c) => v.features.filter((f) => categoryOf(f) === c).flatMap((f) => f.content.flatMap((b) => (b.type === 'list' ? b.items : b.type === 'text' ? [b.value] : []))));
const renderedLinesOf = (section) => Array.from(section.querySelectorAll('[data-whats-new-list] li, p')).map((el) => el.textContent);

/* ================================================================== */
console.log('\n--- 1. fresh profile: one list of the current line ---');
/* ================================================================== */
{
  window.localStorage.removeItem(WHATS_NEW_SEEN_KEY);
  window.localStorage.removeItem('whatsNewWindow');
  renderWhatsNew();
  await sleep(30);
  check('the window opens by itself on a fresh profile, on the shared FloatingWindow chrome', !!win() && win().classList.contains('fixed') && !!win().querySelector('[data-floating-window-header]'));
  check('it is titled just "What\'s New" - no version in the title bar', win().querySelector('[data-floating-window-header]').textContent.trim() === "What's New" && !document.querySelector('[data-whats-new-version-badge]'), win().querySelector('[data-floating-window-header]').textContent.trim());
  check('the state change was broadcast as open', stateEvents[stateEvents.length - 1] === true);
  check('it is draggable and resizable (header handle + resize grips)', win().querySelector('[data-floating-window-header]').className.includes('cursor-grab') && win().querySelectorAll('.cursor-nwse-resize, .cursor-ew-resize, .cursor-ns-resize').length === 3);
  check('there is no version dropdown', !document.querySelector('[data-whats-new-select], select'));
  check(`the content is one scroll container showing the current line (${currentLine}.x)`, !!content() && content().classList.contains('overflow-y-auto') && content().getAttribute('data-whats-new-line') === currentLine);
  check('the content region is keyboard-focusable and labelled', content().getAttribute('tabindex') === '0' && /Release notes/.test(content().getAttribute('aria-label') || ''));
  check(`every version of the ${currentLine}.x line is listed, newest first, the current one first (= package.json)`, sectionVersions().join(',') === ofLine(currentLine).map((v) => v.version).join(',') && sectionVersions()[0] === latestVersion && latestVersion === pkgVersion, sectionVersions().join(','));
  check('no other line is in the list', sectionVersions().every((v) => lineOf(v) === currentLine));
  const headers = sections().map((s) => ({ h2: s.querySelector('h2')?.textContent, date: s.querySelector('[data-whats-new-date]')?.textContent }));
  check('each version has a header with its number...', headers.every((h, i) => h.h2 === `Version ${sectionVersions()[i]}`), JSON.stringify(headers.slice(0, 2)));
  const withDates = ofLine(currentLine).filter((v) => v.date);
  check(`...and its release date (${withDates.length} of ${ofLine(currentLine).length} entries carry one)`, withDates.length > 0 && sections().every((s, i) => { const v = ofLine(currentLine)[i]; const t = s.querySelector('[data-whats-new-date]'); return v.date ? t?.textContent === v.date && t.getAttribute('datetime') === v.date : !t; }));
  check('the current version is marked "current"', /current/i.test(sections()[0].textContent) && !sections()[0].querySelector('[data-whats-new-new-badge]'));

  // categories
  const latest = versions[0];
  const first = sections()[0];
  const tags = Array.from(first.querySelectorAll('[data-whats-new-category]')).map((h) => h.getAttribute('data-whats-new-category'));
  const expectedTags = CATEGORIES.filter((c) => latest.features.some((f) => categoryOf(f) === c));
  check(`v${latest.version}: the changes are grouped by category in the fixed order (${tags.join(', ')})`, tags.length > 0 && tags.join(',') === expectedTags.join(','), tags.join(','));
  check('the headings are tag-style: "[CATEGORY]" in a mono chip', Array.from(first.querySelectorAll('[data-whats-new-category]')).every((h) => h.textContent === `[${h.getAttribute('data-whats-new-category')}]` && /font-mono/.test(h.className)));
  check('no day headings remain anywhere', !Array.from(document.querySelectorAll('[data-whats-new-content] h3, [data-whats-new-content] h4')).some((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.textContent.trim())));
  check(`every line of v${latest.version} is rendered exactly once, in category order (${linesOf(latest).length} lines)`, linesOf(latest).length > 0 && renderedLinesOf(first).join('\n') === linesOf(latest).join('\n'), `${renderedLinesOf(first).length} rendered`);
  const allLines = sections().flatMap((s, i) => renderedLinesOf(s).map((l) => `${sectionVersions()[i]}|${l}`));
  check('across the whole list every change appears exactly once', new Set(allLines).size === allLines.length && allLines.length === ofLine(currentLine).reduce((n, v) => n + linesOf(v).length, 0), String(allLines.length));
  check('the fixed order puts MISC last and every category used is a known one', CATEGORIES[CATEGORIES.length - 1] === 'MISC' && Array.from(document.querySelectorAll('[data-whats-new-category]')).every((h) => CATEGORIES.includes(h.getAttribute('data-whats-new-category'))));
  check('every version of the list has at least one category group', sections().every((s) => s.querySelectorAll('[data-whats-new-category]').length > 0));

  // older lines
  const older = lines.filter((l) => Number(l) < Number(currentLine));
  const switches = () => Array.from(document.querySelectorAll('[data-whats-new-older-lines] [data-whats-new-line-switch]')).map((b) => b.getAttribute('data-whats-new-line-switch'));
  check(`the end of the list offers the older lines as buttons (${older.map((l) => `Version ${l}.x`).join(', ')})`, switches().join(',') === older.join(',') && Array.from(document.querySelectorAll('[data-whats-new-older-lines] button')).every((b) => /^Version \d+\.x$/.test(b.textContent.trim())), switches().join(','));
  check('...placed after the last version section, in the closing block', !!document.querySelector('[data-whats-new-older-lines]')?.closest('[data-whats-new-closing]') && Array.from(content().children).indexOf(document.querySelector('[data-whats-new-closing]')) > Array.from(content().children).indexOf(sections()[sections().length - 1]));
  // one rule between any two blocks: no element with a bottom border directly followed by one with a top border, no <hr>, no empty section
  const doubleRule = (container) => Array.from(container.children).some((el, i, all) => i > 0 && /\bborder-b\b/.test(all[i - 1].className) && /\bborder-t\b/.test(el.className));
  check('no doubled separator anywhere in the list (a bottom border followed by a top border), no <hr>', !doubleRule(content()) && !content().querySelector('hr') && sections().every((s) => !/\bborder-b\b/.test(s.className)));
  check('versions are separated by one rule each: every section but the first has a top border, the first none', sections().every((s, i) => (i === 0) !== /\bborder-t\b/.test(s.className)));
  check('the block before the older-lines switch has no bottom border, no section is empty', !/\bborder-b\b/.test(document.querySelector('[data-whats-new-older-lines]').previousElementSibling?.className || '') && sections().every((s) => s.querySelectorAll('[data-whats-new-list] li, p').length > 0));
  const closing = document.querySelector('[data-whats-new-closing]');
  check('after the last version: ONE closing block behind a single rule holding "Older releases" and the thank-you line, nothing else between', !!closing && closing.previousElementSibling === sections()[sections().length - 1] && closing === content().lastElementChild && /\bborder-t\b/.test(closing.className) && closing.contains(document.querySelector('[data-whats-new-older-lines]')) && /Thank you for using Jacarium/.test(closing.textContent) && !closing.querySelector('[class*="border-t"], [class*="border-b"], hr'), closing?.className);
  check('no empty element in the list (every child of the content has text)', Array.from(content().children).every((el) => el.textContent.trim().length > 0));
  const gotIt = document.querySelector('[data-whats-new-close]');
  check('"Got it!" is the shared primary Button primitive at normal weight', !!gotIt && gotIt.tagName === 'BUTTON' && /bg-blue-600/.test(gotIt.className) && !/font-(semi)?bold|font-medium/.test(gotIt.className) && gotIt.textContent.trim() === 'Got it!', gotIt?.className);
  check('the line-switch buttons are the shared Button primitive too', Array.from(document.querySelectorAll('[data-whats-new-line-switch]')).every((b) => /sc-btn|border-os-input-border|bg-os-modal/.test(b.className) && !/font-(semi)?bold/.test(b.className)), document.querySelector('[data-whats-new-line-switch]')?.className);
  if (older.length) {
    const before = content();
    click(window, document.querySelector(`[data-whats-new-line-switch="${older[0]}"]`));
    await sleep(20);
    check(`"Version ${older[0]}.x" shows that line's list: every ${older[0]}.x version newest first, nothing of ${currentLine}.x`, content().getAttribute('data-whats-new-line') === older[0] && sectionVersions().join(',') === ofLine(older[0]).map((v) => v.version).join(','), sectionVersions().join(','));
    check('...as a fresh container scrolled to the top', content() !== before && content().scrollTop === 0);
    const legacy = ofLine(older[0]).find((v) => v.features.some((f) => f.title));
    if (legacy) {
      const s = document.querySelector(`[data-whats-new-version="${legacy.version}"]`);
      check(`a hand-written entry (${legacy.version}) keeps its titles under the category tags, with all of its lines`, Array.from(s.querySelectorAll('h4')).map((h) => h.textContent).sort().join('|') === legacy.features.map((f) => f.title).sort().join('|') && renderedLinesOf(s).join('\n') === linesOf(legacy).join('\n'));
    }
    check('...each version grouped by category too', sections().every((s) => s.querySelectorAll('[data-whats-new-category]').length > 0));
    check(`no doubled separator in the ${older[0]}.x list either`, !doubleRule(content()) && sections().every((s, i) => (i === 0) !== /\bborder-t\b/.test(s.className)) && !content().querySelector('hr'));
    const back = document.querySelector(`[data-whats-new-line-switch="${currentLine}"]`);
    check(`a "Back to version ${currentLine}.x" button is offered`, !!back && new RegExp(`Back to version ${currentLine}\\.x`).test(back.textContent));
    click(window, back);
    await sleep(20);
    check('...and brings the current line back', content().getAttribute('data-whats-new-line') === currentLine && sectionVersions()[0] === latestVersion);
  } else {
    console.log('INFO: only one major line in the data - the line switch is not exercised');
  }
  check('no "new" badge on a fresh profile (nothing was seen before)', !document.querySelector('[data-whats-new-new-badge]'));
}

/* ================================================================== */
console.log('\n--- 2. closing records the version; show once per version; "new" badge ---');
/* ================================================================== */
{
  click(window, byText(document, /^Got it!$/, 'button'));
  await sleep(20);
  check('"Got it!" closes the window and records the version as seen', !win() && window.localStorage.getItem(WHATS_NEW_SEEN_KEY) === latestVersion && stateEvents[stateEvents.length - 1] === false);
  unmountWhatsNew();
  renderWhatsNew();
  await sleep(20);
  check('a remount with the version already seen stays closed', !win());
  window.dispatchEvent(new window.Event('toggleWhatsNew'));
  await sleep(20);
  check('the toggleWhatsNew event reopens it', !!win());
  const older = lines.filter((l) => Number(l) < Number(currentLine));
  if (older.length) {
    click(window, document.querySelector(`[data-whats-new-line-switch="${older[0]}"]`));
    await sleep(20);
    check('an older line can be opened...', content().getAttribute('data-whats-new-line') === older[0]);
  }
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  window.dispatchEvent(new window.Event('toggleWhatsNew'));
  await sleep(20);
  check('...but a reopen goes back to the current line (the choice is not persisted)', content().getAttribute('data-whats-new-line') === currentLine && sectionVersions()[0] === latestVersion);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  check('Escape closes it', !win());
  window.dispatchEvent(new window.Event('toggleWhatsNew'));
  await sleep(20);
  click(window, win().querySelector('button[aria-label="Close"]'));
  await sleep(20);
  check('the header x closes it', !win());
  unmountWhatsNew();
  // seen an older version: it opens again and the newer ones are marked
  const seen = ofLine(currentLine)[ofLine(currentLine).length - 1].version;
  window.localStorage.setItem(WHATS_NEW_SEEN_KEY, seen);
  renderWhatsNew();
  await sleep(20);
  check(`a different seen version (${seen}) opens it again (once per version)`, !!win());
  const unseen = sectionVersions().filter((v) => v !== seen && v !== latestVersion);
  check(`the versions newer than ${seen} (other than the current one) carry a "new" badge, ${seen} itself does not`, unseen.every((v) => !!document.querySelector(`[data-whats-new-version="${v}"] [data-whats-new-new-badge]`)) && !document.querySelector(`[data-whats-new-version="${seen}"] [data-whats-new-new-badge]`) && document.querySelector(`[data-whats-new-version="${latestVersion}"]`).getAttribute('data-whats-new-unseen') === 'true', unseen.join(','));
  unmountWhatsNew();
}

/* ================================================================== */
console.log('\n--- 3. source guards ---');
/* ================================================================== */
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'components', 'WhatsNew.jsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('WhatsNew is built on the shared FloatingWindow', /import FloatingWindow from '\.\/common\/FloatingWindow'/.test(src) && /<FloatingWindow\b/.test(src) && !/createPortal/.test(src));
  check('no hard-coded colours or os-*/NN opacity classes (theme tokens only)', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(code) && !/\bos-[a-z-]+\/\d+(?!\d*\))/.test(code.replace(/ring-os-blue\/40/g, '')) && !/purple|from-purple|to-blue/.test(code));
  check('no <select> and no day grouping in the source', !/<select/.test(src) && /groupFeaturesByCategory/.test(src));
  check('App.jsx still mounts it', /<WhatsNew\s*\/>/.test(fs.readFileSync(path.join(REPO, 'src', 'App.jsx'), 'utf8')));
}

process.exit(summary());
