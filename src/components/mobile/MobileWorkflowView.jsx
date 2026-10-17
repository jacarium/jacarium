/* eslint-disable react-refresh/only-export-components */
import { Play, Globe, Terminal, Scale, GitBranch, Timer, Database, Variable, Code2, Eye, Flag, List, Repeat, Shuffle, ListOrdered, StickyNote, Lightbulb, Lock, Square } from 'lucide-react';
import { pinKind } from '../workflow/workflowConnections';
import { NODE_CATEGORIES } from '../workflow/workflowNodeCategories';

/**
 * A workflow on a phone: read-only, as a list instead of a canvas. The
 * execution path from Begin Play is followed node by node (a white
 * connector between cards, as the canvas draws execution edges), a
 * branching node lists each outlet with what it leads to, and the nodes
 * off that path (variables feeding data pins, notes) come first (notes)
 * or last (data). Editing - moving, connecting, deleting, the node's
 * fields - stays on the desktop: the toolbar says so.
 *
 * `linearize` is exported for the tests: it turns ReactFlow's nodes and
 * edges into the ordered list the view renders.
 */

const LABELS = Object.fromEntries(NODE_CATEGORIES.flatMap((c) => c.nodes.map((n) => [n.type, n.label])));
const DESCRIPTIONS = Object.fromEntries(NODE_CATEGORIES.flatMap((c) => c.nodes.map((n) => [n.type, n.description])));
const ICONS = {
  beginplay: Play, restapi: Globe, ssh: Terminal, comparison: Scale, branch: GitBranch, delay: Timer, storage: Database,
  variablereference: Variable, transformation: Code2, visualizer: Eye, result: Flag, makearray: List, forloop: Repeat,
  switch: Shuffle, sequence: ListOrdered, note: StickyNote, idea: Lightbulb, string: Variable, integer: Variable,
  text: Variable, boolean: Variable, object: Variable, array: Variable,
};
const DATA_NODE_TYPES = ['string', 'integer', 'text', 'boolean', 'object', 'array'];
const ANNOTATION_TYPES = ['note', 'idea'];

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

/** One line that says what a node does, from its fields. */
export function summarize(node) {
  const d = node.data || {};
  const text = (v) => (v == null ? '' : String(v));
  switch (node.type) {
    case 'restapi': return { chip: text(d.method || 'GET'), body: text(d.url) || 'no URL yet' };
    case 'ssh': return { chip: 'SSH', body: [d.username && d.host ? `${d.username}@${d.host}` : text(d.host), text(d.command)].filter(Boolean).join('  ') || 'no command yet' };
    case 'comparison': return { chip: text(d.operator || '=='), body: '' };
    case 'delay': return { chip: 'WAIT', body: `${Number(d.duration) || 0} ms` };
    case 'storage': return { chip: 'SET', body: text(d.variableName || 'data') };
    case 'variablereference': return { chip: 'GET', body: text(d.variableName || d.name || 'data') };
    case 'transformation': return { chip: 'JS', body: text(d.code).split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) || 'return input;' };
    case 'makearray': return { chip: 'SPLIT', body: text(d.separator || ',') };
    case 'string': case 'integer': case 'text': case 'boolean': case 'object': case 'array':
      return { chip: labelFor(node.type), body: text(d.value) };
    case 'note': case 'idea': return { chip: '', body: text(d.text) };
    default: return { chip: '', body: '' };
  }
}

// The accent colours are the --mob-* tokens of src/mobile.css: the mockups'
// dark values in the dark themes, their light counterparts in the light
// theme, every pair at 4.5:1 or better (tests/mobile-ui.test.mjs measures).
const CHIP = {
  GET: 'bg-[var(--mob-get-bg)] text-[var(--mob-get-text)]', POST: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]', PUT: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]',
  PATCH: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]', DELETE: 'bg-[var(--mob-delete-bg)] text-[var(--mob-delete-text)]',
};
const OUTLET_COLOR = { TRUE: 'text-[var(--mob-true)]', FALSE: 'text-[var(--mob-false)]', LOOP: 'text-[var(--mob-true)]', DONE: 'text-os-text-secondary', DEFAULT: 'text-os-text-secondary' };

function Chip({ text }) {
  if (!text) return null;
  return <span className={`px-[7px] py-[2px] rounded-xs font-mono text-[12px] font-medium ${CHIP[text] || 'bg-os-card-secondary text-os-text-secondary'}`}>{text}</span>;
}

function NodeCard({ entry }) {
  const { node, inputs, outlets } = entry;
  const Icon = ICONS[node.type] || Square;
  const { chip, body } = summarize(node);
  const title = node.data?.label || labelFor(node.type);
  if (ANNOTATION_TYPES.includes(node.type)) {
    return (
      <div data-testid="mobile-workflow-note" className="rounded-sm border border-[var(--mob-note-border)] bg-[var(--mob-note-bg)] px-[10px] py-2 flex flex-col gap-1 mb-[14px]">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--mob-note-title)]"><Icon size={12} />{node.type === 'idea' ? 'IDEA' : 'NOTE'}</div>
        <div className="font-text text-[13px] leading-[1.4] text-[var(--mob-note-text)] whitespace-pre-wrap">{body || 'Empty'}</div>
      </div>
    );
  }
  const hasBody = chip || body || inputs.length > 0 || outlets.length > 0;
  return (
    <div data-testid="mobile-workflow-node" data-node-type={node.type} className="rounded-sm border border-os-input-border bg-os-card overflow-hidden">
      <div className={`flex items-center gap-2 px-3 py-[9px] font-semibold ${hasBody ? 'border-b border-os-border' : ''}`}>
        <Icon size={14} />
        <span className="truncate">{title}</span>
        <span className="flex-1" />
        <span className="font-normal text-[12px] text-os-text-muted truncate">{DESCRIPTIONS[node.type] || ''}</span>
      </div>
      {(chip || body) && (
        <div className="px-3 pt-2 pb-[10px] flex items-center gap-2 text-[12px]">
          <Chip text={chip} />
          <span className="flex-1 min-w-0 font-mono text-os-terminal-text whitespace-nowrap overflow-hidden text-ellipsis">{body}</span>
        </div>
      )}
      {inputs.length > 0 && (
        <div className="px-3 pb-[10px] flex items-center gap-2 flex-wrap text-[12px] text-os-text-secondary">
          {inputs.map(({ node: source, handle }, i) => (
            <span key={`${source.id}-${handle}-${i}`} className="px-[7px] py-[2px] rounded-xs border border-os-border inline-flex items-center gap-1">
              <Variable size={11} />{source.data?.label || labelFor(source.type)}{summarize(source).body ? <span className="font-mono text-[var(--os-code-string)]">{JSON.stringify(summarize(source).body)}</span> : null}
            </span>
          ))}
        </div>
      )}
      {outlets.length > 0 && (
        <div className="flex flex-col">
          {outlets.map((outlet, i) => (
            <div key={outlet.handle} className={`flex items-center gap-[10px] px-3 py-[10px] ${i < outlets.length - 1 ? 'border-b border-os-border' : ''}`}>
              <span className={`w-[46px] shrink-0 font-mono text-[11px] font-medium ${OUTLET_COLOR[outlet.caption] || 'text-os-text-secondary'}`}>{outlet.caption}</span>
              {outlet.targets.length === 0 ? (
                <span className="text-[12px] text-os-text-muted">nothing connected</span>
              ) : outlet.targets.map((target) => {
                const TargetIcon = ICONS[target.type] || Square;
                const s = summarize(target);
                return (
                  <span key={target.id} className="flex items-center gap-2 min-w-0">
                    <TargetIcon size={14} className="text-os-text-secondary shrink-0" />
                    <span className="font-semibold">{target.data?.label || labelFor(target.type)}</span>
                    <Chip text={s.chip} />
                    {s.body ? <span className="font-mono text-[11px] text-os-text-secondary whitespace-nowrap overflow-hidden text-ellipsis">{s.body}</span> : null}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MobileWorkflowView({ nodes = [], edges = [] }) {
  const items = linearize(nodes, edges);
  return (
    <div data-testid="mobile-workflow-view" className="sc-workflow-reader flex-1 min-h-0 overflow-y-auto flex flex-col text-[13px] text-os-text-primary">
      {items.map((entry, i) => {
        const annotation = ANNOTATION_TYPES.includes(entry.node.type);
        const next = items[i + 1];
        const connector = !annotation && next && !ANNOTATION_TYPES.includes(next.node.type) && entry.outlets.length === 0;
        return (
          <div key={entry.node.id}>
            <NodeCard entry={entry} />
            {connector && <div className={`w-[2px] h-4 ml-[22px] ${DATA_NODE_TYPES.includes(next.node.type) ? 'bg-[var(--mob-connector-data)]' : 'bg-os-text-primary'}`} />}
          </div>
        );
      })}
      {items.length === 0 && <div className="text-os-text-muted">This workflow has no nodes.</div>}
    </div>
  );
}

/**
 * The phone toolbar above the reader: Run and Stop, and the reminder that
 * editing is a desktop affair. It sits on the reader's own surface, with
 * no band of its own under the page header.
 */
export function MobileWorkflowToolbar({ isExecuting, onRun, onStop }) {
  return (
    <div role="toolbar" aria-label="Workflow" data-testid="mobile-workflow-toolbar" className="h-[52px] shrink-0 flex items-center gap-1 pl-1.5 pr-3 text-os-text-primary">
      <button type="button" aria-label="Run workflow" data-testid="mobile-workflow-run" onClick={onRun} disabled={isExecuting} className="w-10 h-10 flex items-center justify-center disabled:text-os-text-muted"><Play size={19} /></button>
      <button type="button" aria-label="Stop workflow" data-testid="mobile-workflow-stop" onClick={onStop} disabled={!isExecuting} className="w-10 h-10 flex items-center justify-center disabled:text-os-text-muted"><Square size={19} /></button>
      <span className="flex-1" />
      <span data-testid="mobile-workflow-readonly" className="h-7 px-[10px] rounded-xs border border-os-border inline-flex items-center gap-1.5 text-[12px] text-os-text-secondary"><Lock size={13} />View only · edit on desktop</span>
    </div>
  );
}
