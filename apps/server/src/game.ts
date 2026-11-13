import type { WebSocket } from 'ws';
import {
  CART_COST,
  CRAFT_KINDS,
  DOCK_RADIUS,
  DT,
  FLAG_BOOSTING,
  FLAG_DRILLING,
  FLAG_LOADED,
  GALAXY,
  MATERIALS,
  NO_INPUT,
  RESOURCE_KINDS,
  SHIP_SPECS,
  SNAPSHOT_EVERY,
  TICK_HZ,
  autopilotEta,
  copyShip,
  emptyResources,
  makeShip,
  stepShip,
  totalResources,
  type ClientMsg,
  type CraftKind,
  type CrewWire,
  type EntWire,
  type InputState,
  type PaintOp,
  type Resources,
  type ServerMsg,
  type ShipState,
  type SpaceInfo,
} from '@poprock/shared';
import type { CrewData, Store } from './db';
import { SystemSpace, type Craft, type SystemHost } from './system';

export interface Player {
  id: number;
  name: string;
  ws: WebSocket;
  crewId: number;
  craft: Craft | null;
  inputs: { seq: number; i: InputState }[];
  lastInput: InputState;
  ack: number;
  /** identifies the space last sent to this client */
  spaceKey: string | null;
}

export interface Crew {
  id: number;
  name: string;
  resources: Resources;
  carts: number;
  mothership: ShipState;
  /** parked system, or null in hyperspace */
  systemId: number | null;
  pilotId: number | null;
  members: Set<number>;
}

const MAX_QUEUED_INPUTS = 4;

export class Game implements SystemHost {
  tick = 0;
  readonly startedAt = Date.now();
  players = new Map<number, Player>();
  crews = new Map<number, Crew>();
  systems = new Map<number, SystemSpace>();
  galaxyVersion = 0;
  private entityId = 1;
  private playerId = 1;
  private crewDirty = true;

  constructor(readonly store: Store) {
    for (const row of store.listSystems()) {
      const sys = new SystemSpace(row, store, this);
      sys.spawnCritters(row.def.critters);
      this.systems.set(row.id, sys);
    }
    let crews = store.listCrews();
    if (crews.length === 0) {
      const home = [...this.systems.values()][0];
      store.insertCrew('Home Crew', {
        resources: emptyResources(),
        carts: 1,
        systemId: home.row.id,
        gx: home.row.gx,
        gy: home.row.gy,
        angle: 0,
      });
      crews = store.listCrews();
    }
    for (const c of crews) this.addCrew(c.id, c.name, c.data);
  }

  private addCrew(id: number, name: string, data: CrewData): void {
    const sys = data.systemId != null ? this.systems.get(data.systemId) : undefined;
    const ship = makeShip(this.nextEntityId(), 'mothership', data.gx, data.gy, data.angle);
    const crew: Crew = {
      id,
      name,
      resources: { ...emptyResources(), ...data.resources },
      carts: data.carts,
      mothership: ship,
      systemId: sys ? sys.row.id : null,
      pilotId: null,
      members: new Set(),
    };
    if (sys) this.park(crew, sys);
    this.crews.set(id, crew);
  }

  // ---- SystemHost ----

  nextEntityId(): number {
    return this.entityId++;
  }

  parkedMotherships(systemId: number): { crewId: number; x: number; y: number }[] {
    const out = [];
    for (const c of this.crews.values()) if (c.systemId === systemId) out.push({ crewId: c.id, x: c.mothership.x, y: c.mothership.y });
    return out;
  }

  deposit(crewId: number, res: Resources): void {
    const crew = this.crews.get(crewId);
    if (!crew) return;
    for (const k of RESOURCE_KINDS) crew.resources[k] += res[k];
    this.crewDirty = true;
  }

  // ---- connections ----

  connect(ws: WebSocket, name: string): Player {
    // One shared crew for now; the model already supports more.
    const crew = [...this.crews.values()][0];
    const p: Player = {
      id: this.playerId++,
      name: name.slice(0, 24) || 'Pilot',
      ws,
      crewId: crew.id,
      craft: null,
      inputs: [],
      lastInput: NO_INPUT,
      ack: 0,
      spaceKey: null,
    };
    crew.members.add(p.id);
    this.players.set(p.id, p);
    this.send(p, { t: 'welcome', playerId: p.id, tickHz: TICK_HZ });
    this.toastCrew(crew, `${p.name} came aboard.`);
    this.crewDirty = true;
    return p;
  }

  disconnect(p: Player): void {
    const crew = this.crews.get(p.crewId);
    if (p.craft) this.dock(p, true);
    if (crew) {
      crew.members.delete(p.id);
      if (crew.pilotId === p.id) crew.pilotId = null;
      this.toastCrew(crew, `${p.name} left.`);
    }
    this.players.delete(p.id);
    this.crewDirty = true;
  }

  handle(p: Player, msg: ClientMsg): void {
    const crew = this.crews.get(p.crewId)!;
    switch (msg.t) {
      case 'input':
        p.inputs.push({ seq: msg.seq, i: sanitizeInput(msg.i) });
        if (p.inputs.length > MAX_QUEUED_INPUTS * 4) p.inputs.splice(0, p.inputs.length - MAX_QUEUED_INPUTS);
        break;
      case 'launch':
        this.launch(p, crew, msg.craft);
        break;
      case 'dock':
        this.dock(p, false);
        break;
      case 'helm':
        if (msg.take && crew.pilotId == null) crew.pilotId = p.id;
        else if (!msg.take && crew.pilotId === p.id) crew.pilotId = null;
        else if (msg.take) this.send(p, { t: 'toast', text: 'Someone else has the helm.' });
        this.crewDirty = true;
        break;
      case 'autopilot':
        this.setAutopilot(p, crew, msg.systemId);
        break;
      case 'jump':
        if (crew.pilotId !== p.id) this.send(p, { t: 'toast', text: 'Take the helm (H) to jump.' });
        else this.jump(crew);
        break;
      case 'dropCargo': {
        const sys = p.craft && crew.systemId != null ? this.systems.get(crew.systemId) : undefined;
        if (!p.craft || !sys) break;
        if (sys.dropCargo(p.craft)) this.send(p, { t: 'toast', text: 'Cargo dropped on the rail. A cart will collect it.' });
        else this.send(p, { t: 'toast', text: 'Nothing to drop, or no rail node nearby.' });
        break;
      }
      case 'buildCart':
        if (crew.resources.ferrite < CART_COST.ferrite) {
          this.send(p, { t: 'toast', text: `A cart costs ${CART_COST.ferrite} ferrite.` });
          break;
        }
        crew.resources.ferrite -= CART_COST.ferrite;
        crew.carts++;
        if (crew.systemId != null) {
          this.systems.get(crew.systemId)?.addCarts(crew.id, 1, crew.mothership.x, crew.mothership.y);
        }
        this.toastCrew(crew, `${p.name} built a rail cart.`);
        this.crewDirty = true;
        break;
      case 'hello':
        break;
    }
  }

  private launch(p: Player, crew: Crew, kind: CraftKind): void {
    if (p.craft) return;
    if (!CRAFT_KINDS.includes(kind)) return;
    if (crew.systemId == null) {
      this.send(p, { t: 'toast', text: 'Craft can only launch inside a star system.' });
      return;
    }
    const sys = this.systems.get(crew.systemId)!;
    const m = crew.mothership;
    const a = Math.random() * Math.PI * 2;
    const ship = makeShip(this.nextEntityId(), kind, m.x + Math.cos(a) * 90, m.y + Math.sin(a) * 90, a);
    ship.vx = Math.cos(a) * 180;
    ship.vy = Math.sin(a) * 180;
    const craft: Craft = { ship, kind, ownerId: p.id, crewId: crew.id, cargo: emptyResources(), railTail: null };
    sys.crafts.set(ship.id, craft);
    p.craft = craft;
    p.inputs = [];
    this.crewDirty = true;
  }

  /** Return a player's craft to the mothership, depositing cargo. `force` skips the range check. */
  private dock(p: Player, force: boolean): void {
    const crew = this.crews.get(p.crewId)!;
    const craft = p.craft;
    if (!craft) return;
    const m = crew.mothership;
    if (!force && Math.hypot(craft.ship.x - m.x, craft.ship.y - m.y) > DOCK_RADIUS) {
      this.send(p, { t: 'toast', text: 'Too far from the mothership to dock.' });
      return;
    }
    const n = totalResources(craft.cargo);
    if (n > 0) {
      this.deposit(crew.id, craft.cargo);
      if (!force) this.toastCrew(crew, `${p.name} delivered ${n} ore.`);
    }
    for (const sys of this.systems.values()) sys.crafts.delete(craft.ship.id);
    p.craft = null;
    p.inputs = [];
    this.crewDirty = true;
  }

  private setAutopilot(p: Player, crew: Crew, systemId: number | null): void {
    if (crew.pilotId !== p.id) {
      this.send(p, { t: 'toast', text: 'Take the helm (H) to set a course.' });
      return;
    }
    if (crew.systemId != null) {
      this.send(p, { t: 'toast', text: 'Jump to hyperspace (J) first.' });
      return;
    }
    const target = systemId != null ? this.systems.get(systemId) : undefined;
    crew.mothership.ap = target ? { x: target.row.gx, y: target.row.gy, systemId: target.row.id } : null;
    this.crewDirty = true;
  }

  private park(crew: Crew, sys: SystemSpace): void {
    const m = crew.mothership;
    m.x = sys.row.def.park.x;
    m.y = sys.row.def.park.y;
    m.vx = 0;
    m.vy = 0;
    m.ap = null;
    crew.systemId = sys.row.id;
    sys.addCarts(crew.id, crew.carts, m.x, m.y);
  }

  private enterSystem(crew: Crew, sys: SystemSpace): void {
    this.park(crew, sys);
    this.toastCrew(crew, `Arrived at ${sys.row.name}. Mothership parked.`);
    this.crewDirty = true;
  }

  private jump(crew: Crew): void {
    if (crew.systemId == null) return;
    const sys = this.systems.get(crew.systemId)!;
    for (const id of crew.members) {
      const p = this.players.get(id);
      if (p?.craft) {
        this.dock(p, true);
        this.send(p, { t: 'toast', text: 'Recalled to the mothership for the jump.' });
      }
    }
    this.deposit(crew.id, sys.removeCarts(crew.id));
    const m = crew.mothership;
    const a = m.angle;
    m.x = sys.row.gx + Math.cos(a) * GALAXY.exitDistance;
    m.y = sys.row.gy + Math.sin(a) * GALAXY.exitDistance;
    m.vx = Math.cos(a) * 200;
    m.vy = Math.sin(a) * 200;
    m.ap = null;
    crew.systemId = null;
    this.toastCrew(crew, `Jumped out of ${sys.row.name} into hyperspace.`);
    this.crewDirty = true;
  }

  // ---- simulation ----

  step(): void {
    this.tick++;
    const galaxy = { dt: DT, asteroids: [], bodies: [] };

    for (const p of this.players.values()) {
      const next = p.inputs.shift();
      if (next) {
        p.lastInput = next.i;
        p.ack = next.seq;
      }
      while (p.inputs.length > MAX_QUEUED_INPUTS) {
        // Client is ahead of us; drop to keep latency bounded.
        const skip = p.inputs.shift()!;
        p.ack = skip.seq;
        p.lastInput = skip.i;
      }
    }

    // Crafts inside systems.
    for (const sys of this.systems.values()) {
      const env = {
        dt: DT,
        asteroids: sys.asteroids,
        bodies: sys.bodies,
        onPaint: (op: PaintOp) => sys.paintQueue.push(op),
      };
      for (const craft of sys.crafts.values()) {
        const owner = this.players.get(craft.ownerId);
        const input = owner ? owner.lastInput : NO_INPUT;
        const hold = SHIP_SPECS[craft.kind].hold;
        stepShip(craft.ship, input, {
          ...env,
          onMined: (counts) => {
            for (let m = 1; m < counts.length; m++) {
              const kind = MATERIALS[m].yields;
              if (!kind || counts[m] === 0) continue;
              const room = hold - totalResources(craft.cargo);
              craft.cargo[kind] += Math.max(0, Math.min(room, counts[m]));
            }
          },
        });
        if (craft.kind === 'layer') sys.layRail(craft, input.action);
      }
      sys.step();
    }

    // Motherships in hyperspace.
    for (const crew of this.crews.values()) {
      if (crew.systemId != null) continue;
      const pilot = crew.pilotId != null ? this.players.get(crew.pilotId) : undefined;
      const hadAp = crew.mothership.ap != null;
      stepShip(crew.mothership, pilot ? pilot.lastInput : NO_INPUT, galaxy);
      if (hadAp !== (crew.mothership.ap != null)) this.crewDirty = true;
      for (const sys of this.systems.values()) {
        if (Math.hypot(crew.mothership.x - sys.row.gx, crew.mothership.y - sys.row.gy) < GALAXY.enterRadius) {
          this.enterSystem(crew, sys);
          break;
        }
      }
    }

    this.broadcastState();
  }

  // ---- networking ----

  private spaceKeyFor(crew: Crew): string {
    if (crew.systemId == null) return `galaxy:${this.galaxyVersion}`;
    const sys = this.systems.get(crew.systemId)!;
    return `sys:${sys.row.id}:${sys.version}`;
  }

  galaxyInfo(): SpaceInfo {
    return { kind: 'galaxy', systems: [...this.systems.values()].map((s) => s.wire()) };
  }

  private broadcastState(): void {
    // Terrain edits go out every tick so drilling looks immediate for everyone.
    for (const sys of this.systems.values()) {
      if (sys.paintQueue.length === 0) continue;
      const msg: ServerMsg = { t: 'paint', ops: sys.paintQueue };
      for (const p of this.playersInSystem(sys.row.id)) if (p.spaceKey?.startsWith(`sys:${sys.row.id}:`)) this.send(p, msg);
      sys.paintQueue = [];
    }

    for (const p of this.players.values()) {
      const crew = this.crews.get(p.crewId)!;
      const key = this.spaceKeyFor(crew);
      if (p.spaceKey !== key) {
        p.spaceKey = key;
        const sys = crew.systemId != null ? this.systems.get(crew.systemId)! : null;
        this.send(p, { t: 'space', space: sys ? sys.spaceInfo() : this.galaxyInfo() });
        if (sys) this.send(p, { t: 'rails', net: sys.rails });
        p.inputs = [];
      }
    }

    if (this.tick % SNAPSHOT_EVERY === 0) {
      for (const sys of this.systems.values()) {
        if (!sys.railsDirty) continue;
        sys.railsDirty = false;
        for (const p of this.playersInSystem(sys.row.id)) this.send(p, { t: 'rails', net: sys.rails });
      }
      const galaxyEnts = this.galaxyEntities();
      const systemEnts = new Map<number, EntWire[]>();
      for (const p of this.players.values()) {
        const crew = this.crews.get(p.crewId)!;
        let ents: EntWire[];
        if (crew.systemId == null) ents = galaxyEnts;
        else {
          let e = systemEnts.get(crew.systemId);
          if (!e) systemEnts.set(crew.systemId, (e = this.systemEntities(crew.systemId)));
          ents = e;
        }
        const own = this.controlledShip(p, crew);
        this.send(p, {
          t: 'snap',
          tick: this.tick,
          ents,
          you: {
            ship: own ? copyShip(own) : null,
            ack: p.ack,
            cargo: p.craft && SHIP_SPECS[p.craft.kind].hold > 0 ? p.craft.cargo : null,
            eta: crew.systemId == null ? autopilotEta(crew.mothership) : null,
          },
        });
      }
    }

    if (this.crewDirty || this.tick % TICK_HZ === 0) {
      this.crewDirty = false;
      for (const crew of this.crews.values()) {
        const wire = this.crewWire(crew);
        for (const id of crew.members) {
          const p = this.players.get(id);
          if (p) this.send(p, { t: 'crew', crew: wire });
        }
      }
    }
  }

  /** The ship this player predicts locally: their craft, or the mothership if piloting in hyperspace. */
  private controlledShip(p: Player, crew: Crew): ShipState | null {
    if (p.craft) return p.craft.ship;
    if (crew.pilotId === p.id && crew.systemId == null) return crew.mothership;
    return null;
  }

  private playersInSystem(systemId: number): Player[] {
    const out: Player[] = [];
    for (const p of this.players.values()) if (this.crews.get(p.crewId)?.systemId === systemId) out.push(p);
    return out;
  }

  private galaxyEntities(): EntWire[] {
    const out: EntWire[] = [];
    for (const crew of this.crews.values()) {
      if (crew.systemId != null) continue;
      out.push(shipWire(crew.mothership, crew.name));
    }
    return out;
  }

  private systemEntities(systemId: number): EntWire[] {
    const sys = this.systems.get(systemId)!;
    const out: EntWire[] = [];
    for (const crew of this.crews.values()) {
      if (crew.systemId === systemId) out.push({ ...shipWire(crew.mothership, crew.name), f: 0 });
    }
    for (const c of sys.crafts.values()) {
      const owner = this.players.get(c.ownerId);
      const w = shipWire(c.ship, owner?.name);
      if (totalResources(c.cargo) > 0) w.f |= FLAG_LOADED;
      out.push(w);
    }
    for (const c of sys.carts) {
      if (c.state === 'garage') continue;
      out.push({ id: c.id, k: 'cart', x: r1(c.x), y: r1(c.y), vx: 0, vy: 0, a: r2(c.angle), f: totalResources(c.cargo) > 0 ? FLAG_LOADED : 0 });
    }
    for (const c of sys.critters) {
      out.push({ id: c.id, k: 'critter', x: r1(c.x), y: r1(c.y), vx: r1(c.vx), vy: r1(c.vy), a: r2(Math.atan2(c.vy, c.vx)), f: 0 });
    }
    return out;
  }

  crewWire(crew: Crew): CrewWire {
    const sys = crew.systemId != null ? this.systems.get(crew.systemId) : undefined;
    return {
      id: crew.id,
      name: crew.name,
      resources: crew.resources,
      carts: crew.carts,
      pilotId: crew.pilotId,
      members: [...crew.members].map((id) => {
        const p = this.players.get(id)!;
        return { id, name: p.name, craft: p.craft?.kind ?? null };
      }),
      location: sys ? sys.row.name : 'Hyperspace',
      inSystem: !!sys,
      autopilotTarget: crew.mothership.ap?.systemId ?? null,
    };
  }

  send(p: Player, msg: ServerMsg): void {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
  }

  toastCrew(crew: Crew, text: string): void {
    for (const id of crew.members) {
      const p = this.players.get(id);
      if (p) this.send(p, { t: 'toast', text });
    }
  }

  toastAll(text: string, systemId?: number): void {
    for (const p of this.players.values()) {
      if (systemId != null && this.crews.get(p.crewId)?.systemId !== systemId) continue;
      this.send(p, { t: 'toast', text });
    }
  }

  // ---- persistence ----

  save(): void {
    for (const sys of this.systems.values()) {
      for (const a of sys.asteroids) {
        if (!a.dirty) continue;
        this.store.saveCells(a.id, a.cols, a.rows, a.cells);
        a.dirty = false;
      }
      if (sys.railsUnsaved) {
        this.store.saveRails(sys.row.id, sys.rails);
        sys.railsUnsaved = false;
      }
    }
    for (const crew of this.crews.values()) {
      const m = crew.mothership;
      const sys = crew.systemId != null ? this.systems.get(crew.systemId) : undefined;
      // Parked crews persist at their system's galaxy position so they reload parked.
      this.store.saveCrew(crew.id, crew.name, {
        resources: crew.resources,
        carts: crew.carts,
        systemId: crew.systemId,
        gx: sys ? sys.row.gx : m.x,
        gy: sys ? sys.row.gy : m.y,
        angle: m.angle,
      });
    }
  }

  // ---- admin hooks ----

  /** Re-read a system from the database (after an admin edit) and push it to clients. */
  reloadSystem(id: number): void {
    const row = this.store.getSystem(id);
    const existing = this.systems.get(id);
    if (!row) {
      if (existing && ![...this.crews.values()].some((c) => c.systemId === id)) this.systems.delete(id);
    } else if (existing) {
      existing.reload(row);
    } else {
      const sys = new SystemSpace(row, this.store, this);
      sys.spawnCritters(row.def.critters);
      this.systems.set(id, sys);
    }
    this.galaxyVersion++;
  }
}

function shipWire(s: ShipState, name?: string): EntWire {
  let f = 0;
  if (s.drilling) f |= FLAG_DRILLING;
  if (s.boosting) f |= FLAG_BOOSTING;
  const w: EntWire = { id: s.id, k: s.kind, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy), a: r2(s.angle), f };
  if (name) w.n = name;
  return w;
}

function sanitizeInput(i: InputState): InputState {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  return { sx: num(i?.sx), sy: num(i?.sy), boost: !!i?.boost, action: !!i?.action };
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
