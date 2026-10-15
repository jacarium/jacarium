/**
 * Entry for tests/helpers/documents-import-harness.html (see there). Exposes
 * window.__harness so tests/documents-import-theme.test.mjs can walk the
 * REAL Documents "Import from JSON" flow one step at a time and toggle the
 * theme:
 *
 *   __harness.showInput()            - open the input modal (paste / upload
 *                                      file), fresh state each time; the
 *                                      real validateDocumentsImport runs on
 *                                      "Dry Run" / "Import Documents"; a dry
 *                                      run shows the statistics in place and
 *                                      a valid "Import Documents" hands over
 *                                      to the progress modal exactly like
 *                                      the app does
 *   __harness.showProgress(kind)     - open the progress modal directly with
 *                                      synthetic documents: 'ok' (all
 *                                      succeed), 'partial' (one fails),
 *                                      'fail' (all fail), 'running' (one
 *                                      document never finishes, so the modal
 *                                      stays in its importing state)
 *   __harness.hide()
 *   __harness.setDark(bool)          - same class ThemeContext toggles
 *   __harness.imported               - titles the synthetic onImportItem
 *                                      accepted so far
 *
 * The runner is synthetic (see onRun below): it resolves after a short
 * delay per document, counts titles containing "FAIL" as invalid and never
 * settles for "HANG".
 * All content is synthetic; nothing touches IndexedDB or the network.
 */
/* eslint-disable react-refresh/only-export-components -- test entry, renders as a side effect */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import ImportFlow from '../../src/components/common/ImportFlow.jsx';
import { useImportFlow } from '../../src/hooks/useImportFlow.js';
import { validateDocumentsImport } from '../../src/utils/documentImport.js';
import DocumentsImportStats, { DOCUMENTS_MERGE_LABEL, documentsMergeHint } from '../../src/components/features/documents/DocumentsImportStats.jsx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 PNG (synthetic, built by hand) so the 'ok' set carries an embedded
// image the way Export Category (JSON) writes it (see documentAttachments.js)
const DOT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const DOCS = {
  ok: [
    { title: 'Runbook: Alpha', content: '# Alpha\n\n![dot](attachment:dot.png)\n\nSynthetic body', category: 'Runbooks',
      media: [{ filename: 'dot.png', mimeType: 'image/png', size: 70, uploadedAt: '2026-01-02T03:04:05.000Z', tags: [], data: DOT_PNG }] },
    { title: 'Notes 📝 Beta', content: 'Unicode body – ünïcödé', category: 'Notes', locked: true },
    { title: 'Gamma', content: '```js\nconsole.log(1)\n```' },
  ],
  partial: [
    { title: 'Runbook: Alpha', content: 'ok', category: 'Runbooks' },
    { title: 'FAIL: Broken record', content: 'this one is refused by the synthetic importer' },
    { title: 'Gamma', content: 'ok', category: 'Notes' },
  ],
  fail: [
    { title: 'FAIL: first', content: 'x' },
    { title: 'FAIL: second', content: 'y' },
  ],
  running: [
    { title: 'Runbook: Alpha', content: 'ok' },
    { title: 'HANG: never finishes', content: 'z' },
    { title: 'Gamma', content: 'ok' },
  ],
};

const imported = [];
const summaryRow = (label) => ({ created: 0, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0, errors: [], samples: { created: [], updated: [], filled: [] }, ...(label ? { label } : {}) });

/**
 * Synthetic stand-in for src/utils/documentImport.js runDocumentsImport
 * (nothing touches IndexedDB here): same progress/log contract and the same
 * result shape { mode, dryRun, summary, totals } with Documents, per-category
 * and Images rows, a same-title note, a renamed-image note and invalid rows
 * with reasons. "FAIL" titles become invalid rows, "HANG" never finishes.
 */
async function onRun(docs, { dryRun = false, mergeMode = false, onProgress } = {}) {
  const report = (u) => { if (onProgress) onProgress(u); };
  const documents = { ...summaryRow(), sameTitle: 0, locked: 0 };
  const images = { ...summaryRow(), renamed: [] };
  const categories = {};
  report({ current: 0, total: docs.length, log: `Starting ${dryRun ? 'dry run' : 'import'} of ${docs.length} document(s)...` });
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    await sleep(30);
    report({ log: `${dryRun ? 'Checking' : 'Importing'} "${doc.title}"...` });
    if (/HANG/.test(doc.title || '')) await new Promise(() => {});
    if (/FAIL/.test(doc.title || '')) {
      documents.invalid += 1;
      documents.errors.push({ label: doc.title, reason: 'Synthetic failure: quota exceeded' });
      report({ current: i + 1, total: docs.length, log: `✗ Failed to import "${doc.title}": Synthetic failure: quota exceeded`, logType: 'error' });
      continue;
    }
    if (!dryRun) imported.push(doc.title);
    const cat = doc.category || 'General';
    const isNew = cat !== 'Notes';
    categories[cat] = categories[cat] || { ...summaryRow(`Category "${cat}"${isNew ? ' (new)' : ''}`), isNew };
    // Merge mode (synthetic): "Alpha" matches a newer-in-file local -> replaced,
    // "Beta" matches with a blank local field -> completed, "Gamma" matches a
    // locked local -> unchanged (locked); everything else is new.
    const outcome = !mergeMode ? 'created' : /Alpha/.test(doc.title) ? 'updated' : /Beta/.test(doc.title) ? 'filled' : /Gamma/.test(doc.title) ? 'skipped' : 'created';
    documents[outcome] += 1;
    categories[cat][outcome] += 1;
    if (documents.samples[outcome]) documents.samples[outcome].push(doc.title);
    if (categories[cat].samples[outcome]) categories[cat].samples[outcome].push(doc.title);
    if (mergeMode && outcome === 'skipped') documents.locked += 1;
    if (!mergeMode && /Alpha/.test(doc.title)) documents.sameTitle += 1;
    if (Array.isArray(doc.media) && doc.media.length) {
      images.created += 1;
      images.samples.created.push('dot-2.png');
      images.renamed.push({ from: 'dot.png', to: 'dot-2.png', document: doc.title });
      report({ log: `  1 image (1 renamed)`, type: 'info' });
      report({ log: `  ⚠ A different image named "dot.png" already exists here - stored as "dot-2.png" and the links were updated`, logType: 'warning' });
    }
    report({ current: i + 1, total: docs.length, log: `✓ ${dryRun ? 'Would import' : 'Imported'} "${doc.title}"`, logType: 'success' });
  }
  if (documents.sameTitle) documents.note = `${documents.sameTitle} has the same title as an existing document in the same category (imported as a separate copy): Runbook: Alpha`;
  if (documents.locked) documents.note = `${documents.locked} locked document left untouched: Gamma`;
  if (images.renamed.length) images.note = `1 renamed because a different local image owns the name: dot.png → dot-2.png (links updated in "Runbook: Alpha")`;
  const summary = { documents };
  for (const name of Object.keys(categories).sort()) summary[`category:${name}`] = categories[name];
  summary.images = images;
  const totals = { created: documents.created + images.created, updated: documents.updated, filled: documents.filled, skipped: documents.skipped + images.skipped, deleted: 0, invalid: documents.invalid + images.invalid };
  report({ log: dryRun ? `Dry run finished - nothing was written. ${documents.created} document(s) would be imported.` : `✓ Import completed. ${documents.created} document(s) imported${totals.invalid ? `, ${totals.invalid} invalid` : ''}.`, logType: totals.invalid && !documents.created ? 'error' : totals.invalid ? 'warning' : 'success' });
  return { mode: 'documents', dryRun, mergeMode, summary, totals };
}

function Harness() {
  // Remount the flow for every show* so each step starts from fresh state
  const [key, setKey] = React.useState(0);
  const [pending, setPending] = React.useState(null); // { kind: 'input' } | { kind: 'progress', docs }
  return (
    <div style={{ minHeight: '100vh', background: 'var(--os-canvas)', padding: 24 }}>
      <p style={{ color: 'var(--os-text-secondary)', fontFamily: 'sans-serif', fontSize: 13 }}>
        Documents import harness - tests only
      </p>
      <Flow key={key} pending={pending} onRegister={(api) => {
        window.__harness = {
          showInput: () => { setKey((k) => k + 1); setPending({ kind: 'input' }); },
          showProgress: (kind = 'ok') => { setKey((k) => k + 1); setPending({ kind: 'progress', docs: DOCS[kind] || DOCS.ok }); },
          hide: () => { setKey((k) => k + 1); setPending(null); },
          setDark: (dark) => document.documentElement.classList.toggle('dark', !!dark),
          imported,
          ...api,
        };
        window.__harnessReady = true;
      }} />
    </div>
  );
}

function Flow({ pending, onRegister }) {
  const flow = useImportFlow({ validateFn: validateDocumentsImport, onRun });
  const { startImport, handleInputValidated } = flow;

  React.useEffect(() => {
    onRegister({});
    if (!pending) return;
    if (pending.kind === 'input') startImport();
    else if (pending.kind === 'progress') handleInputValidated(pending.docs);
    // The flow is remounted (new key) for every pending change, so this
    // deliberately runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ImportFlow
      isInputOpen={flow.showInputModal}
      isProgressOpen={flow.showProgressModal}
      onInputClose={flow.handleInputClose}
      onProgressClose={flow.handleProgressClose}
      onValidated={flow.handleInputValidated}
      importData={flow.importData}
      title="Import Documents"
      placeholder="Paste your JSON array of documents here..."
      validateFn={flow.validateFn}
      onRun={flow.onRun}
      renderStats={(result) => <DocumentsImportStats result={result} />}
      importLabel="Import Documents"
      mergeLabel={DOCUMENTS_MERGE_LABEL}
      mergeHint={documentsMergeHint}
    />
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
