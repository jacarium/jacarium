/**
 * jsdom entry for tests/documents-sidebar-truncation.test.mjs: mounts the
 * REAL DocumentSidebar (real CategoryList/CategorySection/ItemList) with the
 * props DocumentsPage passes it, so the test can inspect the rendered row
 * markup. Bundled with esbuild by the test; `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DocumentSidebar from '@worktree/src/components/features/documents/DocumentSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

export function mountSidebar(documents, extraProps = {}) {
  const categories = [...new Set(documents.map((d) => d.category || 'General'))];
  const root = createRoot(document.getElementById('root'));
  flushSync(() => {
    root.render(
      React.createElement(
        NotificationProvider,
        null,
        React.createElement(DocumentSidebar, {
          documents,
          categories,
          categoryData: [],
          currentDocument: null,
          rightPaneDocument: null,
          onSelectDocument: () => {},
          onCreateDocument: () => {},
          onRenameCategory: () => {},
          onRefreshDocuments: async () => {},
          ...extraProps,
        })
      )
    );
  });
  return root;
}
