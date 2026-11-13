import {
  DT,
  angleDiff,
  applyPaint,
  copyShip,
  createAsteroid,
  decodeCells,
  emptyRailNet,
  stepShip,
  type Asteroid,
  type CrewWire,
  type EntWire,
  type GravityBody,
  type InputState,
  type RailNet,
  type ServerMsg,
  type ShipState,
  type SpaceInfo,
  type SystemWire,
  type YouWire,
} from '@poprock/shared';

export interface DisplayEnt {
  w: EntWire;
  x: number;
  y: number;
  a: number;
  /** performance.now() of the snapshot that last updated `w` */
  seenAt: number;
}

/** Everything the client knows about the space it's in, plus own-ship prediction. */
export class World {
  playerId = 0;
  space: SpaceInfo | null = null;
  /** bumped whenever `space` is replaced, so the renderer can rebuild */
  spaceVersion = 0;
  asteroids: Asteroid[] = [];
  bodies: GravityBody[] = [];
  systems: SystemWire[] = [];
  rails: RailNet = emptyRailNet();
  railsVersion = 0;
  ents = new Map<number, DisplayEnt>();
  crew: CrewWire | null = null;
  you: YouWire | null = null;

  predicted: ShipState | null = null;
  private pending: { seq: number; i: InputState }[] = [];
  private seq = 0;
  /** visual offset that decays after a server correction */
  private corr = { x: 0, y: 0 };

  onToast: (text: string) => void = () => {};
  onPaint: (x: number, y: number, r: number, m: number) => void = () => {};

  handle(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.playerId = m.playerId;
        break;
      case 'space':
        this.setSpace(m.space);
        break;
      case 'paint':
        for (const op of m.ops) {
          if (applyPaint(this.asteroids, op) > 0) this.onPaint(op.x, op.y, op.r, op.m);
        }
        break;
      case 'rails':
        this.rails = m.net;
        this.railsVersion++;
        break;
      case 'crew':
        this.crew = m.crew;
        break;
      case 'toast':
        this.onToast(m.text);
        break;
      case 'snap':
        this.applySnap(m.ents, m.you);
        break;
    }
  }

  private setSpace(space: SpaceInfo): void {
    this.space = space;
    this.spaceVersion++;
    this.ents.clear();
    this.predicted = null;
    this.pending = [];
    if (space.kind === 'galaxy') {
      this.systems = space.systems;
      this.asteroids = [];
      this.bodies = [];
      this.rails = emptyRailNet();
    } else {
      this.asteroids = space.asteroids.map((a) => {
        const ast = createAsteroid(a.id, a.x, a.y, a.cols, a.rows, decodeCells(a.data, a.cols * a.rows));
        return ast;
      });
      this.bodies = space.bodies;
    }
    this.railsVersion++;
  }

  private applySnap(ents: EntWire[], you: YouWire): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const w of ents) {
      seen.add(w.id);
      const d = this.ents.get(w.id);
      if (d) {
        d.w = w;
        d.seenAt = now;
      } else this.ents.set(w.id, { w, x: w.x, y: w.y, a: w.a, seenAt: now });
    }
    for (const id of this.ents.keys()) if (!seen.has(id)) this.ents.delete(id);
    this.you = you;
    this.reconcile(you);
  }

  /** Rewind own ship to the server's state and replay inputs the server hasn't processed yet. */
  private reconcile(you: YouWire): void {
    if (!you.ship) {
      this.predicted = null;
      this.pending = [];
      return;
    }
    const prev = this.predicted;
    const fresh = !prev || prev.id !== you.ship.id;
    this.pending = this.pending.filter((p) => p.seq > you.ack);
    const s = copyShip(you.ship);
    if (!fresh) for (const p of this.pending) stepShip(s, p.i, this.env());
    if (prev && !fresh) {
      const ex = prev.x - s.x;
      const ey = prev.y - s.y;
      if (Math.hypot(ex, ey) < 250) {
        this.corr.x += ex;
        this.corr.y += ey;
      } else this.corr.x = this.corr.y = 0;
    } else this.corr.x = this.corr.y = 0;
    this.predicted = s;
  }

  private env() {
    return { dt: DT, asteroids: this.asteroids, bodies: this.bodies };
  }

  /** One fixed client tick: predict own ship and return the message to send. */
  tick(input: InputState): { seq: number; i: InputState } {
    const msg = { seq: ++this.seq, i: input };
    if (this.predicted) {
      stepShip(this.predicted, input, {
        ...this.env(),
        onPaint: (op) => this.onPaint(op.x, op.y, op.r, op.m),
      });
      this.pending.push(msg);
      if (this.pending.length > 120) this.pending.shift();
    }
    return msg;
  }

  /** Advance display positions. Other entities extrapolate from the last snapshot and ease toward it. */
  frame(dt: number): void {
    const now = performance.now();
    const k = 1 - Math.exp(-dt * 14);
    for (const d of this.ents.values()) {
      const age = Math.min(0.25, (now - d.seenAt) / 1000);
      const tx = d.w.x + d.w.vx * age;
      const ty = d.w.y + d.w.vy * age;
      if (Math.hypot(tx - d.x, ty - d.y) > 600) {
        d.x = tx;
        d.y = ty;
        d.a = d.w.a;
      } else {
        d.x += (tx - d.x) * k;
        d.y += (ty - d.y) * k;
        d.a += angleDiff(d.a, d.w.a) * k;
      }
    }
    const decay = Math.exp(-dt * 10);
    this.corr.x *= decay;
    this.corr.y *= decay;
    const own = this.predicted;
    if (own) {
      const d = this.ents.get(own.id);
      if (d) {
        d.x = own.x + this.corr.x;
        d.y = own.y + this.corr.y;
        d.a = own.angle;
        d.w = { ...d.w, f: (own.drilling ? 1 : 0) | (own.boosting ? 2 : 0) | (d.w.f & 4) };
      }
    }
  }

  /** The entity the camera should follow. */
  focus(): DisplayEnt | null {
    if (this.predicted) return this.ents.get(this.predicted.id) ?? null;
    return this.myMothership();
  }

  myMothership(): DisplayEnt | null {
    const name = this.crew?.name;
    for (const d of this.ents.values()) if (d.w.k === 'mothership' && d.w.n === name) return d;
    return null;
  }
}

