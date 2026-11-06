/**
 * jsdom entry for tests/markdown-doc-links.test.mjs: the REAL markdown
 * pipeline (src/utils/interactiveMarkdown.js - marked + the renderer +
 * DOMPurify) with the document-link resolver (src/utils/docLinks.js) and
 * the PDF export's link flattening. Bundled with esbuild by
 * tests/helpers/jsdom-documents-env.mjs (setupDocumentsEnv(name, { entry }));
 * `@worktree/` resolves to the repo.
 */
import { processInteractiveMarkdown } from '@worktree/src/utils/interactiveMarkdown.js';
import { createDocLinkResolver, findDocLinks, docLinkContextAt, searchDocuments, docLinkDirective, renderDocLinks, DOC_LINK_RE, isStableIdRef } from '@worktree/src/utils/docLinks.js';
import { flattenDocLinksForPdf } from '@worktree/src/utils/pdfExportNative.js';
import { BLOCK_COMMANDS, BUILTIN_COMMANDS, matchesSlashQuery, isInsideCode } from '@worktree/src/utils/slashCommands.js';

export { processInteractiveMarkdown, createDocLinkResolver, findDocLinks, docLinkContextAt, searchDocuments, docLinkDirective, renderDocLinks, DOC_LINK_RE, isStableIdRef, flattenDocLinksForPdf, BLOCK_COMMANDS, BUILTIN_COMMANDS, matchesSlashQuery, isInsideCode };
