/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { Play, Globe, Terminal, Scale, GitBranch, Timer, Database, Variable, Code2, Eye, Flag, List, Repeat, Shuffle, ListOrdered, StickyNote, Lightbulb, Lock, Square, Eraser, Loader2, Check, X } from 'lucide-react';
import { pinKind } from '../workflow/workflowConnections';
import { NODE_CATEGORIES } from '../workflow/workflowNodeCategories';

/**
 * A workflow on a phone: read-only, as a list instead of a canvas. The
 * execution path from Begin Play is followed node by node (a white
 * connector between cards, as the canvas draws execution edges), a
 * branching node lists each outlet with what it leads to, and the nodes
 * off that path (variables feeding data pins, notes) come first (notes)
 * or last (data). Editing - moving, connecting, deleting, the node's
 * fields - stays on the desktop: the toolbar says so. Running is not
 * editing: Run, Stop and Clear work as on the desktop, and the cards show
 * the same live execution state the canvas nodes do - it is the same node
 * state (node.data.status, the results the engine writes into result-like
 * nodes), rendered by the reader: no second copy of the run logic.
 *
 * `linearize` and `summarize` are exported for the tests: the ordered list
 * the view renders, and a node's one-line summary (used where a node is
 * named inside another's outlet). `describe` gives the card body: the
 * method and the whole URL of a REST call, several lines of a Transform's
 * code, a command, a value - never a bare first line or an ellipsis.
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
const PREVIEW_LINES = 6;

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
  const d = node.data || {};
  switch (node.type) {
    case 'restapi': return { chip: text(d.method || 'GET'), body: text(d.url) || 'no URL yet' };
    case 'ssh': return { chip: 'SSH', body: [d.username && d.host ? `${d.username}@${d.host}` : text(d.host), text(d.command)].filter(Boolean).join('  ') || 'no command yet' };
    case 'comparison': return { chip: text(d.operator || '=='), body: '' };
    case 'delay': return { chip: 'WAIT', body: `${Number(d.duration) || 0} ms` };
    case 'storage': return { chip: 'SET', body: text(d.variableName || 'data') };
    case 'variablereference': return { chip: 'GET', body: text(d.variableName || d.name || 'data') };
    case 'transformation': return { chip: 'JS', body: asLines(d.code).find((l) => l.trim() && !l.trim().startsWith('//')) || 'return input;' };
    case 'makearray': return { chip: 'SPLIT', body: text(d.separator || ',') };
    case 'string': case 'integer': case 'text': case 'boolean': case 'object': case 'array':
      return { chip: labelFor(node.type), body: text(d.value) };
    case 'note': case 'idea': return { chip: '', body: text(d.text) };
    default: return { chip: '', body: '' };
  }
}

/**
 * The card body: what the node holds, readable - the method and the whole
 * URL, the code (several lines, monospace), the command, the value - and,
 * after a run, what the engine wrote into it (a Result's output, a
 * Visualizer's data, a Comparison's verdict, an error).
 *   { chip, lines, mono, wrap, output }: `lines` is the content, `mono`
 *   in a monospace block (code, values), `wrap` lets long lines wrap (URLs,
 *   commands) rather than scroll sideways; `output` the run's result lines.
 */
export function describe(node) {
  const d = node.data || {};
  const code = (v) => ({ lines: asLines(v).filter((l, i, a) => !(i === a.length - 1 && l === '')), mono: true, wrap: false });
  const value = (v) => ({ lines: asLines(pretty(v)), mono: true, wrap: true });
  let base;
  switch (node.type) {
    case 'restapi': base = { chip: text(d.method || 'GET'), lines: [text(d.url) || 'no URL yet'], mono: true, wrap: true }; break;
    case 'ssh': base = { chip: 'SSH', lines: [d.username && d.host ? `${d.username}@${d.host}${d.port && String(d.port) !== '22' ? `:${d.port}` : ''}` : text(d.host) || 'no host yet', ...asLines(d.command).filter(Boolean)], mono: true, wrap: true }; break;
    case 'comparison': base = { chip: text(d.operator || '=='), lines: [], mono: false, wrap: true }; break;
    case 'delay': base = { chip: 'WAIT', lines: [`${Number(d.duration) || 0} ms`], mono: false, wrap: true }; break;
    case 'storage': base = { chip: 'SET', lines: [text(d.variableName || 'data')], mono: true, wrap: true }; break;
    case 'variablereference': base = { chip: 'GET', lines: [text(d.variableName || d.name || 'data')], mono: true, wrap: true }; break;
    case 'transformation': base = { chip: 'JS', ...code(text(d.code) || 'return input;') }; break;
    case 'makearray': base = { chip: 'SPLIT', lines: [`separator ${JSON.stringify(text(d.separator || ','))}`], mono: true, wrap: true }; break;
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

const CHIP = {
  GET: 'bg-[var(--mob-get-bg)] text-[var(--mob-get-text)]', POST: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]', PUT: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]',
  PATCH: 'bg-[var(--mob-post-bg)] text-[var(--mob-post-text)]', DELETE: 'bg-[var(--mob-delete-bg)] text-[var(--mob-delete-text)]',
};
const OUTLET_COLOR = { TRUE: 'text-[var(--mob-true)]', FALSE: 'text-[var(--mob-false)]', LOOP: 'text-[var(--mob-true)]', DONE: 'text-os-text-secondary', DEFAULT: 'text-os-text-secondary' };
// the execution states, as the canvas nodes carry them (node.data.status)
const STATUS = {
  processing: { border: 'border-os-blue workflow-node-processing', chip: 'text-os-blue', label: 'running', Icon: Loader2, spin: true },
  complete: { border: 'border-[var(--mob-true)]', chip: 'text-[var(--mob-true)]', label: 'done', Icon: Check, spin: false },
  error: { border: 'border-[var(--mob-false)]', chip: 'text-[var(--mob-false)]', label: 'failed', Icon: X, spin: false },
};

function Chip({ text: t }) {
  if (!t) return null;
  return <span className={`px-[7px] py-[2px] rounded-xs font-mono text-[12px] font-medium ${CHIP[t] || 'bg-os-card-secondary text-os-text-secondary'}`}>{t}</span>;
}

/** The content lines of a card: a preview of PREVIEW_LINES, the rest on a tap. */
function Lines({ lines, mono, wrap, expanded, onToggle, testId }) {
  if (!lines.length) return null;
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const more = lines.length - shown.length;
  const mode = wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto';
  return (
    <div data-testid={testId} className={`min-w-0 text-[12px] leading-[1.45] ${mono ? `font-mono text-os-terminal-text ${mode}` : 'font-text whitespace-pre-wrap break-words'}`}>
      {shown.join('\n')}
      {more > 0 && (
        <button type="button" onClick={onToggle} className="block mt-1 text-[12px] font-text text-os-text-secondary underline-offset-2">… {more} more line{more === 1 ? '' : 's'}</button>
      )}
      {expanded && lines.length > PREVIEW_LINES && (
        <button type="button" onClick={onToggle} className="block mt-1 text-[12px] font-text text-os-text-secondary">show less</button>
      )}
    </div>
  );
}

function NodeCard({ entry }) {
  const { node, inputs, outlets } = entry;
  const Icon = ICONS[node.type] || Square;
  const [expanded, setExpanded] = useState(false);
  const title = node.data?.label || labelFor(node.type);
  if (ANNOTATION_TYPES.includes(node.type)) {
    return (
      <div data-testid="mobile-workflow-note" className="rounded-sm border border-[var(--mob-note-border)] bg-[var(--mob-note-bg)] px-[10px] py-2 flex flex-col gap-1 mb-[14px]">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--mob-note-title)]"><Icon size={12} />{node.type === 'idea' ? 'IDEA' : 'NOTE'}</div>
        <div className="font-text text-[13px] leading-[1.4] text-[var(--mob-note-text)] whitespace-pre-wrap">{node.data?.text || 'Empty'}</div>
      </div>
    );
  }
  const { chip, lines, mono, wrap, output } = describe(node);
  const status = STATUS[node.data?.status] || null;
  const hasBody = chip || lines.length > 0 || output.length > 0 || inputs.length > 0 || outlets.length > 0;
  return (
    <div data-testid="mobile-workflow-node" data-node-type={node.type} data-status={node.data?.status || undefined} className={`rounded-sm border bg-os-card overflow-hidden ${status ? status.border : 'border-os-input-border'}`}>
      <div className={`flex items-center gap-2 px-3 py-[9px] font-semibold ${hasBody ? 'border-b border-os-border' : ''}`}>
        <Icon size={14} />
        <span className="truncate">{title}</span>
        <span className="flex-1" />
        {status ? (
          <span data-testid="mobile-workflow-node-status" className={`inline-flex items-center gap-1 font-normal text-[12px] ${status.chip}`}>
            <status.Icon size={13} className={status.spin ? 'animate-spin' : ''} />{status.label}
          </span>
        ) : (
          <span className="font-normal text-[12px] text-os-text-muted truncate">{DESCRIPTIONS[node.type] || ''}</span>
        )}
      </div>
      {(chip || lines.length > 0) && (
        <div className="px-3 pt-2 pb-[10px] flex items-start gap-2 text-[12px]">
          <Chip text={chip} />
          <Lines lines={lines} mono={mono} wrap={wrap} expanded={expanded} onToggle={() => setExpanded((v) => !v)} testId="mobile-workflow-node-body" />
        </div>
      )}
      {output.length > 0 && (
        <div data-testid="mobile-workflow-node-output" className={`mx-3 mb-[10px] px-2 py-1.5 rounded-xs text-[12px] font-mono whitespace-pre-wrap break-all ${node.data?.status === 'error' ? 'bg-[var(--mob-delete-bg)] text-[var(--mob-delete-text)]' : 'bg-os-card-secondary text-os-terminal-text'}`}>
          {(expanded ? output : output.slice(0, PREVIEW_LINES)).join('\n')}{output.length > PREVIEW_LINES && !expanded ? `\n… ${output.length - PREVIEW_LINES} more lines` : ''}
        </div>
      )}
      {inputs.length > 0 && (
        <div className="px-3 pb-[10px] flex items-center gap-2 flex-wrap text-[12px] text-os-text-secondary">
          {inputs.map(({ node: source, handle }, i) => (
            <span key={`${source.id}-${handle}-${i}`} className="px-[7px] py-[2px] rounded-xs border border-os-border inline-flex items-center gap-1 min-w-0">
              <Variable size={11} className="shrink-0" />{source.data?.label || labelFor(source.type)}{summarize(source).body ? <span className="font-mono text-[var(--os-code-string)] break-all">{JSON.stringify(summarize(source).body)}</span> : null}
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
                    <span className="font-semibold whitespace-nowrap shrink-0">{target.data?.label || labelFor(target.type)}</span>
                    {s.chip ? <span className="shrink-0"><Chip text={s.chip} /></span> : null}
                    {s.body ? <span className="font-mono text-[11px] text-os-text-secondary whitespace-nowrap overflow-hidden text-ellipsis min-w-0">{s.body}</span> : null}
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
  const scroller = useRef(null);
  // Follow the run: the card of the node being executed is scrolled into
  // view - unless the reader was scrolled by hand during this run (a touch
  // or a wheel on it), which hands the scrolling back to the reader until
  // the next run starts.
  const handScrolled = useRef(false);
  const running = nodes.find((n) => n.data?.status === 'processing')?.id || null;
  const anyRun = nodes.some((n) => n.data?.status);
  useEffect(() => { if (!anyRun) handScrolled.current = false; }, [anyRun]);
  useEffect(() => {
    if (!running || handScrolled.current || !scroller.current) return;
    const card = scroller.current.querySelector(`[data-testid="mobile-workflow-node"][data-status="processing"]`);
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [running]);
  const byHand = () => { if (anyRun) handScrolled.current = true; };
  return (
    <div ref={scroller} data-testid="mobile-workflow-view" onTouchMove={byHand} onWheel={byHand} className="sc-workflow-reader flex-1 min-h-0 overflow-y-auto flex flex-col text-[13px] text-os-text-primary">
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
 * The phone toolbar above the reader: Run, Stop and Clear (the node outputs
 * of the last run, as the desktop's Eraser), and the reminder that editing
 * is a desktop affair. It sits on the reader's own surface.
 */
export function MobileWorkflowToolbar({ isExecuting, onRun, onStop, onClear }) {
  return (
    <div role="toolbar" aria-label="Workflow" data-testid="mobile-workflow-toolbar" className="h-[52px] shrink-0 flex items-center gap-1 pl-1.5 pr-3 text-os-text-primary">
      <button type="button" aria-label="Run workflow" data-testid="mobile-workflow-run" onClick={onRun} disabled={isExecuting} className="w-10 h-10 flex items-center justify-center disabled:text-os-text-muted"><Play size={19} /></button>
      <button type="button" aria-label="Stop workflow" data-testid="mobile-workflow-stop" onClick={onStop} disabled={!isExecuting} className="w-10 h-10 flex items-center justify-center disabled:text-os-text-muted"><Square size={19} /></button>
      {onClear && <button type="button" aria-label="Clear node outputs" title="Clear node outputs" data-testid="mobile-workflow-clear" onClick={onClear} disabled={isExecuting} className="w-10 h-10 flex items-center justify-center disabled:text-os-text-muted"><Eraser size={19} /></button>}
      <span className="flex-1" />
      <span data-testid="mobile-workflow-readonly" className="h-7 px-[10px] rounded-xs border border-os-border inline-flex items-center gap-1.5 text-[12px] text-os-text-secondary"><Lock size={13} />View only · edit on desktop</span>
    </div>
  );
}
