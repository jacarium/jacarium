/**
 * Guards the AI-chat markdown rendering performance fix and its
 * no-visual-change contract (src/components/common/AIMessageMarkdown.jsx).
 *
 * Background: AIChatPage and AIChatSidebar used to call marked() inline
 * inside their messages.map(...) render bodies. During response streaming,
 * every SSE chunk triggers a setConversations() with a new messages array,
 * so EVERY assistant message in the conversation was re-parsed by marked()
 * on every single token - O(total conversation length) parse work per chunk
 * (measured: 5 marked() calls per chunk with 4 completed assistant messages
 * + 1 streaming). The fix extracts per-message rendering into the memoized
 * AIMessageMarkdown component so only the message whose content actually
 * changed is re-parsed (measured: exactly 1 call per chunk).
 *
 * What this test does:
 *  1. STREAMING RE-PARSE COUNT - mounts the REAL AIChatPage in jsdom with a
 *     seeded 8-message conversation (4 completed assistant messages, one of
 *     them with citations), drives a REAL streaming response through the
 *     component's own handleStreamingResponse via a mocked fetch that
 *     returns a controlled SSE ReadableStream, and counts marked() calls
 *     per streamed chunk (marked is wrapped by an esbuild alias shim).
 *     Asserts exactly 1 parse per chunk and that completed messages' DOM
 *     is untouched while streaming.
 *  2. BYTE-IDENTICAL OUTPUT - renders AIMessageMarkdown next to a verbatim
 *     copy of the pre-fix inline JSX (both AIChatPage's citation-processing
 *     IIFE and AIChatSidebar's div) via renderToStaticMarkup and asserts
 *     byte-identical HTML for realistic messages, including the citation
 *     filter/renumber path. One deliberate delta from the truly pre-fix
 *     code: commit 8983ee5 (security audit) later wrapped the component's
 *     marked() output in DOMPurify.sanitize(), so the legacy reference
 *     copies apply the same sanitize -- the check still pins the citation
 *     logic, class names, and DOM structure byte-for-byte.
 *  3. MEMO CONTRACT - parent re-renders with unchanged props must not
 *     re-invoke marked(); a content change must re-invoke it exactly once;
 *     citation clicks must still reach the handler with the right doc_id.
 *  4. STREAMING-APPEARANCE DOCUMENTATION - pins down how marked (17.x)
 *     renders truncated in-flight markdown (investigated 2026-07: unclosed
 *     **bold / `code` show as literal marker chars until the closing marker
 *     arrives, then snap correct; an unclosed ``` fence renders as an OPEN
 *     code block that correctly absorbs the streamed code - i.e. no broken
 *     intermediate states worth patching). These checks fail if a marked
 *     upgrade changes that behavior, at which point the conclusion should
 *     be revisited.
 *
 * Run:  node tests/ai-chat-markdown-rendering.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

// ---------- precondition checks ----------
function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('marked', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-markdown-rendering-'));

// ---------- test scaffolding ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- marked counting shim (aliased over 'marked' in the bundle) ----------
// The shim proxies the real marked so behavior is unchanged, but every
// invocation is recorded in globalThis.__markedCalls.
const realMarkedEntry = req.resolve('marked');
const SHIM = path.join(WORKDIR, 'marked-shim.mjs');
fs.writeFileSync(SHIM, `
import * as real from ${JSON.stringify(realMarkedEntry)};
globalThis.__markedCalls = [];
const counted = new Proxy(real.marked, {
  apply(target, thisArg, args) {
    globalThis.__markedCalls.push(String(args[0]).slice(0, 80));
    return Reflect.apply(target, thisArg, args);
  },
});
export { counted as marked };
`);

// ---------- harness entry (bundled with the REAL components) ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import AIChatPage from '@worktree/src/components/AIChatPage.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import AIMessageMarkdown from '@worktree/src/components/common/AIMessageMarkdown.jsx';

// ------- verbatim copies of the PRE-FIX inline rendering (the reference
// output the memoized component must reproduce byte-for-byte), except that
// marked() output goes through the same DOMPurify.sanitize() the component
// gained in commit 8983ee5 (XSS audit) -- an intentional post-fix change
// that this contract check must not flag -------

// AIChatPage.jsx (pre-fix lines 1260-1329): the citation-processing IIFE
function LegacyPageMessageBody({ msg, handleCitationClick }) {
  return (() => {
    // Process citations: filter referenced ones and renumber sequentially
    if (msg.citations && msg.citations.length > 0) {
      const referencedCitations = msg.citations.filter(citation => {
        const citationPattern = new RegExp(\`\\\\[\${citation.number}\\\\]\`, 'g');
        return citationPattern.test(msg.content);
      });

      if (referencedCitations.length > 0) {
        const citationMap = new Map();
        referencedCitations.forEach((citation, index) => {
          citationMap.set(citation.number, index + 1);
        });

        let processedContent = msg.content;
        const sortedCitations = [...referencedCitations].sort((a, b) => b.number - a.number);
        sortedCitations.forEach(citation => {
          const oldNumber = citation.number;
          const newNumber = citationMap.get(oldNumber);
          const pattern = new RegExp(\`\\\\[\${oldNumber}\\\\]\`, 'g');
          processedContent = processedContent.replace(pattern, \`[\${newNumber}]\`);
        });

        const renumberedCitations = referencedCitations.map((citation, index) => ({
          ...citation,
          displayNumber: index + 1
        }));

        return (
          <>
            <div
              className="prose prose-xs max-w-none text-xs dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(processedContent)) }}
            />
            <div className="mt-4 pt-3 border-t border-os-border">
              <div className="text-[10px] font-semibold text-os-text-muted mb-2">Sources:</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {renumberedCitations.map((citation) => (
                  <button
                    key={citation.number}
                    onClick={() => handleCitationClick(citation.doc_id)}
                    className="flex items-start gap-2 text-[10px] text-os-text-secondary hover:text-blue-500 transition-colors text-left p-2 rounded-sm hover:bg-os-card-secondary"
                  >
                    <span className="font-mono font-semibold text-os-text-muted shrink-0">[{citation.displayNumber}]</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{citation.doc_title}</div>
                      <div className="text-os-text-muted truncate">({citation.doc_category})</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        );
      }
    }

    return (
      <div
        className="prose prose-xs max-w-none text-xs dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(msg.content)) }}
      />
    );
  })();
}

// AIChatSidebar.jsx (pre-fix lines 1157-1168)
function LegacySidebarMessageBody({ msg }) {
  return (
    <div
      className={\`prose prose-xs max-w-none text-xs wrap-break-word overflow-hidden \${
        msg.role === 'user' ? 'prose-invert' : ''
      }\`}
      style={{
        overflowWrap: 'break-word',
        wordWrap: 'break-word',
        wordBreak: 'break-word'
      }}
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(msg.content)) }}
    />
  );
}

const PAGE_CLASS = "prose prose-xs max-w-none text-xs dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word";
const SIDEBAR_STYLE = { overflowWrap: 'break-word', wordWrap: 'break-word', wordBreak: 'break-word' };
const noop = () => {};

window.__harness = {
  React,
  marked,

  mountPage() {
    const root = createRoot(document.getElementById('root'));
    root.render(
      <NotificationProvider>
        <AIChatPage />
      </NotificationProvider>
    );
    return root;
  },

  // Section 2: legacy vs new static markup for one message fixture
  renderPagePair(msg) {
    return {
      legacy: renderToStaticMarkup(<LegacyPageMessageBody msg={msg} handleCitationClick={noop} />),
      current: renderToStaticMarkup(
        <AIMessageMarkdown
          content={msg.content}
          citations={msg.citations}
          onCitationClick={noop}
          className={PAGE_CLASS}
        />
      ),
    };
  },
  renderSidebarPair(msg) {
    return {
      legacy: renderToStaticMarkup(<LegacySidebarMessageBody msg={msg} />),
      current: renderToStaticMarkup(
        <AIMessageMarkdown
          content={msg.content}
          className={\`prose prose-xs max-w-none text-xs wrap-break-word overflow-hidden \${
            msg.role === 'user' ? 'prose-invert' : ''
          }\`}
          style={SIDEBAR_STYLE}
        />
      ),
    };
  },

  // Section 3: memo probe - parent re-renders with stable vs changed props
  mountMemoProbe(citations, onCitationClick) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const api = { container };
    function Probe() {
      const [, setTick] = React.useState(0);
      const [content, setContent] = React.useState('Hello **world**, see [1].');
      api.rerender = () => setTick((t) => t + 1);
      api.setContent = (c) => setContent(c);
      return (
        <AIMessageMarkdown
          content={content}
          citations={citations}
          onCitationClick={onCitationClick}
          className={PAGE_CLASS}
        />
      );
    }
    createRoot(container).render(<Probe />);
    return api;
  },
};
`);

// ---------- bundle with esbuild ----------
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      // count every marked() call made by the bundled components
      b.onResolve({ filter: /^marked$/ }, () => ({ path: SHIM }));
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

// ---------- jsdom environment ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('HTMLTextAreaElement', window.HTMLTextAreaElement);
define('HTMLInputElement', window.HTMLInputElement);
define('Element', window.Element);
define('Node', window.Node);
define('Event', window.Event);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

// ---------- seed conversation: 4 completed assistant messages (one with
// citations), so pre-fix code parses 4 completed + 1 streaming = 5 per chunk
const CITED = {
  role: 'assistant',
  content: 'Check the config [3] and also the runbook [10].\n\nUse `systemctl restart`.',
  citations: [
    { number: 3, doc_id: 'doc-cfg', doc_title: 'Config Guide', doc_category: 'Guides' },
    { number: 7, doc_id: 'doc-unref', doc_title: 'Unreferenced', doc_category: 'Misc' },
    { number: 10, doc_id: 'doc-run', doc_title: 'Runbook', doc_category: 'Ops' },
  ],
};
const SEEDED_MESSAGES = [
  { role: 'user', content: 'How do I fix the ssh timeout?' },
  { role: 'assistant', content: 'It is usually the **keepalive** setting.\n\n```bash\ngrep -i alive /etc/ssh/sshd_config\n```' },
  { role: 'user', content: 'What about the firewall?' },
  CITED,
  { role: 'user', content: 'Can you list the steps?' },
  { role: 'assistant', content: '1. Edit the config\n2. Restart the *service*\n3. Verify with `ssh -v`' },
  { role: 'user', content: 'Thanks. Anything else?' },
  { role: 'assistant', content: 'Also check **DNS resolution** on the host.' },
];
const conversation = {
  id: 1,
  name: 'Perf Test',
  createdAt: new Date().toISOString(),
  messages: SEEDED_MESSAGES,
  settings: { provider: 'anthropic', model: 'claude-test', temperature: 0, maxTokens: 200 },
};
window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation]));
window.localStorage.setItem('aiChatPageCurrentConversation', '1');

// ---------- mocked backend fetch (health, models, SSE chat stream) ----------
let streamController = null;
const encoder = new TextEncoder();
const json = (obj) => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/ai/health')) return json({ status: 'ok' });
  if (u.includes('/api/ai/models')) {
    return json({ anthropic: ['claude-test'], openai: [], gemini: [], ollama: [], ssh: [] });
  }
  if (u.includes('/api/ai/chat-stream')) {
    const stream = new ReadableStream({ start(c) { streamController = c; } });
    return new Response(stream, { status: 200 });
  }
  return new Response('not found', { status: 404 });
};
window.fetch = globalThis.fetch;

// keep the component's [Stream]/[Stream Debug] logging out of test output
const realLog = console.log;
console.log = () => {};

// ---------- load bundle, mount the real page ----------
createRequire(import.meta.url)(BUNDLE);
const harness = window.__harness;
const calls = () => globalThis.__markedCalls.length;

let exitCode = 1;
try {
  harness.mountPage();

  // wait for the page to finish its health/models/conversation loading
  let ta = null;
  for (let i = 0; i < 50 && !ta; i++) {
    await sleep(100);
    ta = [...window.document.querySelectorAll('textarea')]
      .find((t) => t.placeholder === 'Type your message...');
  }
  console.log = realLog;
  check('section 1: real AIChatPage mounted with seeded conversation', !!ta, ta ? undefined : 'textarea never appeared');

  const initialParses = calls();
  // the bubbles carry markdown-preview + sc-chat-markdown (the inert prose classes are gone);
  // the user's own messages render through the same component now, so 8 bubbles for 4 + 4 seeded messages
  const proseDivs = () => [...window.document.querySelectorAll('.sc-chat-markdown')];
  check('section 1: all 4 seeded assistant messages (and the 4 user messages) rendered as markdown',
    proseDivs().length === 8 && initialParses >= 8,
    `prose divs=${proseDivs().length}, marked calls at load=${initialParses}`);
  check('section 1: seeded citation message rendered with renumbered sources',
    window.document.body.textContent.includes('Config Guide') &&
    window.document.body.textContent.includes('Runbook') &&
    !window.document.body.textContent.includes('Unreferenced'));

  // snapshot a completed message's DOM node to prove streaming leaves it alone
  const completedNode = proseDivs().find((d) => d.innerHTML.includes('keepalive'));
  const completedHTMLBefore = completedNode.innerHTML;

  // ---- type a message and hit Enter (drives the REAL handleSendMessage) ----
  console.log = () => {};
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  valueSetter.call(ta, 'Now stream me an answer');
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(50);
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  for (let i = 0; i < 50 && !streamController; i++) await sleep(100);
  console.log = realLog;
  check('section 1: page issued the streaming request (mocked SSE stream attached)', !!streamController);

  // ---- stream a realistic markdown answer chunk by chunk, counting parses ----
  const CHUNKS = [
    'Here is', ' what I found about the **', 'connection', ' timeout**', ' issue.\n\n',
    'Run this', ':\n\n``', '`python\n', 'import socket\n', 'sock = socket.create_connection(("h", 22))\n',
    '``', '`\n\nThen check `KEEP', 'ALIVE_INTERVAL`', ' and *retry*.',
  ];
  const perChunk = [];
  console.log = () => {};
  for (const chunk of CHUNKS) {
    const before = calls();
    streamController.enqueue(encoder.encode(
      `data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`
    ));
    await sleep(90); // let the reader loop + React render settle
    perChunk.push(calls() - before);
  }
  streamController.close();
  await sleep(300);
  console.log = realLog;

  console.log(`    marked() calls per streamed chunk: [${perChunk.join(', ')}]`);
  console.log(`    (pre-fix this is 5 per chunk here: 4 completed assistant messages + the streaming one; scales with conversation length)`);
  check('section 1: every streamed chunk re-parses EXACTLY the one streaming message (1 marked call per chunk)',
    perChunk.length === CHUNKS.length && perChunk.every((n) => n === 1),
    `per-chunk counts: [${perChunk.join(', ')}]`);
  check('section 1: completed messages\' rendered DOM untouched during streaming',
    completedNode.isConnected && completedNode.innerHTML === completedHTMLBefore);

  const streamed = proseDivs().find((d) => d.innerHTML.includes('language-python'));
  check('section 1: streamed message finished with correctly rendered markdown',
    !!streamed &&
    streamed.innerHTML.includes('<strong>connection timeout</strong>') &&
    streamed.innerHTML.includes('<code>KEEPALIVE_INTERVAL</code>') &&
    streamed.innerHTML.includes('<em>retry</em>'),
    streamed ? streamed.innerHTML.slice(0, 200) : 'streamed message not found');

  // ================= section 2: byte-identical output vs pre-fix markup =====
  const fixtures = [
    { name: 'plain paragraph', msg: { role: 'assistant', content: 'Just a simple answer.' } },
    { name: 'bold/italic/inline-code/list', msg: { role: 'assistant', content: 'Use **bold**, *italic* and `code`.\n\n- one\n- two' } },
    { name: 'fenced code block', msg: { role: 'assistant', content: 'Try:\n\n```python\nprint("hi")\n```\n\nDone.' } },
    { name: 'citations referenced out of order (renumber path)', msg: CITED },
    {
      name: 'citations present but none referenced (plain path)',
      msg: { role: 'assistant', content: 'No refs here.', citations: [{ number: 5, doc_id: 'd', doc_title: 'T', doc_category: 'C' }] },
    },
    {
      name: 'ten+ citations ([1] vs [10] replacement ordering)',
      msg: {
        role: 'assistant',
        content: 'See [1] then [10] and [2].',
        citations: Array.from({ length: 10 }, (_, i) => ({
          number: i + 1, doc_id: `d${i + 1}`, doc_title: `Doc ${i + 1}`, doc_category: 'Cat',
        })),
      },
    },
  ];
  for (const { name, msg } of fixtures) {
    const { legacy, current } = harness.renderPagePair(msg);
    check(`section 2: AIChatPage output byte-identical - ${name}`, legacy === current,
      legacy === current ? undefined : `legacy:\n${legacy}\ncurrent:\n${current}`);
  }
  for (const role of ['assistant', 'user']) {
    const msg = { role, content: 'Sidebar **message** with `code`.' };
    const { legacy, current } = harness.renderSidebarPair(msg);
    check(`section 2: AIChatSidebar output byte-identical - ${role} message`, legacy === current,
      legacy === current ? undefined : `legacy:\n${legacy}\ncurrent:\n${current}`);
  }

  // ================= section 3: memo contract + citation click ==============
  const clicked = [];
  const stableClick = (id) => clicked.push(id);
  const stableCitations = [
    { number: 1, doc_id: 'doc-a', doc_title: 'Doc A', doc_category: 'Cat' },
  ];
  const probe = harness.mountMemoProbe(stableCitations, stableClick);
  await sleep(100);
  const afterMount = calls();
  probe.rerender(); await sleep(50);
  probe.rerender(); await sleep(50);
  probe.rerender(); await sleep(50);
  check('section 3: parent re-renders with unchanged content/citations do NOT re-invoke marked()',
    calls() === afterMount, `delta=${calls() - afterMount}`);
  probe.setContent('Changed **content**, see [1].');
  await sleep(50);
  check('section 3: content change re-invokes marked() exactly once', calls() === afterMount + 1,
    `delta=${calls() - afterMount}`);
  const srcButton = probe.container.querySelector('button');
  check('section 3: citations Sources button rendered', !!srcButton);
  srcButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  check('section 3: citation click reaches handler with the citation doc_id',
    clicked.length === 1 && clicked[0] === 'doc-a', JSON.stringify(clicked));

  // ================= section 4: in-flight (truncated) markdown appearance ===
  // Documents the task-2 investigation result; see file header. Uses the real
  // marked via the counting shim (behavior-identical).
  const m = harness.marked;
  check('section 4: unclosed **bold shows literal asterisks (self-corrects on close, no breakage)',
    m('text with **bold').includes('**bold') &&
    m('text with **bold** done').includes('<strong>bold</strong>'));
  check('section 4: unclosed `inline code shows a literal backtick, snaps on close',
    m('the `KEEP').includes('`KEEP') &&
    m('the `KEEP` done').includes('<code>KEEP</code>'));
  check('section 4: unclosed ``` fence renders as an OPEN code block absorbing streamed code (desired look)',
    m('```python\nimport socket\n').includes('<pre><code class="language-python">import socket') &&
    m('```python\nimport socket\n```\n\nafter').includes('<p>after</p>'));

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.log = realLog;
  console.error('TEST DRIVER ERROR:', e);
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  process.exit(exitCode);
}
