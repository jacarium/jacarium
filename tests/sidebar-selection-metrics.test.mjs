#!/usr/bin/env node
/**
 * Selecting a sidebar row changes colour and background only: the label
 * keeps the same font, size, weight and line-height, so the row's height
 * and the text's top / baseline do not move. Measured in Chromium
 * (playwright-core, fonts loaded) on the REAL lists - the Documents sidebar
 * (main shell), the Kanban board list, the Tasks instance list, the
 * Workflow list and the Tools sidebar - in both themes: the same row is
 * measured unselected and selected (and a neighbour the other way round),
 * and every metric must be identical.
 *
 * THE BUG: the selected label carried `font-medium`; the heavier weight
 * changes the glyph metrics (visibly so with Linux font hinting), so the
 * text shifted and the row could change height on selection.
 *
 * Also saves zoomed crops of the two rows (2x) per page and theme - set
 * SIDEBAR_SHOTS_DIR to keep them. The lists are seeded through each page's
 * "Import from JSON" dialog (the Tools list has its rows built in).
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/sidebar-selection-metrics.test.mjs
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
const OUT = process.env.SIDEBAR_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-selection-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5292);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

const fixture = (rel) => path.join(REPO, 'tests', 'fixtures', rel);
const PAGES = [
  { key: 'documents', url: '/', importLabel: 'Import Documents', fixture: fixture('documents-import/valid-documents.json'), menuTitle: 'Menu' },
  { key: 'kanban', url: '/?standalone=kanban', importLabel: 'Import Boards', fixture: fixture('import-json/boards.json'), menuTitle: 'Menu' },
  { key: 'tasks', url: '/?standalone=tasks', importLabel: 'Import Instances', fixture: fixture('import-json/instances.json'), menuTitle: 'Menu' },
  { key: 'workflows', url: '/?standalone=workflow', importLabel: 'Import Workflows', fixture: fixture('import-json/workflows.json'), menuTitle: 'Workflow menu' },
  { key: 'tools', url: '/?standalone=tools' },
];

async function routes(context) {
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
}

async function open(theme, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', JSON.stringify(theme));
      localStorage.setItem('expandedDocumentCategories', JSON.stringify(['Runbooks', 'Notes']));
      localStorage.setItem('expandedKanbanCategories', JSON.stringify(['Work', 'Home']));
      localStorage.setItem('expandedTaskInstanceCategories', JSON.stringify(['Work', 'Home']));
      localStorage.setItem('expandedWorkflowCategories', JSON.stringify(['Ops', 'General']));
      localStorage.setItem('expandedToolCategories', JSON.stringify(['Security', 'Networking', 'Format']));
    } catch { /* ignore */ }
  }, { theme });
  await routes(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + url, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (url === '/') { const rail = page.locator('button[title="Documents"]'); if (await rail.count()) { await rail.first().click().catch(() => {}); await page.waitForTimeout(600); } }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function seed(page, spec) {
  if (!spec.fixture) return;
  await page.locator(`button[title="${spec.menuTitle}"]`).first().click();
  await page.getByText('Import from JSON', { exact: true }).first().click();
  await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="import-json-input"]').fill(fs.readFileSync(spec.fixture, 'utf8'));
  await page.getByRole('button', { name: spec.importLabel, exact: true }).click();
  await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  if (spec.key === 'documents') {
    await page.getByText('Import Complete', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await page.waitForTimeout(800);
}

/** The first two sidebar item rows (.sc-row) with a label, as [row index, label text]. */
// (category headers are .sc-row too: skipped by their chevron)
const rowsInfo = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.sc-row'))
  .filter((el) => !el.querySelector('svg.lucide-chevron-down, svg.lucide-chevron-right, svg.lucide-chevron-up'))
  .map((el, i) => ({ i, text: (el.querySelector('span.text-sm, h3, .truncate') || el).textContent.trim(), visible: el.getClientRects().length > 0 }))
  .filter((r) => r.visible && r.text).slice(0, 2));

/** Every metric that must not change on selection, for row `i` of the .sc-row list. */
const METRIC = (text) => {
  const row = Array.from(document.querySelectorAll('.sc-row')).find((el) => (el.querySelector('span.text-sm, h3, .truncate') || el).textContent.trim() === text);
  const label = row.querySelector('span.text-sm, h3, .truncate') || row;
  const icon = row.querySelector('svg');
  const r = row.getBoundingClientRect(); const l = label.getBoundingClientRect(); const ic = icon && icon.getBoundingClientRect();
  const cs = getComputedStyle(label); const rs = getComputedStyle(row);
  const range = document.createRange(); range.selectNodeContents(label); const tr = range.getClientRects()[0] || l;
  const round = (v) => Math.round(v * 100) / 100;
  return {
    rowHeight: round(r.height), labelTop: round(l.top - r.top), labelHeight: round(l.height), labelLeft: round(l.left - r.left),
    textTop: round(tr.top - r.top), textHeight: round(tr.height), iconTop: ic ? round(ic.top - r.top) : null, iconLeft: ic ? round(ic.left - r.left) : null,
    fontWeight: cs.fontWeight, fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontFamily: cs.fontFamily, letterSpacing: cs.letterSpacing,
    padding: [rs.paddingTop, rs.paddingRight, rs.paddingBottom, rs.paddingLeft].join(' '), border: [rs.borderTopWidth, rs.borderRightWidth, rs.borderBottomWidth, rs.borderLeftWidth].join(' '),
    outline: rs.outlineWidth, color: cs.color, background: rs.backgroundColor,
  };
};
const measure = (page, text) => page.evaluate(METRIC, text);
const STABLE = ['rowHeight', 'labelTop', 'labelHeight', 'labelLeft', 'textTop', 'textHeight', 'iconTop', 'iconLeft', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily', 'letterSpacing', 'padding', 'border', 'outline'];
const diff = (a, b) => STABLE.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${a[k]} -> ${b[k]}`);

async function crop(page, text, file) {
  const rect = await page.evaluate((text) => { const r = Array.from(document.querySelectorAll('.sc-row')).find((el) => (el.querySelector('span.text-sm, h3, .truncate') || el).textContent.trim() === text).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, text);
  await page.screenshot({ path: file, clip: { x: Math.max(0, rect.x - 4), y: Math.max(0, rect.y - 4), width: rect.width + 8, height: rect.height + 8 } });
}

try {
  for (const spec of PAGES) {
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, spec.url);
      const t = (s) => `${spec.key} ${theme}: ${s}`;
      try {
        await seed(page, spec);
        const rows = await rowsInfo(page);
        check(t('two sidebar rows to compare'), rows.length === 2, JSON.stringify(rows));
        if (rows.length < 2) continue;
        const [a, b] = rows;
        const click = (text) => page.evaluate((text) => Array.from(document.querySelectorAll('.sc-row')).find((el) => (el.querySelector('span.text-sm, h3, .truncate') || el).textContent.trim() === text).click(), text);
        // select B first so A is measured unselected, then select A (rows are found by their label: a click may re-render the list)
        await click(b.text); await page.waitForTimeout(500);
        const aOff = await measure(page, a.text); const bOn = await measure(page, b.text);
        await crop(page, a.text, path.join(OUT, `${spec.key}-${theme}-rowA-unselected.png`));
        await crop(page, b.text, path.join(OUT, `${spec.key}-${theme}-rowB-selected.png`));
        await click(a.text); await page.waitForTimeout(500);
        const aOn = await measure(page, a.text); const bOff = await measure(page, b.text);
        await crop(page, a.text, path.join(OUT, `${spec.key}-${theme}-rowA-selected.png`));
        await crop(page, b.text, path.join(OUT, `${spec.key}-${theme}-rowB-unselected.png`));
        check(t(`selecting "${a.text}" changes its colour / background`), aOn.color !== aOff.color || aOn.background !== aOff.background, JSON.stringify({ off: [aOff.color, aOff.background], on: [aOn.color, aOn.background] }));
        check(t(`"${a.text}": height, label top/height, text top/baseline, icon, font (weight/size/line-height), padding and borders are identical selected vs unselected`), diff(aOff, aOn).length === 0, diff(aOff, aOn).join('; '));
        check(t(`"${b.text}": the same, the other way round`), diff(bOn, bOff).length === 0, diff(bOn, bOff).join('; '));
        check(t('the selected weight equals the unselected weight'), aOn.fontWeight === aOff.fontWeight && bOn.fontWeight === bOff.fontWeight, `${aOff.fontWeight} / ${aOn.fontWeight}`);
        console.log(`  crops: ${OUT}/${spec.key}-${theme}-row{A,B}-{selected,unselected}.png`);
      } finally {
        await context.close();
      }
    }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
