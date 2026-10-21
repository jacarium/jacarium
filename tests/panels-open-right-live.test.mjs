#!/usr/bin/env node
/**
 * "Open on the right" in the real window (Chromium, playwright-core, a
 * Vite dev server with the backend faked, a throwaway profile):
 *   - the rail's right-click menu on AI Chat opens the panel on the RIGHT
 *     of the page (its box right of the canvas, the handle on its left
 *     edge, the width under aiChatSidebarWidthRight); a plain click on
 *     Quick Notes then opens Quick Notes on the LEFT while AI Chat stays
 *     on the right (two panels, two sides); "Move to the left" moves AI
 *     Chat - one panel, never two - and the left exclusivity closes Quick
 *     Notes; the side is REMEMBERED per device: closing AI Chat on the right
 *     and clicking its icon reopens it on the right, also after a reload,
 *     and "Add as AI Context" opens it there; "Move to the left" is
 *     remembered the same way; dragging a right panel never pushes the page
 *     under 480 px; Team Chat too, and its composer matches the AI Chat
 *     sidebar's (textarea height / padding / radius / font, the tall send
 *     button);
 *   - the phone layout has no rail, no menu item, and ignores a remembered
 *     right side.
 * Screenshots (set PANEL_SHOTS_DIR), dark and light: AI Chat on the right,
 * Quick Notes left + AI Chat right, and the menu.
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/panels-open-right-live.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
const OUT = process.env.PANEL_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'panels-open-right-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5296);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

async function open(theme, { viewport = { width: 1400, height: 900 }, mobile = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: theme, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); } catch { /* ignore */ } }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.2', protocol: 2 } }));
  await context.route('**/api/ai/health', (r) => r.fulfill({ json: { status: 'online' } }));
  await context.route('**/api/ai/models', (r) => r.fulfill({ json: { ollama: ['qwen3:30b'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page };
}

const rect = (page, sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; }, sel);
// the page beside the panels: the row's flex-1 column
const canvasRect = (page) => page.evaluate(() => { const col = document.querySelector('[data-testid="panel-ai-chat"], [data-testid="panel-quick-notes"], [data-testid="panel-team-chat"]'); const row = col ? col.parentElement : document.querySelector('.flex.h-screen'); const canvas = Array.from(row.children).find((el) => el.classList.contains('flex-1')); const r = canvas.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; });
async function railMenu(page, testId) {
  await page.locator(`[data-testid="${testId}"]`).click({ button: 'right' });
  await page.locator('[data-testid="rail-panel-menu"]').waitFor({ state: 'visible', timeout: 3000 });
  return page.locator('[data-testid="rail-panel-side"]');
}
const screenshot = async (page, name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); };

try {
  for (const theme of ['light', 'dark']) {
    const t = (s) => `${theme}: ${s}`;
    const { context, page } = await open(theme);
    try {
      // ---- AI Chat on the right
      let item = await railMenu(page, 'rail-ai-chat');
      check(t('the AI Chat icon\'s right-click menu offers "Open on the right"'), (await item.textContent()).trim() === 'Open on the right');
      await screenshot(page, `menu-${theme}`);
      await item.click(); await page.waitForTimeout(600);
      const ai = await rect(page, '[data-testid="panel-ai-chat"]');
      const canvas = await canvasRect(page);
      check(t('AI Chat opens as a resizable panel on the RIGHT of the page'), !!ai && ai.x >= canvas.right - 1 && (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'right', JSON.stringify({ ai, canvas }));
      check(t('its resize handle sits on its left edge'), await page.evaluate(() => document.querySelector('[data-testid="panel-ai-chat"] .cursor-col-resize')?.className.includes('left-0')));
      check(t('the rail menu now reads "Move to the left"'), (await (await railMenu(page, 'rail-ai-chat')).textContent()).trim() === 'Move to the left');
      await page.keyboard.press('Escape'); await page.mouse.click(700, 450); await page.waitForTimeout(200);
      await screenshot(page, `ai-chat-right-${theme}`);

      // ---- a drag never pushes the page under 480 px, and the width is stored per side
      const handle = await page.evaluate(() => { const h = document.querySelector('[data-testid="panel-ai-chat"] .cursor-col-resize'); const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 300 }; });
      await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x - 900, handle.y, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(300);
      const after = await canvasRect(page);
      const aiAfter = await rect(page, '[data-testid="panel-ai-chat"]');
      check(t('dragging the right panel wide stops where the page keeps 480 px (and the panel\'s own max)'), after.width >= 479 && aiAfter.width > ai.width, JSON.stringify({ after, aiAfter }));
      check(t('the right-side width is stored under aiChatSidebarWidthRight, the left key untouched'), await page.evaluate(() => Number(localStorage.getItem('aiChatSidebarWidthRight')) > 0 && localStorage.getItem('aiChatSidebarWidth') === null));

      // ---- Quick Notes on the left at the same time
      await page.locator('[data-testid="rail-quick-notes"]').click(); await page.waitForTimeout(600);
      const notes = await rect(page, '[data-testid="panel-quick-notes"]');
      const canvas2 = await canvasRect(page);
      const aiStill = await rect(page, '[data-testid="panel-ai-chat"]');
      check(t('a plain click opens Quick Notes on the LEFT while AI Chat stays on the right (one panel each side)'), !!notes && notes.right <= canvas2.x + 1 && !!aiStill && aiStill.x >= canvas2.right - 1 && (await page.locator('[data-testid="panel-quick-notes"]').getAttribute('data-side')) === 'left', JSON.stringify({ notes, aiStill, canvas2 }));
      await screenshot(page, `left-and-right-${theme}`);

      // ---- move AI Chat to the left: one panel, and the left exclusivity closes Quick Notes
      item = await railMenu(page, 'rail-ai-chat');
      await item.click(); await page.waitForTimeout(600);
      const aiLeft = await rect(page, '[data-testid="panel-ai-chat"]');
      const canvas3 = await canvasRect(page);
      check(t('"Move to the left" moves AI Chat (one panel, never two) to the left and closes the left Quick Notes'), (await page.locator('[data-testid="panel-ai-chat"]').count()) === 1 && aiLeft.right <= canvas3.x + 1 && (await page.locator('[data-testid="panel-quick-notes"]').count()) === 0, JSON.stringify({ aiLeft, canvas3 }));

      // ---- the side is remembered: on the left now, a close + click reopens on the left
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(400);
      check(t('the icon closes it'), (await page.locator('[data-testid="panel-ai-chat"]').count()) === 0);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(600);
      check(t('moved to the left then closed, a plain click reopens it on the left (remembered)'), (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'left' && (await page.evaluate(() => localStorage.getItem('panelSide.aiChat'))) === '"left"');
      // move right, close: a plain click reopens on the RIGHT - also after a reload - and so does "Add as AI Context"
      item = await railMenu(page, 'rail-ai-chat'); await item.click(); await page.waitForTimeout(500);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(400);
      check(t('closed on the right: nothing open, the side kept in localStorage panelSide.aiChat'), (await page.locator('[data-testid="panel-ai-chat"]').count()) === 0 && (await page.evaluate(() => localStorage.getItem('panelSide.aiChat'))) === '"right"');
      item = await railMenu(page, 'rail-ai-chat');
      check(t('closed, the menu still reads "Move to the left" (the remembered side)'), (await item.textContent()).trim() === 'Move to the left');
      await page.keyboard.press('Escape'); await page.mouse.click(700, 450); await page.waitForTimeout(200);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(600);
      check(t('a plain click reopens AI Chat on the right'), !!(await rect(page, '[data-testid="panel-ai-chat"]')) && (await rect(page, '[data-testid="panel-ai-chat"]')).x >= (await canvasRect(page)).right - 1 && (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'right');
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(300);
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500);
      for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
      await page.evaluate((th) => { document.documentElement.classList.toggle('dark', th === 'dark'); }, theme);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(600);
      check(t('after a reload a plain click still opens it on the right'), (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'right' && (await rect(page, '[data-testid="panel-ai-chat"]')).x >= (await canvasRect(page)).right - 1);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(300);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } }))); await page.waitForTimeout(600);
      check(t('"Add as AI Context" (the open event without a side) opens it on the remembered right side'), (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'right');
      // back to the left for good
      item = await railMenu(page, 'rail-ai-chat'); await item.click(); await page.waitForTimeout(500);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(300);
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(500);
      check(t('"Move to the left", close, click: on the left again and remembered'), (await page.locator('[data-testid="panel-ai-chat"]').getAttribute('data-side')) === 'left' && (await page.evaluate(() => localStorage.getItem('panelSide.aiChat'))) === '"left"');
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(300);

      // ---- Team Chat on the right too
      item = await railMenu(page, 'rail-team-chat');
      await item.click(); await page.waitForTimeout(600);
      const chat = await rect(page, '[data-testid="panel-team-chat"]');
      check(t('Team Chat opens on the right the same way'), !!chat && chat.x >= (await canvasRect(page)).right - 1 && (await page.locator('[data-testid="panel-team-chat"]').getAttribute('data-side')) === 'right', JSON.stringify(chat));

      // ---- Team Chat's composer matches the AI Chat sidebar's (AI Chat on the left beside it)
      await page.locator('[data-testid="rail-ai-chat"]').click(); await page.waitForTimeout(600);
      const composer = await page.evaluate(() => {
        const pick = (el) => { if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { h: Math.round(r.height), pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '), radius: cs.borderTopLeftRadius, font: cs.fontSize, border: cs.borderTopWidth, w: Math.round(r.width) }; };
        const ai = document.querySelector('[data-testid="panel-ai-chat"] textarea'); const aiBtn = ai?.parentElement.querySelector('button');
        const team = document.querySelector('[data-testid="team-chat-input"]'); const teamBtn = document.querySelector('[data-testid="team-chat-send"]');
        return { ai: pick(ai), team: pick(team), aiBtn: pick(aiBtn), teamBtn: pick(teamBtn), aiRows: ai?.rows, teamRows: team?.rows, aligned: aiBtn && ai && teamBtn && team && Math.round(aiBtn.getBoundingClientRect().bottom) === Math.round(ai.getBoundingClientRect().bottom) && Math.round(teamBtn.getBoundingClientRect().bottom) === Math.round(team.getBoundingClientRect().bottom) };
      });
      check(t('Team Chat\'s message box is a 3-row textarea with the AI Chat sidebar\'s height, padding, radius, border and font size'), composer.ai && composer.team && composer.team.h === composer.ai.h && composer.team.pad === composer.ai.pad && composer.team.radius === composer.ai.radius && composer.team.font === composer.ai.font && composer.team.border === composer.ai.border && composer.teamRows === 3 && composer.aiRows === 3, JSON.stringify(composer));
      check(t('...and its send button has the AI Chat sidebar\'s size (the tall square button), bottom-aligned with the box'), composer.aiBtn && composer.teamBtn && composer.teamBtn.h === composer.aiBtn.h && composer.teamBtn.w === composer.aiBtn.w && composer.aligned, JSON.stringify(composer));
      await screenshot(page, `team-chat-right-ai-chat-left-${theme}`);
    } finally { await context.close(); }
  }

  // ---- the phone: no rail, no menu
  {
    const { context, page } = await open('light', { viewport: { width: 390, height: 844 }, mobile: true });
    try {
      check('the phone layout has no rail icons and so no "Open on the right"', (await page.locator('[data-testid="rail-ai-chat"]').count()) === 0 && (await page.locator('[data-testid="rail-panel-menu"]').count()) === 0);
      await page.evaluate(() => { localStorage.setItem('panelSide.aiChat', JSON.stringify('right')); window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } })); });
      await page.waitForTimeout(800);
      check('a remembered right side is ignored on the phone: the panel is a drawer, no right-hand column', (await page.locator('[data-side="right"]').count()) === 0);
    } finally { await context.close(); }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
