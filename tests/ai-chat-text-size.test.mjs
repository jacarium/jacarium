#!/usr/bin/env node
/**
 * The AI chat bubbles use the app's CHAT text size, and a user's message is
 * plain text - in the real app (Chromium, playwright-core, a Vite dev
 * server, the backend faked), the AI Chat sidebar and Robin's page, dark
 * and light:
 *   - a reply paragraph is 14px / 20px (--sc-chat-font / --sc-chat-line,
 *     text-sm: what Team Chat's text and the sidebar list rows use), not
 *     the Documents preview's 16px / 1.7 the bubbles inherited in 3.3.3;
 *   - headings in a reply stay within the stated ratio of that size (h1
 *     1.15em, h2 1.1em, h3 1.05em, bold), tables and lists at the chat
 *     size, code a little smaller;
 *   - the user's own message - exactly the one from the report, a sentence
 *     ending in ":" over a "---" line (a setext heading) and two lines -
 *     keeps its Markdown, in the sidebar and on Robin alike (the same
 *     renderer and chat size): its heading is an h2 of at most 1.1x the
 *     body size, not a title, and the "---" is not shown as text;
 *   - Team Chat's message text and the sidebar rows measure the same size.
 * Screenshots (set CHAT_SIZE_SHOTS_DIR).
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/ai-chat-text-size.test.mjs
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
const OUT = process.env.CHAT_SIZE_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-text-size-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5303);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

// the user's message from the report (a sentence over "---": a setext heading to Markdown) and a reply with every size-bearing element
const USER = 'Convert this to markdown table too:\n---\nSLSA Level 2 Requirement    Explanation\nProvenance - Available    The provenance is available to the consumer';
const ANSWER = '# Converted\n\n## As a table\n\n### Rows\n\nHere it is, with `inline code` and a list:\n\n- one\n- two\n\n| Requirement | Explanation |\n|---|---|\n| Provenance | Available |\n\n> Note: done.';
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.removeItem('aiChatPageConversations'); } catch { /* ignore */ } }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.3', protocol: 2 } }));
  await context.route('**/api/ai/health', (r) => r.fulfill({ json: { status: 'online' } }));
  await context.route('**/api/ai/models', (r) => r.fulfill({ json: { ollama: ['qwen3:30b'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } } }));
  await context.route('**/api/ai/chat-stream', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse([{ type: 'content', content: ANSWER }, { type: 'done' }]) }));
  await context.route('**/api/ai/chat', (r) => r.fulfill({ json: { message: ANSWER } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page };
}

// the sizes of a reply bubble (root = the .sc-chat-markdown of the reply) and of the user's bubble
const PROBE = (root, user) => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const cs = (el) => el && getComputedStyle(el);
  const p = root.querySelector('p'); const h1 = root.querySelector('h1'); const h2 = root.querySelector('h2'); const h3 = root.querySelector('h3');
  const code = root.querySelector('code'); const td = root.querySelector('td'); const li = root.querySelector('li'); const bq = root.querySelector('blockquote');
  const out = {
    p: px(cs(p).fontSize), pLine: px(cs(p).lineHeight), root: px(cs(root).fontSize), rootLine: px(cs(root).lineHeight), family: cs(root).fontFamily.slice(0, 40),
    h1: h1 && px(cs(h1).fontSize), h2: h2 && px(cs(h2).fontSize), h3: h3 && px(cs(h3).fontSize), h1Weight: h1 && cs(h1).fontWeight,
    code: code && px(cs(code).fontSize), td: td && px(cs(td).fontSize), li: li && px(cs(li).fontSize), bq: bq && px(cs(bq).fontSize),
  };
  if (user) {
    const heading = user.querySelector('h1,h2,h3,h4,h5,h6');
    const body = user.querySelector('p') || user;
    out.user = { size: px(cs(user).fontSize), bodySize: px(cs(body).fontSize), line: px(cs(body).lineHeight), headingTag: heading && heading.tagName, headingSize: heading && px(cs(heading).fontSize), headings: user.querySelectorAll('h1,h2,h3,h4,h5,h6').length, dashes: /^---$/m.test(user.innerText), text: user.innerText.slice(0, 160) };
  }
  return out;
};
const sendIn = async (page, textarea) => { await textarea.fill(USER); await textarea.press('Enter'); };

function assess(t, who, g) {
  check(t(`${who}: a reply paragraph is 14px / 20px (the chat size), on the app's UI font`), g.p === 14 && g.pLine === 20 && g.root === 14 && !/Georgia|serif/i.test(g.family), JSON.stringify(g));
  check(t(`${who}: headings stay within the ratio (h1 <= 1.15em, h2 <= 1.1em, h3 <= 1.05em of 14px), bold, and h1 > h2 > h3 > p`), g.h1 && g.h2 && g.h3 && g.h1 <= 14 * 1.15 + 0.05 && g.h2 <= 14 * 1.1 + 0.05 && g.h3 <= 14 * 1.05 + 0.05 && g.h1 > g.h2 && g.h2 > g.h3 && g.h3 > g.p && Number(g.h1Weight) >= 600, JSON.stringify(g));
  check(t(`${who}: lists, tables and blockquotes at the chat size, code a little smaller`), g.li === 14 && g.td === 14 && g.bq === 14 && g.code < 14 && g.code >= 12, JSON.stringify(g));
  check(t(`${who}: the user's bubble keeps its Markdown at the chat size: the setext heading from "text" over "---" is an h2 of at most 1.1x the body (<= 15.4px), no literal "---", the body 14px / 20px`), g.user && g.user.size === 14 && g.user.bodySize === 14 && g.user.line === 20 && g.user.headingTag === 'H2' && g.user.headingSize <= 14 * 1.1 + 0.05 && !g.user.dashes && /Convert this to markdown table too:/.test(g.user.text), JSON.stringify(g.user));
}

try {
  for (const theme of ['dark', 'light']) {
    const t = (s) => `${theme}: ${s}`;
    const { context, page } = await open(theme);
    try {
      // ---- the sidebar
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } })));
      await page.waitForTimeout(800);
      const side = page.locator('textarea[placeholder="Type your message..."].px-3');
      await side.waitFor({ timeout: 8000 });
      await sendIn(page, side);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.ai-chat-message .sc-chat-markdown')).some((el) => /Converted/.test(el.textContent)), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
      const sidebar = await page.evaluate((probeSrc) => {
        const probe = new Function('root', 'user', `return (${probeSrc})(root, user);`);
        const reply = Array.from(document.querySelectorAll('.ai-chat-message .sc-chat-markdown')).find((el) => /Converted/.test(el.textContent));
        const user = document.querySelector('.ai-chat-message .sc-chat-markdown-user');
        return reply ? probe(reply, user) : null;
      }, PROBE.toString());
      check(t('sidebar: the reply rendered'), !!sidebar);
      if (sidebar) assess(t, 'sidebar', sidebar);
      await page.evaluate(() => { const el = document.querySelector('.ai-chat-message .sc-chat-markdown-user'); el && el.scrollIntoView({ block: 'start' }); });
      const shotS = path.join(OUT, `sidebar-size-${theme}.png`); await page.screenshot({ path: shotS }); console.log(`  screenshot: ${shotS}`);
      // the same size as Team Chat's text and the sidebar list rows (text-sm; opening Team Chat on the left closes the AI chat - the shot is taken first)
      const others = await page.evaluate(() => { const px = (v) => Math.round(parseFloat(v) * 100) / 100; const row = document.querySelector('.sc-row span.text-sm'); const teamEmpty = null; return { row: row && px(getComputedStyle(row).fontSize), teamEmpty }; });
      await page.locator('[data-testid="rail-team-chat"]').click(); await page.waitForTimeout(600);
      const team = await page.evaluate(() => { const px = (v) => Math.round(parseFloat(v) * 100) / 100; const p = document.querySelector('[data-testid="panel-team-chat"] p.text-sm'); const ta = document.querySelector('[data-testid="team-chat-input"]'); return { p: p && px(getComputedStyle(p).fontSize), input: ta && px(getComputedStyle(ta).fontSize) }; });
      check(t('the chat size equals Team Chat\'s text (text-sm, 14px) and the sidebar list rows'), sidebar && sidebar.p === team.p && sidebar.p === team.input && (others.row == null || others.row === sidebar.p), JSON.stringify({ team, others }));
      await page.locator('[data-testid="rail-team-chat"]').click(); await page.waitForTimeout(300);

      // ---- Robin
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent.trim()) === 'Robin'); if (b) b.click(); });
      await page.waitForTimeout(1500);
      await sendIn(page, page.locator('textarea').last());
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).some((el) => /Converted/.test(el.textContent) && !el.closest('.ai-chat-message')), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
      const robin = await page.evaluate((probeSrc) => {
        const probe = new Function('root', 'user', `return (${probeSrc})(root, user);`);
        const reply = Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).find((el) => /Converted/.test(el.textContent) && !el.closest('.ai-chat-message'));
        const user = Array.from(document.querySelectorAll('.sc-chat-bubble .sc-chat-markdown')).find((el) => !el.closest('.ai-chat-message') && /Convert this to markdown table too:/.test(el.textContent));
        return reply ? probe(reply, user) : null;
      }, PROBE.toString());
      check(t('Robin: the reply rendered'), !!robin);
      if (robin) assess(t, 'Robin', robin);
      const shotR = path.join(OUT, `robin-size-${theme}.png`); await page.screenshot({ path: shotR }); console.log(`  screenshot: ${shotR}`);
    } finally { await context.close(); }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
