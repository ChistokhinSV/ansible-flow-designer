// AFD-345: the canvas's wires side by side. Each RoutedEdge routes itself (memoised, so a drag
// reroutes only the wires that moved) and puts its route here; once a render has put them all,
// spreadWires runs over the whole level, as the exports and the layout check do, and each edge
// draws its own spread route. It runs in a microtask after the render's layout effects, so the
// spread route is drawn in the same frame, before the browser paints.
import { createContext } from 'react';
import { type LaneWire, spreadWires } from '../../core/view/lanes';
import type { Box, Route } from '../../core/view/route';

/** A wire's route as spread, with the route it was spread from. */
export interface Spread {
  base: Route;
  route: Route;
}

const same = (a: Route, b: Route) =>
  a.path === b.path && a.label.x === b.label.x && a.label.y === b.label.y;

export class WireLaneStore {
  private wires = new Map<string, LaneWire>();
  private boxes: readonly Box[] = [];
  private spread = new Map<string, Spread>();
  private listeners = new Map<string, Set<() => void>>();
  private queued = false;

  put(wire: LaneWire): void {
    if (this.wires.get(wire.id) === wire) return;
    this.wires.set(wire.id, wire);
    this.schedule();
  }

  drop(id: string): void {
    if (!this.wires.delete(id)) return;
    this.spread.delete(id);
    this.schedule();
  }

  setBoxes(boxes: readonly Box[]): void {
    if (this.boxes === boxes) return;
    this.boxes = boxes;
    this.schedule();
  }

  subscribe(id: string, fn: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set<() => void>();
    this.listeners.set(id, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  get(id: string): Spread | undefined {
    return this.spread.get(id);
  }

  /** Runs the pass now (tests, and the microtask). */
  run(): void {
    this.queued = false;
    const wires = [...this.wires.values()];
    const routes = spreadWires(wires, this.boxes);
    const changed: string[] = [];
    for (const w of wires) {
      const route = routes.get(w.id) ?? w.route;
      const old = this.spread.get(w.id);
      if (old && old.base === w.route && same(old.route, route)) continue;
      this.spread.set(w.id, { base: w.route, route });
      changed.push(w.id);
    }
    for (const id of changed) for (const fn of this.listeners.get(id) ?? []) fn();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      if (this.queued) this.run();
    });
  }
}

/** The canvas's lane store; none outside a canvas, where each wire keeps its own route. */
export const WireLanes = createContext<WireLaneStore | null>(null);
