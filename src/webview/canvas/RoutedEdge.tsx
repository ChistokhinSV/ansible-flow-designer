// Wires on the canvas (AFD-70): React Flow's smooth step, or a route round the nodes in its way, from
// the router the exports and the layout check use. The boxes are the canvas's own nodes where they
// are drawn now, so a wire steps aside while a node is dragged across it.
import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { createContext, memo, useContext, useMemo } from 'react';
import { type Box, routeWire } from '../../core/view/route';

/** The level's node boxes as the canvas shows them. */
export const NodeBoxes = createContext<readonly Box[]>([]);

export const RoutedEdge = memo(function RoutedEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerEnd,
  markerStart,
  interactionWidth,
}: EdgeProps) {
  const boxes = useContext(NodeBoxes);
  const text = typeof label === 'string' ? label : undefined;
  const route = useMemo(
    () =>
      routeWire(
        { x: sourceX, y: sourceY },
        sourcePosition,
        { x: targetX, y: targetY },
        targetPosition,
        boxes,
        text,
      ),
    [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, boxes, text],
  );
  return (
    <BaseEdge
      path={route.path}
      labelX={route.label.x}
      labelY={route.label.y}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
    />
  );
});
