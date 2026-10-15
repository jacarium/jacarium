/**
 * jsdom entry for tests/document-category-duplicates.test.mjs: exposes the
 * REAL category/document utils + Dexie db and a re-renderable mount of the
 * REAL DocumentSidebar (real CategoryList/CategorySection), all from ONE
 * bundle so the sidebar and the assertions share the same Dexie instance.
 * Bundled with esbuild by the test; `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DocumentSidebar from '@worktree/src/components/features/documents/DocumentSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

export * as documentCategories from '@worktree/src/utils/documentCategories.js';
export * as documents from '@worktree/src/utils/documents.js';
export * as importDatabase from '@worktree/src/utils/importDatabase.js';
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
