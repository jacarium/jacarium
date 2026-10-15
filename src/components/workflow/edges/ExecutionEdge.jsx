import { BaseEdge, getBezierPath } from 'reactflow';

/**
 * Control-flow edge: a light core stroke over a darker outline so it stays
 * visible on both light and dark canvases, running from the source pin to
 * the target pin. Selection turns the outline blue (hover does the same in
 * CSS). Direction is shown by the pins themselves (white triangles, see
 * NodeComponents.jsx), so the wire carries no arrowhead.
 */
export default function ExecutionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  selected,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const outline = selected ? '#3b82f6' : '#5a5a5a';
  const core = '#f5f5f5';

  return (
    <>
      <path
        className="workflow-edge-outline"
        d={edgePath}
        style={{
          fill: 'none',
          strokeWidth: selected ? 7 : 5,
          stroke: outline,
          strokeLinecap: 'round',
        }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        interactionWidth={24}
        style={{
          ...style,
          strokeWidth: 3,
          stroke: core,
          strokeLinecap: 'round',
        }}
      />
    </>
  );
}
