import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT } from './constants';
import { NO_INPUT, copyShip, makeShip, stepShip, type InputState } from './flight';
import { MAT } from './materials';
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
  for (let i = 0; i < 120; i++) inputs.push({ sx: Math.cos(i * 0.05), sy: Math.sin(i * 0.05), boost: i % 30 < 10, action: true });
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
  const push: InputState = { sx: 1, sy: 0, boost: true, action: false };
  for (let i = 0; i < 300; i++) stepShip(s, push, { dt: DT, asteroids: terrain, bodies: [] });
  assert.ok(s.x < -600, `scout ended up inside the asteroid at x=${s.x}`);
});

test('driller tunnels into rock', () => {
  const terrain = [generateAsteroid(def)];
  const s = makeShip(1, 'driller', -1500, 0);
  const drill: InputState = { sx: 1, sy: 0, boost: false, action: true };
  for (let i = 0; i < 300; i++) stepShip(s, drill, { dt: DT, asteroids: terrain, bodies: [] });
  assert.ok(s.x > -700, `driller only reached x=${s.x}`);
});

test('mothership autopilot cancels on manual input', () => {
  const s = makeShip(1, 'mothership', 0, 0);
  s.ap = { x: 5000, y: 0, systemId: 3 };
  stepShip(s, NO_INPUT, { dt: DT, asteroids: [], bodies: [] });
  assert.ok(s.ap);
  const before = copyShip(s);
  stepShip(s, { sx: 0, sy: 1, boost: false, action: false }, { dt: DT, asteroids: [], bodies: [] });
  assert.equal(s.ap, null);
  assert.ok(before.ap);
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
