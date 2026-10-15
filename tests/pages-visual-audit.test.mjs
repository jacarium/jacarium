/**
 * Every page of the app in the real browser, in the light theme, the
 * Jacaranda dark theme and the neutral dark theme, at desktop width (1400)
 * and at phone width (393) - and, for the sidebar rows, in the five gradient
 * themes as well (idle, hovered and selected): each renders a non-blank viewport, raises no
 * exception, shows no horizontal page overflow at phone width, and its
 * controls follow the tokens (no button or field with a weight above 400 or
 * a radius other than the control radius / a pill, no text button with an
 * icon), its sidebar list rows are square full-width rows (no radius,
 * no per-row border), and the tabs of its tab strip (an open document,
 * workflow, board or tool - opened here so every page with a strip shows
 * one) are square, idle, hovered and active. Screenshots land in PAGES_SHOTS_DIR (default: a temp dir) as
 * <page>-<variant>[-phone].png - the "after" set of the design-system pass.
 *
 * The pages come from tests/helpers/visual-snapshots.mjs (APP_PAGES) plus
 * the Settings dialog. No backend: pages show their offline/empty states.
 * Needs Chrome and a free Vite port; skips cleanly otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew, slug, APP_PAGES } from './helpers/visual-snapshots.mjs';

const OUT = process.env.PAGES_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pages-visual-audit-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const app = await launchDocumentsApp({ port: 5281, profilePrefix: 'pages-audit-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(0); }
const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
const ev = (s) => app.evaluate(s);
const shot = async (name) => { const f = path.join(OUT, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const spread = (file) => { if (!PNG) return 255; const png = PNG.sync.read(fs.readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const VARIANTS = { light: 'light', jacaranda: 'dark', neutral: 'dark-neutral' };
const GRADIENTS = { magma: 'gradient-red-purple', nebula: 'gradient-blue-purple', vulkan: 'gradient-green-blue', sunset: 'gradient-orange-red', aurora: 'gradient-pink-purple' };
Object.assign(VARIANTS, GRADIENTS);
const gradient = (v) => v in GRADIENTS;
const setVariant = async (v) => { await ev(`localStorage.setItem('app-theme', ${JSON.stringify(VARIANTS[v])})`); await ev('location.reload()'); await sleep(3500); await ev(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`); await dismissWhatsNew(app); };
// The pages with a tab strip (src/components/features/documents/TabBar.jsx and its
// look-alikes, .sc-tab-strip) and the empty-state button that opens a first item
// there; later variants find the item in the sidebar and the row click opens it.
// (Tools: the first tool of the sidebar, its category expanded first when it is collapsed)
const OPEN_TOOL = `(() => { const inSidebar = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 64 && r.right <= 360; };
  const tool = Array.from(document.querySelectorAll('.sc-row')).find((el) => /border-l-4/.test(el.className) && inSidebar(el));
  if (tool) { tool.click(); return 'tool'; }
  const header = Array.from(document.querySelectorAll('button')).find((el) => inSidebar(el) && /flex-1/.test(el.className) && /[A-Za-z]{2,}/.test(el.textContent));
  if (header) { header.click(); return 'expanded'; }
  return 'nothing'; })()`;
const TAB_PAGES = { Documents: 'New Document', Kanban: 'Create Board', 'Workflow Builder': 'New Workflow', Tools: OPEN_TOOL };
const openItem = async (how) => {
  if (!how) return false;
  if (how.startsWith('(')) { let r = await ev(how); if (r === 'expanded') { await sleep(400); r = await ev(how); } if (r === 'tool') await sleep(1200); return r === 'tool'; }
  const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(how)}); if (!b) return false; b.click(); return true; })()`);
  if (ok) await sleep(1500);
  return ok;
};
const TAB_SEL = '.sc-tab-strip > *';
const SQUARE = '0px/0px/0px/0px';
const tabShape = `(tab) => { const c = getComputedStyle(tab); return { active: tab.getAttribute('data-active') === 'true' || /border-b-os-blue|border-b-green-600|border-b-purple-600/.test(tab.className), r: [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius].join('/') }; }`;
const tabsProbe = () => ev(`(() => { const shape = ${tabShape}; const out = []; for (const el of Array.from(document.querySelectorAll('${TAB_SEL}'))) { const r = el.getBoundingClientRect(); if (r.width === 0 || !/[A-Za-z0-9]{2,}/.test(el.textContent || '')) continue; out.push({ t: (el.textContent || '').trim().slice(0, 22), x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2, ...shape(el) }); } return out; })()`);
const tabAt = (p) => ev(`(() => { const shape = ${tabShape}; const el = document.elementFromPoint(${p.x}, ${p.y}); const tab = el && el.closest('${TAB_SEL}'); return tab ? shape(tab) : null; })()`);
// every tab of the strip: square idle; the first three hovered and then clicked (active) as well
async function squareTabs() {
  const tabs = await tabsProbe();
  const bad = tabs.filter((t) => t.r !== SQUARE).map((t) => `${t.t} idle r=${t.r}`);
  for (const t of tabs.slice(0, 3)) {
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y }); await sleep(150);
    const hovered = await tabAt(t);
    if (hovered && hovered.r !== SQUARE) bad.push(`${t.t} hover r=${hovered.r}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1 }); await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 }); await sleep(250);
    const active = await tabAt(t);
    if (!active) bad.push(`${t.t} gone after a click`);
    else if (!active.active) bad.push(`${t.t} not active after a click`);
    else if (active.r !== SQUARE) bad.push(`${t.t} active r=${active.r}`);
  }
  return { count: tabs.length, bad };
}
const clickNav = async (label) => { const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('nav button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`); await sleep(1500); return ok; };
const controls = () => ev(`(() => {
  const cs = (e) => getComputedStyle(e); const out = { bold: [], radius: [], iconText: [] };
  const KEEP = /lucide-(chevron|check|eye|x\b|grip)/i;   // functional icons (lucide names its svgs lucide-<icon>)
  for (const b of Array.from(document.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().width > 0)) {
    if (b.closest('nav')) continue;
    const r = cs(b).borderTopLeftRadius; const w = Number(cs(b).fontWeight);
    const text = Array.from(b.childNodes).some((n) => (n.nodeType === 3 && /[A-Za-z]{2,}/.test(n.textContent)) || (n.nodeType === 1 && !/sr-only|opacity-0|absolute|pointer-events-none/.test(n.className || '') && /[A-Za-z]{2,}/.test(n.textContent) && n.tagName !== 'svg'));
    if (w > 400 && text) out.bold.push(b.textContent.trim().slice(0, 25));
    if (!(r === '8px' || parseFloat(r) > 100 || r === '0px') && !b.closest('[role="tablist"]') && !b.closest('.react-flow')) out.radius.push(r + ' ' + b.textContent.trim().slice(0, 20));
    const svgs = Array.from(b.querySelectorAll('svg')).filter((x) => !KEEP.test(x.getAttribute('class') || '') && !x.closest('.sr-only, .opacity-0, .absolute'));
    const svg = svgs[0];
    if (text && svg && !/text-left/.test(b.className) && b.getAttribute('role') !== 'option') out.iconText.push(b.textContent.trim().slice(0, 25));
  }
  // sidebar list rows (the left panel next to the rail): full-width square rows like the Documents sidebar -
  // no radius, no per-row border (a left accent bar on the selected row is the one exception)
  out.rows = []; out.rowPoints = [];
  for (const el of Array.from(document.querySelectorAll('.sc-row, [draggable="true"], .cursor-pointer, .cursor-grab, [role="option"], [role="treeitem"], [role="button"], button'))) {
    const r = el.getBoundingClientRect(); const c = cs(el);
    if (r.width === 0 || r.left < 64 || r.right > 360 || r.top < 48 || r.height < 24 || r.height > 140 || r.width < 120) continue;
    if (el.closest('nav, [role="menu"], [role="dialog"], .react-flow, [data-testid="settings-modal"], input, select, form')) continue;
    if (el !== el.closest('.sc-row, [draggable="true"], .cursor-pointer, .cursor-grab, [role="option"], [role="treeitem"], [role="button"], button')) continue;
    if (el.parentElement && el.parentElement.closest('.sc-row')) continue;   // a control inside a row is not the row
    if (!/[A-Za-z]{2,}/.test(el.textContent || '')) continue;
    const radius = c.borderTopLeftRadius; const borders = [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth].map(parseFloat);
    if (radius !== '0px' || borders.some((w) => w > 0)) out.rows.push((el.textContent || '').trim().slice(0, 22) + ' r=' + radius + ' b=' + borders.join('/'));
    out.rowPoints.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, t: (el.textContent || '').trim().slice(0, 22) });
  }
  for (const f of Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), select, textarea')).filter((f) => f.getBoundingClientRect().width > 0)) {
    const r = cs(f).borderTopLeftRadius; if (r !== '8px' && r !== '0px' && !(parseFloat(r) > 100)) out.radius.push('field ' + r);
    if (Number(cs(f).fontWeight) > 400) out.bold.push('field');
  }
  return out;
})()`);

try {
  await dismissWhatsNew(app);
  for (const v of Object.keys(VARIANTS)) {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await setVariant(v);
    const theme = await ev(`[document.documentElement.classList.contains('dark'), document.documentElement.getAttribute('data-dark-variant')].join('/')`);
    check(`${v}: the theme applies`, theme === (v === 'light' ? 'false/' : v === 'jacaranda' ? 'true/' : 'true/neutral'), theme);   // gradients paint over the neutral dark
    for (const label of APP_PAGES) {
      const errorsBefore = app.errors.length;
      await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      const ok = await clickNav(label);
      check(`${v}: nav item "${label}" exists`, ok);
      if (!ok) continue;
      if (!gradient(v)) { const f = await shot(`${slug(label)}-${v}`); check(`${v}: ${label} renders non-blank`, spread(f) > 40); }
      const c = await controls();
      // the first row hovered, then selected: a state must not round it either
      const rowAt = (p) => ev(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); const row = el && el.closest('.sc-row, [draggable="true"], .cursor-pointer, [role="button"], button'); if (!row) return null; const cs = getComputedStyle(row); return { r: cs.borderTopLeftRadius, b: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth].map(parseFloat).join('/') }; })()`);
      const stateRows = [];
      for (const p of (c.rowPoints || []).slice(0, 2)) {
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(150);
        const hovered = await rowAt(p);
        if (hovered && (hovered.r !== '0px' || hovered.b.split('/').some((w) => parseFloat(w) > 0))) stateRows.push(`${p.t} hover r=${hovered.r} b=${hovered.b}`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(250);
        const selected = await rowAt(p);
        if (selected && (selected.r !== '0px' || selected.b.split('/').some((w) => parseFloat(w) > 0))) stateRows.push(`${p.t} selected r=${selected.r} b=${selected.b}`);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      // the tab strip: an item opened (the empty-state button, or the row selected above), every tab square
      if (label in TAB_PAGES) await openItem(TAB_PAGES[label]);
      const tabs = await squareTabs();
      if (label in TAB_PAGES) check(`${v}: ${label} shows a tab strip to audit (an item is open)`, tabs.count > 0, 'no tab found');
      check(`${v}: ${label} tabs are square (no radius), idle, hovered and active`, tabs.bad.length === 0, tabs.bad.slice(0, 6).join(' ; '));
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });
      check(`${v}: ${label} controls follow the tokens (no bold text button or field, control radius, no icon in a text button)`, c.bold.length === 0 && c.radius.length === 0 && c.iconText.length === 0, JSON.stringify(c).slice(0, 280));
      check(`${v}: ${label} sidebar list rows are square full-width rows (no radius, no per-row border), idle, hovered and selected`, (c.rows || []).length === 0 && stateRows.length === 0, [...(c.rows || []), ...stateRows].slice(0, 6).join(' ; '));
      if (!gradient(v)) {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
        await sleep(600);
        const overflow = await ev('document.documentElement.scrollWidth > document.documentElement.clientWidth + 1');
        check(`${v}: ${label} has no horizontal page overflow at 393 px`, overflow === false);
        await shot(`${slug(label)}-${v}-phone`);
      }
      const newErrors = app.errors.slice(errorsBefore).filter((e) => !/favicon|ResizeObserver|themeObserver|querySelectorAll/.test(e));
      check(`${v}: ${label} raises no exception`, newErrors.length === 0, newErrors.join(' || ').slice(0, 200));
    }
    if (gradient(v)) continue;
    // Settings (General) on top of the Documents page
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await clickNav('Documents');
    await ev(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'general' } }))`); await sleep(900);
    check(`${v}: Settings opens`, await ev(`!!document.querySelector('[data-testid="settings-modal"]')`));
    await shot(`settings-${v}`);
    await app.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true }); await sleep(500);
    await shot(`settings-${v}-phone`);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Emulation.clearDeviceMetricsOverride');
  }
} catch (e) {
  check('the pages audit runs', false, e.stack || String(e));
} finally {
  await app.close();
}
console.log(`\nscreenshots: ${OUT}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
