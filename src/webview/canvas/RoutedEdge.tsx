// Wires on the canvas (AFD-70): React Flow's smooth step, or a route round the nodes in its way, from
// the router the exports and the layout check use. AFD-294: or curved, as the setting says. The boxes are the canvas's own nodes where they
// are drawn now, so a wire steps aside while a node is dragged across it. AFD-345: the route then
// goes through the level's lane pass (wireLanes.ts), so wires sharing a line run side by side.
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { type Box, labelBox, routeWire } from '../../core/view/route';
import { insertOnWire } from '../portActions';
import { useUi } from '../store';
import { WireLanes } from './wireLanes';

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
  source,
  target,
  sourceHandleId,
  targetHandleId,
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
  const wireStyle = useUi((s) => s.wireStyle);
  const text = typeof label === 'string' ? label : undefined;
  const lanes = useContext(WireLanes);
  const own = useMemo(
    () =>
      routeWire(
        { x: sourceX, y: sourceY },
        sourcePosition,
        { x: targetX, y: targetY },
        targetPosition,
        boxes,
        text,
        wireStyle,
      ),
    [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, boxes, text, wireStyle],
  );
  useLayoutEffect(() => {
    lanes?.put({
      id,
      a: { x: sourceX, y: sourceY },
      b: { x: targetX, y: targetY },
      from: `${source}.${sourceHandleId ?? ''}`,
      to: `${target}.${targetHandleId ?? ''}`,
      route: own,
      ...(text ? { label: text } : {}),
      style: wireStyle,
    });
  }, [
    lanes,
    id,
    own,
    sourceX,
    sourceY,
    targetX,
    targetY,
    source,
    target,
    sourceHandleId,
    targetHandleId,
    text,
    wireStyle,
  ]);
  useLayoutEffect(() => () => lanes?.drop(id), [lanes, id]);
  const subscribe = useCallback(
    (fn: () => void) => (lanes ? lanes.subscribe(id, fn) : () => {}),
    [lanes, id],
  );
  const spread = useSyncExternalStore(subscribe, () => lanes?.get(id));
  // Until the pass has seen this route (a drag frame), the route as routed.
  const route = spread && spread.base === own ? spread.route : own;
  // AFD-231: Insert Node on This Wire in one click: beside the label, clear of its text.
  const plus = (data as { plus?: boolean } | undefined)?.plus;
  const box = text ? labelBox(text, route.label) : undefined;
  const plusAt = { x: box ? box.x + box.width + 12 : route.label.x, y: route.label.y };
  // AFD-378: the port name over every wire, not in this wire's SVG: a wire drawn after it (two
  // fail wires sharing a lane) struck it through.
  const labelClass = (data as { labelClass?: string } | undefined)?.labelClass ?? '';
  return (
    <>
      {text ? (
        <EdgeLabelRenderer>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the wire is the control; the label is a larger target for the mouse. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the wire itself takes the keyboard. */}
          <div
            className={`afd-wire-label nodrag nopan ${labelClass}`}
            data-edge-label={id}
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`,
            }}
            onMouseEnter={() => hover(id)}
            onMouseLeave={() => hover(null)}
            onClick={(e) => {
              e.stopPropagation();
              if (useUi.getState().selection.edge !== id) useUi.getState().select({ edge: id });
            }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
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
        label={text ? undefined : label}
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
