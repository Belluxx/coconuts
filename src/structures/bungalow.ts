import * as THREE from 'three/webgpu';
import { attribute, color, mix, positionWorld, sin, vec3 } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { groundHeight } from '../land/terrain';
import { createPottedPlant } from '../land/vegetation';
import { V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { reliefNormal, surfaceNoise3D } from '../shading';
import { PartBuilder } from './builder';
import { BUNGALOW, BUNGALOW_BED, BUNGALOW_CHAIR, BUNGALOW_VERANDA_CHAIR, bungalowFloorY, bungalowPoint } from './bungalowLayout';
import type { TimberMaterials } from './timber';

/** Plaster, paint, fabrics and furnishings, alongside the shared timber. */
function createBungalowMaterials(timber: TimberMaterials) {
  const tint = attribute('color', 'vec3'), grain = attribute('grain', 'vec3');
  // The floor and ceiling boards are seen from both sides.
  const wood = timber.deck.clone();
  wood.side = THREE.DoubleSide;

  // Whole walls share one lime wash; no per-part tint.
  const plaster = new THREE.MeshStandardNodeMaterial({ roughness: .96 });
  const lime = surfaceNoise3D(positionWorld.mul(3.7)).mul(.025).add(surfaceNoise3D(positionWorld.mul(51)).mul(.008));
  plaster.colorNode = color('#f2e6cf').mul(lime.add(1));
  plaster.normalNode = reliefNormal(lime.mul(.014));

  const blue = new THREE.MeshStandardNodeMaterial({ roughness: .72 });
  const paint = surfaceNoise3D(grain.mul(vec3(2, 72, 72)));
  blue.colorNode = mix(color('#316895'), color('#598fbc'), paint.mul(.16).add(.55)).mul(tint);
  blue.normalNode = reliefNormal(paint.mul(.0006));

  const cloth = (base: string) => {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
    const weave = sin(grain.x.mul(410)).mul(sin(grain.z.mul(410))).mul(.016);
    material.colorNode = color(base).mul(tint).mul(weave.add(1));
    material.normalNode = reliefNormal(weave.mul(.001));
    return material;
  };
  const materials = {
    wood, frame: timber.frame, endgrain: timber.endgrain, rope: timber.rope, thatch: timber.thatch,
    plaster, blue, linen: cloth('#f8efde'), rug: cloth('#467fae'),
    brass: new THREE.MeshStandardNodeMaterial({ color: '#b99b54', roughness: .4, metalness: .7 }),
    ceramic: new THREE.MeshStandardNodeMaterial({ color: '#d3bd97', roughness: .68 }),
    soil: new THREE.MeshStandardNodeMaterial({ color: '#4b3c29', roughness: 1 }),
    paper: new THREE.MeshStandardNodeMaterial({ color: '#fbdea2', roughness: .95, side: THREE.DoubleSide, emissive: '#e7aa59', emissiveIntensity: .12 }),
    art: new THREE.MeshStandardNodeMaterial({ roughness: .95, vertexColors: true }),
  };
  for (const [name, material] of Object.entries(materials)) if (!material.name) material.name = `Bungalow · ${name}`;
  return materials;
}
type BungalowMaterial = keyof ReturnType<typeof createBungalowMaterials>;
type Builder = PartBuilder<BungalowMaterial>;

const Y = V(0, 1, 0);
const FRONT = -1.55, BACK = 2.85, HALF = 2.55, WALL = 2.74;

function foundation(b: Builder) {
  for (const x of [-2.82, 0, 2.82]) for (const z of [-3.22, -.2, 2.86]) {
    const p = bungalowPoint(x, 0, z), bottom = groundHeight(p.x, p.z) - bungalowFloorY - .24;
    b.beam('frame', V(x, bottom, z), V(x, -.08, z), .21, .21);
    b.box('endgrain', V(x, -.075, z), .24, .04, .24);
  }
  for (const z of [-3.22, -.2, 2.86]) b.box('frame', V(0, -.27, z), 6.15, .27, .19);
  for (const x of [-2.82, 0, 2.82]) b.beam('frame', V(x, -.14, -3.44), V(x, -.14, 3.08), .2, .16);
  // Alternating butt joints and fine gaps give the veranda a real boarded edge.
  for (let row = 0; row < 27; row++) {
    const z = -3.45 + (row + .5) * 6.55 / 27, joint = row % 2 ? -.8 : .8;
    for (const [left, right] of [[-3.08, joint - .004], [joint + .004, 3.08]]) {
      b.box('wood', V((left + right) / 2, -.055, z), right - left, .11, 6.55 / 27 - .007, true, .005);
      for (const x of [left + .05, right - .05]) b.cylinder('brass', V(x, .001, z), V(x, .004, z), .008, .008, false);
    }
  }
  b.box('frame', V(0, -.17, -3.5), 6.32, .29, .13);
  b.box('frame', V(0, -.17, 3.12), 6.32, .29, .13);
  for (const x of [-3.14, 3.14]) b.beam('frame', V(x, -.17, -3.5), V(x, -.17, 3.12), .29, .13);
  for (let step = 0; step < 4; step++) {
    const z = -3.5 - (3.5 - step) * .44, y = -(4 - step) * .21;
    b.box('wood', V(0, y - .04, z), 1.78, .08, .465, true, .008);
    b.box('frame', V(0, y - .13, z + .185), 1.64, .18, .06);
  }
  for (const x of [-.95, .95]) {
    b.beam('frame', V(x, -1.02, -5.5), V(x, -.08, -3.28), .19, .16);
    const p = bungalowPoint(x, 0, -5.45), bottom = groundHeight(p.x, p.z) - bungalowFloorY - .08;
    b.beam('frame', V(x, bottom, -5.45), V(x, -.87, -5.45), .17, .17);
  }
}

function walls(b: Builder) {
  // Openings are absent geometry, so doorways and windows need no collision exceptions.
  for (const side of [-1, 1]) {
    b.box('plaster', V(side * 1.665, WALL / 2, FRONT), 1.77, WALL, .15, true, 0);
    b.box('plaster', V(side * HALF, .52, .65), .15, 1.04, 4.4, true, 0);
    b.box('plaster', V(side * HALF, 2.47, .65), .15, .54, 4.4, true, 0);
    for (const [near, far] of [[FRONT, -.575], [1.175, BACK]]) b.box('plaster', V(side * HALF, 1.62, (near + far) / 2), .15, 1.16, far - near, true, 0);
  }
  b.box('plaster', V(0, 2.515, FRONT), 1.56, .45, .15, true, 0);
  b.box('plaster', V(0, .55, BACK), 5.1, 1.1, .15, true, 0);
  b.box('plaster', V(0, 2.52, BACK), 5.1, .44, .15, true, 0);
  for (const [left, right] of [[-HALF, -1.925], [-.275, HALF]]) b.box('plaster', V((left + right) / 2, 1.7, BACK), right - left, 1.2, .15, true, 0);
  for (const x of [-HALF, HALF]) for (const z of [FRONT, BACK]) b.beam('frame', V(x, -.02, z), V(x, WALL + .08, z), .18, .18);
  for (const z of [FRONT, BACK]) {
    b.box('frame', V(0, WALL, z), 5.3, .18, .22);
    if (z === BACK) b.box('frame', V(0, .09, z - .09), 5.05, .16, .04);
  }
  for (const x of [-HALF, HALF]) {
    b.beam('frame', V(x, WALL, FRONT), V(x, WALL, BACK), .18, .22);
    b.beam('frame', V(x * .962, .09, FRONT), V(x * .962, .09, BACK), .16, .045);
  }
  // Deep sills, narrow muntins, and shutters folded back against the plaster.
  for (const side of [-1, 1]) {
    const x = side * (HALF + .025);
    for (const z of [-.59, 1.19]) b.beam('wood', V(x, .98, z), V(x, 2.27, z), .115, .21);
    for (const y of [1.025, 2.235]) b.beam('wood', V(x, y, -.65), V(x, y, 1.25), .1, .24);
    b.beam('wood', V(x, 1.04, .3), V(x, 2.22, .3), .044, .07);
    b.beam('wood', V(x, 1.64, -.575), V(x, 1.64, 1.175), .043, .07);
    b.box('endgrain', V(x, .99, .3), .36, .055, 2.02);
    for (const z of [-.98, 1.58]) {
      b.box('blue', V(x + side * .1, 1.63, z), .065, 1.22, .63);
      for (let row = 0; row < 9; row++) b.box('blue', V(x + side * .145, 1.12 + row * .126, z), .035, .094, .52, false, .004);
      for (const y of [1.065, 2.195]) b.box('wood', V(x + side * .15, y, z), .04, .065, .64, false);
    }
  }
  for (const x of [-1.945, -.255]) b.beam('wood', V(x, 1.04, BACK), V(x, 2.37, BACK), .11, .21);
  for (const y of [1.075, 2.335]) b.box('wood', V(-1.1, y, BACK), 1.86, .1, .24);
  b.box('endgrain', V(-1.1, 1.035, BACK), 1.96, .055, .36);

  for (const x of [-.78, .78]) b.beam('wood', V(x, 0, FRONT - .04), V(x, 2.34, FRONT - .04), .12, .22);
  b.box('wood', V(0, 2.32, FRONT - .04), 1.72, .13, .22);
  b.box('endgrain', V(0, .02, FRONT), 1.55, .04, .28);
  // The blue door stands open inward, leaving a generous, unobstructed entrance.
  const rotation = new THREE.Quaternion().setFromAxisAngle(Y, 1.73), hinge = V(.715, 0, FRONT + .08);
  const doorPart = (material: BungalowMaterial, p: THREE.Vector3, w: number, h: number, d: number) => {
    b.add(new RoundedBoxGeometry(w, h, d, 1, .005), material, p.applyQuaternion(rotation).add(hinge), rotation);
  };
  for (let plank = 0; plank < 6; plank++) doorPart('blue', V(-.12 - plank * .225, 1.13, 0), .22, 2.22, .065);
  for (const x of [-.05, -1.31]) doorPart('blue', V(x, 1.13, -.052), .085, 2.24, .05);
  for (const y of [.07, .79, 2.18]) doorPart('blue', V(-.68, y, -.052), 1.35, .09, .05);
  for (const y of [.34, 1.87]) doorPart('brass', V(-.025, y, .054), .065, .13, .04);
  const knob = V(-1.22, 1.03, -.105).applyQuaternion(rotation).add(hinge);
  b.add(new THREE.SphereGeometry(.043, 12, 8), 'brass', knob, new THREE.Quaternion(), false);
}

function veranda(b: Builder) {
  for (const x of [-2.85, 2.85]) {
    b.beam('frame', V(x, -.06, -3.23), V(x, 2.88, -3.23), .18, .18);
    for (const y of [.12, .98, 2.63]) b.box('endgrain', V(x, y, -3.23), .225, .075, .225);
    b.beam('frame', V(x, 2.22, -3.23), V(x > 0 ? x - .58 : x + .58, 2.76, -3.23), .11, .11);
    b.beam('frame', V(x, 2.22, -3.23), V(x, 2.76, -2.65), .11, .11);
  }
  b.box('frame', V(0, 2.8, -3.23), 5.95, .19, .2);
  const rail = (a: THREE.Vector3, c: THREE.Vector3) => {
    const length = a.distanceTo(c), count = Math.ceil(length / .32);
    for (const y of [.2, .93]) b.beam('wood', a.clone().setY(y), c.clone().setY(y), y > .5 ? .105 : .075, y > .5 ? .15 : .095);
    for (let i = 0; i <= count; i++) {
      const p = a.clone().lerp(c, i / count);
      b.beam('wood', p.clone().setY(.2), p.clone().setY(.92), .064, .064);
    }
  };
  for (const side of [-1, 1]) {
    rail(V(side * 2.85, 0, -3.23), V(side * 1.02, 0, -3.23));
    rail(V(side * 2.85, 0, -3.23), V(side * 2.85, 0, FRONT));
    b.beam('frame', V(side * 1.02, 0, -3.23), V(side * 1.02, 1.02, -3.23), .11, .11);
    b.box('endgrain', V(side * 1.02, 1.03, -3.23), .16, .045, .16);
  }
  // Low reclining chair, ivory cushion, and a little table on the shaded veranda.
  const chair = BUNGALOW_VERANDA_CHAIR;
  for (const x of [chair.x - .37, chair.x + .37]) {
    b.beam('frame', V(x, .04, chair.z - .3), V(x, .52, chair.z - .16), .075, .075);
    b.beam('frame', V(x, .04, chair.z + .83), V(x, 1.05, chair.z + .77), .075, .075);
    b.beam('wood', V(x, .6, chair.z - .25), V(x, .66, chair.z + .79), .075, .07);
    b.beam('wood', V(x, .39, chair.z - .29), V(x, .97, chair.z + .83), .065, .07);
  }
  b.box('linen', V(chair.x, chair.seatY - .065, chair.z), .68, .13, .63, true, .045);
  const back = new RoundedBoxGeometry(.68, .13, .82, 3, .06);
  b.add(back, 'linen', V(chair.x, chair.seatY + .225, chair.z + .53), new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -.58));
  b.box('rug', V(chair.x, chair.seatY + .017, chair.z - .09), .69, .018, .24, false, .005);
  b.cylinder('wood', V(-1.13, .5, -2.09), V(-1.13, .55, -2.09), .28);
  for (let i = 0; i < 3; i++) {
    const angle = i * Math.PI * 2 / 3;
    b.beam('frame', V(-1.13 + Math.cos(angle) * .19, .03, -2.09 + Math.sin(angle) * .19), V(-1.13 + Math.cos(angle) * .12, .51, -2.09 + Math.sin(angle) * .12), .045, .045);
  }
  b.cylinder('ceramic', V(-1.13, .56, -2.09), V(-1.13, .68, -2.09), .045, .055, false);
}

function roof(b: Builder) {
  const lower = [V(-3.65, 2.8, -3.99), V(3.65, 2.8, -3.99), V(3.65, 2.8, 3.57), V(-3.65, 2.8, 3.57)];
  const upper = [V(-.4, 5.08, -.5), V(.4, 5.08, -.5), V(.4, 5.08, .3), V(-.4, 5.08, .3)];
  // Boxed eaves close the overhang down onto the wall plates and veranda beam.
  // Leave the room itself open to the pitched liner above.
  for (const [near, far] of [[lower[0].z, FRONT], [BACK, lower[2].z]]) {
    const rows = Math.ceil((far - near) / .19), depth = (far - near) / rows;
    for (let row = 0; row < rows; row++) {
      b.box('wood', V(0, 2.775, near + (row + .5) * depth), 7.3, .055, depth - .003, true, .003);
    }
  }
  for (const side of [-1, 1]) {
    const width = (3.65 - HALF) / 6;
    for (let plank = 0; plank < 6; plank++) {
      const x = side * (HALF + (plank + .5) * width);
      b.beam('wood', V(x, 2.775, FRONT), V(x, 2.775, BACK), .055, width - .003, true, .003);
    }
    b.beam('frame', V(side * 2.85, 2.71, -3.23), V(side * 2.85, 2.71, BACK), .18, .16);
    // Shallow joists give the veranda ceiling a clear connection to its posts.
    for (const x of [.94, 1.89]) b.beam('frame', V(side * x, 2.71, -3.23), V(side * x, 2.71, FRONT), .105, .095);
  }
  for (let edge = 0; edge < 4; edge++) {
    b.beam('frame', lower[edge].clone().setY(2.77), lower[(edge + 1) % 4].clone().setY(2.77), .18, .105);
  }
  const surface = (points: THREE.Vector3[], indices: number[], material: BungalowMaterial, solid: boolean, tint?: THREE.Color) => {
    const geometry = new THREE.BufferGeometry();
    // All roof sheets wind upward; the material also shades their sheltered undersides.
    const normal = points[indices[1]].clone().sub(points[indices[0]]).cross(points[indices[2]].clone().sub(points[indices[0]]));
    if (normal.y < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(p => p.toArray()), 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    b.add(geometry, material, V(), new THREE.Quaternion(), solid, tint);
  };
  for (let face = 0; face < 4; face++) {
    const next = (face + 1) % 4;
    const point = (u: number, t: number) => lower[face].clone().lerp(lower[next], u).lerp(upper[face].clone().lerp(upper[next], u), t)
      .add(V(0, Math.sin(Math.PI * t) * .13, 0));
    // The liner and rafters follow the same gentle curve as the thatch.
    for (let plank = 0; plank < 22; plank++) {
      const a = plank / 22, c = (plank + 1) / 22;
      for (let segment = 0; segment < 8; segment++) {
        const start = segment / 8, end = (segment + 1) / 8;
        surface([point(a, start), point(c, start), point(c, end), point(a, end)], [0, 1, 2, 0, 2, 3], 'wood', true);
      }
    }
    for (let rafter = 0; rafter < 6; rafter++) {
      const u = rafter / 6;
      for (let segment = 0; segment < 8; segment++) {
        const start = THREE.MathUtils.lerp(.015, .97, segment / 8), end = THREE.MathUtils.lerp(.015, .97, (segment + 1) / 8);
        b.beam('frame', point(u, start).add(V(0, -.07, 0)), point(u, end).add(V(0, -.07, 0)), .13, .105);
      }
    }
    for (let course = 0; course < 8; course++) {
      const tip = course / 8 - .026, root = Math.min(1.02, (course + 1.3) / 8);
      const span = point(0, tip).distanceTo(point(1, tip)), strips = Math.ceil(span / .105);
      for (let strip = 0; strip < strips; strip++) {
        const center = (strip + .5) / strips, width = (1.05 + b.random() * .2) / strips;
        const end = tip - b.random() * .025, points: THREE.Vector3[] = [], indices: number[] = [];
        for (let row = 0; row <= 4; row++) for (let across = 0; across < 3; across++) {
          const f = row / 4, u = center + (across - 1) * width / 2;
          const t = THREE.MathUtils.lerp(root, end + (row === 4 && across !== 1 ? .01 + b.random() * .012 : 0), f);
          const p = point(u, t);
          p.y += .04 + f ** 1.7 * .18 + Math.sin(f * Math.PI) * .025 + (across === 1 ? .019 : 0) - f ** 5 * .02;
          points.push(p);
          if (row < 4 && across < 2) {
            const i = row * 3 + across;
            indices.push(i, i + 1, i + 3, i + 1, i + 4, i + 3);
          }
        }
        const shade = .38 + b.random() * .56;
        surface(points, indices, 'thatch', false, new THREE.Color().setRGB(shade, shade, shade));
        if (course === 0 && strip % 3 === 0) {
          const a = points[9].clone(), c = points[13].clone().add(V(0, -.06 - b.random() * .04, 0));
          b.cylinder('thatch', a, c, .009, .003, false);
        }
      }
    }
  }
  b.box('thatch', V(0, 5.12, -.1), .87, .18, .88, false, .045);
  for (let bundle = 0; bundle < 11; bundle++) b.cylinder('thatch', V(-.39 + bundle * .078, 5.2, -.56), V(-.39 + bundle * .078, 5.2, .37), .045, .04, false);
  // A small woven collar binds the clipped crown of the hipped roof.
  for (const z of [-.33, .16]) b.beam('rope', V(-.45, 5.22, z), V(.45, 5.22, z), .025, .032, false);
}

function interior(b: Builder, root: THREE.Group) {
  const { x: bedX, z: bedZ, mattressY, pillowZ } = BUNGALOW_BED;
  for (const x of [bedX - .72, bedX + .72]) for (const z of [bedZ - 1.02, bedZ + 1.02]) b.beam('frame', V(x, .015, z), V(x, .48, z), .095, .095);
  b.box('wood', V(bedX, .35, bedZ), 1.64, .2, 2.19);
  b.box('linen', V(bedX, mattressY - .15, bedZ), 1.6, .3, 2.14, true, .09);
  for (let slat = 0; slat < 8; slat++) b.box('wood', V(bedX - .72 + slat * .205, .85, 2.58), .193, .76, .07);
  b.box('frame', V(bedX, 1.235, 2.58), 1.69, .075, .095);
  for (const x of [bedX - .4, bedX + .4]) {
    const pillow = new RoundedBoxGeometry(.68, .17, .47, 3, .08);
    b.add(pillow, 'linen', V(x, mattressY + .08, pillowZ), new THREE.Quaternion().setFromAxisAngle(Y, (b.random() - .5) * .12));
  }
  b.box('rug', V(bedX, .745, .95), 1.615, .024, 1.04, false, .008);
  for (const x of [bedX - .812, bedX + .812]) b.box('rug', V(x, .61, .95), .026, .29, 1.04, false, .008);
  b.box('rug', V(.47, .012, -.13), 1.72, .024, 1.33, false, .01);
  for (const x of [-.29, 1.23]) b.box('linen', V(x, .026, -.13), .027, .004, 1.23, false, .001);
  for (let fringe = 0; fringe < 30; fringe++) for (const z of [-.81, .55]) b.beam('linen', V(-.37 + fringe * .057, .018, z), V(-.37 + fringe * .057, .018, z + Math.sign(z) * .07), .008, .013, false, .002);

  const table = (x: number, z: number, width: number, depth: number, height: number) => {
    b.box('wood', V(x, height, z), width, .07, depth);
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) b.beam('frame', V(x + dx * (width / 2 - .075), .02, z + dz * (depth / 2 - .075)), V(x + dx * (width / 2 - .075), height, z + dz * (depth / 2 - .075)), .075, .075);
  };
  table(-.03, 2.15, .62, .59, .56);
  b.box('wood', V(-.03, .2, 2.15), .52, .06, .47);
  b.cylinder('ceramic', V(-.03, .6, 2.15), V(-.03, .87, 2.15), .11, .06, false);
  b.cylinder('brass', V(-.03, .85, 2.15), V(-.03, 1.04, 2.15), .015, .015, false);
  b.cylinder('paper', V(-.03, .98, 2.15), V(-.03, 1.3, 2.15), .23, .12, false);
  const lamp = new THREE.PointLight('#ffd6a1', 3.2, 4.8, 2);
  lamp.name = 'Bungalow · warm bedside lamp';
  lamp.position.copy(bungalowPoint(-.03, bungalowFloorY + 1.12, 2.15));
  root.add(lamp);
  table(-1.86, 1.48, .76, 1.05, .75);
  for (let book = 0; book < 3; book++) b.box(book === 1 ? 'linen' : 'blue', V(-1.86, .811 + book * .037, 1.75), .24 + book * .025, .032, .34, false);
  b.box('paper', V(-1.88, .792, 1.31), .35, .008, .26, false, .001);
  const chair = BUNGALOW_CHAIR;
  table(chair.x, chair.z, .48, .5, chair.seatY - .035);
  for (const x of [chair.x - .22, chair.x + .22]) b.beam('frame', V(x, .43, chair.z - .26), V(x, .96, chair.z - .23), .045, .045);
  for (const y of [.72, .88]) b.box('wood', V(chair.x, y, chair.z - .24), .47, .1, .045);

  // A living plant in a sandy ceramic pot softens the room's back corner.
  b.cylinder('ceramic', V(-2.01, .02, 2.4), V(-2.01, .39, 2.4), .17, .24);
  b.cylinder('soil', V(-2.01, .37, 2.4), V(-2.01, .385, 2.4), .211, .211, false);
  const plant = createPottedPlant('heart leaf', .73, .49, 80331);
  plant.position.copy(bungalowPoint(-2.01, bungalowFloorY + .38, 2.4));
  plant.rotation.y = BUNGALOW.yaw;
  root.add(plant);
  // Framed ocean print, made of flat colored shapes rather than an image download.
  b.box('frame', V(1.4, 1.99, BACK - .11), .7, .89, .035, false);
  const panel = new THREE.PlaneGeometry(.61, .79);
  panel.rotateY(Math.PI);
  b.add(panel, 'art', V(1.4, 1.99, BACK - .133), new THREE.Quaternion(), false, new THREE.Color('#7db1c9'));
  const sun = new THREE.CircleGeometry(.094, 24); sun.rotateY(Math.PI);
  b.add(sun, 'art', V(1.56, 2.18, BACK - .139), new THREE.Quaternion(), false, new THREE.Color('#f4dab0'));
  const island = new THREE.Shape(); island.moveTo(-.3, -.23); island.quadraticCurveTo(-.05, .14, .2, -.13); island.lineTo(.3, -.26); island.lineTo(.3, -.33); island.lineTo(-.3, -.33);
  const silhouette = new THREE.ShapeGeometry(island); silhouette.rotateY(Math.PI);
  b.add(silhouette, 'art', V(1.4, 1.99, BACK - .141), new THREE.Quaternion(), false, new THREE.Color('#397f92'));
}

function surfboard(b: Builder) {
  const outline = new THREE.Shape();
  outline.moveTo(0, 1.22); outline.bezierCurveTo(.24, 1.12, .35, .44, .31, -.23);
  outline.bezierCurveTo(.29, -.75, .18, -1.07, .11, -1.16); outline.quadraticCurveTo(0, -1.2, -.11, -1.16);
  outline.bezierCurveTo(-.18, -1.07, -.29, -.75, -.31, -.23); outline.bezierCurveTo(-.35, .44, -.24, 1.12, 0, 1.22);
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: .046, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: .024, bevelThickness: .018, curveSegments: 18 });
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.14, -.12, -.045));
  const tilted = geometry.clone().applyQuaternion(rotation);
  tilted.computeBoundingBox();
  const bounds = tilted.boundingBox!;
  // Rest the actual beveled tail on the deck and the nose against the front wall.
  // Keeping the whole board on the veranda avoids crossing the platform's fascia.
  const center = V(1.78, .008 - bounds.min.y, FRONT - .075 - .006 - bounds.max.z);
  tilted.dispose();
  b.add(geometry, 'blue', center, rotation);
  const stripe = new THREE.Shape();
  stripe.moveTo(0, -1.07); stripe.quadraticCurveTo(.025, -.96, .025, -.82);
  stripe.lineTo(.016, .84); stripe.quadraticCurveTo(.012, .99, 0, 1.04);
  stripe.quadraticCurveTo(-.012, .99, -.016, .84); stripe.lineTo(-.025, -.82);
  stripe.quadraticCurveTo(-.025, -.96, 0, -1.07);
  const inlay = new THREE.ShapeGeometry(stripe);
  // Front of the board faces the beach; two ivory pinstripes follow its long axis.
  inlay.rotateY(Math.PI);
  for (const dx of [-.095, .095]) b.add(inlay.clone(), 'linen', V(dx, 0, -.022).applyQuaternion(rotation).add(center), rotation, false);
  inlay.dispose();
}

/** The beach cottage: open veranda, airy room, and hand-laid palm thatch. */
export function createBungalow(timber: TimberMaterials, collisions: IslandCollisions) {
  const root = new THREE.Group();
  root.name = 'The beach bungalow';
  const placement = new THREE.Matrix4().compose(V(BUNGALOW.x, bungalowFloorY, BUNGALOW.z),
    new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), BUNGALOW.yaw), V(1, 1, 1));
  const builder = new PartBuilder(createBungalowMaterials(timber), { seed: 190823, collisions, placement });
  foundation(builder); walls(builder); veranda(builder); roof(builder); interior(builder, root); surfboard(builder);
  builder.build(root);
  return root;
}
