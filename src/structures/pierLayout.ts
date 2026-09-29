import { groundHeight } from '../land/terrain';
import { smoothstep } from '../math';

/** Meters, Y up. These dimensions build the visible geometry; collisions use that geometry. */
export const PIER = Object.freeze({
  x: -24,
  deckY: 1.59,
  width: 3.7,
  headWidth: 9,
  seaZ: -11.15,
  headLandZ: -2.6,
  rampSeaZ: 13,
  landZ: 23,
  boardThickness: .14,
  boardGap: .009,
});

const PIER_SURFACES = Object.freeze([
  Object.freeze({ left: PIER.x - PIER.width / 2, right: PIER.x + PIER.width / 2, near: PIER.seaZ, far: PIER.landZ }),
  Object.freeze({ left: PIER.x - PIER.headWidth / 2, right: PIER.x + PIER.headWidth / 2, near: PIER.seaZ, far: PIER.headLandZ }),
]);

/** Allow room for the rowboat's outboard oars beside the new rubbing strakes. */
export const PIER_ROWBOAT = Object.freeze({ x: -17, z: -7.7, yaw: -.32 });
/** Keep rowing and swimming within the rendered sea. */
export const SEA_RADIUS = 650;

/** Shared by the pavilion geometry and the sitting interaction. */
export const PIER_BENCHES = [-1, 1].map(side => Object.freeze({
  side, x: PIER.x + side * 2.03, z: -6.35, halfLength: 1.72,
  seatY: PIER.deckY + .495,
}));

export const onPier = (x: number, z: number): boolean => PIER_SURFACES.some(
  rect => x >= rect.left && x <= rect.right && z >= rect.near && z <= rect.far,
);

/** The last boards settle slightly into the sand, with zero slope at each end. */
export function pierDeckHeight(x: number, z: number): number {
  const blend = smoothstep(PIER.rampSeaZ, PIER.landZ, z);
  return PIER.deckY * (1 - blend) + (groundHeight(x, z) - .018) * blend;
}
