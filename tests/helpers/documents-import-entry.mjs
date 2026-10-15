/**
 * jsdom entry for tests/documents-import-json.test.mjs and
 * tests/documents-export-category.test.mjs: exposes the REAL document /
 * import / export utils + Dexie db, a re-renderable mount of the REAL
 * DocumentSidebar (which owns the "Import from JSON" ImportFlow and the
 * category context menu's "Export Category (JSON)"), and the real
 * useImportExport hook, all from ONE bundle so the UI and the assertions
 * share the same Dexie instance. Bundled with esbuild by
 * tests/helpers/jsdom-documents-env.mjs; `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DocumentSidebar from '@worktree/src/components/features/documents/DocumentSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import ImportDBModal from '@worktree/src/components/common/modals/ImportDBModal.jsx';
import { useImportExport } from '@worktree/src/hooks/useImportExport.js';

export * as documents from '@worktree/src/utils/documents.js';
export * as documentImport from '@worktree/src/utils/documentImport.js';
export * as documentAttachments from '@worktree/src/utils/documentAttachments.js';
export * as media from '@worktree/src/utils/media.js';
export * as importDatabase from '@worktree/src/utils/importDatabase.js';
export * as documentCategories from '@worktree/src/utils/documentCategories.js';
export { collectExportData } from '@worktree/src/utils/exportDatabase.js';
export { stringifyToParts } from '@worktree/src/utils/incrementalJson.js';
export { db } from '@worktree/src/db/database.js';

let root = null;

/** Render (or re-render) the sidebar with the props DocumentsPage passes it. */
export function renderSidebar(props) {
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => {
    root.render(
      React.createElement(
        NotificationProvider,
        null,
        React.createElement(DocumentSidebar, {
          documents: [],
          categories: [],
          categoryData: [],
          currentDocument: null,
          rightPaneDocument: null,
          onSelectDocument: () => {},
          onCreateDocument: () => {},
          onRenameCategory: () => {},
          onRefreshDocuments: async () => {},
          ...props,
        })
      )
    );
  });
  return root;
}

export function unmountSidebar() {
  if (root) {
    flushSync(() => root.unmount());
    root = null;
  }
}

// The hook's functions are useCallback'd with stable deps, so one probe
// render yields callables that stay valid for the rest of the test.
let importExport = null;
function HookProbe() {
  importExport = useImportExport();
  return null;
}

/** The real useImportExport() result (exportToJSON, exportCategory, ...). */
export function getImportExport() {
  if (!importExport) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    flushSync(() => createRoot(host).render(React.createElement(HookProbe)));
  }
  return importExport;
}

// The database import modal (shared ImportStats/ImportFooter must keep its
// look): mounted in its own root with the host callbacks the test provides.
let dbRoot = null;
let dbHost = null;
export function renderImportDBModal(props) {
  if (!dbRoot) {
    dbHost = document.createElement('div');
    document.body.appendChild(dbHost);
    dbRoot = createRoot(dbHost);
  }
  flushSync(() => {
    dbRoot.render(React.createElement(ImportDBModal, { isOpen: true, onClose: () => {}, onImport: async () => ({}), ...props }));
  });
}
export function unmountImportDBModal() {
  if (dbRoot) {
    flushSync(() => dbRoot.unmount());
    dbRoot = null;
    dbHost.remove();
    dbHost = null;
  }
}
