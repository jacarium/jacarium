/**
 * Links follow the theme (src/index.css, "Links"): one --link / --link-hover
 * token per theme block, read by .link, .brand-link, the primitives' link
 * buttons (sc-btn-link) and the Diagnostics frame's .ui-link.
 *
 *   static: the two tokens exist in the light block, the Jacaranda dark
 *   block, the neutral dark block and every gradient theme's block; the link
 *   rules draw from the tokens only; no <a> / link button in src carries a
 *   palette text colour (text-blue-600, text-purple-700, a hex) outside the
 *   allow-list;
 *
 *   render (Vite + Chromium, every theme the app offers: light, Jacaranda
 *   dark, the neutral dark and the five gradient themes): the links of
 *   Application Settings > About have the computed colour of the theme's
 *   resolved --link, and that colour reads at >= 4.5:1 on the modal surface.
 *
 * Screenshots (LINK_OUT, LINK_LABEL for the prefix). Never touches the user's
 * profile: the app runs on the Vite dev server against faked /api routes.
 *
 * Run: node tests/link-colour.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { COLOR_PROBE, parseCssColor, contrast, over } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
const css = read('src/index.css');
const block = (selector) => { const i = css.indexOf(`\n${selector} {`); if (i < 0) return ''; return css.slice(i, css.indexOf('\n}', i)); };
const tokensOf = (text) => Object.fromEntries(Array.from(text.matchAll(/(--[\w-]+):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
const themeSrc = read('src/contexts/ThemeContext.jsx');
const GRADIENTS = Array.from(themeSrc.matchAll(/^\s*'(gradient-[a-z-]+)':\s*\{/gm)).map((m) => m[1]);
check(`the app's theme list is known: light, dark, dark-neutral and ${GRADIENTS.length} gradient themes`, GRADIENTS.length >= 5, GRADIENTS.join(', '));
for (const [name, sel] of [['light', ':root'], ['dark (Jacaranda)', '.dark'], ['dark-neutral', '.dark[data-dark-variant="neutral"]']]) {
  const t = tokensOf(block(sel));
  check(`${name}: --link and --link-hover are defined in its block`, t['--link'] && t['--link-hover'], JSON.stringify({ link: t['--link'], hover: t['--link-hover'] }));
}
for (const id of GRADIENTS) {
  // the .dark prefix matters: the neutral dark block (.dark[data-dark-variant="neutral"]) sets --link too, and a plain
  // [data-theme] rule would lose to it (the browser part below confirms the colour that actually paints)
  const m = css.match(new RegExp(`\\.dark\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
  const t = m ? tokensOf(m[1]) : {};
  check(`${id}: --link and --link-hover are defined for the gradient theme (a light tint of its accent)`, t['--link'] && t['--link-hover'], m ? m[1].trim().slice(0, 120) : 'no block');
}
const linkRules = css.slice(css.indexOf('/* ==== Links'), css.indexOf('/* ==== End of links'));
check('the link rules (.link, .brand-link, .sc-btn-link) live in one place and draw from --link / --link-hover only', /\.brand-link/.test(linkRules) && /\.sc-btn-link/.test(linkRules) && /var\(--link\)/.test(linkRules) && /var\(--link-hover\)/.test(linkRules) && !/#[0-9a-f]{3,8}\b|rgb\(|text-/i.test(linkRules), linkRules.slice(0, 300));
check('.brand-link no longer paints the brand accent directly', !/\.brand-link\s*\{[^}]*--brand-accent/.test(css));
check("the primitives' link button carries no palette colour of its own (the colour is --link)", !/link:\s*`[^`]*text-(os-blue|blue|purple|violet)/.test(read('src/components/ui/primitives.jsx')));
check("the Diagnostics frame's .ui-link reads the bridged --link token", /\.ui-link\s*\{[^}]*var\(--link/.test(read('backend/static/styles.css')));
// no anchor / link button in src with a hard-coded link colour
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(jsx|js)$/.test(e.name)) out.push(p); } return out; };
const LINK_COLOUR = /text-(?:blue|purple|violet|indigo|sky)-\d{2,3}|text-\[#|color:\s*['"]?#?[0-9a-f]{3,8}['"]?/i;
const ALLOW = [/utils\/interactiveMarkdown\.js/, /StartupError\.jsx/];
const offenders = [];
for (const file of walk(path.join(REPO, 'src'))) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(REPO, file);
  for (const m of text.matchAll(/<(a|ExternalLink)\b[^>]*>/g)) {
    if (LINK_COLOUR.test(m[0]) && !ALLOW.some((a) => a.test(rel))) offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length} ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}
check(`no <a> / <ExternalLink> in src carries a hard-coded link colour (${offenders.length} found)`, offenders.length === 0, offenders.slice(0, 6).join('\n'));

// The corner radius tokens: a use without its fallback squares off wherever the token is missing (a render path
// without the Tailwind @theme block gave square buttons once), so every var(--radius-*) use carries one
{
  const bare = [];
  for (const [file, text] of [['src/index.css', css], ['backend/static/styles.css', read('backend/static/styles.css')]]) {
    text.split('\n').forEach((l, i) => { if (/^\s*--radius-[\w-]+:/.test(l)) return; const m = l.match(/var\(--radius-[\w-]+\)/g); if (m) bare.push(`${file}:${i + 1} ${m.join(' ')}`); });
  }
  check(`every var(--radius-*) use in the shared CSS carries its fallback (${bare.length} without)`, bare.length === 0, bare.slice(0, 8).join('\n'));
}

// ---------------------------------------------------------------------------
// Render: the About links in every theme
// ---------------------------------------------------------------------------
if (process.env.SKIP_BROWSER_TESTS) { console.log(`\n${failed ? 'FAILED' : 'All static checks passed'} (browser part skipped)`); process.exit(failed ? 1 : 0); }
const pw = req('playwright-core');
const PORT = Number(process.env.SMOKE_PORT || 5337);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
const OUT = process.env.LINK_OUT ? path.resolve(process.env.LINK_OUT) : null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const LABEL = process.env.LINK_LABEL || 'links';
const APP_THEMES = ['light', 'dark', 'dark-neutral', ...GRADIENTS];
for (const theme of APP_THEMES) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme === 'light' ? 'light' : 'dark' });
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', theme); } catch { /* storage off */ } }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.6', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' }); await sleep(1500);
  const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
  await clickButton('Got it!'); await sleep(300);   // the What's New dialog (its 'seen' key may lag the version) would otherwise sit over About
  await clickButton('Documents'); await sleep(800);
  const opened = await page.evaluate(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => /^documents$/i.test(e.textContent.trim())); const header = h && h.closest('div').parentElement; const b = header && Array.from(header.querySelectorAll('button')).find((x) => x.querySelector('svg.lucide-menu')); if (!b) return false; b.click(); return true; });
  if (opened) { await sleep(300); await clickButton('Settings'); await sleep(900); }
  const about = await clickButton('About'); await sleep(600);
  const look = await page.evaluate((probe) => {
    // the shared colour toolkit: the browser paints each colour and reads the pixel back, so oklch()/color() syntaxes resolve too
    const C = new Function('return ' + probe)();
    const rgb = (px) => (px ? 'rgb(' + px[0] + ', ' + px[1] + ', ' + px[2] + ')' : null);
    const links = Array.from(document.querySelectorAll('.brand-link')).filter((el) => el.offsetParent);
    if (!links.length) return { links: 0 };
    const el = links[0];
    const colour = rgb(C.parse(getComputedStyle(el).color));
    const surface = rgb(C.effectiveBg(el));
    const want = rgb(C.parse(getComputedStyle(document.documentElement).getPropertyValue('--link').trim()));
    return { links: links.length, colour, surface, want, theme: document.documentElement.getAttribute('data-theme'), texts: links.slice(0, 3).map((l) => l.textContent.trim()) };
  }, COLOR_PROBE);
  if (OUT) await page.screenshot({ path: path.join(OUT, `${LABEL}-${theme}-about.png`) });
  const radii = await page.evaluate(() => Array.from(document.querySelectorAll('button.btn, .btn')).filter((b) => b.offsetParent && b.getBoundingClientRect().height > 20).slice(0, 12).map((b) => ({ text: b.textContent.trim().slice(0, 20), r: getComputedStyle(b).borderRadius })));
  const want8 = radii.filter((x) => x.r !== '8px');
  check(`${theme}: every button on the page has the control radius of 8px (${radii.length} checked)`, radii.length > 0 && want8.length === 0, JSON.stringify(want8.slice(0, 5)));
  const got = parseCssColor(look.colour), want = parseCssColor(look.want), surface = parseCssColor(look.surface || 'rgb(255,255,255)');
  const cr = got && surface ? contrast(over(got, surface), surface) : 0;
  check(`${theme}: Application Settings > About shows its links (${look.links}) in the theme's --link (${look.want}) at >= 4.5:1 on the modal surface (${cr.toFixed(2)})`, about && look.links > 0 && got && want && [0, 1, 2].every((i) => Math.abs(got[i] - want[i]) <= 2) && cr >= 4.5, JSON.stringify(look));
  await context.close();
}
await stop();
console.log(`\n${failed ? 'FAILED' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
