import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { V, seededRandom } from '../math';
import type { IslandCollisions } from '../player/collisions';

const X = V(1, 0, 0);

interface BuilderOptions {
  /** Seeds `random()` and the per-part grain offset and tint. */
  seed?: number;
  /** Solid parts are also added to the walking and swimming collisions. */
  collisions?: IslandCollisions;
  /** Applied to every part, e.g. a building's position and heading. */
  placement?: THREE.Matrix4;
  /** Rounded-box bevel segments; small craft use 2 for softer edges. */
  bevelSegments?: number;
}

/**
 * Assembles static structures from simple parts, merged into one mesh per
 * section and material. Every part keeps its own `grain` coordinates (meters
 * in the part's local frame) and a slight `color` tint, so batched timber still
 * reads as separate pieces. Long parts run along local X.
 */
export class PartBuilder<M extends string> {
  readonly random: () => number;
  /** Parts are batched per section and material. */
  section = '';
  private readonly batches = new Map<string, { material: M; parts: THREE.BufferGeometry[] }>();
  private readonly collisions?: IslandCollisions;
  private readonly placement: THREE.Matrix4;
  private readonly bevelSegments: number;

  constructor(private readonly materials: Record<M, THREE.Material>, options: BuilderOptions = {}) {
    this.random = seededRandom(options.seed ?? 1);
    this.collisions = options.collisions;
    this.placement = options.placement ?? new THREE.Matrix4();
    this.bevelSegments = options.bevelSegments ?? 1;
  }

  add(geometry: THREE.BufferGeometry, material: M, position = V(), rotation = new THREE.Quaternion(), solid = true, tint?: THREE.Color) {
    const points = geometry.getAttribute('position'), count = points.count;
    const offset = V(this.random() * 80, .13 + this.random() * .09, this.random() * .07);
    const shade = .9 + this.random() * .17, warmth = (this.random() - .5) * .035;
    if (!geometry.hasAttribute('grain')) {
      const grain = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) grain.set([points.getX(i) + offset.x, points.getY(i) + offset.y, points.getZ(i) + offset.z], i * 3);
      geometry.setAttribute('grain', new THREE.BufferAttribute(grain, 3));
    }
    if (!geometry.hasAttribute('color')) {
      const color = tint ? [tint.r, tint.g, tint.b] : [shade + warmth, shade, shade - warmth];
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) colors.set(color, i * 3);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, rotation, V(1, 1, 1)).premultiply(this.placement));
    // The exact same solids are rendered and indexed for walking.
    if (solid) this.collisions?.addGeometry(geometry);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.deleteAttribute('uv');
    const key = `${this.section} · ${material}`;
    if (!this.batches.has(key)) this.batches.set(key, { material, parts: [] });
    this.batches.get(key)!.parts.push(flat);
  }

  /** A rectangular member from `a` to `b`. */
  beam(material: M, a: THREE.Vector3, b: THREE.Vector3, height: number, width: number, solid = true, bevel = .012) {
    const direction = b.clone().sub(a);
    const geometry = bevel > 0
      ? new RoundedBoxGeometry(direction.length(), height, width, this.bevelSegments, Math.min(bevel, height / 3, width / 3))
      : new THREE.BoxGeometry(direction.length(), height, width);
    this.add(geometry, material, a.clone().add(b).multiplyScalar(.5), new THREE.Quaternion().setFromUnitVectors(X, direction.normalize()), solid);
  }

  /** An axis-aligned box, `width` along X. */
  box(material: M, center: THREE.Vector3, width: number, height: number, depth: number, solid = true, bevel = .012) {
    this.beam(material, center.clone().addScaledVector(X, -width / 2), center.clone().addScaledVector(X, width / 2), height, depth, solid, bevel);
  }

  cylinder(material: M, a: THREE.Vector3, b: THREE.Vector3, radius: number, topRadius = radius, solid = true, sides = 12) {
    const direction = b.clone().sub(a);
    const geometry = new THREE.CylinderGeometry(topRadius, radius, direction.length(), sides);
    geometry.rotateZ(-Math.PI / 2);
    this.add(geometry, material, a.clone().add(b).multiplyScalar(.5), new THREE.Quaternion().setFromUnitVectors(X, direction.normalize()), solid);
  }

  /** A rope or rod along a smooth curve; grain runs along its length. */
  tube(material: M, points: THREE.Vector3[], radius: number, segments = 20, sides = 7, solid = true, closed = false) {
    const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
    const geometry = new THREE.TubeGeometry(curve, segments, radius, sides, closed);
    const uv = geometry.getAttribute('uv'), grain = new Float32Array(uv.count * 3), length = curve.getLength();
    for (let i = 0; i < uv.count; i++) grain.set([uv.getX(i) * length, uv.getY(i) * Math.PI * 2, 0], i * 3);
    geometry.setAttribute('grain', new THREE.BufferAttribute(grain, 3));
    this.add(geometry, material, V(), new THREE.Quaternion(), solid);
  }

  /** Merge every batch into `root`. */
  build(root: THREE.Object3D) {
    for (const [name, batch] of this.batches) {
      const merged = mergeGeometries(batch.parts, false)!;
      const geometry = mergeVertices(merged, .00001);
      merged.dispose();
      batch.parts.forEach(part => part.dispose());
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials[batch.material]);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
    this.batches.clear();
  }
}
