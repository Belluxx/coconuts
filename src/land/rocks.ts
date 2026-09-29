import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, float, max, mix, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { smoothstep as ease, seededRandom, TAU, V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { surfaceNoise3D, type TSLNode } from '../shading';
import { inBoardwalkClearing } from '../structures/boardwalkLayout';
import { inBungalowClearing } from '../structures/bungalowLayout';
import { coastDistance, groundHeight, seabedHeight, shoreZ } from './terrain';
import { wetAlbedo } from './wetSand';
import { CREEK, GORGE, POOL, gorgeRadius, gorgeSkyView, inFallsWater, inGorge, sprayWetness, toLocal, toWorld } from './waterfallLayout';

type RockForm = 'boulder' | 'slab' | 'cliff' | 'talus';
type Habitat = 'headland' | 'shore' | 'garden' | 'talus' | 'falls';
/** Where a formation stands; birds look for perches on top of them. */
export type RockPlacement = { x: number; z: number; habitat: Habitat };

type StoneFace = { corners: THREE.Vector3[]; normal: THREE.Vector3; chip: boolean };

/** Split a solid along a geological fracture, retaining its broad planar faces. */
function cutStone(faces: StoneFace[], normal: THREE.Vector3, distance: number, chip = false) {
  const result: StoneFace[] = [];
  const cut: THREE.Vector3[] = [];
  for (const face of faces) {
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < face.corners.length; i++) {
      const a = face.corners[i], b = face.corners[(i + 1) % face.corners.length];
      const da = a.dot(normal) - distance, db = b.dot(normal) - distance;
      if (da <= 1e-7) corners.push(a);
      if ((da < -1e-7 && db > 1e-7) || (da > 1e-7 && db < -1e-7)) {
        const point = a.clone().lerp(b, da / (da - db));
        corners.push(point);
        if (!cut.some(other => other.distanceToSquared(point) < 1e-12)) cut.push(point);
      }
    }
    if (corners.length >= 3) result.push({ ...face, corners });
  }
  if (cut.length >= 3) {
    const center = cut.reduce((sum, point) => sum.add(point), V()).divideScalar(cut.length);
    const u = (Math.abs(normal.y) < .9 ? V(0, 1, 0) : V(1, 0, 0)).cross(normal).normalize();
    const v = normal.clone().cross(u);
    cut.sort((a, b) => Math.atan2(a.clone().sub(center).dot(v), a.clone().sub(center).dot(u))
      - Math.atan2(b.clone().sub(center).dot(v), b.clone().sub(center).dot(u)));
    result.push({ corners: cut, normal, chip });
  }
  return result;
}

/**
 * Reference-built stone kit: unequal fracture planes, clipped shoulders and
 * small angular chips. No sphere primitives or smooth rounded bevels are used.
 * All four forms share metre-scale coordinates around the origin and hard
 * normals, so shoreline fragments and distant cliff faces have the same style.
 */
export function createRockGeometry(seed: number, form: RockForm = 'boulder', detail: 'near' | 'far' = 'near') {
  const random = seededRandom(seed);
  let faces: StoneFace[] = [];
  // Begin with six oriented faces; every following cut adds an actual surface.
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const normal = V().setComponent(axis, sign);
    const u = V().setComponent((axis + 1) % 3, 1.6);
    const v = V().setComponent((axis + 2) % 3, 1.6 * sign);
    const center = normal.clone().multiplyScalar(1.6);
    faces.push({ normal, chip: false, corners: [
      center.clone().sub(u).sub(v), center.clone().add(u).sub(v),
      center.clone().add(u).add(v), center.clone().sub(u).add(v),
    ] });
  }
  const sides = form === 'talus' ? 6 : form === 'cliff' ? 7 : 8;
  const phase = random() * TAU;
  const sideNormals: THREE.Vector3[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = phase + i / sides * TAU + (random() - .5) * .34;
    const lean = (random() - .5) * (form === 'cliff' ? .32 : .78);
    const normal = V(Math.cos(angle), lean, Math.sin(angle)).normalize();
    sideNormals.push(normal);
    faces = cutStone(faces, normal, .70 + random() * .37);
  }
  const capTilt = form === 'talus' ? .90 : form === 'slab' ? .24 : form === 'cliff' ? .30 : .68;
  const top = V((random() - .5) * capTilt, 1, (random() - .5) * capTilt).normalize();
  faces = cutStone(faces, top, form === 'talus' ? .65 : .80 + random() * .16);
  faces = cutStone(faces, V(.03, -1, -.05).normalize(), .86 + random() * .08);
  // Wider shoulder cuts give boulders their asymmetrical, worn silhouette;
  // nearly vertical cliff faces retain enough mass for a flat planted crown.
  sideNormals.forEach((side, i) => {
    const upper = side.clone().add(V(0, form === 'cliff' ? .63 : .96 + random() * .25, 0)).normalize();
    const reach = form === 'cliff' ? .98 + random() * .17 : .89 + random() * .24;
    faces = cutStone(faces, upper, reach, true);
    if (i % 2 === 0) faces = cutStone(faces, side.clone().add(V(0, -.85, 0)).normalize(), 1.01 + random() * .09, true);
  });
  // Small oblique corner breaks read as chipped stone instead of soft fillets.
  for (let i = 0; i < sides; i++) {
    const a = sideNormals[i], b = sideNormals[(i + 1) % sides];
    const normal = a.clone().add(b).add(V(0, (random() - .5) * .65)).normalize();
    let furthest = -Infinity;
    for (const face of faces) for (const p of face.corners) furthest = Math.max(furthest, p.dot(normal));
    faces = cutStone(faces, normal, furthest - .035 - random() * .055, true);
  }

  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const creases: number[] = [], footing: number[] = [], indices: number[] = [];
  const verticalScale = form === 'slab' ? .54 : form === 'talus' ? .66 : 1;
  const horizontalScale = form === 'slab' ? 1.12 : form === 'talus' ? 1.06 : 1;
  const fissure = (p: THREE.Vector3) => {
    const plane = Math.abs(p.y * .81 + p.x * .27 - p.z * .19 + Math.sin(p.z * 4.2 + phase) * .035 - .12);
    const split = 1 - ease(.012, .09, plane);
    const vertical = Math.abs(p.x * .65 + p.z * .74 + p.y * .08 - .18);
    return Math.max(split, form === 'cliff' ? (1 - ease(.008, .065, vertical)) * .8 : 0);
  };
  const sculpt = (p: THREE.Vector3) => {
    const low = Math.sin(p.x * 4.6 + p.z * 1.8 + phase) * Math.sin(p.y * 4.1 - p.z * 3.2 + phase * .7);
    const high = Math.sin(p.x * 10.1 - p.y * 8.2 + phase * 1.3) * Math.sin(p.z * 8.8 + p.y * 5.3);
    const displacement = low * .072 + high * .021 - fissure(p) * .075;
    return p.clone().addScaledVector(p.clone().normalize(), displacement);
  };
  const emit = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, face: StoneFace, pigment: number) => {
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if (normal.dot(face.normal) < 0) [b, c] = [c, b];
    const originals = [a, b, c];
    const scaled = originals.map(p => sculpt(p)).map(p => V(p.x * horizontalScale, p.y * verticalScale, p.z));
    const flat = scaled[1].clone().sub(scaled[0]).cross(scaled[2].clone().sub(scaled[0])).normalize();
    const start = positions.length / 3;
    const patch = Math.sin((a.x + b.x + c.x) * 6.4 + (a.z + b.z + c.z) * 3.9 + phase) * .035;
    for (const [i, p] of scaled.entries()) {
      positions.push(p.x, p.y, p.z);
      normals.push(flat.x, flat.y, flat.z);
      colors.push((pigment + patch) * 1.008, pigment + patch, (pigment + patch) * .991);
      creases.push(fissure(originals[i]));
      footing.push(0);
    }
    indices.push(start, start + 1, start + 2);
  };
  const facet = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, face: StoneFace, pigment: number) => {
    const steps = detail === 'far' ? 1 : form === 'talus' ? 2 : 3;
    const point = (i: number, j: number) => a.clone().multiplyScalar(1 - (i + j) / steps)
      .addScaledVector(b, i / steps).addScaledVector(c, j / steps);
    for (let i = 0; i < steps; i++) for (let j = 0; j < steps - i; j++) {
      emit(point(i, j), point(i + 1, j), point(i, j + 1), face, pigment);
      if (j < steps - i - 1) emit(point(i + 1, j), point(i + 1, j + 1), point(i, j + 1), face, pigment);
    }
  };
  for (const face of faces) {
    const pigment = .88 + random() * .19 + (face.chip ? .025 : 0);
    if (detail === 'near' && !face.chip && face.corners.length > 3) {
      // A shallow raised core breaks a broad plane into unequal sculpted facets.
      // The displacement is small enough to keep the fracture face legible.
      const center = face.corners.reduce((sum, p) => sum.add(p), V()).divideScalar(face.corners.length);
      center.lerp(face.corners[Math.floor(random() * face.corners.length)], .18)
        .addScaledVector(face.normal, .008 + random() * .019);
      for (let i = 0; i < face.corners.length; i++) {
        facet(center, face.corners[i], face.corners[(i + 1) % face.corners.length], face, pigment + (random() - .5) * .025);
      }
    } else {
      for (let i = 1; i < face.corners.length - 1; i++) facet(face.corners[0], face.corners[i], face.corners[i + 1], face, pigment);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('rockCrease', new THREE.Float32BufferAttribute(creases, 1));
  geometry.setAttribute('rockFoot', new THREE.Float32BufferAttribute(footing, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  // The standalone kit gets only a thin sandy fringe at its actual lowest edge.
  // Island placements replace it with height above the supporting terrain.
  const base = geometry.boundingBox!.min.y, feet = geometry.getAttribute('rockFoot');
  for (let i = 0; i < feet.count; i++) feet.setX(i, (positions[i * 3 + 1] - base) * 2.6);
  geometry.name = `Fractured island stone · ${form} ${seed} · ${detail}`;
  return geometry;
}

/** Broad gray-beige planes with chalky chips, sandy feet and planted crowns. */
export function createRockMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .92 });
  material.shadowSide = THREE.BackSide;
  material.name = 'Reference stone · warm gray fracture faces and sand';
  const p = positionWorld;
  const tint = attribute('color', 'vec3');
  const cavity = attribute('rockCrease', 'float');
  const broad = surfaceNoise3D(p.mul(.48));
  const grain = surfaceNoise3D(p.mul(24)).mul(.025).add(1);
  let stone: TSLNode = mix(color('#8e989c'), color('#b4afa2'), broad.mul(.28).add(.49)).mul(tint);
  stone = stone.mul(grain).mul(float(1).sub(cavity.mul(.22)));
  const tideNoise = surfaceNoise3D(p.mul(vec3(2.7, 1.5, 2.7))).mul(.10);
  const tidalWet = float(1).sub(smoothstep(-.16, .30, p.y.add(tideNoise)));
  // Spray from the waterfall keeps nearby stone wet.
  const fallsWet = sprayWetness(p);
  const wet = max(tidalWet, fallsWet.mul(.87));
  const sandEdge = surfaceNoise3D(p.mul(4.2)).mul(.22).add(surfaceNoise3D(p.mul(13)).mul(.075));
  const sand = float(1).sub(smoothstep(.08, .36, attribute('rockFoot', 'float').add(sandEdge)))
    .mul(float(1).sub(smoothstep(8, 16, p.y))).mul(.88);
  stone = mix(stone, color('#d5c6a3').mul(tint), sand);
  const inland = coastDistance(p.xz);
  const habitat = smoothstep(10, 20, inland).mul(smoothstep(1.4, 5, p.y));
  const mossPatch = smoothstep(-.1, .34, broad.add(surfaceNoise3D(p.mul(3.1)).mul(.21)));
  const moss = mossPatch.mul(smoothstep(.48, .87, normalWorld.y)).mul(max(habitat, fallsWet.mul(.6))).mul(.78);
  stone = mix(stone, mix(color('#637b3d'), color('#929948'), broad.mul(.5).add(.5)).mul(tint), moss);
  // Water in the stone's pores and film darkens it the way it darkens sand.
  material.colorNode = wetAlbedo(stone, wet, wet.mul(.7));
  material.roughnessNode = mix(float(.92), float(.35), wet);
  // Inside the waterfall's gorge, its walls hide part of the sky.
  material.aoNode = gorgeSkyView(p);
  return material;
}

/** Headlands, shore boulders, garden slabs and the waterfall's stone, merged into spatial cells. */
export function createRocks(collisions: IslandCollisions) {
  const root = new THREE.Group();
  root.name = 'Island geology · reference-built fractured stone';
  const random = seededRandom(581902);
  const material = createRockMaterial();
  const placements: RockPlacement[] = [];
  const prototypes = new Map<string, THREE.BufferGeometry>();
  const cells = new Map<string, { center: THREE.Vector3; parts: THREE.BufferGeometry[] }>();
  const cellFor = (x: number, z: number) => {
    const cx = Math.floor(x / 48), cz = Math.floor(z / 48), key = `${cx},${cz}`;
    if (!cells.has(key)) cells.set(key, { center: V((cx + .5) * 48, 0, (cz + .5) * 48), parts: [] });
    return cells.get(key)!;
  };
  const prototype = (seed: number, form: RockForm) => {
    const key = `${seed}/${form}`;
    if (!prototypes.has(key)) prototypes.set(key, createRockGeometry(seed, form));
    return prototypes.get(key)!;
  };
  const add = (x: number, z: number, sx: number, sy: number, sz: number, form: RockForm, habitat: Habitat, yaw = random() * TAU, variant = Math.floor(random() * 9), lift = 0) => {
    // Keep the waterfall's water and gorge to its own stones.
    if (habitat !== 'falls' && (inFallsWater(x, z, Math.max(sx, sz) + .4) || inGorge(x, z, Math.max(sx, sz)))) return;
    if (Math.abs(x + 24) < 4.7 + sx && z < 25 && z > -15) return;
    const seed = 17131 + variant * 719 + ['boulder', 'slab', 'cliff', 'talus'].indexOf(form) * 3137;
    const stone = prototype(seed, form);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler((random() - .5) * .12, yaw, (random() - .5) * .11));
    if (habitat === 'falls') {
      const dx = (groundHeight(x + .12, z) - groundHeight(x - .12, z)) / .24;
      const dz = (groundHeight(x, z + .12) - groundHeight(x, z - .12)) / .24;
      quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(-dx, 1, -dz).normalize()));
    }
    const scale = V(sx, sy, sz);
    const transformed = stone.clone().applyMatrix4(new THREE.Matrix4().compose(V(x, 0, z), quaternion, scale));
    transformed.computeBoundingBox();
    const bounds = transformed.boundingBox!;
    // A real embedded footing even on steep slopes: sample the bottom footprint
    // instead of assuming the center's terrain elevation applies to the rock.
    const base = seabedHeight(x, z);
    let lowGround = base;
    for (const dx of [-.62, 0, .62]) for (const dz of [-.62, 0, .62]) lowGround = Math.min(lowGround, seabedHeight(x + dx * sx, z + dz * sz));
    const burial = sy * (form === 'slab' ? .075 : habitat === 'headland' ? .32 : .16);
    const centerY = Math.min(base - burial, lowGround - bounds.min.y - Math.min(.16, sy * .18));
    const y = centerY + lift;
    transformed.translate(0, y, 0);
    const stoneTint = new THREE.Color().setRGB(.93 + random() * .11, .93 + random() * .085, .91 + random() * .09);
    // Leave the two-stone opening where the cascade enters the basin. Consume
    // the placement's random values first so the other formations stay put.
    // Keep the cottage and walking corridors clear without reshuffling the geology.
    if (inBungalowClearing(x, z, Math.max(sx, sz))
      || inBoardwalkClearing(x, z, Math.max(sx, sz))) {
      transformed.dispose();
      return;
    }
    const colorize = (geometry: THREE.BufferGeometry) => {
      const colors = geometry.getAttribute('color');
      const points = geometry.getAttribute('position'), footing = geometry.getAttribute('rockFoot');
      for (let i = 0; i < colors.count; i++) {
        colors.setXYZ(i, colors.getX(i) * stoneTint.r, colors.getY(i) * stoneTint.g, colors.getZ(i) * stoneTint.b);
        footing.setX(i, points.getY(i) - seabedHeight(points.getX(i), points.getZ(i)));
      }
    };
    collisions.addGeometry(transformed);
    colorize(transformed);
    cellFor(x, z).parts.push(transformed);
    placements.push({ x, z, habitat });
  };

  // Tall fractured columns sit in broad stepped groups, with shorter shoulders
  // at their feet. The hillside hides the backs of the columns and joins them
  // into the reference's planted cliff masses.
  const headlands = [
    [73, 17, 7, 13, 7], [79, 20, 6, 17, 6], [84, 15, 6, 11, 7], [88, 8, 7, 10, 8],
    [70, 7, 6, 10, 6], [74, -1, 6, 11, 5], [89, -12, 7, 9, 6], [101, -20, 7, 8, 8],
    [48, 12, 4, 6, 5], [-69, -7, 7, 9, 7], [-79, -14, 8, 10, 8], [-89, -27, 7, 8, 7],
    [-63, -17, 4, 4, 4], [-53, -12, 3, 2.4, 3],
  ];
  headlands.forEach(([x, z, sx, sy, sz], i) => {
    const yaw = (x > 0 ? .17 : -.3) + Math.sin(i * 1.7) * .37;
    add(x, z, sx * 1.05, sy * .93, sz, 'cliff', 'headland', yaw, i % 9);
    add(x - sx * .57, z - sz * .43, sx * .68, sy * .56, sz * .77, 'cliff', 'headland', yaw + .18, (i + 4) % 9);
    add(x + sx * .39, z - sz * .57, sx * .58, sy * .32, sz * .65, i % 3 ? 'boulder' : 'slab', 'headland', yaw - .38, (i + 6) % 9);
  });
  for (let i = 0; i < 74; i++) {
    const x = 44 + random() * 66, d = 17 + random() * 35, z = shoreZ(x) + d;
    if (z > 36 || z < -49) continue;
    const slope = Math.hypot((groundHeight(x + 1, z) - groundHeight(x - 1, z)) * .5, (groundHeight(x, z + 1) - groundHeight(x, z - 1)) * .5);
    if (slope < .62 && random() < .72) continue;
    const r = 2.7 + random() * 2.35;
    const form = i % 6 === 0 ? 'slab' : i % 4 === 0 ? 'boulder' : 'cliff';
    add(x, z, r, r * (form === 'cliff' ? 1.45 + random() * .55 : .56 + random() * .55), r * (.80 + random() * .40), form, 'headland', -.15 + random() * .55);
  }
  // Shore boulders arrive in loose families at the ends of the bay. Satellite
  // fracture chips stay close to their parent, leaving the central sand open.
  const families = [[-48, -1], [-58, -13], [-68, -24], [-84, -40], [-98, -64], [46, -2], [72, -25], [89, -45], [105, -76], [116, -97]];
  families.forEach(([cx, cz], family) => {
    for (let i = 0; i < 5; i++) {
      const x = cx + (random() - .5) * 10, z = cz + (random() - .5) * 8;
      const r = i === 0 ? 2.6 + random() * 1.3 : .75 + random() * 1.5;
      add(x, z, r * (1.05 + random() * .25), r * (.64 + random() * .32), r, 'boulder', 'shore', random() * TAU, (family + i) % 9);
      for (let chip = 0; chip < 3; chip++) {
        const angle = random() * TAU, radius = r * (.85 + random() * .48), size = .15 + random() * .37;
        add(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius, size * 1.45, size * .55, size, 'talus', 'talus');
      }
    }
  });
  // Flat bedding shelves form two recognizable layered piles, with unequal
  // overhangs and a loose fracture chip resting against the lowest course.
  for (const [x, z, yaw] of [[-48, 6, .4], [31, 26, -.35]]) {
    add(x, z, 2.8, 1.2, 2.05, 'slab', 'garden', yaw, 2);
    add(x + .28, z + .12, 2.58, .85, 1.84, 'slab', 'garden', yaw + .08, 5, .62);
    add(x - .24, z + .20, 2.3, .67, 1.76, 'slab', 'garden', yaw - .05, 8, 1.06);
    add(x - 2.1, z - 1.35, .9, .8, .82, 'talus', 'garden', yaw + .4, 3);
  }
  for (const [x, z, r] of [[-13, 32, 2.6], [-18, 29, 1.7], [18, 31, 2.2], [24, 27, 2.8], [-8, 48, 1.5], [9, 20, .7], [-15, 20, .5]]) {
    add(x, z, r, r * .70, r * .85, r > 2 ? 'slab' : 'boulder', 'garden');
  }
  // Half-buried stones belong to the same woodland pockets as the ferns.
  // A few loose satellites keep their distribution from becoming a rock border.
  for (const [cx, cz] of [[-35, 33], [-30, 40], [-13, 49], [19, 42], [32, 34], [44, 22], [-52, 12]]) {
    for (let i = 0; i < 4; i++) {
      const x = cx + (random() - .5) * 7, z = cz + (random() - .5) * 6;
      if (z - shoreZ(x) < 12) continue;
      const r = i === 0 ? 1.1 + random() * .7 : .28 + random() * .55;
      add(x, z, r * 1.2, r * .63, r, i === 0 ? 'slab' : 'boulder', 'garden');
    }
  }
  // The waterfall's stone: talus fallen from the gorge's walls, the boulder
  // ring that holds the pool, slabs framing the brink, the spring's
  // boulders, and a few big stones in the pool's shallows.
  const fallsRandom = seededRandom(834172);
  const place = (along: number, across: number, size: number, form: RockForm, clearance = .15) => {
    const p = toWorld(along, across);
    if (inFallsWater(p.x, p.z, clearance)) return;
    add(p.x, p.z, size * 1.2, size * .66, size * .95, form, 'falls', fallsRandom() * TAU);
  };
  for (let i = 0; i < 30; i++) {
    const angle = (fallsRandom() * 2 - 1) * (GORGE.span - .08), inset = .25 + fallsRandom() * 1.4;
    const size = .3 + fallsRandom() ** 1.7 * 1.15, form = fallsRandom() < .3 ? 'slab' : 'boulder';
    const radius = gorgeRadius(angle) - inset;
    if (Math.abs(angle) > .45) place(GORGE.back - Math.cos(angle) * radius, Math.sin(angle) * radius, size, form);
  }
  // Boulders shoulder to shoulder along the open side of the pool.
  for (let i = 0; i < 15; i++) {
    const angle = -1.9 + 3.8 * i / 14 + (fallsRandom() - .5) * .12, rim = 1.1 + fallsRandom() * .08;
    const size = .42 + fallsRandom() * .4 + (i % 4 === 1 ? .3 : 0);
    const p = toWorld(POOL.along + Math.cos(angle) * rim * POOL.radiusAlong, Math.sin(angle) * rim * POOL.radiusAcross);
    add(p.x, p.z, size * 1.25, size * .62, size, i % 5 === 3 ? 'slab' : 'boulder', 'falls', fallsRandom() * TAU);
  }
  for (const side of [-1, 1]) place(-.7 - fallsRandom() * .5, side * (1.85 + fallsRandom() * .3), .75 + fallsRandom() * .3, 'slab', 0);
  const spring = CREEK.at(0);
  for (const [dx, dz, size] of [[-.9, .8, 1.25], [.7, 1.1, 1.05], [.1, 1.6, .85], [1.4, .2, .7]]) {
    const { along, across } = toLocal(spring.x + dx, spring.z + dz);
    place(along, across, size, 'boulder', 0);
  }
  for (let i = 0; i < 5; i++) {
    const angle = 1 + fallsRandom() * 4.3, rim = .82 + fallsRandom() * .12;
    const p = toWorld(POOL.along + Math.cos(angle) * rim * POOL.radiusAlong, Math.sin(angle) * rim * POOL.radiusAcross);
    const size = .45 + fallsRandom() * .35;
    add(p.x, p.z, size * 1.2, size * .6, size, 'boulder', 'falls', fallsRandom() * TAU);
  }
  prototypes.forEach(geometry => geometry.dispose());
  cells.forEach((cell, key) => {
    const geometry = mergeGeometries(cell.parts, false)!;
    cell.parts.forEach(part => part.dispose());
    geometry.translate(-cell.center.x, 0, -cell.center.z);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Fractured stone formations · cell ${key}`;
    mesh.position.copy(cell.center);
    mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
  });
  return { root, placements };
}
