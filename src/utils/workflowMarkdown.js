/**
 * A workflow as readable Markdown for the AI chat ("Add as AI Context" on a
 * workflow): the nodes in execution order - the phone reader's order
 * (workflowReader linearize: notes, then the chain from Begin Play,
 * then what was not reached) - each with its type and key fields the way
 * the reader describes them (REST method and URL, SSH user@host and
 * command, Transform code, Condition operator, values...), its data inputs
 * and its outlets with their targets, then the connections. Never a raw
 * JSON dump.
 */
import { linearize, describe, labelFor } from './workflowReader';

const ANNOTATIONS = ['note', 'idea'];

export function workflowMarkdown(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  if (!nodes.length) return '_(this workflow has no nodes)_';
  const entries = linearize(nodes, edges);
  const index = new Map(entries.map((e, i) => [e.node.id, i + 1]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = (n) => String(n?.data?.label || labelFor(n?.type) || 'Node');
  const ref = (n) => `${name(n)} (#${index.get(n.id) ?? '?'})`;
  const lines = [];
  if (workflow?.description) lines.push(String(workflow.description), '');

  entries.forEach((entry, i) => {
    const { node, inputs, outlets } = entry;
    if (ANNOTATIONS.includes(node.type)) {
      lines.push(`> ${node.type === 'idea' ? 'Idea' : 'Note'}: ${String(node.data?.text || '').replace(/\n/g, '\n> ')}`, '');
      return;
    }
    const d = describe(node);
    const type = labelFor(node.type);
    const chip = d.chip && d.chip !== type ? ` ${d.chip}` : '';
    lines.push(`### ${i + 1}. ${name(node)} - ${type}${chip}`);
    if (d.lines.length) {
      if (d.mono) lines.push('```', ...d.lines, '```');
      else lines.push(...d.lines);
    }
    if (inputs.length) lines.push(`- inputs: ${inputs.map((s) => `${ref(s.node)} -> ${s.handle || 'data'}`).join(', ')}`);
    for (const o of outlets) lines.push(`- ${o.caption || o.handle}: ${o.targets.length ? o.targets.map(ref).join(', ') : '(nothing)'}`);
    lines.push('');
  });

  lines.push('### Connections');
  const connections = edges.map((e) => {
    const a = byId.get(e.source); const b = byId.get(e.target);
    if (!a || !b) return null;
    const out = e.sourceHandle && e.sourceHandle !== 'exec-out' ? ` [${e.sourceHandle}]` : '';
    const into = e.targetHandle && e.targetHandle !== 'exec-in' ? ` [${e.targetHandle}]` : '';
    return `- ${ref(a)}${out} -> ${ref(b)}${into}`;
  }).filter(Boolean);
  lines.push(...(connections.length ? connections : ['_(none)_']));
  return lines.join('\n').trim();
}

/** The payload "Add as AI Context" dispatches for a workflow. */
export function workflowContextPayload(workflow) {
  return { kind: 'workflow', title: workflow?.title || 'Untitled workflow', category: workflow?.category || '', content: workflowMarkdown(workflow), source: { kind: 'workflow', id: workflow?.id } };
}
