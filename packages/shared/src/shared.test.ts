import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT } from './constants';
import { NO_INPUT, copyShip, makeShip, stepShip, type InputState } from './flight';
import { MAT } from './materials';
import { angleDiff } from './math';
import { emptyRailNet, extendRail, findPath, isDepot } from './rails';
import { applyPaint, cellAt, collideCircle, decodeCells, encodeCells, generateAsteroid } from './terrain';

const def = { id: 1, x: 0, y: 0, radius: 1200, seed: 42 };

test('asteroid generation is deterministic and solid near the middle ring', () => {
  const a = generateAsteroid(def);
  const b = generateAsteroid(def);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(cellAt(a, 5000, 5000), MAT.EMPTY);
  let solid = 0;
  for (const c of a.cells) if (c !== MAT.EMPTY) solid++;
  assert.ok(solid > a.cells.length * 0.4, `expected a mostly solid asteroid, got ${solid}/${a.cells.length}`);
});

test('cell encoding round-trips', () => {
  const a = generateAsteroid(def);
  const decoded = decodeCells(encodeCells(a.cells), a.cells.length);
  assert.deepEqual(decoded, a.cells);
});

test('carving is idempotent and reports mined materials', () => {
  const a = generateAsteroid(def);
  const op = { a: 1, x: 600, y: 0, r: 60, m: MAT.EMPTY, s: 0 as const };
  const counts = new Array(6).fill(0);
  const first = applyPaint([a], op, counts);
  assert.ok(first > 0);
  assert.equal(counts.reduce((s, n) => s + n, 0), first);
  assert.equal(applyPaint([a], op), 0);
  assert.equal(collideCircle(a, 600, 0, 10), null);
});

test('flight step is deterministic (client prediction depends on this)', () => {
  const inputs: InputState[] = [];
  for (let i = 0; i < 120; i++) inputs.push({ ...NO_INPUT, sx: Math.cos(i * 0.05), sy: Math.sin(i * 0.05), boost: i % 30 < 10, action: true });
  const run = () => {
    const terrain = [generateAsteroid(def)];
    const s = makeShip(1, 'driller', -1500, 0);
    for (const i of inputs) stepShip(s, i, { dt: DT, asteroids: terrain, bodies: [] });
    return s;
  };
  assert.deepEqual(run(), run());
});

test('ships do not pass through rock', () => {
  const terrain = [generateAsteroid(def)];
  const s = makeShip(1, 'scout', -1600, 0);
  const push: InputState = { ...NO_INPUT, sx: 1, boost: true };
  for (let i = 0; i < 300; i++) stepShip(s, push, { dt: DT, asteroids: terrain, bodies: [] });
  assert.ok(s.x < -600, `scout ended up inside the asteroid at x=${s.x}`);
});

test('driller tunnels into rock', () => {
  const terrain = [generateAsteroid(def)];
  const s = makeShip(1, 'driller', -1500, 0);
  const drill: InputState = { ...NO_INPUT, sx: 1, action: true };
  for (let i = 0; i < 300; i++) stepShip(s, drill, { dt: DT, asteroids: terrain, bodies: [] });
  assert.ok(s.x > -700, `driller only reached x=${s.x}`);
});

test('mothership autopilot cancels on manual input', () => {
  const s = makeShip(1, 'mothership', 0, 0);
  s.ap = { x: 5000, y: 0, systemId: 3 };
  stepShip(s, NO_INPUT, { dt: DT, asteroids: [], bodies: [], galaxy: true });
  assert.ok(s.ap);
  const before = copyShip(s);
  stepShip(s, { ...NO_INPUT, sy: 1 }, { dt: DT, asteroids: [], bodies: [], galaxy: true });
  assert.equal(s.ap, null);
  assert.ok(before.ap);
});

test('keyboard: A/D rotate in place, W thrusts along the nose, S brakes', () => {
  const s = makeShip(1, 'driller', 0, 0, 0);
  for (let i = 0; i < 15; i++) stepShip(s, { ...NO_INPUT, turn: 1 }, { dt: DT, asteroids: [], bodies: [] });
  assert.ok(s.angle > 1, `expected a clockwise turn, angle=${s.angle}`);
  assert.equal(Math.hypot(s.vx, s.vy), 0, 'turning alone should not move the ship');
  const heading = s.angle;
  for (let i = 0; i < 30; i++) stepShip(s, { ...NO_INPUT, thrust: 1 }, { dt: DT, asteroids: [], bodies: [] });
  assert.ok(Math.abs(angleDiff(Math.atan2(s.vy, s.vx), heading)) < 0.01, 'thrust should push along the heading');
  const fast = Math.hypot(s.vx, s.vy);
  for (let i = 0; i < 10; i++) stepShip(s, { ...NO_INPUT, brake: true }, { dt: DT, asteroids: [], bodies: [] });
  assert.ok(Math.hypot(s.vx, s.vy) < fast * 0.3, 'brake should bleed off speed');
});

test('mothership is slow inside a system and fast on the galaxy map', () => {
  const run = (galaxy: boolean) => {
    const s = makeShip(1, 'mothership', 0, 0);
    for (let i = 0; i < 600; i++) stepShip(s, { ...NO_INPUT, thrust: 1 }, { dt: DT, asteroids: [], bodies: [], galaxy });
    return Math.hypot(s.vx, s.vy);
  };
  assert.ok(run(false) <= 111);
  assert.ok(run(true) > 500);
});

test('rails extend, snap, and path to a depot', () => {
  const net = emptyRailNet();
  let tail: number | null = null;
  for (let x = 0; x <= 400; x += 10) tail = extendRail(net, [], tail, x, 0).tail;
  assert.ok(net.nodes.length >= 8);
  const far = net.nodes[net.nodes.length - 1];
  const path = findPath(net, far.id, (n) => isDepot(n, 0, 0));
  assert.ok(path && path.length > 1);
});
