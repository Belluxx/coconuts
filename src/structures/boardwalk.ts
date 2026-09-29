import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { groundHeight } from '../land/terrain';
import { V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { BOARDWALKS, boardwalkFrame, type BoardwalkFrame, type BoardwalkRoute } from './boardwalkLayout';
import { PartBuilder } from './builder';
import type { TimberMaterials } from './timber';
import { createTorch, createTorchMaterials } from './torches';

type Builder = PartBuilder<keyof TimberMaterials>;
const at = (frame: BoardwalkFrame, across: number, rise = 0) => frame.center.clone().addScaledVector(frame.right, across).add(V(0, rise, 0));

function plank(b: Builder, route: BoardwalkRoute, from: number, to: number) {
  const a = boardwalkFrame(route, from), c = boardwalkFrame(route, to), depth = to - from;
  const geometry = new RoundedBoxGeometry(route.width, .1, depth, 1, .004);
  const positions = geometry.getAttribute('position'), grain = new Float32Array(positions.count * 3);
  const offset = b.random() * 70;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i), t = z / depth + .5;
    grain.set([x + offset, y + .18, z + .06], i * 3);
    // Slightly tapered boards follow bends without overlapping or opening wedge gaps.
    const p = at(a, x).lerp(at(c, x), t);
    positions.setXYZ(i, p.x, p.y + y - .05, p.z);
  }
  geometry.setAttribute('grain', new THREE.BufferAttribute(grain, 3));
  geometry.computeVertexNormals(); b.add(geometry, 'deck');
  const middle = boardwalkFrame(route, (from + to) / 2);
  for (const side of [-1, 1]) {
    const nail = at(middle, side * 1.04, .001);
    b.cylinder('metal', nail, nail.clone().add(V(0, .002, 0)), .009, .009, false, 6);
  }
}

function post(b: Builder, frame: BoardwalkFrame, side: number) {
  const p = at(frame, side * 1.205), bottom = groundHeight(p.x, p.z) - .22;
  b.beam('frame', p.clone().setY(bottom), p.clone().add(V(0, 1, 0)), .165, .165);
  b.box('endgrain', p.clone().add(V(0, 1.005, 0)), .18, .035, .18);
  const wraps: THREE.Vector3[] = [];
  for (let i = 0; i <= 64; i++) {
    const angle = i / 32 * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
    const radius = .087 / Math.max(Math.abs(c), Math.abs(s));
    wraps.push(p.clone().add(V(c * radius, .835 + i / 32 * .028, s * radius)));
  }
  b.tube('rope', wraps, .016, 64, 5, false);
  const bolt = p.clone().addScaledVector(frame.right, side * .085).add(V(0, -.18, 0));
  b.cylinder('metal', bolt, bolt.clone().addScaledVector(frame.right, side * .014), .025, .025, false, 6);
}

function buildRoute(b: Builder, route: BoardwalkRoute) {
  const boards = Math.ceil(route.length / .265), spacing = route.length / boards;
  for (let i = 0; i < boards; i++) {
    b.section = `${route.name} · span ${Math.floor(i * spacing / 12) + 1}`;
    plank(b, route, i * spacing + .0035, (i + 1) * spacing - .0035);
  }
  // Continuous bearers sit beneath the two sides, with low stub piles at each bay.
  const segments = Math.ceil(route.length / .9);
  for (let i = 0; i < segments; i++) {
    const s = i * route.length / segments, e = (i + 1) * route.length / segments;
    b.section = `${route.name} · span ${Math.floor(s / 12) + 1}`;
    const a = boardwalkFrame(route, s), c = boardwalkFrame(route, e);
    for (const side of [-1, 1]) b.beam('frame', at(a, side * 1.02, -.2), at(c, side * 1.02, -.2), .2, .13);
  }
  const bays = Math.ceil((route.length - 2.4) / 3.1);
  for (let i = 0; i <= bays; i++) {
    const s = 1.2 + i / bays * (route.length - 2.4), f = boardwalkFrame(route, s);
    b.section = `${route.name} · span ${Math.floor(s / 12) + 1}`;
    b.beam('frame', at(f, -1.28, -.29), at(f, 1.28, -.29), .16, .17);
    for (const side of [-1, 1]) {
      post(b, f, side);
      if (i === bays) continue;
      const next = 1.2 + (i + 1) / bays * (route.length - 2.4);
      const points = Array.from({ length: 9 }, (_, j) => at(boardwalkFrame(route, THREE.MathUtils.lerp(s, next, j / 8)), side * 1.205, .87 - Math.sin(Math.PI * j / 8) * .17));
      b.tube('rope', points, .027, 20, 6, true);
    }
  }
}

/** Raised timber trails from the beach inland, lit by torches after dark. */
export function createBoardwalks(materials: TimberMaterials, collisions: IslandCollisions) {
  const root = new THREE.Group();
  root.name = 'Boardwalks · beach to inland';
  const builder = new PartBuilder(materials, { seed: 48192, collisions });
  for (const route of BOARDWALKS) buildRoute(builder, route);
  builder.build(root);

  const torchMaterials = createTorchMaterials(materials);
  const lights: THREE.PointLight[] = [];
  BOARDWALKS.forEach((route, routeIndex) => {
    const count = Math.ceil(route.length / 8);
    for (let i = 0; i < count; i++) {
      const distance = 2.7 + i * (route.length - 5.4) / (count - 1), f = boardwalkFrame(route, distance);
      const side = (i + routeIndex) % 2 === 0 ? -1 : 1;
      const position = at(f, side * 1.53, -.18);
      const inward = f.right.clone().multiplyScalar(-side);
      const torch = createTorch(i < 3 ? 'lantern' : 'basket', torchMaterials, collisions, {
        position, yaw: Math.atan2(-inward.z, inward.x),
        footing: groundHeight(position.x, position.z) - position.y - .2,
        seed: routeIndex * 10 + i,
      });
      // The scene's light pool picks the nearest torches to light each frame.
      const light = new THREE.PointLight('#ffad48', 0, 8, 2);
      light.name = 'Torch · warm light';
      light.position.copy(torch.lightPosition);
      root.add(torch.root, light);
      lights.push(light);
    }
  });
  return {
    root,
    update(time: number, daylight: number) {
      lights.forEach((light, i) => {
        const flicker = 1 + Math.sin(time * 7.3 + i * 2.4) * .055 + Math.sin(time * 13.7 + i) * .025;
        light.intensity = THREE.MathUtils.lerp(3, 16, 1 - daylight) * flicker;
      });
    },
  };
}
