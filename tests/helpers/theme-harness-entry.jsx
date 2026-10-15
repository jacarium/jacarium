/**
 * Entry for tests/helpers/theme-harness.html (see there). Exposes
 * window.__harness so tests/export-import-theme.test.mjs can show one modal
 * at a time and toggle the theme:
 *
 *   __harness.showExport('ok' | 'fail')  - ExportProgressModal running a
 *                                          synthetic job that logs an info,
 *                                          a warning and then succeeds/fails
 *   __harness.showImport()               - ImportDBModal (drop a file on its
 *                                          drop zone to reach the preview)
 *   __harness.hide()
 *   __harness.setDark(bool)              - same class ThemeContext toggles
 *
 * All content is synthetic; nothing touches IndexedDB or the network.
 */
/* eslint-disable react-refresh/only-export-components -- test entry, renders as a side effect */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import ExportProgressModal from '../../src/components/common/ExportProgressModal.jsx';
import ImportDBModal from '../../src/components/common/modals/ImportDBModal.jsx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeJob(outcome) {
  return {
    title: 'Export Documents',
    description: 'Runbooks (3 documents) as ZIP',
    run: async (onProgress) => {
      onProgress({ step: 1, steps: 2, label: 'Collecting documents', current: 0, total: 3, log: 'Collecting 3 documents...' });
      await sleep(50);
      onProgress({ current: 2, log: 'Attachment "diagram.png" has no file data - skipped', logType: 'warning' });
      await sleep(50);
      onProgress({ current: 3, log: 'Collected 3 documents' });
      if (outcome === 'fail') {
        await sleep(50);
        throw new Error('Synthetic failure: archive could not be written');
      }
      onProgress({ step: 2, steps: 2, label: 'Building archive', indeterminate: true, log: 'Compressing...' });
      await sleep(50);
      return {};
    },
  };
}

// Deliberately synthetic - shape only, no real records
const IMPORT_FIXTURE = {
  version: '1',
  exportDate: '2026-01-02T03:04:05.000Z',
  documents: [{ id: 'doc-1' }, { id: 'doc-2' }],
  documentTemplates: [{ id: 'tpl-1' }],
  jqlTemplates: [],
  engineTemplates: [{ id: 'eng-1' }],
  workflows: [],
  kanbanBoards: [{ id: 'board-1' }],
  kanbanCards: [],
  taskwarriorInstances: [{ id: 1, name: 'Work' }, { id: 2, name: 'Remote' }],
  taskwarriorTasks: { Work: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001' }], Remote: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }] },
  taskTombstones: ['aaaaaaaa-0000-4000-8000-000000000009'],
};

// What ImportDBModal's onDryRun host callback resolves with (the shape of
// src/utils/importDatabase.js runImport()); exercises every part of the
// statistics block: counts, sample labels, an invalid row with its reason.
const DRY_RUN_RESULT = {
  mode: 'merge',
  dryRun: true,
  summary: {
    documents: {
      created: 1, updated: 0, filled: 1, skipped: 1, deleted: 0, invalid: 1,
      errors: [{ label: 'Runbook Broken / Ops', reason: 'not a record object' }],
      samples: { created: ['Runbook New / Ops'], updated: [], filled: ['Runbook Partial / Ops'] },
    },
    kanbanCards: {
      created: 0, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 1,
      errors: [{ label: 'Orphan Card', reason: 'its board (id 999) is not in the import file' }],
      samples: { created: [], updated: [], filled: [] },
    },
    // Format-2 backups (src/utils/taskwarriorBackup.js): one row per
    // TaskWarrior instance with the transport and the breakdown line.
    'tasks:Work': {
      created: 3, updated: 2, filled: 0, skipped: 5, deleted: 0, invalid: 0, errors: [],
      samples: { created: ['Alpha', 'Beta', 'Gamma (completed)'], updated: ['Delta'], filled: [], tombstoned: ['Epsilon (deleted)'], purgedHere: ['Zeta'] },
      instance: 'Work', via: 'cli', needsDataPath: false, cliError: null, tombstoned: 1, purgedHere: 1,
      createdByStatus: { pending: 2, completed: 1 },
      note: '1 completed of the new tasks is not pending (Completed/Deleted sections only); a deleted task the TaskWarrior CLI no longer has is dropped again on the next sync',
    },
    'tasks:Remote': {
      created: 1, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0, errors: [],
      samples: { created: ['Remote task'], updated: [], filled: [], tombstoned: [], purgedHere: [] },
      instance: 'Remote', via: 'db', needsDataPath: true, cliError: 'Data directory does not exist: /home/other/.task-remote',
      tombstoned: 0, purgedHere: 0, createdByStatus: { pending: 1 },
    },
  },
  totals: { created: 5, updated: 2, filled: 1, skipped: 6, deleted: 0, invalid: 2 },
};

function Harness() {
  // null | { kind: 'export', job } | { kind: 'import', key }. Each showImport()
  // gets a new key so the modal remounts with fresh state (it keeps its
  // loaded file / merge toggle across isOpen toggles otherwise).
  const [view, setView] = React.useState(null);

  React.useEffect(() => {
    let importKey = 0;
    window.__harness = {
      showExport: (outcome = 'ok') => setView({ kind: 'export', job: makeJob(outcome) }),
      showImport: () => setView({ kind: 'import', key: ++importKey }),
      hide: () => setView(null),
      setDark: (dark) => document.documentElement.classList.toggle('dark', !!dark),
      importFixtureJson: JSON.stringify(IMPORT_FIXTURE),
    };
    window.__harnessReady = true;
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--os-canvas)', padding: 24 }}>
      <p style={{ color: 'var(--os-text-secondary)', fontFamily: 'sans-serif', fontSize: 13 }}>
        Theme harness - tests only
      </p>
      <ExportProgressModal
        isOpen={view?.kind === 'export'}
        onClose={() => setView(null)}
        job={view?.kind === 'export' ? view.job : null}
      />
      <ImportDBModal
        key={view?.kind === 'import' ? view.key : 'closed'}
        isOpen={view?.kind === 'import'}
        onClose={() => setView(null)}
        onImport={() => setView(null)}
        onDryRun={async () => DRY_RUN_RESULT}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
