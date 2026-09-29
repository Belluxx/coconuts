import { float, mix, smoothstep, vec2 } from 'three/tsl';
import { coastDistance } from '../land/terrain';
import { surfaceCellular, surfaceNoise, type TSLNode } from '../shading';
import { foamMarkers } from './surf';

/**
 * Foam rafts covering the fraction `state.x` of the surface. Bubbles gather
 * at the edges of small convection cells, so partial cover forms a lace of
 * filaments around clear holes, and the holes close as cover approaches one.
 * `state` is `surfFoam`: its markers carry the pattern with the water.
 */
export function foamLace(xz: TSLNode, state: TSLNode) {
  const d = coastDistance(xz);
  const layer = (marker: TSLNode) => {
    const p = vec2(xz.x, xz.y.add(marker.sub(d)));
    const warped = p.add(vec2(surfaceNoise(p.mul(.9)), surfaceNoise(p.mul(.8).add(17))).mul(.35));
    const cells = surfaceCellular(warped.mul(2.2));
    const clusters = surfaceCellular(warped.mul(9).add(5));
    return cells.mul(.75).add(clusters.mul(.25)).add(surfaceNoise(warped.mul(5)).mul(.12));
  };
  const pattern = mix(layer(state.w), layer(state.z), foamMarkers);
  const threshold = float(1).sub(state.x.clamp(0, 1).mul(1.1));
  return smoothstep(threshold, threshold.add(.1), pattern);
}
