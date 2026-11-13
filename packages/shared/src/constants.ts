export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
/** Server sends a snapshot every N ticks. */
export const SNAPSHOT_EVERY = 2;

export const DEFAULT_PORT = 8080;

export type CraftKind = 'scout' | 'driller' | 'layer';
export type ShipKind = CraftKind | 'mothership';
export type EntityKind = ShipKind | 'cart' | 'critter';

export const CRAFT_KINDS: CraftKind[] = ['scout', 'driller', 'layer'];

/** Which flight model a ship uses. Carts ride rails and are simulated separately. */
export type FlightModel = 'glide' | 'thrust';

export interface ShipSpec {
  label: string;
  model: FlightModel;
  radius: number;
  turnRate: number; // rad/s
  /** glide: cruise speed. thrust: top speed. */
  speed: number;
  boostSpeed: number;
  /** thrust model acceleration, px/s^2 */
  thrust: number;
  /** thrust model velocity decay per second (exponential) */
  drag: number;
  /** extra drag applied while there is no stick input */
  idleDrag: number;
  /** bounciness against terrain, 0..1 */
  restitution: number;
  /** affected by gravity bodies */
  gravity: boolean;
  /** cargo hold size in ore units (0 = none) */
  hold: number;
}

export const SHIP_SPECS: Record<ShipKind, ShipSpec> = {
  scout: {
    label: 'Scout',
    model: 'glide',
    radius: 10,
    turnRate: 5.0,
    speed: 520,
    boostSpeed: 950,
    thrust: 1600,
    drag: 0,
    idleDrag: 0,
    restitution: 0.55,
    gravity: true,
    hold: 0,
  },
  driller: {
    label: 'Driller',
    model: 'thrust',
    radius: 16,
    turnRate: 2.8,
    speed: 400,
    boostSpeed: 520,
    thrust: 850,
    drag: 0.9,
    idleDrag: 2.2,
    restitution: 0.1,
    gravity: false,
    hold: 120,
  },
  layer: {
    label: 'Rail Layer',
    model: 'thrust',
    radius: 12,
    turnRate: 3.8,
    speed: 360,
    boostSpeed: 480,
    thrust: 900,
    drag: 1.2,
    idleDrag: 3.0,
    restitution: 0.2,
    gravity: false,
    hold: 0,
  },
  mothership: {
    label: 'Mothership',
    model: 'thrust',
    radius: 60,
    turnRate: 1.6,
    speed: 900,
    boostSpeed: 1400,
    thrust: 420,
    drag: 0.25,
    idleDrag: 0.5,
    restitution: 0,
    gravity: false,
    hold: 0,
  },
};

/** The mothership inside a star system: a slow, heavy base of operations. */
export const MOTHERSHIP_LOCAL: ShipSpec = {
  ...SHIP_SPECS.mothership,
  turnRate: 0.45,
  speed: 110,
  boostSpeed: 160,
  thrust: 55,
  drag: 0.15,
  idleDrag: 0.35,
  restitution: 0.05,
};

/** Braking decelerates at this multiple of a ship's thrust. */
export const BRAKE_FACTOR = 1.2;

/** Unmanned craft hold station in a ring around their mothership. */
export const FORMATION = {
  radius: 230,
  /** a returning craft this close to its slot re-docks */
  dockRadius: 90,
  /** a craft must get this far from its slot before flying back re-docks it */
  armDistance: 160,
  /** how fast an unmanned craft flies home to its slot */
  returnSpeed: 420,
};

/** The craft a new crew starts with, in formation-slot order. */
export const DEFAULT_FLEET: CraftKind[] = ['scout', 'driller', 'layer', 'driller'];

export const DRILL = {
  reach: 40,
  radius: 38,
  /** Max speed while carving material of hardness 1. */
  speed: 190,
};

export const RAIL = {
  spacing: 48,
  snap: 26,
  /** a rail node this close to the parked mothership is a depot */
  depotRadius: 340,
  cartSpeed: 260,
  /** how close a driller has to be to a rail node to drop cargo on it */
  dropRadius: 90,
};

export const DOCK_RADIUS = 280;
export const CART_COST = { ferrite: 40 };

export const GALAXY = {
  /** distance from a star at which a mothership drops into the system */
  enterRadius: 260,
  exitDistance: 480,
};

export const STICK_DEADZONE = 0.15;
