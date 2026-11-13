import type { CrewWire, GravityBody } from '@poprock/shared';

export interface AsteroidRow {
  id: number;
  systemId: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  seed: number;
}

export interface SystemRow {
  id: number;
  name: string;
  gx: number;
  gy: number;
  color: string;
  def: { bodies: GravityBody[]; park: { x: number; y: number }; critters: number };
  asteroids: AsteroidRow[];
}

export type EventKind = 'broadcast' | 'spawnCritters' | 'oreBloom' | 'grantResources';

export interface EventRow {
  id: number;
  name: string;
  kind: EventKind;
  params: Record<string, unknown>;
  delaySec: number;
  repeatSec: number;
  enabled: boolean;
  lastFired: number | null;
}

export interface Overview {
  tick: number;
  uptimeSec: number;
  players: { id: number; name: string; crewId: number; craft: string | null; cargo: number; x: number | null; y: number | null }[];
  crews: CrewWire[];
  systems: { id: number; name: string; crafts: number; carts: number; critters: number; railNodes: number; asteroids: number }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  overview: () => call<Overview>('GET', '/api/overview'),
  systems: () => call<SystemRow[]>('GET', '/api/systems'),
  createSystem: (s: Partial<SystemRow>) => call<{ id: number }>('POST', '/api/systems', s),
  updateSystem: (s: SystemRow) => call<SystemRow>('PUT', `/api/systems/${s.id}`, s),
  deleteSystem: (id: number) => call('DELETE', `/api/systems/${id}`),
  clearRails: (id: number) => call('POST', `/api/systems/${id}/clear-rails`),
  addAsteroid: (systemId: number, a: Partial<AsteroidRow>) => call<{ id: number }>('POST', `/api/systems/${systemId}/asteroids`, a),
  updateAsteroid: (a: AsteroidRow) => call('PUT', `/api/asteroids/${a.id}`, a),
  deleteAsteroid: (id: number) => call('DELETE', `/api/asteroids/${id}`),
  events: () => call<EventRow[]>('GET', '/api/events'),
  createEvent: (e: Partial<EventRow>) => call<{ id: number }>('POST', '/api/events', e),
  updateEvent: (e: EventRow) => call<EventRow>('PUT', `/api/events/${e.id}`, e),
  deleteEvent: (id: number) => call('DELETE', `/api/events/${id}`),
  triggerEvent: (id: number) => call<{ result: string }>('POST', `/api/events/${id}/trigger`),
  broadcast: (message: string) => call('POST', '/api/broadcast', { message }),
};
