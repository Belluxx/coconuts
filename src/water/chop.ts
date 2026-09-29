import { Fn, cos, dot, float, normalize, sin, smoothstep, vec2, vec3 } from 'three/tsl';
import { seededRandom } from '../math';
import { surfaceNoise, type TSLNode } from '../shading';
import { GRAVITY, angularFrequency, seaTime } from './seaState';

/** Short waves repeat every tile (meters), so the caustics atlas can tile too. */
export const CHOP_TILE = 18;
const LATTICE = Math.PI * 2 / CHOP_TILE;

/** A light trade breeze across the lagoon's fetch drives the short waves. */
const WIND_SPEED = 3.5, FETCH = 1500;
/** The wind, and so the waves, run onshore and slightly across the bay. */
const WIND = Math.atan2(1, .3);
const BANDS = 12, PER_BAND = 4, SHORTEST = .08, LONGEST = 4;
/** Waves shorter than this answer gusts within seconds; longer ones carry the fetch's history. */
const GUSTED = Math.PI * 2 / 1.2;

export interface ChopWave { kx: number; kz: number; k: number; amplitude: number; omega: number; phase: number }

/** Fetch-limited JONSWAP frequency spectrum (m²·s). */
function jonswap(omega: number) {
  const peak = 22 * (GRAVITY ** 2 / (WIND_SPEED * FETCH)) ** (1 / 3);
  const alpha = .076 * (WIND_SPEED ** 2 / (FETCH * GRAVITY)) ** .22;
  const width = omega <= peak ? .07 : .09;
  const enhancement = 3.3 ** Math.exp(-((omega - peak) ** 2) / (2 * width ** 2 * peak ** 2));
  return alpha * GRAVITY ** 2 * omega ** -5 * Math.exp(-1.25 * (peak / omega) ** 4) * enhancement;
}

/** Direction relative to the wind with cos² spreading, at cumulative probability `p`. */
function spreadAngle(p: number) {
  let angle = (p - .5) * Math.PI;
  for (let i = 0; i < 10; i++) {
    const error = (angle + Math.PI / 2 + Math.sin(2 * angle) / 2) / Math.PI - p;
    angle -= error / Math.max((1 + Math.cos(2 * angle)) / Math.PI, .05);
    angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, angle));
  }
  return angle;
}

/**
 * Sample the spectrum in log-spaced wavenumber bands. Each band keeps its
 * exact energy, split among directions drawn from the spreading function and
 * snapped to the tile's lattice, so height and slope variances are preserved.
 */
function sampleSpectrum() {
  const random = seededRandom(90217);
  const low = Math.PI * 2 / LONGEST, high = Math.PI * 2 / SHORTEST;
  const lattice = new Map<string, { m: number; n: number; energy: number }>();
  for (let band = 0; band < BANDS; band++) {
    const k1 = low * (high / low) ** (band / BANDS), k2 = low * (high / low) ** ((band + 1) / BANDS);
    const w1 = angularFrequency(k1), w2 = angularFrequency(k2);
    let energy = 0;
    for (let i = 0; i < 64; i++) energy += jonswap(w1 + (w2 - w1) * (i + .5) / 64) * (w2 - w1) / 64;
    for (let j = 0; j < PER_BAND; j++) {
      const angle = WIND + spreadAngle((j + random()) / PER_BAND);
      const k = k1 * (k2 / k1) ** random();
      const m = Math.round(k * Math.cos(angle) / LATTICE), n = Math.round(k * Math.sin(angle) / LATTICE);
      if (m === 0 && n === 0) continue;
      // Two draws on one lattice point are one wave carrying both energies.
      const key = `${m},${n}`;
      const point = lattice.get(key) ?? { m, n, energy: 0 };
      point.energy += energy / PER_BAND;
      lattice.set(key, point);
    }
  }
  return [...lattice.values()].map(({ m, n, energy }) => {
    const k = Math.hypot(m, n) * LATTICE;
    return { kx: m * LATTICE, kz: n * LATTICE, k, amplitude: Math.sqrt(2 * energy), omega: angularFrequency(k), phase: random() * Math.PI * 2 };
  });
}

export const CHOP: ChopWave[] = sampleSpectrum();
/** Waves long enough for the caustics' photon grid to resolve their focusing. */
export const FOCUSING_CHOP = CHOP.filter(wave => wave.k <= Math.PI * 2 / .6);
/** Significant wave height of the chop. */
export const CHOP_HEIGHT = 4 * Math.sqrt(CHOP.reduce((sum, wave) => sum + wave.amplitude ** 2 / 2, 0));
/**
 * Mean square slope of capillary ripples shorter than the sampled spectrum.
 * Cox and Munk's sun-glitter measurements give the total for this wind.
 */
const CAPILLARY_SLOPES = Math.max(.003,
  .003 + .00512 * WIND_SPEED - CHOP.reduce((sum, wave) => sum + (wave.amplitude * wave.k) ** 2 / 2, 0));

/** Depth-limited breaking caps short waves in the last decimeters of water. */
export const chopLimit = (depth: TSLNode) => depth.mul(.5 / CHOP_HEIGHT).clamp(0, 1);

/** Tile-local coordinates keep phases precise far from the origin; the lattice makes this exact. */
const wrap = (xz: TSLNode) => xz.sub(xz.div(CHOP_TILE).floor().mul(CHOP_TILE));
const phaseOf = (xz: TSLNode, clock: TSLNode, wave: ChopWave) =>
  dot(xz, vec2(wave.kx, wave.kz)).sub(clock.mul(wave.omega)).add(wave.phase);

/** Height of the chop at world xz (meters). */
export const chopHeight = (xz: TSLNode, clock: TSLNode = float(seaTime), waves = CHOP) => Fn(() => {
  const local = wrap(xz).toVar();
  const height = float(0).toVar();
  for (const wave of waves) height.addAssign(sin(phaseOf(local, clock, wave)).mul(wave.amplitude));
  return height;
})();

/** Upward normal of the chop; `footprint` fades waves smaller than a pixel. */
export const chopNormal = (xz: TSLNode, clock: TSLNode = float(seaTime), waves = CHOP, footprint?: TSLNode) => Fn(() => {
  const local = wrap(xz).toVar();
  const slope = vec2(0).toVar();
  for (const wave of waves) {
    const resolved = footprint ? float(1).sub(smoothstep(.6, 1.8, footprint.mul(wave.k))) : float(1);
    slope.addAssign(vec2(wave.kx, wave.kz).mul(cos(phaseOf(local, clock, wave)).mul(wave.amplitude).mul(resolved)));
  }
  return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
})();

/**
 * Wind gusts sweep across the lagoon as darker patches of fresh ripples. The
 * pattern travels downwind; short waves grow and decay with it.
 */
export const windGust = (xz: TSLNode) => {
  const downwind = vec2(Math.cos(WIND), Math.sin(WIND));
  const broad = surfaceNoise(xz.sub(downwind.mul(seaTime.mul(2.6))).div(38));
  const fine = surfaceNoise(xz.sub(downwind.mul(seaTime.mul(3.1))).div(13).add(9));
  return float(1).add(broad.mul(.5)).add(fine.mul(.22)).clamp(.3, 1.7);
};

/**
 * Resolved chop slopes (xy) and the mean square slope of every wave this
 * pixel cannot resolve (z). Filtered slopes become microfacet roughness, so
 * the glitter pattern widens with distance instead of aliasing.
 */
export const chopSurface = (xz: TSLNode, footprint: TSLNode, gust: TSLNode) => Fn(() => {
  const local = wrap(xz).toVar();
  const slope = vec2(0).toVar();
  const unresolved = gust.mul(gust).mul(CAPILLARY_SLOPES).toVar();
  for (const wave of CHOP) {
    const amplitude = wave.k > GUSTED ? gust.mul(wave.amplitude) : float(wave.amplitude);
    const resolved = float(1).sub(smoothstep(.6, 1.8, footprint.mul(wave.k)));
    slope.addAssign(vec2(wave.kx, wave.kz).mul(cos(phaseOf(local, float(seaTime), wave)).mul(amplitude).mul(resolved)));
    unresolved.addAssign(float(1).sub(resolved.mul(resolved)).mul(amplitude.mul(wave.k).pow(2)).mul(.5));
  }
  return vec3(slope, unresolved);
})();

/** CPU height of the chop, matching `chopHeight`. */
export function sampleChopHeight(x: number, z: number, seconds: number) {
  let height = 0;
  for (const wave of CHOP) height += Math.sin(x * wave.kx + z * wave.kz - seconds * wave.omega + wave.phase) * wave.amplitude;
  return height;
}
