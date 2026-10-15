/**
 * Real-component-tree test client.
 * Mounts the REAL DocumentsPage (with real DocumentSidebar + DocumentEditor),
 * uses the REAL cloudWebSocket/cloudCentralSync/yjsProvider/documents modules,
 * talking to a REAL Jacarium central server over a REAL socket.io connection.
 * Controlled over stdin (JSON lines), reports over stdout ("@@RES"/"@@EVT" lines).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import readline from 'node:readline';
import DocumentsPage from '@worktree/src/components/DocumentsPage.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { startCloudSync } from '@worktree/src/utils/cloudSync.js';
import { createDocument, getDocuments } from '@worktree/src/utils/documents.js';
import { isWebSocketConnected } from '@worktree/src/utils/cloudWebSocket.js';

const out = (prefix, obj) => process.stdout.write(prefix + ' ' + JSON.stringify(obj) + '\n');
const res = (obj) => out('@@RES', obj);
const evt = (obj) => out('@@EVT', obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findDocRow(title) {
  const spans = Array.from(document.querySelectorAll('span'));
  return spans.find((s) => s.textContent === title) || null;
}

function fire(el, type, extra = {}) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 20, ...extra });
  el.dispatchEvent(ev);
}

function editorTextarea() {
  // The editor textarea is the only <textarea> in the tree (search box is an <input>)
  return document.querySelector('textarea');
}

function editorDocumentProp() {
  const ta = editorTextarea();
  if (!ta) return { error: 'no textarea mounted' };
  const key = Object.keys(ta).find((k) => k.startsWith('__reactFiber$'));
  if (!key) return { error: 'no react fiber on textarea' };
  // The DOM node's fiber pointer can lag one commit behind when a render
  // didn't touch the textarea host fiber itself, so props-only updates (e.g.
  // a refreshed `document` object) may only be visible on the OTHER fiber
  // tree. Walk up to the HostRoot to learn which tree is current, then read
  // the DocumentEditor's props from that tree.
  let docFiber = null;
  let fiber = ta[key];
  let top = fiber;
  while (fiber) {
    const t = fiber.type;
    const name = typeof t === 'function' ? (t.displayName || t.name) : null;
    if (name === 'DocumentEditor' && !docFiber) docFiber = fiber;
    top = fiber;
    fiber = fiber.return;
  }
  if (!docFiber) return { error: 'DocumentEditor fiber not found' };
  const walkedTreeIsCurrent = !top.stateNode || top.stateNode.current === top;
  const props = (walkedTreeIsCurrent ? docFiber.memoizedProps : docFiber.alternate?.memoizedProps)
    || docFiber.memoizedProps || {};
  const d = props.document || null;
  return {
    documentId: props.documentId ?? null,
    document: d && {
      id: d.id, title: d.title, inCloud: d.inCloud ?? null,
      cloudDocumentId: d.cloudDocumentId ?? null, ownerId: d.ownerId ?? null,
      cloudLastUpdated: d.cloudLastUpdated ?? null,
    },
  };
}

function typeText(text) {
  const ta = editorTextarea();
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value + text);
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  return { ok: true, value: ta.value };
}

// Insert text at the current caret position (real user-typing shape: value is
// spliced at selectionStart, caret advances, then an input event fires so the
// real React onChange -> yjs.updateContent path runs).
function typeAtCaret(text) {
  const ta = editorTextarea();
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  setter.call(ta, ta.value.slice(0, start) + text + ta.value.slice(end));
  ta.setSelectionRange(start + text.length, start + text.length);
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  return { ok: true };
}

function fireKeyup(ta) {
  ta.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'a' }));
}

// Find a rendered collaborative-cursor overlay by its user label.
// DocumentEditor renders: <div style={top,left}><div class="w-0.5 h-5 .."/>
//                           <div class=".. -top-5 ..">{name}</div></div>
function findCursorOverlay(name) {
  const label = Array.from(document.querySelectorAll('div'))
    .find((d) => d.className && String(d.className).includes('-top-5') && d.textContent === name);
  if (!label || !label.parentElement) return null;
  const st = label.parentElement.style;
  return { top: parseFloat(st.top), left: parseFloat(st.left) };
}

// State for the cursor watcher (MutationObserver-based renders recorder)
let cursorWatch = null;

function snapshotCursor(name) {
  const ta = editorTextarea();
  if (!ta) return null;
  const overlay = findCursorOverlay(name);
  const value = ta.value;
  const lastNl = value.lastIndexOf('\n');
  return {
    present: !!overlay,
    top: overlay ? overlay.top : null,
    left: overlay ? overlay.left : null,
    scrollTop: ta.scrollTop,
    scrollLeft: ta.scrollLeft,
    valueLen: value.length,
    lineCount: value.split('\n').length,
    lastLineLen: value.length - (lastNl + 1),
  };
}

async function docsReport() {
  const docs = await getDocuments();
  return docs.map((d) => ({
    id: d.id, title: d.title, inCloud: d.inCloud ?? null,
    cloudDocumentId: d.cloudDocumentId ?? null, ownerId: d.ownerId ?? null,
    cloudLastUpdated: d.cloudLastUpdated ?? null,
    contentLen: (d.content || '').length, content: d.content || '',
  }));
}

async function main() {
  // Optional multi-doc seeding: CREATE_DOCS_JSON is a JSON array of document
  // records created verbatim BEFORE the app mounts (same "existed in an
  // earlier session" simulation as CREATE_DOC_* below, but supports several
  // docs and arbitrary cloud metadata combinations - e.g. inCloud WITHOUT a
  // cloudDocumentId, the "cloud doc that never engaged Yjs" shape needed by
  // tests/doc-sync-targeted-updates.test.mjs).
  if (process.env.CREATE_DOCS_JSON) {
    for (const doc of JSON.parse(process.env.CREATE_DOCS_JSON)) {
      await createDocument({ category: 'General', ...doc });
    }
  }
  if (process.env.CREATE_DOC_TITLE) {
    await createDocument({
      title: process.env.CREATE_DOC_TITLE,
      content: process.env.CREATE_DOC_CONTENT || '',
      category: 'General',
      // Optional cloud metadata: simulates a machine that already has a local
      // IndexedDB copy of a previously-synced cloud document (fake-indexeddb
      // is per-process, so "opened it in an earlier session" must be seeded
      // this way). See tests/yjs-server-doc-load-failure.test.mjs.
      ...(process.env.CREATE_DOC_CLOUD_ID && {
        inCloud: true,
        cloudDocumentId: process.env.CREATE_DOC_CLOUD_ID,
        ownerId: process.env.CREATE_DOC_OWNER_ID || process.env.MACHINE_ID,
        cloudLastUpdated: Date.now(),
      }),
    });
  }

  await startCloudSync();

  const root = createRoot(document.getElementById('root'));
  // Plain createElement (no JSX) so this file stays lintable as a normal .mjs script
  root.render(
    React.createElement(NotificationProvider, null, React.createElement(DocumentsPage))
  );

  await sleep(500);
  evt({ ready: true, machineId: process.env.MACHINE_ID, connected: isWebSocketConnected() });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, cmd, args = {} } = msg;
    try {
      switch (cmd) {
        case 'status':
          res({ id, connected: isWebSocketConnected() });
          break;
        case 'docs':
          res({ id, docs: await docsReport() });
          break;
        case 'click-doc': {
          const el = findDocRow(args.title);
          if (!el) { res({ id, error: 'doc row not found: ' + args.title }); break; }
          fire(el, 'click');
          await sleep(300);
          res({ id, ok: true });
          break;
        }
        case 'ctx-doc': {
          const el = findDocRow(args.title);
          if (!el) { res({ id, error: 'doc row not found: ' + args.title }); break; }
          fire(el, 'contextmenu');
          await sleep(150);
          res({ id, ok: true, buttons: Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean) });
          break;
        }
        case 'click-menu': {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === args.label);
          if (!btn) { res({ id, error: 'menu button not found: ' + args.label }); break; }
          fire(btn, 'click');
          res({ id, ok: true });
          break;
        }
        case 'editor-doc':
          res({ id, ...editorDocumentProp() });
          break;
        // Grant another identity Read & Write on a document this machine
        // shares, through the real UI: context menu -> Manage Permissions ->
        // add the identity as Read & Write -> Save. The owner's client then
        // re-uploads the document with the new map, which the central server
        // records and enforces (yjs-update from anyone else is refused).
        case 'grant-write': {
          const el = findDocRow(args.title);
          if (!el) { res({ id, error: 'doc row not found: ' + args.title }); break; }
          fire(el, 'contextmenu');
          await sleep(150);
          const manage = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Manage Permissions');
          if (!manage) { res({ id, error: 'Manage Permissions not offered (not the owner, or not shared yet)' }); break; }
          fire(manage, 'click');
          await sleep(300);
          const input = Array.from(document.querySelectorAll('input')).find((i) => /Machine ID|identity/i.test(i.placeholder || ''));
          const select = Array.from(document.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'write'));
          if (!input || !select) { res({ id, error: 'permissions modal not found' }); break; }
          const setInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setInput.call(input, args.identity);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
          const setSelect = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setSelect.call(select, 'write');
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
          await sleep(50);
          const add = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Add');
          if (!add) { res({ id, error: 'Add button not found' }); break; }
          fire(add, 'click');
          await sleep(100);
          const save = Array.from(document.querySelectorAll('button')).find((b) => /^Save/.test(b.textContent.trim()));
          if (!save) { res({ id, error: 'Save button not found' }); break; }
          fire(save, 'click');
          await sleep(800);
          res({ id, ok: true });
          break;
        }
        // Rename a document through the real sidebar UI: double-click the row
        // (opens InlineEdit), type the new title, press Enter (commits via
        // onRenameDocument -> DocumentsPage.handleRenameDocument).
        case 'rename-doc': {
          const el = findDocRow(args.title);
          if (!el) { res({ id, error: 'doc row not found: ' + args.title }); break; }
          fire(el, 'dblclick');
          await sleep(200);
          const input = Array.from(document.querySelectorAll('input')).find((i) => i.value === args.title);
          if (!input) { res({ id, error: 'inline edit input not found for: ' + args.title }); break; }
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, args.newTitle);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
          await sleep(50);
          input.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
          await sleep(300);
          res({ id, ok: true });
          break;
        }
        case 'textarea': {
          const ta = editorTextarea();
          res({
            id,
            value: ta ? ta.value : null,
            readOnly: ta ? !!ta.readOnly : null,
            placeholder: ta ? ta.placeholder : null,
          });
          break;
        }
        // Whether the rendered page (outside the textarea's value) contains a
        // piece of text - used to assert banners are (not) shown.
        case 'page-contains':
          res({ id, contains: document.body.textContent.includes(args.text) });
          break;
        case 'type':
          res({ id, ...typeText(args.text) });
          break;
        case 'type-at':
          res({ id, ...typeAtCaret(args.text) });
          break;
        case 'set-cursor': {
          const ta = editorTextarea();
          if (!ta) { res({ id, error: 'no textarea' }); break; }
          ta.setSelectionRange(args.pos, args.selEnd ?? args.pos);
          fireKeyup(ta); // real path: onKeyUp -> handleCursorMove -> yjs.updateCursor
          res({ id, ok: true, pos: ta.selectionStart });
          break;
        }
        case 'scroll-to': {
          const ta = editorTextarea();
          if (!ta) { res({ id, error: 'no textarea' }); break; }
          ta.scrollTop = args.top || 0;
          ta.scrollLeft = args.left || 0;
          ta.dispatchEvent(new window.Event('scroll', { bubbles: false }));
          res({ id, ok: true, scrollTop: ta.scrollTop });
          break;
        }
        // Type text one character at a time at the caret, with a keyup after
        // each char (exactly like real typing: onChange then onKeyUp ->
        // handleCursorMove -> awareness update per keystroke).
        case 'burst-type': {
          const interval = args.intervalMs ?? 20;
          for (const ch of String(args.text)) {
            const r = typeAtCaret(ch);
            if (r.error) { res({ id, error: r.error }); break; }
            const ta = editorTextarea();
            if (ta) fireKeyup(ta);
            await sleep(interval);
          }
          res({ id, ok: true });
          break;
        }
        case 'cursor-overlay':
          res({ id, ...(snapshotCursor(args.name) || { error: 'no textarea' }) });
          break;
        // Record every rendered state of a named remote-cursor overlay.
        // A MutationObserver fires on each React commit that touches the DOM,
        // so brief transient (flickered) positions are captured even between
        // driver polls. Each sample pairs the overlay's rendered top/left with
        // the textarea content AT THAT INSTANT, so the driver can check every
        // rendered frame against ground truth.
        case 'watch-cursor': {
          if (cursorWatch) cursorWatch.obs.disconnect();
          const samples = [];
          const record = () => {
            const s = snapshotCursor(args.name);
            if (!s) return;
            const prev = samples[samples.length - 1];
            if (prev && prev.present === s.present && prev.top === s.top && prev.left === s.left
                && prev.valueLen === s.valueLen && prev.lineCount === s.lineCount
                && prev.lastLineLen === s.lastLineLen) return;
            samples.push(s);
          };
          const obs = new window.MutationObserver(record);
          obs.observe(document.getElementById('root'), {
            subtree: true, childList: true, attributes: true, characterData: true,
          });
          cursorWatch = { obs, samples };
          record();
          res({ id, ok: true });
          break;
        }
        case 'unwatch-cursor': {
          if (!cursorWatch) { res({ id, error: 'no watcher active' }); break; }
          cursorWatch.obs.disconnect();
          const samples = cursorWatch.samples;
          cursorWatch = null;
          res({ id, ok: true, samples });
          break;
        }
        default:
          res({ id, error: 'unknown cmd ' + cmd });
      }
    } catch (e) {
      res({ id, error: String(e && e.stack || e) });
    }
  });
}

main().catch((e) => {
  evt({ fatal: String(e && e.stack || e) });
  process.exit(1);
});
