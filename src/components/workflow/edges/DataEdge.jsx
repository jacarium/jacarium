import { BaseEdge, getBezierPath } from 'reactflow';

/**
 * Data-flow (and note "link") edge: thin coloured stroke, thicker with a soft
 * glow when selected, running from the data-out pin to the data-in pin.
 * `data.color` overrides the default purple. Direction is shown by the pins
 * (see NodeComponents.jsx), so the wire carries no arrowhead.
 */
export default function DataEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
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

  const stroke = data?.color || '#9333ea';

  return (
    <>
      {selected && (
        <path
          className="workflow-edge-outline"
          d={edgePath}
          style={{ fill: 'none', stroke, strokeOpacity: 0.3, strokeWidth: 8, strokeLinecap: 'round' }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        interactionWidth={24}
        style={{
          ...style,
          strokeWidth: selected ? 3 : 2,
          stroke,
          strokeLinecap: 'round',
        }}
      />
    </>
  );
}
