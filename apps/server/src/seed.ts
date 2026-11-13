import { mulberry32 } from '@poprock/shared';
import type { Store, SystemDef } from './db';

const STAR_MASS = 4_000_000;

interface SeedSystem {
  name: string;
  gx: number;
  gy: number;
  color: string;
}

const OTHERS: SeedSystem[] = [
  { name: 'Kessler Reach', gx: 6000, gy: -4000, color: '#ff9a5a' },
  { name: 'Thule Drift', gx: -7000, gy: -6000, color: '#8ad4ff' },
  { name: 'Marrow', gx: 11000, gy: 5000, color: '#ff5a7a' },
  { name: 'Cinder Gate', gx: -4000, gy: 9000, color: '#ffd25a' },
  { name: 'Ostrava', gx: 15000, gy: -9000, color: '#b48aff' },
  { name: 'Halcyon', gx: 2000, gy: 14000, color: '#7affc4' },
  { name: 'Brine', gx: -13000, gy: 3000, color: '#5ab4ff' },
];

/** Default content for a brand-new system: a star, a parking spot, one asteroid. */
export function defaultSystemDef(): SystemDef {
  return {
    bodies: [{ x: 0, y: 0, radius: 220, mass: STAR_MASS }],
    park: { x: -1400, y: 1400 },
    critters: 14,
  };
}

export function seedGalaxy(store: Store): void {
  const homeId = store.insertSystem({
    name: 'Vesta (Home)',
    gx: 0,
    gy: 0,
    color: '#ffe9a8',
    def: {
      bodies: [
        { x: 0, y: 0, radius: 260, mass: STAR_MASS },
        { x: 2600, y: 2600, radius: 90, mass: 1_500_000 },
      ],
      park: { x: -1400, y: 1400 },
      critters: 18,
    },
  });
  store.insertAsteroid({ systemId: homeId, name: 'Vesta Major', x: -5200, y: 0, radius: 3000, seed: 1001 });
  store.insertAsteroid({ systemId: homeId, name: 'Vesta Minor', x: 4200, y: -3400, radius: 1800, seed: 1002 });

  const rand = mulberry32(7);
  for (const s of OTHERS) {
    const id = store.insertSystem({ ...s, def: defaultSystemDef() });
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + rand();
      const radius = 1200 + Math.floor(rand() * 1600);
      const dist = 3200 + radius;
      store.insertAsteroid({
        systemId: id,
        name: `${s.name} ${String.fromCharCode(65 + i)}`,
        x: Math.round(Math.cos(ang) * dist),
        y: Math.round(Math.sin(ang) * dist),
        radius,
        seed: Math.floor(rand() * 1e9),
      });
    }
  }

  store.insertEvent({
    name: 'Welcome broadcast',
    kind: 'broadcast',
    params: { message: 'Home control: drillers are cleared for Vesta Major. Watch for glimmers in the tunnels.' },
    delaySec: 20,
    repeatSec: 0,
    enabled: true,
  });
  store.insertEvent({
    name: 'Ore bloom (home)',
    kind: 'oreBloom',
    params: { systemId: homeId, count: 3, radius: 120 },
    delaySec: 120,
    repeatSec: 300,
    enabled: true,
  });
}
