import { Fn, float } from 'three/tsl';
import { smoothstep } from '../math';
import type { TSLNode } from '../shading';
import { waterfallTerrain } from './waterfallLayout';

/** The waterline curves around the bay: z of the shore at a given x. */
export const shoreZ = (x: number) => 22 - 0.011 * x * x;
/** Shader version of `z - shoreZ(x)`: signed distance from the waterline, positive inland. */
export const coastDistance = Fn(([xz]: [TSLNode]) => xz.y.sub(float(22).sub(xz.x.mul(xz.x).mul(.011))));

/** Smooth, deterministic low-frequency terrain noise, independent of draw order. */
export function terrainNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const hash = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const tx = x - ix, tz = z - iz, u = tx * tx * (3 - 2 * tx), v = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz) * (1 - u) + hash(ix + 1, iz) * u;
  const b = hash(ix, iz + 1) * (1 - u) + hash(ix + 1, iz + 1) * u;
  return (a * (1 - v) + b * v) * 2 - 1;
}

/** Centimeter-scale drifts; the same surface supports feet, stones and plants. */
function beachRelief(x: number, z: number): number {
  const d = z - shoreZ(x);
  const dry = smoothstep(0, 3, d) * (1 - smoothstep(12, 22, d));
  const drift = terrainNoise(x * .19, z * .23) * .072;
  const settling = terrainNoise(x * .83 + 41, z * .71 - 9) * .013;
  return (drift + settling) * dry;
}

/** The island's landform before the waterfall carved it. */
export function baseGround(x: number, z: number): number {
  const d = z - shoreZ(x);
  const beach = -1.25 + smoothstep(-10, 5, d) * 2.2 + Math.max(0, d - 5) * 0.024;
  const g = (cx: number, cz: number, sx: number, sz: number, h: number) => Math.exp(-(((x-cx)/sx)**2 + ((z-cz)/sz)**2)) * h;
  const hills = g(73, 21, 25, 31, 37) + g(51, 35, 22, 27, 20) + g(94, -5, 21, 32, 23) + g(-76, 0, 23, 32, 19) + g(-45, 62, 45, 25, 12);
  return beach + beachRelief(x, z) + hills * smoothstep(9, 32, d) + Math.sin(x*.24)*Math.sin(z*.2)*.35*smoothstep(7,25,d);
}

/** Height of dry land and the wadeable beach, including the waterfall's gorge and streams. */
export const groundHeight = (x: number, z: number) => waterfallTerrain(x, z, baseGround(x, z));

/** Wadeable sand gives way to reef shelves, gullies, and a blue-water drop-off. */
export function seabedHeight(x: number, z: number): number {
  const offshore = Math.max(0, shoreZ(x) - z - 9);
  // Keep the walking shoreline intact. Broad, rounded terraces make a real
  // vertical water column while retaining an unbroken approach from the sand.
  const slope = .052 * (offshore - 8 * (1 - Math.exp(-offshore / 8)));
  const terraces = smoothstep(1, 20, offshore) * 2.5
    + smoothstep(22, 52, offshore) * 3.8
    + smoothstep(52, 90, offshore) * 4.4;
  const reefRelief = (terrainNoise(x * .095, z * .105) * .42
    + terrainNoise(x * .23 + 8, z * .19) * .13) * smoothstep(8, 21, offshore);
  return groundHeight(x, z) - slope - terraces + reefRelief;
}
