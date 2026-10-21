#!/usr/bin/env node
/**
 * "Add as AI Context" sends the item's CONTENT, redacted with placeholders
 * the model cannot mistake for real values, in a new chat - and the user
 * has the say over the redaction (src/utils/aiContext.js, aiPrivacy.js,
 * src/components/common/AIChatSidebar.jsx, AIContextDialog.jsx).
 *   1. the detector: ghcr.io / quay.io / docker.io / registry.redhat.io /
 *      github.com / pypi.org, file names, path segments and version
 *      strings are not redacted; a private host, an IP, an email, a
 *      user name and a token are, as [REDACTED_TYPE_n], the same
 *      placeholder for every occurrence; the allow list (with subdomains)
 *      and the deny list are honoured; per-type switches, per-finding
 *      decisions and the chat switch; the block format and the note;
 *   2. the sidebar (real component in jsdom): addAIContext creates a NEW
 *      conversation on the default provider/model with the chip ("N
 *      hidden"); the first request's body carries the delimited block (the
 *      content, not metadata) with the note, exactly as the eye dialog
 *      shows; the eye dialog: findings with masked values, a per-item
 *      toggle un-redacts exactly that value, a per-type switch, the token
 *      warning, Never hide goes to the device list and survives a new chat,
 *      a hand edit is what gets sent, Reset reloads the document; a
 *      selection payload; the lists live in localStorage only;
 *   3. the lists never enter a settings payload (source).
 * Run: node tests/ai-context-content.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
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
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) { if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
for (const dep of ['fake-indexeddb', 'jsdom']) { if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed`); process.exit(0); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; let total = 0;
const report = console.log;
function check(name, cond, detail = '') { total += 1; if (cond) report(`PASS: ${name}`); else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

/* ---------- 1. the detector (plain ESM) ---------- */
// fake secrets assembled at run time, so the tracked file holds no secret-shaped literal (scripts/privacy-scan.sh)
const FAKE_GH = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
report('\n--- 1. the detector ---');
const C = await import(new URL('../src/utils/aiContext.js', import.meta.url).href);
const { redactText, formatContextBlock, buildContextMessage, REDACTION_NOTE, kanbanBoardMarkdown, documentContextPayload, selectionContextPayload, newContext, renderContext, maskValue } = C;
const SAMPLE = 'Pull ghcr.io/acme/app:1.2.3, quay.io/x/y and registry.redhat.io/ubi9 from github.com; pip from pypi.org. Runs on node-12 at 10.0.0.5 (also 10.0.0.5) via lab.corp.internal; file.tar.gz in /etc/host.conf, python3.11, v1.2.3.4. token=abcd1234secret user: robin mail bob@corp.example key ' + FAKE_GH + ' and 127.0.0.1';
let r = redactText(SAMPLE);
check('public registries, package indexes and vendors are not redacted (ghcr.io, quay.io, registry.redhat.io, github.com, pypi.org)', /ghcr\.io\/acme/.test(r.text) && /quay\.io\/x/.test(r.text) && /registry\.redhat\.io\/ubi9/.test(r.text) && /github\.com/.test(r.text) && /pypi\.org/.test(r.text), r.text);
check('file names, path segments, version strings and loopback are left alone', /file\.tar\.gz/.test(r.text) && /\/etc\/host\.conf/.test(r.text) && /python3\.11/.test(r.text) && /v1\.2\.3\.4/.test(r.text) && /127\.0\.0\.1/.test(r.text), r.text);
check('a private host, a numbered host, an IP, an email, a username and tokens are hidden as [REDACTED_TYPE_n]', /\[REDACTED_HOST_\d\]/.test(r.text) && !/lab\.corp\.internal/.test(r.text) && !/node-12/.test(r.text) && !/10\.0\.0\.5/.test(r.text) && !/bob@corp/.test(r.text) && !/abcd1234secret/.test(r.text) && !/ghp_abcdef/.test(r.text) && !/\brobin\b/.test(r.text), r.text);
check('the same value gets the same placeholder every time (10.0.0.5 twice -> one ip-1, count 2)', (r.text.match(/\[REDACTED_IP_1\]/g) || []).length === 2 && r.findings.find((f) => f.type === 'ip').count === 2, r.text);
check('the findings carry type, value, placeholder and hidden', r.findings.some((f) => f.type === 'token' && f.value.startsWith('ghp_') && f.hidden) && r.findings.some((f) => f.type === 'email' && f.value === 'bob@corp.example') && r.findings.some((f) => f.type === 'username' && f.value === 'robin'), JSON.stringify(r.findings.map((f) => [f.type, f.value])));
const policyOff = { enabled: true, types: { token: true, host: false, ip: true, email: true, username: true } };
r = redactText(SAMPLE, { policy: policyOff });
check('a per-type switch off sends every value of that type as it is (hosts), the others stay hidden', /lab\.corp\.internal/.test(r.text) && /node-12/.test(r.text) && !/10\.0\.0\.5/.test(r.text) && r.findings.filter((f) => f.type === 'host').every((f) => !f.hidden));
r = redactText(SAMPLE, { decisions: { 'ip:10.0.0.5': 'send' } });
check('a per-finding decision un-redacts exactly that value', /10\.0\.0\.5 \(also 10\.0\.0\.5\)/.test(r.text) && !/lab\.corp\.internal/.test(r.text));
r = redactText(SAMPLE, { allow: ['corp.internal'] });
check('the allow list covers a host and its subdomains and the email domain stays (the address itself is still an email finding)', /lab\.corp\.internal/.test(r.text) && r.findings.some((f) => f.type === 'email'));
r = redactText('Deploy acme-widget to prod; the acme-widget pipeline.', { deny: ['acme-widget'] });
check('the deny list hides a value the rules would let through, as a "custom" finding', !/acme-widget/.test(r.text) && r.findings[0].type === 'custom' && r.findings[0].count === 2, r.text);
r = redactText(SAMPLE, { policy: { enabled: false, types: {} } });
check('the chat switch off sends everything as it is', r.text === SAMPLE && r.findings.every((f) => !f.hidden));
check('a password assignment, a Bearer token, a JWT and an AWS key are tokens; a placeholder value (<secret>) is not', (() => { const t = redactText('password: hunter2x Authorization: Bearer abcdefghijklmnopqrstu eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk ' + FAKE_AWS + ' api_key=<your-key>'); return t.findings.filter((f) => f.type === 'token').length === 4 && /api_key=<your-key>/.test(t.text); })());
check('maskValue keeps the shape, not the value', maskValue('' + FAKE_GH + '') === 'gh••••••••89' && maskValue('abc') === '•••');
const block = formatContextBlock({ title: 'Runbook', category: 'Ops', text: 'line 1\nline 2\n' });
check('the block: header with title and category, the content, the end marker', block === '--- Document: Runbook (category: Ops) ---\nline 1\nline 2\n--- End of document ---', JSON.stringify(block));
check('a selection block and a board block have their own markers', formatContextBlock({ kind: 'selection', title: 'Runbook', text: 'x' }) === '--- Selection from document: Runbook ---\nx\n--- End of selection ---' && /^--- Kanban board: B \(category: Work\) ---\n/.test(formatContextBlock({ kind: 'kanban', title: 'B', category: 'Work', text: 'x' })) && /--- End of board ---$/.test(formatContextBlock({ kind: 'kanban', title: 'B', text: 'x' })));
const msg = buildContextMessage([formatContextBlock({ title: 'A', text: 'host [REDACTED_HOST_1]' })], 'why?');
check('the message carries the redaction note when a placeholder is in it, then the blocks, then the question; no note without placeholders', msg.includes(REDACTION_NOTE) && msg.endsWith('\n\nQuestion: why?') && msg.indexOf(REDACTION_NOTE) < msg.indexOf('--- Document: A ---') && !buildContextMessage([formatContextBlock({ title: 'A', text: 'clean' })], 'q').includes('REDACTED'), msg);
check('a board renders as markdown: a section per column, cards as a list with description', kanbanBoardMarkdown({ columns: [{ id: 'todo', title: 'To Do' }, { id: 'done', title: 'Done' }] }, [{ title: 'Fix', status: 'todo', description: 'd' }, { title: 'Ship', status: 'done' }]) === '## To Do\n- **Fix**\n  d\n\n## Done\n- **Ship**');
check('the document payload carries the content, not the metadata', JSON.stringify(documentContextPayload({ id: 7, title: 'T', category: 'C', content: 'body', locked: false, stableId: 'x' })) === JSON.stringify({ kind: 'document', title: 'T', category: 'C', content: 'body', source: { kind: 'document', id: 7 } }));
const ctx = newContext(selectionContextPayload({ id: 1, title: 'Doc' }, 'on node-3 and ghcr.io'));
let rc = renderContext(ctx);
check('renderContext: the block over the redacted text, the hidden count; a hand edit freezes the text', rc.text === '--- Selection from document: Doc ---\non [REDACTED_HOST_1] and ghcr.io\n--- End of selection ---' && rc.hidden === 1 && renderContext({ ...ctx, manual: 'my own text' }).text === 'my own text' && renderContext({ ...ctx, manual: 'my own text' }).edited === true, rc.text);

/* ---------- 2. the sidebar ---------- */
report('\n--- 2. the AI chat sidebar ---');
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AIChatSidebar from '@worktree/src/components/common/AIChatSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { db } from '@worktree/src/db/database.js';
import * as privacy from '@worktree/src/utils/aiPrivacy.js';
let setView = null; let key = 0;
function Host() { const [view, set] = React.useState(null); setView = set; if (!view) return null; return React.createElement(AIChatSidebar, { key: view.key, isOpen: true, onClose: () => {} }); }
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
window.__harness = { mount: () => whenReady(() => setView({ key: ++key })), unmount: () => whenReady(() => setView(null)), db, privacy };
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Host)));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'warning',
});
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver); window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {}; window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
const MODELS = { ollama: ['qwen3:30b', 'llama3'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } };
const requests = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url, options = {}) => {
  const u = String(url);
  if (/\/api\/ai\/health/.test(u)) return json({ status: 'online' });
  if (/\/api\/ai\/models/.test(u)) return json(MODELS);
  if (/\/api\/ai\/chat$/.test(u)) { requests.push(JSON.parse(options.body || '{}')); return json({ message: 'ANSWER' }); }
  return json({}, 404);
};
define('fetch', stubFetch); window.fetch = stubFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = process.env.VERBOSE ? (fn) => fn : (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|^===|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);
createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const setNative = (el, value) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const DOC = 'Pull ghcr.io/acme/app:1.2.3 on node-12 at 10.0.0.5 via lab.corp.internal. token=abcd1234secret';
const docId = await H.db.documents.add({ title: 'Runbook', content: DOC, category: 'Ops', createdAt: new Date(), updatedAt: new Date() });
window.localStorage.clear();
H.mount();
await waitFor(() => $('textarea'));
await sleep(300);
const chatInput = () => $$('textarea').find((t) => /Type your message|No AI models|offline/.test(t.placeholder));
const convName = () => $$('span').find((s) => /Chat|Conversation/.test(s.textContent) && s.classList.contains('truncate'))?.textContent.trim();
const payload = documentContextPayload({ id: docId, title: 'Runbook', category: 'Ops', content: DOC });
const before = convName();
window.dispatchEvent(new window.CustomEvent('addAIContext', { detail: { contextData: payload } }));
const chip = await waitFor(() => $('[data-testid="ai-context-chip"]'));
check('addAIContext opens a NEW conversation (its name carries the document) with the chip "Document: Runbook" and the hidden count', !!chip && convName() !== before && /Runbook - Chat/.test(convName() || '') && /Document: Runbook/.test(chip.textContent) && /4 hidden/.test($('[data-testid="ai-context-summary"]').textContent), `${convName()} | ${chip?.textContent}`);
const stored = () => JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => /aiChatConversations/.test(k))) || '[]');
check('...on the default provider / model (ollama / qwen3:30b)', stored()[0]?.settings?.provider === 'ollama' && stored()[0]?.settings?.model === 'qwen3:30b', JSON.stringify(stored()[0]?.settings));
// the eye: exactly what is sent
click($('[data-testid="ai-context-eye"]'));
const dialog = await waitFor(() => $('[data-testid="ai-context-dialog"]'));
const expectedText = '--- Document: Runbook (category: Ops) ---\nPull ghcr.io/acme/app:1.2.3 on [REDACTED_HOST_1] at [REDACTED_IP_1] via [REDACTED_HOST_2]. token=[REDACTED_TOKEN_1]\n--- End of document ---';
check('the eye dialog shows the delimited block (content, redacted), as plain text, with the explanation line', !!dialog && $('[data-testid="ctx-text"]').value === expectedText && /This is exactly what the AI receives/.test(dialog.textContent), $('[data-testid="ctx-text"]')?.value);
check('the findings list: 4 findings, values masked, placeholders, each hidden', $$('[data-testid^="ctx-finding-"][data-hidden]').length === 4 && $$('[data-testid^="ctx-finding-"][data-hidden]').every((f) => f.getAttribute('data-hidden') === 'true') && /ab•+et/.test(dialog.textContent) && !/abcd1234secret/.test(dialog.textContent), dialog.textContent.slice(0, 400));
// the dialog's tabs: Document (default, the text) and Privacy (the switches, with the count)
const shown = (id) => !!$(`[data-testid="${id}"]`) && !$(`[data-testid="${id}"]`).hidden;
check('the Document tab is the default: its panel shows the text, the Privacy panel is hidden, the summary badge reads "4 of 4 hidden"', $('[data-testid="ctx-tab-text"]').getAttribute('aria-selected') === 'true' && $('[data-testid="ctx-tab-text"]').textContent === 'Document' && shown('ctx-panel-text') && !shown('ctx-panel-privacy') && $('[data-testid="ctx-summary"]').textContent === '4 of 4 hidden', $('[data-testid="ctx-summary"]')?.textContent);
check('the Privacy tab carries the count badge "Privacy 4/4"', $('[data-testid="ctx-tab-privacy"]').textContent === 'Privacy 4/4', $('[data-testid="ctx-tab-privacy"]').textContent);
click($('[data-testid="ctx-tab-privacy"]')); await sleep(30);
check('the Privacy tab shows the master switch, the per-type switches and the findings; the text panel is hidden', shown('ctx-panel-privacy') && !shown('ctx-panel-text') && shown('ctx-redaction-switch') && shown('ctx-types') && shown('ctx-findings'));
click($('[data-testid="ctx-finding-value-token:abcd1234secret"]')); await sleep(30);
check('click-to-reveal shows the value', /abcd1234secret/.test($('[data-testid="ctx-finding-value-token:abcd1234secret"]').textContent));
click($('[data-testid="ctx-finding-toggle-ip:10.0.0.5"]')); await sleep(30);
check('...the badge and the summary follow live: "Privacy 3/4", "3 of 4 hidden"', $('[data-testid="ctx-tab-privacy"]').textContent === 'Privacy 3/4' && $('[data-testid="ctx-summary"]').textContent === '3 of 4 hidden', $('[data-testid="ctx-tab-privacy"]').textContent);
click($('[data-testid="ctx-tab-text"]')); await sleep(30);
check('back on the Document tab the text reflects the Privacy choices', shown('ctx-panel-text') && /at 10\.0\.0\.5 via \[REDACTED_HOST_2\]/.test($('[data-testid="ctx-text"]').value));
click($('[data-testid="ctx-tab-privacy"]')); await sleep(30);
check('a per-item toggle un-redacts exactly that value in the preview', /at 10\.0\.0\.5 via \[REDACTED_HOST_2\]/.test($('[data-testid="ctx-text"]').value) && $('[data-testid="ctx-finding-ip:10.0.0.5"]').getAttribute('data-hidden') === 'false', $('[data-testid="ctx-text"]').value);
click($('[data-testid="ctx-type-toggle-host"]')); await sleep(30);
check('the Hosts switch sends every host as it is', /on node-12 at 10\.0\.0\.5 via lab\.corp\.internal/.test($('[data-testid="ctx-text"]').value), $('[data-testid="ctx-text"]').value);
click($('[data-testid="ctx-type-toggle-token"]')); await sleep(30);
check('Tokens & keys off shows the warning and sends the token', !!$('[data-testid="ctx-tokens-warning"]') && /token=abcd1234secret/.test($('[data-testid="ctx-text"]').value));
click($('[data-testid="ctx-type-toggle-token"]')); await sleep(30);
check('...and on again hides it (tokens stay hidden unless explicitly toggled)', !$('[data-testid="ctx-tokens-warning"]') && /token=\[REDACTED_TOKEN_1\]/.test($('[data-testid="ctx-text"]').value));
click($('[data-testid="ctx-save"]'));
await waitFor(() => (!$('[data-testid="ai-context-dialog"]') ? true : null));
check('Save keeps the choices: the chip now reads 1 hidden', /1 hidden/.test($('[data-testid="ai-context-summary"]').textContent), $('[data-testid="ai-context-summary"]').textContent);
// send
requests.length = 0;
setNative(chatInput(), 'what is this?'); await sleep(30);
click($$('button').find((b) => b.querySelector('svg.lucide-send')) || $$('button').find((b) => /send/i.test(b.getAttribute('title') || '')));
await waitFor(() => (requests.length ? true : null));
const sentText = requests[0]?.messages?.[0]?.content || '';
check('the request body carries the delimited content block exactly as the preview showed, with the redaction note and the question; no metadata JSON', requests.length === 1 && sentText.includes('--- Document: Runbook (category: Ops) ---\nPull ghcr.io/acme/app:1.2.3 on node-12 at 10.0.0.5 via lab.corp.internal. token=\[REDACTED_TOKEN_1\]\n--- End of document ---') && sentText.includes(REDACTION_NOTE) && sentText.endsWith('Question: what is this?') && !/stableId|"locked"|updatedAt/.test(sentText) && requests[0].provider === 'ollama' && requests[0].model === 'qwen3:30b', sentText);
await waitFor(() => (/ANSWER/.test(document.body.textContent) ? true : null));
check('the answer lands in the new chat', /ANSWER/.test(document.body.textContent));
// a hand edit is what gets sent; Reset reloads the document
click($('[data-testid="ai-context-eye"]'));
await waitFor(() => $('[data-testid="ai-context-dialog"]'));
setNative($('[data-testid="ctx-text"]'), 'My own note about the runbook.'); await sleep(30);
check('a hand edit freezes the text: the switches are disabled and the note says so on both tabs; the summary reads "edited"', !!$('[data-testid="ctx-edited-note"]') && !!$('[data-testid="ctx-edited-note-privacy"]') && $('[data-testid="ctx-type-toggle-host"]').disabled === true && /\u00b7 edited$/.test($('[data-testid="ctx-summary"]').textContent), $('[data-testid="ctx-summary"]')?.textContent);
click($('[data-testid="ctx-save"]'));
await waitFor(() => (!$('[data-testid="ai-context-dialog"]') ? true : null));
check('...the chip reads edited', /edited/.test($('[data-testid="ai-context-summary"]').textContent));
requests.length = 0;
setNative(chatInput(), 'and now?'); await sleep(30);
click($$('button').find((b) => b.querySelector('svg.lucide-send')));
await waitFor(() => (requests.length ? true : null));
check('an edited context is re-sent on the next message exactly as edited', requests[0].messages.at(-1).content.includes('My own note about the runbook.') && !requests[0].messages.at(-1).content.includes('--- Document'), requests[0].messages.at(-1).content);
await H.db.documents.update(docId, { content: 'Updated runbook on node-7.' });
click($('[data-testid="ai-context-eye"]'));
await waitFor(() => $('[data-testid="ai-context-dialog"]'));
click($('[data-testid="ctx-reset"]'));
await waitFor(() => (/Updated runbook/.test($('[data-testid="ctx-text"]').value) ? true : null));
check('Reset to the document reloads the current content, drops the edit and keeps the chat\'s privacy choices (Hosts still "Send all")', $('[data-testid="ctx-text"]').value === '--- Document: Runbook (category: Ops) ---\nUpdated runbook on node-7.\n--- End of document ---' && !$('[data-testid="ctx-edited-note"]') && !$('[data-testid="ctx-type-toggle-host"]').disabled && $('[data-testid="ctx-type-toggle-host"]').getAttribute('aria-checked') === 'false', $('[data-testid="ctx-text"]').value);
click($('[data-testid="ctx-type-toggle-host"]')); await sleep(30);
check('Hosts back to "Hide all": node-7 redacted afresh', /on \[REDACTED_HOST_1\]\./.test($('[data-testid="ctx-text"]').value), $('[data-testid="ctx-text"]').value);
// Never hide -> the device list, honoured in a later chat
click($('[data-testid="ctx-finding-allow-host:node-7"]')); await sleep(30);
check('Never hide puts the value on the device allow list and the preview sends it', H.privacy.getPrivacyLists().allow.includes('node-7') && /on node-7\./.test($('[data-testid="ctx-text"]').value) && JSON.parse(window.localStorage.getItem('jacarium.aiPrivacy')).allow.includes('node-7'));
click($('[data-testid="ctx-cancel"]'));
await waitFor(() => (!$('[data-testid="ai-context-dialog"]') ? true : null));
window.dispatchEvent(new window.CustomEvent('addAIContext', { detail: { contextData: selectionContextPayload({ id: docId, title: 'Runbook', category: 'Ops' }, 'see node-7 and node-8 at ghcr.io') } }));
await waitFor(() => (/Selection: Runbook/.test($('[data-testid="ai-context-chip"]')?.textContent || '') ? true : null));
click($('[data-testid="ai-context-eye"]'));
await waitFor(() => $('[data-testid="ai-context-dialog"]'));
check('a selection payload: its own chip and block; the allow list is honoured across chats (node-7 sent, node-8 hidden)', $('[data-testid="ctx-text"]').value === '--- Selection from document: Runbook ---\nsee node-7 and [REDACTED_HOST_1] at ghcr.io\n--- End of selection ---', $('[data-testid="ctx-text"]').value);
click($('[data-testid="ctx-cancel"]'));
check('the allow / deny lists live in localStorage on this device only (jacarium.aiPrivacy), not with the conversations', !!window.localStorage.getItem('jacarium.aiPrivacy') && !JSON.stringify(stored()).includes('"allow"'));

/* ---------- 3. never in a settings payload; the placeholder format ---------- */
report('\n--- 3. the settings scopes, the placeholder format ---');
const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
{
  const { marked } = req('marked');
  const sample = 'See [REDACTED_HOST_1] and [REDACTED_IP_2].\n\n[REDACTED_HOST_1]: 10.0.0.5\n\n```\n[REDACTED_HOST_1]: in code\n```\n';
  const html = marked(C.protectPlaceholdersForMarkdown(sample));
  check('placeholders are ASCII [REDACTED_TYPE_n]: a bare one renders as plain text in a bubble, never a link', /\[REDACTED_HOST_1\] and \[REDACTED_IP_2\]/.test(html) && !/<a /.test(html), html);
  check('a placeholder at a line start followed by a colon (a link reference definition to marked) is kept in the bubble, and left alone inside fenced code', /\[REDACTED_HOST_1\]: 10\.0\.0\.5/.test(html) && /<code>\[REDACTED_HOST_1\]: in code/.test(html), html);
  check('(without the protection marked takes that line as a link reference definition: the line vanishes and the earlier placeholder becomes a link)', !/\]: 10\.0\.0\.5/.test(marked(sample)) && /<a href="10\.0\.0\.5"/.test(marked(sample)), marked(sample));
  check('the model instruction names the [REDACTED_...] placeholders', /\[REDACTED_\.\.\.\]/.test(REDACTION_NOTE) && /keep them as they are/.test(REDACTION_NOTE), REDACTION_NOTE);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const guillemets = walk(path.join(REPO, 'src')).filter((f) => /\.(js|jsx|css|md)$/.test(f) && /[\u00ab\u00bb]/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(REPO, f));
  check('no «» guillemets remain anywhere in src (nor in this test)', guillemets.length === 0 && !/[\u00ab\u00bb]/.test(src('tests/ai-context-content.test.mjs').replace(/no [\u00ab\u00bb]+ guillemets/, '')), guillemets.join(', '));
}
check('settingsStore.js and the copy sheet know nothing of the privacy lists; the lists module never touches the settings store', !/aiPrivacy|PRIVACY_STORAGE/.test(src('src/services/settingsStore.js')) && !/aiPrivacy/.test(src('src/components/common/modals/settings/CopySettingsSheet.jsx')) && !/settingsStore|homeServer/.test(src('src/utils/aiPrivacy.js')));
check('the four "Add as AI Context" sources send the content payloads (document / board), and the selection menu offers the new entry', /documentContextPayload\(freshDoc\)/.test(src('src/components/features/documents/DocumentSidebar.jsx')) && /documentContextPayload\(doc\)/.test(src('src/components/DocumentsPage.jsx')) && /kanbanContextPayload\(board, cards\)/.test(src('src/components/KanbanPage.jsx')) && /kanbanContextPayload\(board, cards\)/.test(src('src/components/kanban/KanbanBoardList.jsx')) && /selectionContextPayload\(document, text\)/.test(src('src/components/features/documents/DocumentEditor.jsx')) && /Add as AI Context/.test(src('src/components/features/documents/TextSelectionMenu.jsx')));

report(`\n${total - failures}/${total} checks passed`);
H.unmount();
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
