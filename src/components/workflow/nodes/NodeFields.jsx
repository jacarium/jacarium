import { Copy, Check, Maximize2, Minimize2 } from 'lucide-react';
import { formatNodeValue } from '../workflowNodeUtils';

/*
 * Field editors shared by the node bodies. They carry the nodrag / nowheel /
 * select-text classes (see NodeComponents.jsx) and the common input styling
 * once, so a node only says what is specific to it: the label, the height, a
 * monospace font, or the red accent of the SSH node.
 */

/** Focus-ring colour per node accent; full class names so Tailwind keeps them. */
const RING_CLASS = {
  purple: 'focus:ring-purple-500',
  red: 'focus:ring-red-500'
};

/** Label + control, stacked. */
export function NodeField({ label, className, children }) {
  return (
    <div className={className}>
      <label className="block text-xs text-os-text-secondary mb-1">{label}</label>
      {children}
    </div>
  );
}

export function NodeTextInput({ accent = 'purple', className = '', type = 'text', ...props }) {
  return (
    <input
      type={type}
      className={`nodrag w-full px-2 py-1.5 text-sm border rounded-sm focus:outline-hidden focus:ring-2 ${RING_CLASS[accent]} disabled:bg-os-card-secondary bg-os-input-bg text-os-text-primary ${className}`}
      {...props}
    />
  );
}

export function NodeTextArea({ accent = 'purple', className = '', ...props }) {
  return (
    <textarea
      className={`nodrag nowheel w-full px-2 py-1.5 text-sm border rounded-sm resize-none focus:outline-hidden focus:ring-2 ${RING_CLASS[accent]} disabled:bg-os-card-secondary bg-os-input-bg text-os-text-primary ${className}`}
      {...props}
    />
  );
}

export function NodeSelect({ accent = 'purple', className = '', children, ...props }) {
  return (
    <select
      className={`nodrag w-full px-2 py-1.5 text-sm border rounded-sm focus:outline-hidden focus:ring-2 ${RING_CLASS[accent]} disabled:bg-os-card-secondary bg-os-input-bg text-os-text-primary ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

/** Read-only preview of a stored value (Set Variable / Get Variable). */
export function NodeValuePreview({ label, value }) {
  if (value === undefined || value === null) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-medium text-os-text-secondary mb-1">{label}</div>
      <pre className="nodrag nowheel select-text cursor-text text-xs font-mono overflow-auto max-h-32 bg-os-card-secondary p-2 rounded-sm border border-os-border">
        {formatNodeValue(value)}
      </pre>
    </div>
  );
}

/** Expand/collapse + copy buttons above an output block (Result / Visualizer). */
export function OutputActions({ expanded, onToggleExpanded, copied, onCopy }) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onToggleExpanded}
        className="nodrag p-1 hover:bg-os-card transition-colors rounded-sm"
        title={expanded ? "Collapse" : "Expand"}
      >
        {expanded ? (
          <Minimize2 size={12} className="text-os-text-secondary" />
        ) : (
          <Maximize2 size={12} className="text-os-text-secondary" />
        )}
      </button>
      <button
        onClick={onCopy}
        className="nodrag p-1 hover:bg-os-card transition-colors rounded-sm"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check size={12} className="text-green-500" />
        ) : (
          <Copy size={12} className="text-os-text-secondary" />
        )}
      </button>
    </div>
  );
}
