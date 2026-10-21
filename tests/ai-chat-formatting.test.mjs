#!/usr/bin/env node
/**
 * AI answers render as Markdown in the chat bubbles - Robin's page (streamed
 * over /api/ai/chat-stream) and the AI Chat sidebar (/api/ai/chat) - in the
 * real app: headings (sized for a bubble, smaller than the Documents
 * preview), horizontal rules (a thin line in the border token), bullet and
 * numbered lists with nested ones, fenced code with syntax highlighting,
 * inline code, tables, blockquotes, the callouts, a thinking block, and a
 * long code line that scrolls sideways inside the bubble instead of
 * overflowing it. Both themes, and the phone layout for Robin.
 *
 * THE BUG: the bubbles carried Tailwind Typography's `prose` classes, but
 * the plugin is not installed, so headings, bullets and rules had no
 * styling at all (the user saw "#"-less run-together headings and no
 * rules). The bubbles now carry the Documents preview's `markdown-preview`
 * rules plus the bubble-scaled `sc-chat-markdown` overrides (src/index.css).
 *
 * Chromium through playwright-core (SKIP without it); a Vite dev server with
 * the backend faked in the page. Set CHAT_SHOTS_DIR to keep screenshots.
 * Run: node tests/ai-chat-formatting.test.mjs
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
const OUT = process.env.CHAT_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-formatting-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 5290;
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch {} try { vite.kill('SIGTERM'); } catch {} };

// a model-style answer: everything a real reply uses
const ANSWER = `# Rollout stuck

## What to check first

Start with the pod status and events:

\`\`\`bash
kubectl rollout status deployment/checkout -n shop
kubectl get events -n shop --sort-by=.lastTimestamp --field-selector=involvedObject.kind=Pod,involvedObject.name=checkout-7d9f8c6b5-x2k4q,reason!=Scheduled,reason!=Pulled,reason!=Created,reason!=Started --output=custom-columns=TIME:.lastTimestamp,TYPE:.type,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message | tail -n 20
\`\`\`

### Likely causes

1. The image cannot be pulled
   - a typo in the tag
   - the registry needs credentials (\`imagePullSecrets\`)
2. The readiness probe fails
   - the port is wrong
   - the app starts slowly

> [!TIP]
> \`kubectl describe pod\` shows the probe's last failure.

> Plain quote: check the events before the logs.

| Field | Value |
| --- | --- |
| namespace | shop |
| replicas | 3 |

---

\`\`\`yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
\`\`\`

Done.`;
const THINKING = 'The user has a stuck rollout; look at events first.';
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
function stream(answer) {
  const chunks = [];
  for (let i = 0; i < answer.length; i += 37) chunks.push({ type: 'content', content: answer.slice(i, i + 37) });
  return sse([{ type: 'thinking', content: THINKING }, ...chunks, { type: 'done' }]);
}
async function routes(context) {
  await context.route('**/api/ai/health', (r) => r.fulfill({ json: { status: 'online' } }));
  await context.route('**/api/ai/models', (r) => r.fulfill({ json: { ollama: ['qwen3:30b'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } } }));
  await context.route('**/api/ai/chat-stream', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: stream(ANSWER) }));
  await context.route('**/api/ai/chat', (r) => r.fulfill({ json: { message: ANSWER } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
}
const PROBE = `(root) => {
  if (!root) return null;
  const cs = (el) => el && getComputedStyle(el);
  const p = root.querySelector('p'); const h1 = root.querySelector('h1'); const h2 = root.querySelector('h2'); const h3 = root.querySelector('h3');
  const hr = root.querySelector('hr'); const pre = Array.from(root.querySelectorAll('pre')).find((x) => x.scrollWidth > x.clientWidth) || root.querySelector('pre');
  const bubble = root.closest('.ai-chat-message') || root.parentElement;
  const px = (v) => parseFloat(v);
  return {
    h1: !!h1, h2: !!h2, h3: !!h3, hr: !!hr, lists: root.querySelectorAll('ul li').length, nested: !!root.querySelector('ul ul, ol ul, ul ol, ol ol'), ol: root.querySelectorAll('ol > li').length,
    pre: root.querySelectorAll('pre').length, hljs: !!root.querySelector('pre code.hljs span[class*="hljs-"]'), langs: Array.from(root.querySelectorAll('pre code')).map((c) => c.className), inlineCode: !!root.querySelector('p code, li code'),
    table: !!root.querySelector('table'), blockquote: !!root.querySelector('blockquote'), callout: !!root.querySelector('.md-callout-tip'),
    pSize: px(cs(p).fontSize), h1Size: h1 && px(cs(h1).fontSize), h2Size: h2 && px(cs(h2).fontSize), h3Size: h3 && px(cs(h3).fontSize),
    hrHeight: hr && hr.getBoundingClientRect().height, hrColor: hr && cs(hr).backgroundColor, hrBorderTop: hr && cs(hr).borderTopWidth,
    liStyle: root.querySelector('ul > li') && cs(root.querySelector('ul > li')).listStyleType, olStyle: root.querySelector('ol > li') && cs(root.querySelector('ol > li')).listStyleType,
    preOverflowX: pre && cs(pre).overflowX, preWhiteSpace: pre && cs(pre).whiteSpace, preScrolls: pre && pre.scrollWidth > pre.clientWidth + 2, preInsideBubble: pre && bubble && pre.getBoundingClientRect().right <= bubble.getBoundingClientRect().right + 1 && pre.getBoundingClientRect().width <= bubble.getBoundingClientRect().width,
    bubbleOverflow: bubble && bubble.scrollWidth > bubble.clientWidth + 2,
    prose: root.className.includes('prose'), classes: root.className,
  };
}`;
async function open(theme, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: theme, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.removeItem('aiChatPageConversations'); localStorage.removeItem('aiChatConversations'); } catch {} }, { theme });
  await routes(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(URL_, { waitUntil: 'load' }); await page.waitForTimeout(2200);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page };
}
const results = {};
try {
  for (const theme of ['dark', 'light']) {
    const { context, page } = await open(theme, { width: 1400, height: 900 });
    // Robin: a streamed answer with a thinking block
    const nav = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent.trim()) === 'Robin'); if (b) { b.click(); return true; } return false; });
    if (!nav) await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate-to-page', { detail: 'ai-chat' })));
    await page.waitForTimeout(1500);
    const ta = page.locator('textarea').last();
    await ta.fill('My rollout is stuck'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).some((el) => /Done\./.test(el.textContent)), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const robin = await page.evaluate(`((probe) => probe(Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).find((el) => /Done\\./.test(el.textContent))))(${PROBE})`);
    results[`robin-${theme}`] = robin;
    check(`${theme} Robin (streamed): headings h1/h2/h3 rendered and sized for a bubble (h1 > h2 > h3 > p, h1 under 1.5x p)`, robin && robin.h1 && robin.h2 && robin.h3 && robin.h1Size > robin.h2Size && robin.h2Size > robin.h3Size && robin.h3Size > robin.pSize && robin.h1Size <= robin.pSize * 1.5, JSON.stringify(robin));
    check(`${theme} Robin: a visible 1px horizontal rule in the border token`, robin && robin.hr && Math.round(robin.hrHeight) === 1 && robin.hrColor && !/rgba\(0, 0, 0, 0\)/.test(robin.hrColor), robin && `${robin.hrHeight} ${robin.hrColor}`);
    check(`${theme} Robin: bullet and numbered lists with nesting, bullets shown`, robin && robin.lists >= 4 && robin.nested && robin.ol === 2 && robin.liStyle === 'disc' && robin.olStyle === 'decimal', robin && `${robin.lists} ${robin.nested} ${robin.liStyle} ${robin.olStyle}`);
    check(`${theme} Robin: fenced bash and yaml blocks, syntax-highlighted; inline code; a table; a blockquote; the TIP callout`, robin && robin.pre === 2 && robin.hljs && robin.langs.join().includes('language-bash') && robin.langs.join().includes('language-yaml') && robin.inlineCode && robin.table && robin.blockquote && robin.callout, robin && JSON.stringify([robin.pre, robin.hljs, robin.langs, robin.inlineCode, robin.table, robin.blockquote, robin.callout]));
    check(`${theme} Robin: the long code line scrolls inside the bubble (overflow-x auto, white-space pre) and the bubble itself does not overflow`, robin && robin.preOverflowX === 'auto' && robin.preWhiteSpace === 'pre' && robin.preScrolls && robin.preInsideBubble && !robin.bubbleOverflow, robin && JSON.stringify([robin.preOverflowX, robin.preWhiteSpace, robin.preScrolls, robin.preInsideBubble, robin.bubbleOverflow]));
    check(`${theme} Robin: no inert prose class left`, robin && !robin.prose, robin && robin.classes);
    const thinking = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /^Thinking/.test(b.textContent.trim())));
    check(`${theme} Robin: the thinking block is offered as its tab`, thinking);
    await page.evaluate(() => { const el = Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).find((x) => /Done\./.test(x.textContent)); el && el.scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `robin-formatted-${theme}.png`) });
    // the sidebar: a non-streamed answer (CHAT_SHOTS_ROBIN_ONLY skips it: before this fix the sidebar did not render at all)
    if (process.env.CHAT_SHOTS_ROBIN_ONLY) { await context.close(); continue; }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', { detail: { isOpen: true } })));
    await page.waitForTimeout(800);
    const side = page.locator('textarea[placeholder="Type your message..."].px-3');   // the sidebar's (Robin's own is px-4)
    await side.waitFor({ timeout: 8000 });
    await side.fill('Same question in the sidebar'); await side.press('Enter');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.ai-chat-message .sc-chat-markdown')).some((el) => /Done\./.test(el.textContent)), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const sidebar = await page.evaluate(`((probe) => probe(Array.from(document.querySelectorAll('.ai-chat-message .sc-chat-markdown')).find((el) => /Done\\./.test(el.textContent))))(${PROBE})`);
    results[`sidebar-${theme}`] = sidebar;
    check(`${theme} sidebar (non-streamed): headings, rule, lists, highlighted code, table, callout - and code scrolls inside the bubble`, sidebar && sidebar.h1 && sidebar.h2 && sidebar.hr && Math.round(sidebar.hrHeight) === 1 && sidebar.lists >= 4 && sidebar.liStyle === 'disc' && sidebar.hljs && sidebar.table && sidebar.callout && sidebar.preOverflowX === 'auto' && sidebar.preScrolls && sidebar.preInsideBubble && !sidebar.bubbleOverflow && !sidebar.prose, JSON.stringify(sidebar));
    await page.evaluate(() => { const el = Array.from(document.querySelectorAll('.ai-chat-message .sc-chat-markdown')).find((x) => /Done\./.test(x.textContent)); el && el.scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `sidebar-formatted-${theme}.png`) });
    await context.close();
  }
  // the phone: Robin's page at 390px
  {
    const { context, page } = await open('dark', { width: 390, height: 844 });
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, a')).find((x) => /Robin/.test(x.getAttribute('aria-label') || x.textContent)); b && b.click(); });
    await page.waitForTimeout(1200);
    const more = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^More$/.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; });
    if (more) { await page.waitForTimeout(400); await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[role="menuitem"], button')).find((x) => /Robin/.test(x.textContent)); b && b.click(); }); await page.waitForTimeout(1200); }
    const ta = page.locator('textarea').last();
    if (await ta.count()) {
      await ta.fill('Stuck rollout'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).some((el) => /Done\./.test(el.textContent)), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      const phone = await page.evaluate(`((probe) => probe(Array.from(document.querySelectorAll('.markdown-preview.sc-chat-markdown')).find((el) => /Done\\./.test(el.textContent))))(${PROBE})`);
      results.phone = phone;
      check('phone Robin: the same formatting, the code scrolls inside the bubble, no sideways page overflow', phone && phone.h1 && phone.hr && phone.lists >= 4 && phone.preScrolls && phone.preInsideBubble && !phone.bubbleOverflow && (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), JSON.stringify(phone));
      await page.screenshot({ path: path.join(OUT, 'robin-formatted-phone-dark.png') });
    } else {
      check('phone Robin: the page opened', false, 'no textarea');
    }
    await context.close();
  }
  const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
  check('index.css: the sc-chat-markdown rules exist (headings, hr in the border token, pre overflow-x auto / white-space pre, lists)', /\.sc-chat-markdown h1 \{ font-size: 1\.3em; \}/.test(css) && /\.sc-chat-markdown hr \{[^}]*background-color: var\(--os-border\)/.test(css) && /\.sc-chat-markdown pre \{[^}]*white-space: pre;[^}]*overflow-x: auto;/.test(css) && /\.sc-chat-markdown ul \{ list-style-type: disc; \}/.test(css));
  const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  check('the bubbles carry markdown-preview + sc-chat-markdown and no prose class (Tailwind Typography is not installed)', /markdown-preview sc-chat-markdown/.test(src('src/components/AIChatPage.jsx')) && /markdown-preview sc-chat-markdown/.test(src('src/components/common/AIChatSidebar.jsx')) && !/\bprose\b/.test(src('src/components/AIChatPage.jsx')) && !/\bprose\b/.test(src('src/components/common/AIChatSidebar.jsx')) && !/typography/.test(src('package.json')));
} finally {
  await stop();
}
fs.writeFileSync(path.join(OUT, 'probes.json'), JSON.stringify(results, null, 1));
console.log(`\nscreenshots: ${OUT}`);
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
