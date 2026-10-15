#!/usr/bin/env node

/**
 * End-to-end smoke check of the Workflow Builder canvas in a REAL browser
 * (headless Chrome driven over the DevTools protocol - no puppeteer/playwright
 * needed, Node's built-in WebSocket + fetch are enough).
 *
 * Complements tests/workflow-canvas-interactions.test.mjs (jsdom cannot run
 * d3-drag / React Flow's pointer machinery). What this proves against the
 * real renderer:
 *   - the standalone workflow page boots and a new workflow renders a canvas
 *     with nodes, edges, minimap, controls and the Run/Stop/Clear toolbar;
 *   - Run completes without exceptions; Clear leaves the nodes in place;
 *   - Note and Idea nodes can be dropped through the palette's DataTransfer
 *     path, are editable, and never light up as "processing" during a run;
 *   - a mousedown on a `nodrag` element does NOT move the node while the
 *     same gesture on the node header does (the original "copy moves the
 *     node" bug);
 *   - Ctrl+C with highlighted text is left to the browser (native copy),
 *     Ctrl+C with a selected node and no text selection copies the node,
 *     and Ctrl+V pastes it;
 *   - visual stacking, asserted with document.elementFromPoint on the region
 *     where two ordinary nodes overlap: selecting a node never lifts it above
 *     others (elevateNodesOnSelect/elevateEdgesOnSelect are off - the default
 *     +1000 boost made "Send to Back" look broken while the node was still
 *     selected), and the right-click layer menu (Bring to Front / Bring
 *     Forward / Send Backward / Send to Back) changes what is visibly on top
 *     immediately;
 *   - the MiniMap paints its (SVG, DOM-ordered) node rects in the same order
 *     as the canvas stacking, in both directions of the layer menu;
 *   - the drag-select box selects a node it only partially overlaps
 *     (selectionMode Partial) while a box that stops short of a node does
 *     not select it;
 *   - pins are the React Flow handles themselves, drawn on the node's border
 *     (exec pins white triangles, data pins purple circles) so a wire ends
 *     exactly at its pin; the wires carry no arrowhead markers and the
 *     execution edge's outline follows its selected state;
 *   - the node menu's Clear Execution Pins / Clear Data Pins remove only that
 *     edge type on that node and disable themselves when nothing is attached;
 *   - the node palette list is bounded by its resizable pane: its scroll
 *     range ends exactly at the last card, which is fully visible when
 *     scrolled to the bottom, in every category collapse state;
 *   - a real (trusted-input) marquee that sweeps across nodes with text
 *     (textarea, input, selectable JSON output) selects the nodes but leaves
 *     no native text highlight, while a drag that starts inside a field or
 *     the JSON output still selects that text;
 *   - per-category collapse state of the palette is persisted (localStorage)
 *     and restored after leaving the page and coming back;
 *   - no uncaught exceptions / console errors are logged along the way.
 *
 * Deliberately NOT named *.test.mjs: tests/run-all.sh auto-runs that glob,
 * and this check needs Google Chrome and a Vite dev server (started here on
 * a private port and stopped again). Run it by hand:
 *
 *   node tests/workflow-canvas-smoke.mjs
 *
 * Environment:
 *   CHROME_BIN   path to a Chrome/Chromium binary (auto-detected on macOS /
 *                Linux PATH when unset)
 *   SMOKE_PORT   dev-server port (default 5199)
 *
 * Exit code: 0 = all checks passed, 1 = a check failed or Chrome is missing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 5199);
const DEBUG_PORT = PORT + 1000;
const URL = `http://localhost:${PORT}/?standalone=workflow`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('FAIL: no Chrome/Chromium binary found - set CHROME_BIN=/path/to/chrome');
  process.exit(1);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- 1. Vite dev server ----------
// Spawn vite's bin directly (not via npx) so kill() reliably stops the server.
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { // up to 60s: Vite may re-optimize deps after a lockfile change
  try { ready = (await fetch(`http://localhost:${PORT}/`)).ok; } catch { await sleep(250); }
}
if (!ready) {
  await stop(vite);
  console.error(`FAIL: Vite dev server did not come up on :${PORT}`);
  process.exit(1);
}

// ---------- 2. Headless Chrome over CDP ----------
const profile = mkdtempSync(path.join(tmpdir(), 'workflow-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});
const cleanup = async () => {
  await stop(chrome); // wait: Chrome keeps writing its profile until it has exited
  await stop(vite);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
};

let exitCode = 1;
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    try { targets = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json(); } catch { await sleep(250); }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('ERROR: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(5000);

  // ---------- 3. Probes ----------
  // With selectionOnDrag React Flow ignores pane *clicks*; selection is reset on
  // pane mousedown, so "click empty canvas to deselect" is mousedown + mouseup.
  const deselectAll = async () => {
    await evaluate(`(() => { const pane = document.querySelector('.react-flow__pane');
      const o = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, view: window };
      pane.dispatchEvent(new MouseEvent('mousedown', o)); pane.dispatchEvent(new MouseEvent('mouseup', o)); })()`);
    await sleep(150);
  };

  const initial = await evaluate(`({
    empty: !!Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes('No Workflow Selected')),
    notes: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('Notes'))
  })`);
  check('page boots to the empty state with a Notes palette category', initial.empty && initial.notes, JSON.stringify(initial));

  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('New Workflow')).click()`);
  await sleep(2500);

  const canvas = await evaluate(`({
    nodes: document.querySelectorAll('.react-flow__node').length,
    edges: document.querySelectorAll('.react-flow__edge').length,
    nodrag: document.querySelectorAll('.react-flow__node .nodrag').length,
    toolbar: ['Run workflow','Stop execution','Clear node outputs'].map(t => { const b = document.querySelector('button[title="'+t+'"]'); return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing'; }),
    minimap: !!document.querySelector('.react-flow__minimap'),
    controls: document.querySelectorAll('.react-flow__controls-button').length
  })`);
  check('new workflow renders Begin Play -> Result with toolbar, minimap and controls',
    canvas.nodes === 2 && canvas.edges === 1 && canvas.nodrag > 0 && canvas.minimap && canvas.controls > 0 &&
    JSON.stringify(canvas.toolbar) === '["enabled","disabled","enabled"]', JSON.stringify(canvas));

  await evaluate(`document.querySelector('button[title="Run workflow"]').click()`);
  await sleep(3000);
  await evaluate(`document.querySelector('button[title="Clear node outputs"]').click()`);
  await sleep(300);
  const afterClear = await evaluate(`({ nodes: document.querySelectorAll('.react-flow__node').length, run: document.querySelector('button[title="Run workflow"]').disabled })`);
  check('Run then Clear completes and keeps both nodes', afterClear.nodes === 2 && afterClear.run === false, JSON.stringify(afterClear));

  await evaluate(`(() => {
    const pane = document.querySelector('.react-flow__pane');
    const rect = pane.getBoundingClientRect();
    for (const [type, dx] of [['note', 100], ['idea', 420]]) {
      const dt = new DataTransfer();
      dt.setData('application/reactflow', type);
      pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.left + dx, clientY: rect.top + 520, dataTransfer: dt }));
    }
  })()`);
  await sleep(800);
  const dropped = await evaluate(`({ nodes: document.querySelectorAll('.react-flow__node').length, note: document.querySelectorAll('.workflow-note').length, idea: document.querySelectorAll('.workflow-idea').length, handles: document.querySelectorAll('.workflow-link-handle').length })`);
  check('Note and Idea nodes drop onto the canvas via the palette DataTransfer path',
    dropped.nodes === 4 && dropped.note === 1 && dropped.idea === 1 && dropped.handles === 8, JSON.stringify(dropped));

  const typed = await evaluate(`(() => { const ta = document.querySelector('.workflow-note textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'hello mind map'); ta.dispatchEvent(new Event('input', { bubbles: true })); return ta.value; })()`);
  check('Note textarea is editable', typed === 'hello mind map');

  await evaluate(`document.querySelector('button[title="Run workflow"]').click()`);
  await sleep(150);
  const noteRun = await evaluate(`document.querySelectorAll('.workflow-note.workflow-node-processing, .workflow-idea.workflow-node-processing').length`);
  check('Note/Idea nodes never show a processing state during a run', noteRun === 0);
  await sleep(3000);

  // Select the first node (React Flow selects on drag-start)
  await evaluate(`(() => {
    const node = document.querySelector('.react-flow__node');
    const r = node.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, clientX: r.left + 20, clientY: r.top + 10, view: window };
    node.dispatchEvent(new MouseEvent('mousedown', o));
    document.dispatchEvent(new MouseEvent('mouseup', o));
    node.dispatchEvent(new MouseEvent('click', o));
  })()`);
  await sleep(300);
  check('mousedown on a node selects it', (await evaluate(`document.querySelectorAll('.react-flow__node.selected').length`)) === 1);

  const copyText = await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('span')).find(s => s.textContent.trim() === 'Note');
    label.style.userSelect = 'text';
    const range = document.createRange(); range.selectNodeContents(label);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const ev = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return { selection: sel.toString(), prevented: ev.defaultPrevented };
  })()`);
  check('Ctrl+C with highlighted text is left to the browser (node copy not triggered)',
    copyText.selection.length > 0 && copyText.prevented === false, JSON.stringify(copyText));

  const copyNode = await evaluate(`(() => {
    window.getSelection().removeAllRanges();
    const ev = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);
  check('Ctrl+C with a selected node and no text selection copies the node', copyNode === true);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(500);
  check('Ctrl+V pastes the copied node', (await evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 5);

  const dragProbe = async (selector) => {
    await evaluate(`(() => {
      const node = document.querySelector('.react-flow__node');
      const target = ${JSON.stringify(selector)} ? node.querySelector(${JSON.stringify(selector)}) : node;
      window.__probe = { node, before: node.style.transform };
      const r = target.getBoundingClientRect();
      const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window });
      target.dispatchEvent(new MouseEvent('mousedown', o(r.left + 4, r.top + 4)));
      document.dispatchEvent(new MouseEvent('mousemove', o(r.left + 30, r.top + 30)));
      document.dispatchEvent(new MouseEvent('mousemove', o(r.left + 60, r.top + 60)));
    })()`);
    await sleep(300);
    const r = await evaluate(`(() => {
      const { node, before } = window.__probe;
      const out = { dragging: node.classList.contains('dragging'), moved: before !== node.style.transform };
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, view: window }));
      return out;
    })()`);
    await sleep(200);
    return r;
  };
  // Press on an actual nodrag *field* (React Flow's handles also carry `nodrag`,
  // and pressing one starts a pin connection instead of a drag)
  const fromNodrag = await dragProbe('input.nodrag');
  check('mouse-drag starting on a nodrag element does NOT move the node', !fromNodrag.dragging && !fromNodrag.moved, JSON.stringify(fromNodrag));
  const fromHeader = await dragProbe('.rounded-t-lg');
  check('mouse-drag starting on the node header moves the node', fromHeader.dragging && fromHeader.moved, JSON.stringify(fromHeader));

  // =====================================================================
  // Visual stacking. Everything below is asserted with document.elementFromPoint
  // on a region where two nodes overlap - i.e. what the user actually sees -
  // never only the data model's zIndex.
  // =====================================================================
  const overlapNote = `(() => {
    const note = document.querySelector('.react-flow__node-note');
    const ideas = document.querySelectorAll('.react-flow__node-idea');
    const idea = ideas[ideas.length - 1];
    const ir = idea.getBoundingClientRect();
    const nr = note.getBoundingClientRect();
    const hit = document.elementFromPoint(ir.left + 6, ir.top + ir.height / 2);
    return { noteZ: note.style.zIndex, ideaZ: idea.style.zIndex,
      overlaps: ir.left >= nr.left && ir.top >= nr.top && ir.left < nr.right && ir.top < nr.bottom,
      hitIsIdea: !!hit && idea.contains(hit), hitIsNote: !!hit && note.contains(hit) };
  })()`;

  // ---- Note/Idea: a Note gets NO special stacking any more (default like every node) ----
  await evaluate(`(() => {
    const note = document.querySelector('.react-flow__node-note');
    const r = note.getBoundingClientRect();
    const pane = document.querySelector('.react-flow__pane');
    const dt = new DataTransfer();
    dt.setData('application/reactflow', 'idea');
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 55, dataTransfer: dt }));
  })()`);
  await sleep(800);
  const stack = await evaluate(overlapNote);
  check('a Note starts at the default z-index like any other node; an Idea dropped later on top of it receives the pointer',
    stack.noteZ === '0' && stack.ideaZ === '0' && stack.overlaps && stack.hitIsIdea, JSON.stringify(stack));

  // Press on `pointExpr` (JS against the node rect `r`) and drag. Idea: its left
  // padding (before the bulb button). Note: its header strip (textarea is nodrag).
  const dragNode = async (selector, pointExpr) => {
    await evaluate(`(() => {
      const all = document.querySelectorAll(${JSON.stringify(selector)});
      const node = all[all.length - 1];
      const note = document.querySelector('.react-flow__node-note');
      window.__probe = { node, before: node.style.transform, noteBefore: note.style.transform };
      const r = node.getBoundingClientRect();
      const [px, py] = ${pointExpr};
      const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window });
      document.elementFromPoint(px, py).dispatchEvent(new MouseEvent('mousedown', o(px, py)));
      document.dispatchEvent(new MouseEvent('mousemove', o(px + 34, py + 26)));
      document.dispatchEvent(new MouseEvent('mousemove', o(px + 64, py + 56)));
    })()`);
    await sleep(300);
    const r = await evaluate(`(() => {
      const { node, before, noteBefore } = window.__probe;
      const note = document.querySelector('.react-flow__node-note');
      const out = { moved: before !== node.style.transform, noteMoved: noteBefore !== note.style.transform, selectedZ: node.style.zIndex };
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, view: window }));
      return out;
    })()`);
    await sleep(200);
    return r;
  };
  const ideaDrag = await dragNode('.react-flow__node-idea', '[r.left + 6, r.top + r.height / 2]');
  check('dragging the Idea that sits on top of the Note moves the Idea, not the Note underneath',
    ideaDrag.moved && !ideaDrag.noteMoved, JSON.stringify(ideaDrag));
  const noteDrag = await dragNode('.react-flow__node-note', '[r.left + r.width * 0.35, r.top + 12]');
  const afterNoteDrag = await evaluate(overlapNote);
  check('selecting/dragging the Note does NOT lift it above the Idea on top of it (no selection z-boost)',
    noteDrag.moved && noteDrag.selectedZ === '0' && afterNoteDrag.hitIsIdea, JSON.stringify({ noteDrag, afterNoteDrag }));
  const connectionMenuOpen = `!!document.querySelector('input[placeholder="Search nodes..."]')`;
  check('dragging Note/Idea by their chrome never starts a pin connection (no stray connection menu)',
    (await evaluate(connectionMenuOpen)) === false);

  // ---- Two ordinary nodes: Begin Play (A) and its pasted copy (B, +50/+50, later in DOM => on top) ----
  // Pin A/B by node id: the node array (and so DOM order) follows stacking
  // order, so "first/last in the DOM" would change under the layer actions.
  const bpIds = await evaluate(`Array.from(document.querySelectorAll('.react-flow__node-beginplay')).map(n => n.dataset.id)`);
  const A = `document.querySelector('.react-flow__node[data-id="${bpIds[0]}"]')`;
  const B = `document.querySelector('.react-flow__node[data-id="${bpIds[1]}"]')`;
  const abState = `(() => {
    const a = ${A}, b = ${B};
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    const px = br.left + 12, py = br.top + 12; // inside both A and B
    const inA = px >= ar.left && px < ar.right && py >= ar.top && py < ar.bottom;
    const hit = document.elementFromPoint(px, py);
    const edgeLevels = Array.from(document.querySelectorAll('.react-flow__edges')).map(s => Number(s.style.zIndex || 0));
    return { overlap: inA, top: a.contains(hit) ? 'A' : b.contains(hit) ? 'B' : 'other',
      aZ: a.style.zIndex, bZ: b.style.zIndex, aSelected: a.classList.contains('selected'), bSelected: b.classList.contains('selected'),
      maxEdgeLevel: Math.max(0, ...edgeLevels), menuOpen: !!document.querySelector('[data-testid="node-context-menu"]') };
  })()`;
  const clickNode = (expr) => evaluate(`(() => {
    const n = ${expr}; const h = n.querySelector('.rounded-t-lg') || n; const r = h.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + 8, view: window };
    h.dispatchEvent(new MouseEvent('mousedown', o)); document.dispatchEvent(new MouseEvent('mouseup', o)); h.dispatchEvent(new MouseEvent('click', o));
  })()`);
  const openMenuOn = async (expr) => {
    await evaluate(`(() => {
      const n = ${expr}; const h = n.querySelector('.rounded-t-lg') || n; const r = h.getBoundingClientRect();
      h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + 8, view: window }));
    })()`);
    await sleep(150);
  };
  const menuItems = () => evaluate(`Array.from(document.querySelectorAll('[data-testid="node-context-menu"] [role="menuitem"]')).map(b => b.textContent.trim())`);
  const clickMenu = async (label) => {
    await evaluate(`Array.from(document.querySelectorAll('[data-testid="node-context-menu"] [role="menuitem"]')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await sleep(300);
  };

  const s0 = await evaluate(abState);
  check('setup: pasted Begin Play (B) overlaps the original (A) and, being later in the DOM, renders on top',
    s0.overlap && s0.top === 'B' && s0.aZ === '0' && s0.bZ === '0', JSON.stringify(s0));

  await clickNode(A);
  await sleep(300);
  const s1 = await evaluate(abState);
  check('selecting A does NOT pull it above B (no selection z-boost) and its edges stay on the base layer',
    s1.aSelected && s1.top === 'B' && s1.aZ === '0' && s1.maxEdgeLevel < 1000, JSON.stringify(s1));

  await openMenuOn(A);
  const items = await menuItems();
  check('right-clicking a node opens the layer menu with the four layer actions first',
    JSON.stringify(items.slice(0, 4)) === JSON.stringify(['Bring to Front', 'Bring Forward', 'Send Backward', 'Send to Back']), JSON.stringify(items));
  await clickMenu('Bring to Front');
  const s2 = await evaluate(abState);
  check('Bring to Front on A: A visibly covers B in the overlap (menu closed, A still selected)',
    s2.top === 'A' && !s2.menuOpen && s2.aSelected, JSON.stringify(s2));

  await openMenuOn(A);
  await clickMenu('Send to Back');
  const s3 = await evaluate(abState);
  check('Send to Back on A while A is still selected: B visibly covers A IMMEDIATELY (no deselect needed)',
    s3.top === 'B' && s3.aSelected && !s3.menuOpen && Number(s3.aZ) < Number(s3.bZ), JSON.stringify(s3));

  // Make A and B the two topmost layers (A then B) so the one-step actions
  // below move B past A specifically, not past some other z-0 node.
  await openMenuOn(A);
  await clickMenu('Bring to Front');
  await openMenuOn(B);
  await clickMenu('Bring to Front');
  const s3b = await evaluate(abState);
  check('setup: A then B brought to front - B is the top layer directly above A',
    s3b.top === 'B' && Number(s3b.bZ) === Number(s3b.aZ) + 1, JSON.stringify(s3b));

  await openMenuOn(B);
  await clickMenu('Send Backward');
  const s4 = await evaluate(abState);
  check('Send Backward on B steps it one layer down, just below A: A visibly covers B',
    s4.top === 'A' && Number(s4.bZ) < Number(s4.aZ), JSON.stringify(s4));

  await openMenuOn(B);
  await clickMenu('Bring Forward');
  const s5 = await evaluate(abState);
  // One step up may land B tied with A (ties are drawn in DOM order, B later);
  // what matters is what is on screen.
  check('Bring Forward on B steps it one layer up, past A: B visibly covers A again',
    s5.top === 'B' && Number(s5.bZ) >= Number(s5.aZ), JSON.stringify(s5));

  await openMenuOn(B);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(100);
  const s6 = await evaluate(abState);
  check('Escape closes the layer menu without changing the order', !s6.menuOpen && s6.top === 'B' && s6.bZ === s5.bZ, JSON.stringify(s6));

  await openMenuOn(B);
  await evaluate(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, view: window }))`);
  await sleep(100);
  check('clicking outside closes the layer menu', (await evaluate(abState)).menuOpen === false);

  // Selection/deselection must never change what is on top
  await clickNode(B);
  await sleep(200);
  const s7 = await evaluate(abState);
  await deselectAll();
  await sleep(200);
  const s8 = await evaluate(abState);
  check('clicking B then deselecting leaves the manual order untouched (B on top before and after)',
    s7.bSelected && s7.top === 'B' && s8.top === 'B', JSON.stringify({ s7, s8 }));
  check('layer-menu interactions never open the connection menu', (await evaluate(connectionMenuOpen)) === false);

  // =====================================================================
  // MiniMap draw order must track the real canvas stacking. Minimap rects are
  // SVG (painted in DOM order), so the Note's rect must come AFTER the Begin
  // Play rects when the Note is on top and BEFORE them when it is at the back.
  // =====================================================================
  const NOTE = `document.querySelector('.react-flow__node-note')`;
  const miniOrder = `(() => {
    const rects = Array.from(document.querySelectorAll('.react-flow__minimap .react-flow__minimap-node'));
    const cls = (r, t) => r.classList.contains('minimap-node-' + t);
    const noteIdx = rects.findIndex(r => cls(r, 'note'));
    const bpIdx = rects.map((r, i) => cls(r, 'beginplay') ? i : -1).filter(i => i >= 0);
    const canvas = Array.from(document.querySelectorAll('.react-flow__node'));
    const canvasNoteIdx = canvas.findIndex(n => n.classList.contains('react-flow__node-note'));
    const canvasBpIdx = canvas.map((n, i) => n.classList.contains('react-flow__node-beginplay') ? i : -1).filter(i => i >= 0);
    return { total: rects.length, noteIdx, bpIdx, canvasNoteIdx, canvasBpIdx, noteZ: ${NOTE}.style.zIndex,
      minimapMatchesCanvas: rects.length === canvas.length && rects.every((r, i) => {
        const t = canvas[i].className.match(/react-flow__node-([a-z]+)/)[1]; return cls(r, t); }) };
  })()`;

  const m0 = await evaluate(miniOrder);
  check('minimap paints one rect per node in the same order as the canvas node layers',
    m0.total > 0 && m0.minimapMatchesCanvas, JSON.stringify(m0));

  await openMenuOn(NOTE);
  await clickMenu('Bring to Front');
  const m1 = await evaluate(miniOrder);
  check('Note brought to front: its minimap rect is painted after every Begin Play rect (on top), like the canvas',
    m1.noteIdx === m1.total - 1 && m1.bpIdx.every((i) => i < m1.noteIdx) && m1.minimapMatchesCanvas && Number(m1.noteZ) > 0, JSON.stringify(m1));

  await openMenuOn(NOTE);
  await clickMenu('Send to Back');
  const m2 = await evaluate(miniOrder);
  check('Note sent to back: its minimap rect is painted first (under every Begin Play rect), like the canvas',
    m2.noteIdx === 0 && m2.bpIdx.every((i) => i > m2.noteIdx) && m2.minimapMatchesCanvas && Number(m2.noteZ) < 0, JSON.stringify(m2));

  // Bring one Begin Play above the Note (Note stays at the back) - still tracked
  await openMenuOn(A);
  await clickMenu('Bring to Front');
  const m3 = await evaluate(miniOrder);
  check('a Begin Play brought to front paints last in the minimap while the Note stays first',
    m3.noteIdx === 0 && m3.bpIdx.includes(m3.total - 1) && m3.minimapMatchesCanvas, JSON.stringify(m3));
  check('minimap/layer interactions never open the connection menu', (await evaluate(connectionMenuOpen)) === false);

  // =====================================================================
  // Marquee (drag-select box) - selectionMode Partial: a node is selected as
  // soon as the box overlaps ANY part of it, not only when fully enclosed.
  // =====================================================================
  // Draw a selection box on the pane from (x1,y1) to (x2,y2) in screen px.
  const marquee = async (fromExpr, toExpr) => {
    await evaluate(`(() => {
      const pane = document.querySelector('.react-flow__pane');
      window.getSelection().removeAllRanges();
      const [x1, y1] = ${fromExpr}; const [x2, y2] = ${toExpr};
      const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window });
      pane.dispatchEvent(new MouseEvent('mousedown', o(x1, y1)));
      pane.dispatchEvent(new MouseEvent('mousemove', o((x1 + x2) / 2, (y1 + y2) / 2)));
      pane.dispatchEvent(new MouseEvent('mousemove', o(x2, y2)));
    })()`);
    await sleep(150);
    const during = await evaluate(`({ box: !!document.querySelector('.react-flow__selection'), selected: Array.from(document.querySelectorAll('.react-flow__node.selected')).map(n => n.className.match(/react-flow__node-([a-z]+)/)[1]) })`);
    await evaluate(`(() => {
      const pane = document.querySelector('.react-flow__pane');
      const [x2, y2] = ${toExpr};
      pane.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: x2, clientY: y2, view: window }));
    })()`);
    await sleep(200);
    const after = await evaluate(`Array.from(document.querySelectorAll('.react-flow__node.selected')).map(n => n.className.match(/react-flow__node-([a-z]+)/)[1])`);
    return { during, after };
  };
  const resultRect = `document.querySelector('.react-flow__node-result').getBoundingClientRect()`;

  // Box starts outside the Result node and ends only ~30px into its top-left corner
  const partial = await marquee(`(r => [r.left - 40, r.top - 40])(${resultRect})`, `(r => [r.left + 30, r.top + 30])(${resultRect})`);
  check('marquee that only partially overlaps a node selects it (SelectionMode.Partial) - full enclosure not required',
    partial.during.box && partial.after.includes('result'), JSON.stringify(partial));
  check('marquee does not over-select: nodes the box never touched stay unselected',
    partial.after.length === 1, JSON.stringify(partial));
  check('partial marquee never opens the connection menu', (await evaluate(connectionMenuOpen)) === false);

  // Deselect, then a box that stops 6px short of the node must NOT select it
  await deselectAll();
  await sleep(150);
  check('pane click never opens the connection menu', (await evaluate(connectionMenuOpen)) === false);
  const miss = await marquee(`(r => [r.left - 60, r.top - 60])(${resultRect})`, `(r => [r.left - 6, r.top - 6])(${resultRect})`);
  check('marquee that stops just short of a node does not select it (no grazing false positives)',
    miss.during.box && miss.after.length === 0, JSON.stringify(miss));
  check('marquee selection never opens the connection menu', (await evaluate(connectionMenuOpen)) === false);

  // =====================================================================
  // Edge arrowheads + "Clear Execution Pins" / "Clear Data Pins"
  // =====================================================================
  // Wire a data edge by dragging from the first Idea's data-out pin (nothing
  // overlaps it; React Flow picks the pressed handle via elementFromPoint)
  // onto the Result's data-in pin.
  const dragState = await evaluate(`(() => {
    document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, view: window }));
    const src = document.querySelector('.react-flow__node-idea .react-flow__handle[data-handleid="data-out"]');
    const dst = document.querySelector('.react-flow__node-result .react-flow__handle[data-handleid="data-in"]');
    const c = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const [sx, sy] = c(src); const [tx, ty] = c(dst);
    const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window });
    src.dispatchEvent(new MouseEvent('mousedown', o(sx, sy)));
    document.dispatchEvent(new MouseEvent('mousemove', o((sx + tx) / 2, (sy + ty) / 2)));
    document.dispatchEvent(new MouseEvent('mousemove', o(tx, ty)));
    window.__drag = { tx, ty, dst };
    const pressed = document.elementFromPoint(sx, sy);
    const describe = (el) => el ? (el.tagName + '.' + String(el.className.baseVal ?? el.className).split(' ').slice(0, 4).join('.') + (el.closest('.react-flow__node') ? ' in ' + el.closest('.react-flow__node').dataset.id : '')) : null;
    const sr = src.getBoundingClientRect();
    const ancestors = []; for (let el = pressed; el && ancestors.length < 5; el = el.parentElement) ancestors.push(describe(el));
    return { src: !!src, dst: !!dst, pressedIsSrc: pressed === src, pressed: describe(pressed), ancestors, srcRect: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)],
      connectionMenuOpen: !!document.querySelector('input[placeholder="Search nodes..."]'), nodeMenuOpen: !!document.querySelector('[data-testid="node-context-menu"]'),
      connectionLine: !!document.querySelector('.react-flow__connectionline') };
  })()`);
  await sleep(100);
  // Release over the destination pin (bubbles to the document listeners React Flow installed on press)
  await evaluate(`(() => { const { tx, ty, dst } = window.__drag; dst.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: tx, clientY: ty, view: window })); })()`);
  await sleep(500);
  const edgeInfo = `(() => {
    const info = (g) => {
      if (!g) return null;
      const line = g.querySelector('path.react-flow__edge-path');
      const outline = g.querySelector('path.workflow-edge-outline');
      return { id: g.dataset.id, hasMarker: !!g.querySelector('marker') || !!(line && line.getAttribute('marker-end')),
        selected: g.classList.contains('selected'), lineStroke: line && line.style.stroke, outlineStroke: outline && outline.style.stroke };
    };
    return { execCount: document.querySelectorAll('.react-flow__edge-execution').length, dataCount: document.querySelectorAll('.react-flow__edge-data').length,
      exec: info(document.querySelector('.react-flow__edge-execution')), data: info(document.querySelector('.react-flow__edge-data')) };
  })()`;
  const e0 = await evaluate(edgeInfo);
  check('a data edge can be wired by dragging pin to pin (Idea data-out -> Result data-in)',
    e0.execCount === 1 && e0.dataCount === 1, JSON.stringify({ dragState, counts: [e0.execCount, e0.dataCount] }));
  check('execution edge: light core over a gray outline, no arrowhead marker (the pins show direction)',
    e0.exec && !e0.exec.hasMarker && e0.exec.lineStroke === 'rgb(245, 245, 245)' && e0.exec.outlineStroke === 'rgb(90, 90, 90)', JSON.stringify(e0.exec));
  check('data edge: purple stroke, no arrowhead marker',
    e0.data && !e0.data.hasMarker && e0.data.lineStroke === 'rgb(147, 51, 234)', JSON.stringify(e0.data));

  // Pins sit ON the node border, centred on their label row: the handle's
  // centre is on the node's left/right edge, and a wire ends at the pin
  const pinGeometry = await evaluate(`(() => {
    const result = document.querySelector('.react-flow__node-result'); const nr = result.getBoundingClientRect();
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; };
    const execIn = centre(result.querySelector('.react-flow__handle[data-handleid="exec-in"]'));
    const dataIn = centre(result.querySelector('.react-flow__handle[data-handleid="data-in"]'));
    const label = result.querySelector('.workflow-pin-row span').getBoundingClientRect();
    const execPin = result.querySelector('.react-flow__handle[data-handleid="exec-in"]');
    const svg = execPin.querySelector('svg path');
    // node-1 is the Begin Play the execution edge starts from (a pasted copy exists by now)
    const bp = document.querySelector('.react-flow__node[data-id="node-1"]'); const br = bp.getBoundingClientRect();
    const execOut = centre(bp.querySelector('.react-flow__handle[data-handleid="exec-out"]'));
    const path = document.querySelector('.react-flow__edge-execution path.react-flow__edge-path');
    const d = path.getAttribute('d'); const m = /^M([-\\d.]+),([-\\d.]+)/.exec(d); const end = /([-\\d.]+),([-\\d.]+)$/.exec(d);
    const vp = document.querySelector('.react-flow__viewport'); const t = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([-\\d.]+)\\)/.exec(vp.style.transform);
    const pane = document.querySelector('.react-flow__renderer').getBoundingClientRect();
    const toScreen = (x, y) => ({ x: pane.left + +t[1] + x * +t[3], y: pane.top + +t[2] + y * +t[3] });
    const start = toScreen(+m[1], +m[2]); const stop = toScreen(+end[1], +end[2]);
    return { execInOnBorder: Math.abs(execIn.x - nr.left), dataInOnBorder: Math.abs(dataIn.x - nr.left), execOutOnBorder: Math.abs(execOut.x - br.right),
      dataInOnLabelRow: Math.abs(dataIn.y - (label.top + label.height / 2)), execIsTriangle: !!svg, execPinSize: execIn.w,
      wireStartsAtPin: Math.hypot(start.x - execOut.x, start.y - execOut.y), wireEndsAtPin: Math.hypot(stop.x - execIn.x, stop.y - execIn.y) };
  })()`);
  check('pins are centred on the node border (exec-in / data-in on the left edge, exec-out on the right edge)',
    pinGeometry.execInOnBorder <= 2 && pinGeometry.dataInOnBorder <= 2 && pinGeometry.execOutOnBorder <= 2, JSON.stringify(pinGeometry));
  check('a data pin is vertically centred on its label row and the exec pin is a triangle (SVG)',
    pinGeometry.dataInOnLabelRow <= 2 && pinGeometry.execIsTriangle, JSON.stringify(pinGeometry));
  check('the execution wire starts and ends at the pins (within the pin radius)',
    pinGeometry.wireStartsAtPin <= pinGeometry.execPinSize && pinGeometry.wireEndsAtPin <= pinGeometry.execPinSize, JSON.stringify(pinGeometry));

  // Select the execution edge (click its interaction path): the outline turns blue
  await evaluate(`(() => {
    const g = document.querySelector('.react-flow__edge-execution');
    const hit = g.querySelector('.react-flow__edge-interaction') || g.querySelector('path');
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window }));
  })()`);
  await sleep(300);
  const e1 = await evaluate(edgeInfo);
  check('selecting the execution edge colours its outline blue',
    e1.exec.selected && e1.exec.outlineStroke === 'rgb(59, 130, 246)' && e1.exec.lineStroke === 'rgb(245, 245, 245)', JSON.stringify(e1.exec));

  // Result node has one execution edge (from Begin Play) and one data edge (from the Idea)
  const RESULT = `document.querySelector('.react-flow__node-result')`;
  const pinItems = () => evaluate(`Array.from(document.querySelectorAll('[data-testid="node-context-menu"] [role="menuitem"]')).map(b => ({ label: b.textContent.trim(), disabled: b.disabled }))`);
  await openMenuOn(RESULT);
  const p0 = await pinItems();
  check('node menu has a separated pin group: Clear Execution Pins / Clear Data Pins, both enabled when both edge types are attached',
    p0.length === 6 && p0[4].label === 'Clear Execution Pins' && !p0[4].disabled && p0[5].label === 'Clear Data Pins' && !p0[5].disabled &&
    (await evaluate(`document.querySelectorAll('[data-testid="node-context-menu"] .border-t').length`)) === 1, JSON.stringify(p0));
  await clickMenu('Clear Data Pins');
  const e2 = await evaluate(edgeInfo);
  check('Clear Data Pins removes only the data edge; the execution edge and the nodes remain',
    e2.dataCount === 0 && e2.execCount === 1 && (await evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 6, JSON.stringify(e2));

  await openMenuOn(RESULT);
  const p1 = await pinItems();
  check('with no data edges left, Clear Data Pins is disabled while Clear Execution Pins stays enabled',
    p1[5].disabled && !p1[4].disabled, JSON.stringify(p1));
  await clickMenu('Clear Execution Pins');
  const e3 = await evaluate(edgeInfo);
  check('Clear Execution Pins removes only the execution edge; nodes remain',
    e3.execCount === 0 && e3.dataCount === 0 && (await evaluate(`document.querySelectorAll('.react-flow__node').length`)) === 6, JSON.stringify(e3));
  await openMenuOn(RESULT);
  const p2 = await pinItems();
  check('with nothing attached both pin actions are disabled; layer actions stay enabled',
    p2[4].disabled && p2[5].disabled && p2.slice(0, 4).every((i) => !i.disabled), JSON.stringify(p2));
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(100);

  // =====================================================================
  // Marquee over a node with a text field must not natively highlight the
  // field's text. Native text selection only happens for TRUSTED pointer
  // input, so this section drives the mouse through CDP Input events.
  // =====================================================================
  const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const realDrag = async ([x1, y1], [x2, y2]) => {
    await mouse('mousePressed', x1, y1, { buttons: 1 });
    await mouse('mouseMoved', (x1 + x2) / 2, (y1 + y2) / 2, { buttons: 1 });
    await mouse('mouseMoved', x2, y2, { buttons: 1 });
    await sleep(80);
    await mouse('mouseReleased', x2, y2);
    await sleep(250);
  };
  // Deselect everything and blur any field first
  await evaluate(`document.activeElement && document.activeElement.blur(); window.getSelection().removeAllRanges()`);
  await deselectAll();
  await sleep(150);
  const noteGeom = await evaluate(`(() => {
    const note = document.querySelector('.react-flow__node-note'); const r = note.getBoundingClientRect();
    const ta = note.querySelector('textarea'); const tr = ta.getBoundingClientRect();
    const start = [r.left - 30, r.top - 30];
    const startsOnPane = document.elementFromPoint(...start)?.classList.contains('react-flow__pane');
    return { start, end: [tr.left + tr.width * 0.6, tr.top + tr.height * 0.5], startsOnPane, text: ta.value, taRect: [tr.left, tr.top, tr.width, tr.height] };
  })()`);
  await realDrag(noteGeom.start, noteGeom.end);
  const selectionState = `(() => {
    const note = document.querySelector('.react-flow__node-note'); const ta = note.querySelector('textarea');
    const sel = window.getSelection();
    const painted = sel.rangeCount > 0 && !sel.isCollapsed; // a non-collapsed page range = the browser paints a highlight somewhere
    return { noteSelected: note.classList.contains('selected'), selectedNodes: document.querySelectorAll('.react-flow__node.selected').length,
      pageRangePainted: painted, pageSelectionText: sel.toString().slice(0, 40), rangeCoversTextarea: painted && sel.containsNode(ta, true),
      fieldHighlight: ta.selectionEnd - ta.selectionStart, fieldFocused: document.activeElement === ta, bodyUserSelect: document.body.style.userSelect };
  })()`;
  const afterMarquee = await evaluate(selectionState);
  check('real marquee from empty canvas across a Note with text still selects the node (partial overlap)',
    noteGeom.startsOnPane && noteGeom.text.length > 0 && afterMarquee.noteSelected, JSON.stringify({ noteGeom, afterMarquee }));
  check('real marquee across the Note leaves NO native text highlight (no page range, no field selection)',
    !afterMarquee.pageRangePainted && afterMarquee.fieldHighlight === 0, JSON.stringify(afterMarquee));
  check('body user-select is restored after the marquee gesture', afterMarquee.bodyUserSelect === '');

  // Intentional selection: deselect (RF draws a group-selection overlay over
  // multiple selected nodes), then press inside the textarea's text and drag right
  await deselectAll();
  await sleep(150);
  const [tx0, ty0, tw] = noteGeom.taRect;
  const pressedOn = await evaluate(`(() => { const el = document.elementFromPoint(${tx0 + 12}, ${ty0 + 12}); return el ? el.tagName + '.' + String(el.className.baseVal ?? el.className).split(' ').slice(0, 3).join('.') + ' in ' + (el.closest('.react-flow__node')?.dataset.id || '-') + ' selected=' + document.querterySelectorAll : null; })()`.replace('document.querterySelectorAll', "document.querySelectorAll('.react-flow__node.selected').length"));
  await realDrag([tx0 + 12, ty0 + 12], [tx0 + Math.min(tw - 6, 120), ty0 + 12]);
  const afterFieldDrag = await evaluate(`(() => {
    const ta = document.querySelector('.react-flow__node-note textarea');
    return { fieldHighlight: ta.selectionEnd - ta.selectionStart, fieldFocused: document.activeElement === ta, pressedOn: ${JSON.stringify(pressedOn)} };
  })()`);
  check('a drag that starts inside the textarea still selects its text normally (no regression of the select-text fix)',
    afterFieldDrag.fieldFocused && afterFieldDrag.fieldHighlight > 0, JSON.stringify(afterFieldDrag));

  // Same sweep, but across an Idea <input> holding the label "branch", starting from empty canvas
  await evaluate(`(() => { const i = document.querySelector('.react-flow__node-idea input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'branch'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.activeElement && document.activeElement.blur(); window.getSelection().removeAllRanges()`);
  const ideaGeom = await evaluate(`(() => {
    const idea = Array.from(document.querySelectorAll('.react-flow__node-idea')).find(n => n.querySelector('input').value); const r = idea.getBoundingClientRect();
    const input = idea.querySelector('input'); const ir = input.getBoundingClientRect();
    const start = [r.left - 30, r.top - 30];
    return { start, end: [ir.left + ir.width * 0.7, ir.top + ir.height / 2], startsOnPane: !!document.elementFromPoint(...start)?.classList.contains('react-flow__pane'), text: input.value };
  })()`);
  await realDrag(ideaGeom.start, ideaGeom.end);
  const afterIdeaMarquee = await evaluate(`(() => {
    const idea = Array.from(document.querySelectorAll('.react-flow__node-idea')).find(n => n.querySelector('input').value); const input = idea.querySelector('input'); const sel = window.getSelection();
    return { ideaSelected: idea.classList.contains('selected'), pageRangePainted: sel.rangeCount > 0 && !sel.isCollapsed, fieldHighlight: input.selectionEnd - input.selectionStart, fieldFocused: document.activeElement === input };
  })()`);
  check('real marquee across an Idea <input> selects the node but leaves no native text highlight',
    ideaGeom.startsOnPane && ideaGeom.text.length > 0 && afterIdeaMarquee.ideaSelected && !afterIdeaMarquee.pageRangePainted && afterIdeaMarquee.fieldHighlight === 0,
    JSON.stringify({ ideaGeom, afterIdeaMarquee }));

  // ---- Selectable OUTPUT text (Visualizer JSON <pre>, select-text) under a marquee ----
  // Build String("abc") -> Visualizer (data) and Begin Play A -> Visualizer (exec), run it,
  // then sweep a real marquee from empty canvas across the Visualizer's JSON output.
  await deselectAll();
  const dropAt = async (type, xExpr, yExpr) => evaluate(`(() => {
    const pane = document.querySelector('.react-flow__pane'); const p = pane.getBoundingClientRect();
    const x = ${xExpr}, y = ${yExpr};
    const onPane = document.elementFromPoint(x, y) === pane;
    const dt = new DataTransfer(); dt.setData('application/reactflow', ${JSON.stringify(type)});
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    return onPane;
  })()`);
  const visOnPane = await dropAt('visualizer', 'p.right - 470', 'p.top + 30');
  const strOnPane = await dropAt('string', 'p.right - 470', 'p.top + 420');
  await sleep(800);
  await evaluate(`(() => { const i = document.querySelector('.react-flow__node-string input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'abc'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const wire = async (srcSel, dstSel) => {
    const ok = await evaluate(`(() => {
      const src = document.querySelector(${JSON.stringify(srcSel)}), dst = document.querySelector(${JSON.stringify(dstSel)});
      if (!src || !dst) return 'missing';
      const c = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
      const [sx, sy] = c(src); const [tx, ty] = c(dst);
      if (document.elementFromPoint(sx, sy) !== src) return 'src covered';
      const o = (x, y) => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window });
      src.dispatchEvent(new MouseEvent('mousedown', o(sx, sy)));
      document.dispatchEvent(new MouseEvent('mousemove', o((sx + tx) / 2, (sy + ty) / 2)));
      document.dispatchEvent(new MouseEvent('mousemove', o(tx, ty)));
      window.__wire = { tx, ty, dst };
      return 'ok';
    })()`);
    if (ok !== 'ok') return ok;
    await sleep(100);
    await evaluate(`(() => { const { tx, ty, dst } = window.__wire; dst.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: tx, clientY: ty, view: window })); })()`);
    await sleep(300);
    return 'ok';
  };
  const w1 = await wire('.react-flow__node-string .react-flow__handle[data-handleid="data-out"]', '.react-flow__node-visualizer .react-flow__handle[data-handleid="data-in"]');
  const w2 = await wire(`.react-flow__node[data-id="${bpIds[0]}"] .react-flow__handle[data-handleid="exec-out"]`, '.react-flow__node-visualizer .react-flow__handle[data-handleid="exec-in"]');
  await evaluate(`document.querySelector('button[title="Run workflow"]').click()`);
  await sleep(1500);
  const visOut = await evaluate(`(() => { const pre = document.querySelector('.react-flow__node-visualizer pre'); return pre ? pre.textContent : null; })()`);
  check('setup: String -> Visualizer wired and run, Visualizer shows selectable JSON output',
    visOnPane && strOnPane && w1 === 'ok' && w2 === 'ok' && visOut === '"abc"', JSON.stringify({ visOnPane, strOnPane, w1, w2, visOut }));
  await sleep(2200); // let the post-run status reset settle

  await evaluate(`document.activeElement && document.activeElement.blur(); window.getSelection().removeAllRanges()`);
  await deselectAll();
  await sleep(150);
  const preGeom = await evaluate(`(() => {
    const vis = document.querySelector('.react-flow__node-visualizer'); const r = vis.getBoundingClientRect();
    const pre = vis.querySelector('pre'); const pr = pre.getBoundingClientRect();
    const start = [r.right + 30, pr.top - 10];
    return { start, end: [pr.left + 10, pr.top + pr.height / 2], startsOnPane: document.elementFromPoint(...start) === document.querySelector('.react-flow__pane') };
  })()`);
  await realDrag(preGeom.start, preGeom.end);
  const afterPreMarquee = await evaluate(`(() => {
    const vis = document.querySelector('.react-flow__node-visualizer'); const sel = window.getSelection();
    return { visSelected: vis.classList.contains('selected'), pageRangePainted: sel.rangeCount > 0 && !sel.isCollapsed, pageSelectionText: sel.toString().slice(0, 40), bodyUserSelect: document.body.style.userSelect };
  })()`);
  check('real marquee from empty canvas across the Visualizer JSON output selects the node...',
    preGeom.startsOnPane && afterPreMarquee.visSelected, JSON.stringify({ preGeom, afterPreMarquee }));
  check('...and does NOT natively highlight the JSON text inside it',
    !afterPreMarquee.pageRangePainted && afterPreMarquee.pageSelectionText === '' && afterPreMarquee.bodyUserSelect === '', JSON.stringify(afterPreMarquee));

  // Intentional: a drag that starts inside the <pre> still selects the JSON text (select-text fix)
  await deselectAll();
  await sleep(150);
  const prePts = await evaluate(`(() => { const pr = document.querySelector('.react-flow__node-visualizer pre').getBoundingClientRect(); return [[pr.left + 4, pr.top + 8], [pr.left + 40, pr.top + 8]]; })()`);
  const prePressedOn = await evaluate(`(() => { const el = document.elementFromPoint(${prePts[0][0]}, ${prePts[0][1]}); const cs = getComputedStyle(el); return el ? el.tagName + '.' + String(el.className.baseVal ?? el.className).split(' ').slice(0, 3).join('.') + ' selected=' + document.querySelectorAll('.react-flow__node.selected').length + ' userSelect=' + cs.userSelect + '/' + cs.webkitUserSelect : null; })()`);
  await mouse('mousePressed', prePts[0][0], prePts[0][1], { buttons: 1 });
  await sleep(50);
  const midPress = await evaluate(`({ ranges: window.getSelection().rangeCount, anchor: window.getSelection().anchorNode && window.getSelection().anchorNode.nodeName, active: document.activeElement && document.activeElement.tagName + '.' + String(document.activeElement.className).split(' ').slice(0, 2).join('.') })`);
  await mouse('mouseMoved', (prePts[0][0] + prePts[1][0]) / 2, prePts[0][1], { buttons: 1 });
  await mouse('mouseMoved', prePts[1][0], prePts[1][1], { buttons: 1 });
  await sleep(80);
  const midMove = await evaluate(`({ ranges: window.getSelection().rangeCount, text: window.getSelection().toString() })`);
  await mouse('mouseReleased', prePts[1][0], prePts[1][1]);
  const justReleased = await evaluate(`({ ranges: window.getSelection().rangeCount, text: window.getSelection().toString() })`);
  await sleep(250);
  const afterPreDrag = await evaluate(`({ text: window.getSelection().toString(), ranges: window.getSelection().rangeCount, pressedOn: ${JSON.stringify(prePressedOn)}, midPress: ${JSON.stringify(midPress)}, midMove: ${JSON.stringify(midMove)}, justReleased: ${JSON.stringify(justReleased)} })`);
  check('a drag that starts inside the JSON output still selects its text (no regression of the select-text fix)',
    afterPreDrag.text.length > 0 && '"abc"'.includes(afterPreDrag.text.trim()), JSON.stringify(afterPreDrag));

  // =====================================================================
  // Node palette scrolling: the list must be bounded by the pane it lives in,
  // its scroll range must end at the last card, and the last card must be
  // fully visible after scrolling to the bottom - in every collapse state.
  // =====================================================================
  const paletteState = `(() => {
    const list = document.querySelector('[data-testid="node-library-list"]');
    const pane = list.parentElement.parentElement; // VerticalResizableDivider bottom section (overflow hidden)
    const cards = Array.from(list.querySelectorAll('[draggable="true"]'));
    const last = cards[cards.length - 1];
    list.scrollTop = list.scrollHeight; // scroll to the very bottom
    const lr = list.getBoundingClientRect(), pr = pane.getBoundingClientRect(), cr = last.getBoundingClientRect();
    const visibleBottom = Math.min(lr.bottom, pr.bottom);
    const pad = parseFloat(getComputedStyle(list).paddingBottom);
    return {
      cards: cards.length,
      listClientHeight: list.clientHeight, paneHeight: Math.round(pr.height),
      clippedByPane: Math.round(lr.bottom - pr.bottom),                 // > 0: list extends past its pane
      scrollable: list.scrollHeight > list.clientHeight,
      // content bottom in scroll coordinates vs. total scroll range (> 0: scroll range past content)
      deadSpace: Math.round(list.scrollHeight - (cr.bottom - lr.top + list.scrollTop + pad)),
      lastCardFullyVisible: Math.round(cr.bottom) <= Math.round(visibleBottom) + 1 && cr.top >= lr.top - 1,
      scrolledToEnd: Math.abs(list.scrollTop + list.clientHeight - list.scrollHeight) <= 1
    };
  })()`;
  const toggleCategory = (name) => evaluate(`Array.from(document.querySelectorAll('[data-testid="node-library-list"] button')).find(b => b.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
  // deadSpace within a couple of px of 0: scroll range ends exactly at the last card (+ padding)
  const paletteOk = (s) => s.clippedByPane <= 0 && Math.abs(s.deadSpace) <= 2 && s.lastCardFullyVisible && s.scrolledToEnd;

  const pal0 = await evaluate(paletteState);
  check('palette (all categories open) is bounded by its pane, scrolls exactly to the last card, and the last card is fully visible',
    pal0.scrollable && paletteOk(pal0), JSON.stringify(pal0));

  await toggleCategory('Variables');
  await sleep(150);
  const pal1 = await evaluate(paletteState);
  check('palette after collapsing a category: scroll range shrinks to the real content, last card still fully reachable',
    pal1.cards === pal0.cards - 6 && paletteOk(pal1), JSON.stringify(pal1));

  await toggleCategory('Control Flow');
  await toggleCategory('Actions');
  await sleep(150);
  const pal2 = await evaluate(paletteState);
  check('palette with most categories collapsed: no dead scroll space, last card fully visible',
    pal2.cards === 2 && paletteOk(pal2), JSON.stringify(pal2));

  await toggleCategory('Variables');
  await toggleCategory('Control Flow');
  await toggleCategory('Actions');
  await sleep(150);
  const pal3 = await evaluate(paletteState);
  check('palette after re-expanding everything: back to the full list, still bounded and fully reachable',
    pal3.cards === pal0.cards && pal3.scrollable && paletteOk(pal3), JSON.stringify(pal3));

  // =====================================================================
  // The library filter box: the magnifier sits inside the field on the left,
  // the clear button inside on the right and only while there is text, and
  // the text starts to the right of the magnifier. (A global [title] rule
  // once outranked the `absolute` utility and dropped the clear button
  // under the input.)
  // =====================================================================
  const filterGeometry = `(() => {
    const input = document.querySelector('[data-testid="node-library-filter"]');
    const wrap = input.parentElement;
    const inside = (el) => { if (!el) return null; const a = el.getBoundingClientRect(), b = input.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom; };
    const svg = wrap.querySelector('svg'), btn = wrap.querySelector('button');
    const ir = input.getBoundingClientRect(), sr = svg.getBoundingClientRect(), br = btn && btn.getBoundingClientRect();
    return {
      value: input.value, iconInside: inside(svg), hasClear: !!btn, clearInside: btn ? inside(btn) : null,
      iconLeft: sr.right <= ir.left + parseFloat(getComputedStyle(input).paddingLeft),
      clearRight: btn ? br.left >= ir.right - parseFloat(getComputedStyle(input).paddingRight) : null,
      wrapHeight: Math.round(wrap.getBoundingClientRect().height), inputHeight: Math.round(ir.height)
    };
  })()`;
  const filterEmpty = await evaluate(filterGeometry);
  check('library filter (empty): magnifier inside the field at the left padding, no clear button, wrapper as tall as the input',
    filterEmpty.iconInside && filterEmpty.iconLeft && !filterEmpty.hasClear && filterEmpty.wrapHeight === filterEmpty.inputHeight, JSON.stringify(filterEmpty));
  await evaluate(`(() => { const i = document.querySelector('[data-testid="node-library-filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'bra'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const filterTyped = await evaluate(filterGeometry);
  check('library filter (with text): clear button inside the field at the right padding, magnifier still inside, wrapper unchanged',
    filterTyped.value === 'bra' && filterTyped.hasClear && filterTyped.clearInside && filterTyped.clearRight && filterTyped.iconInside && filterTyped.wrapHeight === filterTyped.inputHeight, JSON.stringify(filterTyped));
  await evaluate(`document.querySelector('[data-testid="node-library-filter"]').parentElement.querySelector('button').click()`);
  await sleep(200);
  const filterCleared = await evaluate(filterGeometry);
  check('library filter: the clear button empties the field and goes away', filterCleared.value === '' && !filterCleared.hasClear, JSON.stringify(filterCleared));

  // =====================================================================
  // Palette collapse state persists across navigation / restart (localStorage)
  // =====================================================================
  const categoryCards = `(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-testid="node-library-list"] > div')).map(sec => {
    const b = sec.querySelector('button'); return [b.textContent.trim().replace(/\\s*\\d+$/, ''), sec.querySelectorAll('[draggable="true"]').length];
  })))()`;
  const c0 = await evaluate(categoryCards);
  check('palette starts with every category open (no stored preference yet)',
    Object.values(c0).every((n) => n > 0) && Object.keys(c0).length === 4, JSON.stringify(c0));

  await toggleCategory('Variables');
  await toggleCategory('Control Flow');
  await sleep(150);
  const c1 = await evaluate(categoryCards);
  check('collapsing Variables and Control Flow (Actions/Notes left open) takes effect',
    c1['Variables'] === 0 && c1['Control Flow'] === 0 && c1['Actions'] > 0 && c1['Notes'] > 0, JSON.stringify(c1));
  const stored = JSON.parse(await evaluate(`localStorage.getItem('workflowNodeLibraryExpandedCategories')`) || 'null');
  check('the choice is persisted in localStorage (same mechanism as the sidebar width); never-toggled categories are not stored',
    !!stored && stored.Variables === false && stored['Control Flow'] === false && !('Notes' in stored), JSON.stringify(stored));

  // Leave the page and come back (a full reload: covers switching pages AND an app restart)
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: URL });
  await sleep(4000);
  const c2 = await evaluate(categoryCards);
  check('after leaving the page and returning, collapsed categories stay collapsed and open ones stay open',
    c2['Variables'] === 0 && c2['Control Flow'] === 0 && c2['Actions'] > 0 && c2['Notes'] > 0, JSON.stringify(c2));

  await toggleCategory('Variables');
  await sleep(150);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: URL });
  await sleep(4000);
  const c3 = await evaluate(categoryCards);
  check('re-opening a category after the round trip also persists',
    c3['Variables'] > 0 && c3['Control Flow'] === 0 && c3['Actions'] > 0 && c3['Notes'] > 0, JSON.stringify(c3));

  check('no uncaught exceptions or console errors', errors.length === 0, errors.slice(0, 3).join(' || '));

  ws.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
