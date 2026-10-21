/**
 * jsdom entry for tests/ai-context-yjs-live.test.mjs: the REAL
 * DocumentEditor on a cloud (Yjs-backed) document, the real useYjsText and
 * yjsProvider (the cloud socket replaced by tests/helpers/
 * cloud-websocket-fake.mjs through setupDocumentsEnv's `stubs`), the real
 * Dexie db and documents utils, and the real AI-context loaders - all from
 * ONE bundle so the editor, the Y.Doc and the loader share their modules.
 * Bundled by tests/helpers/jsdom-documents-env.mjs; `@worktree/` resolves
 * to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

export * as sources from '@worktree/src/utils/aiContextSources.js';
export * as documents from '@worktree/src/utils/documents.js';
export { getYjsProvider } from '@worktree/src/utils/yjsProvider.js';
export { getMachineId } from '@worktree/src/utils/cloudCentralSync.js';
export { db } from '@worktree/src/db/database.js';
export * as fakeSocket from '@worktree/tests/helpers/cloud-websocket-fake.mjs';

let root = null;
let setEditorState = null;
function EditorHost({ initial }) {
  const [state, setState] = React.useState(initial);
  setEditorState = setState;
  return React.createElement(DocumentEditor, {
    documentId: state.documentId,
    document: state.document,
    title: state.document.title,
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

/** Mount the real editor on { documentId, document, content }. */
export function renderEditor(initial) {
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => {
    root.render(React.createElement(NotificationProvider, null, React.createElement(EditorHost, { initial })));
  });
}
export function switchEditor(next) { flushSync(() => setEditorState && setEditorState(next)); }
export function unmountEditor() { if (root) { flushSync(() => root.unmount()); root = null; setEditorState = null; } }
