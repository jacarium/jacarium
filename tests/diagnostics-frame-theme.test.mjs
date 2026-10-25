/**
 * The Diagnostics tab frames follow the app theme.
 *
 * The tab content is rendered from backend templates inside a sandboxed
 * srcdoc iframe (DiagnosticsPage.jsx). The frame inlines the app's
 * stylesheets, and the parent mirrors its theme onto the frame's <html>
 * (class "dark" plus data-theme / data-dark-variant / data-gradient), so
 * the os-* tokens resolve inside the frame exactly as outside. The template
 * cards (.panel) are the app's Card surface (bg-os-card, border-os-border,
 * the card radius), tables use the same divider colour and Chart.js text /
 * grid colours come from the tokens (window.diagnosticsThemeColor in the
 * frame); severity and series colours stay semantic.
 *
 * Real browser (Vite on :5173 + the Flask backend on :8080 + the synthetic
 * sosreport fixture, like tests/helpers/visual-snapshots.mjs): on the
 * Processes tab, for light, Jacaranda dark, neutral dark and a gradient
 * theme, the computed card background INSIDE the frame equals the app's
 * --os-card token, the table divider equals --os-border, the chart text
 * colour equals --os-text-primary, and the frame updated LIVE (no
 * reload). The frame reports those computed values to the parent after
 * every theme change (window.__diagnosticsFrameTheme, a read-only hook).
 *
 * Static: the diagnostics rules of src/index.css and backend/static/
 * styles.css carry no hard-coded colours, and no template picks chart
 * colours with a classList.contains('dark') ternary any more.
 *
 * SKIPS (exit 0) without Chrome, without backend/venv or when :5173/:8080
 * are busy. Run: node tests/diagnostics-frame-theme.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { startFlask, makeFixture, dismissWhatsNew, VITE_PORT } from './helpers/visual-snapshots.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---- static ----
{
  const css = read('src/index.css');
  const start = css.indexOf('/* Diagnostics content styling overrides for theme support */');
  const end = css.indexOf('/* Grid Buzzer Button Styles */', start);
  const block = start >= 0 && end > start ? css.slice(start, end) : '';
  const declarations = block.replace(/\[[^\]]*\]/g, '');   // attribute selectors such as [fill="#fff"] name what a template wrote, not a colour we apply
  check('src/index.css has the diagnostics block and it uses tokens, no hex colours', block.length > 500 && !/#[0-9a-fA-F]{3,8}\b/.test(declarations) && /var\(--os-card\)/.test(block) && /var\(--os-border\)/.test(block), (declarations.match(/#[0-9a-fA-F]{3,8}\b/g) || []).slice(0, 5).join(','));
  check('the .panel card is the Card surface: token background, token border, the card radius', /#diagnostics-content \.panel[\s\S]{0,400}var\(--os-card\)/.test(block) && /#diagnostics-content \.panel[\s\S]{0,400}var\(--radius-lg(, [^)]+)?\)/.test(block));   // the token may carry its px fallback (the frame's own stylesheet can load before the theme block)
  const backendCss = read('backend/static/styles.css');
  check('backend/static/styles.css uses the tokens too (no hex colours left)', !/#[0-9a-fA-F]{3,8}\b/.test(backendCss) && /var\(--os-/.test(backendCss), (backendCss.match(/#[0-9a-fA-F]{3,8}\b/g) || []).slice(0, 5).join(','));
  const dir = path.join(REPO, 'backend', 'templates', 'tabs');
  const ternaries = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/classList\.contains\('dark'\)\s*\?\s*'#|isDark(Mode)?\s*\?\s*'(#|rgba)/.test(src)) ternaries.push(f);
  }
  check('no template picks chart colours with a dark-class ternary (they ask diagnosticsThemeColor)', ternaries.length === 0, ternaries.join(', '));
  const page = read('src/components/DiagnosticsPage.jsx');
  check('DiagnosticsPage mirrors class + data-theme + data-dark-variant + data-gradient into the frame and watches all four', /attributeFilter: \['class', 'data-theme', 'data-dark-variant', 'data-gradient', 'style'\]/.test(page) && /diagnosticsThemeColor/.test(page) && /__diagnosticsThemeApplied/.test(page));
  check('the standalone Flask dashboard defines the same colour helper for the templates', /diagnosticsThemeColor/.test(read('backend/templates/layout.html')));
}

// ---- live ----
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'diag-frame-theme-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(failed ? 1 : 0); }
let backend = null;
try {
  backend = await startFlask();
  if (backend.skip) { console.log('SKIP: ' + backend.skip); process.exit(failed ? 1 : 0); }
  if (!(await makeFixture())) { console.log('SKIP: could not build the synthetic diagnostics fixture (python3 missing?)'); process.exit(failed ? 1 : 0); }
  await app.send('Network.enable');
  await app.send('Network.setExtraHTTPHeaders', { headers: { 'X-App-Token': backend.token } });
  await dismissWhatsNew(app);
  const ev = (s) => app.evaluate(s);
  const clickNav = (label) => ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  await ev(`localStorage.setItem('diagnosticsReportsDirectory', ${JSON.stringify(FIXTURE_ROOT)})`);
  await clickNav('Tools'); await sleep(500);
  await clickNav('Diagnostics');
  const opened = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(${JSON.stringify(FIXTURE_REPORT)})); if (!b) return false; b.click(); return true; })()`, 20000);
  check('the synthetic report opens in Diagnostics', opened);
  const labels = await app.waitFor(`(() => { const l = Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()); return l.length ? l : null; })()`, 20000) || [];
  check('the Processes tab is listed', labels.includes('Processes'), labels.join(','));
  await ev(`(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Processes'); s && s.closest('div.cursor-pointer').click(); })()`);
  const reported = await app.waitFor(`!!(window.__diagnosticsFrameTheme && window.__diagnosticsFrameTheme.panelBackground)`, 20000);
  check('the frame reports its computed theme to the parent once rendered (window.__diagnosticsFrameTheme)', reported, JSON.stringify(await ev('window.__diagnosticsFrameTheme')));

  // the parent's tokens as rgb (through a probe element, so hex and rgb compare alike)
  const tokens = () => ev(`(() => { const p = document.createElement('div'); document.body.appendChild(p); const rgb = (name) => { p.style.backgroundColor = ''; p.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); const c = getComputedStyle(p).backgroundColor; return c; }; const out = { card: rgb('--os-card'), border: rgb('--os-border'), textSecondary: rgb('--os-text-secondary'), textPrimary: rgb('--os-text-primary') }; p.remove(); return out; })()`);
  const VARIANTS = {
    light: { dark: false, theme: 'light', variant: null, gradient: null },
    jacaranda: { dark: true, theme: 'dark', variant: null, gradient: null },
    neutral: { dark: true, theme: 'dark-neutral', variant: 'neutral', gradient: null },
    nebula: { dark: true, theme: 'gradient-blue-purple', variant: 'neutral', gradient: 'blue-purple' },
  };
  const applyVariant = (v) => ev(`(() => { const h = document.documentElement; h.classList.${v.dark ? 'add' : 'remove'}('dark'); h.setAttribute('data-theme', ${JSON.stringify(v.theme)}); ${v.variant ? `h.setAttribute('data-dark-variant', ${JSON.stringify(v.variant)})` : "h.removeAttribute('data-dark-variant')"}; ${v.gradient ? `h.setAttribute('data-gradient', ${JSON.stringify(v.gradient)})` : "h.removeAttribute('data-gradient')"}; })()`);
  const loadsBefore = await ev('window.__diagnosticsFrameTheme.loads');
  const seen = new Set();
  for (const [name, v] of Object.entries(VARIANTS)) {
    await applyVariant(v);
    const ok = await app.waitFor(`(() => { const t = window.__diagnosticsFrameTheme; return !!t && t.theme && t.theme.dark === ${v.dark} && t.theme.theme === ${JSON.stringify(v.theme)} && t.theme.darkVariant === ${JSON.stringify(v.variant)} ? true : false; })()`, 8000);
    const frame = await ev('window.__diagnosticsFrameTheme');
    const parent = await tokens();
    check(`${name}: the frame applied the theme live (attributes mirrored, no reload)`, ok && frame.loads === loadsBefore, JSON.stringify({ frame: frame?.theme, loads: frame?.loads, loadsBefore }));
    check(`${name}: the card background inside the frame equals the app's --os-card (${parent.card})`, frame?.panelBackground === parent.card, `frame ${frame?.panelBackground}`);
    check(`${name}: the card border equals --os-border and the table divider too`, frame?.panelBorder === parent.border && frame?.tableDivider === parent.border, JSON.stringify({ panelBorder: frame?.panelBorder, tableDivider: frame?.tableDivider, border: parent.border }));
    check(`${name}: the card radius is the card radius (14px)`, frame?.panelRadius === '14px', frame?.panelRadius);
    check(`${name}: Chart.js text follows the theme (defaults.color = --os-text-primary, ticks too) and the grid is --os-border (${frame?.chart?.instances} charts)`, frame?.chart && frame.chart.defaultColor === parent.textPrimary && frame.chart.instances > 0 && frame.chart.tickColors.length > 0 && frame.chart.tickColors.every((c) => c === parent.textPrimary) && frame.chart.gridColors.every((c) => c === parent.border), JSON.stringify(frame?.chart));
    check(`${name}: the frame's body text colour is --os-text-primary`, frame?.textColor === parent.textPrimary, `${frame?.textColor} vs ${parent.textPrimary}`);
    seen.add(parent.card);
  }
  check('the four themes gave three distinct card colours (light, Jacaranda, neutral; the gradient dark shares the neutral surface)', seen.size === 3, [...seen].join(' | '));
  const pageErrors = app.errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await app.close();
  if (backend && backend.stop) await backend.stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
