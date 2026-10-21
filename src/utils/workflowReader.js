/**
 * The workflow reader's pure helpers, shared by the phone's read-only view
 * (src/components/mobile/MobileWorkflowView.jsx) and the AI context's
 * Markdown (src/utils/workflowMarkdown.js) - no component, no React:
 *
 *   linearize(nodes, edges)  the nodes in reading order: notes first, then
 *                            the execution chain from Begin Play (a
 *                            branching node carries its outlets with their
 *                            targets, every node its data inputs), then
 *                            whatever was not reached, data nodes last;
 *   summarize(node)          one line that says what a node does;
 *   describe(node)           the card body - the method and the whole URL,
 *                            the whole code, the command, the value - and,
 *                            after a run, what the engine wrote into it;
 *   labelFor(type), pinName(type, handle), ANNOTATION_TYPES.
 *
 * A field the user has not typed into reads as the desktop editor shows it
 * (nodeFields: the editor's fallbacks; the saved node carries nothing for it).
 */
import { pinKind } from '../components/workflow/workflowConnections';
import { NODE_CATEGORIES } from '../components/workflow/workflowNodeCategories';
import { nodeFields } from '../components/workflow/nodes/nodeDefaults';

const LABELS = Object.fromEntries(NODE_CATEGORIES.flatMap((c) => c.nodes.map((n) => [n.type, n.label])));
export const DATA_NODE_TYPES = ['string', 'integer', 'text', 'boolean', 'object', 'array'];
// the data pins a node has, named as the desktop's node components label them (DataInputPin)
const PIN_NAMES = {
  comparison: { 'left-in': 'left', 'right-in': 'right' },
  branch: { 'data-in': 'condition' }, boolean: { 'data-in': 'condition' },
  delay: { 'data-in': 'duration' }, forloop: { 'data-in': 'array' }, makearray: { 'data-in': 'string' },
  restapi: { 'data-in': 'override' }, ssh: { 'data-in': 'override' }, switch: { 'data-in': 'value' },
  transformation: { 'data-in': 'input' }, storage: { 'data-in': 'data' }, result: { 'data-in': 'data' }, visualizer: { 'data-in': 'data' },
};
/** The name of the data pin `handle` of a node of `type` ("left", "input"...), as the desktop labels it. */
export function pinName(type, handle) {
  const h = handle || 'data-in';
  return PIN_NAMES[type]?.[h] || h.replace(/-in$/, '') || 'data';
}
export const ANNOTATION_TYPES = ['note', 'idea'];
export function labelFor(type) {
  return LABELS[type] || type || 'Node';
}

/** The execution outlets of a node, as [handleId, caption] pairs. */
function outletsOf(node) {
  const data = node.data || {};
  switch (node.type) {
    case 'branch': return [['true', 'TRUE'], ['false', 'FALSE']];
    case 'forloop': return [['loop-body', 'LOOP'], ['completed', 'DONE']];
    case 'switch': return [...(Array.isArray(data.cases) ? data.cases : []).map((c, i) => [`case-${i}`, String(c?.value ?? `case ${i + 1}`)]), ['default', 'DEFAULT']];
    case 'sequence': return Array.from({ length: Number(data.outputCount) || 2 }, (_, i) => [`output-${i}`, `THEN ${i + 1}`]);
    default: return [['exec-out', '']];
  }
}

/**
 * Order the nodes for reading: notes, then the execution chain from Begin
 * Play (each node once; a branching node carries its outlets with their
 * targets), then whatever was not reached, data nodes last.
 */
export function linearize(nodes = [], edges = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const execTargets = (nodeId, handleId) => edges
    .filter((e) => e.source === nodeId && (e.sourceHandle || 'exec-out') === handleId && pinKind(byId.get(nodeId)?.type, e.sourceHandle || 'exec-out') === 'exec')
    .map((e) => byId.get(e.target)).filter(Boolean);
  const dataSources = (nodeId) => edges
    .filter((e) => e.target === nodeId && pinKind(byId.get(e.source)?.type, e.sourceHandle || 'exec-out') === 'data')
    .map((e) => ({ node: byId.get(e.source), handle: e.targetHandle || '' })).filter((s) => s.node);

  const seen = new Set();
  const items = [];
  const visit = (node) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    const outlets = outletsOf(node);
    const branching = outlets.length > 1 || outlets[0][0] !== 'exec-out';
    const entry = { node, inputs: dataSources(node.id), outlets: [] };
    items.push(entry);
    if (branching) {
      entry.outlets = outlets.map(([handle, caption]) => ({ handle, caption, targets: execTargets(node.id, handle) }));
      for (const outlet of entry.outlets) for (const target of outlet.targets) visit(target);
    } else {
      for (const target of execTargets(node.id, 'exec-out')) visit(target);
    }
  };

  for (const node of nodes) if (ANNOTATION_TYPES.includes(node.type)) { seen.add(node.id); items.push({ node, inputs: [], outlets: [] }); }
  for (const node of nodes) if (node.type === 'beginplay') visit(node);
  for (const node of nodes) if (!seen.has(node.id) && !DATA_NODE_TYPES.includes(node.type)) visit(node);
  for (const node of nodes) if (!seen.has(node.id)) visit(node);
  return items;
}

const text = (v) => (v == null ? '' : String(v));
const asLines = (v) => text(v).replace(/\r\n?/g, '\n').split('\n');
const pretty = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 2); } catch { return String(v); } };

/** One line that says what a node does, from its fields (where a node is named inside an outlet). */
export function summarize(node) {
  const d = nodeFields(node);
  switch (node.type) {
    case 'restapi': return { chip: text(d.method), body: text(d.url) || 'no URL yet' };
    case 'ssh': return { chip: 'SSH', body: [d.username && d.host ? `${d.username}@${d.host}` : text(d.host), text(d.command)].filter(Boolean).join('  ') || 'no command yet' };
    case 'comparison': return { chip: text(d.operator), body: '' };
    case 'delay': return { chip: 'WAIT', body: `${Number(d.duration) || 0} ms` };
    case 'storage': return { chip: 'SET', body: text(d.variableName) };
    case 'variablereference': return { chip: 'GET', body: text(d.variableName) };
    case 'transformation': return { chip: 'JS', body: asLines(d.code).find((l) => l.trim() && !l.trim().startsWith('//')) || asLines(d.code)[0] };
    case 'makearray': return { chip: 'SPLIT', body: text(d.delimiter) };
    case 'string': case 'integer': case 'text': case 'boolean': case 'object': case 'array':
      return { chip: labelFor(node.type), body: text(d.value) };
    case 'note': case 'idea': return { chip: '', body: text(d.text) };
    default: return { chip: '', body: '' };
  }
}

/**
 * The card body: what the node holds, readable - the method and the whole
 * URL, the whole code (monospace), the command, the value - and, after a
 * run, what the engine wrote into it (a Result's output, a Visualizer's
 * data, a Comparison's verdict, an error).
 *   { chip, lines, mono, wrap, output }: `lines` is the content, all of it,
 *   `mono` in a monospace block (code, values), `wrap` lets long lines wrap
 *   (URLs, commands, code) rather than scroll sideways; `output` the run's
 *   result lines.
 */
export function describe(node) {
  const d = nodeFields(node);
  const code = (v) => ({ lines: asLines(v).filter((l, i, a) => !(i === a.length - 1 && l === '')), mono: true, wrap: true });
  const value = (v) => ({ lines: asLines(pretty(v)), mono: true, wrap: true });
  let base;
  switch (node.type) {
    case 'restapi': base = { chip: text(d.method), lines: [text(d.url) || 'no URL yet'], mono: true, wrap: true }; break;
    case 'ssh': base = { chip: 'SSH', lines: [d.username && d.host ? `${d.username}@${d.host}${d.port && String(d.port) !== '22' ? `:${d.port}` : ''}` : text(d.host) || 'no host yet', ...asLines(d.command).filter(Boolean)], mono: true, wrap: true }; break;
    case 'comparison': base = { chip: text(d.operator), lines: [], mono: false, wrap: true }; break;
    case 'delay': base = { chip: 'WAIT', lines: [`${Number(d.duration) || 0} ms`], mono: false, wrap: true }; break;
    case 'storage': base = { chip: 'SET', lines: [text(d.variableName)], mono: true, wrap: true }; break;
    case 'variablereference': base = { chip: 'GET', lines: [text(d.variableName)], mono: true, wrap: true }; break;
    case 'transformation': base = { chip: 'JS', ...code(d.code) }; break;
    case 'makearray': base = { chip: 'SPLIT', lines: [`delimiter ${JSON.stringify(text(d.delimiter))}`], mono: true, wrap: true }; break;
    case 'string': case 'integer': case 'boolean': base = { chip: labelFor(node.type), lines: [text(d.value)], mono: true, wrap: true }; break;
    case 'text': base = { chip: labelFor(node.type), ...value(d.value), mono: false }; break;
    case 'object': case 'array': base = { chip: labelFor(node.type), ...value(typeof d.value === 'string' ? d.value : pretty(d.value)) }; break;
    case 'switch': base = { chip: '', lines: [], mono: false, wrap: true }; break;
    default: base = { chip: '', lines: [], mono: false, wrap: true };
  }
  base.lines = base.lines.filter((l) => l !== undefined);
  // what the run wrote into the node (the same fields the canvas nodes show)
  const output = [];
  if (d.status === 'error' && d.error != null) output.push(...asLines(`Error: ${pretty(d.error)}`));
  else if (node.type === 'result' && d.outputValue !== undefined) output.push(...asLines(pretty(d.outputValue)));
  else if (node.type === 'visualizer' && d.data !== undefined) output.push(...asLines(pretty(d.data)));
  else if (node.type === 'comparison' && d.result !== undefined) output.push(pretty(d.result) === 'true' ? 'true' : pretty(d.result) === 'false' ? 'false' : pretty(d.result));
  return { ...base, output };
}
