#!/usr/bin/env node
/**
 * Workflow Builder: "New Workflow" opens the new workflow in a tab (src/hooks/useWorkflowSession.js).
 *
 * THE BUG: handleNewWorkflow() queued the tab (openInTab -> setOpenTabs) and then awaited loadWorkflows(),
 * which rebuilt the tab list from openTabsRef.current - a ref an effect writes AFTER a render. When
 * getWorkflows() came back before React had rendered, the ref still held the previous (empty) list and
 * loadWorkflows() replaced the tabs with it: the workflow was created in the database, but no tab opened and
 * the empty state stayed. A timing race: Dexie 4.3's IndexedDB read was slow enough to lose it almost always,
 * Dexie 4.4's fast enough to win it every time (the 3.4.9 dependency batch made it visible in every theme of
 * tests/pages-visual-audit.test.mjs). loadWorkflows() now prunes through the setOpenTabs updater, which sees
 * the queued state.
 *
 * Live (headless Chromium, the real page, no backend): open the Workflow Builder, click "New Workflow", a tab
 * with the new workflow and the canvas must appear; the duplicate action's path is the same code.
 * Static: loadWorkflows() prunes through the updater form, never from openTabsRef.
 *
 * SKIPs like tests/mobile-ui.test.mjs. Run: node tests/workflow-new-tab.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchDocumentsApp, sleep, REPO } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

// --- static -----------------------------------------------------------------
const hook = fs.readFileSync(path.join(REPO, 'src', 'hooks', 'useWorkflowSession.js'), 'utf8');
const body = hook.slice(hook.indexOf('async function loadWorkflows'), hook.indexOf('function loadWorkflowIntoEditor'));
check('loadWorkflows() prunes the tabs through the setOpenTabs updater (sees the queued state)', /setOpenTabs\(\s*tabs\s*=>/.test(body), body.slice(0, 200));
check('...and no longer reads openTabsRef.current for it', !/openTabsRef\.current/.test(body));

// --- live -------------------------------------------------------------------
const port = Number(process.env.SMOKE_PORT || 5289);
const app = await launchDocumentsApp({ port, profilePrefix: 'workflow-new-tab-' });
if (app.skip) {
  console.log('SKIP: ' + app.skip);
  console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
  process.exit(failed ? 1 : 0);
}
const ev = (s) => app.evaluate(s);
const tabs = () => ev(`Array.from(document.querySelectorAll('.sc-tab-strip > *')).map((e) => e.textContent.trim()).filter((t) => /[A-Za-z]{2,}/.test(t))`);
try {
  await dismissWhatsNew(app);
  const nav = await ev(`(() => { const b = Array.from(document.querySelectorAll('nav button')).find((el) => el.textContent.trim() === 'Workflow Builder'); if (!b) return false; b.click(); return true; })()`);
  await sleep(1500);
  check('the Workflow Builder opens from the rail', nav);
  check('it starts on the empty state with no tab', (await tabs()).length === 0 && await ev(`!!Array.from(document.querySelectorAll('*')).find((e) => e.textContent === 'No Workflow Selected')`));
  const clicked = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Workflow'); if (!b) return false; b.click(); return true; })()`);
  check('the empty state offers "New Workflow"', clicked);
  const opened = await app.waitFor(`document.querySelectorAll('.sc-tab-strip > *').length > 0 && !!document.querySelector('.react-flow')`, 5000);
  const titles = await tabs();
  check('a tab for the new workflow opens and the canvas shows (the created workflow is not lost to the tab pruning)', !!opened && titles.some((t) => /Untitled Workflow/.test(t)), JSON.stringify(titles));
  check('the workflow was stored once', (await ev(`(() => new Promise((resolve) => { const r = indexedDB.open('Jacarium'); r.onsuccess = () => { const db = r.result; const c = db.transaction('workflows', 'readonly').objectStore('workflows').count(); c.onsuccess = () => { db.close(); resolve(c.result); }; }; r.onerror = () => resolve(-1); }))()`)) === 1);
  // a second one: two tabs, the new one active
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Workflow'); if (b) b.click(); })()`);
  await sleep(1500);
  check('the empty-state button is gone once a workflow is open (the sidebar menu makes the next one)', (await tabs()).length === 1);
  check('no page exception', app.errors.length === 0, app.errors.join(' | '));
} finally {
  await app.close();
}
console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
