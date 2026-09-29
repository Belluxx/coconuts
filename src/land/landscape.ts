import * as THREE from 'three/webgpu';
import type { IslandCollisions } from '../player/collisions';
import type { QualitySettings } from '../quality';
import type { EnvironmentMap } from '../sky/environmentMap';
import type { CausticsField } from '../water/caustics';
import type { RefractionCapture } from '../water/refraction';
import { createBirds } from './birds';
import { createGround } from './ground';
import { createRocks } from './rocks';
import { createVegetation } from './vegetation';
import { createWaterfall } from './waterfall';

/** The island itself: ground, rocks, vegetation, the waterfall, and the terns that roost there. */
export function createLandscape(
  scene: THREE.Scene, caustics: CausticsField, refraction: RefractionCapture, environmentMap: EnvironmentMap, collisions: IslandCollisions,
) {
  const root = new THREE.Group();
  root.name = 'Island · landscape';
  const ground = createGround(caustics);
  const rocks = createRocks(collisions);
  const vegetation = createVegetation(collisions);
  root.add(ground.root, rocks.root, vegetation.root);
  // Nothing here moves: skip per-frame matrix updates.
  root.traverse(object => { object.updateMatrix(); object.matrixAutoUpdate = false; });
  const waterfall = createWaterfall(caustics, refraction, environmentMap, collisions);
  const birds = createBirds(vegetation.plants, rocks);
  scene.add(root, waterfall.root, birds.root);
  return {
    waterfall,
    /** Apply a preset's vegetation detail immediately, before its shaders are prepared. */
    setQuality(quality: QualitySettings, player: THREE.Vector3) {
      vegetation.update(0, player, quality);
    },
    update(dt: number, seconds: number, player: THREE.Vector3, quality: QualitySettings, daylight: number, motion: boolean) {
      vegetation.update(dt, player, quality);
      birds.update(seconds, player, motion, daylight);
    },
  };
}
