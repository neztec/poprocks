export const MAT = {
  EMPTY: 0,
  CRUST: 1,
  ROCK: 2,
  DEEP: 3,
  FERRITE: 4,
  AURIC: 5,
} as const;

export type ResourceKind = 'ferrite' | 'auric';
export const RESOURCE_KINDS: ResourceKind[] = ['ferrite', 'auric'];

export interface MaterialDef {
  name: string;
  /** RGB used by the terrain renderer */
  color: [number, number, number];
  /** multiplier on drill time; higher = slower */
  hardness: number;
  yields: ResourceKind | null;
}

export const MATERIALS: MaterialDef[] = [
  { name: 'empty', color: [0, 0, 0], hardness: 0, yields: null },
  { name: 'crust', color: [138, 143, 158], hardness: 1.4, yields: null },
  { name: 'rock', color: [92, 97, 114], hardness: 1.0, yields: null },
  { name: 'deep rock', color: [58, 61, 78], hardness: 1.8, yields: null },
  { name: 'ferrite', color: [201, 119, 58], hardness: 1.2, yields: 'ferrite' },
  { name: 'auric', color: [232, 197, 71], hardness: 2.2, yields: 'auric' },
];

export type Resources = Record<ResourceKind, number>;

export function emptyResources(): Resources {
  return { ferrite: 0, auric: 0 };
}

export function totalResources(r: Resources): number {
  let n = 0;
  for (const k of RESOURCE_KINDS) n += r[k];
  return n;
}
