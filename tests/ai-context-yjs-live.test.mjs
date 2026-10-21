#!/usr/bin/env node
/**
 * "Add as AI Context" on a cloud (Yjs-backed) document sends the LIVE Yjs
 * text, not the IndexedDB copy. The REAL DocumentEditor, useYjsText and
 * yjsProvider run in jsdom on a document marked inCloud with a
 * cloudDocumentId; the cloud socket is a fake that never connects
 * (tests/helpers/cloud-websocket-fake.mjs), so the hook takes its offline
 * path: it creates the provider and, after its 3 s fallback, seeds the Yjs
 * text from the local copy. Then a collaborator's edit lands in the shared
 * Y.Doc (an insert into the ytext, as a remote update would apply): the
 * editor's textarea shows it at once, IndexedDB does not have it yet (the
 * hook mirrors the text with a debounce), and
 * src/utils/aiContextSources.js loadDocumentContext - what every "Add as
 * AI Context" menu calls - returns the text WITH the edit: the open editor
 * answers the live-text event (DocumentEditor), and that wins over storage.
 *
 * Run:  node tests/ai-context-yjs-live.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb (SKIP without them).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('ai-context-yjs', {
  entry: path.join(here, 'helpers', 'ai-context-yjs-entry.mjs'),
  stubs: { 'utils/cloudWebSocket': path.join(here, 'helpers', 'cloud-websocket-fake.mjs') },
});
const { document } = window;
const { sources, documents, getYjsProvider, getMachineId, db, fakeSocket, renderEditor, unmountEditor } = mod;

try {
  const BODY = 'Body on node-9 for the cloud.';
  const id = await documents.createDocument({ title: 'Cloud runbook', content: BODY, category: 'Ops' });
  await db.documents.update(id, { inCloud: true, cloudDocumentId: 'cloud-doc-1', ownerId: await getMachineId() });
  const doc = await documents.getDocument(id);
  check('the document is a cloud one in storage (inCloud + cloudDocumentId), its body in IndexedDB', doc.inCloud === true && doc.cloudDocumentId === 'cloud-doc-1' && doc.content === BODY);

  renderEditor({ documentId: id, document: doc, content: doc.content });
  await sleep(200);
  const textarea = () => document.querySelector('textarea.sc-editor-textarea');
  check('the real editor is mounted on the document', !!textarea());
  check('the editor opened the Yjs provider on the (fake) socket and asked for sync-step1', fakeSocket.emitted.some((e) => e.event === 'yjs-sync-step1' && e.payload?.documentId === 'cloud-doc-1'), JSON.stringify(fakeSocket.emitted.map((e) => e.event)));

  // the offline fallback (3 s) seeds the Yjs text from the local copy
  const ytext = getYjsProvider('cloud-doc-1').ydoc.getText('content');
  let seeded = false;
  for (let i = 0; i < 30 && !seeded; i++) { await sleep(250); seeded = ytext.toString() === BODY; }
  check('after the hook\'s offline fallback the Yjs text holds the body and the textarea shows it', seeded && textarea().value === BODY, `ytext="${ytext.toString()}" textarea="${textarea()?.value}"`);

  // a collaborator's edit arrives in the shared Y.Doc
  ytext.insert(ytext.length, ' Live Yjs addition.');
  await sleep(100);
  const stored = (await db.documents.get(id)).content;
  check('the edit is in the editor at once, while IndexedDB still holds the old body (the mirror is debounced)', textarea().value === `${BODY} Live Yjs addition.` && stored === BODY, `textarea="${textarea().value}" stored="${stored}"`);

  check('liveDocumentContent(id): the open editor answers with the live Yjs text', sources.liveDocumentContent(id) === `${BODY} Live Yjs addition.`);
  const payload = await sources.loadDocumentContext(id);
  check('loadDocumentContext - what every "Add as AI Context" menu calls - carries the live Yjs text, not the stale copy, with no error', payload.content === `${BODY} Live Yjs addition.` && !payload.error && payload.kind === 'document' && payload.title === 'Cloud runbook', JSON.stringify(payload));
  const metaOnly = await sources.loadDocumentContext({ id, title: 'Cloud runbook', category: 'Ops' });
  check('...also when handed the sidebar\'s metadata-only row', metaOnly.content === `${BODY} Live Yjs addition.`);

  // once the editor is gone the loader falls back to storage (the mirror has caught up by then, or not)
  unmountEditor();
  await sleep(100);
  check('with no editor open the live event goes unanswered and the loader reads storage', sources.liveDocumentContent(id) === undefined && typeof (await sources.loadDocumentContext(id)).content === 'string');
} catch (e) {
  check('the run completed', false, e.stack || e.message);
}
process.exit(summary());
