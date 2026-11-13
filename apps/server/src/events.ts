import { MAT, RESOURCE_KINDS, emptyResources, paintCircle } from '@poprock/shared';
import type { EventRow, Store } from './db';
import type { Game } from './game';

/** Runs admin-authored events on their schedule. */
export class EventScheduler {
  private enabledAt = new Map<number, number>();

  constructor(
    private store: Store,
    private game: Game,
  ) {}

  /** Called about once a second. */
  poll(): void {
    const now = Date.now();
    for (const e of this.store.listEvents()) {
      if (!e.enabled) {
        this.enabledAt.delete(e.id);
        continue;
      }
      if (!this.enabledAt.has(e.id)) this.enabledAt.set(e.id, now);
      const since = this.enabledAt.get(e.id)!;
      const due =
        e.lastFired == null || e.lastFired < since
          ? now - since >= e.delaySec * 1000
          : e.repeatSec > 0 && now - e.lastFired >= e.repeatSec * 1000;
      if (due) this.fire(e);
    }
  }

  fire(e: EventRow): string {
    const result = this.run(e);
    e.lastFired = Date.now();
    if (e.repeatSec <= 0 && e.lastFired) {
      // one-shot events switch themselves off after firing
      e.enabled = false;
    }
    this.store.updateEvent(e);
    console.log(`[event] ${e.name}: ${result}`);
    return result;
  }

  private run(e: EventRow): string {
    const p = e.params;
    const systemId = typeof p.systemId === 'number' ? p.systemId : undefined;
    switch (e.kind) {
      case 'broadcast': {
        const text = String(p.message ?? '');
        this.game.toastAll(text, systemId);
        return `broadcast "${text}"`;
      }
      case 'spawnCritters': {
        const sys = systemId != null ? this.game.systems.get(systemId) : undefined;
        if (!sys) return 'no such system';
        const n = Math.max(1, Math.min(100, Number(p.count ?? 5)));
        sys.spawnCritters(n);
        this.game.toastAll(`A school of glimmers drifts into ${sys.row.name}.`, sys.row.id);
        return `spawned ${n} critters in ${sys.row.name}`;
      }
      case 'oreBloom': {
        const sys = systemId != null ? this.game.systems.get(systemId) : undefined;
        if (!sys || sys.asteroids.length === 0) return 'no such system or no asteroids';
        const count = Math.max(1, Math.min(20, Number(p.count ?? 3)));
        const radius = Math.max(30, Math.min(400, Number(p.radius ?? 120)));
        let blooms = 0;
        for (let i = 0; i < count; i++) {
          const ast = sys.asteroids[Math.floor(Math.random() * sys.asteroids.length)];
          // Pick a random solid cell so the bloom lands in rock.
          for (let tries = 0; tries < 50; tries++) {
            const idx = Math.floor(Math.random() * ast.cells.length);
            if (ast.cells[idx] === MAT.EMPTY) continue;
            const x = ast.x + ((idx % ast.cols) + 0.5) * ast.cell;
            const y = ast.y + (Math.floor(idx / ast.cols) + 0.5) * ast.cell;
            paintCircle(ast, x, y, radius, MAT.FERRITE, true);
            sys.paintQueue.push({ a: ast.id, x, y, r: radius, m: MAT.FERRITE, s: 1 });
            blooms++;
            break;
          }
        }
        this.game.toastAll(`Survey: ${blooms} fresh ferrite blooms detected in ${sys.row.name}.`, sys.row.id);
        return `${blooms} blooms in ${sys.row.name}`;
      }
      case 'grantResources': {
        const grant = emptyResources();
        for (const k of RESOURCE_KINDS) grant[k] = Math.max(0, Number(p[k] ?? 0));
        for (const crew of this.game.crews.values()) this.game.deposit(crew.id, grant);
        this.game.toastAll(`Supply drop: ${RESOURCE_KINDS.map((k) => `${grant[k]} ${k}`).join(', ')}.`);
        return 'granted';
      }
    }
    return 'unknown event kind';
  }
}
