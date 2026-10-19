/**
 * jsdom entry for tests/markdown-callouts.test.mjs: the REAL markdown
 * pipeline (src/utils/interactiveMarkdown.js - marked + the renderer +
 * DOMPurify). Bundled with esbuild by tests/helpers/jsdom-documents-env.mjs
 * (setupDocumentsEnv(name, { entry })); `@worktree/` resolves to the repo.
 */
import { processInteractiveMarkdown, parseCalloutMarker, CALLOUT_TYPES } from '@worktree/src/utils/interactiveMarkdown.js';
import { marked } from 'marked';

export { processInteractiveMarkdown, parseCalloutMarker, CALLOUT_TYPES, marked };
