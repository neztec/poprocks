import type { IncomingMessage, ServerResponse } from 'node:http';
import { totalResources } from '@poprock/shared';
import type { EventKind, EventRow, Store, SystemDef, SystemRow } from './db';
import type { EventScheduler } from './events';
import type { Game } from './game';
import { defaultSystemDef } from './seed';

type Handler = (ctx: { params: string[]; body: Record<string, unknown> }) => unknown;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const EVENT_KINDS: EventKind[] = ['broadcast', 'spawnCritters', 'oreBloom', 'grantResources'];

/** Admin REST API. No auth yet: the server is meant to run locally for now. */
export function createApi(store: Store, game: Game, events: EventScheduler) {
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) => {
    routes.push([method, new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), h]);
  };

  const systemOr404 = (id: string): SystemRow => {
    const s = store.getSystem(Number(id));
    if (!s) throw new HttpError(404, 'system not found');
    return s;
  };

  route('GET', '/api/overview', () => ({
    tick: game.tick,
    uptimeSec: Math.round((Date.now() - game.startedAt) / 1000),
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      crewId: p.crewId,
      craft: p.craft?.kind ?? null,
      cargo: p.craft ? totalResources(p.craft.cargo) : 0,
      x: p.craft ? Math.round(p.craft.ship.x) : null,
      y: p.craft ? Math.round(p.craft.ship.y) : null,
    })),
    crews: [...game.crews.values()].map((c) => game.crewWire(c)),
    systems: [...game.systems.values()].map((s) => ({
      id: s.row.id,
      name: s.row.name,
      crafts: s.crafts.size,
      carts: s.carts.length,
      critters: s.critters.length,
      railNodes: s.rails.nodes.length,
      asteroids: s.asteroids.length,
    })),
  }));

  route('GET', '/api/systems', () =>
    store.listSystems().map((s) => ({ ...s, asteroids: store.listAsteroids(s.id) })),
  );

  route('POST', '/api/systems', ({ body }) => {
    const id = store.insertSystem({
      name: str(body.name, 'New System'),
      gx: num(body.gx, 0),
      gy: num(body.gy, 0),
      color: str(body.color, '#ffffff'),
      def: defaultSystemDef(),
    });
    store.insertAsteroid({ systemId: id, name: 'Asteroid A', x: 4500, y: 0, radius: 1600, seed: Math.floor(Math.random() * 1e9) });
    game.reloadSystem(id);
    return { id };
  });

  route('PUT', '/api/systems/:id', ({ params, body }) => {
    const s = systemOr404(params[0]);
    const def = (body.def ?? {}) as Partial<SystemDef>;
    const next: SystemRow = {
      ...s,
      name: str(body.name, s.name),
      gx: num(body.gx, s.gx),
      gy: num(body.gy, s.gy),
      color: str(body.color, s.color),
      def: {
        bodies: Array.isArray(def.bodies) ? def.bodies.map((b) => ({ x: num(b.x, 0), y: num(b.y, 0), radius: num(b.radius, 100), mass: num(b.mass, 0) })) : s.def.bodies,
        park: def.park ? { x: num(def.park.x, s.def.park.x), y: num(def.park.y, s.def.park.y) } : s.def.park,
        critters: def.critters != null ? Math.max(0, Math.min(200, num(def.critters, s.def.critters))) : s.def.critters,
      },
    };
    store.updateSystem(next);
    game.reloadSystem(s.id);
    return next;
  });

  route('DELETE', '/api/systems/:id', ({ params }) => {
    const s = systemOr404(params[0]);
    if ([...game.crews.values()].some((c) => c.systemId === s.id)) throw new HttpError(409, 'a crew is parked in this system');
    store.deleteSystem(s.id);
    game.reloadSystem(s.id);
    return { ok: true };
  });

  route('POST', '/api/systems/:id/asteroids', ({ params, body }) => {
    const s = systemOr404(params[0]);
    const id = store.insertAsteroid({
      systemId: s.id,
      name: str(body.name, 'Asteroid'),
      x: num(body.x, 0),
      y: num(body.y, 0),
      radius: clampRadius(num(body.radius, 1500)),
      seed: Math.floor(num(body.seed, Math.random() * 1e9)),
    });
    game.reloadSystem(s.id);
    return { id };
  });

  route('POST', '/api/systems/:id/clear-rails', ({ params }) => {
    const s = systemOr404(params[0]);
    game.systems.get(s.id)?.clearRails();
    return { ok: true };
  });

  route('PUT', '/api/asteroids/:id', ({ params, body }) => {
    const a = store.getAsteroid(Number(params[0]));
    if (!a) throw new HttpError(404, 'asteroid not found');
    store.updateAsteroid({
      ...a,
      name: str(body.name, a.name),
      x: num(body.x, a.x),
      y: num(body.y, a.y),
      radius: clampRadius(num(body.radius, a.radius)),
      seed: Math.floor(num(body.seed, a.seed)),
    });
    game.reloadSystem(a.systemId);
    return { ok: true };
  });

  route('DELETE', '/api/asteroids/:id', ({ params }) => {
    const a = store.getAsteroid(Number(params[0]));
    if (!a) throw new HttpError(404, 'asteroid not found');
    store.deleteAsteroid(a.id);
    game.reloadSystem(a.systemId);
    return { ok: true };
  });

  route('GET', '/api/events', () => store.listEvents());

  route('POST', '/api/events', ({ body }) => {
    const id = store.insertEvent(eventFromBody(body));
    return { id };
  });

  route('PUT', '/api/events/:id', ({ params, body }) => {
    const e = store.getEvent(Number(params[0]));
    if (!e) throw new HttpError(404, 'event not found');
    const next: EventRow = { ...e, ...eventFromBody(body, e) };
    store.updateEvent(next);
    return next;
  });

  route('DELETE', '/api/events/:id', ({ params }) => {
    store.deleteEvent(Number(params[0]));
    return { ok: true };
  });

  route('POST', '/api/events/:id/trigger', ({ params }) => {
    const e = store.getEvent(Number(params[0]));
    if (!e) throw new HttpError(404, 'event not found');
    // Manual triggers don't consume a one-shot event.
    const wasEnabled = e.enabled;
    const result = events.fire(e);
    e.enabled = wasEnabled;
    store.updateEvent(e);
    return { result };
  });

  route('POST', '/api/broadcast', ({ body }) => {
    game.toastAll(str(body.message, ''));
    return { ok: true };
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        const body = req.method === 'GET' ? {} : await readJson(req);
        const out = h({ params: m.slice(1), body });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message) }));
      }
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    return true;
  };
}

function eventFromBody(body: Record<string, unknown>, prev?: EventRow): Omit<EventRow, 'id' | 'lastFired'> {
  const kind = EVENT_KINDS.includes(body.kind as EventKind) ? (body.kind as EventKind) : (prev?.kind ?? 'broadcast');
  return {
    name: str(body.name, prev?.name ?? 'Event'),
    kind,
    params: typeof body.params === 'object' && body.params ? (body.params as Record<string, unknown>) : (prev?.params ?? {}),
    delaySec: Math.max(0, num(body.delaySec, prev?.delaySec ?? 0)),
    repeatSec: Math.max(0, num(body.repeatSec, prev?.repeatSec ?? 0)),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : (prev?.enabled ?? true),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof v === 'object' && v ? v : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function clampRadius(r: number): number {
  return Math.max(300, Math.min(4000, r));
}
