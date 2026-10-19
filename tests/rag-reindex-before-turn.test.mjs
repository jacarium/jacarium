#!/usr/bin/env node
/**
 * Robin refreshes the dataset index before every dataset turn.
 *
 * The vector index only knew a document as it was when the dataset
 * selection was saved (DatasetSelectionModal posts the selected documents
 * then). A note edited afterwards was searched as its OLD text until the
 * selection was saved again, so Robin answered from stale chunks.
 * src/utils/ragIndex.js indexDatasetDocuments() posts the CURRENT content
 * of the selected documents to /api/embeddings/index (the backend skips
 * unchanged ones by checksum), and AIChatPage awaits it before the RAG
 * request.
 *
 * Proved here with the real helper over fake-indexeddb and a recorded fetch:
 *   1. only the selected documents are posted, with id, title, the current
 *      content and the category ('Uncategorized' when missing);
 *   2. an empty selection, or ids of deleted documents, posts nothing;
 *   3. a failed request throws (the page logs it and still sends the turn);
 *   4. AIChatPage awaits the refresh before the RAG request, inside the
 *      dataset branch only, and never lets it block the chat.
 *
 * Run:  node tests/rag-reindex-before-turn.test.mjs
 * Preconditions: npm install; npm install --no-save fake-indexeddb
 *   (prints "SKIP:" and exits 0 when the test-only dep is missing)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
function resolvable(name) { try { req.resolve(name); return true; } catch { return false; } }
for (const dep of ['esbuild', 'dexie']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
if (!resolvable('fake-indexeddb')) { console.log('SKIP: test-only dependency "fake-indexeddb" not installed (npm install --no-save fake-indexeddb)'); process.exit(0); }

let failures = 0; let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) console.log(`PASS: ${name}`);
  else { failures += 1; console.log(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 400)}` : ''}`); }
}

// ---------- source: the page awaits the refresh in the dataset branch ----------
const page = fs.readFileSync(path.join(REPO, 'src/components/AIChatPage.jsx'), 'utf8');
const branch = (page.match(/if \(hasDatasets && supportsRAG\) \{[\s\S]*?\} else if \(supportsStreaming\)/) || [''])[0];
check('AIChatPage awaits indexDatasetDocuments inside the dataset (RAG) branch, in a try/catch that only warns',
  /await indexDatasetDocuments\(backendUrl, datasets\.documentIds\);/.test(branch) && /catch \(error\) \{\s*console\.warn/.test(branch)
  && page.indexOf('await indexDatasetDocuments(') < page.indexOf('await handleStreamingResponse(endpoint, requestBody, updatedMessages)'));

// ---------- bundle the helper ----------
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-reindex-'));
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
import { indexDatasetDocuments } from '@worktree/src/utils/ragIndex.js';
import { db } from '@worktree/src/db/database.js';
module.exports = { indexDatasetDocuments, db };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => { if (isBuiltin(args.path)) return { path: args.path, external: true }; try { return { path: req.resolve(args.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});
await import(req.resolve('fake-indexeddb/auto'));
// the helper goes through apiFetch, which reads window/localStorage for the auth token
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };
const calls = [];
let respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, indexed: 1, skipped: 1, chunks_created: 2 }) });
globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null }); return respond(); };
const { indexDatasetDocuments, db } = createRequire(import.meta.url)(BUNDLE);

const now = Date.now();
const a = await db.documents.add({ title: 'DAST', content: '# DAST\n\nOld text', category: 'AI Security', createdAt: new Date(now), updatedAt: new Date(now) });
const b = await db.documents.add({ title: 'SAST', content: '# SAST\n\nStatic analysis', category: 'AI Security', createdAt: new Date(now), updatedAt: new Date(now) });
const c = await db.documents.add({ title: 'Unrelated', content: 'Nope', createdAt: new Date(now), updatedAt: new Date(now) });
await db.documents.update(a, { content: '# DAST\n\nEdited after the dataset was saved' });

const result = await indexDatasetDocuments('http://backend.test', [a, b]);
const posted = calls[0]?.body?.documents || [];
check('posts the selected documents only (not the unselected one)', calls.length === 1 && posted.map((d) => d.id).sort().join() === [a, b].sort().join(), JSON.stringify(calls[0]));
check('with the CURRENT content (the edit made after the dataset was saved)', posted.find((d) => d.id === a)?.content === '# DAST\n\nEdited after the dataset was saved');
check('to /api/embeddings/index, with title and category', /\/api\/embeddings\/index$/.test(calls[0]?.url || '') && posted.every((d) => d.title && d.category === 'AI Security'));
check('returns the backend summary', result && result.indexed === 1 && result.chunks_created === 2, JSON.stringify(result));

calls.length = 0;
const none = await indexDatasetDocuments('http://backend.test', []);
const gone = await indexDatasetDocuments('http://backend.test', [9999]);
check('an empty selection or ids of deleted documents post nothing and return null', none === null && gone === null && calls.length === 0, calls.length);

calls.length = 0;
const d = await indexDatasetDocuments('http://backend.test', [c]);
check('a document without a category is posted as Uncategorized', d && calls[0]?.body?.documents?.[0]?.category === 'Uncategorized', JSON.stringify(calls[0]?.body));

respond = () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'RAG features not available' }) });
let threw = null;
try { await indexDatasetDocuments('http://backend.test', [a]); } catch (e) { threw = e; }
check('a failed request throws with the backend\'s error (the page warns and still sends the turn)', threw && /RAG features not available/.test(threw.message), String(threw));

console.log(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
