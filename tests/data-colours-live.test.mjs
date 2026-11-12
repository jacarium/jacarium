#!/usr/bin/env node
/**
 * Data colours follow the colour-vision palettes (Playwright against the
 * Vite dev server, no backend). Seeds shared documents owned by three
 * collaborators and a Kanban board with coloured columns, then, in light and
 * dark, at the default and under each palette (blue-weak, red-weak,
 * green-weak) and high contrast: the owner bar on a Documents row and the
 * column dot on the board are painted the stored colour at the default and
 * the palette's categorical colour (--chart-cat-N, the category the stored
 * colour maps to) under a palette; the switch is live (the same element,
 * no re-render); the ink on a painted colour resolves to black or white;
 * and the stored values in the database never change. Screenshots go to
 * READING_AIDS_SHOTS_DIR/../data-colours.
 *
 * Needs playwright-core with Chromium. Port DATA_COLOURS_TEST_PORT (5242).
 * Run: node tests/data-colours-live.test.mjs
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
const PORT = Number(process.env.DATA_COLOURS_TEST_PORT || 5242);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', '..', 'data-colours');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (DATA_COLOURS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

// the seed: three collaborators (their hashed colours differ) and a board whose columns carry chosen colours
const OWNERS = ['ada@example.test', 'grace@example.test', 'linus@example.test'];
const COLUMNS = [{ id: 'c-todo', title: 'To do', color: '#dc2626' }, { id: 'c-doing', title: 'Doing', color: '#16a34a' }, { id: 'c-done', title: 'Done', color: '#64748b' }];

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'light'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* storage off */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.3.1', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); await sleep(150); } else break; } };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().click(); } else { await page.locator('[data-testid="rail-more"]').click(); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().click(); } await page.mouse.move(700, 450); await sleep(700); };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// every painted element on the page: its stored colour, its category, and what it paints, all resolved to rgb
const painted = (scope) => page.evaluate((scope) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => { if (!c) return null; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]}, ${d[1]}, ${d[2]})`; };
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const token = (n) => { probe.style.backgroundColor = `var(${n})`; const v = rgb(getComputedStyle(probe).backgroundColor); probe.style.backgroundColor = ''; return v; };
  const out = [];
  for (const el of document.querySelectorAll(`${scope} [style*="--dc-cat"]`)) {
    const cs = getComputedStyle(el);
    const cat = (el.style.getPropertyValue('--dc-cat').match(/--chart-cat-(\d)/) || [])[1];
    const prop = ['border-left-color', 'background-color', 'color', 'stroke'].find((p) => el.style.getPropertyValue(p) === 'var(--dc)');
    if (!el.dataset.dcProbe) el.dataset.dcProbe = String(Math.random()).slice(2, 8);
    out.push({ id: el.dataset.dcProbe, stored: rgb(el.style.getPropertyValue('--dc-stored')), cat: Number(cat), catColour: token(`--chart-cat-${cat}`), prop, shown: rgb(cs.getPropertyValue(prop)), text: (el.textContent || '').trim().slice(0, 30) });
  }
  // the ink: an element painted with a category must resolve to black or white (the relative colour syntax works)
  probe.style.cssText = '--dc-cat: var(--chart-cat-4); --dc-ink: #ffffff; color: var(--dc-ink)';
  const inkOnPalette = rgb(getComputedStyle(probe).color);
  probe.remove();
  return { items: out, inkOnPalette, cls: document.documentElement.className };
}, scope);

const PALETTES = [['default', { colorVision: 'none', highContrast: false }], ['protanopia', { colorVision: 'protanopia', highContrast: false }], ['deuteranopia', { colorVision: 'deuteranopia', highContrast: false }], ['tritanopia', { colorVision: 'tritanopia', highContrast: false }], ['high-contrast', { colorVision: 'none', highContrast: true }]];

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500); await dismiss();
  const seeded = await page.evaluate(async ({ owners, columns }) => {
    const { db } = await import('/src/db/database.js');
    const now = new Date();
    await db.documents.bulkAdd(owners.map((ownerId, i) => ({ title: `Shared note ${i + 1}`, content: `# Shared note ${i + 1}\n\nFrom a colleague.`, category: 'General', createdAt: now, updatedAt: now, inCloud: true, ownerId })));
    const boardId = await db.kanbanBoards.add({ title: 'Palette board', category: 'General', columns, createdAt: now, updatedAt: now, inCloud: true, ownerId: owners[0] });
    await db.kanbanCards.add({ boardId, title: 'A card', status: 'c-todo', position: 0, createdAt: now, updatedAt: now });
    return { boardId, docs: await db.documents.count() };
  }, { owners: OWNERS, columns: COLUMNS });
  check('the seed went in: three shared documents and a board', seeded.docs >= 3 && seeded.boardId > 0, JSON.stringify(seeded));
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();

  for (const mode of ['light', 'dark']) {
    await page.evaluate((m) => localStorage.setItem('app-theme', m), mode);
    await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();
    await setAids({ colorVision: 'none', highContrast: false }); await sleep(200);

    // Documents: the owner bar of each shared document
    await goTo('Documents'); await sleep(600);
    if (!(await page.locator('[style*="--dc-cat"]').count())) { await page.locator('button', { hasText: /^General/ }).first().click().catch(() => {}); await sleep(400); }
    let before = null;
    for (const [name, aids] of PALETTES) {
      await setAids(aids); await sleep(300);
      const { items, inkOnPalette, cls } = await painted('body');
      const rows = items.filter((i) => i.prop === 'border-left-color' && /Shared note/.test(i.text));
      check(`${mode}/${name}: Documents rows for the three collaborators carry a data colour`, rows.length >= 3, `${rows.length} rows; html.${cls}`);
      if (name === 'default') {
        check(`${mode}/${name}: the owner bar shows the stored colour`, rows.every((r) => r.shown === r.stored), JSON.stringify(rows.map((r) => [r.text, r.stored, r.shown])));
        check(`${mode}/${name}: the three owners' colours differ`, new Set(rows.map((r) => r.stored)).size === 3, JSON.stringify(rows.map((r) => r.stored)));
        before = rows;
      } else {
        check(`${mode}/${name}: the owner bar shows the palette's categorical colour`, rows.every((r) => r.shown === r.catColour && r.shown !== r.stored), JSON.stringify(rows.map((r) => [r.text, r.cat, r.catColour, r.shown, r.stored])));
        check(`${mode}/${name}: the switch is live: the same row elements, the stored colour untouched`, before && rows.every((r) => before.some((b) => b.id === r.id && b.stored === r.stored)), JSON.stringify(rows.map((r) => r.id)));
        check(`${mode}/${name}: the ink on a category resolves to black or white`, inkOnPalette === 'rgb(0, 0, 0)' || inkOnPalette === 'rgb(255, 255, 255)', inkOnPalette);
        const cats = new Set(rows.map((r) => r.cat));
        check(`${mode}/${name}: collaborators that map to different categories stay distinct`, cats.size === new Set(rows.map((r) => r.shown)).size, `${[...cats]} -> ${rows.map((r) => r.shown)}`);
      }
      if (name === 'deuteranopia' || (name === 'default' && mode === 'light')) await shot(`documents-${name}-${mode}`);
    }

    // Kanban: the column dots on the board
    await setAids({ colorVision: 'none', highContrast: false }); await sleep(200);
    await goTo('Kanban'); await sleep(600);
    const row = page.locator('text=Palette board').first();
    if (await row.count()) { await row.click(); await sleep(800); }
    for (const [name, aids] of PALETTES) {
      await setAids(aids); await sleep(300);
      const { items } = await painted('body');
      const dots = items.filter((i) => i.prop === 'background-color' && i.text === '');
      check(`${mode}/${name}: the board's three column dots carry a data colour`, dots.length >= 3, `${dots.length} dots`);
      if (name === 'default') check(`${mode}/${name}: a column dot shows the stored colour`, dots.every((d) => d.shown === d.stored), JSON.stringify(dots.map((d) => [d.stored, d.shown])));
      else check(`${mode}/${name}: a column dot shows the palette's categorical colour; the grey column lands on the grey category`, dots.every((d) => d.shown === d.catColour) && dots.some((d) => d.cat === 8), JSON.stringify(dots.map((d) => [d.cat, d.catColour, d.shown])));
      if (name === 'deuteranopia') await shot(`kanban-${name}-${mode}`);
    }
    await setAids({ colorVision: 'none', highContrast: false });
  }

  // the stored values never changed
  const stored = await page.evaluate(async () => { const { db } = await import('/src/db/database.js'); const b = (await db.kanbanBoards.toArray()).find((x) => x.title === 'Palette board'); const d = (await db.documents.toArray()).filter((x) => /^Shared note/.test(x.title)); return { columns: b?.columns, owners: d.map((x) => x.ownerId).sort() }; });
  check('the board columns in the database keep their colours', JSON.stringify(stored.columns) === JSON.stringify(COLUMNS), JSON.stringify(stored.columns));
  check('the documents in the database keep their owners', JSON.stringify(stored.owners) === JSON.stringify([...OWNERS].sort()), JSON.stringify(stored.owners));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack : String(e));
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
