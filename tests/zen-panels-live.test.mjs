#!/usr/bin/env node
/**
 * Zen mode's edges (Playwright against the Vite dev server, no backend):
 * two pull-out tabs at the middle of the window's edges. The left one (every
 * page with a sidebar, Documents included) opens the page's sidebar as the
 * shared zen side overlay; the right one opens "Navigation", the same overlay on
 * the right, listing the pages (the rail's order, the current one marked)
 * and the panels (AI Chat, Quick Notes, Team Chat, Notifications). A page
 * switches at once, zen stays; a panel shows inside the overlay, with a
 * back control to the list. Both overlays: resizable from their inner edge
 * (a width of their own), instant (the shared panel motion is none), the
 * focus moves in, Esc and an outside click close them.
 *
 * Zen's overlays are temporary views: entering zen snapshots the panels'
 * state, nothing opened, closed or shown in zen changes the layout after
 * zen, the persisted layout is never written by zen toggles; the page
 * sidebar's state is never touched; switching pages in zen is a real
 * navigation. The footer bar is gone: a "Zen" label beside the connection
 * indicator leaves zen and names the chords (announced once on entering).
 * Zen's column follows Line width (Off: the pane's width).
 *
 * Needs playwright-core with Chromium. Port ZEN_PANELS_TEST_PORT (5229);
 * screenshots in ZEN_SHOTS_DIR. Run: node tests/zen-panels-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.ZEN_PANELS_TEST_PORT || 5229);
const OUT = process.env.ZEN_SHOTS_DIR || '/private/tmp/claude-501/shots/zen';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (ZEN_PANELS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const { RAIL_PAGES } = await import(path.join(REPO, 'src/components/railPages.js'));
const PAGES = RAIL_PAGES.map((p) => p.label);
const PANELS = [['aiChat', 'AI Chat'], ['draft', 'Quick Notes'], ['chat', 'Team Chat'], ['notification', 'Notifications']];
const LAYOUT_KEYS = ['chatSidebarOpen', 'notificationSidebarOpen', 'draftSidebarOpen', 'aiChatSidebarOpen', 'innerSidebarVisible', 'notification-sidebar-width', 'chat-sidebar-width', 'draft-sidebar-width', 'aiChatSidebarWidth', 'document-sidebar-width'];
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const domClick = (locator) => locator.first().evaluate((el) => el.click());
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await domClick(b); } else { await domClick(page.locator('[data-testid="rail-more"]')); await sleep(250); await domClick(page.locator('[data-testid="rail-more-menu"] button', { hasText: label })); } await page.mouse.move(700, 450); await sleep(600); };
const zen = (on) => page.evaluate(async (on) => { const m = await import('/src/utils/readingAids.js'); m.zenMode.set(on); }, on);
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const noField = () => page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
const tab = (which) => page.locator(`[data-testid="${which === 'left' ? 'zen-sidebar-button' : 'zen-panels-button'}"]`);
const ms = (v) => (/ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000);
const storage = () => page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), LAYOUT_KEYS);
// the panels drawn as columns (outside any zen overlay), told apart by their header titles
const panelsOpen = () => page.evaluate(() => { const names = Array.from(document.querySelectorAll('[data-side][data-ra-area]')).filter((el) => !el.closest('[data-zen-overlay]') && el.getBoundingClientRect().width > 0).map((el) => { const h = el.querySelector('h2, h3, [data-testid="sidebar-title"]'); return (h ? h.textContent : el.textContent).trim().slice(0, 24); }); return { aiChat: names.some((n) => /^AI Chat/.test(n)), notification: names.some((n) => /^Notifications/.test(n)), draft: names.some((n) => /^Quick Notes/.test(n)), chat: names.some((n) => /^Team Chat/.test(n)), names }; });
const columns = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-side][data-ra-area]')).filter((el) => el.getBoundingClientRect().width > 0 && !el.closest('[data-zen-overlay]')).map((el) => el.getAttribute('data-testid') || el.className.slice(0, 30)));
const state = () => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, midY: (r.top + r.bottom) / 2 }; };
  const left = document.querySelector('[data-testid="zen-sidebar-button"]'); const right = document.querySelector('[data-testid="zen-panels-button"]');
  const overlay = document.querySelector('[data-zen-overlay]');
  const goTo = document.querySelector('[data-testid="zen-go-to-overlay"]');
  const active = document.activeElement;
  return { zen: document.documentElement.classList.contains('zen-mode'), vw: window.innerWidth, vh: window.innerHeight,
    left: left && { ...box(left), label: left.getAttribute('aria-label'), expanded: left.getAttribute('aria-expanded') },
    right: right && { ...box(right), label: right.getAttribute('aria-label'), expanded: right.getAttribute('aria-expanded'), opacity: parseFloat(getComputedStyle(right).opacity), bg: getComputedStyle(right).backgroundColor },
    overlay: overlay ? { side: overlay.getAttribute('data-zen-overlay'), role: overlay.getAttribute('role'), label: overlay.getAttribute('aria-label'), ...box(overlay), focusInside: overlay.contains(active), animation: getComputedStyle(overlay).animationName, testId: overlay.getAttribute('data-testid') } : null,
    goTo: goTo ? { title: (goTo.querySelector('[data-testid="zen-go-to-title"]') || {}).textContent, back: !!goTo.querySelector('[data-testid="zen-go-to-back"]'), list: !!goTo.querySelector('[data-testid="zen-panels-menu"]'), pages: Array.from(goTo.querySelectorAll('[data-testid^="zen-page-"]')).map((b) => b.textContent.trim()), panels: Array.from(goTo.querySelectorAll('[data-testid^="zen-panel-"]')).map((b) => b.textContent.trim()), current: Array.from(goTo.querySelectorAll('[aria-current="page"]')).map((b) => b.dataset.name), slot: (goTo.querySelector('[data-testid="zen-go-to-slot"]') || {}).getAttribute ? goTo.querySelector('[data-testid="zen-go-to-slot"]').getAttribute('data-zen-panel') : null, slotText: goTo.querySelector('[data-testid="zen-go-to-slot"]') ? goTo.querySelector('[data-testid="zen-go-to-slot"]').textContent.trim().slice(0, 40) : null, width: box(goTo).width } : null,
    activeTestId: active && active.getAttribute ? active.getAttribute('data-testid') : null, activeName: active && active.dataset ? active.dataset.name : null,
    badge: (() => { const b = document.querySelector('[data-testid="zen-badge"]'); const c = document.querySelector('[data-testid="connection-indicator"]'); const a = document.querySelector('[data-testid="zen-announce"]'); return { shown: !!b, title: b && b.getAttribute('title'), box: box(b), indicator: box(c), announce: a ? a.textContent : null, color: b && getComputedStyle(b).color, bg: b && getComputedStyle(b).backgroundColor }; })(),
    overlapping: ['zen-sidebar-button', 'zen-panels-button'].flatMap((id) => { const t = document.querySelector(`[data-testid="${id}"]`); if (!t) return []; const r = t.getBoundingClientRect(); const hits = []; for (const [x, y] of [[r.left + 1, r.top + 1], [r.right - 1, r.bottom - 1], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]]) { const under = document.elementsFromPoint(x, y).filter((e) => !t.contains(e) && !e.contains(t) && e.matches('button, a, input, [role="button"], [role="tab"]')); if (under.length) hits.push(under[0].tagName + '.' + String(under[0].className).slice(0, 30)); } return hits; }),
  };
});
const tabContrast = (which) => page.evaluate((which) => {
  const t = document.querySelector(`[data-testid="${which === 'left' ? 'zen-sidebar-button' : 'zen-panels-button'}"]`);
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(',').map((v) => parseFloat(v)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const r = t.getBoundingClientRect();
  const behind = document.elementsFromPoint(r.left - 4, r.top + r.height / 2).find((e) => parse(getComputedStyle(e).backgroundColor) && parse(getComputedStyle(e).backgroundColor).a > 0.5);
  const pageBg = behind ? parse(getComputedStyle(behind).backgroundColor) : { r: 30, g: 30, b: 30, a: 1 };
  const tabBg = parse(getComputedStyle(t).backgroundColor); const op = parseFloat(getComputedStyle(t).opacity);
  const painted = { r: tabBg.r * op + pageBg.r * (1 - op), g: tabBg.g * op + pageBg.g * (1 - op), b: tabBg.b * op + pageBg.b * (1 - op) };
  const label = t.querySelector('.sc-zen-tab-label');
  return { rest: Math.round(ratio(painted, pageBg) * 10) / 10, label: label ? Math.round(ratio(parse(getComputedStyle(label).color), parse(getComputedStyle(label).backgroundColor) || tabBg) * 10) / 10 : null };
}, which);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  // ---- the tabs per page: the right one everywhere, the left one on every page with a sidebar - Documents too
  for (const label of PAGES) {
    await goTo(label); await zen(true); await sleep(300);
    const s = await state();
    const centred = (b) => b && Math.abs(b.midY - s.vh / 2) <= 2;
    check(`${label}: in zen the right-edge tab "${s.right && s.right.label}" sits at the middle of the right edge and the left-edge tab "${s.left && s.left.label}" at the middle of the left edge`, s.zen && s.right && centred(s.right) && Math.abs(s.vw - s.right.right) <= 1 && /navigation/i.test(s.right.label) && s.left && centred(s.left) && s.left.left <= 1 && /^Show /.test(s.left.label), JSON.stringify(s));
    check(`${label}: the tabs overlap no page control`, s.overlapping.length === 0, JSON.stringify(s.overlapping));
    await zen(false); await sleep(200);
  }

  // ---- the chips: one quiet word each, the smallest type, the action in the name and the chord in aria-keyshortcuts
  await goTo('Tasks'); await zen(true); await sleep(300);
  const chips = await page.evaluate(() => ['zen-sidebar-button', 'zen-panels-button'].map((id) => { const b = document.querySelector(`[data-testid="${id}"]`); const c = b && b.querySelector('.sc-zen-tab-label'); const d = b && b.getAttribute('aria-describedby') && document.getElementById(b.getAttribute('aria-describedby')); return b && { id, text: c && c.textContent.trim(), kbd: !!(c && c.querySelector('kbd')), size: c && parseFloat(getComputedStyle(c).fontSize), delay: c && getComputedStyle(c).transitionDelay, label: b.getAttribute('aria-label'), keys: b.getAttribute('aria-keyshortcuts'), desc: d ? d.textContent : null }; }));
  check('the left tab\'s chip reads exactly "Sidebar", the right one\'s "Navigation" - text only, no kbd', chips[0] && chips[0].text === 'Sidebar' && !chips[0].kbd && chips[1] && chips[1].text === 'Navigation' && !chips[1].kbd, JSON.stringify(chips));
  check('the chips are small (the smallest type, 11 px or under) and hidden at rest', chips.every((c) => c && c.size <= 11.01), JSON.stringify(chips.map((c) => c && c.size)));
  check('the accessible names keep the action ("Show sidebar", "Show navigation"), the chord sits in aria-keyshortcuts and a description', chips[0].label === 'Show sidebar' && chips[1].label === 'Show navigation' && chips.every((c) => c.keys && /\[|\]|Bracket/.test(c.keys) && c.desc && c.desc.includes(c.keys)), JSON.stringify(chips));
  await tab('left').hover(); await sleep(600);
  const chipShown = await page.evaluate(() => { const c = document.querySelector('[data-testid="zen-sidebar-button"] .sc-zen-tab-label'); return c && { opacity: parseFloat(getComputedStyle(c).opacity), pointer: getComputedStyle(c).pointerEvents }; });
  check('hovering shows the chip (after its delay) and the chip takes no pointer events', chipShown && chipShown.opacity === 1 && chipShown.pointer === 'none', JSON.stringify(chipShown));
  await page.mouse.move(700, 450); await sleep(200);
  // ---- the left tab on Tasks: click, keyboard, Esc order, click outside, instant, resizable
  await goTo('Tasks'); await zen(true); await sleep(300);
  await tab('left').click(); await sleep(350);
  let s = await state();
  check('Tasks: a click on the left tab opens the sidebar overlay (a dialog from the left edge); zen stays; the tab says expanded', s.zen && s.overlay && s.overlay.side === 'left' && s.overlay.role === 'dialog' && s.overlay.left === 0 && s.left.expanded === 'true' && s.overlay.focusInside, JSON.stringify(s));
  check('the overlay opens instantly (the shared panel motion is none)', s.overlay && s.overlay.animation === 'none', JSON.stringify(s.overlay));
  await page.keyboard.press('Escape'); await sleep(300);
  s = await state();
  check('Esc closes the sidebar overlay first; zen stays; the focus returns to the tab', s.zen && !s.overlay && s.left.expanded === 'false' && s.activeTestId === 'zen-sidebar-button', JSON.stringify(s));
  await tab('left').focus(); await page.keyboard.press('Enter'); await sleep(350);
  s = await state();
  check('Enter on the focused left tab opens the overlay too, with the focus inside it', s.overlay && s.overlay.side === 'left' && s.overlay.focusInside, JSON.stringify(s));
  await page.mouse.click(900, 500); await sleep(300);
  s = await state();
  check('a click outside closes the sidebar overlay; zen stays', s.zen && !s.overlay, JSON.stringify(s));
  const lb = (await state()).left;
  await page.mouse.move(lb.left + lb.width / 2, lb.midY); await sleep(600);
  s = await state();
  check('hovering the left tab opens nothing (the chip shows, no peek)', !s.overlay && s.left.expanded === 'false', JSON.stringify(s));
  await tab('left').click(); await sleep(350);
  await page.mouse.move(900, 500); await sleep(700);
  s = await state();
  check('opened by a click, the overlay stays open when the pointer leaves it (no auto-close)', !!s.overlay && s.overlay.side === 'left', JSON.stringify(s));
  // resizable from its inner edge, the width its own
  const before = await storage();
  const handle = await page.locator('[data-testid="zen-sidebar-overlay"] [data-ra-control]').first().boundingBox();
  const w0 = s.overlay.width;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200); await page.mouse.down(); await page.mouse.move(handle.x + 120, handle.y + 200, { steps: 6 }); await page.mouse.up(); await sleep(300);
  s = await state();
  const zenKey = await page.evaluate(() => localStorage.getItem('innerSidebarVisible.zen') || localStorage.getItem('tasks-sidebar-width.zen') || Object.keys(localStorage).filter((k) => /\.zen(Right)?$/.test(k)).join(','));
  check(`dragging the overlay's inner edge resizes it (${Math.round(w0)} -> ${Math.round(s.overlay.width)} px), the width kept under a zen key of its own (${zenKey}), the normal column's keys untouched`, s.overlay && s.overlay.width > w0 + 60 && /\.zen/.test(zenKey) && JSON.stringify(await storage()) === JSON.stringify(before), JSON.stringify({ w0, s: s.overlay, zenKey }));
  await page.keyboard.press('Escape'); await sleep(200);

  // ---- Documents: the left tab opens the document list and the Templates section; a document opens and zen stays
  await zen(false);
  await page.evaluate(async () => { const m = await import('/src/utils/documents.js'); for (let i = 1; i <= 3; i++) await m.createDocument({ title: `Sample note ${i}`, content: `# Sample ${i}\n\nSample text ${i}.`, category: 'General' }); });
  await goTo('Documents'); await goTo('Tasks'); await goTo('Documents'); await sleep(400);
  const sidebarShownBefore = await page.evaluate(() => localStorage.getItem('innerSidebarVisible'));
  await zen(true); await sleep(300);
  s = await state();
  check('Documents in zen: the left tab "Show documents" is there, the sidebar column is not', s.left && s.left.label === 'Show sidebar' && !(await page.locator('[data-testid="document-sidebar"]').count()), JSON.stringify(s.left));
  await tab('left').click(); await sleep(400);
  const general = page.locator('[data-testid="zen-sidebar-overlay"] button', { hasText: /^General/ }).first();
  if (await general.count()) { await general.click(); await sleep(300); }
  const listed = await page.evaluate(() => { const o = document.querySelector('[data-testid="zen-sidebar-overlay"]'); return o ? { docs: o.textContent.includes('Sample note'), templates: /TEMPLATES/i.test(o.textContent) } : null; });
  check('the overlay lists the documents and the Templates section', listed && listed.docs && listed.templates, JSON.stringify(listed));
  await shot('documents-left-overlay');
  const row = page.locator('[data-testid="zen-sidebar-overlay"] .sc-row', { hasText: /Sample note 2/ }).first();
  await row.click(); await sleep(600);
  s = await state();
  const openTitle = await page.evaluate(() => { const tabs = Array.from(document.querySelectorAll('[data-testid="document-tab"]')).map((t) => t.textContent.trim()); const editor = document.querySelector('.sc-editor-cm .cm-content, .markdown-preview'); return `${tabs.join(' | ')} :: ${editor ? editor.textContent.slice(0, 60) : ''}`; });
  check('choosing a document opens it, zen stays and the overlay closes', s.zen && !s.overlay && /Sample note 2|Sample 2/.test(openTitle), JSON.stringify({ openTitle, zen: s.zen, overlay: s.overlay }));
  // the tab bar stays in zen, as on every page: switching tabs works with zen on, nothing overlaps the edge tab or the badge
  const tabsInZen = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-tab"]')).map((t) => { const r = t.getBoundingClientRect(); return { text: t.textContent.trim(), top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }));
  check('Documents in zen: the tab bar is shown with the open document\'s tab at the top of the pane', s.zen && tabsInZen.length >= 1 && tabsInZen[0].top < 80 && /Sample note 2/.test(tabsInZen.map((t) => t.text).join(' ')), JSON.stringify(tabsInZen));
  await tab('left').click(); await sleep(300);
  await page.locator('[data-testid="zen-sidebar-overlay"] .sc-row', { hasText: /Sample note 3/ }).first().click(); await sleep(600);
  const twoTabs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-tab"]')).map((t) => t.textContent.trim()));
  const firstTab = page.locator('[data-testid="document-tab"]', { hasText: /Sample note 2/ }).first();
  await firstTab.click(); await sleep(500);
  s = await state();
  const shownAfterSwitch = await page.evaluate(() => { const e = document.querySelector('.sc-editor-cm .cm-content, .markdown-preview'); return e ? e.textContent.slice(0, 80) : ''; });
  const edge = s.left && { top: s.left.midY - 30, bottom: s.left.midY + 30 };
  check('a second document adds a tab; clicking the first tab switches back with zen still on; the tab bar sits above the edge tab and the Zen badge stays bottom right', s.zen && twoTabs.length >= 2 && /Sample 2|Sample note 2/.test(shownAfterSwitch) && tabsInZen.every((t) => t.bottom < edge.top) && s.badge && s.badge.shown && s.badge.box && s.badge.box.top > 700, JSON.stringify({ twoTabs, shownAfterSwitch, tabsInZen, edge, badge: s.badge && s.badge.box }));
  await tab('left').click(); await sleep(300); await page.keyboard.press('Escape'); await sleep(200);
  s = await state(); check('Documents: Esc closes the overlay', !s.overlay);
  await tab('left').click(); await sleep(300); await page.mouse.click(900, 500); await sleep(300);
  s = await state(); check('Documents: an outside click closes the overlay', !s.overlay);
  await zen(false); await sleep(300);
  check('after zen the Documents sidebar state is what it was (the snapshot rule: the overlay touched nothing)', (await page.evaluate(() => localStorage.getItem('innerSidebarVisible'))) === sidebarShownBefore && (await page.locator('[data-testid="document-sidebar"]').count()) === (sidebarShownBefore === 'false' ? 0 : 1), JSON.stringify({ sidebarShownBefore }));

  // ---- the right tab: "Navigation" - pages and panels
  await goTo('Tasks'); await zen(true); await sleep(300);
  await tab('right').click(); await sleep(400);
  s = await state();
  check('the right tab opens the "Navigation" overlay (a dialog from the right edge), the focus inside', s.overlay && s.overlay.side === 'right' && s.overlay.role === 'dialog' && Math.abs(s.vw - s.overlay.right) <= 1 && s.goTo && s.goTo.title === 'Navigation' && s.goTo.list && s.overlay.focusInside, JSON.stringify(s));
  check(`it lists every page in the rail's order (${s.goTo && s.goTo.pages.length} of ${PAGES.length}) and the four panels`, s.goTo && s.goTo.pages.length === PAGES.length && PAGES.every((p, i) => s.goTo.pages[i].startsWith(p)) && s.goTo.panels.length === 4 && PANELS.every(([, l], i) => s.goTo.panels[i] === l), JSON.stringify(s.goTo));
  check('the current page (Tasks) is marked with aria-current and the word "current", and holds the focus', s.goTo.current.join() === 'Tasks' && s.goTo.pages.find((p) => /^Tasks/.test(p)).includes('current') && s.activeName === 'Tasks', JSON.stringify({ current: s.goTo.current, active: s.activeName }));
  check('the overlay opens instantly', s.overlay.animation === 'none');
  await shot('go-to-list');
  // keyboard: arrows across both groups, Home / End, type-ahead
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  s = await state(); const afterTwo = s.activeName;
  await page.keyboard.press('End'); s = await state(); const atEnd = s.activeName;
  await page.keyboard.press('ArrowDown'); s = await state(); const wrapped = s.activeName;
  await page.keyboard.press('Home'); await page.keyboard.type('qu'); await sleep(200); s = await state(); const typed = s.activeName;
  check(`arrows move across both groups (Tasks -> ${afterTwo}), End reaches the last panel (${atEnd}), ArrowDown wraps to the first page (${wrapped}), type-ahead "qu" lands on Quick Notes (${typed})`, afterTwo === 'Diagnostics' && atEnd === 'Notifications' && wrapped === 'Documents' && typed === 'Quick Notes', JSON.stringify({ afterTwo, atEnd, wrapped, typed }));
  // a page: switches, zen stays, the overlay closes
  await page.keyboard.press('Home'); await page.keyboard.type('ka'); await sleep(200); await page.keyboard.press('Enter'); await sleep(700);
  s = await state();
  const onKanban = await page.evaluate(() => !!document.querySelector('nav.w-16 button[aria-label="Kanban"].bg-os-rail-active, nav.w-16 button[aria-label="Kanban"][class*="rail-active"]'));
  check('choosing Kanban switches the page (a real navigation), zen stays, the overlay closes', s.zen && !s.overlay && onKanban, JSON.stringify({ s, onKanban }));
  await tab('right').click(); await sleep(300);
  s = await state();
  check('reopened on Kanban: Kanban is the current page now', s.goTo && s.goTo.current.join() === 'Kanban', JSON.stringify(s.goTo && s.goTo.current));
  // a panel: inside the overlay, the header its name with a back control; back returns to the list; Esc closes
  await page.locator('[data-testid="zen-panel-notification"]').click(); await sleep(500);
  s = await state();
  check('choosing Notifications shows the panel inside the overlay: the header is "Notifications" with a back control, the panel\'s content in the slot', s.overlay && s.goTo && s.goTo.title === 'Notifications' && s.goTo.back && s.goTo.slot === 'notification' && s.goTo.slotText && s.goTo.slotText.length > 0, JSON.stringify(s.goTo));
  check('...the list is gone meanwhile, and no panel column is drawn behind the overlay', !s.goTo.list && (await columns()).length <= 1, JSON.stringify(await columns()));
  await shot('go-to-panel');
  await page.locator('[data-testid="zen-go-to-back"]').click(); await sleep(300);
  s = await state();
  check('the back control returns to the Navigation list', s.goTo && s.goTo.title === 'Navigation' && s.goTo.list, JSON.stringify(s.goTo));
  await page.locator('[data-testid="zen-panel-aiChat"]').click(); await sleep(500);
  await page.keyboard.press('Escape'); await sleep(300);
  s = await state();
  check('Esc with a panel showing closes the overlay (Esc always gets out), zen stays', s.zen && !s.overlay, JSON.stringify(s));
  await tab('right').click(); await sleep(400);
  s = await state();
  check('reopened: the panel that was showing (AI Chat) shows again', s.goTo && s.goTo.title === 'AI Chat' && s.goTo.slot === 'aiChat', JSON.stringify(s.goTo));
  await page.locator('[data-testid="zen-go-to-back"]').click(); await sleep(200);
  await page.mouse.click(300, 500); await sleep(300);
  s = await state();
  check('a click outside closes the Navigation overlay', !s.overlay);
  // resizing the Navigation overlay: its own width key
  await tab('right').click(); await sleep(300);
  s = await state(); const gw0 = s.goTo.width;
  const gh = await page.locator('[data-testid="zen-go-to-overlay"] [data-ra-control]').first().boundingBox();
  await page.mouse.move(gh.x + gh.width / 2, gh.y + 200); await page.mouse.down(); await page.mouse.move(gh.x - 100, gh.y + 200, { steps: 6 }); await page.mouse.up(); await sleep(300);
  s = await state();
  check(`the Navigation overlay resizes from its inner edge (${Math.round(gw0)} -> ${Math.round(s.goTo.width)} px), under its own key`, s.goTo.width > gw0 + 50 && (await page.evaluate(() => localStorage.getItem('zen-go-to.zenRight'))) != null, JSON.stringify({ gw0, w: s.goTo.width }));
  await page.keyboard.press('Escape'); await sleep(200);
  await zen(false); await sleep(300);

  // ---- the snapshot rule: a panel and the page sidebar, four cases, and a page switch in zen
  await goTo('Tasks');
  const storageBefore = await storage();
  await zen(true); await sleep(300);
  await tab('right').click(); await sleep(300); await page.locator('[data-testid="zen-panel-notification"]').click(); await sleep(400);
  const duringZen = await storage();
  check('case 1 (closed before zen, opened in zen): the stored layout is not written by the zen toggle', duringZen.notificationSidebarOpen === storageBefore.notificationSidebarOpen, JSON.stringify({ storageBefore, duringZen }));
  await page.keyboard.press('Escape'); await sleep(200);
  await zen(false); await sleep(400);
  let open = await panelsOpen();
  check('case 1: opened and closed in zen -> closed after zen', !open.notification, JSON.stringify(open));
  await zen(true); await sleep(300);
  await tab('right').click(); await sleep(300); await page.locator('[data-testid="zen-panel-notification"]').click(); await sleep(400);
  await zen(false); await sleep(400);   // left open in the overlay when zen ends
  open = await panelsOpen();
  check('case 2: opened in zen and still showing when zen ends -> closed after zen (restore wins)', !open.notification && (await columns()).length <= 1, JSON.stringify({ open, columns: await columns() }));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleNotificationSidebar', { detail: { open: true } }))); await sleep(500);
  open = await panelsOpen();
  check('a panel opened normally (Notifications) shows as a column before zen', open.notification, JSON.stringify(open));
  const storedOpen = await storage();
  await zen(true); await sleep(300);
  await tab('right').click(); await sleep(300); await page.locator('[data-testid="zen-panel-notification"]').click(); await sleep(300);
  await page.locator('[data-testid="zen-go-to-back"]').click(); await sleep(200); await page.keyboard.press('Escape'); await sleep(200);
  await zen(false); await sleep(400);
  open = await panelsOpen();
  check('case 3: open before zen, shown and dismissed in zen -> open again after zen', open.notification && JSON.stringify(await storage()) === JSON.stringify(storedOpen), JSON.stringify({ open }));
  await zen(true); await sleep(300);
  await tab('right').click(); await sleep(300); await page.keyboard.type('ka'); await sleep(200); await page.keyboard.press('Enter'); await sleep(600);
  await tab('right').click(); await sleep(300); await page.locator('[data-testid="zen-panel-draft"]').click(); await sleep(300); await page.keyboard.press('Escape'); await sleep(200);
  await zen(false); await sleep(400);
  open = await panelsOpen();
  check('case 4: a page switched in zen (Kanban) stays; the panels are the snapshot (Notifications open, Quick Notes closed)', open.notification && !open.draft && (await page.evaluate(() => !!document.querySelector('nav.w-16 button[aria-label="Kanban"][class*="rail-active"]'))), JSON.stringify(open));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleNotificationSidebar'))); await sleep(400);
  // the panels' stored open states and the page sidebar's: as before the zen sessions (a panel opened normally in between
  // wrote its own width, which is a real change, not zen's)
  const openKeys = ['chatSidebarOpen', 'notificationSidebarOpen', 'draftSidebarOpen', 'aiChatSidebarOpen', 'innerSidebarVisible', 'document-sidebar-width'];
  const pick = (o) => Object.fromEntries(openKeys.map((k) => [k, o[k]]));
  check('the stored layout (the four panels\' open states, the page sidebar, the Documents sidebar width) after the zen sessions equals what it was before them', JSON.stringify(pick(await storage())) === JSON.stringify(pick(storageBefore)), JSON.stringify({ before: pick(storageBefore), after: pick(await storage()) }));
  // the page sidebar: hidden before zen -> opened as the overlay in zen -> still hidden after
  await goTo('Tasks');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleInnerSidebar'))); await sleep(400);
  const hiddenBefore = (await columns()).length;
  await zen(true); await sleep(300);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zenShowSidebar'))); await sleep(300);
  s = await state();
  check('the page sidebar hidden before zen still opens as the overlay in zen (the shortcut event)', s.overlay && s.overlay.side === 'left', JSON.stringify(s.overlay));
  await zen(false); await sleep(300);
  check('...and is still hidden after zen; shown before -> shown after', (await columns()).length === hiddenBefore, JSON.stringify(await columns()));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleInnerSidebar'))); await sleep(300);

  // ---- the Zen label in the status corner: leaves zen, names the chords, announced once
  await zen(true); await sleep(400);
  s = await state();
  check('in zen a "Zen" label sits in the status corner beside the connection indicator; no footer bar', s.badge.shown && !(await page.locator('[data-testid="zen-hint"]').count()) && s.badge.indicator && s.badge.box.right <= s.badge.indicator.left + 1 && Math.abs(s.badge.box.midY - s.badge.indicator.midY) <= 4, JSON.stringify(s.badge));
  check('its tooltip names the chords: Esc or the zen chord to leave, the sidebar chord, the go-to chord', /Zen mode: Esc or .+ to leave · .+ sidebar · .+ navigation/.test(s.badge.title || ''), String(s.badge.title));
  check('entering zen is announced through a polite status region', s.badge.announce === s.badge.title, JSON.stringify([s.badge.announce, s.badge.title]));
  const ratioOf = (fg, bg) => { const p = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const v = m[1].split(',').map(Number); return { r: v[0], g: v[1], b: v[2] }; }; const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }; const a = lum(p(fg)), b = lum(p(bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  check(`the label reads at ${ratioOf(s.badge.color, s.badge.bg).toFixed(1)}:1 (4.5:1 or better)`, ratioOf(s.badge.color, s.badge.bg) >= 4.5, JSON.stringify([s.badge.color, s.badge.bg]));
  await page.evaluate(async () => { const m = await import('/src/shortcuts/store.js'); m.setOverrides({ ...m.getOverrides(), 'reading.showPanels': 'Mod+Alt+KeyG' }); }); await sleep(300);
  s = await state();
  check('a rebinding shows in the tooltip (Show Navigation rebound to Mod+Alt+G)', /G navigation/.test(s.badge.title || '') || /⌥⌘G|Alt\+G/.test(s.badge.title || ''), String(s.badge.title));
  await page.evaluate(async () => { const m = await import('/src/shortcuts/store.js'); const o = { ...m.getOverrides() }; delete o['reading.showPanels']; m.setOverrides(o); });
  await setAids({ textScale: 200, scaleChrome: true }); await sleep(600);
  s = await state();
  check('at 200 % with the interface scaled the label and the indicator do not overlap, nor the right edge tab', s.badge.box.right <= s.badge.indicator.left + 1 && s.badge.box.top > s.right.bottom, JSON.stringify([s.badge.box, s.badge.indicator, s.right]));
  await setAids({ textScale: 100, scaleChrome: false }); await sleep(400);
  await page.locator('[data-testid="zen-badge"]').click(); await sleep(300);
  s = await state();
  check('clicking the label leaves zen (the label goes with it)', !s.zen && !s.badge.shown, JSON.stringify(s.badge));

  // ---- zen's width follows Line width: Off = the pane's width, 60 ch centred, live
  await goTo('Documents'); await zen(true); await sleep(400);
  const pad = () => page.evaluate(() => { const s = document.querySelector('[data-testid="reading-aids-surface"] .sc-editor-cm .cm-content, [data-testid="reading-aids-surface"] .markdown-preview'); if (!s) return null; const r = s.getBoundingClientRect(); const cs = getComputedStyle(s); return { padLeft: parseFloat(cs.paddingLeft), width: r.width, fontSize: parseFloat(cs.fontSize) }; });
  await setAids({ lineWidth: 0 }); await sleep(300);
  let p = await pad();
  check(`zen with Line width Off: the document fills the pane (padding ${p && p.padLeft} px, not a centred column)`, p && p.padLeft <= 32, JSON.stringify(p));
  await setAids({ lineWidth: 60 }); await sleep(300);
  p = await pad();
  const chPx = await page.evaluate(() => { const s = document.querySelector('[data-testid="reading-aids-surface"] .sc-editor-cm .cm-content, [data-testid="reading-aids-surface"] .markdown-preview'); const span = document.createElement('span'); span.textContent = '0'; span.style.cssText = 'position:absolute;visibility:hidden;font:inherit'; s.appendChild(span); const w = span.getBoundingClientRect().width; span.remove(); return w; });
  check(`...set to 60 ch while in zen: a centred column of about 60 ch at once (padding ${p && Math.round(p.padLeft)} px of a ${p && Math.round(p.width)} px pane, ${p && ((p.width - 2 * p.padLeft) / chPx).toFixed(1)} ch by the element's own "0")`, p && p.padLeft > 150 && Math.abs((p.width - 2 * p.padLeft) - 60 * chPx) <= 0.15 * 60 * chPx, JSON.stringify({ p, chPx }));
  await setAids({ lineWidth: 0 }); await zen(false); await sleep(300);
  p = await pad();
  check('outside zen the default is unchanged (the normal padding)', p && p.padLeft <= 32, JSON.stringify(p));

  // ---- high contrast: the right tab's contrast
  await zen(true); await sleep(300);
  const restDark = await tabContrast('right');
  await setAids({ highContrast: true }); await sleep(400);
  await tab('right').hover(); await sleep(200);
  const hc = await tabContrast('right');
  check(`contrast: the right tab at rest ${restDark.rest}:1 (3:1 or better); under high contrast the tab ${hc.rest}:1 and its label chip ${hc.label}:1 (7:1 or better)`, restDark.rest >= 3 && hc.rest >= 7 && (hc.label == null || hc.label >= 7), JSON.stringify({ restDark, hc }));
  await setAids({ highContrast: false }); await zen(false); await sleep(300);

  // ---- the shortcuts: Mod+Alt+[ the sidebar, Mod+Alt+] Navigation (the focus on the current page), never while typing
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await goTo('Tasks'); await zen(true); await sleep(300);
  await noField(); await sleep(100);
  await page.keyboard.press(`${mod}+Alt+BracketLeft`); await sleep(300);
  s = await state();
  check('the "Show sidebar / sections" shortcut opens the sidebar overlay with the focus inside', s.overlay && s.overlay.side === 'left' && s.overlay.focusInside, JSON.stringify(s.overlay));
  await page.keyboard.press(`${mod}+Alt+BracketLeft`); await sleep(300);
  s = await state();
  check('...and again closes it', !s.overlay && s.zen, JSON.stringify(s.overlay));
  await page.keyboard.press(`${mod}+Alt+BracketRight`); await sleep(300);
  s = await state();
  check('the "Show Navigation" shortcut opens the Navigation overlay with the focus on the current page', s.overlay && s.overlay.side === 'right' && s.activeName === 'Tasks', JSON.stringify({ overlay: s.overlay, active: s.activeName }));
  await page.keyboard.press('Escape'); await sleep(200);
  await goTo('Documents'); await zen(true); await sleep(300);
  const ed = page.locator('.sc-editor-cm .cm-content');
  if (!(await ed.count())) { await zen(false); await sleep(300); await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (b) b.click(); }); await ed.waitFor({ timeout: 15000 }).catch(() => {}); await zen(true); await sleep(300); }
  await ed.click(); await page.keyboard.type('zen typing test'); await sleep(100);
  await page.keyboard.press(`${mod}+Alt+BracketRight`); await sleep(300);
  s = await state();
  await page.keyboard.press(`Shift+${mod}+ArrowLeft`); await sleep(150);
  const selected = await page.evaluate(() => (window.getSelection() ? window.getSelection().toString().length : 0));
  check('typing in the editor: the Navigation shortcut does not fire, and Shift+Mod+ArrowLeft still selects to the line start', !s.overlay && selected > 0, JSON.stringify({ overlay: s.overlay, selected }));
  await zen(false);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
