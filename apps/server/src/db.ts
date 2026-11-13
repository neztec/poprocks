import { DatabaseSync } from 'node:sqlite';
import { emptyRailNet, type GravityBody, type RailNet, type Resources } from '@poprock/shared';
import { seedGalaxy } from './seed';

export interface SystemDef {
  bodies: GravityBody[];
  /** where motherships park on arrival */
  park: { x: number; y: number };
  /** target wildlife population */
  critters: number;
}

export interface SystemRow {
  id: number;
  name: string;
  gx: number;
  gy: number;
  color: string;
  def: SystemDef;
}

export interface AsteroidRow {
  id: number;
  systemId: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  seed: number;
}

export interface CrewData {
  resources: Resources;
  carts: number;
  /** system id the mothership is parked in, or null when in hyperspace */
  systemId: number | null;
  gx: number;
  gy: number;
  angle: number;
}

export type EventKind = 'broadcast' | 'spawnCritters' | 'oreBloom' | 'grantResources';

export interface EventRow {
  id: number;
  name: string;
  kind: EventKind;
  params: Record<string, unknown>;
  /** seconds after server start (or after being enabled) before first firing */
  delaySec: number;
  /** 0 = fire once */
  repeatSec: number;
  enabled: boolean;
  lastFired: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS systems (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  gx REAL NOT NULL,
  gy REAL NOT NULL,
  color TEXT NOT NULL,
  def TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asteroids (
  id INTEGER PRIMARY KEY,
  system_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL,
  y REAL NOT NULL,
  radius REAL NOT NULL,
  seed INTEGER NOT NULL,
  cols INTEGER,
  rows INTEGER,
  cells BLOB
);
CREATE TABLE IF NOT EXISTS rails (
  system_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  delay_sec REAL NOT NULL DEFAULT 0,
  repeat_sec REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired INTEGER
);
`;

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM systems').get() as Row;
    if (Number(count.n) === 0) seedGalaxy(this);
  }

  // ---- systems ----

  listSystems(): SystemRow[] {
    return (this.db.prepare('SELECT * FROM systems ORDER BY id').all() as Row[]).map(toSystem);
  }

  getSystem(id: number): SystemRow | null {
    const r = this.db.prepare('SELECT * FROM systems WHERE id = ?').get(id) as Row | undefined;
    return r ? toSystem(r) : null;
  }

  insertSystem(s: Omit<SystemRow, 'id'>): number {
    const res = this.db
      .prepare('INSERT INTO systems (name, gx, gy, color, def) VALUES (?, ?, ?, ?, ?)')
      .run(s.name, s.gx, s.gy, s.color, JSON.stringify(s.def));
    return Number(res.lastInsertRowid);
  }

  updateSystem(s: SystemRow): void {
    this.db
      .prepare('UPDATE systems SET name = ?, gx = ?, gy = ?, color = ?, def = ? WHERE id = ?')
      .run(s.name, s.gx, s.gy, s.color, JSON.stringify(s.def), s.id);
  }

  deleteSystem(id: number): void {
    this.db.prepare('DELETE FROM asteroids WHERE system_id = ?').run(id);
    this.db.prepare('DELETE FROM rails WHERE system_id = ?').run(id);
    this.db.prepare('DELETE FROM systems WHERE id = ?').run(id);
  }

  // ---- asteroids ----

  listAsteroids(systemId?: number): AsteroidRow[] {
    const rows = (
      systemId == null
        ? this.db.prepare('SELECT id, system_id, name, x, y, radius, seed FROM asteroids ORDER BY id').all()
        : this.db.prepare('SELECT id, system_id, name, x, y, radius, seed FROM asteroids WHERE system_id = ? ORDER BY id').all(systemId)
    ) as Row[];
    return rows.map(toAsteroid);
  }

  getAsteroid(id: number): AsteroidRow | null {
    const r = this.db.prepare('SELECT id, system_id, name, x, y, radius, seed FROM asteroids WHERE id = ?').get(id) as Row | undefined;
    return r ? toAsteroid(r) : null;
  }

  insertAsteroid(a: Omit<AsteroidRow, 'id'>): number {
    const res = this.db
      .prepare('INSERT INTO asteroids (system_id, name, x, y, radius, seed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.systemId, a.name, a.x, a.y, a.radius, a.seed);
    return Number(res.lastInsertRowid);
  }

  /** Updates shape parameters and drops saved cells so it regenerates. */
  updateAsteroid(a: AsteroidRow): void {
    this.db
      .prepare('UPDATE asteroids SET name = ?, x = ?, y = ?, radius = ?, seed = ?, cols = NULL, rows = NULL, cells = NULL WHERE id = ?')
      .run(a.name, a.x, a.y, a.radius, a.seed, a.id);
  }

  deleteAsteroid(id: number): void {
    this.db.prepare('DELETE FROM asteroids WHERE id = ?').run(id);
  }

  loadCells(id: number): { cols: number; rows: number; cells: Uint8Array } | null {
    const r = this.db.prepare('SELECT cols, rows, cells FROM asteroids WHERE id = ?').get(id) as Row | undefined;
    if (!r || r.cells == null) return null;
    return { cols: Number(r.cols), rows: Number(r.rows), cells: new Uint8Array(r.cells as Uint8Array) };
  }

  saveCells(id: number, cols: number, rows: number, cells: Uint8Array): void {
    this.db.prepare('UPDATE asteroids SET cols = ?, rows = ?, cells = ? WHERE id = ?').run(cols, rows, cells, id);
  }

  // ---- rails ----

  loadRails(systemId: number): RailNet {
    const r = this.db.prepare('SELECT data FROM rails WHERE system_id = ?').get(systemId) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as RailNet) : emptyRailNet();
  }

  saveRails(systemId: number, net: RailNet): void {
    this.db
      .prepare('INSERT INTO rails (system_id, data) VALUES (?, ?) ON CONFLICT(system_id) DO UPDATE SET data = excluded.data')
      .run(systemId, JSON.stringify(net));
  }

  // ---- crews ----

  listCrews(): { id: number; name: string; data: CrewData }[] {
    return (this.db.prepare('SELECT * FROM crews ORDER BY id').all() as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      data: JSON.parse(String(r.data)) as CrewData,
    }));
  }

  insertCrew(name: string, data: CrewData): number {
    const res = this.db.prepare('INSERT INTO crews (name, data) VALUES (?, ?)').run(name, JSON.stringify(data));
    return Number(res.lastInsertRowid);
  }

  saveCrew(id: number, name: string, data: CrewData): void {
    this.db.prepare('UPDATE crews SET name = ?, data = ? WHERE id = ?').run(name, JSON.stringify(data), id);
  }

  // ---- events ----

  listEvents(): EventRow[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id').all() as Row[]).map(toEvent);
  }

  getEvent(id: number): EventRow | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  insertEvent(e: Omit<EventRow, 'id' | 'lastFired'>): number {
    const res = this.db
      .prepare('INSERT INTO events (name, kind, params, delay_sec, repeat_sec, enabled) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.name, e.kind, JSON.stringify(e.params), e.delaySec, e.repeatSec, e.enabled ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  updateEvent(e: EventRow): void {
    this.db
      .prepare('UPDATE events SET name = ?, kind = ?, params = ?, delay_sec = ?, repeat_sec = ?, enabled = ?, last_fired = ? WHERE id = ?')
      .run(e.name, e.kind, JSON.stringify(e.params), e.delaySec, e.repeatSec, e.enabled ? 1 : 0, e.lastFired, e.id);
  }

  deleteEvent(id: number): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }
}

function toSystem(r: Row): SystemRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    gx: Number(r.gx),
    gy: Number(r.gy),
    color: String(r.color),
    def: JSON.parse(String(r.def)) as SystemDef,
  };
}

function toAsteroid(r: Row): AsteroidRow {
  return {
    id: Number(r.id),
    systemId: Number(r.system_id),
    name: String(r.name),
    x: Number(r.x),
    y: Number(r.y),
    radius: Number(r.radius),
    seed: Number(r.seed),
  };
}

function toEvent(r: Row): EventRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: String(r.kind) as EventKind,
    params: JSON.parse(String(r.params)) as Record<string, unknown>,
    delaySec: Number(r.delay_sec),
    repeatSec: Number(r.repeat_sec),
    enabled: Number(r.enabled) === 1,
    lastFired: r.last_fired == null ? null : Number(r.last_fired),
  };
}
