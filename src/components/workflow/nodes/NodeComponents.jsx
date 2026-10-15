import { Handle, Position } from 'reactflow';

/*
 * Mouse-interaction conventions for node bodies
 * --------------------------------------------
 * React Flow starts a node drag on mousedown anywhere inside a node unless the
 * event target sits inside an element with the `nodrag` class, and it zooms
 * the canvas on wheel events unless the target sits inside `nowheel`. Anything
 * a user is meant to click, type into, scroll or select text in therefore
 * carries these classes explicitly:
 *
 *   <input> / <select> / <button>   -> `nodrag`
 *   <textarea>                      -> `nodrag nowheel`
 *   scrollable / selectable output  -> `nodrag nowheel select-text cursor-text`
 *
 * Node chrome (header, padding, pin labels) stays draggable. The shared field
 * editors in NodeFields.jsx carry the classes once for every node.
 *
 * Pins
 * ----
 * A pin is the React Flow <Handle> itself, drawn ON the node's border
 * (Unreal Blueprints style): execution pins are white triangles pointing in
 * the direction of flow, data pins purple circles. Each sits in a `relative`
 * row and is absolutely positioned at the row's edge, vertically centred on
 * its label (src/index.css `.workflow-pin`), so a wire ends exactly at the
 * pin and never disappears under the node body. The wires carry no
 * arrowheads: the pin shape shows direction. The hit area is wider than the
 * drawn pin (a ::after halo), centred on it.
 */

/** A pin on the row's edge: `kind` is 'exec' (triangle) or 'data' (circle). */
export function Pin({ kind, type, position, id, isConnectable }) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      isConnectable={isConnectable}
      className={`workflow-pin workflow-pin-${kind}`}
    >
      {kind === 'exec' && (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 1.5 L12.5 7 L2 12.5 Z" />
        </svg>
      )}
    </Handle>
  );
}

/** Purple data pin (the labelled DataInputPin / DataOutputPin and BeginPlay use it). */
export function DataPinHandle({ type, position, id, isConnectable }) {
  return <Pin kind="data" type={type} position={position} id={id} isConnectable={isConnectable} />;
}

/** White execution pin. */
export function ExecPinHandle({ type, position, id, isConnectable }) {
  return <Pin kind="exec" type={type} position={position} id={id} isConnectable={isConnectable} />;
}

// Execution Input Pin (header - on the left border)
export function ExecInputPin({ isConnectable }) {
  return <ExecPinHandle type="target" position={Position.Left} id="exec-in" isConnectable={isConnectable} />;
}

// Execution Output Pin (header - on the right border)
export function ExecOutputPin({ isConnectable }) {
  return <ExecPinHandle type="source" position={Position.Right} id="exec-out" isConnectable={isConnectable} />;
}

// Data Input Pin with its label (body - on the left border)
export function DataInputPin({ isConnectable, label = "Data In", targetHandle = "data-in" }) {
  return (
    <div className="workflow-pin-row flex items-center mb-2">
      <DataPinHandle type="target" position={Position.Left} id={targetHandle} isConnectable={isConnectable} />
      <span className="text-xs text-os-text-muted ml-1">{label}</span>
    </div>
  );
}

// Data Output Pin with its label (body - on the right border)
export function DataOutputPin({ isConnectable, label = "Data Out" }) {
  return (
    <div className="workflow-pin-row flex items-center justify-end mt-2">
      <span className="text-xs text-os-text-muted mr-1">{label}</span>
      <DataPinHandle type="source" position={Position.Right} id="data-out" isConnectable={isConnectable} />
    </div>
  );
}

// Node Header with execution pins on its borders
export function NodeHeader({
  icon: Icon,
  title,
  isShared,
  status,
  hasExecInput = true,
  hasExecOutput = false,
  isConnectable,
  children
}) {
  return (
    <div className={`workflow-node-header px-3 py-2 ${isShared ? 'bg-pink-50' : 'bg-[#151515]'} rounded-t-lg border-b flex items-center gap-2 relative`}>
      {hasExecInput && <ExecInputPin isConnectable={isConnectable} />}
      {hasExecOutput && <ExecOutputPin isConnectable={isConnectable} />}

      <div className="flex items-center gap-2">
        <Icon size={16} className={isShared ? 'text-pink-600' : 'text-white'} />
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>

      {status === 'processing' && (
        <div className="ml-auto">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
        </div>
      )}
      {status === 'complete' && (
        <span className={`${children ? '' : 'ml-auto'} text-xs text-green-600`}>✓</span>
      )}
      {status === 'error' && (
        <span className={`${children ? '' : 'ml-auto'} text-xs text-red-600`}>✗</span>
      )}

      {children}
    </div>
  );
}

// Execution Output Pin with a label (body - on the right border)
export function ExecOutputPinWithLabel({ id, label, isConnectable }) {
  return (
    <div className="workflow-pin-row flex items-center justify-end">
      <span className="text-xs text-os-text-muted mr-1">{label}</span>
      <ExecPinHandle type="source" position={Position.Right} id={id} isConnectable={isConnectable} />
    </div>
  );
}

/** The engine's error for this node, shown in the body (nothing when clear). */
export function NodeError({ error, className = '' }) {
  if (!error) return null;
  return (
    <div className={`text-xs text-red-600 bg-red-50 px-2 py-1 rounded-sm ${className}`.trim()}>
      Error: {error}
    </div>
  );
}

/** Short usage hint shown inside a node body. */
export function NodeHint({ children, className = '' }) {
  return (
    <div className={`text-xs text-os-text-muted bg-blue-50 px-2 py-1.5 rounded-sm border border-blue-200 ${className}`.trim()}>
      {children}
    </div>
  );
}

const LINK_HANDLE_CLASS = 'workflow-link-handle w-2.5! h-2.5! rounded-full! border-2! border-os-card!';

/**
 * The four "link" handles of the freeform (mind-map) nodes: data-typed edges
 * in/out on the left/right plus top/bottom, all in the note's own colour.
 * No execution semantics.
 */
export function LinkHandles({ color, isConnectable }) {
  const style = { backgroundColor: color };
  return (
    <>
      <Handle type="target" position={Position.Left} id="data-in" isConnectable={isConnectable} className={LINK_HANDLE_CLASS} style={style} />
      <Handle type="target" position={Position.Top} id="link-top" isConnectable={isConnectable} className={LINK_HANDLE_CLASS} style={style} />
      <Handle type="source" position={Position.Right} id="data-out" isConnectable={isConnectable} className={LINK_HANDLE_CLASS} style={style} />
      <Handle type="source" position={Position.Bottom} id="link-bottom" isConnectable={isConnectable} className={LINK_HANDLE_CLASS} style={style} />
    </>
  );
}
