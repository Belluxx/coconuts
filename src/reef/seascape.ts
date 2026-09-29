import * as THREE from 'three/webgpu';
import { seabedHeight } from '../land/terrain';
import { smoothstep } from '../math';

/** Still-water level. Swimmers keep their backs below the passing troughs. */
export const SEA_LEVEL = 0;

// One-metre cells cover every reef terrace; beyond them the seabed is open sand.
const MIN_X = -150, MAX_X = 150, MIN_Z = -330, MAX_Z = 40;
const COLUMNS = MAX_X - MIN_X + 1, ROWS = MAX_Z - MIN_Z + 1;
/** Colonies read as rounded masses: full height just outside their bounds, sand again beyond this skirt. */
const SKIRT_START = .35, SKIRT_END = 1.8;

/** What a swimmer senses ahead: how far to rise over the reef, and which way to turn around it. */
export type Feeling = { climb: number; turn: number };

/**
 * The water column as animals perceive it: the sand, and the solid mass of
 * coral and stone above it. Baked once, so each question is a few array reads.
 */
export function createSeascape(obstacleBounds: readonly THREE.Box3[]) {
  const floor = new Float32Array(COLUMNS * ROWS);
  for (let row = 0; row < ROWS; row++) for (let column = 0; column < COLUMNS; column++) {
    floor[row * COLUMNS + column] = seabedHeight(MIN_X + column, MIN_Z + row);
  }
  const solid = floor.slice();
  for (const bounds of obstacleBounds) {
    const minColumn = Math.max(0, Math.floor(bounds.min.x - MIN_X - SKIRT_END));
    const maxColumn = Math.min(COLUMNS - 1, Math.ceil(bounds.max.x - MIN_X + SKIRT_END));
    const minRow = Math.max(0, Math.floor(bounds.min.z - MIN_Z - SKIRT_END));
    const maxRow = Math.min(ROWS - 1, Math.ceil(bounds.max.z - MIN_Z + SKIRT_END));
    for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
      const x = MIN_X + column, z = MIN_Z + row, index = row * COLUMNS + column;
      const outside = Math.hypot(Math.max(bounds.min.x - x, 0, x - bounds.max.x), Math.max(bounds.min.z - z, 0, z - bounds.max.z));
      const presence = 1 - smoothstep(SKIRT_START, SKIRT_END, outside);
      if (presence <= 0) continue;
      const top = floor[index] + (Math.max(floor[index], bounds.max.y + .06) - floor[index]) * presence;
      solid[index] = Math.max(solid[index], top);
    }
  }

  function sample(field: Float32Array, x: number, z: number) {
    const gx = x - MIN_X, gz = z - MIN_Z, column = Math.floor(gx), row = Math.floor(gz);
    if (column < 0 || row < 0 || column >= COLUMNS - 1 || row >= ROWS - 1) return seabedHeight(x, z);
    const index = row * COLUMNS + column, u = gx - column, v = gz - row;
    const near = field[index] + (field[index + 1] - field[index]) * u;
    const far = field[index + COLUMNS] + (field[index + COLUMNS + 1] - field[index + COLUMNS]) * u;
    return near + (far - near) * v;
  }

  const floorAt = (x: number, z: number) => sample(floor, x, z);
  const solidAt = (x: number, z: number) => sample(solid, x, z);

  /** Highest solid point under a body of the given horizontal radius. */
  function solidUnder(x: number, z: number, radius: number) {
    const r = radius * .7;
    return Math.max(solidAt(x, z), solidAt(x + r, z), solidAt(x - r, z), solidAt(x, z + r), solidAt(x, z - r));
  }

  /**
   * Feel ahead along a horizontal heading, as a fish reads pressure on its
   * lateral line. A body wanting `clearance` above the reef rises over what it
   * can; when the gap below `ceiling` is too small, it turns toward open water.
   */
  function feel(x: number, y: number, z: number, dirX: number, dirZ: number, reach: number, clearance: number, ceiling: number, out: Feeling) {
    out.climb = 0; out.turn = 0;
    let need = -Infinity;
    for (const t of [.35, .7, 1]) need = Math.max(need, solidAt(x + dirX * reach * t, z + dirZ * reach * t) + clearance);
    if (need <= y) return out;
    if (need <= ceiling) {
      out.climb = need - y;
      return out;
    }
    // No passage over the top: compare both shoulders and commit to the lower.
    const c = Math.cos(.7), s = Math.sin(.7);
    const left = solidAt(x + (dirX * c - dirZ * s) * reach, z + (dirZ * c + dirX * s) * reach);
    const right = solidAt(x + (dirX * c + dirZ * s) * reach, z + (dirZ * c - dirX * s) * reach);
    out.turn = left < right ? 1 : -1;
    out.climb = Math.max(0, Math.min(left, right) + clearance - y);
    return out;
  }

  return { floorAt, solidAt, solidUnder, feel };
}

export type Seascape = ReturnType<typeof createSeascape>;
