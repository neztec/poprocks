import type { WebSocket } from 'ws';
import {
  CART_COST,
  CRAFT_KINDS,
  DEFAULT_FLEET,
  DOCK_RADIUS,
  FLAG_IDLE,
  FORMATION,
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
  formationSlot,
  makeShip,
  stepShip,
  totalResources,
  turnToward,
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
  /** online players */
  members: Set<number>;
  /** everyone who has ever come aboard, by name */
  roster: string[];
  fleet: Craft[];
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
    const kinds = (data.fleet ?? DEFAULT_FLEET).filter((k) => CRAFT_KINDS.includes(k));
    const crew: Crew = {
      id,
      name,
      resources: { ...emptyResources(), ...data.resources },
      carts: data.carts,
      mothership: ship,
      systemId: sys ? sys.row.id : null,
      pilotId: null,
      members: new Set(),
      roster: [...(data.roster ?? [])],
      fleet: kinds.map((kind, slot) => ({
        ship: makeShip(this.nextEntityId(), kind, 0, 0),
        kind,
        crewId: id,
        slot,
        pilotId: null,
        cargo: emptyResources(),
        railTail: null,
        armed: false,
      })),
    };
    if (sys) this.park(crew, sys, data.lx != null && data.ly != null ? { x: data.lx, y: data.ly } : undefined);
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
    if (!crew.roster.includes(p.name)) crew.roster.push(p.name);
    this.players.set(p.id, p);
    this.send(p, { t: 'welcome', playerId: p.id, tickHz: TICK_HZ });
    this.toastCrew(crew, `${p.name} came aboard.`);
    this.crewDirty = true;
    return p;
  }

  disconnect(p: Player): void {
    const crew = this.crews.get(p.crewId);
    if (p.craft) this.dock(p, true); // the empty craft flies itself back into formation
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
      case 'launch': {
        if (p.craft) break;
        const free = crew.fleet.find((c) => c.kind === msg.craft && c.pilotId == null);
        if (free) this.board(p, crew, free);
        else this.send(p, { t: 'toast', text: `No free ${SHIP_SPECS[msg.craft]?.label ?? 'craft'} in the formation.` });
        break;
      }
      case 'board': {
        const craft = crew.fleet.find((c) => c.ship.id === msg.craftId);
        if (craft) this.board(p, crew, craft);
        break;
      }
      case 'dock':
        this.dock(p, false);
        break;
      case 'seat':
        if (msg.seat === 'helm') this.takeHelm(p, crew);
        else {
          if (p.craft) this.dock(p, false);
          else if (crew.pilotId === p.id) crew.pilotId = null;
          this.crewDirty = true;
        }
        break;
      case 'helm':
        if (msg.take) this.takeHelm(p, crew);
        else if (crew.pilotId === p.id) crew.pilotId = null;
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

  private takeHelm(p: Player, crew: Crew): void {
    if (crew.pilotId != null && crew.pilotId !== p.id) {
      this.send(p, { t: 'toast', text: 'Someone else has the helm.' });
      return;
    }
    if (p.craft) {
      this.dock(p, false);
      if (p.craft) return; // too far out to dock
    }
    crew.pilotId = p.id;
    this.crewDirty = true;
  }

  /** Put a player in the cockpit of one of the crew's formation craft. */
  private board(p: Player, crew: Crew, craft: Craft): void {
    if (p.craft) {
      this.send(p, { t: 'toast', text: 'Dock your current craft first.' });
      return;
    }
    if (crew.systemId == null) {
      this.send(p, { t: 'toast', text: 'Craft can only launch inside a star system.' });
      return;
    }
    if (craft.pilotId != null) {
      const other = this.players.get(craft.pilotId);
      this.send(p, { t: 'toast', text: `${other?.name ?? 'Someone'} is flying that one.` });
      return;
    }
    if (crew.pilotId === p.id) crew.pilotId = null;
    craft.pilotId = p.id;
    craft.armed = false;
    craft.railTail = null;
    // Nudge it outward from the mothership so it clears the formation ring.
    const m = crew.mothership;
    const a = Math.atan2(craft.ship.y - m.y, craft.ship.x - m.x);
    craft.ship.vx = m.vx + Math.cos(a) * 140;
    craft.ship.vy = m.vy + Math.sin(a) * 140;
    p.craft = craft;
    p.inputs = [];
    this.crewDirty = true;
  }

  /** Hand a player's craft back to the formation, depositing cargo. `force` skips the range check. */
  private dock(p: Player, force: boolean): void {
    const crew = this.crews.get(p.crewId)!;
    const craft = p.craft;
    if (!craft) return;
    const m = crew.mothership;
    if (!force && Math.hypot(craft.ship.x - m.x, craft.ship.y - m.y) > DOCK_RADIUS && !this.nearSlot(crew, craft)) {
      this.send(p, { t: 'toast', text: 'Too far from the mothership to dock.' });
      return;
    }
    const n = totalResources(craft.cargo);
    if (n > 0) {
      this.deposit(crew.id, craft.cargo);
      craft.cargo = emptyResources();
      if (!force) this.toastCrew(crew, `${p.name} delivered ${n} ore.`);
    }
    craft.pilotId = null;
    craft.railTail = null;
    craft.ship.drilling = craft.ship.boosting = false;
    p.craft = null;
    p.inputs = [];
    this.crewDirty = true;
  }

  private slotOf(crew: Crew, craft: Craft): { x: number; y: number; angle: number } {
    return formationSlot(crew.mothership, craft.slot, crew.fleet.length);
  }

  private nearSlot(crew: Crew, craft: Craft): boolean {
    const t = this.slotOf(crew, craft);
    return Math.hypot(craft.ship.x - t.x, craft.ship.y - t.y) < FORMATION.dockRadius;
  }

  /** Unmanned craft fly to their slot and hold station there as the mothership moves. */
  private holdFormation(crew: Crew, craft: Craft, dt: number): void {
    const s = craft.ship;
    const t = this.slotOf(crew, craft);
    const m = crew.mothership;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy);
    // Match the mothership's velocity plus a spring toward the slot, capped.
    let vx = m.vx + dx * 3;
    let vy = m.vy + dy * 3;
    const sp = Math.hypot(vx, vy);
    if (sp > FORMATION.returnSpeed) {
      vx *= FORMATION.returnSpeed / sp;
      vy *= FORMATION.returnSpeed / sp;
    }
    s.vx = vx;
    s.vy = vy;
    s.x += vx * dt;
    s.y += vy * dt;
    const face = d > 60 ? Math.atan2(dy, dx) : t.angle;
    s.angle = turnToward(s.angle, face, SHIP_SPECS[craft.kind].turnRate * dt);
    s.drilling = s.boosting = false;
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

  private park(crew: Crew, sys: SystemSpace, at?: { x: number; y: number }): void {
    const m = crew.mothership;
    m.x = at?.x ?? sys.row.def.park.x;
    m.y = at?.y ?? sys.row.def.park.y;
    m.vx = 0;
    m.vy = 0;
    m.ap = null;
    crew.systemId = sys.row.id;
    sys.addCarts(crew.id, crew.carts, m.x, m.y);
    for (const c of crew.fleet) {
      const t = this.slotOf(crew, c);
      Object.assign(c.ship, { x: t.x, y: t.y, vx: 0, vy: 0, angle: t.angle, ap: null });
      c.pilotId = null;
      sys.crafts.set(c.ship.id, c);
    }
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
    for (const c of crew.fleet) sys.crafts.delete(c.ship.id);
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
    const galaxy = { dt: DT, asteroids: [], bodies: [], galaxy: true };

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

    // Motherships inside systems: the helm drives them slowly around the system.
    for (const crew of this.crews.values()) {
      const sys = crew.systemId != null ? this.systems.get(crew.systemId) : undefined;
      if (!sys) continue;
      const pilot = crew.pilotId != null ? this.players.get(crew.pilotId) : undefined;
      stepShip(crew.mothership, pilot && !pilot.craft ? pilot.lastInput : NO_INPUT, { dt: DT, asteroids: sys.asteroids, bodies: sys.bodies });
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
        const crew = this.crews.get(craft.crewId)!;
        const owner = craft.pilotId != null ? this.players.get(craft.pilotId) : undefined;
        if (!owner) {
          this.holdFormation(crew, craft, DT);
          continue;
        }
        const input = owner.lastInput;
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
        // Flying back into your formation slot re-docks: the craft parks and you return to quarters.
        const t = this.slotOf(crew, craft);
        const d = Math.hypot(craft.ship.x - t.x, craft.ship.y - t.y);
        if (d > FORMATION.armDistance) craft.armed = true;
        else if (craft.armed && d < FORMATION.dockRadius) {
          this.dock(owner, false);
          this.send(owner, { t: 'toast', text: `${SHIP_SPECS[craft.kind].label} back in formation. You're in crew quarters.` });
        }
      }
      sys.step();
    }

    // Motherships in hyperspace.
    for (const crew of this.crews.values()) {
      if (crew.systemId != null) continue;
      const pilot = crew.pilotId != null ? this.players.get(crew.pilotId) : undefined;
      const hadAp = crew.mothership.ap != null;
      stepShip(crew.mothership, pilot && !pilot.craft ? pilot.lastInput : NO_INPUT, galaxy);
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

  /** The ship this player predicts locally: their craft, or the mothership when at the helm. */
  private controlledShip(p: Player, crew: Crew): ShipState | null {
    if (p.craft) return p.craft.ship;
    if (crew.pilotId === p.id) return crew.mothership;
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
      if (crew.systemId === systemId) out.push(shipWire(crew.mothership, crew.name));
    }
    for (const c of sys.crafts.values()) {
      const owner = c.pilotId != null ? this.players.get(c.pilotId) : undefined;
      const w = shipWire(c.ship, owner?.name);
      if (totalResources(c.cargo) > 0) w.f |= FLAG_LOADED;
      if (!owner) w.f |= FLAG_IDLE;
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
      cartStatus: sys ? sys.cartSummary(crew.id) : null,
      pilotId: crew.pilotId,
      members: [
        ...[...crew.members].map((id) => {
          const p = this.players.get(id)!;
          return { id, name: p.name, online: true, craftId: p.craft?.ship.id ?? null, craft: p.craft?.kind ?? null };
        }),
        ...crew.roster
          .filter((n) => ![...crew.members].some((id) => this.players.get(id)?.name === n))
          .map((name) => ({ id: null, name, online: false, craftId: null, craft: null })),
      ],
      fleet: crew.fleet.map((c) => ({
        id: c.ship.id,
        kind: c.kind,
        slot: c.slot,
        pilotId: c.pilotId,
        out: crew.systemId != null && !this.nearSlot(crew, c),
      })),
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
        lx: sys ? Math.round(m.x) : undefined,
        ly: sys ? Math.round(m.y) : undefined,
        fleet: crew.fleet.map((c) => c.kind),
        roster: crew.roster,
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
  return {
    sx: num(i?.sx),
    sy: num(i?.sy),
    turn: num(i?.turn),
    thrust: Math.max(0, num(i?.thrust)),
    brake: !!i?.brake,
    boost: !!i?.boost,
    action: !!i?.action,
  };
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
