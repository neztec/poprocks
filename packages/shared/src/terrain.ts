import { MAT, MATERIALS } from './materials';
import { fbm } from './math';

/** World pixels per terrain cell. */
export const CELL = 15;

/** Natural cave shape: noise frequency (lower = longer, wider-spaced tunnels) and band half-width (higher = wider tunnels). */
export const CAVES = { scale: 0.02, band: 0.035 };
/** Cells per render/dirty chunk edge. */
export const CHUNK = 64;

/** How an asteroid is described in the galaxy definition (center + size + seed). */
export interface AsteroidDef {
  id: number;
  x: number;
  y: number;
  radius: number;
  seed: number;
}

/** Live, mutable asteroid terrain. x/y is the top-left corner in world pixels. */
export interface Asteroid {
  id: number;
  x: number;
  y: number;
  cols: number;
  rows: number;
  cell: number;
  cells: Uint8Array;
  /** chunk indices touched since the renderer last looked */
  dirtyChunks: Set<number>;
  /** changed since last persisted */
  dirty: boolean;
}

/** A circular terrain edit. Carving is painting MAT.EMPTY. Idempotent, so safe to apply twice. */
export interface PaintOp {
  a: number;
  x: number;
  y: number;
  r: number;
  m: number;
  /** 1 = only replace solid cells (e.g. ore blooms); 0 = replace anything */
  s: 0 | 1;
}

export function createAsteroid(id: number, x: number, y: number, cols: number, rows: number, cells?: Uint8Array): Asteroid {
  return {
    id,
    x,
    y,
    cols,
    rows,
    cell: CELL,
    cells: cells ?? new Uint8Array(cols * rows),
    dirtyChunks: new Set(),
    dirty: false,
  };
}

export function generateAsteroid(def: AsteroidDef): Asteroid {
  const size = Math.ceil((def.radius * 2) / CELL);
  const ast = createAsteroid(def.id, def.x - (size * CELL) / 2, def.y - (size * CELL) / 2, size, size);
  const R = def.radius / CELL;
  const c = size / 2;
  const seed = def.seed;
  const coreCavern = def.radius >= 2000 ? R * 0.12 : 0;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dx = col + 0.5 - c;
      const dy = row + 0.5 - c;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // Lumpy silhouette, sampled around the rim so it wraps seamlessly.
      const edge = R * (0.84 + 0.16 * fbm(Math.cos(ang) * 2.2 + 50, Math.sin(ang) * 2.2 + 50, seed, 3));
      if (d > edge) continue;
      if (d < coreCavern) continue;

      const depth = 1 - d / edge; // 0 at surface, 1 at core
      // Worm-like natural caves where the noise field crosses its midline.
      const cave = fbm(col * CAVES.scale, row * CAVES.scale, seed + 7, 4);
      if (depth > 0.07 && Math.abs(cave - 0.5) < CAVES.band) continue;

      let mat: number = depth < 0.1 ? MAT.CRUST : depth < 0.55 ? MAT.ROCK : MAT.DEEP;
      if (mat !== MAT.CRUST) {
        const ore = fbm(col * 0.07 + 100, row * 0.07, seed + 31, 3);
        if (ore > 0.7) mat = MAT.FERRITE;
        if (mat === MAT.DEEP && fbm(col * 0.11, row * 0.11 + 300, seed + 57, 2) > 0.76) mat = MAT.AURIC;
      }
      ast.cells[row * size + col] = mat;
    }
  }
  return ast;
}

export function cellAt(ast: Asteroid, x: number, y: number): number {
  const col = Math.floor((x - ast.x) / ast.cell);
  const row = Math.floor((y - ast.y) / ast.cell);
  if (col < 0 || row < 0 || col >= ast.cols || row >= ast.rows) return MAT.EMPTY;
  return ast.cells[row * ast.cols + col];
}

export function isSolidAt(asteroids: Asteroid[], x: number, y: number): boolean {
  for (const a of asteroids) if (cellAt(a, x, y) !== MAT.EMPTY) return true;
  return false;
}

function overlapsBounds(ast: Asteroid, x: number, y: number, r: number): boolean {
  return !(x + r < ast.x || y + r < ast.y || x - r > ast.x + ast.cols * ast.cell || y - r > ast.y + ast.rows * ast.cell);
}

export interface Contact {
  nx: number;
  ny: number;
  depth: number;
}

/** Circle vs solid cells. Returns an averaged push-out normal and the deepest penetration. */
export function collideCircle(ast: Asteroid, x: number, y: number, r: number): Contact | null {
  if (!overlapsBounds(ast, x, y, r)) return null;
  const cs = ast.cell;
  const c0 = Math.max(0, Math.floor((x - r - ast.x) / cs));
  const c1 = Math.min(ast.cols - 1, Math.floor((x + r - ast.x) / cs));
  const r0 = Math.max(0, Math.floor((y - r - ast.y) / cs));
  const r1 = Math.min(ast.rows - 1, Math.floor((y + r - ast.y) / cs));
  let sx = 0;
  let sy = 0;
  let maxDepth = 0;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (ast.cells[row * ast.cols + col] === MAT.EMPTY) continue;
      const left = ast.x + col * cs;
      const top = ast.y + row * cs;
      const px = Math.max(left, Math.min(x, left + cs));
      const py = Math.max(top, Math.min(y, top + cs));
      let dx = x - px;
      let dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      let depth: number;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        depth = r - d;
      } else {
        // Center is inside the cell: push away from the cell center.
        dx = x - (left + cs / 2);
        dy = y - (top + cs / 2);
        const d = Math.hypot(dx, dy) || 1;
        dx /= d;
        dy /= d;
        depth = r;
      }
      sx += dx * depth;
      sy += dy * depth;
      if (depth > maxDepth) maxDepth = depth;
    }
  }
  if (maxDepth === 0) return null;
  const len = Math.hypot(sx, sy);
  if (len < 1e-6) return { nx: 0, ny: -1, depth: maxDepth };
  return { nx: sx / len, ny: sy / len, depth: maxDepth };
}

/**
 * Paint a circle of cells with a material. Returns how many cells changed.
 * If `counts` is given, counts[oldMaterial] is incremented for each changed cell.
 */
export function paintCircle(
  ast: Asteroid,
  x: number,
  y: number,
  r: number,
  mat: number,
  onlySolid: boolean,
  counts?: number[],
): number {
  if (!overlapsBounds(ast, x, y, r)) return 0;
  const cs = ast.cell;
  const c0 = Math.max(0, Math.floor((x - r - ast.x) / cs));
  const c1 = Math.min(ast.cols - 1, Math.floor((x + r - ast.x) / cs));
  const r0 = Math.max(0, Math.floor((y - r - ast.y) / cs));
  const r1 = Math.min(ast.rows - 1, Math.floor((y + r - ast.y) / cs));
  const r2 = r * r;
  let changed = 0;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cx = ast.x + (col + 0.5) * cs - x;
      const cy = ast.y + (row + 0.5) * cs - y;
      if (cx * cx + cy * cy > r2) continue;
      const i = row * ast.cols + col;
      const old = ast.cells[i];
      if (old === mat) continue;
      if (onlySolid && old === MAT.EMPTY) continue;
      ast.cells[i] = mat;
      if (counts) counts[old]++;
      changed++;
      // Edge highlights depend on neighbors, so mark adjacent chunks too.
      markDirty(ast, col, row);
    }
  }
  if (changed > 0) ast.dirty = true;
  return changed;
}

function markDirty(ast: Asteroid, col: number, row: number): void {
  const chunkCols = Math.ceil(ast.cols / CHUNK);
  const cc = Math.floor(col / CHUNK);
  const cr = Math.floor(row / CHUNK);
  ast.dirtyChunks.add(cr * chunkCols + cc);
  const lc = col % CHUNK;
  const lr = row % CHUNK;
  if (lc === 0 && cc > 0) ast.dirtyChunks.add(cr * chunkCols + cc - 1);
  if (lc === CHUNK - 1 && (cc + 1) * CHUNK < ast.cols) ast.dirtyChunks.add(cr * chunkCols + cc + 1);
  if (lr === 0 && cr > 0) ast.dirtyChunks.add((cr - 1) * chunkCols + cc);
  if (lr === CHUNK - 1 && (cr + 1) * CHUNK < ast.rows) ast.dirtyChunks.add((cr + 1) * chunkCols + cc);
}

export function applyPaint(asteroids: Asteroid[], op: PaintOp, counts?: number[]): number {
  const ast = asteroids.find((a) => a.id === op.a);
  if (!ast) return 0;
  return paintCircle(ast, op.x, op.y, op.r, op.m, op.s === 1, counts);
}

/** Average hardness of the given material counts (0 if nothing). */
export function averageHardness(counts: number[]): number {
  let n = 0;
  let h = 0;
  for (let m = 1; m < counts.length; m++) {
    n += counts[m];
    h += counts[m] * MATERIALS[m].hardness;
  }
  return n === 0 ? 0 : h / n;
}

/** True if the straight line between two points never passes through solid terrain. */
export function lineClear(asteroids: Asteroid[], x0: number, y0: number, x1: number, y1: number): boolean {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (isSolidAt(asteroids, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

// --- wire encoding: run-length bytes, base64 ---------------------------------

export function encodeCells(cells: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let run = 1;
    while (i + run < cells.length && cells[i + run] === v && run < 255) run++;
    out.push(v, run);
    i += run;
  }
  return bytesToBase64(Uint8Array.from(out));
}

export function decodeCells(data: string, length: number): Uint8Array {
  const rle = base64ToBytes(data);
  const cells = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    cells.fill(rle[i], o, o + rle[i + 1]);
    o += rle[i + 1];
  }
  return cells;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
