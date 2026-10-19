#!/usr/bin/env node
/**
 * The Documents editor's "/" popup (DocumentEditor.jsx, src/utils/slashCommands.js):
 * one list of the built-in commands (the five callouts, Quick Workflow, Quick
 * AI, Quick Task) above the user's templates, and nothing fires on typing
 * alone.
 *
 * THE BUG: typing "/wf" opened Quick Workflow at once and "/ai" Quick AI,
 * so a path containing them could not be typed; the popup listed templates
 * only, and the callouts had no entry.
 *
 * Static (plain Node): the built-in list, the matcher (names, labels,
 * aliases), where a slash opens the popup (a word start, not inside a fence
 * or inline code), what closes it.
 * Live (headless Chromium, the real page):
 *   - "/note" + Enter inserts a Note callout; "/wf" + Enter opens Quick
 *     Workflow; "/wf" + Escape leaves "/wf" in the text, nothing opened;
 *   - "/usr/local/note" stays text with no popup at the end; "cd /tmp/ai" too;
 *   - no popup inside a ``` fence or inline code;
 *   - arrow keys move the highlight, a click runs an entry;
 *   - a template still inserts as before;
 *   - the phone: the popup works from the touch keyboard (the same input events).
 *
 * SKIPs like tests/mobile-ui.test.mjs. Run: node tests/slash-commands-ui.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.SLASH_UI_TEST_PORT || 5197);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static ----
{
  const { BUILTIN_COMMANDS, QUICK_COMMANDS, matchesSlashQuery, slashQueryAt, isInsideCode } = await import(path.join(REPO, 'src', 'utils', 'slashCommands.js'));
  check('the built-in list: the five callouts then Quick Workflow, Quick AI, Quick Task', BUILTIN_COMMANDS.map((c) => c.name).join() === '/note,/tip,/important,/warning,/caution,/wf,/ai,/task' && QUICK_COMMANDS.every((c) => c.action && c.builtin));
  check('the matcher: "wf" and "workflow" find Quick Workflow, "ai" Quick AI, "warn" the Warning callout, case-insensitive; "zzz" nothing', matchesSlashQuery(QUICK_COMMANDS[0], 'wf') && matchesSlashQuery(QUICK_COMMANDS[0], 'WorkFlow') && matchesSlashQuery(QUICK_COMMANDS[1], 'ai') && matchesSlashQuery(BUILTIN_COMMANDS[3], 'warn') && !BUILTIN_COMMANDS.some((c) => matchesSlashQuery(c, 'zzz')));
  check('a template matches on its name, description and tags as before', matchesSlashQuery({ name: 'Runbook', description: 'incident steps', tags: ['ops'] }, 'run') && matchesSlashQuery({ name: 'Runbook', description: 'incident steps', tags: ['ops'] }, 'ops') && !matchesSlashQuery({ name: 'Runbook' }, 'xyz'));
  check('a slash opens the popup at a line start or after whitespace, with the typed query', slashQueryAt('/') === '' && slashQueryAt('/no') === 'no' && slashQueryAt('text /wf') === 'wf' && slashQueryAt('line\n/ai') === 'ai');
  check('a second slash, a space, or a slash inside a word: no popup (/usr/local/note, cd /tmp/ai, a/b)', slashQueryAt('/usr/local/note') === null && slashQueryAt('cd /tmp/ai') === null && slashQueryAt('a/b') === null && slashQueryAt('/note ') === null);
  check('inside a ``` fence or inline code: no popup', slashQueryAt('```\n/note') === null && slashQueryAt('```bash\necho\n```\n/note') === 'note' && slashQueryAt('see `/wf') === null && slashQueryAt('see `/wf` then /ai') === 'ai' && isInsideCode('~~~\nx') && !isInsideCode('~~~\nx\n~~~\n'));
}

if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (SLASH_UI_TEST_PORT)`); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(failed ? 1 : 0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(failed ? 1 : 0); }

async function open(device) {
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.evaluate(async () => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear(); await db.documentTemplates.clear();
    const id = await db.documents.add({ title: 'Slash', content: '', category: 'General', stableId: 'sid-slash', createdAt: new Date(), updatedAt: new Date() });
    await db.documentTemplates.add({ syncId: 'tpl-runbook', name: 'Runbook', description: 'Incident runbook', category: 'Ops', tags: ['ops'], content: '# Runbook\n\nSteps.', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Slash', category: 'General', inCloud: false }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    localStorage.removeItem('app-theme');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(500); }
  return { context, page, errors };
}
const popup = (page) => page.evaluate(() => { const header = Array.from(document.querySelectorAll('.fixed span')).find((s) => /Commands and templates/.test(s.textContent)); if (!header) return null; const box = header.closest('.fixed'); return { entries: Array.from(box.querySelectorAll('[data-slash-entry]')).map((e) => ({ id: e.getAttribute('data-slash-entry'), selected: /bg-purple-100|dark:bg-purple-900\/30/.test(e.className) })), groups: Array.from(box.querySelectorAll('[data-slash-group]')).map((g) => g.getAttribute('data-slash-group')) }; });
const setText = (page, text) => page.locator('.sc-editor-textarea').evaluate((el, value) => { el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(el.value.length, el.value.length); }, text);
const value = (page) => page.locator('.sc-editor-textarea').inputValue();

try {
  const desk = await open({ viewport: { width: 1280, height: 900 } });
  const { page } = desk;
  const ta = page.locator('.sc-editor-textarea');
  check('the editor is open with an empty document', await ta.count() === 1);

  // /note + Enter
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/note'); await page.waitForTimeout(400);
  let p = await popup(page);
  check('typing "/note" opens the popup with the Note callout highlighted in the BUILT-IN group (no templates match)', !!p && p.groups[0] === 'builtin' && p.entries.length === 1 && p.entries[0].id === 'callout-note' && p.entries[0].selected, JSON.stringify(p));
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  check('Enter inserts the Note callout in place of the command', (await value(page)) === '> [!NOTE]\n> ' && !(await popup(page)), JSON.stringify(await value(page)));

  // "/" alone: everything, grouped
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/'); await page.waitForTimeout(400);
  p = await popup(page);
  check('"/" alone lists the eight built-ins first and the Runbook template under TEMPLATES', !!p && p.groups.join() === 'builtin,templates' && p.entries.length === 9 && p.entries[8].id !== 'callout-note' && p.entries.slice(0, 8).every((e) => /^callout-|^quick-/.test(e.id)), JSON.stringify(p));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200);
  p = await popup(page);
  check('arrow keys move the highlight (two down: Important)', p.entries.findIndex((e) => e.selected) === 2 && p.entries[2].id === 'callout-important', JSON.stringify(p.entries.map((e) => e.selected)));
  await page.locator('[data-slash-entry="tpl-runbook"], [data-slash-entry]').last().click(); await page.waitForTimeout(300);
  check('a click runs an entry: the Runbook template is inserted as before', /^# Runbook\n\nSteps\.$/.test(await value(page)), JSON.stringify(await value(page)));

  // /wf + Enter opens Quick Workflow; /wf + Escape leaves the text
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/wf'); await page.waitForTimeout(400);
  p = await popup(page);
  check('typing "/wf" opens the popup with Quick Workflow (not the panel)', !!p && p.entries.length === 1 && p.entries[0].id === 'quick-workflow' && !(await page.getByText('Quick Workflow', { exact: true }).filter({ hasNot: page.locator('[data-slash-entry]') }).count()), JSON.stringify(p));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check('Escape closes the popup and leaves "/wf" in the text, nothing opened', !(await popup(page)) && (await value(page)) === '/wf' && !(await page.locator('text=Run a workflow').count()), JSON.stringify(await value(page)));
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/wf'); await page.waitForTimeout(400);
  await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  const wfOpen = await page.evaluate(() => Array.from(document.querySelectorAll('span')).some((s) => s.textContent.trim() === 'Quick Workflow' && !s.closest('[data-slash-entry]')));
  check('Enter on Quick Workflow opens the Quick Workflow panel; the typed "/wf" stays until its result replaces it', wfOpen && (await value(page)) === '/wf' && !(await popup(page)), JSON.stringify({ wfOpen, text: await value(page) }));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  // paths stay text
  for (const text of ['/usr/local/note', 'cd /tmp/ai', 'see /etc/wf-config']) {
    await setText(page, ''); await ta.focus(); await page.keyboard.type(text); await page.waitForTimeout(400);
    check(`"${text}" stays text with no popup at the end`, !(await popup(page)) && (await value(page)) === text, JSON.stringify({ popup: await popup(page), text: await value(page) }));
  }
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/note '); await page.waitForTimeout(300);
  check('a space after the command closes the popup', !(await popup(page)) && (await value(page)) === '/note ');
  await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  check('...and Enter is then a plain newline', (await value(page)) === '/note \n');
  await setText(page, ''); await ta.focus(); await page.keyboard.type('/zzz'); await page.waitForTimeout(300);
  check('a query nothing matches shows no popup', !(await popup(page)) && (await value(page)) === '/zzz');

  // no popup inside code
  await setText(page, '```bash\n'); await ta.focus(); await page.keyboard.type('/note'); await page.waitForTimeout(300);
  check('inside a ``` fence "/note" is code: no popup', !(await popup(page)) && (await value(page)) === '```bash\n/note');
  await setText(page, 'run `'); await ta.focus(); await page.keyboard.type('/wf'); await page.waitForTimeout(300);
  check('inside inline code "/wf" is text: no popup', !(await popup(page)) && (await value(page)) === 'run `/wf');
  check('desktop: no page errors', desk.errors.length === 0, desk.errors.slice(0, 3).join(' | '));
  await desk.context.close();

  // the phone: the same from the touch keyboard
  const phone = await open(pw.devices['iPhone 14 Pro']);
  const pta = phone.page.locator('.sc-editor-textarea');
  check('phone: the editor is open', await pta.count() === 1);
  await setText(phone.page, ''); await pta.tap(); await phone.page.keyboard.type('/tip'); await phone.page.waitForTimeout(500);
  const pp = await popup(phone.page);
  check('phone: typing "/tip" opens the popup with the Tip callout', !!pp && pp.entries.length === 1 && pp.entries[0].id === 'callout-tip', JSON.stringify(pp));
  await phone.page.locator('[data-slash-entry="callout-tip"]').tap(); await phone.page.waitForTimeout(400);
  check('phone: a tap on the entry inserts the Tip callout', (await value(phone.page)) === '> [!TIP]\n> ', JSON.stringify(await value(phone.page)));
  check('phone: no page errors', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  await phone.context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
