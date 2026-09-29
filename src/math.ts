import { Vector3 } from 'three/webgpu';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);

/** GLSL-style smoothstep: edges first, then the value. */
export function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Deterministic generator (mulberry32): the same seed always grows the same island. */
export function seededRandom(seed: number) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash in [0, 1]; the salt selects an independent value per cell. */
export function latticeHash(x: number, y: number, salt: number) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ salt;
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967295;
}
