import { Application, CanvasSource, Container, Graphics, Text, Texture, TilingSprite } from 'pixi.js';
import {
  DOCK_RADIUS,
  DRILL,
  FLAG_BOOSTING,
  FLAG_DRILLING,
  FLAG_LOADED,
  GALAXY,
  MAT,
  RAIL,
  nodeHasCargo,
  type EntityKind,
  type SystemWire,
} from '@poprock/shared';
import type { DisplayEnt, World } from '../world';
import { TerrainView } from './terrain';

interface EntView {
  kind: EntityKind;
  root: Container;
  rotor: Container;
  flame?: Graphics;
  drill?: Graphics;
  cargo?: Graphics;
  rings?: Graphics;
  label?: Text;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
}

const ZOOM_LIMITS = { system: [0.12, 1.6], galaxy: [0.015, 0.4] } as const;

export class Scene {
  readonly app = new Application();
  private stars: TilingSprite[] = [];
  private world = new Container();
  private bodiesG = new Graphics();
  private terrainLayer = new Container();
  private terrain: TerrainView[] = [];
  private railsG = new Graphics();
  private entLayer = new Container();
  private fxG = new Graphics();
  private galaxyG = new Graphics();
  private galaxyLabels = new Container();
  private systemLabels = new Map<number, Text>();
  private overlayG = new Graphics();
  private views = new Map<number, EntView>();
  private particles: Particle[] = [];
  private builtSpace = -1;
  private builtRails = -1;
  cam = { x: 0, y: 0 };
  zoom = { system: 0.55, galaxy: 0.09 };
  private time = 0;
  private kind: 'galaxy' | 'system' = 'galaxy';

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: window, background: '#04050a', antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    parent.appendChild(this.app.canvas);
    for (const [density, alpha] of [
      [0.00018, 0.5],
      [0.00007, 0.9],
    ] as const) {
      const t = new TilingSprite({ texture: starTexture(density), width: window.innerWidth, height: window.innerHeight });
      t.alpha = alpha;
      this.stars.push(t);
      this.app.stage.addChild(t);
    }
    this.fxG.blendMode = 'add';
    this.world.addChild(this.galaxyG, this.galaxyLabels, this.bodiesG, this.terrainLayer, this.railsG, this.entLayer, this.fxG);
    this.app.stage.addChild(this.world, this.overlayG);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }


  get currentZoom(): number {
    return this.zoom[this.kind];
  }

  zoomBy(factor: number): void {
    const [lo, hi] = ZOOM_LIMITS[this.kind];
    this.zoom[this.kind] = Math.max(lo, Math.min(hi, this.zoom[this.kind] * factor));
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    const z = this.currentZoom;
    return { x: (x - this.cam.x) * z + this.app.screen.width / 2, y: (y - this.cam.y) * z + this.app.screen.height / 2 };
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    const z = this.currentZoom;
    return { x: (x - this.app.screen.width / 2) / z + this.cam.x, y: (y - this.app.screen.height / 2) / z + this.cam.y };
  }

  /** System marker under a screen point, for click-to-autopilot. */
  systemAt(world: World, sx: number, sy: number): SystemWire | null {
    if (this.kind !== 'galaxy') return null;
    for (const s of world.systems) {
      const p = this.worldToScreen(s.gx, s.gy);
      if (Math.hypot(p.x - sx, p.y - sy) < 28) return s;
    }
    return null;
  }

  /** A paint op landed: kick up debris (or sparkles for ore blooms). */
  burst(x: number, y: number, r: number, m: number): void {
    if (this.particles.length > 600) return;
    const ore = m !== MAT.EMPTY;
    const n = ore ? 30 : 5;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (ore ? 60 : 40) + Math.random() * (ore ? 160 : 120);
      this.particles.push({
        x: x + Math.cos(a) * r * (ore ? Math.random() : 0.6),
        y: y + Math.sin(a) * r * (ore ? Math.random() : 0.6),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.6 + Math.random() * 0.6,
        max: 1.2,
        color: ore ? 0xffa04a : 0x8d93a8,
        size: ore ? 3 : 2 + Math.random() * 2,
      });
    }
  }

  render(world: World, dt: number, selectedTarget: number | null): void {
    this.time += dt;
    if (world.spaceVersion !== this.builtSpace) this.rebuild(world);
    if (world.railsVersion !== this.builtRails) this.drawRails(world);
    for (const t of this.terrain) t.update();

    const focus = world.focus();
    if (focus) {
      const k = Math.min(1, dt * 8);
      this.cam.x += (focus.x - this.cam.x) * k;
      this.cam.y += (focus.y - this.cam.y) * k;
    }
    const z = this.currentZoom;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    this.world.scale.set(z);
    this.world.position.set(sw / 2 - this.cam.x * z, sh / 2 - this.cam.y * z);
    this.stars.forEach((s, i) => {
      s.width = sw;
      s.height = sh;
      const par = (i + 1) * (this.kind === 'galaxy' ? 0.02 : 0.05);
      s.tilePosition.set(-this.cam.x * par, -this.cam.y * par);
    });

    this.syncEntities(world);
    this.stepParticles(dt);
    if (this.kind === 'galaxy') this.drawGalaxy(world, selectedTarget);
    this.drawOverlay(world);
  }

  // ---- space building ----

  private rebuild(world: World): void {
    this.builtSpace = world.spaceVersion;
    this.kind = world.space?.kind ?? 'galaxy';
    for (const t of this.terrain) t.destroy();
    this.terrain = [];
    this.terrainLayer.removeChildren();
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
    this.particles = [];
    this.bodiesG.clear();
    this.galaxyG.clear();
    this.galaxyLabels.removeChildren().forEach((c) => c.destroy());
    this.systemLabels.clear();
    const focusShip = world.focus();
    if (focusShip) {
      this.cam.x = focusShip.x;
      this.cam.y = focusShip.y;
    }

    if (world.space?.kind === 'system') {
      for (const a of world.asteroids) {
        const view = new TerrainView(a);
        this.terrain.push(view);
        this.terrainLayer.addChild(view.container);
      }
      const color = parseColor(world.space.system.color);
      for (const [i, b] of world.bodies.entries()) {
        if (i === 0) {
          for (let g = 6; g >= 1; g--) this.bodiesG.circle(b.x, b.y, b.radius * (1 + g * 0.35)).fill({ color, alpha: 0.035 });
          this.bodiesG.circle(b.x, b.y, b.radius).fill(color);
        } else {
          this.bodiesG.circle(b.x, b.y, b.radius).fill(0x3d4a6b).stroke({ width: 6, color: 0x6c7fae });
        }
      }
      if (!focusShip) {
        this.cam.x = world.bodies[0]?.x ?? 0;
        this.cam.y = world.bodies[0]?.y ?? 0;
      }
    } else if (world.space?.kind === 'galaxy') {
      for (const s of world.systems) {
        const t = new Text({ text: s.name, style: { fontFamily: 'monospace', fontSize: 14, fill: 0xcfd8ff } });
        t.anchor.set(0.5, -1.2);
        this.systemLabels.set(s.id, t);
        this.galaxyLabels.addChild(t);
      }
    }
  }

  private drawRails(world: World): void {
    this.builtRails = world.railsVersion;
    const g = this.railsG;
    g.clear();
    const byId = new Map(world.rails.nodes.map((n) => [n.id, n]));
    for (const [a, b] of world.rails.edges) {
      const p = byId.get(a);
      const q = byId.get(b);
      if (!p || !q) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      for (let t = 0; t <= len; t += 14) {
        const x = p.x + (dx / len) * t;
        const y = p.y + (dy / len) * t;
        g.moveTo(x - nx * 7, y - ny * 7).lineTo(x + nx * 7, y + ny * 7);
      }
      g.stroke({ width: 3, color: 0x4a5470 });
      g.moveTo(p.x + nx * 4, p.y + ny * 4).lineTo(q.x + nx * 4, q.y + ny * 4);
      g.moveTo(p.x - nx * 4, p.y - ny * 4).lineTo(q.x - nx * 4, q.y - ny * 4);
      g.stroke({ width: 2, color: 0xb8c6e6 });
    }
    for (const n of world.rails.nodes) {
      if (nodeHasCargo(n)) {
        g.rect(n.x - 9, n.y - 9, 18, 18).fill(0xc9773a).stroke({ width: 2, color: 0xffd8a8 });
      }
    }
  }

  // ---- entities ----

  private syncEntities(world: World): void {
    const inGalaxy = this.kind === 'galaxy';
    for (const [id, d] of world.ents) {
      let v = this.views.get(id);
      if (!v) {
        v = makeView(d, inGalaxy);
        this.views.set(id, v);
        this.entLayer.addChild(v.root);
      }
      v.root.position.set(d.x, d.y);
      v.rotor.rotation = d.a;
      if (inGalaxy) v.root.scale.set(Math.max(1, 0.22 / this.currentZoom));
      else if (v.label) v.label.scale.set(Math.max(1, 0.7 / this.currentZoom));
      const f = d.w.f;
      if (v.flame) {
        const moving = Math.hypot(d.w.vx, d.w.vy) > 30;
        v.flame.visible = moving;
        v.flame.scale.x = (f & FLAG_BOOSTING ? 1.6 : 1) * (0.8 + Math.random() * 0.4);
      }
      if (v.drill) {
        const on = (f & FLAG_DRILLING) !== 0;
        v.drill.scale.y = on ? 0.75 + Math.sin(this.time * 60) * 0.25 : 1;
        if (on && Math.random() < 0.6) {
          const hx = d.x + Math.cos(d.a) * DRILL.reach;
          const hy = d.y + Math.sin(d.a) * DRILL.reach;
          this.burst(hx, hy, DRILL.radius * 0.6, MAT.EMPTY);
        }
      }
      if (v.cargo) v.cargo.visible = (f & FLAG_LOADED) !== 0;
      if (d.w.k === 'critter') {
        v.rotor.alpha = 0.75 + Math.sin(this.time * 3 + id) * 0.25;
      }
    }
    for (const [id, v] of this.views) {
      if (!world.ents.has(id)) {
        v.root.destroy({ children: true });
        this.views.delete(id);
      }
    }
  }

  private stepParticles(dt: number): void {
    const g = this.fxG;
    g.clear();
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      g.circle(p.x, p.y, p.size).fill({ color: p.color, alpha: Math.min(1, p.life / p.max) });
      keep.push(p);
    }
    this.particles = keep;
  }

  // ---- galaxy map ----

  private drawGalaxy(world: World, selected: number | null): void {
    const g = this.galaxyG;
    const z = this.currentZoom;
    g.clear();
    // SC2-style grid
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.app.screen.width, this.app.screen.height);
    const step = 2000;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) g.moveTo(x, tl.y).lineTo(x, br.y);
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) g.moveTo(tl.x, y).lineTo(br.x, y);
    g.stroke({ width: 1 / z, color: 0x1d6b4a, alpha: 0.35 });

    const ms = world.myMothership();
    const apTarget = world.crew?.autopilotTarget ?? null;
    for (const s of world.systems) {
      const color = parseColor(s.color);
      const r = 9 / z;
      g.circle(s.gx, s.gy, GALAXY.enterRadius).stroke({ width: 1 / z, color, alpha: 0.25 });
      g.circle(s.gx, s.gy, r * 2.2).fill({ color, alpha: 0.12 });
      g.circle(s.gx, s.gy, r).fill(color);
      if (s.id === selected) g.circle(s.gx, s.gy, r * 2.6).stroke({ width: 2 / z, color: 0xffffff, alpha: 0.9 });
      if (s.id === apTarget && ms) {
        g.moveTo(ms.x, ms.y).lineTo(s.gx, s.gy).stroke({ width: 2 / z, color: 0x00ffcc, alpha: 0.6 });
      }
      const label = this.systemLabels.get(s.id);
      if (label) {
        label.position.set(s.gx, s.gy);
        label.scale.set(1 / z);
      }
    }
  }

  // ---- screen-space overlay ----

  private drawOverlay(world: World): void {
    const g = this.overlayG;
    g.clear();
    if (this.kind !== 'system') return;
    const ms = world.myMothership();
    const focus = world.focus();
    if (!ms || !focus || ms === focus) return;
    const p = this.worldToScreen(ms.x, ms.y);
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const margin = 40;
    if (p.x > margin && p.y > margin && p.x < w - margin && p.y < h - margin) return;
    // Arrow at the screen edge pointing home.
    const cx = w / 2;
    const cy = h / 2;
    const a = Math.atan2(p.y - cy, p.x - cx);
    const t = Math.min((w / 2 - margin) / Math.abs(Math.cos(a) || 1e-6), (h / 2 - margin) / Math.abs(Math.sin(a) || 1e-6));
    const ax = cx + Math.cos(a) * t;
    const ay = cy + Math.sin(a) * t;
    const s = 12;
    g.poly([
      ax + Math.cos(a) * s,
      ay + Math.sin(a) * s,
      ax + Math.cos(a + 2.5) * s,
      ay + Math.sin(a + 2.5) * s,
      ax + Math.cos(a - 2.5) * s,
      ay + Math.sin(a - 2.5) * s,
    ]).fill({ color: 0x8fa8ff, alpha: 0.85 });
  }
}

// ---- entity shapes (all face +x) ----

function makeView(d: DisplayEnt, inGalaxy: boolean): EntView {
  const root = new Container();
  const rotor = new Container();
  root.addChild(rotor);
  const v: EntView = { kind: d.w.k, root, rotor };
  const body = new Graphics();

  switch (d.w.k) {
    case 'scout': {
      v.flame = flame(-6, 6, 0xffaa33);
      body.poly([15, 0, -10, 10, -5, 0, -10, -10]).fill(0x00ffcc);
      rotor.addChild(v.flame, body);
      break;
    }
    case 'driller': {
      v.flame = flame(-18, 9, 0xff7a33);
      body.poly([-18, -12, 8, -14, 14, -8, 14, 8, 8, 14, -18, 12]).fill(0xd9822b).stroke({ width: 2, color: 0x5a3010 });
      body.rect(-12, -6, 12, 12).fill(0x3a2410);
      v.drill = new Graphics().poly([0, -11, 22, 0, 0, 11]).fill(0xcfd6e6).stroke({ width: 1.5, color: 0x6c7488 });
      v.drill.x = 13;
      v.cargo = new Graphics().rect(-15, -4, 8, 8).fill(0xffc070);
      rotor.addChild(v.flame, body, v.drill, v.cargo);
      break;
    }
    case 'layer': {
      v.flame = flame(-12, 7, 0x66bbff);
      body.poly([14, 0, -10, 12, -14, 0, -10, -12]).fill(0x5aa0ff).stroke({ width: 1.5, color: 0x1a3a70 });
      body.circle(-3, 0, 5).fill(0xffe08a);
      rotor.addChild(v.flame, body);
      break;
    }
    case 'mothership': {
      v.flame = flame(-120, 22, 0x66ccff);
      body
        .poly([130, 0, 80, -30, -90, -42, -120, -26, -120, 26, -90, 42, 80, 30])
        .fill(0x2b3555)
        .stroke({ width: 3, color: 0x8fa8ff });
      body.rect(-60, -16, 110, 32).fill(0x1a2038);
      body.rect(40, -8, 30, 16).fill(0x9fe8ff);
      body.circle(-110, -16, 8).fill(0x66ccff);
      body.circle(-110, 16, 8).fill(0x66ccff);
      rotor.addChild(v.flame, body);
      if (!inGalaxy) {
        v.rings = new Graphics();
        v.rings.circle(0, 0, DOCK_RADIUS).stroke({ width: 2, color: 0x8fa8ff, alpha: 0.18 });
        v.rings.circle(0, 0, RAIL.depotRadius).stroke({ width: 2, color: 0x4dff9a, alpha: 0.12 });
        root.addChildAt(v.rings, 0);
      }
      break;
    }
    case 'cart': {
      body.rect(-11, -8, 22, 16).fill(0x9aa3b8).stroke({ width: 2, color: 0x4a5470 });
      v.cargo = new Graphics().rect(-7, -5, 14, 10).fill(0xc9773a);
      rotor.addChild(body, v.cargo);
      break;
    }
    case 'critter': {
      const hue = (d.w.id * 47) % 360;
      const color = hslToHex(hue, 0.8, 0.65);
      body.circle(0, 0, 14).fill({ color, alpha: 0.18 });
      body.poly([9, 0, 1, -5, -6, 0, 1, 5]).fill(color);
      body.poly([-5, 0, -12, -5, -12, 5]).fill({ color, alpha: 0.8 });
      body.blendMode = 'add';
      rotor.addChild(body);
      break;
    }
  }

  if (d.w.n && d.w.k !== 'critter' && d.w.k !== 'cart') {
    v.label = new Text({ text: d.w.n, style: { fontFamily: 'monospace', fontSize: 12, fill: 0xdfe6ff } });
    v.label.anchor.set(0.5, d.w.k === 'mothership' ? -5 : -2.2);
    v.label.alpha = 0.8;
    root.addChild(v.label);
  }
  return v;
}

function flame(x: number, w: number, color: number): Graphics {
  const g = new Graphics().poly([0, -w * 0.6, -w * 1.8, 0, 0, w * 0.6]).fill({ color, alpha: 0.85 });
  g.x = x;
  g.blendMode = 'add';
  return g;
}

function starTexture(density: number): Texture {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const n = Math.floor(size * size * density);
  for (let i = 0; i < n; i++) {
    const b = 120 + Math.floor(Math.random() * 135);
    ctx.fillStyle = `rgb(${b},${b},${Math.min(255, b + 30)})`;
    const s = Math.random() < 0.1 ? 2 : 1;
    ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
  }
  return new Texture({ source: new CanvasSource({ resource: c }) });
}

function parseColor(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

function hslToHex(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

