/**
 * jsdom entry for tests/media-upload-rename.test.mjs: the REAL Media Library
 * modal (src/components/common/modals/MediaLibraryModal.jsx) mounted over
 * the real media utils and Dexie db, all from ONE bundle so the UI and the
 * assertions share the same database. Bundled with esbuild by
 * tests/helpers/jsdom-documents-env.mjs; `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MediaLibraryModal from '@worktree/src/components/common/modals/MediaLibraryModal.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

export * as media from '@worktree/src/utils/media.js';
export * as mediaNames from '@worktree/src/utils/mediaNames.js';
export * as documentAttachments from '@worktree/src/utils/documentAttachments.js';
export { db } from '@worktree/src/db/database.js';

let root = null;

/** Render (or re-render) the modal, open, with the given props. */
export function renderModal(props = {}) {
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => {
    root.render(
      React.createElement(
        NotificationProvider,
        null,
        React.createElement(MediaLibraryModal, { isOpen: true, onClose: () => {}, ...props })
      )
    );
  });
  return root;
}

export function unmountModal() {
  if (root) {
    flushSync(() => root.unmount());
    root = null;
  }
}
