/**
 * jsdom entry for tests/documents-find-in-files.test.mjs: exposes the REAL
 * DocumentSidebar (context menus + hamburger menu that carry "Find in
 * Files"), the REAL FindInFilesWindow, the REAL DocumentEditor (jump to
 * line), the document / openDocument / findInFiles utils and the Dexie db,
 * all from ONE bundle so the UI and the assertions share one database.
 * Bundled with esbuild by tests/helpers/jsdom-documents-env.mjs
 * (setupDocumentsEnv(name, { entry })); `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DocumentSidebar from '@worktree/src/components/features/documents/DocumentSidebar.jsx';
import FindInFilesWindow from '@worktree/src/components/features/documents/FindInFilesWindow.jsx';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

export * as documents from '@worktree/src/utils/documents.js';
export * as openDocument from '@worktree/src/utils/openDocument.js';
export * as findInFiles from '@worktree/src/utils/findInFiles.js';
export { db } from '@worktree/src/db/database.js';

function mountable(makeElement) {
  let root = null;
  let host = null;
  return {
    render(props) {
      if (!root) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
      }
      flushSync(() => root.render(makeElement(props)));
      return root;
    },
    unmount() {
      if (root) {
        flushSync(() => root.unmount());
        root = null;
        host.remove();
        host = null;
      }
    },
  };
}

const sidebar = mountable((props) => React.createElement(
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
));
/** Render (or re-render) the real sidebar with the props DocumentsPage passes it. */
export const renderSidebar = sidebar.render;
export const unmountSidebar = sidebar.unmount;

const findWindow = mountable((props) => React.createElement(FindInFilesWindow, {
  open: true,
  scope: null,
  documents: [],
  onClose: () => {},
  onOpenDocument: () => {},
  ...props,
}));
/** Render (or re-render) the real Find in Files window. */
export const renderFindWindow = findWindow.render;
export const unmountFindWindow = findWindow.unmount;

// The real editor, with its document switchable from the test (the way
// DocumentsPage swaps documentId/content when a tab is opened).
let setEditorState = null;
function EditorHost({ initial }) {
  const [state, setState] = React.useState(initial);
  setEditorState = setState;
  return React.createElement(DocumentEditor, {
    documentId: state.documentId,
    document: { id: state.documentId, title: state.title || 'Doc', inCloud: false },
    title: state.title || 'Doc',
    content: state.content,
    onContentChange: (e) => setState((s) => ({ ...s, content: e.target.value })),
    onTitleChange: () => {},
    onCategoryChange: () => {},
    templates: [],
    categories: [],
    locked: false,
    isOnline: true,
  });
}
const editor = mountable((initial) => React.createElement(
  NotificationProvider,
  null,
  React.createElement(EditorHost, { initial })
));
/** Mount the real DocumentEditor showing { documentId, title, content }. */
export const renderEditor = editor.render;
export const unmountEditor = () => { setEditorState = null; editor.unmount(); };
/** Switch the mounted editor to another { documentId, title, content }. */
export function switchEditor(next) {
  flushSync(() => setEditorState && setEditorState(next));
}
