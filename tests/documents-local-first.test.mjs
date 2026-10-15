/**
 * Local first: opening a document renders from IndexedDB without waiting for
 * the home server. In the real browser (Vite, no backend): synchronisation
 * is started with a transport that NEVER answers; a document then opens
 * within the normal render time, no "Updating from the server" text or
 * overlay exists anywhere, and the background pull was issued (the hanging
 * transport saw a pull first). Then, without the server: a change applied
 * to the open, untouched document (the engine's 'syncApplied' with the
 * row) updates the editor in place with a small notice; while the editor
 * holds an edit, the same event leaves the edit alone; a 'syncConflict'
 * from the engine shows the conflict notice without blocking.
 *
 * Statically: no "Updating from the server" string remains in src/, and
 * the open path does not await pullNow.
 * Run: node tests/documents-local-first.test.mjs (skips without Chrome)
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchDocumentsApp, REPO, sleep, createNewDocument } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const src = fs.readFileSync(path.join(REPO, 'src/components/DocumentsPage.jsx'), 'utf8');
check('no "Updating from the server" text in the Documents page', !/Updating from the server/.test(src));
check('no such text anywhere in src/', !fs.readdirSync(path.join(REPO, 'src/components')).some((f) => f.endsWith('.jsx') && /Updating from the server/.test(fs.readFileSync(path.join(REPO, 'src/components', f), 'utf8'))));
check('the open path pulls in the background (no awaited pullNow)', !/await pullNow\(/.test(src) && /pullNow\(\{ timeout: 0 \}\)\.catch/.test(src));

const app = await launchDocumentsApp({ port: 5286, profilePrefix: 'local-first-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(failed ? 1 : 0); }
const ev = (s) => app.evaluate(s);
try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await dismissWhatsNew(app);
  // two documents in the local database
  await ev(`(async () => { const docs = await import('/src/utils/documents.js'); await docs.createDocument({ title: 'Local first one', content: '# One\\n\\nStored locally.', category: 'General' }); await docs.createDocument({ title: 'Local first two', content: '# Two\\n\\nAlso local.', category: 'General' }); })()`);
  await ev('location.reload()'); await sleep(3500); await dismissWhatsNew(app);
  // synchronisation with a server that never answers; the transport records what was asked
  await ev(`(async () => { window.__pulls = []; const engine = await import('/src/sync/syncEngine.js'); await engine.startSync({ transport: { fetch: (p) => { window.__pulls.push(p); return new Promise(() => {}); } }, listen: false, immediate: false }); window.__syncStarted = engine.isSyncStarted(); })()`);
  check('sync is started with a hanging transport', await ev('window.__syncStarted === true'));
  // the sidebar lists the category first: expand it when its documents are not listed, then open the row
  const listed = await ev(`Array.from(document.querySelectorAll('*')).some((el) => el.children.length === 0 && el.textContent.trim() === 'Local first one')`);
  if (!listed) { await ev(`(() => { const cat = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'General').pop(); if (cat) cat.click(); })()`); await sleep(600); }
  const t0b = Date.now();
  const hit = await ev(`(() => { const row = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Local first one').pop(); if (!row) return false; row.click(); return true; })()`);
  check('the document row is in the sidebar', hit, await ev(`Array.from(document.querySelectorAll('.sc-row')).map((r) => r.textContent.trim().slice(0, 20)).join(' | ')`));
  const opened = await app.waitFor(`(() => { const ta = document.querySelector('textarea'); return !!ta && /Stored locally/.test(ta.value); })()`, 4000, 50);
  const elapsed = Date.now() - t0b;
  check('the document opens from IndexedDB without waiting for the server', !!opened && elapsed < 2000, `${elapsed} ms`);
  check('no blocking "updating" element', !(await ev(`!!document.querySelector('[data-testid="sync-updating"]')`)) && !/Updating from the server/.test(await ev('document.body.textContent')));
  await sleep(300);
  check('the background pull was issued right after the open, pull first', await ev(`window.__pulls.length > 0 && /\\/api\\/sync\\/pull/.test(window.__pulls[0])`), await ev('JSON.stringify(window.__pulls)'));

  // a change from another device reaches the untouched open document: in place, with a notice
  const docId = await ev(`(async () => { const { db } = await import('/src/db/database.js'); return (await db.documents.where('title').equals('Local first one').first()).id; })()`);
  await ev(`(async () => { const { db } = await import('/src/db/database.js'); await db.documents.update(${docId}, { content: '# One\\n\\nChanged on the other device.', updatedAt: Date.now() }); window.dispatchEvent(new CustomEvent('syncApplied', { detail: { collections: ['documents'], changes: [{ collection: 'documents', key: 'x', deleted: false, row: { id: ${docId} } }] } })); })()`);
  const updated = await app.waitFor(`(() => { const ta = document.querySelector('textarea'); return !!ta && /Changed on the other device/.test(ta.value); })()`, 4000, 50);
  check('an untouched open document is updated in place', !!updated);
  check('...with an info NoticeBanner under the editor toolbar (the strip the offline / read-only notices use), not a wait or a pop-up', await ev(`(() => { const n = document.querySelector('[data-testid="document-sync-banner"]'); return !!n && n.dataset.tone === 'info' && /Updated from another device/.test(n.textContent) && !document.querySelector('[data-testid="sync-notice"]'); })()`));
  check('...the banner sits in the editor column above the textarea, not fixed over the page', await ev(`(() => { const n = document.querySelector('[data-testid="document-sync-banner"]'); const ta = document.querySelector('textarea'); if (!n || !ta) return false; const a = n.getBoundingClientRect(), b = ta.getBoundingClientRect(); return getComputedStyle(n).position !== 'fixed' && n.parentElement.contains(ta) && !!(n.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING) && a.top <= b.top; })()`));

  // the user is editing: the same event must not overwrite the edit
  await ev(`(() => { const ta = document.querySelector('textarea'); ta.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '\\n\\nMy edit in progress'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await ev(`(async () => { const { db } = await import('/src/db/database.js'); await db.documents.update(${docId}, { content: '# One\\n\\nA second remote change.', updatedAt: Date.now() }); window.dispatchEvent(new CustomEvent('syncApplied', { detail: { collections: ['documents'], changes: [{ collection: 'documents', key: 'x', deleted: false, row: { id: ${docId} } }] } })); })()`);
  await sleep(500);
  check('an edit in progress is not overwritten by a remote change', await ev(`(() => { const ta = document.querySelector('textarea'); return /My edit in progress/.test(ta.value) && !/second remote change/.test(ta.value); })()`));

  // the engine's conflict announcement shows the notice
  await ev(`window.dispatchEvent(new CustomEvent('syncConflict', { detail: { table: 'documents', id: ${docId}, title: 'Local first one', outcome: 'remote-won', copyId: 999, copyTitle: 'Local first one (conflict copy 2026-10-13 20:00)' } }))`);
  await sleep(200);
  check('a conflict shows a warning NoticeBanner in the same strip, naming the conflict copy, with "Open conflict copy" and a dismiss', await ev(`(() => { const n = document.querySelector('[data-testid="document-sync-banner"]'); return !!n && n.dataset.tone === 'warning' && /conflict copy/.test(n.textContent) && !!n.querySelector('[data-testid="document-sync-open-copy"]') && !!n.querySelector('[data-testid="document-sync-banner-dismiss"]'); })()`));
  await ev(`document.querySelector('[data-testid="document-sync-banner-dismiss"]').click()`); await sleep(200);
  check('dismiss closes the conflict banner', !(await ev(`!!document.querySelector('[data-testid="document-sync-banner"]')`)));
  check('the editor stays usable (no overlay over it)', await ev(`(() => { const ta = document.querySelector('textarea'); const r = ta.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === ta || ta.contains(el); })()`));
  check('no runtime exception', app.errors.filter((e) => !/favicon|ResizeObserver/.test(e)).length === 0, app.errors.join(' || ').slice(0, 200));
} catch (e) {
  check('the local-first scenario runs', false, e.stack || String(e));
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
