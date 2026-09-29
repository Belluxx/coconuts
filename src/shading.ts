import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, type Node } from 'three/webgpu';
import { cross, dFdx, dFdy, dot, max, normalView, normalize, positionView, texture, vec2, type ShaderNodeObject } from 'three/tsl';
import { latticeHash } from './math';

/** Shader-node helpers shared by the island's materials. */
export type TSLNode = ShaderNodeObject<Node>;

const PERIOD = 32, SIZE = 512;
let atlas: DataTexture | undefined;

/** Seamless gradient noise (red) and cellular distance (green), baked once with real mipmaps. */
function noiseAtlas() {
  if (atlas) return atlas;
  const data = new Uint8Array(SIZE * SIZE * 4);
  const hash = (x: number, y: number, salt: number) => latticeHash((x + PERIOD) % PERIOD, (y + PERIOD) % PERIOD, salt);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const gradient = (x: number, y: number, dx: number, dy: number) => {
    const angle = hash(x, y, 7351) * Math.PI * 2;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const px = (x + .5) * PERIOD / SIZE, py = (y + .5) * PERIOD / SIZE;
    const ix = Math.floor(px), iy = Math.floor(py), dx = px - ix, dy = py - iy;
    const u = fade(dx), v = fade(dy);
    const a = gradient(ix, iy, dx, dy) * (1 - u) + gradient(ix + 1, iy, dx - 1, dy) * u;
    const b = gradient(ix, iy + 1, dx, dy - 1) * (1 - u) + gradient(ix + 1, iy + 1, dx - 1, dy - 1) * u;
    let distance = Infinity;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const sx = ix + ox + hash(ix + ox, iy + oy, 3191) - px;
      const sy = iy + oy + hash(ix + ox, iy + oy, 8179) - py;
      distance = Math.min(distance, sx * sx + sy * sy);
    }
    const i = (y * SIZE + x) * 4;
    data[i] = Math.round(Math.max(0, Math.min(1, (a * (1 - v) + b * v) * .7 + .5)) * 255);
    data[i + 1] = Math.round(Math.min(1, Math.sqrt(distance)) * 255);
    data[i + 3] = 255;
  }
  atlas = new DataTexture(data, SIZE, SIZE, RGBAFormat);
  atlas.name = 'Island · baked surface noise';
  atlas.wrapS = atlas.wrapT = RepeatWrapping;
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;
  return atlas;
}

/** Gradient noise in [-1, 1]; one unit of `point` is one noise cell. */
export const surfaceNoise = (point: TSLNode) => texture(noiseAtlas(), point.div(PERIOD)).r.mul(2).sub(1);
/** Projects height into the texture so vertical cliffs retain surface variation. */
export const surfaceNoise3D = (point: TSLNode) => surfaceNoise(point.xz.add(point.y.mul(vec2(.73, .39))));
/** Distance to the nearest cell center, in [0, 1]. */
export const surfaceCellular = (point: TSLNode) => texture(noiseAtlas(), point.div(PERIOD)).g;

/** Perturb the view-space normal with a procedural height field (surface-gradient bump). */
export function reliefNormal(height: TSLNode) {
  const dx = dFdx(positionView), dy = dFdy(positionView);
  const r1 = cross(dy, normalView), r2 = cross(normalView, dx);
  const determinant = dot(dx, r1);
  const gradient = r1.mul(dFdx(height)).add(r2.mul(dFdy(height))).mul(determinant.sign());
  return normalize(normalView.mul(max(determinant.abs(), .0000001)).sub(gradient));
}

/**
 * Render a node's offscreen pass only while `active()`. The first update always
 * renders, so the pass's pipeline and texture are ready before they are needed.
 */
export function renderWhen(node: Node, active: () => boolean) {
  const update = node.updateBefore.bind(node);
  let prepared = false;
  node.updateBefore = frame => {
    if (prepared && !active()) return;
    prepared = true;
    update(frame);
  };
}
