import { shoreZ } from '../land/terrain';
import { seededRandom } from '../math';

const HABITAT_SEED = 720418;
const OFFSHORE_TERRACES = [79, 112, 148, 187];
const OFFSHORE_LANES = [-91, -60, -29, 29, 60, 91];
const REEF_SEPARATION = 6;

/** Shared habitat layout for scenery and wildlife. All distances are in meters. */
export type MarineHabitat = Readonly<{
  id: string;
  seed: number;
  x: number;
  z: number;
  /** Signed distance from the shore; negative values are offshore. */
  d: number;
  rx: number;
  rz: number;
  /** Relative density used when sampling decorative details. */
  weight: number;
  kind: 'reef' | 'grass' | 'rubble';
  zone: 'lagoon' | 'shelf' | 'outer';
}>;

function generateHabitats(): readonly MarineHabitat[] {
  const random = seededRandom(HABITAT_SEED);
  const habitats: MarineHabitat[] = [];
  const add = (x: number, d: number, rx: number, rz: number, kind: MarineHabitat['kind']) => {
    const z = shoreZ(x) + d;
    const zone = d > -60 ? 'lagoon' : d > -125 ? 'shelf' : 'outer';
    const id = `${kind}-${habitats.length}`;
    habitats.push(Object.freeze({
      id,
      seed: HABITAT_SEED + habitats.length * 7919,
      x, z, d, rx, rz,
      weight: kind === 'reef' ? rx * rz : rx * rz * .65,
      kind,
      zone,
    }));
  };
  // These first gardens invite exploration from the beach and pier. The center
  // remains a sandy approach; a 12 m wide channel continues offshore.
  add(17, -25, 8.8, 7.4, 'reef');
  add(-27, -27, 8.5, 7.2, 'reef');
  add(42, -38, 8.6, 7.5, 'reef');
  add(-36, -50, 8.8, 7.8, 'reef');
  add(24, -51, 9.1, 7.8, 'reef');
  add(-14, -13, 5.1, 3.8, 'grass');
  add(-7, -31, 4.1, 6.1, 'grass');
  add(34, -17, 4.9, 3.6, 'rubble');
  add(-46, -30, 4.7, 4.2, 'rubble');
  // Jittered, separated reef islands extend across four offshore terraces.
  // Their positions are shared with wildlife rather than independently guessed.
  for (const offshore of OFFSHORE_TERRACES) for (const lane of OFFSHORE_LANES) {
    const x = lane + (random() - .5) * 7;
    const d = -offshore + (random() - .5) * 8;
    const rx = 8.2 + random() * 2.9, rz = 7.3 + random() * 2.5;
    const z = shoreZ(x) + d;
    const overlapsReef = habitats.some(habitat => habitat.kind === 'reef'
      && Math.hypot(x - habitat.x, z - habitat.z) < Math.max(rx, rz) + Math.max(habitat.rx, habitat.rz) + REEF_SEPARATION);
    if (overlapsReef) continue;
    add(x, d, rx, rz, 'reef');
    if (offshore < 125 && Math.abs(lane) < 70) {
      add(x + (x < 0 ? -12 : 12), d + 1, 3.7, 4.3, 'rubble');
    }
  }
  return Object.freeze(habitats);
}

export const MARINE_HABITATS = generateHabitats();
export const REEF_HABITATS = Object.freeze(MARINE_HABITATS.filter(habitat => habitat.kind === 'reef'));

/** True when a footprint clears the reserved, gently winding sandy channel. */
export function marineChannelClear(x: number, z: number, radius = 0): boolean {
  const offshore = shoreZ(x) - z;
  if (offshore < 40) return true;
  const center = Math.sin(offshore * .031) * 4;
  return Math.abs(x - center) > 6 + radius;
}
