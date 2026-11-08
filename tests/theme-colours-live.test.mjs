/**
 * A custom theme colours every surface, live (Playwright against the Vite
 * dev server, no backend): a dark green theme like the one that showed the
 * bug (green text on near-black; the headings of the Documents preview and
 * the text in its fenced code blocks stayed white) is applied, a document
 * with headings, a code block, inline code, a table and a link is previewed,
 * and the computed colours of the preview's H1 / H2, the code-block text,
 * the inline code, the table header, the body text and a modal title are
 * checked against the theme's tokens (src/utils/customThemes.js
 * deriveTokens: --md-*). The About page's header sits on the page in the
 * theme's text colours (no tinted box). Then the built-in Jacaranda, Light
 * and Dark (neutral) schemes are checked against the values those elements
 * always had (a regression guard: the --md-* tokens default to them).
 * Screenshots (the green theme: the preview, the editor, About) go to
 * CUSTOM_THEMES_SHOTS_DIR (/private/tmp/claude-501/shots/custom-themes).
 *
 * Needs playwright-core with Chromium. Port THEME_COLOURS_TEST_PORT (5209).
 * Run: node tests/theme-colours-live.test.mjs
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
const PORT = Number(process.env.THEME_COLOURS_TEST_PORT || 5209);
const OUT = process.env.CUSTOM_THEMES_SHOTS_DIR || '/private/tmp/claude-501/shots/custom-themes';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (THEME_COLOURS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

// the green theme (the maintainer's kind): green text on a near-black code background
const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
const green = ct.validateCustomTheme({
  ...ct.defaultTheme('dark', 'Terminal green'),
  colors: {
    canvas: '#06140a', card: '#0b1f10', cardSecondary: '#11301a', codeBg: '#020a05',
    textPrimary: '#3fbf6a', textSecondary: '#2f9e57', textMuted: '#2a7a46',
    accent: '#5ee08a', border: '#1d4d2a', success: '#3fbf6a', warning: '#d9c54a', danger: '#f26b6b',
    railText: '#3fbf6a', sidebar: '#04100a', markArch: '#3fbf6a', markBlossom: '#06140a', markCenter: null,
  },
}).theme;
const tokens = ct.deriveTokens(green);
const rgb = (hex) => { const c = ct.parseColor(hex); return `rgb(${c.r}, ${c.g}, ${c.b})`; };
const DOC = ['# Heading one', '', 'Body text with `inline code` and a [link](https://example.com).', '', '## Heading two', '', '```bash', 'echo "plain words"', 'ls -la', '```', '', '| Column | Value |', '| --- | --- |', '| a | 1 |', '| b | 2 |', '', '### Heading three'].join('\n');

const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(({ theme, scheme }) => {
  try {
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    if (!localStorage.getItem('jacarium-custom-themes')) localStorage.setItem('jacarium-custom-themes', JSON.stringify([theme]));
    if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', scheme);
  } catch { /* storage */ }
}, { theme: green, scheme: `custom-${green.id}` });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.2.0', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }); };
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
// the computed colours of the preview's parts and the dialog title
const probe = () => page.evaluate(() => {
  const cs = (el, prop = 'color') => (el ? getComputedStyle(el)[prop] : null);
  const p = document.querySelector('.markdown-preview');
  const q = (s) => (p ? p.querySelector(s) : null);
  return {
    h1: cs(q('h1')), h2: cs(q('h2')), h3: cs(q('h3')), body: cs(q('p')), inlineCode: cs(q('p code')), link: cs(q('a')),
    codeText: cs(q('pre code')), codeBg: cs(q('pre'), 'backgroundColor'), th: cs(q('th')), thBg: cs(q('th'), 'backgroundColor'), tdBorder: cs(q('td'), 'borderTopColor'),
    h1Border: cs(q('h1'), 'borderBottomColor'),
    keyword: cs(q('pre .hljs-built_in, pre .hljs-keyword')),
    modalTitle: cs(document.querySelector('[data-testid="settings-modal"] h2')),
    dark: document.documentElement.classList.contains('dark'),
  };
});
const openPreview = async () => {
  await page.locator('button[title="Preview"], button[title^="Preview (all documents)"]').first().click();
  await page.locator('.markdown-preview h1').waitFor({ timeout: 15000 });
  await sleep(300);
};

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('the green custom theme is applied from storage: the dark base and the text token on <html>', (await page.evaluate(() => [document.documentElement.classList.contains('dark'), getComputedStyle(document.documentElement).getPropertyValue('--os-text-primary').trim(), getComputedStyle(document.documentElement).getPropertyValue('--md-heading').trim()])).join() === 'true,#3fbf6a,#3fbf6a');
  // a document with headings, inline code, a link, a fenced block and a table, previewed
  check('New Document', await clickButton('New Document'));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(500);
  await page.locator('.sc-editor-cm .cm-content').click();
  await page.keyboard.insertText(DOC); await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'green-theme-editor.png') });
  await openPreview();
  let c = await probe();
  check('the preview under the green theme: H1, H2 and H3 take the text colour (no white heading)', c.h1 === rgb(green.colors.textPrimary) && c.h2 === c.h1 && c.h3 === c.h1, JSON.stringify(c));
  check('...the body text, the table header text and its border follow the theme (text, the secondary card, the border)', c.body === rgb(green.colors.textPrimary) && c.th === rgb(green.colors.textPrimary) && c.thBg === rgb(green.colors.cardSecondary) && c.tdBorder === rgb(green.colors.border) && c.h1Border === rgb(green.colors.border), JSON.stringify(c));
  check('...the code block\'s plain text is the derived code text (readable on the code background), the block the theme\'s code background; inline code the same text colour', c.codeText === rgb(tokens['--md-code-text']) && c.codeBg === rgb(green.colors.codeBg) && c.inlineCode === rgb(tokens['--md-code-text']) && ct.contrastRatio(tokens['--md-code-text'], green.colors.codeBg) >= 4.5, JSON.stringify([c.codeText, c.codeBg, c.inlineCode, tokens['--md-code-text']]));
  check('...the link is the theme\'s link colour; a syntax token keeps the base\'s palette (not the text colour)', c.link === rgb(tokens['--md-link']) && c.keyword && c.keyword !== c.codeText, JSON.stringify([c.link, tokens['--md-link'], c.keyword]));
  await page.screenshot({ path: path.join(OUT, 'green-theme-preview.png') });
  // a modal title, and the About header
  await page.locator('[data-testid="sidebar-brand-mark"]').click();
  await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
  c = await probe();
  check('a dialog title (Application Settings) is in the theme\'s text colour', c.modalTitle === rgb(green.colors.textPrimary), c.modalTitle);
  await page.locator('[data-testid="settings-modal"] [role="tab"]', { hasText: 'About' }).click();
  await page.locator('[data-testid="about-hero"]').waitFor({ timeout: 10000 }); await sleep(200);
  const about = await page.evaluate(() => { const h = document.querySelector('[data-testid="about-hero"]'); const cs = getComputedStyle(h); const w = h.querySelector('.brand-wordmark'); const t = h.querySelector('[data-testid="about-tagline"]'); return { bg: cs.backgroundColor, title: w && getComputedStyle(w).color, tagline: t && getComputedStyle(t).color, hero: h.classList.contains('brand-hero') }; });
  check('About: the header has no tinted box (a transparent background, no brand-hero), the title in the text colour and the tagline in the secondary colour', about.bg === 'rgba(0, 0, 0, 0)' && !about.hero && about.title === rgb(green.colors.textPrimary) && about.tagline === rgb(green.colors.textSecondary), JSON.stringify(about));
  await page.locator('[data-testid="settings-modal"]').screenshot({ path: path.join(OUT, 'green-theme-about.png') });
  await page.keyboard.press('Escape'); await sleep(300);
  // the unread dot by the bell (--rail-badge, from the accent): the rail's own markup placed on the bell (the
  // notification history is in memory, nothing in this test raises one), its painted colour the token's
  const probeBadge = () => page.evaluate(() => {
    const bell = document.querySelector('[data-testid="rail-notifications"]');
    if (!bell) return null;
    let dot = bell.querySelector('[data-testid="rail-badge"]');
    if (!dot) { dot = document.createElement('span'); dot.className = 'absolute top-2 right-2 w-2 h-2 rounded-full bg-(--rail-badge)'; dot.setAttribute('data-testid', 'rail-badge'); bell.appendChild(dot); }
    const cs = getComputedStyle(document.documentElement);
    return { color: getComputedStyle(dot).backgroundColor, token: cs.getPropertyValue('--rail-badge').trim(), rail: cs.getPropertyValue('--os-rail').trim() };
  });
  const badge = await probeBadge();
  check('the unread dot by the bell takes the theme\'s --rail-badge token (derived from the accent) and reads on the rail (>= 3:1)', !!badge && badge.color === rgb(badge.token) && badge.token === tokens['--rail-badge'] && ct.contrastRatio(badge.token, badge.rail) >= 3, JSON.stringify([badge, tokens['--rail-badge']]));
  await page.locator('nav.w-16').screenshot({ path: path.join(OUT, 'green-theme-rail-badge.png') });

  // the built-in schemes: the values those elements always had
  const expected = {
    dark: { h1: 'rgb(230, 237, 243)', codeText: 'rgb(230, 237, 243)', inlineCode: 'rgb(230, 237, 243)', link: 'rgb(74, 158, 255)', thBg: 'rgb(22, 27, 34)', tdBorder: 'rgb(58, 58, 58)', h1Border: 'rgb(58, 58, 58)', dark: true },
    'dark-neutral': { h1: 'rgb(230, 237, 243)', codeText: 'rgb(230, 237, 243)', inlineCode: 'rgb(230, 237, 243)', link: 'rgb(74, 158, 255)', thBg: 'rgb(22, 27, 34)', tdBorder: 'rgb(58, 58, 58)', h1Border: 'rgb(58, 58, 58)', dark: true },
    light: { h1: 'rgb(36, 41, 47)', codeText: 'rgb(36, 41, 47)', inlineCode: 'rgb(36, 41, 47)', body: 'rgb(36, 41, 47)', link: 'rgb(9, 105, 218)', codeBg: 'rgb(246, 248, 250)', thBg: 'rgb(246, 248, 250)', tdBorder: 'rgb(208, 215, 222)', h1Border: 'rgb(216, 222, 228)', dark: false },
    'gradient-red-purple': { h1: 'rgb(230, 237, 243)', codeText: 'rgb(230, 237, 243)', inlineCode: 'rgb(230, 237, 243)', link: 'rgb(74, 158, 255)', thBg: 'rgb(22, 27, 34)', tdBorder: 'rgb(58, 58, 58)', h1Border: 'rgb(58, 58, 58)', dark: true },
  };
  // the unread dot per built-in scheme: railBadge() of its accent (Light, Jacaranda, Dark) or its arch tint (Magma)
  const badgeExpected = { dark: ['#4a9eff', 'rgb(74, 158, 255)'], 'dark-neutral': ['#4a9eff', 'rgb(74, 158, 255)'], light: ['#0066cc', 'rgb(0, 102, 204)'], 'gradient-red-purple': ['#ffe4e6', 'rgb(255, 228, 230)'] };
  for (const scheme of ['dark', 'dark-neutral', 'light', 'gradient-red-purple']) {
    await page.evaluate((s) => localStorage.setItem('app-theme', s), scheme);
    await page.reload({ waitUntil: 'load' }); await sleep(1500);
    await dismiss();
    if (!(await page.locator('.markdown-preview h1').count())) {
      const tab = page.locator('[data-testid^="doc-tab-"], .sc-tab').first();
      if (await tab.count()) await tab.click().catch(() => {});
      await openPreview().catch(() => {});
    }
    c = await probe();
    const exp = expected[scheme];
    const diffs = Object.keys(exp).filter((k) => c[k] !== exp[k]).map((k) => `${k}: ${c[k]} != ${exp[k]}`);
    if (scheme === 'dark') {
      const codeBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--os-code-bg').trim());
      if (c.codeBg !== rgb(codeBg)) diffs.push(`codeBg: ${c.codeBg} != ${codeBg}`);
      const body = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--os-text-primary').trim());
      if (c.body !== rgb(body)) diffs.push(`body: ${c.body} != ${body}`);
    }
    check(`${scheme}: the preview's headings, code text, inline code, link, table header, borders and body keep their built-in values`, diffs.length === 0, diffs.join(' | ') || JSON.stringify(c));
    const b = await probeBadge();
    const railStops = await page.evaluate(() => { const nav = document.querySelector('nav.w-16'); const cs = getComputedStyle(nav); return [cs.backgroundImage, cs.backgroundColor]; });
    check(`${scheme}: the unread dot is the scheme's own (${badgeExpected[scheme][0]}, from its accent / arch tint through railBadge), painted ${badgeExpected[scheme][1]}, not the old purple`, !!b && b.token.toLowerCase() === badgeExpected[scheme][0] && b.color === badgeExpected[scheme][1] && b.color !== 'rgb(168, 85, 247)', JSON.stringify([b, railStops]));
    if (scheme !== 'dark-neutral') await page.locator('nav.w-16').screenshot({ path: path.join(OUT, `${scheme}-rail-badge.png`) });
  }
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
