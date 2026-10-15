/**
 * Guards the Workflow Builder canvas interaction fixes and the execution
 * toolbar (src/components/WorkflowBuilder.jsx, src/components/workflow/*,
 * src/hooks/useWorkflowExecution.js, src/utils/workflowExecution.js).
 *
 * THE BUG: "when I try to copy text I move the node instead of selecting it".
 * Two compounding causes:
 *   1. React Flow starts a node drag on ANY mousedown inside a node unless the
 *      target sits inside a `.nodrag` element. No node used `nodrag`, so
 *      pressing the mouse on the JSON in a Visualizer/Result <pre> (or on an
 *      <input>) dragged the node instead of selecting text. Tailwind's
 *      `select-text` is only a CSS hint and does not stop d3-drag.
 *   2. A document-level keydown listener turned every Ctrl/Cmd+C into
 *      "copy selected nodes" (preventDefault + clipboardRef) unless the
 *      target was an <input>/<textarea>, so a text selection inside a <pre>
 *      was never copied natively.
 *
 * THE FIX:
 *   1. Every interactive element inside a node carries `nodrag` explicitly
 *      (inputs/selects/buttons), textareas and scrollable output also carry
 *      `nowheel`, and selectable output carries `select-text` - a deliberate
 *      convention documented in NodeComponents.jsx.
 *   2. shouldCopyNodesOnShortcut() (workflowNodeUtils.js) lets the browser's
 *      native copy win whenever text is highlighted or an editable element
 *      is focused, and only copies nodes when a node is actually selected.
 *
 * Also covered here (same change set):
 *   - the Clear toolbar button: clearNodeOutputs() wipes Visualizer/Result/
 *     Comparison results and statuses WITHOUT deleting nodes or their config,
 *     and the toolbar enables/disables Run/Stop/Clear consistently;
 *   - the useWorkflowExecution hook drives the REAL engine end to end
 *     (run -> results land in nodes -> Clear resets them; Stop actually
 *     aborts a run via the new shouldAbort hook);
 *   - the freeform "note" / "idea" (mind-map) node types: registered in the
 *     node map + palette, rendered with link handles on all four sides,
 *     editable, and NEVER executed by the engine;
 *   - the right-click layer menu's reorderNode() arithmetic (Bring to Front /
 *     Forward / Backward / Send to Back on the per-node zIndex) and the fact
 *     that no node type gets special default stacking. Real on-screen
 *     stacking (elementFromPoint) is asserted in workflow-canvas-smoke.mjs;
 *   - fan-out execution order: Sequence -> Delay -> Visualizer branches
 *     update progressively, each Visualizer right after its own Delay.
 *
 * Sections 1-2 are dependency-free source/pure-function checks. Section 3
 * mounts the REAL components (ExecutionToolbar, the hook, React Flow with the
 * real node components) in jsdom via an esbuild bundle - same pattern as
 * confirmation-modal-typed-phrase.test.mjs.
 *
 * Run:  node tests/workflow-canvas-interactions.test.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
requireResolvable('reactflow', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

// ---------- test scaffolding ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =====================================================================
// Section 1: source-level conventions (no deps)
// =====================================================================
const NODES_DIR = path.join(REPO, 'src', 'components', 'workflow', 'nodes');
const TAG_RULES = {
  input: ['nodrag'],
  select: ['nodrag'],
  button: ['nodrag'],
  textarea: ['nodrag', 'nowheel'],
  pre: ['nodrag', 'nowheel', 'select-text'],
};

/** Brace-aware scan for JSX opening tags of `tag` (so `=>` inside props is fine). */
function openingTags(src, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let j = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, j + 1));
    re.lastIndex = j + 1;
  }
  return out;
}
function classString(tagSrc) {
  const m = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(tagSrc);
  return m ? (m[1] ?? m[2]) : '';
}

{
  const violations = [];
  let scanned = 0;
  for (const file of fs.readdirSync(NODES_DIR).filter((f) => f.endsWith('.jsx') && f !== 'NodeComponents.jsx')) {
    const src = fs.readFileSync(path.join(NODES_DIR, file), 'utf8');
    for (const [tag, required] of Object.entries(TAG_RULES)) {
      for (const t of openingTags(src, tag)) {
        scanned++;
        const cls = classString(t).split(/\s+/);
        const missing = required.filter((r) => !cls.includes(r));
        if (missing.length) violations.push(`${file}: <${tag}> missing ${missing.join(',')}`);
      }
    }
  }
  // The shared editors in NodeFields.jsx carry the classes for most inputs,
  // so the scan sees fewer raw tags than it used to; the floor only guards
  // against the scan silently matching nothing.
  check('section 1: every interactive element inside a node carries the nodrag/nowheel convention',
    violations.length === 0 && scanned > 15, violations.slice(0, 5).join('; ') || `${scanned} tags scanned`);

  const builderSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'WorkflowBuilder.jsx'), 'utf8');
  check('section 1: note/idea node types registered in the nodeTypes map',
    /note:\s*NoteNode/.test(builderSrc) && /idea:\s*IdeaNode/.test(builderSrc));
  check('section 1: keydown handler defers to shouldCopyNodesOnShortcut (no blanket preventDefault on Ctrl+C)',
    builderSrc.includes('shouldCopyNodesOnShortcut({ target: event.target, selection: window.getSelection(), nodes })'));
  check('section 1: selection never changes node stacking (React Flow select-elevation is disabled for nodes and edges)',
    builderSrc.includes('elevateNodesOnSelect={false}') && builderSrc.includes('elevateEdgesOnSelect={false}'));
  check('section 1: marquee selection is partial-overlap (SelectionMode.Partial), not full-enclosure',
    builderSrc.includes('selectionMode={SelectionMode.Partial}') && /import ReactFlow, \{[^}]*\bSelectionMode\b[^}]*\} from 'reactflow'/.test(builderSrc));
  check('section 1: execution toolbar wires Run/Stop/Clear to the hook',
    /<ExecutionToolbar[\s\S]*?onRun=\{executeWorkflow\}[\s\S]*?onStop=\{stopWorkflow\}[\s\S]*?onClear=\{clearOutputs\}/.test(builderSrc));

  const engineSrc = fs.readFileSync(path.join(REPO, 'src', 'utils', 'workflowExecution.js'), 'utf8');
  check('section 1: engine never seeds annotation (note/idea) nodes into the execution queue',
    /ANNOTATION_NODE_TYPES = \['note', 'idea'\]/.test(engineSrc) &&
    /\.filter\(node => !ANNOTATION_NODE_TYPES\.includes\(node\.type\)\)/.test(engineSrc));
  check('section 1: engine exposes a shouldAbort hook so Stop can halt a run',
    /export async function executeWorkflowInBrowser\([^)]*shouldAbort = null\)/.test(engineSrc) &&
    engineSrc.includes('if (isAborted()) break;'));
}

// =====================================================================
// Section 2: pure helpers (native ESM import, no deps)
// =====================================================================
const utils = await import(path.join(REPO, 'src', 'components', 'workflow', 'workflowNodeUtils.js'));
{
  const { shouldCopyNodesOnShortcut, clearNodeOutputs, clearNodeStatuses, getMaxNodeId, withNodeChangeHandler } = utils;
  const div = { tagName: 'DIV', isContentEditable: false };
  const selectedNodes = [{ id: 'a', selected: true }, { id: 'b', selected: false }];
  const textSel = { isCollapsed: false, toString: () => '{"id": 1}' };
  const collapsed = { isCollapsed: true, toString: () => '' };
  const emptyRange = { isCollapsed: false, toString: () => '' };

  check('section 2: Ctrl+C with highlighted text is NOT hijacked for node copy (even with a node selected)',
    shouldCopyNodesOnShortcut({ target: div, selection: textSel, nodes: selectedNodes }) === false);
  check('section 2: Ctrl+C with collapsed selection + selected node copies nodes',
    shouldCopyNodesOnShortcut({ target: div, selection: collapsed, nodes: selectedNodes }) === true);
  check('section 2: Ctrl+C with an empty (non-collapsed) range still copies nodes',
    shouldCopyNodesOnShortcut({ target: div, selection: emptyRange, nodes: selectedNodes }) === true);
  check('section 2: Ctrl+C with no selection object + selected node copies nodes',
    shouldCopyNodesOnShortcut({ target: div, selection: null, nodes: selectedNodes }) === true);
  check('section 2: Ctrl+C with no selected node is left to the browser',
    shouldCopyNodesOnShortcut({ target: div, selection: collapsed, nodes: [{ id: 'a', selected: false }] }) === false);
  check('section 2: Ctrl+C inside INPUT / TEXTAREA / contentEditable is left to the browser',
    !shouldCopyNodesOnShortcut({ target: { tagName: 'INPUT' }, selection: null, nodes: selectedNodes }) &&
    !shouldCopyNodesOnShortcut({ target: { tagName: 'TEXTAREA' }, selection: null, nodes: selectedNodes }) &&
    !shouldCopyNodesOnShortcut({ target: { tagName: 'DIV', isContentEditable: true }, selection: null, nodes: selectedNodes }));

  const onChange = () => {};
  const graph = [
    { id: 'node-1', type: 'beginplay', position: { x: 0, y: 0 }, data: { status: 'complete', inputs: { host: {} }, onChange } },
    { id: 'node-2', type: 'visualizer', position: { x: 1, y: 0 }, data: { status: 'complete', viewMode: 'table', data: [{ a: 1 }], onChange } },
    { id: 'node-3', type: 'result', position: { x: 2, y: 0 }, data: { status: 'error', error: 'boom', outputValue: { ok: true }, onChange } },
    { id: 'node-4', type: 'comparison', position: { x: 3, y: 0 }, data: { status: 'complete', operator: '>=', result: true, onChange } },
    { id: 'node-5', type: 'transformation', position: { x: 4, y: 0 }, data: { status: 'complete', code: 'return input;', onChange } },
    { id: 'node-7', type: 'note', position: { x: 5, y: 0 }, data: { text: 'keep me', color: 'blue', onChange } },
  ];
  const cleared = clearNodeOutputs(graph);
  check('section 2: clearNodeOutputs keeps every node (ids, types, positions)',
    cleared.length === graph.length && cleared.every((n, i) => n.id === graph[i].id && n.type === graph[i].type && n.position === graph[i].position));
  check('section 2: clearNodeOutputs wipes Visualizer data / Result outputValue / Comparison result',
    !('data' in cleared[1].data) && !('outputValue' in cleared[2].data) && !('result' in cleared[3].data));
  check('section 2: clearNodeOutputs resets status and error on every node',
    cleared.every((n) => n.data.status === null && !('error' in n.data)));
  check('section 2: clearNodeOutputs preserves node configuration and handlers',
    cleared[1].data.viewMode === 'table' && cleared[3].data.operator === '>=' && cleared[4].data.code === 'return input;' &&
    cleared[5].data.text === 'keep me' && cleared[5].data.color === 'blue' && eq(cleared[0].data.inputs, { host: {} }) &&
    cleared.every((n) => n.data.onChange === onChange));
  check('section 2: clearNodeOutputs does not mutate the input nodes',
    graph[1].data.data.length === 1 && graph[2].data.outputValue.ok === true && graph[3].data.status === 'complete');

  const statusCleared = clearNodeStatuses(graph);
  check('section 2: clearNodeStatuses (Stop) clears status but keeps outputs',
    statusCleared.every((n) => n.data.status === null) && statusCleared[1].data.data.length === 1 && statusCleared[2].data.outputValue.ok === true);

  check('section 2: getMaxNodeId ignores non node-N ids and returns 0 for none',
    getMaxNodeId([{ id: 'node-3' }, { id: 'node-12' }, { id: 'edge-99' }, { id: 'x' }]) === 12 && getMaxNodeId([]) === 0);

  let latest = [{ id: 'node-1', data: { a: 1 } }, { id: 'node-2', data: { a: 2 } }];
  const setNodes = (updater) => { latest = updater(latest); };
  const wired = withNodeChangeHandler({ id: 'node-2', type: 'note', data: { text: '' } }, setNodes);
  wired.data.onChange({ text: 'hi' });
  check('section 2: withNodeChangeHandler merges partial updates into only its own node',
    typeof wired.data.onChange === 'function' && eq(latest, [{ id: 'node-1', data: { a: 1 } }, { id: 'node-2', data: { a: 2, text: 'hi' } }]));

  // Layer order (right-click menu): a,b tie at 0 (b later => on top of a), note manually at -2000, c at 5
  const { reorderNode } = utils;
  const stack = [
    { id: 'a', type: 'string', data: {} },
    { id: 'b', type: 'string', data: {} },
    { id: 'note', type: 'note', zIndex: -2000, data: {} },
    { id: 'c', type: 'string', zIndex: 5, data: {} },
  ];
  const z = (arr, id) => arr.find((n) => n.id === id).zIndex;
  check('section 2: Bring to Front puts the node above every other node (max + 1)', z(reorderNode(stack, 'a', 'front'), 'a') === 6);
  check('section 2: Send to Back puts the node below every other node (min - 1)', z(reorderNode(stack, 'c', 'back'), 'c') === -2001);
  check('section 2: Bring Forward steps just past the node immediately above (tie resolved by array order)',
    z(reorderNode(stack, 'a', 'forward'), 'a') === 1 && z(reorderNode(stack, 'b', 'forward'), 'b') === 6);
  check('section 2: Send Backward steps just below the node immediately below',
    z(reorderNode(stack, 'b', 'backward'), 'b') === -1 && z(reorderNode(stack, 'a', 'backward'), 'a') === -2001);
  check('section 2: reorder is a no-op (same array) when already at the top/bottom or for unknown ids/actions',
    reorderNode(stack, 'c', 'front') === stack && reorderNode(stack, 'c', 'forward') === stack &&
    reorderNode(stack, 'note', 'back') === stack && reorderNode(stack, 'note', 'backward') === stack &&
    reorderNode(stack, 'nope', 'front') === stack && reorderNode(stack, 'a', 'sideways') === stack);
  check('section 2: reorder only touches the target node and never mutates the input',
    reorderNode(stack, 'a', 'front').filter((n, i) => n !== stack[i]).length === 1 && stack[0].zIndex === undefined);
  // The node array must follow stacking order (the MiniMap paints in array order)
  const { sortNodesByStacking } = utils;
  const sorted = sortNodesByStacking([
    { id: 'top', zIndex: 3 }, { id: 'p', zIndex: 0 }, { id: 'q' }, { id: 'bottom', zIndex: -2000 }, { id: 'r', zIndex: 0 },
  ]);
  check('section 2: sortNodesByStacking orders by effective zIndex and keeps ties in their existing order',
    eq(sorted.map((n) => n.id), ['bottom', 'p', 'q', 'r', 'top']));
  const already = [{ id: 'a', zIndex: -1 }, { id: 'b' }, { id: 'c', zIndex: 0 }, { id: 'd', zIndex: 2 }];
  check('section 2: sortNodesByStacking returns the same array when already in order (no state churn)',
    sortNodesByStacking(already) === already && sortNodesByStacking([]).length === 0);
  check('section 2: reorderNode + sortNodesByStacking moves a sent-to-back node to the front of the array',
    sortNodesByStacking(reorderNode(stack, 'c', 'back'))[0].id === 'c' &&
    sortNodesByStacking(reorderNode(stack, 'a', 'front')).at(-1).id === 'a');

  // Pin clearing (right-click menu): only the given edge type on the given node
  const { nodePinEdges, clearNodePins } = utils;
  const wiring = [
    { id: 'x1', type: 'execution', source: 'bp', target: 'vis' },
    { id: 'x2', type: 'execution', source: 'vis', target: 'res' },
    { id: 'd1', type: 'data', source: 'str', target: 'vis' },
    { id: 'd2', type: 'data', source: 'vis', target: 'res' },
    { id: 'd3', type: 'data', source: 'str', target: 'res' },
    { id: 'x3', type: 'execution', source: 'bp', target: 'other' },
  ];
  const ids = (arr) => arr.map((e) => e.id);
  check('section 2: nodePinEdges finds edges of one type attached on either end',
    eq(ids(nodePinEdges(wiring, 'vis', 'execution')), ['x1', 'x2']) && eq(ids(nodePinEdges(wiring, 'vis', 'data')), ['d1', 'd2']) &&
    nodePinEdges(wiring, 'other', 'data').length === 0);
  check('section 2: Clear Execution Pins removes only that node\'s execution edges (data edges and other nodes untouched)',
    eq(ids(clearNodePins(wiring, 'vis', 'execution')), ['d1', 'd2', 'd3', 'x3']));
  check('section 2: Clear Data Pins removes only that node\'s data edges (execution edges untouched)',
    eq(ids(clearNodePins(wiring, 'vis', 'data')), ['x1', 'x2', 'd3', 'x3']));
  check('section 2: clearing pins is a no-op (same array) when nothing of that type is attached, and never mutates input',
    clearNodePins(wiring, 'other', 'data') === wiring && clearNodePins(wiring, 'nope', 'execution') === wiring && wiring.length === 6);

  check('section 2: a new Note gets no special stacking (same default z-order as every other node)',
    withNodeChangeHandler({ id: 'n', type: 'note', data: {} }, () => {}).zIndex === undefined &&
    withNodeChangeHandler({ id: 'n', type: 'note', zIndex: -3, data: {} }, () => {}).zIndex === -3);
}

// =====================================================================
// Section 3: real components in jsdom
// =====================================================================
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-canvas-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, { ReactFlowProvider } from 'reactflow';
import ExecutionToolbar from '@worktree/src/components/workflow/ExecutionToolbar.jsx';
import useWorkflowExecution from '@worktree/src/hooks/useWorkflowExecution.js';
import { executeWorkflowInBrowser } from '@worktree/src/utils/workflowExecution.js';
import { NODE_CATEGORIES, NOTES_CATEGORY, NO_EXEC_INPUT_NODE_TYPES, ANNOTATION_NODE_TYPES } from '@worktree/src/components/workflow/workflowNodeCategories.js';
import VisualizerNode from '@worktree/src/components/workflow/nodes/VisualizerNode.jsx';
import ResultNode from '@worktree/src/components/workflow/nodes/ResultNode.jsx';
import StringVariableNode from '@worktree/src/components/workflow/nodes/StringVariableNode.jsx';
import NoteNode from '@worktree/src/components/workflow/nodes/NoteNode.jsx';
import IdeaNode from '@worktree/src/components/workflow/nodes/IdeaNode.jsx';
import ExecutionEdge from '@worktree/src/components/workflow/edges/ExecutionEdge.jsx';
import DataEdge from '@worktree/src/components/workflow/edges/DataEdge.jsx';

window.__registry = { NODE_CATEGORIES, NOTES_CATEGORY, NO_EXEC_INPUT_NODE_TYPES, ANNOTATION_NODE_TYPES };
window.__engine = executeWorkflowInBrowser;

// --- Toolbar harness ---
function ToolbarHarness() {
  const [executing, setExecuting] = useState(false);
  window.__toolbar = window.__toolbar || { calls: [] };
  window.__toolbar.setExecuting = setExecuting;
  const rec = (name) => () => window.__toolbar.calls.push(name);
  return <ExecutionToolbar isExecuting={executing} onRun={rec('run')} onStop={rec('stop')} onClear={rec('clear')} />;
}

// --- Hook harness: the real hook driving the real engine ---
function HookHarness() {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const exec = useWorkflowExecution({ nodes, edges, setNodes, currentWorkflow: { id: 'wf', title: 'Test' } });
  const latest = useRef();
  latest.current = { nodes, ...exec };
  window.__exec = {
    setGraph: (n, e) => { setNodes(n); setEdges(e); },
    get: () => latest.current,
  };
  return null;
}

// --- Canvas harness: real node components inside a real React Flow ---
const nodeTypes = { visualizer: VisualizerNode, result: ResultNode, string: StringVariableNode, note: NoteNode, idea: IdeaNode };
const edgeTypes = { execution: ExecutionEdge, data: DataEdge };
window.__canvasEvents = [];
const onChangeFor = (id) => (updates) => window.__canvasEvents.push({ id, updates });
const canvasNodes = [
  { id: 'n-vis', type: 'visualizer', position: { x: 0, y: 0 }, data: { data: { hello: 'world' }, onChange: onChangeFor('n-vis') } },
  { id: 'n-res', type: 'result', position: { x: 500, y: 0 }, data: { outputValue: 'some output', onChange: onChangeFor('n-res') } },
  { id: 'n-str', type: 'string', position: { x: 0, y: 400 }, data: { value: 'abc', onChange: onChangeFor('n-str') } },
  { id: 'n-note', type: 'note', position: { x: 500, y: 400 }, data: { text: '', onChange: onChangeFor('n-note') } },
  { id: 'n-idea', type: 'idea', position: { x: 900, y: 400 }, data: { label: '', color: 'green', onChange: onChangeFor('n-idea') } },
];
const canvasEdges = [
  { id: 'e1', source: 'n-vis', target: 'n-res', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
  { id: 'e2', source: 'n-note', target: 'n-idea', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
];
function CanvasHarness() {
  return (
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} />
      </div>
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById('toolbar-root')).render(<ToolbarHarness />);
createRoot(document.getElementById('hook-root')).render(<HookHarness />);
createRoot(document.getElementById('canvas-root')).render(<CanvasHarness />);
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
const dom = new JSDOM(
  '<!doctype html><html><body><div id="toolbar-root"></div><div id="hook-root"></div><div id="canvas-root"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true },
);
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('HTMLInputElement', window.HTMLInputElement);
define('HTMLTextAreaElement', window.HTMLTextAreaElement);
define('HTMLButtonElement', window.HTMLButtonElement);
// React Flow / d3-drag check `instanceof SVGElement` on pointer events
define('SVGElement', window.SVGElement);
define('Element', window.Element);
define('Node', window.Node);
define('Text', window.Text);
define('DOMRect', window.DOMRect);
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
// React Flow measures nodes/pane with ResizeObserver; jsdom has none.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', ResizeObserverStub);
window.ResizeObserver = ResizeObserverStub;

// ---------- helpers ----------
const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const typeInto = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const btn = (title) => doc.querySelector(`#toolbar-root button[title="${title}"]`);
const btnState = () => ['Run workflow', 'Stop execution', 'Clear node outputs'].map((t) => (btn(t) ? (btn(t).disabled ? 'disabled' : 'enabled') : 'missing'));

// ---------- load bundle ----------
createRequire(import.meta.url)(BUNDLE);
await sleep(150);

let exitCode = 1;
try {
  // ============ section 3a: node registry ===================================
  const reg = window.__registry;
  const notesCat = reg.NODE_CATEGORIES.find((c) => c.category === reg.NOTES_CATEGORY);
  check('section 3a: palette has a Notes category exposing note + idea',
    !!notesCat && eq(notesCat.nodes.map((n) => n.type), ['note', 'idea']) && notesCat.nodes.every((n) => !!n.icon && !!n.label && !!n.color));
  check('section 3a: note/idea can never be targets of an execution edge',
    eq(reg.ANNOTATION_NODE_TYPES, ['note', 'idea']) && reg.NO_EXEC_INPUT_NODE_TYPES.includes('note') && reg.NO_EXEC_INPUT_NODE_TYPES.includes('idea'));

  // ============ section 3b: ExecutionToolbar ================================
  check('section 3b: toolbar renders Run / Stop / Clear with idle states (Run+Clear enabled, Stop disabled)',
    eq(btnState(), ['enabled', 'disabled', 'enabled']), JSON.stringify(btnState()));
  click(btn('Clear node outputs'));
  click(btn('Run workflow'));
  click(btn('Stop execution')); // disabled: must not fire
  check('section 3b: idle clicks fire onClear/onRun but not the disabled Stop',
    eq(window.__toolbar.calls, ['clear', 'run']), JSON.stringify(window.__toolbar.calls));
  window.__toolbar.setExecuting(true);
  await sleep(50);
  check('section 3b: while executing, Run and Clear are disabled and Stop is enabled (consistent pattern)',
    eq(btnState(), ['disabled', 'enabled', 'disabled']), JSON.stringify(btnState()));
  window.__toolbar.calls.length = 0;
  click(btn('Clear node outputs'));
  click(btn('Stop execution'));
  check('section 3b: while executing, Clear cannot race the engine; Stop fires',
    eq(window.__toolbar.calls, ['stop']), JSON.stringify(window.__toolbar.calls));
  window.__toolbar.setExecuting(false);
  await sleep(50);

  // ============ section 3c: real engine skips note/idea nodes ===============
  const engineGraph = {
    nodes: [
      { id: 'node-1', type: 'beginplay', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-2', type: 'object', position: { x: 0, y: 0 }, data: { value: '{"k": 42}' } },
      { id: 'node-3', type: 'visualizer', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-4', type: 'result', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-5', type: 'note', position: { x: 0, y: 0 }, data: { text: 'unconnected note' } },
      { id: 'node-6', type: 'idea', position: { x: 0, y: 0 }, data: { label: 'linked idea' } },
      { id: 'node-7', type: 'note', position: { x: 0, y: 0 }, data: { text: 'note fed by data edge' } },
    ],
    edges: [
      { id: 'e1', source: 'node-1', target: 'node-3', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e2', source: 'node-3', target: 'node-4', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e3', source: 'node-2', target: 'node-3', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
      { id: 'e4', source: 'node-3', target: 'node-4', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
      { id: 'e5', source: 'node-5', target: 'node-6', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
      { id: 'e6', source: 'node-2', target: 'node-7', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
    ],
  };
  const updates = [];
  const { outputs, error } = await window.__engine(engineGraph, {}, (id, status) => updates.push(`${id}:${status}`), null, null);
  const touched = new Set(updates.map((u) => u.split(':')[0]));
  check('section 3c: engine runs the exec chain and delivers data through visualizer to result',
    !error && eq(outputs['node-3'], { k: 42 }) && eq(outputs['node-4'], { k: 42 }), error || JSON.stringify(outputs));
  check('section 3c: engine never marks note/idea nodes processing/complete (even when linked by data edges)',
    !touched.has('node-5') && !touched.has('node-6') && !touched.has('node-7') && touched.has('node-1') && touched.has('node-4'),
    updates.join(','));

  // ============ section 3d: hook lifecycle run -> outputs -> Clear ==========
  const ex = window.__exec;
  ex.setGraph(engineGraph.nodes, engineGraph.edges);
  await sleep(50);
  check('section 3d: hook starts idle', ex.get().isExecuting === false);
  await ex.get().executeWorkflow();
  await sleep(50);
  const after = ex.get().nodes;
  const byId = (id) => after.find((n) => n.id === id);
  check('section 3d: after Run, results land in Visualizer.data and Result.outputValue with complete status',
    eq(byId('node-3').data.data, { k: 42 }) && eq(byId('node-4').data.outputValue, { k: 42 }) &&
    byId('node-3').data.status === 'complete' && byId('node-4').data.status === 'complete' && ex.get().isExecuting === false);
  check('section 3d: after Run, note/idea nodes carry no status', !byId('node-5').data.status && !byId('node-6').data.status);
  ex.get().clearOutputs();
  await sleep(50);
  const cleared = ex.get().nodes;
  const c = (id) => cleared.find((n) => n.id === id);
  check('section 3d: Clear removes the displayed outputs without deleting nodes',
    cleared.length === engineGraph.nodes.length && !('data' in c('node-3').data) && !('outputValue' in c('node-4').data) &&
    c('node-3').data.status === null && c('node-4').data.status === null);
  check('section 3d: Clear keeps node configuration (object value, note text, idea label)',
    c('node-2').data.value === '{"k": 42}' && c('node-5').data.text === 'unconnected note' && c('node-6').data.label === 'linked idea');
  await sleep(2100); // let the hook's deferred status reset fire on the cleared graph (must be a no-op)
  check('section 3d: deferred status reset after Run does not resurrect outputs',
    !('data' in ex.get().nodes.find((n) => n.id === 'node-3').data));

  // ============ section 3e: Stop aborts a running workflow =================
  const slowGraph = {
    nodes: [
      { id: 'node-1', type: 'beginplay', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-2', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 400 } },
      { id: 'node-3', type: 'result', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-4', type: 'object', position: { x: 0, y: 0 }, data: { value: '"late"' } },
    ],
    edges: [
      { id: 'e1', source: 'node-1', target: 'node-2', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e2', source: 'node-2', target: 'node-3', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e3', source: 'node-4', target: 'node-3', sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' },
    ],
  };
  ex.setGraph(slowGraph.nodes, slowGraph.edges);
  await sleep(50);
  const runPromise = ex.get().executeWorkflow();
  await sleep(100);
  check('section 3e: run is in progress while the delay node waits',
    ex.get().isExecuting === true && ex.get().nodes.find((n) => n.id === 'node-2').data.status === 'processing');
  ex.get().stopWorkflow();
  await sleep(20);
  check('section 3e: Stop flips isExecuting off and clears processing states immediately',
    ex.get().isExecuting === false && ex.get().nodes.every((n) => !n.data.status));
  await runPromise;
  await sleep(100);
  check('section 3e: Stop actually halts the engine - the downstream Result never receives a value',
    !('outputValue' in ex.get().nodes.find((n) => n.id === 'node-3').data));
  await sleep(2100);

  // ============ section 3f: real node components on a real canvas ==========
  const canvas = doc.getElementById('canvas-root');
  if (process.env.DEBUG_DOM) console.log('canvas DOM:', canvas.innerHTML.slice(0, 1500));
  const nodeEls = canvas.querySelectorAll('.react-flow__node');
  check('section 3f: React Flow renders all five node types (visualizer, result, string, note, idea)',
    nodeEls.length === 5, `${nodeEls.length} nodes`);

  const visPre = canvas.querySelector('.react-flow__node-visualizer pre');
  const resPre = canvas.querySelector('.react-flow__node-result pre');
  const hasAll = (el, ...cls) => !!el && cls.every((c) => el.classList.contains(c));
  check('section 3f: Visualizer/Result JSON output is nodrag + nowheel + select-text (mousedown selects text, not the node)',
    hasAll(visPre, 'nodrag', 'nowheel', 'select-text') && hasAll(resPre, 'nodrag', 'nowheel', 'select-text'));
  check('section 3f: Visualizer/Result action buttons are nodrag',
    [...canvas.querySelectorAll('.react-flow__node-visualizer button, .react-flow__node-result button')].every((b) => b.classList.contains('nodrag')));
  check('section 3f: String variable input is nodrag',
    hasAll(canvas.querySelector('.react-flow__node-string input'), 'nodrag'));

  const noteEl = canvas.querySelector('.react-flow__node-note');
  if (!noteEl) throw new Error('Note node did not render - remaining 3f checks skipped');
  const noteTa = noteEl.querySelector('textarea');
  check('section 3f: Note node renders an editable nodrag+nowheel textarea',
    hasAll(noteTa, 'nodrag', 'nowheel') && !noteTa.disabled);
  const noteHandles = [...noteEl.querySelectorAll('.react-flow__handle')].map((h) => h.dataset.handleid).sort();
  check('section 3f: Note node exposes link handles on all four sides (data-in/data-out + top/bottom)',
    eq(noteHandles, ['data-in', 'data-out', 'link-bottom', 'link-top']), noteHandles.join(','));
  typeInto(noteTa, 'central topic');
  await sleep(30);
  check('section 3f: typing in a Note propagates through data.onChange({ text })',
    window.__canvasEvents.some((e) => e.id === 'n-note' && e.updates.text === 'central topic'));
  const swatches = noteEl.querySelectorAll('button.nodrag');
  check('section 3f: Note colour swatches are nodrag buttons', swatches.length === 6);
  click(swatches[2]);
  check('section 3f: picking a swatch propagates data.onChange({ color })',
    window.__canvasEvents.some((e) => e.id === 'n-note' && e.updates.color === 'blue'));

  const ideaEl = canvas.querySelector('.react-flow__node-idea');
  const ideaInput = ideaEl && ideaEl.querySelector('input');
  check('section 3f: Idea node renders a nodrag label input and four link handles',
    hasAll(ideaInput, 'nodrag') && ideaEl.querySelectorAll('.react-flow__handle').length === 4);
  typeInto(ideaInput, 'branch');
  click(ideaEl.querySelector('button.nodrag'));
  check('section 3f: Idea label edits and colour cycling propagate through data.onChange',
    window.__canvasEvents.some((e) => e.id === 'n-idea' && e.updates.label === 'branch') &&
    window.__canvasEvents.some((e) => e.id === 'n-idea' && e.updates.color === 'blue'));

  // Edge rendering is NOT asserted here: React Flow only draws edges once it
  // has measured node/handle bounds, which jsdom cannot provide. The real
  // browser check lives in tests/workflow-canvas-smoke.mjs.

  // ============ section 3g: default stacking is the same for every type ====
  // (Real visual stacking / hit-testing is asserted in the Chrome smoke test.)
  const zOf = (sel) => canvas.querySelector(sel).style.zIndex;
  check('section 3g: Note, Idea and Visualizer wrappers all render at the default z-index',
    zOf('.react-flow__node-note') === '0' && zOf('.react-flow__node-idea') === '0' && zOf('.react-flow__node-visualizer') === '0',
    `note=${zOf('.react-flow__node-note')} idea=${zOf('.react-flow__node-idea')}`);

  // ============ section 3h: fan-out branches update progressively ==========
  // Sequence -> 4x Delay -> 4x Visualizer (one Object feeding every Visualizer).
  // Each Visualizer must complete right after ITS Delay, before the next
  // branch's Delay even starts - not all together once every Delay has run.
  const fanOut = { nodes: [
    { id: 'node-1', type: 'beginplay', position: { x: 0, y: 0 }, data: {} },
    { id: 'seq', type: 'sequence', position: { x: 0, y: 0 }, data: { outputCount: 4 } },
    { id: 'src', type: 'object', position: { x: 0, y: 0 }, data: { value: '{"msg": "hi"}' } },
  ], edges: [
    { id: 'e0', source: 'node-1', target: 'seq', sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' },
  ] };
  for (let i = 0; i < 4; i++) {
    fanOut.nodes.push({ id: `delay-${i}`, type: 'delay', position: { x: 0, y: 0 }, data: { duration: 120 } });
    fanOut.nodes.push({ id: `vis-${i}`, type: 'visualizer', position: { x: 0, y: 0 }, data: {} });
    fanOut.edges.push({ id: `s${i}`, source: 'seq', target: `delay-${i}`, sourceHandle: `output-${i}`, targetHandle: 'exec-in', type: 'execution' });
    fanOut.edges.push({ id: `d${i}`, source: `delay-${i}`, target: `vis-${i}`, sourceHandle: 'exec-out', targetHandle: 'exec-in', type: 'execution' });
    fanOut.edges.push({ id: `v${i}`, source: 'src', target: `vis-${i}`, sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' });
  }
  const order = [];
  const t0 = Date.now();
  await window.__engine(fanOut, {}, (id, status) => order.push({ id, status, t: Date.now() - t0 }), null, null);
  const at = (id, status) => order.findIndex((u) => u.id === id && u.status === status);
  const progressive = [0, 1, 2].every((i) => at(`vis-${i}`, 'complete') !== -1 && at(`vis-${i}`, 'complete') < at(`delay-${i + 1}`, 'processing'));
  check('section 3h: engine completes each Visualizer right after its own Delay, before the next branch starts',
    progressive && at('vis-3', 'complete') > at('delay-3', 'complete'),
    order.map((u) => `${u.id}:${u.status}@${u.t}`).join(' '));
  const seqOrder = [0, 1, 2, 3].map((i) => at(`delay-${i}`, 'processing'));
  check('section 3h: Sequence branches still run in "Then 0..3" order',
    seqOrder.every((v, i) => v !== -1 && (i === 0 || v > seqOrder[i - 1])));

  // Same graph through the real hook: the first Visualizer's data must be
  // visible in node state while the run is still executing.
  ex.setGraph(fanOut.nodes, fanOut.edges);
  await sleep(50);
  const fanRun = ex.get().executeWorkflow();
  await sleep(200); // branch 0 (120ms) done, branch 1 in flight
  const mid = ex.get();
  const midVis = (i) => mid.nodes.find((n) => n.id === `vis-${i}`).data;
  check('section 3h: while the run is still executing, Visualizer 0 already shows its data and Visualizer 2/3 do not',
    mid.isExecuting === true && eq(midVis(0).data, { msg: 'hi' }) && !('data' in midVis(2)) && !('data' in midVis(3)),
    `executing=${mid.isExecuting} vis0=${JSON.stringify(midVis(0).data)} vis3=${JSON.stringify(midVis(3).data)}`);
  await fanRun;
  await sleep(50);
  check('section 3h: after the run every Visualizer shows its data',
    [0, 1, 2, 3].every((i) => eq(ex.get().nodes.find((n) => n.id === `vis-${i}`).data.data, { msg: 'hi' })));
  await sleep(2100);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
}
process.exit(exitCode);
