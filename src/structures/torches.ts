import * as THREE from 'three/webgpu';
import { attribute, color, float, fract, mix, positionLocal, sin, smoothstep, time, vec3 } from 'three/tsl';
import { V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { PartBuilder } from './builder';
import type { TimberMaterials } from './timber';

/** Timber from the shared set, plus bronze, amber glass, fire and embers. */
export function createTorchMaterials({ frame, endgrain, rope }: TimberMaterials) {
  const iron = new THREE.MeshStandardNodeMaterial({ color: '#392e25', roughness: .63, metalness: .72 });
  iron.name = 'Torches · blackened bronze';
  const amber = new THREE.MeshStandardNodeMaterial({ color: '#df922f', roughness: .42 });
  amber.name = 'Torches · warm amber glass';
  const flicker = sin(time.mul(7.3)).mul(.055).add(sin(time.mul(13.7)).mul(.025)).add(1);
  const glass = attribute('glow', 'vec3');
  const core = glass.mul(vec3(1, .75, 1)).length().mul(-8).exp();
  amber.emissiveNode = mix(color('#e98520'), color('#fff4b2'), core).mul(flicker).mul(core.mul(4).add(.8));

  const flame = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  flame.name = 'Torches · dancing fire';
  const seed = attribute('seed', 'float'), height = positionLocal.y.div(.72).clamp();
  const flutter = sin(time.mul(9).sub(height.mul(11)).add(seed));
  const sway = sin(time.mul(3.9).add(seed)).mul(.055).add(flutter.mul(.035)).mul(height.pow(1.5));
  flame.positionNode = positionLocal.add(vec3(sway, flutter.mul(height).mul(.035), sin(time.mul(5.2).add(seed).sub(height.mul(7))).mul(height).mul(.033)));
  flame.colorNode = mix(color('#fff4ac'), color('#ff5a08'), smoothstep(.12, .94, height)).mul(1.7);
  flame.opacityNode = float(.74).mul(float(1).sub(smoothstep(.72, 1, height)));

  const ember = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  ember.name = 'Torches · drifting embers';
  const age = fract(time.mul(.24).add(seed));
  ember.positionNode = positionLocal.add(vec3(sin(age.mul(7).add(seed.mul(9))).mul(.13).add(age.mul(.18)), age.mul(1.2), sin(age.mul(6).add(seed.mul(14))).mul(.1)));
  ember.colorNode = color('#ff9c28').mul(3);
  ember.opacityNode = smoothstep(0, .12, age).mul(float(1).sub(smoothstep(.55, 1, age)));
  return { frame, endgrain, rope, iron, amber, flame, ember };
}
type TorchMaterials = ReturnType<typeof createTorchMaterials>;

/** A basket torch with a live flame, or a lantern on a bracket; `footing` sinks the post into the ground. */
export function createTorch(kind: 'basket' | 'lantern', materials: TorchMaterials, collisions: IslandCollisions,
  options: { position: THREE.Vector3; yaw: number; seed: number; footing: number }) {
  const root = new THREE.Group();
  root.name = kind === 'basket' ? 'Basket torch · woven crown' : 'Lantern torch · hanging amber';
  const placement = new THREE.Matrix4().compose(options.position, new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), options.yaw), V(1, 1, 1));
  const b = new PartBuilder<'frame' | 'endgrain' | 'rope' | 'iron' | 'amber'>(materials, { seed: 48192 + options.seed, collisions, placement });
  b.section = root.name;
  let source: THREE.Vector3;
  if (kind === 'basket') {
    b.beam('frame', V(0, options.footing, 0), V(0, 1.79, 0), .12, .115);
    b.cylinder('iron', V(0, 1.55, 0), V(0, 1.77, 0), .076, .115);
    b.cylinder('iron', V(0, 1.75, 0), V(0, 1.8, 0), .115, .14);
    for (let i = 0; i < 10; i++) {
      const angle = i / 10 * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
      b.beam('frame', V(c * .12, 1.79, s * .12), V(c * .205, 2.2, s * .205), .043, .044);
    }
    for (const [y, radius] of [[1.82, .137], [1.98, .171], [2.15, .205]]) {
      const points = Array.from({ length: 33 }, (_, i) => V(Math.cos(i / 32 * Math.PI * 2) * radius, y, Math.sin(i / 32 * Math.PI * 2) * radius));
      // Flat hoop bands bind the flared timber basket.
      const hoop = new THREE.CylinderGeometry(radius + .009, radius + .009, .036, 20, 1, true);
      const inner = new THREE.CylinderGeometry(radius - .009, radius - .009, .036, 20, 1, true);
      inner.scale(-1, 1, 1);
      b.add(hoop, 'iron', V(0, y, 0)); b.add(inner, 'iron', V(0, y, 0));
      b.tube('iron', points, .01, 32, 7, false);
    }
    for (let turn = 0; turn < 6; turn++) {
      const y = 1.48 + turn * .032;
      b.tube('rope', [V(-.065, y, -.065), V(.065, y, -.065), V(.065, y, .065), V(-.065, y, .065), V(-.065, y + .023, -.065)], .014, 16, 7, false);
    }
    b.cylinder('iron', V(0, 1.81, 0), V(0, 1.87, 0), .12, .135);
    source = V(0, 1.96, 0);
    const fire = new THREE.Group();
    fire.name = 'Animated flame and embers';
    fire.position.copy(source.clone().applyMatrix4(placement));
    for (let tongue = 0; tongue < 3; tongue++) {
      const height = tongue === 0 ? .72 : .46, radius = tongue === 0 ? .125 : .072;
      const profile = Array.from({ length: 15 }, (_, i) => {
        const t = i / 14;
        return new THREE.Vector2(Math.sin(Math.PI * t) ** .7 * radius * (1 - t * .55) + (1 - t) * .012, t * height);
      });
      const geometry = new THREE.LatheGeometry(profile, 10);
      geometry.translate((tongue - 1) * .069, 0, tongue === 1 ? .045 : -.02);
      geometry.setAttribute('seed', new THREE.Float32BufferAttribute(Array(geometry.getAttribute('position').count).fill(options.seed * 3.7 + tongue * 2.1), 1));
      const mesh = new THREE.Mesh(geometry, materials.flame);
      mesh.frustumCulled = false; fire.add(mesh);
    }
    for (let i = 0; i < 3; i++) {
      const geometry = new THREE.SphereGeometry(.009 - i * .0015, 5, 4);
      geometry.setAttribute('seed', new THREE.Float32BufferAttribute(Array(geometry.getAttribute('position').count).fill(i / 3 + options.seed * .17), 1));
      const spark = new THREE.Mesh(geometry, materials.ember); spark.position.y = .35;
      spark.frustumCulled = false; fire.add(spark);
    }
    root.add(fire);
  } else {
    b.beam('frame', V(0, options.footing, 0), V(0, 2.66, 0), .16, .16);
    b.box('endgrain', V(0, 2.665, 0), .185, .045, .185);
    b.beam('frame', V(-.08, 2.47, 0), V(.67, 2.47, 0), .14, .13);
    b.beam('frame', V(.04, 2.08, 0), V(.44, 2.43, 0), .062, .066);
    b.cylinder('iron', V(0, 2.47, -.086), V(0, 2.47, .086), .026, .026, false);
    b.tube('iron', [V(.52, 2.42, 0), V(.52, 2.3, 0), V(.55, 2.27, 0), V(.585, 2.3, 0), V(.575, 2.35, 0)], .015, 14, 7, false);
    b.tube('iron', [V(.55, 2.31, 0), V(.515, 2.265, 0), V(.55, 2.22, 0), V(.585, 2.265, 0), V(.55, 2.31, 0)], .012, 16, 7, false);
    for (const y of [1.59, 2.09]) b.box('iron', V(.55, y, 0), .39, .045, .35);
    for (const x of [.39, .71]) for (const z of [-.14, .14]) b.beam('iron', V(x, 1.6, z), V(x, 2.09, z), .027, .027);
    const panes = new THREE.BoxGeometry(.29, .45, .25);
    panes.setAttribute('glow', panes.getAttribute('position').clone());
    b.add(panes, 'amber', V(.55, 1.845, 0));
    const cap = new THREE.CylinderGeometry(.035, .285, .15, 4);
    cap.rotateY(Math.PI / 4); b.add(cap, 'iron', V(.55, 2.175, 0));
    b.box('endgrain', V(.55, 1.575, 0), .405, .035, .36);
    source = V(.55, 1.845, 0);
  }
  b.build(root);
  return { root, lightPosition: source.applyMatrix4(placement) };
}
