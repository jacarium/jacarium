/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { Play, Globe, Terminal, Scale, GitBranch, Timer, Database, Variable, Code2, Eye, Flag, List, Repeat, Shuffle, ListOrdered, StickyNote, Lightbulb, Lock, Square, Eraser, Loader2, Check, X, Link } from 'lucide-react';
import { NODE_CATEGORIES } from '../workflow/workflowNodeCategories';
import { ANNOTATION_TYPES, DATA_NODE_TYPES, describe, labelFor, linearize, pinName, summarize } from '../../utils/workflowReader';
// the reader's helpers (src/utils/workflowReader.js) are re-exported for the tests
export { describe, labelFor, linearize, pinName, summarize };

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
 * `linearize`, `summarize` and `describe` (src/utils/workflowReader.js, so
 * that no utility imports this phone component) give the ordered list the
 * view renders, a node's one-line summary (used where a node is named
 * inside another's outlet) and the card body: the method and the whole URL
 * of a REST call, the whole code of a Transform, a command, a value - never
 * a bare first line, an ellipsis or a cut after some lines: the card grows
 * to fit, long lines wrap.
 *
 * A card's "Inputs" are its data connections: one chip per wire into a
 * data pin - the pin's name as the desktop labels it (left, right,
 * condition, input...), an arrow, the source node's own icon and name, and
 * its value. A tap on a chip scrolls the reader to the source's card and
 * lights it up for a moment.
 */

const DESCRIPTIONS = Object.fromEntries(NODE_CATEGORIES.flatMap((c) => c.nodes.map((n) => [n.type, n.description])));
const ICONS = {
  beginplay: Play, restapi: Globe, ssh: Terminal, comparison: Scale, branch: GitBranch, delay: Timer, storage: Database,
  variablereference: Variable, transformation: Code2, visualizer: Eye, result: Flag, makearray: List, forloop: Repeat,
  switch: Shuffle, sequence: ListOrdered, note: StickyNote, idea: Lightbulb, string: Variable, integer: Variable,
  text: Variable, boolean: Variable, object: Variable, array: Variable,
};

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

/** The content lines of a card: all of them, the card grows to fit; a long line wraps (wrap) or scrolls sideways. */
function Lines({ lines, mono, wrap, testId }) {
  if (!lines.length) return null;
  const mode = wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre overflow-x-auto';
  return (
    <div data-testid={testId} className={`min-w-0 text-[12px] leading-[1.45] ${mono ? `font-mono text-os-terminal-text ${mode}` : 'font-text whitespace-pre-wrap break-words'}`}>
      {lines.join('\n')}
    </div>
  );
}

function NodeCard({ entry, jump, lit }) {
  const { node, inputs, outlets } = entry;
  const Icon = ICONS[node.type] || Square;
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
    <div data-testid="mobile-workflow-node" data-node-id={node.id} data-node-type={node.type} data-status={node.data?.status || undefined} data-lit={lit || undefined} className={`rounded-sm border bg-os-card overflow-hidden ${lit ? 'sc-workflow-card-lit' : ''} ${status ? status.border : 'border-os-input-border'}`}>
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
          <Lines lines={lines} mono={mono} wrap={wrap} testId="mobile-workflow-node-body" />
        </div>
      )}
      {output.length > 0 && (
        <div data-testid="mobile-workflow-node-output" className={`mx-3 mb-[10px] px-2 py-1.5 rounded-xs text-[12px] font-mono whitespace-pre-wrap break-all ${node.data?.status === 'error' ? 'bg-[var(--mob-delete-bg)] text-[var(--mob-delete-text)]' : 'bg-os-card-secondary text-os-terminal-text'}`}>
          {output.join('\n')}
        </div>
      )}
      {inputs.length > 0 && (
        <div data-testid="mobile-workflow-node-inputs" className="px-3 pb-[8px] flex flex-col gap-1 text-[12px]">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-os-text-muted">INPUTS</div>
          {inputs.map(({ node: source, handle }, i) => {
            const SourceIcon = ICONS[source.type] || Square;
            const value = summarize(source).body;
            return (
              <button type="button" key={`${source.id}-${handle}-${i}`} data-testid="mobile-workflow-input" data-source-id={source.id} onClick={() => jump?.(source.id)} aria-label={`${pinName(node.type, handle)} from ${source.data?.label || labelFor(source.type)}`}
                className="min-h-[44px] w-full px-[10px] py-[6px] rounded-sm border border-os-border bg-os-card-secondary inline-flex items-center gap-[6px] min-w-0 text-left text-os-text-primary">
                <Link size={12} className="shrink-0 text-os-text-secondary" />
                <span className="font-mono text-[11px] text-os-text-secondary shrink-0">{pinName(node.type, handle)} ←</span>
                <SourceIcon size={13} className="shrink-0 text-os-text-secondary" />
                <span className="font-semibold shrink-0">{source.data?.label || labelFor(source.type)}</span>
                {value ? <span className="font-mono text-[var(--os-code-string)] [overflow-wrap:anywhere] min-w-0">{JSON.stringify(value)}</span> : null}
              </button>
            );
          })}
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
  // a tap on an input chip: the source node's card scrolls into view and lights up for a moment
  const [lit, setLit] = useState(null);
  const litTimer = useRef(null);
  useEffect(() => () => clearTimeout(litTimer.current), []);
  const jump = (id) => {
    const card = scroller.current?.querySelector(`[data-testid="mobile-workflow-node"][data-node-id="${id}"]`);
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setLit(id);
    clearTimeout(litTimer.current);
    litTimer.current = setTimeout(() => setLit(null), 1400);
  };
  return (
    <div ref={scroller} data-testid="mobile-workflow-view" onTouchMove={byHand} onWheel={byHand} className="sc-workflow-reader flex-1 min-h-0 overflow-y-auto flex flex-col text-[13px] text-os-text-primary">
      {items.map((entry, i) => {
        const annotation = ANNOTATION_TYPES.includes(entry.node.type);
        const next = items[i + 1];
        // the gap to the next card is the same whether a connector line is drawn in it (the execution
        // path goes on) or not (a branch's targets follow in its outlets; an unconnected chain starts)
        const gap = !annotation && next && !ANNOTATION_TYPES.includes(next.node.type);
        const connector = gap && entry.outlets.length === 0;
        return (
          <div key={entry.node.id}>
            <NodeCard entry={entry} jump={jump} lit={lit === entry.node.id} />
            {gap && <div data-testid="mobile-workflow-gap" data-link={connector ? 'true' : 'false'} className={`w-[2px] h-4 ml-[22px] ${!connector ? '' : DATA_NODE_TYPES.includes(next.node.type) ? 'bg-[var(--mob-connector-data)]' : 'bg-os-text-primary'}`} />}
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
