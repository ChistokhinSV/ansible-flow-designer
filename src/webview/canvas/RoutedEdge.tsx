// Wires on the canvas (AFD-70): React Flow's smooth step, or a route round the nodes in its way, from
// the router the exports and the layout check use. The boxes are the canvas's own nodes where they
// are drawn now, so a wire steps aside while a node is dragged across it.
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { createContext, memo, useContext, useMemo } from 'react';
import { type Box, labelBox, routeWire } from '../../core/view/route';
import { insertOnWire } from '../portActions';

/** The level's node boxes as the canvas shows them. */
export const NodeBoxes = createContext<readonly Box[]>([]);

/**
 * AFD-231: tells the canvas the pointer is on a wire's + (or left it), so the + stays while the
 * pointer goes from the wire to it.
 */
export const WireHover = createContext<(id: string | null) => void>(() => {});

export const RoutedEdge = memo(function RoutedEdge({
  id,
  data,
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
  const hover = useContext(WireHover);
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
  // AFD-231: Insert Node on This Wire in one click: beside the label, clear of its text.
  const plus = (data as { plus?: boolean } | undefined)?.plus;
  const box = text ? labelBox(text, route.label) : undefined;
  const plusAt = { x: box ? box.x + box.width + 12 : route.label.x, y: route.label.y };
  return (
    <>
      {plus ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="afd-plus afd-wire-plus nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${plusAt.x}px, ${plusAt.y}px)` }}
            title="Insert a node on this wire"
            aria-label="Insert a node on this wire"
            data-wire-plus={id}
            onMouseEnter={() => hover(id)}
            onMouseLeave={() => hover(null)}
            onClick={(e) => {
              e.stopPropagation();
              insertOnWire(id);
            }}
          >
            <span className="codicon codicon-add" aria-hidden="true" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
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
    </>
  );
});
