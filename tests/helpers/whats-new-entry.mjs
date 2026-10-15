/**
 * jsdom entry for tests/whats-new-window.test.mjs: mounts the REAL WhatsNew
 * window (src/components/WhatsNew.jsx on the shared FloatingWindow) and
 * exposes the real version data it renders. Bundled with esbuild by
 * tests/helpers/jsdom-documents-env.mjs (setupDocumentsEnv(name, { entry }));
 * `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import WhatsNew, { WHATS_NEW_SEEN_KEY } from '@worktree/src/components/WhatsNew.jsx';

export { WHATS_NEW_SEEN_KEY };
export * as versionsData from '@worktree/src/whats-new/versions/index.js';
export * as categoriesData from '@worktree/src/whats-new/categories.js';

let root = null;
let host = null;
export function renderWhatsNew() {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  flushSync(() => root.render(React.createElement(WhatsNew)));
}
export function unmountWhatsNew() {
  if (root) {
    flushSync(() => root.unmount());
    root = null;
    host.remove();
    host = null;
  }
}
