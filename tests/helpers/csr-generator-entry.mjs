/**
 * jsdom entry for tests/csr-generator.test.mjs: mounts the REAL CSR
 * generator tool (src/components/features/tools/CsrGeneratorTool.jsx) so
 * the test can fill its form, press Generate and read the PEM output it
 * shows. Bundled with esbuild by tests/helpers/jsdom-documents-env.mjs
 * (setupDocumentsEnv(name, { entry })); `@worktree/` resolves to the repo.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CsrGeneratorTool from '@worktree/src/components/features/tools/CsrGeneratorTool.jsx';

let root = null;
export function renderTool() {
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => root.render(React.createElement(CsrGeneratorTool)));
}
export function unmountTool() {
  if (root) {
    flushSync(() => root.unmount());
    root = null;
  }
}
