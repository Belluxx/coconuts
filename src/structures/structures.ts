import type * as THREE from 'three/webgpu';
import type { IslandCollisions } from '../player/collisions';
import { createBoardwalks } from './boardwalk';
import { createBoats } from './boats';
import { createBungalow } from './bungalow';
import { createPier } from './pier';
import { PIER_ROWBOAT } from './pierLayout';
import { createTimberMaterials } from './timber';

/** Everything built by hand: the jetty, bungalow, boardwalks with their torches, and the boats. */
export function createStructures(scene: THREE.Scene, collisions: IslandCollisions) {
  const timber = createTimberMaterials();
  const pier = createPier(timber, collisions);
  const boardwalks = createBoardwalks(timber, collisions);
  const bungalow = createBungalow(timber, collisions);
  const { rowboat, oars, yacht } = createBoats();
  rowboat.position.set(PIER_ROWBOAT.x, .16, PIER_ROWBOAT.z);
  rowboat.rotation.y = PIER_ROWBOAT.yaw;
  scene.add(pier.root, boardwalks.root, bungalow, rowboat, yacht);
  return {
    rowboat, oars, yacht,
    mooring: pier.mooring,
    /** Flicker the torches, brighter as the light fades. */
    update: boardwalks.update,
  };
}
