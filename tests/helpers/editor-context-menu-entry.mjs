/**
 * jsdom entry for tests/editor-context-clipboard.test.mjs: the REAL
 * TextSelectionMenu (on the shared ContextMenu) mounted on its own, and the
 * real src/utils/editorClipboard.js, from ONE bundle. Bundled with esbuild by
 * tests/helpers/jsdom-documents-env.mjs; `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import TextSelectionMenu from '@worktree/src/components/features/documents/TextSelectionMenu.jsx';
import ContextMenu, { ContextMenuItem } from '@worktree/src/components/common/menus/ContextMenu.jsx';

export * as editorClipboard from '@worktree/src/utils/editorClipboard.js';

let root = null;

/** Render (or re-render) the menu with the given props. */
export function renderMenu(props = {}) {
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => {
    root.render(React.createElement(TextSelectionMenu, { visible: true, x: 0, y: 0, ...props }));
  });
  return root;
}

export function unmountMenu() {
  if (root) {
    flushSync(() => root.unmount());
    root = null;
  }
}

// a plain shared ContextMenu (no keepFocus), in its own root: the generic focus behaviour
let genericRoot = null;
export function renderGenericMenu({ visible = true, x = 0, y = 0, onClose = () => {} } = {}) {
  if (!genericRoot) {
    const host = document.createElement('div');
    host.id = 'generic-root';
    document.body.appendChild(host);
    genericRoot = createRoot(host);
  }
  flushSync(() => {
    genericRoot.render(React.createElement(ContextMenu, { isVisible: visible, x, y, onClose, testId: 'generic-menu' },
      React.createElement(ContextMenuItem, { label: 'One', onClick: () => {} }),
      React.createElement(ContextMenuItem, { label: 'Two', onClick: () => {} })));
  });
}
