import {
  DT,
  RAIL,
  RESOURCE_KINDS,
  createAsteroid,
  emptyResources,
  encodeCells,
  extendRail,
  findPath,
  generateAsteroid,
  getNode,
  isDepot,
  isSolidAt,
  mulberry32,
  nodeHasCargo,
  totalResources,
  type Asteroid,
  type AsteroidWire,
  type CraftKind,
  type GravityBody,
  type PaintOp,
  type RailNet,
  type RailNode,
  type Resources,
  type ShipState,
  type SpaceInfo,
  type SystemWire,
} from '@poprock/shared';
import type { AsteroidRow, Store, SystemRow } from './db';

export interface Craft {
  ship: ShipState;
  kind: CraftKind;
  ownerId: number;
  crewId: number;
  cargo: Resources;
  /** rail node the layer is currently extending from */
  railTail: number | null;
}

type CartState = 'garage' | 'idle' | 'toPickup' | 'toDepot';

export interface Cart {
  id: number;
  crewId: number;
  x: number;
  y: number;
  angle: number;
  state: CartState;
  /** node the cart is sitting at (idle) */
  at: number | null;
  path: number[];
  pathIdx: number;
  cargo: Resources;
  claim: number | null;
}

export interface Critter {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  wander: number;
}

/** What the system needs from the game: ids, crews, and where motherships are parked. */
export interface SystemHost {
  nextEntityId(): number;
  parkedMotherships(systemId: number): { crewId: number; x: number; y: number }[];
  deposit(crewId: number, res: Resources): void;
}

export class SystemSpace {
  row: SystemRow;
  asteroids: Asteroid[] = [];
  asteroidRows: AsteroidRow[] = [];
  rails: RailNet;
  railsDirty = false;
  railsUnsaved = false;
  /** bumped whenever clients need a full reload (admin edits) */
  version = 0;
  crafts = new Map<number, Craft>();
  carts: Cart[] = [];
  critters: Critter[] = [];
  paintQueue: PaintOp[] = [];
  private rand: () => number;
  private respawnTimer = 0;

  constructor(
    row: SystemRow,
    private store: Store,
    private host: SystemHost,
  ) {
    this.row = row;
    this.rand = mulberry32(row.id * 9973 + Date.now());
    this.rails = store.loadRails(row.id);
    this.loadAsteroids();
  }

  get bodies(): GravityBody[] {
    return this.row.def.bodies;
  }

  loadAsteroids(): void {
    this.asteroidRows = this.store.listAsteroids(this.row.id);
    this.asteroids = this.asteroidRows.map((r) => {
      const saved = this.store.loadCells(r.id);
      const fresh = generateAsteroid({ id: r.id, x: r.x, y: r.y, radius: r.radius, seed: r.seed });
      if (saved && saved.cols === fresh.cols && saved.rows === fresh.rows) {
        return createAsteroid(r.id, fresh.x, fresh.y, saved.cols, saved.rows, saved.cells);
      }
      fresh.dirty = true; // persist the generated state
      return fresh;
    });
  }

  /** Reload after an admin edit. Running crafts stay where they are. */
  reload(row: SystemRow): void {
    this.row = row;
    this.loadAsteroids();
    this.version++;
  }

  wire(): SystemWire {
    return { id: this.row.id, name: this.row.name, gx: this.row.gx, gy: this.row.gy, color: this.row.color };
  }

  spaceInfo(): SpaceInfo {
    const asteroids: AsteroidWire[] = this.asteroids.map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      cols: a.cols,
      rows: a.rows,
      data: encodeCells(a.cells),
    }));
    return { kind: 'system', system: this.wire(), bodies: this.bodies, asteroids };
  }

  // ---- rails ----

  layRail(craft: Craft, laying: boolean): void {
    if (!laying) {
      craft.railTail = null;
      return;
    }
    const res = extendRail(this.rails, this.asteroids, craft.railTail, craft.ship.x, craft.ship.y);
    craft.railTail = res.tail;
    if (res.changed) {
      this.railsDirty = true;
      this.railsUnsaved = true;
    }
  }

  /** Driller drops its hold onto the nearest rail node for a cart to haul. */
  dropCargo(craft: Craft): boolean {
    if (totalResources(craft.cargo) === 0) return false;
    let best: { id: number; d: number } | null = null;
    for (const n of this.rails.nodes) {
      const d = Math.hypot(n.x - craft.ship.x, n.y - craft.ship.y);
      if (d <= RAIL.dropRadius && (!best || d < best.d)) best = { id: n.id, d };
    }
    if (!best) return false;
    const node = getNode(this.rails, best.id)!;
    for (const k of RESOURCE_KINDS) node.cargo[k] += craft.cargo[k];
    craft.cargo = emptyResources();
    this.railsDirty = true;
    this.railsUnsaved = true;
    return true;
  }

  clearRails(): void {
    this.rails = { nextId: this.rails.nextId, nodes: [], edges: [] };
    for (const c of this.carts) this.toGarage(c);
    for (const c of this.crafts.values()) c.railTail = null;
    this.railsDirty = true;
    this.railsUnsaved = true;
  }

  // ---- carts ----

  addCarts(crewId: number, count: number, x: number, y: number): void {
    for (let i = 0; i < count; i++) {
      this.carts.push({
        id: this.host.nextEntityId(),
        crewId,
        x,
        y,
        angle: 0,
        state: 'garage',
        at: null,
        path: [],
        pathIdx: 0,
        cargo: emptyResources(),
        claim: null,
      });
    }
  }

  /** Remove a crew's carts (when it leaves); returns any ore they were carrying. */
  removeCarts(crewId: number): Resources {
    const res = emptyResources();
    for (const c of this.carts) {
      if (c.crewId !== crewId) continue;
      for (const k of RESOURCE_KINDS) res[k] += c.cargo[k];
    }
    this.carts = this.carts.filter((c) => c.crewId !== crewId);
    return res;
  }

  private toGarage(c: Cart): void {
    c.state = 'garage';
    c.at = null;
    c.path = [];
    c.claim = null;
  }

  private stepCarts(dt: number): void {
    const parked = this.host.parkedMotherships(this.row.id);
    const claimed = new Set(this.carts.map((c) => c.claim).filter((v): v is number => v != null));
    for (const cart of this.carts) {
      const home = parked.find((p) => p.crewId === cart.crewId);
      if (!home) continue;
      const depot = (n: RailNode) => isDepot(n, home.x, home.y);

      if (cart.state === 'garage') {
        cart.x = home.x;
        cart.y = home.y;
        let best: { id: number; d: number } | null = null;
        for (const n of this.rails.nodes) {
          if (!depot(n)) continue;
          const d = Math.hypot(n.x - home.x, n.y - home.y);
          if (!best || d < best.d) best = { id: n.id, d };
        }
        if (best) {
          const n = getNode(this.rails, best.id)!;
          cart.x = n.x;
          cart.y = n.y;
          cart.at = n.id;
          cart.state = 'idle';
        }
        continue;
      }

      if (cart.state === 'idle') {
        if (cart.at == null || !getNode(this.rails, cart.at)) {
          this.toGarage(cart);
          continue;
        }
        const pickup = findPath(this.rails, cart.at, (n) => nodeHasCargo(n) && !claimed.has(n.id));
        if (pickup) {
          cart.claim = pickup[pickup.length - 1];
          claimed.add(cart.claim);
          cart.path = pickup;
          cart.pathIdx = 0;
          cart.state = 'toPickup';
        } else if (!depot(getNode(this.rails, cart.at)!)) {
          const back = findPath(this.rails, cart.at, depot);
          if (back) {
            cart.path = back;
            cart.pathIdx = 0;
            cart.state = 'toDepot';
          }
        }
        continue;
      }

      // Moving along a path.
      let budget = RAIL.cartSpeed * dt;
      let broken = false;
      while (budget > 0 && cart.pathIdx < cart.path.length) {
        const target = getNode(this.rails, cart.path[cart.pathIdx]);
        if (!target) {
          this.toGarage(cart);
          broken = true;
          break;
        }
        const dx = target.x - cart.x;
        const dy = target.y - cart.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) cart.angle = Math.atan2(dy, dx);
        if (d <= budget) {
          cart.x = target.x;
          cart.y = target.y;
          budget -= d;
          cart.at = target.id;
          cart.pathIdx++;
        } else {
          cart.x += (dx / d) * budget;
          cart.y += (dy / d) * budget;
          budget = 0;
        }
      }
      if (broken || cart.pathIdx < cart.path.length) continue;

      if (cart.state === 'toPickup') {
        const node = cart.at != null ? getNode(this.rails, cart.at) : undefined;
        if (node) {
          for (const k of RESOURCE_KINDS) {
            cart.cargo[k] += node.cargo[k];
            node.cargo[k] = 0;
          }
          this.railsDirty = true;
          this.railsUnsaved = true;
        }
        cart.claim = null;
        const back = cart.at != null ? findPath(this.rails, cart.at, depot) : null;
        if (back) {
          cart.path = back;
          cart.pathIdx = 0;
          cart.state = 'toDepot';
        } else cart.state = 'idle';
      } else if (cart.state === 'toDepot') {
        if (totalResources(cart.cargo) > 0) {
          this.host.deposit(cart.crewId, cart.cargo);
          cart.cargo = emptyResources();
        }
        cart.state = 'idle';
      }
    }
  }

  // ---- wildlife ----

  spawnCritters(count: number): void {
    for (let i = 0; i < count; i++) {
      const pos = this.findOpenSpot();
      if (!pos) return;
      const a = this.rand() * Math.PI * 2;
      this.critters.push({ id: this.host.nextEntityId(), x: pos.x, y: pos.y, vx: Math.cos(a) * 80, vy: Math.sin(a) * 80, wander: a });
    }
  }

  /** Empty spot near (or inside the tunnels of) an asteroid. */
  private findOpenSpot(): { x: number; y: number } | null {
    for (let tries = 0; tries < 40; tries++) {
      const ast = this.asteroidRows[Math.floor(this.rand() * this.asteroidRows.length)];
      if (!ast) return null;
      const a = this.rand() * Math.PI * 2;
      const d = ast.radius * (0.3 + this.rand() * 0.9);
      const x = ast.x + Math.cos(a) * d;
      const y = ast.y + Math.sin(a) * d;
      if (!isSolidAt(this.asteroids, x, y)) return { x, y };
    }
    return null;
  }

  private stepCritters(dt: number): void {
    const crafts = [...this.crafts.values()];
    for (const c of this.critters) {
      c.wander += (this.rand() - 0.5) * 2.5 * dt;
      let ax = Math.cos(c.wander) * 60;
      let ay = Math.sin(c.wander) * 60;

      // Loose schooling with nearby critters.
      let n = 0;
      let mx = 0;
      let my = 0;
      for (const o of this.critters) {
        if (o === c) continue;
        const d2 = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
        if (d2 < 160 * 160) {
          mx += o.vx;
          my += o.vy;
          n++;
          if (d2 < 30 * 30) {
            ax -= (o.x - c.x) * 2;
            ay -= (o.y - c.y) * 2;
          }
        }
      }
      if (n > 0) {
        ax += (mx / n - c.vx) * 0.8;
        ay += (my / n - c.vy) * 0.8;
      }

      // Scatter from ships.
      let scared = false;
      for (const cr of crafts) {
        const dx = c.x - cr.ship.x;
        const dy = c.y - cr.ship.y;
        const d = Math.hypot(dx, dy);
        if (d < 220 && d > 1) {
          ax += (dx / d) * 500;
          ay += (dy / d) * 500;
          scared = true;
        }
      }

      c.vx += ax * dt;
      c.vy += ay * dt;
      const sp = Math.hypot(c.vx, c.vy);
      const max = scared ? 260 : 120;
      if (sp > max) {
        c.vx *= max / sp;
        c.vy *= max / sp;
      } else if (sp < 40) {
        c.vx *= 40 / Math.max(sp, 1);
        c.vy *= 40 / Math.max(sp, 1);
      }

      // Feel ahead for rock and turn away rather than hit it.
      const lookX = c.x + (c.vx / Math.max(sp, 1)) * 36;
      const lookY = c.y + (c.vy / Math.max(sp, 1)) * 36;
      if (isSolidAt(this.asteroids, lookX, lookY)) {
        const turn = this.rand() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
        const ang = Math.atan2(c.vy, c.vx) + turn;
        c.vx = Math.cos(ang) * sp * 0.6;
        c.vy = Math.sin(ang) * sp * 0.6;
        c.wander = ang;
      }
      const nx = c.x + c.vx * dt;
      const ny = c.y + c.vy * dt;
      if (isSolidAt(this.asteroids, nx, ny)) {
        c.vx = -c.vx;
        c.vy = -c.vy;
      } else {
        c.x = nx;
        c.y = ny;
      }
    }
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.respawnTimer = 5;
      const missing = this.row.def.critters - this.critters.length;
      if (missing > 0) this.spawnCritters(Math.min(missing, 3));
    }
  }

  step(): void {
    this.stepCarts(DT);
    this.stepCritters(DT);
  }
}
