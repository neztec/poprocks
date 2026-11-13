import { DRILL, SHIP_SPECS, STICK_DEADZONE, type ShipKind } from './constants';
import { MATERIALS } from './materials';
import { angleDiff, turnToward } from './math';
import { averageHardness, collideCircle, paintCircle, type Asteroid, type PaintOp } from './terrain';

export interface InputState {
  /** desired direction, magnitude 0..1 */
  sx: number;
  sy: number;
  boost: boolean;
  /** drill / lay rail */
  action: boolean;
}

export const NO_INPUT: InputState = { sx: 0, sy: 0, boost: false, action: false };

export interface Autopilot {
  x: number;
  y: number;
  systemId: number;
}

/** Everything the flight step reads and writes. Shared by server simulation and client prediction. */
export interface ShipState {
  id: number;
  kind: ShipKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  drilling: boolean;
  boosting: boolean;
  /** mothership only */
  ap: Autopilot | null;
}

export interface GravityBody {
  x: number;
  y: number;
  radius: number;
  /** pull strength; acceleration = mass / dist^2 */
  mass: number;
}

export interface StepEnv {
  dt: number;
  asteroids: Asteroid[];
  bodies: GravityBody[];
  /** called for each terrain edit the ship makes */
  onPaint?: (op: PaintOp) => void;
  /** called with material counts removed by the drill this step */
  onMined?: (counts: number[]) => void;
}

export function makeShip(id: number, kind: ShipKind, x: number, y: number, angle = 0): ShipState {
  return { id, kind, x, y, vx: 0, vy: 0, angle, drilling: false, boosting: false, ap: null };
}

export function copyShip(s: ShipState): ShipState {
  return { ...s, ap: s.ap ? { ...s.ap } : null };
}

export function gravityAt(bodies: GravityBody[], x: number, y: number): [number, number] {
  let gx = 0;
  let gy = 0;
  for (const b of bodies) {
    const dx = b.x - x;
    const dy = b.y - y;
    const d2 = Math.max(dx * dx + dy * dy, b.radius * b.radius);
    const d = Math.sqrt(d2);
    const a = b.mass / d2;
    gx += (dx / d) * a;
    gy += (dy / d) * a;
  }
  return [gx, gy];
}

/** Advance one ship by one fixed step. Deterministic given the same state, input and terrain. */
export function stepShip(s: ShipState, inp: InputState, env: StepEnv): void {
  const spec = SHIP_SPECS[s.kind];
  const dt = env.dt;
  let mag = Math.hypot(inp.sx, inp.sy);
  const steering = mag > STICK_DEADZONE;
  if (mag > 1) mag = 1;

  if (s.kind === 'mothership' && s.ap) {
    if (steering) s.ap = null; // any manual thrust takes back control
    else {
      autopilot(s, dt);
      integrate(s, env, spec.radius, spec.restitution);
      return;
    }
  }

  s.boosting = inp.boost && steering;
  const topSpeed = s.boosting ? spec.boostSpeed : spec.speed;

  if (steering) {
    s.angle = turnToward(s.angle, Math.atan2(inp.sy, inp.sx), spec.turnRate * dt);
  }

  if (spec.model === 'glide') {
    // Antopolous-style: holding the stick flies at a held speed along the heading; letting go coasts.
    if (steering) {
      const speed = Math.hypot(s.vx, s.vy);
      const target = topSpeed * mag;
      const next = speed < target ? Math.min(target, speed + spec.thrust * dt) : Math.max(target, speed - spec.thrust * dt);
      s.vx = Math.cos(s.angle) * next;
      s.vy = Math.sin(s.angle) * next;
    }
  } else {
    if (steering) {
      // Thrust is weaker while still turning to face the stick direction.
      const align = Math.max(0, Math.cos(angleDiff(s.angle, Math.atan2(inp.sy, inp.sx))));
      const a = spec.thrust * mag * (0.25 + 0.75 * align);
      s.vx += Math.cos(s.angle) * a * dt;
      s.vy += Math.sin(s.angle) * a * dt;
    }
    const decay = Math.exp(-(spec.drag + (steering ? 0 : spec.idleDrag)) * dt);
    s.vx *= decay;
    s.vy *= decay;
    limitSpeed(s, topSpeed);
  }

  if (spec.gravity && env.bodies.length > 0) {
    const [gx, gy] = gravityAt(env.bodies, s.x, s.y);
    s.vx += gx * dt;
    s.vy += gy * dt;
  }

  s.drilling = false;
  if (s.kind === 'driller' && inp.action) drill(s, env);

  integrate(s, env, spec.radius, spec.restitution);
}

function drill(s: ShipState, env: StepEnv): void {
  s.drilling = true;
  const hx = s.x + Math.cos(s.angle) * DRILL.reach;
  const hy = s.y + Math.sin(s.angle) * DRILL.reach;
  const counts = new Array<number>(MATERIALS.length).fill(0);
  for (const ast of env.asteroids) {
    if (paintCircle(ast, hx, hy, DRILL.radius, 0, false, counts) > 0) {
      env.onPaint?.({ a: ast.id, x: round1(hx), y: round1(hy), r: DRILL.radius, m: 0, s: 0 });
    }
  }
  const hardness = averageHardness(counts);
  if (hardness > 0) {
    limitSpeed(s, DRILL.speed / hardness);
    env.onMined?.(counts);
  }
}

function integrate(s: ShipState, env: StepEnv, radius: number, restitution: number): void {
  // Sub-step so fast ships can't skip over thin walls of 15px cells.
  const travel = Math.hypot(s.vx, s.vy) * env.dt;
  const steps = env.asteroids.length > 0 ? Math.max(1, Math.ceil(travel / Math.max(4, radius * 0.5))) : 1;
  const h = env.dt / steps;
  for (let i = 0; i < steps; i++) {
    s.x += s.vx * h;
    s.y += s.vy * h;
    resolveTerrain(s, env, radius, restitution);
  }
  resolveBodies(s, env, radius, restitution);
}

function resolveTerrain(s: ShipState, env: StepEnv, radius: number, restitution: number): void {
  for (const ast of env.asteroids) {
    // A couple of passes resolves corners without tunneling.
    for (let pass = 0; pass < 2; pass++) {
      const c = collideCircle(ast, s.x, s.y, radius);
      if (!c) break;
      const push = Math.min(c.depth, radius);
      s.x += c.nx * push;
      s.y += c.ny * push;
      const vn = s.vx * c.nx + s.vy * c.ny;
      if (vn < 0) {
        s.vx -= (1 + restitution) * vn * c.nx;
        s.vy -= (1 + restitution) * vn * c.ny;
      }
    }
  }
}

function resolveBodies(s: ShipState, env: StepEnv, radius: number, restitution: number): void {
  for (const b of env.bodies) {
    const dx = s.x - b.x;
    const dy = s.y - b.y;
    const d = Math.hypot(dx, dy);
    const min = b.radius + radius;
    if (d < min && d > 1e-6) {
      const nx = dx / d;
      const ny = dy / d;
      s.x = b.x + nx * min;
      s.y = b.y + ny * min;
      const vn = s.vx * nx + s.vy * ny;
      if (vn < 0) {
        s.vx -= (1 + restitution) * vn * nx;
        s.vy -= (1 + restitution) * vn * ny;
      }
    }
  }
}

function limitSpeed(s: ShipState, max: number): void {
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > max) {
    s.vx *= max / sp;
    s.vy *= max / sp;
  }
}

/** Steer toward the autopilot target, arriving with low speed. */
function autopilot(s: ShipState, dt: number): void {
  const ap = s.ap!;
  const spec = SHIP_SPECS.mothership;
  const dx = ap.x - s.x;
  const dy = ap.y - s.y;
  const dist = Math.hypot(dx, dy) || 1;
  const decel = spec.thrust * 0.8;
  const desired = Math.min(spec.speed, Math.sqrt(2 * decel * dist));
  const dvx = (dx / dist) * desired - s.vx;
  const dvy = (dy / dist) * desired - s.vy;
  const dvl = Math.hypot(dvx, dvy);
  const maxDv = spec.thrust * dt;
  if (dvl > maxDv) {
    s.vx += (dvx / dvl) * maxDv;
    s.vy += (dvy / dvl) * maxDv;
  } else {
    s.vx += dvx;
    s.vy += dvy;
  }
  s.angle = turnToward(s.angle, Math.atan2(dy, dx), spec.turnRate * dt);
  s.boosting = false;
  s.drilling = false;
}

/** Rough seconds-to-arrival for an autopiloted mothership. */
export function autopilotEta(s: ShipState): number | null {
  if (!s.ap) return null;
  const spec = SHIP_SPECS.mothership;
  const dist = Math.hypot(s.ap.x - s.x, s.ap.y - s.y);
  const speed = Math.hypot(s.vx, s.vy);
  const accelTime = Math.max(0, spec.speed - speed) / spec.thrust;
  const brakeDist = (spec.speed * spec.speed) / (2 * spec.thrust * 0.8);
  if (dist < brakeDist) return Math.sqrt((2 * dist) / (spec.thrust * 0.8));
  return accelTime + (dist - brakeDist) / spec.speed + spec.speed / (spec.thrust * 0.8);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
