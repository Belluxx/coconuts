import { Fn, float, mix, smoothstep, vec2 } from 'three/tsl';
import { coastDistance, seabedHeight, shoreZ } from '../land/terrain';
import { smoothstep as smooth } from '../math';
import type { TSLNode } from '../shading';
import { seabedDepth } from './bathymetry';
import { chopHeight, chopLimit, CHOP_HEIGHT, sampleChopHeight } from './chop';
import { seaTime } from './seaState';
import { SURF_END, surf, surfCoverage, surfWater, type SurfSample } from './surf';
import { SURF_START, sampleSwell, swellHeight } from './swell';

/** Where linear swell hands over to the simulated surf. */
const HANDOVER = [SURF_START + 4, SURF_START + 14] as const;

/**
 * Long waves at world xz: the refracted swell offshore, the simulated surf
 * near shore. Returns the surface elevation (x) and the water depth below it (y).
 */
export const longWaves = Fn(([xz]: [TSLNode]) => {
  const water = surfWater(xz);
  const simulated = smoothstep(HANDOVER[0], HANDOVER[1], coastDistance(xz)).mul(surfCoverage(xz));
  const elevation = mix(swellHeight(xz), water.x, simulated);
  return vec2(elevation, mix(seabedDepth(xz), water.z, simulated));
});

/**
 * Rendered surface height: long waves plus depth-limited chop. `chop` and
 * `swell` fade distant detail. Over dry sand the surface rests on the bed and
 * moves continuously as the swash comes and goes; the material hides it there.
 */
export const seaSurfaceHeight = (xz: TSLNode, chop: TSLNode = float(1), swell: TSLNode = float(1)) => {
  const long = longWaves(xz).toVar();
  return long.x.mul(swell).add(chopHeight(xz, float(seaTime)).mul(chopLimit(long.y)).mul(chop));
};

const sample: SurfSample = { elevation: 0, velocity: 0, depth: 0, foam: 0, air: 0 };

/** Water height at a point, matching the rendered surface. */
export function sampleSeaSurface(x: number, z: number) {
  const waves = surf(), d = z - shoreZ(x);
  const coverage = (1 - Math.min(1, Math.max(0, (Math.abs(x) - 160) / 12))) * (1 - Math.min(1, Math.max(0, d - SURF_END + 1)));
  const simulated = smooth(HANDOVER[0], HANDOVER[1], d) * coverage;
  waves.sample(x, d, sample);
  const elevation = sampleSwell(x, z, waves.time) * (1 - simulated) + sample.elevation * simulated;
  const open = Math.max(-seabedHeight(0, shoreZ(0) + Math.max(-700, Math.min(10, d))), smooth(165, 185, Math.abs(x)) * 40);
  const depth = open * (1 - simulated) + sample.depth * simulated;
  return elevation + sampleChopHeight(x, z, waves.time) * Math.min(1, Math.max(0, depth * .5 / CHOP_HEIGHT));
}
