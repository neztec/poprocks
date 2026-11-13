import type { CraftKind, EntityKind } from './constants';
import type { GravityBody, InputState, ShipState } from './flight';
import type { Resources } from './materials';
import type { CartSummary, RailNet } from './rails';
import type { PaintOp } from './terrain';

// ---- client -> server --------------------------------------------------------

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'input'; seq: number; i: InputState }
  /** board the first free craft of this kind */
  | { t: 'launch'; craft: CraftKind }
  /** board a specific fleet craft (drag-and-drop) */
  | { t: 'board'; craftId: number }
  | { t: 'dock' }
  /** move yourself to a seat aboard the mothership */
  | { t: 'seat'; seat: 'helm' | 'quarters' }
  | { t: 'helm'; take: boolean }
  | { t: 'autopilot'; systemId: number | null }
  | { t: 'jump' }
  | { t: 'dropCargo' }
  | { t: 'buildCart' };

// ---- server -> client --------------------------------------------------------

export interface SystemWire {
  id: number;
  name: string;
  gx: number;
  gy: number;
  color: string;
}

export interface AsteroidWire {
  id: number;
  x: number;
  y: number;
  cols: number;
  rows: number;
  data: string;
}

export type SpaceInfo =
  | { kind: 'galaxy'; systems: SystemWire[] }
  | { kind: 'system'; system: SystemWire; bodies: GravityBody[]; asteroids: AsteroidWire[] };

export const FLAG_DRILLING = 1;
export const FLAG_BOOSTING = 2;
export const FLAG_LOADED = 4;
/** an unmanned craft holding station in formation */
export const FLAG_IDLE = 8;

export interface EntWire {
  id: number;
  k: EntityKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  /** bit flags, see FLAG_* */
  f: number;
  /** label (pilot name, crew name) */
  n?: string;
}

export interface YouWire {
  /** entity this client predicts, if any */
  ship: ShipState | null;
  /** last input seq the server applied */
  ack: number;
  cargo: Resources | null;
  /** seconds to autopilot arrival */
  eta: number | null;
}

export interface CrewMember {
  /** player id while online, null for an offline crew member */
  id: number | null;
  name: string;
  online: boolean;
  /** fleet craft this member is flying */
  craftId: number | null;
  craft: CraftKind | null;
}

export interface FleetCraftWire {
  /** entity id of the craft */
  id: number;
  kind: CraftKind;
  /** formation slot around the mothership */
  slot: number;
  pilotId: number | null;
  /** away from its formation slot */
  out: boolean;
}

export interface CrewWire {
  id: number;
  name: string;
  resources: Resources;
  carts: number;
  /** null in hyperspace */
  cartStatus: CartSummary | null;
  pilotId: number | null;
  members: CrewMember[];
  fleet: FleetCraftWire[];
  /** where the mothership is: a system name or 'Hyperspace' */
  location: string;
  inSystem: boolean;
  autopilotTarget: number | null;
}

export type ServerMsg =
  | { t: 'welcome'; playerId: number; tickHz: number }
  | { t: 'space'; space: SpaceInfo }
  | { t: 'snap'; tick: number; ents: EntWire[]; you: YouWire }
  | { t: 'paint'; ops: PaintOp[] }
  | { t: 'rails'; net: RailNet }
  | { t: 'crew'; crew: CrewWire }
  | { t: 'toast'; text: string };
