import * as THREE from 'three/webgpu';
import { Fn, float, sin, smoothstep, texture, vec2 } from 'three/tsl';
import { coastDistance, seabedHeight, shoreZ } from '../land/terrain';
import { DEG, smoothstep as smooth } from '../math';
import type { TSLNode } from '../shading';
import { dispersion, seaTime } from './seaState';

/** Where the numerical surf takes over from linear waves, in meters from the shoreline. */
export const SURF_START = -60;

/**
 * Swell that has crossed the barrier reef: a narrow band of long waves with a
 * little directional spread, so crests arrive in sets and vary along the
 * beach. Amplitudes are at the surf boundary; `angle` is from shore-normal.
 */
const SWELL = [
  { period: 10.2, amplitude: .028, angle: -6, phase: .4 },
  { period: 8.6, amplitude: .038, angle: 4, phase: 2.1 },
  { period: 7.3, amplitude: .042, angle: -2, phase: 4.7 },
  { period: 6.2, amplitude: .034, angle: 7, phase: 1.3 },
  { period: 5.2, amplitude: .024, angle: -9, phase: 5.6 },
  { period: 4.4, amplitude: .016, angle: 3, phase: 3.2 },
] as const;

const PROFILE_START = -2200, PROFILE_END = SURF_START + 20;
const PROFILE_SIZE = PROFILE_END - PROFILE_START + 1;
const depthAt = (u: number) => Math.max(.3, -seabedHeight(0, shoreZ(0) + Math.min(u, PROFILE_END)));

/**
 * Contours run parallel to the coast, so each wave keeps its alongshore
 * wavenumber (Snell's law) while the cross-shore one follows the local depth.
 * Integrating it keeps phase continuous over the shelf; conserving the
 * cross-shore energy flux gives shoaling and refraction together.
 */
const boundary = depthAt(SURF_START);
const waves = SWELL.map(wave => {
  const omega = Math.PI * 2 / wave.period;
  const { k } = dispersion(omega, boundary);
  return { ...wave, omega, alongshore: k * Math.sin(wave.angle * DEG) };
});
const crossShore = (wave: typeof waves[number], u: number) => {
  const { k, group } = dispersion(wave.omega, depthAt(u));
  const across = Math.sqrt(Math.max(k * k - wave.alongshore ** 2, 1e-6));
  return { across, flux: group * across / k };
};
const profile = new Float32Array(PROFILE_SIZE * 4 * 4);
for (let index = 0; index < waves.length; index++) {
  const wave = waves[index], channel = index % 4, row = Math.floor(index / 4);
  const origin = SURF_START - PROFILE_START;
  const reference = crossShore(wave, SURF_START).flux;
  const set = (i: number, phase: number, flux: number) => {
    profile[(row * PROFILE_SIZE + i) * 4 + channel] = phase;
    profile[((row + 2) * PROFILE_SIZE + i) * 4 + channel] = Math.sqrt(reference / flux);
  };
  for (const direction of [-1, 1]) {
    let phase = 0, previous = crossShore(wave, SURF_START).across;
    for (let i = origin; i >= 0 && i < PROFILE_SIZE; i += direction) {
      const local = crossShore(wave, PROFILE_START + i);
      if (i !== origin) phase += direction * (local.across + previous) * .5;
      set(i, phase, local.flux);
      previous = local.across;
    }
  }
}

let profileTexture: THREE.DataTexture | undefined;
function profileMap() {
  if (!profileTexture) {
    profileTexture = new THREE.DataTexture(profile, PROFILE_SIZE, 4, THREE.RGBAFormat, THREE.FloatType);
    profileTexture.name = 'Swell · refracted phase and shoaling over the shelf';
    profileTexture.minFilter = profileTexture.magFilter = THREE.LinearFilter;
    profileTexture.needsUpdate = true;
  }
  return profileTexture;
}

/** Cross-shore coordinate: follows the curved bay near shore, straightens offshore. */
function swellCoordinate(x: number, z: number) {
  const d = z - shoreZ(x);
  return d - .011 * x * x * smooth(80, 500, -d);
}

/** Linear swell elevation at world xz. */
export const swellHeight = Fn(([xz]: [TSLNode]) => {
  const d = coastDistance(xz);
  const u = d.sub(xz.x.mul(xz.x).mul(.011).mul(smoothstep(80, 500, d.negate())));
  const column = u.sub(PROFILE_START).add(.5).div(PROFILE_SIZE).clamp(.5 / PROFILE_SIZE, 1 - .5 / PROFILE_SIZE);
  const rows = [0, 1, 2, 3].map(row => texture(profileMap(), vec2(column, (row + .5) / 4)).level(float(0)));
  const height = float(0).toVar();
  waves.forEach((wave, index) => {
    const channel = (['r', 'g', 'b', 'a'] as const)[index % 4], row = Math.floor(index / 4);
    const phase = seaTime.mul(wave.omega).sub(xz.x.mul(wave.alongshore)).sub(rows[row][channel]).add(wave.phase);
    height.addAssign(sin(phase).mul(rows[row + 2][channel]).mul(wave.amplitude));
  });
  return height;
});

/** CPU counterpart of `swellHeight`. */
export function sampleSwell(x: number, z: number, seconds: number) {
  const cell = Math.max(0, Math.min(PROFILE_SIZE - 1.001, swellCoordinate(x, z) - PROFILE_START));
  const i = Math.floor(cell), t = cell - i;
  let height = 0;
  waves.forEach((wave, index) => {
    const channel = index % 4, row = Math.floor(index / 4);
    const at = (r: number) => (r * PROFILE_SIZE + i) * 4 + channel;
    const phase = profile[at(row)] * (1 - t) + profile[at(row) + 4] * t;
    const amplitude = profile[at(row + 2)] * (1 - t) + profile[at(row + 2) + 4] * t;
    height += Math.sin(seconds * wave.omega - x * wave.alongshore - phase + wave.phase) * amplitude * wave.amplitude;
  });
  return height;
}

/** Incoming elevation at the surf boundary of the transect at `x`. */
export function swellForcing(x: number, seconds: number) {
  let height = 0;
  for (const wave of waves) height += Math.sin(seconds * wave.omega - x * wave.alongshore + wave.phase) * wave.amplitude;
  return height;
}
