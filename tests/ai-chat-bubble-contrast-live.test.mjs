/**
 * The AI chat's bubbles read in every scheme (Playwright against the Vite
 * dev server, the AI backend stubbed - no network): with the AI sidebar
 * open and a user message plus a reply on screen (each with a [text](url)
 * link, a bare URL, inline code and a list; synthetic text, example.test
 * links), every scheme of the Theme gallery (the built-in ones, the
 * palettes, the Crazy group) is applied in turn and the computed colours of
 * the user bubble (the accent surface) and the assistant bubble are read:
 * the text and the links against each bubble's own background must reach
 * 4.5:1, the links are underlined, and a long URL wraps inside the bubble.
 * The table of ratios (scheme x bubble x text / link) is printed for the
 * record. Screenshots of Deep Ocean, Catppuccin Latte and Jacaranda go to
 * CUSTOM_THEMES_SHOTS_DIR (/private/tmp/claude-501/shots/custom-themes).
 *
 * Needs playwright-core with Chromium. Port AI_BUBBLE_TEST_PORT (5210).
 * Run: node tests/ai-chat-bubble-contrast-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { parseCssColor, contrast, over } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.AI_BUBBLE_TEST_PORT || 5210);
const OUT = process.env.CUSTOM_THEMES_SHOTS_DIR || '/private/tmp/claude-501/shots/custom-themes';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (AI_BUBBLE_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const { THEME_STARTERS } = await import(path.join(REPO, 'src/utils/themeStarters.js'));
const SCHEMES = ['light', 'dark', 'dark-neutral', 'gradient-red-purple', 'gradient-blue-purple', 'gradient-green-blue', 'gradient-orange-red', 'gradient-pink-purple', ...THEME_STARTERS.filter((s) => s.group !== 'Built-in schemes').map((s) => `starter-${s.id}`)];
const SHOT = { 'starter-deep-ocean': 'ai-chat-deep-ocean.png', 'starter-catppuccin-latte': 'ai-chat-catppuccin-latte.png', dark: 'ai-chat-jacaranda.png' };
// synthetic messages: a link, a bare URL (long enough to wrap), inline code, a list
const USER_MSG = 'Please check [the runbook](https://docs.example.test/runbooks/network) and https://status.example.test/incidents/2026/a-rather-long-path-that-must-wrap-inside-the-bubble?view=all - then run `oc get nodes`.\n- first step\n- second step';
const REPLY_MSG = 'Sure. See [the reply note](https://docs.example.test/notes/reply) and https://status.example.test/incidents/2026/another-long-path-for-the-reply-bubble?view=all; run `oc get pods -A`.\n- one\n- two';

const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); } catch { /* storage */ } });
// the catch-all first: Playwright tries the routes last-registered first
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/ai/health', (r) => r.fulfill({ json: { status: 'ok' } }));
await context.route('**/api/ai/models', (r) => r.fulfill({ json: { anthropic: ['claude-test'], openai: [], gemini: [], ollama: [], ssh: [], defaults: { provider: 'anthropic', model: 'claude-test' } } }));
await context.route('**/api/ai/chat', (r) => r.fulfill({ json: { message: REPLY_MSG } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.2.0', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true, ai: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }); };
const openThemeSettings = async () => {
  await page.locator('[data-testid="sidebar-brand-mark"]').click();
  await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="settings-modal"] [role="tab"]', { hasText: 'Theme' }).click();
  await page.locator('[data-testid="scheme-gallery"]').waitFor({ timeout: 10000 });
};
const closeSettings = async () => { await page.keyboard.press('Escape'); await sleep(300); };
// the computed colours of both bubbles: text, link, inline code, the bubble's opaque background (walking up), the link's underline and wrapping
const probe = () => page.evaluate(() => {
  const bubbles = Array.from(document.querySelectorAll('.ai-chat-message'));
  const cs = (el, p) => getComputedStyle(el)[p];
  const bgOf = (el) => { let n = el; while (n) { const c = cs(n, 'backgroundColor'); const m = c.match(/rgba?\(([^)]+)\)/); if (c && c !== 'transparent' && !(m && m[1].split(',').length > 3 && parseFloat(m[1].split(',')[3]) < 0.99)) return c; n = n.parentElement; } return null; };
  const one = (b) => {
    if (!b) return null;
    const a = b.querySelector('a'); const bare = Array.from(b.querySelectorAll('a')).find((x) => x.textContent.startsWith('http'));
    const code = b.querySelector('code'); const li = b.querySelector('li');
    return {
      bg: bgOf(b), text: cs(b.querySelector('p') || b, 'color'), link: a && cs(a, 'color'), underline: a && cs(a, 'textDecorationLine'),
      linkBg: a && bgOf(a), bare: !!bare, bareWraps: bare ? bare.getBoundingClientRect().width <= b.getBoundingClientRect().width + 1 && b.scrollWidth <= b.clientWidth + 1 : null,
      code: code && cs(code, 'color'), codeBg: code && cs(code, 'backgroundColor'), li: li && cs(li, 'color'),
    };
  };
  const user = bubbles.find((b) => b.classList.contains('btn-selected') || b.closest('.justify-end'));
  const reply = bubbles.find((b) => b !== user);
  return { user: one(user), reply: one(reply), count: bubbles.length };
});
const ratio = (fg, bg) => { const f = parseCssColor(fg), b = parseCssColor(bg); if (!f || !b) return 0; return Math.round(contrast(f[3] !== undefined && f[3] < 1 ? over(f, b) : f, b) * 100) / 100; };
// a translucent surface (inline code's tint) over the bubble, as an rgb() string
const blend = (top, bottom) => { const t = parseCssColor(top), b = parseCssColor(bottom); if (!t) return bottom; if (!b) return top; const o = over(t, b); return `rgb(${o[0]}, ${o[1]}, ${o[2]})`; };

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleAIChatSidebar')));
  const box = page.locator('textarea[placeholder="Type your message..."]');
  await box.waitFor({ timeout: 20000 });
  await box.fill(USER_MSG);
  await box.press('Enter');
  await page.locator('.ai-chat-message').nth(1).waitFor({ timeout: 20000 }); await sleep(500);
  const first = await probe();
  check('the AI sidebar shows the user message and the stubbed reply, each with a link, a bare URL, inline code and a list', first.count === 2 && first.user && first.reply && first.user.link && first.reply.link && first.user.bare && first.reply.bare && first.user.code && first.reply.li, JSON.stringify(first));

  const rows = [];
  for (const scheme of SCHEMES) {
    await openThemeSettings();
    await page.locator(`[data-testid="scheme-card-${scheme}"]`).click(); await sleep(250);
    await closeSettings();
    await sleep(200);
    const c = await probe();
    const row = { scheme, userText: ratio(c.user.text, c.user.bg), userLink: ratio(c.user.link, c.user.linkBg || c.user.bg), userCode: ratio(c.user.code, c.user.codeBg ? blend(c.user.codeBg, c.user.bg) : c.user.bg), replyText: ratio(c.reply.text, c.reply.bg), replyLink: ratio(c.reply.link, c.reply.linkBg || c.reply.bg), underline: c.user.underline === 'underline' && c.reply.underline === 'underline', wraps: c.user.bareWraps && c.reply.bareWraps, raw: c };
    rows.push(row);
    check(`${scheme}: user bubble text ${row.userText}:1, link ${row.userLink}:1, inline code ${row.userCode}:1; reply text ${row.replyText}:1, link ${row.replyLink}:1 (all >= 4.5), links underlined, a long URL wraps inside the bubble`, row.userText >= 4.5 && row.userLink >= 4.5 && row.userCode >= 4.5 && row.replyText >= 4.5 && row.replyLink >= 4.5 && row.underline && row.wraps, JSON.stringify({ user: c.user, reply: c.reply }));
    if (SHOT[scheme]) await page.screenshot({ path: path.join(OUT, SHOT[scheme]) });
  }
  console.log('\n  scheme                      user text  user link  user code  reply text  reply link');
  for (const r of rows) console.log(`  ${r.scheme.padEnd(28)}${String(r.userText).padEnd(11)}${String(r.userLink).padEnd(11)}${String(r.userCode).padEnd(11)}${String(r.replyText).padEnd(12)}${r.replyLink}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`  screenshots: ${OUT}/`);
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await context.close().catch(() => {});
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
