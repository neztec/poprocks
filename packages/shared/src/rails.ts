import { RAIL } from './constants';
import { emptyResources, totalResources, type Resources } from './materials';
import { lineClear, type Asteroid } from './terrain';

export interface RailNode {
  id: number;
  x: number;
  y: number;
  /** ore waiting at this node for a cart */
  cargo: Resources;
}

/** Undirected rail graph for one star system. Plain data so it serializes as-is. */
export interface RailNet {
  nextId: number;
  nodes: RailNode[];
  edges: [number, number][];
}

export function emptyRailNet(): RailNet {
  return { nextId: 1, nodes: [], edges: [] };
}

export function getNode(net: RailNet, id: number): RailNode | undefined {
  return net.nodes.find((n) => n.id === id);
}

export function nearestNode(net: RailNet, x: number, y: number, maxDist: number, exclude?: number): RailNode | null {
  let best: RailNode | null = null;
  let bestD = maxDist * maxDist;
  for (const n of net.nodes) {
    if (n.id === exclude) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

export function neighbors(net: RailNet, id: number): number[] {
  const out: number[] = [];
  for (const [a, b] of net.edges) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

function hasEdge(net: RailNet, a: number, b: number): boolean {
  return net.edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
}

export function addNode(net: RailNet, x: number, y: number): RailNode {
  const n: RailNode = { id: net.nextId++, x: Math.round(x), y: Math.round(y), cargo: emptyResources() };
  net.nodes.push(n);
  return n;
}

export function link(net: RailNet, a: number, b: number): void {
  if (a !== b && !hasEdge(net, a, b)) net.edges.push([a, b]);
}

/**
 * Rail laying, called each step while a layer holds the action button.
 * Returns the new tail node id (or the old one if nothing changed), and whether the net changed.
 */
export function extendRail(
  net: RailNet,
  asteroids: Asteroid[],
  tailId: number | null,
  x: number,
  y: number,
): { tail: number | null; changed: boolean } {
  const tail = tailId != null ? getNode(net, tailId) : undefined;
  if (!tail) {
    const near = nearestNode(net, x, y, RAIL.snap * 1.5);
    if (near) return { tail: near.id, changed: false };
    return { tail: addNode(net, x, y).id, changed: true };
  }
  const d = Math.hypot(x - tail.x, y - tail.y);
  const snap = nearestNode(net, x, y, RAIL.snap, tail.id);
  if (snap && d > RAIL.snap && !hasEdge(net, tail.id, snap.id)) {
    if (!lineClear(asteroids, tail.x, tail.y, snap.x, snap.y)) return { tail: tail.id, changed: false };
    link(net, tail.id, snap.id);
    return { tail: snap.id, changed: true };
  }
  if (d < RAIL.spacing) return { tail: tail.id, changed: false };
  if (!lineClear(asteroids, tail.x, tail.y, x, y)) return { tail: tail.id, changed: false };
  const n = addNode(net, x, y);
  link(net, tail.id, n.id);
  return { tail: n.id, changed: true };
}

export function isDepot(node: RailNode, mx: number, my: number): boolean {
  return Math.hypot(node.x - mx, node.y - my) <= RAIL.depotRadius;
}

/** Breadth-first path (list of node ids, inclusive) to the first node matching `goal`. */
export function findPath(net: RailNet, from: number, goal: (n: RailNode) => boolean): number[] | null {
  const prev = new Map<number, number>();
  const queue = [from];
  prev.set(from, -1);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = getNode(net, id);
    if (node && goal(node)) {
      const path: number[] = [];
      for (let cur = id; cur !== -1; cur = prev.get(cur)!) path.push(cur);
      return path.reverse();
    }
    for (const nb of neighbors(net, id)) {
      if (!prev.has(nb)) {
        prev.set(nb, id);
        queue.push(nb);
      }
    }
  }
  return null;
}

export function nodeHasCargo(n: RailNode): boolean {
  return totalResources(n.cargo) > 0;
}

/** Every node connected by track to any of `starts` (including them). */
export function connectedTo(net: RailNet, starts: number[]): Set<number> {
  const adj = new Map<number, number[]>();
  for (const [a, b] of net.edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    for (const n of adj.get(queue.pop()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** What a crew's carts are up to, for the HUD. */
export interface CartSummary {
  /** stowed inside the mothership */
  aboard: number;
  /** parked on the rail waiting for cargo */
  waiting: number;
  /** riding out to cargo or back to the depot */
  hauling: number;
  /** some rail node sits inside the mothership's depot ring */
  depotLinked: boolean;
  /** cargo piles sitting on rail nodes */
  cargoPiles: number;
  /** cargo piles no cart can reach from the depot */
  unreachablePiles: number;
}
