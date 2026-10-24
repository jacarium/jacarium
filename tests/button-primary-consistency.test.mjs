/**
 * One primary button colour across the app and the Diagnostics frame, from
 * the --btn-* theme tokens (src/index.css, "Buttons: change the button
 * colours here"):
 *
 *   static: the token set exists in every theme block (light, Jacaranda
 *   dark, the neutral dark variant), the .btn-* classes draw from the tokens
 *   only, the Electron profile picker mirrors the light values, and no
 *   button in src/ or in the Diagnostics templates carries a colour literal
 *   (a Tailwind palette shade, a hex / rgb value) outside the allow-list;
 *
 *   render (Vite + Chromium, dark and light): the reference buttons (Save
 *   Settings, New Document) and the ones the user named (the Tools page, the
 *   JQL Builder's Fields / Import, a modal's Import, Kanban's Create Board,
 *   the Diagnostics Security & Certificates "Open TLS Secret Expiration")
 *   share one computed background, text colour, hover and disabled look,
 *   equal to the resolved --btn-primary-* tokens of that theme;
 *
 *   theme change: overriding --btn-primary-bg at runtime recolours the app's
 *   buttons AND a Diagnostics frame button without a reload (the bridge
 *   mirrors the inline custom properties), and a theme switch re-resolves
 *   both;
 *
 *   contrast (every theme the app offers: light, Jacaranda dark, the neutral
 *   dark and the gradient themes, which inherit the neutral block): every
 *   role class and its ghost / soft / selected forms rendered on each of the
 *   theme's surfaces (canvas, card, card-secondary, modal) reach 4.5:1 for
 *   their text at rest and under the pointer, and 3:1 for a border that is
 *   the role's signifier (the outlined danger button, the soft chips). The
 *   colours are read through tests/helpers/color.mjs, so oklch / color-mix
 *   values resolve like rgb ones.
 *
 * Screenshots of every place (BTN_OUT, BTN_LABEL for the file prefix, e.g.
 * before / after). Never touches the user's profile: the app runs on the
 * Vite dev server against faked /api routes and a faked backend.
 *
 * Run: node tests/button-primary-consistency.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { COLOR_PROBE } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---------------------------------------------------------------------------
// Static: the tokens, the classes, the picker, no colour literal on a button
// ---------------------------------------------------------------------------
const css = read('src/index.css');
const TOKENS = ['bg', 'bg-hover', 'bg-active', 'fg', 'border', 'ring', 'disabled-bg', 'disabled-fg'];
const ROLES = ['primary', 'secondary', 'danger', 'danger-solid', 'ghost'];
const block = (selector) => { const i = css.indexOf(`\n${selector} {`); if (i < 0) return ''; return css.slice(i, css.indexOf('\n}', i)); };
const tokensOf = (text) => Object.fromEntries(Array.from(text.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)).map((m) => [m[1], m[2].trim()]));
const THEMES = { light: tokensOf(block(':root')), dark: tokensOf(block('.dark')), neutral: tokensOf(block('.dark[data-dark-variant="neutral"]')) };
for (const [name, t] of Object.entries(THEMES)) {
  const missing = ROLES.flatMap((r) => TOKENS.map((k) => `--btn-${r}-${k}`)).filter((k) => !(k in t));
  check(`${name}: every button token is defined in its theme block (${ROLES.length} roles x ${TOKENS.length})`, missing.length === 0, missing.join(', '));
}
// The roles whose ghost / soft forms paint the role as TEXT on a surface carry a -text token (darker than the solid fill
// in the light theme, lighter in the dark ones), so a "Start" or "Stop" chip reads at 4.5:1 wherever it sits.
const TEXT_ROLES = ['success', 'warning', 'brand', 'selected'];
for (const [name, t] of Object.entries(THEMES)) {
  const missing = TEXT_ROLES.map((r) => `--btn-${r}-text`).filter((k) => !(k in t));
  check(`${name}: the -text token of every ghost / soft role is defined (${TEXT_ROLES.join(', ')}) and the selected state has its hover`, missing.length === 0 && '--btn-selected-bg-hover' in t, missing.join(', '));
}
// Every theme the app offers resolves to one of the three token blocks: light -> :root, Jacaranda -> .dark, the neutral
// dark and the five gradient themes -> .dark[data-dark-variant="neutral"] (ThemeContext sets that attribute for them).
// A theme that defined some --btn-* tokens of its own would have to define them all.
const themeSrc = read('src/contexts/ThemeContext.jsx');
const GRADIENTS = Array.from(themeSrc.matchAll(/^\s*'(gradient-[a-z-]+)':\s*\{/gm)).map((m) => m[1]);
const APP_THEMES = ['light', 'dark', 'dark-neutral', ...GRADIENTS];
check(`the app's theme list is known: light, dark, dark-neutral and ${GRADIENTS.length} gradient themes (${GRADIENTS.join(', ')})`, GRADIENTS.length >= 5);
check('the gradient themes and the neutral dark set data-dark-variant="neutral" (so they inherit the neutral token block)', /startsWith\('gradient-'\)/.test(themeSrc) && /setAttribute\('data-dark-variant', 'neutral'\)/.test(themeSrc));
{
  const partial = [];
  for (const id of APP_THEMES) {
    const re = new RegExp(`\\n[^{}\\n]*data-theme="${id}"[^{}\\n]*\\{([^}]*)\\}`, 'g');
    for (const m of css.matchAll(re)) {
      const own = Object.keys(tokensOf(m[1])).filter((k) => k.startsWith('--btn-'));
      if (own.length && own.length < ROLES.length * TOKENS.length) partial.push(`${id}: ${own.length} tokens`);
    }
  }
  check('no theme block overrides only a part of the button tokens', partial.length === 0, partial.join(', '));
}
check('the token block carries the "change the button colours here" note', /change the button colours here/i.test(css));
const btnRules = css.slice(css.indexOf('/* ==== Buttons (tests/button-primary-consistency.test.mjs) ===='), css.indexOf('/* ==== End of buttons'));
check('the .btn classes live in one place in src/index.css (the Buttons section) and draw from the tokens only (no colour literal)', btnRules.length > 200 && /\.btn-primary\s*\{/.test(btnRules) && /\.btn-secondary\s*\{/.test(btnRules) && /\.btn-danger\s*\{/.test(btnRules) && !/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i.test(btnRules), btnRules.match(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d[^)]*\)/gi)?.join(', '));
check('.btn-primary is defined once in the app stylesheet', (css.match(/^\.btn-primary\s*\{/gm) || []).length === 1);
{
  const picker = read('electron/profile-picker.html');
  const pk = Object.fromEntries(Array.from(picker.slice(0, picker.indexOf('</style>')).matchAll(/(--btn-primary-bg(?:-hover)?):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
  check('the Electron profile picker (no app stylesheet) mirrors the light --btn-primary-bg / -bg-hover values', pk['--btn-primary-bg'] && pk['--btn-primary-bg'].toUpperCase() === THEMES.light['--btn-primary-bg']?.toUpperCase() && pk['--btn-primary-bg-hover'] && pk['--btn-primary-bg-hover'].toUpperCase() === THEMES.light['--btn-primary-bg-hover']?.toUpperCase(), JSON.stringify({ picker: pk['--btn-primary-bg'], app: THEMES.light['--btn-primary-bg'] }));
}
// The scan: every <button>/<Button>/<a>/<label>/<IconButton> opening tag in src (the tag found by brace depth, since
// attributes hold arrow functions) and every bg-* literal in the Diagnostics templates
const PALETTE = 'blue|sky|indigo|cyan|red|green|emerald|amber|yellow|orange|purple|violet|pink|rose|fuchsia|teal|lime|gray|zinc|slate|neutral|stone';
const LITERAL = new RegExp(`(?:^|[\\s"'\`:])(?:hover:|focus:|active:|disabled:|dark:)*bg-(?:${PALETTE})-\\d{2,3}(?![/\\w-])|bg-\\[#|background(?:-color)?:\\s*['"]?(?:#|rgb|hsl)`, 'i');
const ALLOW = [
  // the quiz game modes colour their answer buttons by game mode on purpose (quiz = blue, others = brand): game-specific, not an action button
  /game-shared\/GameResults\.jsx/,
  // the game boards: a cell's colour is the game's state (selected, hit, revealed), not a button role
  /FloatingTiles\.jsx|LoadingGame\.jsx|TilesGameMode\.jsx:\d+ 'bg-purple-500/,
  // the startup error screen renders before any stylesheet is guaranteed: inline colours on purpose
  /StartupError\.jsx/,
  // the interactive markdown buttons are exported HTML (PDF / standalone preview) with no app stylesheet
  /utils\/interactiveMarkdown\.js/,
  // the editor's preview toggle: orange means "every document" (a deliberate signal colour, no token for it)
  /DocumentEditor\.jsx:\d+ 'bg-orange-500/,
];
const walk = (dir, exts, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, exts, out); } else if (exts.some((x) => p.endsWith(x))) out.push(p); } return out; };
const tagsIn = (text, names) => {
  const out = [];
  const re = new RegExp(`<(${names.join('|')})\\b`, 'g');
  let m;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index, quote = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
      if (depth > 0 && text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) break; continue; }   // a comment inside an attribute's braces
      if (depth > 0 && text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { if (depth > 0 || c !== '`') quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && text[i - 1] !== '=') break;
    }
    out.push({ start: m.index, text: text.slice(m.index, i + 1), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
};
{
  const offenders = [];
  for (const file of walk(path.join(REPO, 'src'), ['.jsx', '.js'])) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    for (const tag of tagsIn(text, ['button', 'Button', 'IconButton', 'a', 'label', 'summary'])) {
      const hit = tag.text.match(LITERAL);
      if (!hit) continue;
      const line = `${rel}:${tag.line} ${hit[0].trim()} ${tag.text.replace(/\s+/g, ' ').slice(0, 120)}`;
      if (!ALLOW.some((a) => a.test(line))) offenders.push(line);
    }
  }
  if (process.env.BTN_VERBOSE && process.env.BTN_VERBOSE !== '1') fs.writeFileSync(process.env.BTN_VERBOSE, offenders.join('\n') + '\n');   // the whole list, for a migration
  check(`no button in src/ carries a colour literal (a Tailwind palette shade or a hex / rgb background) outside the shared .btn classes and the allow-list (${offenders.length} found)`, offenders.length === 0, offenders.slice(0, process.env.BTN_VERBOSE ? 500 : 12).join('\n'));
}
{
  const offenders = [];
  const TPL_ALLOW = [/backend\/templates\/(index|layout)\.html/];   // the standalone Flask pages (not the frame): Tailwind CDN, no app stylesheet
  for (const file of walk(path.join(REPO, 'backend', 'templates'), ['.html'])) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    text.split('\n').forEach((l, i) => {
      if (/bg-(?:blue|sky|indigo)-\d{3}(?![/\w-])|bg-\[#/.test(l) && /<button|button\b|btn/i.test(l)) {
        const line = `${rel}:${i + 1} ${l.trim().slice(0, 140)}`;
        if (!TPL_ALLOW.some((a) => a.test(line))) offenders.push(line);
      }
    });
  }
  check(`no Diagnostics template paints a button with a blue palette literal (the frame draws every page button from the tokens) (${offenders.length} found)`, offenders.length === 0, offenders.slice(0, 12).join('\n'));
  const frameCss = read('backend/static/styles.css');
  check('the frame stylesheet paints the page buttons from the --btn-primary-* tokens (not --os-blue)', /button\.px-3\.py-1[\s\S]*?background-color:\s*var\(--btn-primary-bg/.test(frameCss) && !/button[^{]*\{[^}]*background-color:\s*var\(--os-blue\)/.test(frameCss));
}
{
  const prim = read('src/components/ui/primitives.jsx');
  check('<Button variant="primary"> and the other variants map to the shared .btn classes (no colour utility left in the BUTTON table)', /primary:\s*`sc-btn sc-btn-primary btn btn-primary/.test(prim) && !/BUTTON = \{[\s\S]*?\};/.exec(prim)?.[0].match(/bg-(blue|red|amber|green)-\d{3}/), (/BUTTON = \{[\s\S]*?\};/.exec(prim)?.[0] || '').match(/bg-(blue|red|amber|green)-\d{3}/g)?.join(','));
  const bridge = read('src/components/DiagnosticsPage.jsx');
  check('the theme bridge mirrors the inline custom properties of the app <html> into the frame and watches the style attribute', /vars:/.test(bridge) && /attributeFilter: \['class', 'data-theme', 'data-dark-variant', 'data-gradient', 'style'\]/.test(bridge) && /d\.vars/.test(bridge));
}

// ---------------------------------------------------------------------------
// Render: the real app in Chromium, dark and light
// ---------------------------------------------------------------------------
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const OUT = process.env.BTN_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'button-primary-'));
fs.mkdirSync(OUT, { recursive: true });
const LABEL = process.env.BTN_LABEL || 'after';
const MG_NAME = 'must-gather.local.1234567890';
let html = {}, tabs = [];
if (fs.existsSync(PYTHON)) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'button-primary-fixture-'));
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  const ren = gen.status === 0 ? spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', path.join(work, 'html'), '--fixture', path.join(work, MG_NAME), '--report-type', 'mustgather', '--tabs', 'security'], { encoding: 'utf8' }) : gen;
  check('the Security & Certificates page renders through Flask over the synthetic must-gather', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status === 0) { html = { security: fs.readFileSync(path.join(work, 'html', 'security.html'), 'utf8') }; tabs = JSON.parse(fs.readFileSync(path.join(work, 'html', 'tabs.json'), 'utf8')); }
}
const REPORT = { name: MG_NAME, path: '/tmp/button-primary/' + MG_NAME, type: 'mustgather', modified: 1760000000 };
const PORT = Number(process.env.SMOKE_PORT || 5333);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

async function open(theme) {
  // the theme key as ThemeContext stores it (a bare string: 'light', 'dark', 'dark-neutral', 'gradient-…')
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme === 'light' ? 'light' : 'dark' });
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', theme);
      localStorage.setItem('toolsOpenTabs', JSON.stringify(['uuid-generator']));
      localStorage.setItem('diagnosticsReportsDirectory', '/tmp/button-primary');
      localStorage.removeItem('diagnostics-page-session');
    } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.5', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [REPORT] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs, report_type: 'mustgather', directory: REPORT.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const key = body.sub_tab || body.tab; r.fulfill({ json: { html: html[key] || `<div class="panel rounded-lg shadow-sm"><p>${key} (not part of this test)</p></div>` } }); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t !== 'light'); }, theme);
  return { context, page, errors };
}
// The contrast matrix: every role class (and its ghost / soft / selected forms) rendered as a real .btn on each of the
// theme's surfaces (the page canvas, a card, the card-secondary surface, a modal); the text against the button's own
// background composited over the surface, at rest and under the pointer (the custom properties the :hover rule reads,
// resolved through a probe inside the button), and the border against the surface when the button draws one.
const ROLE_CLASSES = ['btn-primary', 'btn-secondary', 'btn-danger', 'btn-danger-ghost', 'btn-danger-solid', 'btn-danger-soft', 'btn-ghost', 'btn-warning', 'btn-warning-ghost',
  'btn-success', 'btn-success-ghost', 'btn-success-soft', 'btn-brand', 'btn-brand-ghost', 'btn-brand-soft', 'btn-quiet', 'btn-selected', 'btn-selected-soft'];
const SURFACES = ['--os-canvas', '--os-card', '--os-card-secondary', '--os-modal'];
// the roles whose border is the role's signifier (an outline, a soft chip's edge): 3:1 against the surface
const BORDER_ROLES = ['btn-danger', 'btn-success-soft', 'btn-brand-soft', 'btn-selected-soft'];
const contrastMatrix = (page) => page.evaluate(`(() => {
  const C = ${COLOR_PROBE};
  const HOVER = { 'btn-selected': ['var(--btn-selected-bg-hover)', 'var(--btn-selected-fg)'], 'btn-selected-soft': ['var(--btn-selected-tint-strong)', 'var(--btn-selected-text)'] };
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;'; document.body.appendChild(host);
  const out = [];
  for (const s of ${JSON.stringify(SURFACES)}) {
    const box = document.createElement('div'); box.style.cssText = 'padding:8px;background-color:var(' + s + ');'; host.appendChild(box);
    const surface = C.parse(getComputedStyle(box).backgroundColor) || [255, 255, 255, 1];
    for (const role of ${JSON.stringify(ROLE_CLASSES)}) {
      const b = document.createElement('button'); b.className = 'btn ' + role; b.textContent = 'Aa'; box.appendChild(b);
      const probe = document.createElement('span'); b.appendChild(probe);
      const cs = getComputedStyle(b);
      const bg = C.over(C.parse(cs.backgroundColor) || [0, 0, 0, 0], surface);
      const fg = C.parse(cs.color) || [0, 0, 0, 1];
      const text = +C.contrast(C.over(fg, bg), bg).toFixed(2);
      const [hb, hf] = HOVER[role] || ['var(--btn-bg-hover)', 'var(--btn-fg-hover, var(--btn-fg))'];
      probe.style.backgroundColor = hb; probe.style.color = hf;
      const ps = getComputedStyle(probe);
      const hbg = C.over(C.parse(ps.backgroundColor) || [0, 0, 0, 0], surface);
      const hfg = C.parse(ps.color) || fg;
      const hover = +C.contrast(C.over(hfg, hbg), hbg).toFixed(2);
      const bw = parseFloat(cs.borderTopWidth) || 0; const bc = C.parse(cs.borderTopColor);
      const border = bw > 0 && bc ? +C.contrast(C.over(bc, surface), surface).toFixed(2) : null;
      out.push({ role, surface: s.replace('--os-', ''), text, hover, border, fg: cs.color, bg: cs.backgroundColor, hoverBg: ps.backgroundColor });
    }
  }
  host.remove();
  return out;
})()`);
const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
// The computed look of a button, plus the theme's resolved tokens (through a probe element)
const LOOK = ['backgroundColor', 'color', 'borderTopColor', 'borderTopLeftRadius', 'fontWeight'];
const lookOf = (page, selectorOrText) => page.evaluate(({ sel, LOOK }) => {
  const find = () => { if (sel.startsWith('text=')) return Array.from(document.querySelectorAll('button, a, label')).find((el) => el.textContent.trim() === sel.slice(5) && el.offsetParent); return document.querySelector(sel); };
  const el = find(); if (!el) return null;
  const cs = getComputedStyle(el);
  return Object.assign(Object.fromEntries(LOOK.map((k) => [k, cs[k]])), { disabled: !!el.disabled, cls: el.className.toString().slice(0, 120) });
}, { sel: selectorOrText, LOOK });
const tokensResolved = (page) => page.evaluate((TOKENS) => {
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const out = {};
  for (const k of TOKENS) { probe.style.backgroundColor = ''; probe.style.backgroundColor = `var(--btn-primary-${k})`; out[k] = getComputedStyle(probe).backgroundColor; }
  probe.remove(); return out;
}, TOKENS);
const hoverLook = async (page, text) => {
  const h = await page.evaluateHandle((t) => Array.from(document.querySelectorAll('button, a, label')).find((el) => el.textContent.trim() === t && el.offsetParent), text);
  const el = h.asElement(); if (!el) return null;
  await el.hover(); await sleep(150);
  const look = await el.evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.mouse.move(0, 0); await sleep(100);
  return look;
};
async function shot(page, name, theme) { const file = path.join(OUT, `${LABEL}-${name}-${theme}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); }

try {
  // every theme: the tokens resolve, the matrix holds; the dark and light themes also get the page tour below
  for (const theme of APP_THEMES) {
    const { context, page, errors } = await open(theme);
    const applied = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), dark: document.documentElement.classList.contains('dark'), variant: document.documentElement.getAttribute('data-dark-variant') }));
    check(`${theme}: the app applies the theme (data-theme, the dark class, the neutral variant for the neutral dark and the gradients)`,
      applied.theme === theme && applied.dark === (theme !== 'light') && (applied.variant === 'neutral') === (theme === 'dark-neutral' || theme.startsWith('gradient-')), JSON.stringify(applied));
    const matrix = await contrastMatrix(page);
    const unresolved = matrix.filter((m) => !m.fg || m.bg === '' || /^rgba\(0, 0, 0, 0\)$/.test(m.fg));
    check(`${theme}: every role resolves its colours (${ROLE_CLASSES.length} roles x ${SURFACES.length} surfaces)`, matrix.length === ROLE_CLASSES.length * SURFACES.length && unresolved.length === 0, JSON.stringify(unresolved.slice(0, 4)));
    const lowText = matrix.filter((m) => m.text < 4.5).map((m) => `${m.role} on ${m.surface}: ${m.text} (${m.fg} on ${m.bg})`);
    check(`${theme}: every role's text reaches 4.5:1 on every surface (the ghost / soft forms against the surface they sit on)`, lowText.length === 0, lowText.join('; ').slice(0, 1200));
    const lowHover = matrix.filter((m) => m.hover < 4.5).map((m) => `${m.role} on ${m.surface}: ${m.hover} (hover ${m.hoverBg})`);
    check(`${theme}: every role's text reaches 4.5:1 under the pointer too`, lowHover.length === 0, lowHover.join('; ').slice(0, 1200));
    const lowBorder = matrix.filter((m) => BORDER_ROLES.includes(m.role) && m.border !== null && m.border < 3).map((m) => `${m.role} on ${m.surface}: ${m.border}`);
    check(`${theme}: an outlined role's border reaches 3:1 against the surface (${BORDER_ROLES.join(', ')})`, lowBorder.length === 0, lowBorder.join('; '));
    // the secondary button's hairline border is a design choice (the input border token), reported, not enforced
    const hairline = matrix.filter((m) => m.role === 'btn-secondary' && m.border !== null).map((m) => `${m.surface} ${m.border}`);
    console.log(`  INFO ${theme}: the secondary button's border against the surfaces: ${hairline.join(', ')}`);
    if (theme !== 'dark' && theme !== 'light') { check(`${theme}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300)); await context.close(); continue; }
    const tok = await tokensResolved(page);
    const found = {};
    // Documents: New Document (a reference)
    await clickButton(page, 'Documents'); await sleep(900);
    found.newDocument = await lookOf(page, 'text=New Document');
    found.newDocumentHover = await hoverLook(page, 'New Document');
    await shot(page, 'documents-new-document', theme);
    // Settings: Save Settings (the reference), through the Documents hamburger menu
    const opened = await page.evaluate(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => /^documents$/i.test(e.textContent.trim())); const header = h && h.closest('div').parentElement; const b = header && Array.from(header.querySelectorAll('button')).find((x) => x.querySelector('svg.lucide-menu')); if (!b) return false; b.click(); return true; });
    if (opened) { await sleep(300); await clickButton(page, 'Settings'); await sleep(900); }
    found.saveSettings = await lookOf(page, '[data-testid="settings-save"]');
    found.saveSettingsHover = await hoverLook(page, 'Save Settings');
    await shot(page, 'settings-save', theme);
    await page.keyboard.press('Escape'); await sleep(300); await clickButton(page, 'Cancel'); await sleep(400);
    // Tools: the UUID Generator's Generate
    await clickButton(page, 'Tools'); await sleep(1200);
    found.toolsGenerate = await lookOf(page, 'text=Generate UUID');
    found.toolsGenerateHover = await hoverLook(page, 'Generate UUID');
    // the disabled look: Generate UUID disabled for a moment
    const dis = await page.evaluate(({ LOOK }) => { const b = Array.from(document.querySelectorAll('button.btn-primary')).find((el) => el.offsetParent && !el.disabled); if (!b) return null; b.disabled = true; const cs = getComputedStyle(b); const out = Object.fromEntries(LOOK.map((k) => [k, cs[k]])); b.disabled = false; return out; }, { LOOK });
    await shot(page, 'tools-uuid', theme);
    // JQL Builder: Fields, Import, the disabled Save Template; the Import JQL modal's Import
    await clickButton(page, 'JQL Search'); await sleep(1200);
    found.jqlFields = await lookOf(page, 'button[title="Manage custom fields"]');
    found.jqlImport = await lookOf(page, 'button[title="Import JQL query"]');
    found.jqlSaveTemplate = await lookOf(page, 'button[title="Save current query as template"]');
    await shot(page, 'jql-builder', theme);
    await page.evaluate(() => { const b = document.querySelector('button[title="Import JQL query"]'); if (b) b.click(); }); await sleep(600);
    found.modalImport = await page.evaluate((LOOK) => { const h = Array.from(document.querySelectorAll('h2')).find((e) => /^Import JQL$/.test(e.textContent.trim())); const root = h && h.closest('[class*="fixed"], [role="dialog"]') || (h && h.parentElement.parentElement); const b = root && Array.from(root.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Import'); if (!b) return null; const cs = getComputedStyle(b); return Object.assign(Object.fromEntries(LOOK.map((k) => [k, cs[k]])), { disabled: b.disabled, cls: b.className.slice(0, 120) }); }, LOOK);
    await shot(page, 'modal-import-jql', theme);
    await page.keyboard.press('Escape'); await sleep(300); await clickButton(page, 'Cancel'); await sleep(300);
    // Kanban: Create Board (no boards)
    await clickButton(page, 'Kanban'); await sleep(1200);
    found.createBoard = await lookOf(page, 'text=Create Board');
    found.createBoardHover = await hoverLook(page, 'Create Board');
    await shot(page, 'kanban-create-board', theme);
    // Diagnostics: Security & Certificates in the frame
    let frame = null, frameLook = null;
    if (html.security) {
      await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics'); await sleep(600);
      await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (!b) return false; b.click(); return true; }, REPORT.name, { timeout: 20000 }).catch(() => {});
      await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Security & Certificates'), null, { timeout: 20000 }).catch(() => {});
      await page.evaluate(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Security & Certificates'); if (s) s.closest('div.cursor-pointer').click(); });
      for (let i = 0; i < 60 && !frame; i++) { for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { if (await f.evaluate(() => !!document.querySelector('button[onclick*="tls_secrets"]'))) frame = f; } catch { /* navigating */ } } if (!frame) await sleep(250); }
      if (frame) {
        await sleep(800);
        frameLook = await frame.evaluate((LOOK) => { const b = document.querySelector('button[onclick*="tls_secrets"]'); const cs = getComputedStyle(b); return Object.assign(Object.fromEntries(LOOK.map((k) => [k, cs[k]])), { text: b.textContent.trim(), cls: b.className }); }, LOOK);
        found.frameOpenTls = frameLook;
      }
      await shot(page, 'diagnostics-security', theme);
    }
    check(`${theme}: every listed button was found (New Document, Save Settings, Tools Generate UUID, JQL Fields / Import / Save Template, the Import JQL modal, Create Board, the frame's Open TLS Secret Expiration)`,
      ['newDocument', 'saveSettings', 'toolsGenerate', 'jqlFields', 'jqlImport', 'jqlSaveTemplate', 'modalImport', 'createBoard', 'frameOpenTls'].every((k) => found[k]), JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, !!v]))));
    // every button: the resolved tokens of the theme (a disabled one: the disabled pair), the same border, radius and weight
    const want = (b) => ({ backgroundColor: b.disabled ? tok['disabled-bg'] : tok.bg, color: b.disabled ? tok['disabled-fg'] : tok.fg, borderTopColor: tok.border, borderTopLeftRadius: found.newDocument && found.newDocument.borderTopLeftRadius, fontWeight: found.newDocument && found.newDocument.fontWeight });
    const diffs = Object.entries(found).filter(([k, v]) => v && typeof v === 'object' && !/Hover/.test(k)).filter(([, v]) => { const w = want(v); return LOOK.some((p) => v[p] !== w[p]); }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    check(`${theme}: every listed button (the app's pages, the modals, the Diagnostics frame) has the one primary look: background ${tok.bg} and text ${tok.fg} (the disabled pair when disabled), the same border, radius and weight; Save Settings is ${found.saveSettings && found.saveSettings.disabled ? 'disabled here (no server), so it shows the disabled pair' : 'enabled'}`,
      diffs.length === 0, JSON.stringify({ tok, diffs }).slice(0, 1400));
    const hovers = Object.entries(found).filter(([k, v]) => /Hover$/.test(k) && v && found[k.replace(/Hover$/, '')] && !found[k.replace(/Hover$/, '')].disabled);
    check(`${theme}: hover is one colour everywhere (${hovers.length} buttons hovered), the resolved --btn-primary-bg-hover (${tok['bg-hover']})`,
      hovers.length >= 3 && hovers.every(([, h]) => h === tok['bg-hover']), JSON.stringify({ hovers, tok }));
    check(`${theme}: a disabled primary shows the disabled tokens (${tok['disabled-bg']} / ${tok['disabled-fg']})`,
      dis && dis.backgroundColor === tok['disabled-bg'] && dis.color === tok['disabled-fg'], JSON.stringify({ dis, tok }));
    // Theme change at runtime: an inline override on the app's <html> reaches the app's buttons and the frame's
    if (frame) {
      const after = await page.evaluate(async () => {
        const primaries = Array.from(document.querySelectorAll('.btn-primary')).filter((el) => !el.disabled);
        const before = primaries.map((el) => getComputedStyle(el).backgroundColor);
        document.documentElement.style.setProperty('--btn-primary-bg', 'rgb(7, 8, 9)');
        await new Promise((r) => setTimeout(r, 400));
        const now = primaries.map((el) => getComputedStyle(el).backgroundColor);
        return { count: primaries.length, app: now.every((c) => c === 'rgb(7, 8, 9)') ? 'rgb(7, 8, 9)' : JSON.stringify({ before, now }) };
      });
      const inFrame = await frame.evaluate(() => getComputedStyle(document.querySelector('button[onclick*="tls_secrets"]')).backgroundColor);
      await page.evaluate(() => document.documentElement.style.removeProperty('--btn-primary-bg'));
      await sleep(400);
      const back = await frame.evaluate(() => getComputedStyle(document.querySelector('button[onclick*="tls_secrets"]')).backgroundColor);
      check(`${theme}: overriding --btn-primary-bg on the app's <html> at runtime recolours the app's primary buttons and the frame's page button without a reload, and removing it restores the theme value`,
        after.app === 'rgb(7, 8, 9)' && inFrame === 'rgb(7, 8, 9)' && back === tok.bg, JSON.stringify({ after, inFrame, back, tok: tok.bg }));
      // a theme switch: the other theme's token in both
      await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(600);
      const tok2 = await tokensResolved(page);
      const switched = await frame.evaluate(() => getComputedStyle(document.querySelector('button[onclick*="tls_secrets"]')).backgroundColor);
      const appSwitched = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.btn-primary')).find((el) => !el.disabled); return b ? getComputedStyle(b).backgroundColor : null; });
      check(`${theme}: after a theme switch the frame's button and the app's buttons show the new theme's --btn-primary-bg (${tok2.bg})`, switched === tok2.bg && (appSwitched === null || appSwitched === tok2.bg), JSON.stringify({ switched, appSwitched, tok2 }));
      await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(300);
    }
    check(`${theme}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
