import * as THREE from 'three/webgpu';
import { float, smoothstep, texture, vec2 } from 'three/tsl';
import { coastDistance, seabedHeight, shoreZ } from '../land/terrain';
import type { TSLNode } from '../shading';

const START = -700, END = 10, SIZE = END - START + 1;
let map: THREE.DataTexture | undefined;

/**
 * Still-water depth of the seabed, from the bay's cross-shore profile. The
 * terraces follow the coast, so one profile describes the whole lagoon.
 * Beyond the island's flanks the sea is open and deep.
 */
export function seabedDepth(xz: TSLNode) {
  if (!map) {
    const data = new Float32Array(SIZE);
    for (let i = 0; i < SIZE; i++) data[i] = Math.max(0, -seabedHeight(0, shoreZ(0) + START + i));
    map = new THREE.DataTexture(data, SIZE, 1, THREE.RedFormat, THREE.FloatType);
    map.name = 'Lagoon · cross-shore seabed depth';
    map.minFilter = map.magFilter = THREE.LinearFilter;
    map.needsUpdate = true;
  }
  const u = coastDistance(xz).sub(START).add(.5).div(SIZE).clamp(.5 / SIZE, 1 - .5 / SIZE);
  return texture(map, vec2(u, .5)).level(float(0)).r.max(smoothstep(165, 185, xz.x.abs()).mul(40));
}
