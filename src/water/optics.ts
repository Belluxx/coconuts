import { MathUtils, type Vector3 } from 'three/webgpu';
import { exp, float, vec3 } from 'three/tsl';
import type { TSLNode } from '../shading';

export const WATER_IOR = 1.333;

/** All visual effects cross the moving interface within the same two centimeters. */
export const waterImmersion = (depth: number) => MathUtils.smoothstep(depth, -.01, .01);

/** Follow the local wave near the eye, then settle to mean sea level at depth. */
export const waterViewHeight = (surfaceHeight: number, depth: number) =>
  surfaceHeight * (1 - MathUtils.smoothstep(Math.abs(depth), .12, .65));

/*
 * Inherent optical properties of clear lagoon water (1/m) for the red, green
 * and blue primaries (about 600, 540 and 460 nm). Every view and light path,
 * above and below the surface, derives from these few numbers.
 */
/** Pure water (Pope and Fry) plus a trace of dissolved organic matter. */
const ABSORPTION = [.30, .06, .022];
/** Pure seawater (Morel): density fluctuations scatter almost isotropically. */
const MOLECULAR = [.0013, .0021, .0041];
/** Fine suspended carbonate: scattering falls as 1/λ, sharply forward. */
const PARTICLE = [.060, .070, .086];
const PARTICLE_ASYMMETRY = .924;
/** Of particle scattering, only this share is thrown backward (Petzold). */
const PARTICLE_BACKSCATTER = .017;
/**
 * δ-scaling: the forward peak (g² of particle scattering) stays in the beam.
 * Light keeps its energy through it; images lose their sharpness to it.
 */
const FORWARD_PEAK = PARTICLE_ASYMMETRY ** 2;
const TRUNCATED_ASYMMETRY = (PARTICLE_ASYMMETRY - FORWARD_PEAK) / (1 - FORWARD_PEAK);
/** Downwelling light is diffuse: on average it travels 1/0.8 m per meter of depth. */
const MEAN_COSINE = .8;
/** Diffuse attenuation of downwelling irradiance (quasi-single-scattering). */
const DIFFUSE = ABSORPTION.map((a, i) => (a + MOLECULAR[i] * .5 + PARTICLE[i] * PARTICLE_BACKSCATTER) / MEAN_COSINE);

const rgb = (f: (i: number) => number) => vec3(f(0), f(1), f(2));
export const waterAbsorption = rgb(i => ABSORPTION[i]);
/** Beam extinction: what an image loses along a view path. */
export const waterExtinction = rgb(i => ABSORPTION[i] + MOLECULAR[i] + PARTICLE[i]);
/** Scattering that redirects light out of its beam (δ-scaled). */
export const waterScattering = rgb(i => MOLECULAR[i] + PARTICLE[i] * (1 - FORWARD_PEAK));
/** Extinction of light energy traveling as a beam (δ-scaled). */
export const lightExtinction = rgb(i => ABSORPTION[i] + MOLECULAR[i] + PARTICLE[i] * (1 - FORWARD_PEAK));
export const waterBackscattering = rgb(i => MOLECULAR[i] * .5 + PARTICLE[i] * PARTICLE_BACKSCATTER);
export const diffuseAttenuation = rgb(i => DIFFUSE[i]);

/** Photopic luminance of the downwelling daylight left at a depth, relative to the surface. */
export function daylightRemaining(depth: number) {
  return [.2126, .7152, .0722].reduce((sum, weight, i) => sum + weight * Math.exp(-DIFFUSE[i] * Math.max(depth, 0)), 0);
}

/** Image transmission along a view path. */
export const waterTransmission = (distance: TSLNode) => exp(waterExtinction.mul(distance).negate());
/** Transmission of a sunbeam's energy along its refracted path. */
export const beamTransmission = (distance: TSLNode) => exp(lightExtinction.mul(distance).negate());
/** Downwelling skylight remaining at a depth. */
export const diffuseTransmission = (depth: TSLNode) => exp(diffuseAttenuation.mul(depth).negate());
/** Fraction of a beam no particle has deflected yet: caustic filaments survive only in it. */
export const unscatteredFraction = (distance: TSLNode) => exp(float(-(PARTICLE[1] + MOLECULAR[1])).mul(distance));

/**
 * Normalized scattering phase function (1/sr) of the water at the angle whose
 * cosine is given: Rayleigh-like molecular scattering plus the particles'
 * truncated Henyey–Greenstein lobe. `spread` (0–1) broadens it for light that
 * arrives from a wide cone instead of one direction.
 */
export function waterPhase(cosine: TSLNode, spread = 0) {
  const g = TRUNCATED_ASYMMETRY * (1 - spread);
  const lobe = float(1 - g * g).div(float(1 + g * g).sub(cosine.mul(2 * g)).max(1e-4).pow(1.5)).mul(1 / (4 * Math.PI));
  const rayleigh = cosine.mul(cosine).mul(1 - spread).add(1 + spread).mul(3 / (16 * Math.PI));
  const molecular = rgb(i => MOLECULAR[i] / (MOLECULAR[i] + PARTICLE[i] * (1 - FORWARD_PEAK)));
  return vec3(rayleigh).mul(molecular).add(vec3(lobe).mul(vec3(1).sub(molecular)));
}

/**
 * Diffuse reflectance of an optically deep water body with extra backscatter
 * (bubbles): Kubelka–Munk, matched to Morel's 0.33·b_b/a for clear water.
 */
export function bodyReflectance(extraBackscatter: TSLNode = float(0)) {
  const absorption = waterAbsorption.max(.012);
  const ratio = absorption.mul(1.5).div(waterBackscattering.add(extraBackscatter));
  return ratio.add(1).sub(ratio.mul(ratio).add(ratio.mul(2)).sqrt());
}

/** Unpolarized Fresnel reflectance at an air–water interface; `cosine` is measured in air. */
export function fresnelReflectance(cosine: number) {
  const c = Math.max(cosine, 0), g = Math.sqrt(WATER_IOR ** 2 - 1 + c * c);
  const s = (g - c) / (g + c), p = (c * (g + c) - 1) / (c * (g - c) + 1);
  return .5 * s * s * (1 + p * p);
}

/** Shader counterpart of `fresnelReflectance`. */
export function fresnel(cosine: TSLNode) {
  const c = cosine.max(1e-4), g = c.mul(c).add(WATER_IOR ** 2 - 1).sqrt();
  const s = g.sub(c).div(g.add(c));
  const p = c.mul(g.add(c)).sub(1).div(c.mul(g.sub(c)).add(1));
  return s.mul(s).mul(p.mul(p).add(1)).mul(.5);
}

/** Direction toward a light source as seen below a flat surface (Snell's law); always points up. */
export function underwaterLightDirection(direction: Vector3, target: Vector3) {
  const lateral = 1 / WATER_IOR;
  return target.set(direction.x * lateral, Math.sqrt(1 - (1 - direction.y ** 2) * lateral ** 2), direction.z * lateral);
}

/** Fresnel transmission of light arriving from `elevation` (sine) across a flat air/water boundary. */
export const surfaceTransmission = (elevation: number) => 1 - fresnelReflectance(elevation);
