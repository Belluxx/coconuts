import { exp, float, mix, smoothstep } from 'three/tsl';
import type { TSLNode } from '../shading';
import { WATER_IOR } from '../water/optics';
import { CAPILLARY_ALPHA, CAPILLARY_N, surfCoverage, surfFoam, surfWater, waterTable } from '../water/surf';
import { foamLace } from '../water/foam';

/** Water filling the pores lowers each grain's index contrast from 1.55/1.0 to 1.55/1.33: far less scattering. */
const WET_SCATTERING = .35;
/** Diffuse light reflected back down at a water surface from below: 1 − (1 − 0.066)/n². */
const INTERNAL_REFLECTANCE = 1 - (1 - .066) / WATER_IOR ** 2;

/**
 * Darkening of wet sand (Lekner and Dorf). Kubelka–Munk recovers the grains'
 * absorption-to-scattering ratio from the dry albedo; pore water reduces the
 * scattering, so light travels deeper among the grains and more is absorbed.
 * A water surface over them then traps light, returning part of it again.
 * Both effects grow with every bounce: wet sand is darker and more saturated.
 */
export function wetAlbedo(albedo: TSLNode, poreWater: TSLNode, trapping: TSLNode) {
  const dry = albedo.clamp(.02, .98);
  const ratio = float(1).sub(dry).pow(2).div(dry.mul(2)).div(mix(float(1), float(WET_SCATTERING), poreWater));
  const soaked = ratio.add(1).sub(ratio.mul(ratio).add(ratio.mul(2)).sqrt());
  const trapped = soaked.mul(1 - INTERNAL_REFLECTANCE).div(float(1).sub(soaked.mul(INTERNAL_REFLECTANCE)));
  return mix(soaked, trapped, trapping);
}

/** Shader counterpart of `capillarySaturation`: surface saturation at a height above the water table. */
const capillary = (height: TSLNode) =>
  float(1).add(height.max(0).mul(CAPILLARY_ALPHA).pow(CAPILLARY_N)).pow(1 / CAPILLARY_N - 1);

/**
 * Water in and on the beach at a world point: pore saturation from the surf
 * simulation (soaked by swash, draining toward capillary equilibrium above
 * the water table), the free film left by the backwash, whether the sea
 * covers it, and foam stranded on the sand.
 */
export function beachWater(xz: TSLNode, height: TSLNode) {
  const inside = surfCoverage(xz);
  const water = surfWater(xz), foam = surfFoam(xz);
  const saturation = mix(capillary(height.sub(waterTable)), water.w.max(capillary(height.sub(waterTable))), inside);
  // Most darkening comes with the first water: menisci form around every grain contact.
  const poreWater = float(1).sub(exp(saturation.mul(-3))).div(1 - Math.exp(-3));
  const depth = mix(float(1).sub(smoothstep(-.18, .03, height)).mul(.1), water.z, inside);
  // The sea's own surface takes over where it covers more than a few millimeters.
  const covered = smoothstep(.002, .008, depth);
  // A film thicker than the grains' relief is a smooth mirror; thinner, it beads.
  const film = smoothstep(.00005, .0006, depth).max(smoothstep(.97, 1, saturation).mul(.45)).mul(float(1).sub(covered));
  const filmRoughness = mix(float(.3), float(.04), smoothstep(.0002, .002, depth));
  const stranded = foamLace(xz, foam).mul(inside).mul(float(1).sub(covered));
  return { saturation, poreWater, covered, film, filmRoughness, stranded };
}
