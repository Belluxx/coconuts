import * as THREE from 'three/webgpu';
import { seededRandom, smoothstep, TAU, V } from '../math';
import { FoliageSurface, leaf, splitBlade, stem, type LeafShape, type Wind } from './foliage';
import { groundHeight } from './terrain';

const GOLDEN = 2.3999632297;
const greens = ['#388d39', '#83b92c', '#258350', '#b5d631', '#54a23c'].map(c => new THREE.Color(c));
const bark = new THREE.Color('#94704a');
const palmBark = new THREE.Color('#c39a65');

export type PlantKind = 'palm' | 'sea almond' | 'mango' | 'sea grape' | 'fern' |
  'banana' | 'beach grass' | 'hibiscus' | 'monstera' | 'heart leaf' | 'cordyline' | 'trailing vine';
export type Plant = {
  kind: PlantKind; x: number; y: number; z: number; radius: number; height: number; seed: number;
  alignToSlope?: boolean; hero?: boolean; leanX?: number; leanZ?: number;
  /** Grown at the origin, away from the island's ground (e.g. in a pot). */
  standalone?: boolean;
};
type Surfaces = { bark: FoliageSurface; leaf: FoliageSurface; blossom: FoliageSurface };
export const createPlantSurfaces = (): Surfaces => ({ bark: new FoliageSurface(), leaf: new FoliageSurface(), blossom: new FoliageSurface() });
const twigWind = (height: number, total: number): Wind => [Math.min(1.1, Math.max(0, height / total) ** 2), 0, 0];

function fruit(surface: FoliageSurface, center: THREE.Vector3, radius: number, tint: THREE.Color, wind: Wind, stretch = 1.2) {
  const rows: number[][] = [];
  for (let j = 0; j <= 7; j++) {
    const t = j / 7, row: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const angle = k / 10 * TAU, r = Math.sin(t * Math.PI) * radius;
      const color = tint.clone().multiplyScalar(.88 + Math.cos(angle - .8) * .08 + (1 - t) * .15);
      row.push(surface.vertex(center.clone().add(V(Math.cos(angle) * r, Math.cos(t * Math.PI) * radius * stretch, Math.sin(angle) * r)), color, wind, k / 10, t));
    }
    if (j) for (let k = 0; k < 10; k++) surface.quad(rows[j - 1][k], rows[j - 1][k + 1], row[k + 1], row[k]);
    rows.push(row);
  }
}

/** Each scar has a shallow projecting lip, so the warm trunk reads in silhouette. */
function ringedTrunk(p: Plant, s: Surfaces, point: (t: number) => THREE.Vector3, far: boolean) {
  const scars = Math.max(8, Math.round(p.height * 2.15)), sides = far ? 7 : 10;
  const rows: number[][] = [];
  const samples = far ? [0, .19] : [0, .10, .23];
  for (let n = 0; n <= scars; n++) for (const sample of n === scars ? [0] : samples) {
    const t = (n + sample) / scars, tangent = point(Math.min(1, t + .01)).sub(point(Math.max(0, t - .01))).normalize();
    const side = tangent.clone().cross(V(0, 0, 1)).normalize(), front = side.clone().cross(tangent).normalize();
    const baseRadius = p.height * THREE.MathUtils.lerp(.044, .018, Math.pow(t, .56));
    const radius = baseRadius * (1 + Math.exp(-t * 24) * .2) * (sample === .10 || far && sample === 0 ? 1.07 : 1);
    const center = point(t), row: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = k / sides * TAU, uneven = 1 + Math.sin(a * 3 + n * .25) * .025;
      const tint = palmBark.clone().multiplyScalar((sample === 0 ? .79 : sample === .10 ? 1.13 : 1) * (.96 + Math.cos(a + 1) * .05));
      row.push(s.bark.vertex(center.clone().addScaledVector(side, Math.cos(a) * radius * uneven).addScaledVector(front, Math.sin(a) * radius * uneven), tint, twigWind(t, 1), k / sides, t * p.height, 1));
    }
    if (rows.length) for (let k = 0; k < sides; k++) s.bark.quad(rows[rows.length - 1][k], row[k], row[k + 1], rows[rows.length - 1][k + 1]);
    rows.push(row);
  }
}

function growPalm(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z), h = p.height;
  const point = (t: number) => base.clone().add(V((p.leanX ?? 0) * (t * .28 + t * t * .72), h * t, (p.leanZ ?? 0) * t * t));
  ringedTrunk(p, s, point, far);
  if (!far) for (let k = 0; k < 5; k++) {
    const a = k * TAU / 5 + p.seed, reach = h * .045;
    const x = p.x + Math.cos(a) * reach, z = p.z + Math.sin(a) * reach;
    stem(s.bark, [base.clone().add(V(0, .17, 0)), V(x, p.standalone ? .025 : groundHeight(x, z) - .015, z)], h * .013, .018, palmBark, 5);
  }
  const crown = point(1), phase = random() * TAU, count = p.hero ? 12 : 11;
  for (let f = 0; f < count; f++) {
    const age = f / (count - 1), a = phase + f * GOLDEN;
    const forward = V(Math.cos(a), 0, Math.sin(a)), side = V(-forward.z, 0, forward.x);
    const length = h * (.46 + random() * .085) * (.85 + age * .15);
    const rise = length * (.51 - age * .33), droop = length * (.04 + age * .5);
    const frond = (t: number) => crown.clone().add(V(0, .2 - age * .23, 0)).addScaledVector(forward, length * t)
      .add(V(0, Math.sin(t * Math.PI * .86) * rise - droop * t * t, 0));
    const tint = greens[(f + p.seed) % greens.length].clone();
    const bladeStart = .075;
    const blade = (t: number) => frond(bladeStart + t * (1 - bladeStart));
    splitBlade(s.leaf, blade, side, length, length * (.225 + random() * .025), tint, far ? 7 : 11,
      t => [1, t ** 1.6 * .8, t * .5], { fold: .21, slit: .14 });
    const rachis = Array.from({ length: far ? 6 : 9 }, (_, j) => frond(j / (far ? 5 : 8)));
    stem(s.bark, rachis, h * .0044, .005, tint.clone().lerp(new THREE.Color('#b1bc44'), .36), far ? 4 : 5,
      rachis.map((_, j) => [1, (j / (rachis.length - 1)) ** 1.6 * .8, 0]));
  }
  for (let spear = 0; spear < 2; spear++) {
    const a = phase + spear * 2.8, forward = V(Math.cos(a) * .33, 1, Math.sin(a) * .33).normalize();
    const side = V(-Math.sin(a), 0, Math.cos(a)), length = h * (.24 - spear * .04);
    splitBlade(s.leaf, t => crown.clone().addScaledVector(forward, length * t).add(V(0, -length * .19 * t * t, 0)), side,
      length, length * .18, greens[spear ? 1 : 3], far ? 4 : 7, t => [1, t * .2, t * .25], { slit: .18 });
  }
  for (let n = 0; n < (far ? 3 : 6); n++) {
    const a = phase + n * GOLDEN, radius = h * (.029 + random() * .005);
    const center = crown.clone().add(V(Math.cos(a) * h * .047, -h * (.04 + random() * .02), Math.sin(a) * h * .047));
    const tint = new THREE.Color(n % 3 ? '#9cb42b' : '#c0ba34');
    stem(s.bark, [crown, center], h * .003, h * .0017, greens[1], 4, [[1, 0, 0], [1, 0, 0]]);
    fruit(s.bark, center, radius, tint, [1, 0, 0]);
  }
}

/** Overlapping sprays of actual leaves replace the former closed canopy blobs. */
function growBroadleaf(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z), h = p.height, r = p.radius;
  const shape: LeafShape = p.kind === 'mango' ? 'mango' : p.kind === 'sea almond' ? 'almond' : 'grape';
  const lean = V((random() - .5) * h * .12, 0, (random() - .5) * h * .12);
  const top = base.clone().add(lean).add(V(0, h * .8, 0));
  stem(s.bark, [base, base.clone().lerp(top, .4), top], h * .041, h * .01, bark, far ? 5 : 7,
    [[0, 0, 0], [.18, 0, 0], [.7, 0, 0]]);
  const branchCount = p.kind === 'sea grape' ? 7 : 8;
  for (let b = 0; b < branchCount; b++) {
    const tier = b / (branchCount - 1), angle = p.seed + b * GOLDEN;
    const direction = V(Math.cos(angle), 0, Math.sin(angle));
    const root = base.clone().lerp(top, .35 + tier * .56);
    const tip = base.clone().add(lean).addScaledVector(direction, r * (.69 - tier * .37)).add(V(0, h * (.46 + tier * .4), 0));
    const elbow = root.clone().lerp(tip, .55).add(V(0, r * .12, 0));
    stem(s.bark, [root, elbow, tip], h * .015, h * .0028, bark, far ? 4 : 5,
      [root, elbow, tip].map(v => twigWind(v.y - p.y, h)));
    const tint = greens[(b + p.seed) % 4].clone().lerp(greens[0], .3);
    const sprayCount = far ? 3 : 4;
    for (let spray = 0; spray < sprayCount; spray++) {
      const a = angle + spray * GOLDEN;
      const center = tip.clone().add(V(Math.cos(a) * r * .28, (spray % 2 ? .13 : -.03) * r, Math.sin(a) * r * .28));
      if (!far) stem(s.bark, [elbow, center], h * .004, .006, bark, 4,
        [twigWind(elbow.y - p.y, h), twigWind(center.y - p.y, h)]);
      const blades = far ? 4 : 6;
      for (let l = 0; l < blades; l++) {
        const a = angle + l * GOLDEN + spray * .73;
        const outward = V(Math.cos(a), .36 - l * .13, Math.sin(a)).normalize();
        const length = r * (shape === 'mango' ? .67 : .57) * (.8 + random() * .35) * (far ? 1.18 : 1);
        const start = center.clone().addScaledVector(outward, -length * .16).add(V(0, (l % 3) * r * .07, 0));
        const color = tint.clone().multiplyScalar(.84 + random() * .25);
        leaf(s.leaf, start, outward, length, length * (shape === 'mango' ? .23 : .35), length * .13, color,
          shape, twigWind(start.y - p.y, h), far ? 3 : 4, (random() - .5) * .5);
      }
    }
  }
}

function growFern(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y + .025, p.z);
  for (let f = 0; f < (far ? 6 : 10); f++) {
    const a = f * GOLDEN + p.seed, forward = V(Math.cos(a), 0, Math.sin(a)), side = V(-forward.z, 0, forward.x);
    const length = p.radius * (.8 + random() * .45), lift = p.height * (.7 + random() * .3);
    const point = (t: number) => base.clone().addScaledVector(forward, length * t).add(V(0, Math.sin(t * Math.PI * .76) * lift - t * t * .06, 0));
    const spine = Array.from({ length: 7 }, (_, j) => point(j / 6));
    stem(s.bark, spine, .013, .002, greens[1], 4, spine.map((_, j) => [j / 6 * .17, 0, 0]));
    const pairs = far ? 6 : 11;
    for (let k = 0; k < pairs; k++) {
      const t = .13 + k / pairs * .8, size = length * .25 * Math.sin(t * Math.PI) ** .66;
      for (const sign of [-1, 1]) leaf(s.leaf, point(t), side.clone().multiplyScalar(sign).addScaledVector(forward, .35),
        size, size * .25, size * .09, greens[(f + k) % 3], 'fern', [t * .17, 0, t * .13], far ? 2 : 3);
    }
    leaf(s.leaf, point(.85), forward.clone().add(V(0, .15, 0)), length * .18, length * .03, .03, greens[1], 'fern', [.17, 0, .12], 3);
  }
}

function growBanana(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z), h = p.height;
  const crown = base.clone().add(V(0, h * .71, 0));
  for (let sheath = 0; sheath < 3; sheath++) {
    const a = sheath * GOLDEN + p.seed, offset = V(Math.cos(a) * .055, 0, Math.sin(a) * .055);
    stem(s.bark, [base.clone().add(offset), base.clone().lerp(crown, .48).add(offset), crown], h * .07, h * .022,
      greens[sheath + 1].clone().lerp(palmBark, .21), far ? 4 : 6, [[0, 0, 0], [.1, 0, 0], [.26, 0, 0]]);
  }
  for (let l = 0; l < (far ? 6 : 8); l++) {
    const a = p.seed + l * GOLDEN, age = l / 7, forward = V(Math.cos(a), 0, Math.sin(a)), side = V(-forward.z, 0, forward.x);
    const length = p.radius * (1.34 + random() * .36), root = crown.clone().add(V(0, -age * .31 * h, 0));
    const point = (t: number) => root.clone().addScaledVector(forward, length * t * (.45 + age * .51))
      .add(V(0, length * t * (.93 - age * .72) - length * (.1 + age * .48) * t * t, 0));
    const tint = greens[l % greens.length];
    const blade = (t: number) => point(.19 + t * .81);
    splitBlade(s.leaf, blade, side, length, length * .27, tint, far ? 4 : 7, t => [.26, t * .14, t * .3], { slit: .1, fold: .23 });
    const spine = Array.from({ length: 7 }, (_, j) => point(j / 6));
    stem(s.bark, spine, .027, .004, tint.clone().lerp(greens[3], .35), 4, spine.map((_, j) => [.26, j / 6 * .14, 0]));
  }
  const shootBase = base.clone().add(V(p.radius * .32, 0, p.radius * .17));
  const shoot = shootBase.clone().add(V(0, h * .24, 0));
  stem(s.bark, [shootBase, shoot], h * .043, h * .016, greens[1], 5, [[0, 0, 0], [.12, 0, 0]]);
  for (let l = 0; l < (far ? 2 : 4); l++) {
    const a = p.seed + l * GOLDEN + 1, direction = V(Math.cos(a), .55 + (l % 2) * .3, Math.sin(a)).normalize();
    const size = p.radius * (.75 + l * .07), side = V(-Math.sin(a), 0, Math.cos(a));
    splitBlade(s.leaf, t => shoot.clone().addScaledVector(direction, size * t).add(V(0, -size * .35 * t * t, 0)), side,
      size, size * .25, greens[l % 4], far ? 3 : 5, t => [.12, t * .1, t * .2], { slit: .1 });
  }
}

function growAroid(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y + .02, p.z), split = p.kind === 'monstera';
  for (let l = 0; l < (far ? 5 : 8); l++) {
    const a = p.seed + l * GOLDEN, forward = V(Math.cos(a), (split ? -.55 : -.8) + (l % 3) * .24, Math.sin(a)).normalize();
    const size = p.radius * (.74 + random() * .35), root = base.clone().add(V(Math.cos(a) * size * .27, p.height * (.83 + (l % 3) * .19), Math.sin(a) * size * .27));
    const elbow = base.clone().lerp(root, .58).add(V(0, .12, 0));
    const tint = greens[split ? 2 : l % 3].clone().multiplyScalar(.91 + random() * .12);
    stem(s.bark, [base, elbow, root], .019, .01, greens[1], 5, [[0, 0, 0], [.12, 0, 0], [.25, 0, 0]]);
    if (split) {
      const side = V(-Math.sin(a), 0, Math.cos(a));
      splitBlade(s.leaf, t => root.clone().addScaledVector(forward, size * t).add(V(0, size * (Math.sin(t * Math.PI) * .1 - t * t * .28), 0)),
        side, size, size * .48, tint, far ? 4 : 5, t => [.25, 0, t * .19], { heart: true, perforated: !far, slit: .3, fold: .15 });
    } else leaf(s.leaf, root, forward, size, size * .45, size * .35, tint, 'heart', [.25, 0, 0], far ? 4 : 7, (random() - .5) * .2);
  }
}

function growCordyline(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z);
  const colors = ['#a62555', '#ef4860', '#c72c51', '#703156', '#478335'].map(c => new THREE.Color(c));
  for (let l = 0; l < (far ? 8 : 16); l++) {
    const t = l / 15, a = p.seed + l * GOLDEN;
    const length = p.height * (.74 + random() * .35), direction = V(Math.cos(a) * (.2 + t * .68), 1 - t * .56, Math.sin(a) * (.2 + t * .68)).normalize();
    leaf(s.leaf, base.clone().add(V(0, p.height * (.18 + (1 - t) * .16), 0)), direction, length,
      length * (.13 + t * .03), length * (.06 + t * .45), colors[l % colors.length], 'cordyline', [.12, 0, 0], far ? 4 : 7, (random() - .5) * .45);
  }
}

function flower(s: Surfaces, center: THREE.Vector3, direction: THREE.Vector3, radius: number, tint: THREE.Color, far: boolean) {
  const orientation = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), direction.clone().normalize());
  const transform = (v: THREE.Vector3) => v.multiplyScalar(radius).applyQuaternion(orientation).add(center);
  const throat = new THREE.Color(tint.r > .8 && tint.g > .7 && tint.b > .5 ? '#f4c33a' : '#9b2748');
  const segments = far ? 3 : 5;
  for (let petal = 0; petal < 5; petal++) {
    const a = petal * TAU / 5, rows: number[][] = [];
    for (let j = 0; j <= segments; j++) {
      const t = j / segments, width = Math.sin(t * Math.PI) ** .55 * .56, row: number[] = [];
      for (let k = 0; k <= 4; k++) {
        const u = k / 2 - 1, r = .04 + t * .93;
        const point = V(r * Math.cos(a) - u * width * Math.sin(a), r * Math.sin(a) + u * width * Math.cos(a),
          t * t * .1 + Math.sin(t * Math.PI) * (.09 + u * u * .22));
        const color = tint.clone().lerp(throat, (1 - smoothstep(.06, .44, t)) * .82);
        row.push(s.blossom.vertex(transform(point), color, [.22, 0, .05], k / 4, t));
      }
      if (j) for (let k = 0; k < 4; k++) s.blossom.quad(rows[j - 1][k], rows[j - 1][k + 1], row[k + 1], row[k]);
      rows.push(row);
    }
  }
  stem(s.blossom, [center, transform(V(0, .03, .7))], radius * .035, radius * .022, new THREE.Color('#f7c735'), 5,
    [[.22, 0, 0], [.22, 0, 0]]);
  if (!far) for (let k = 0; k < 5; k++) fruit(s.blossom, transform(V(Math.cos(k * 1.256) * .07, Math.sin(k * 1.256) * .07 + .03, .69)),
    radius * .042, new THREE.Color('#ffcd42'), [.22, 0, 0], 1);
}

function growHibiscus(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z);
  const tint = new THREE.Color(['#f43d48', '#ffca28', '#ff6ba5', '#fff3da'][p.seed % 4]);
  const branches = far ? 6 : 9;
  for (let b = 0; b < branches; b++) {
    const a = p.seed + b * GOLDEN, spread = p.radius * (b === 0 ? .15 : .65);
    const top = base.clone().add(V(Math.cos(a) * spread, p.height * (.55 + random() * .42), Math.sin(a) * spread));
    stem(s.bark, [base, base.clone().lerp(top, .57), top], .025, .009, greens[0], 4, [[0, 0, 0], [.09, 0, 0], [.22, 0, 0]]);
    for (let l = 0; l < (far ? 4 : 7); l++) {
      const angle = a + l * GOLDEN, t = .28 + l / 8 * .65, size = p.radius * (.52 + random() * .12);
      const root = base.clone().lerp(top, t), outward = V(Math.cos(angle), .38, Math.sin(angle));
      leaf(s.leaf, root, outward, size, size * .38, size * .18, greens[(b + l) % 4], 'almond', [t * .22, 0, 0], far ? 3 : 4);
    }
    if (b < (far ? 3 : 5)) flower(s, top, V(Math.cos(a) * .7, .75, Math.sin(a) * .7), p.radius * .36, tint, far);
  }
}

function growGrass(p: Plant, s: Surfaces, far: boolean) {
  const random = seededRandom(p.seed), base = V(p.x, p.y, p.z);
  for (let l = 0; l < (far ? 8 : 17); l++) {
    const a = l * GOLDEN + p.seed, length = p.height * (.65 + random() * .7), spread = .22 + l / 17 * .85;
    leaf(s.leaf, base.clone().add(V(Math.cos(a) * .035, 0, Math.sin(a) * .035)), V(Math.cos(a) * spread, 1, Math.sin(a) * spread),
      length, length * (.035 + random() * .02), length * .3, greens[l % greens.length], 'grass', [0, 0, 0], far ? 3 : 5, (random() - .5) * .4);
  }
}

function growVine(p: Plant, s: Surfaces, far: boolean) {
  const base = V(p.x, p.y + .06, p.z), a = p.seed, forward = V(Math.cos(a), 0, Math.sin(a));
  for (let runner = 0; runner < 3; runner++) {
    const direction = forward.clone().applyAxisAngle(V(0, 1, 0), (runner - 1) * .65);
    const point = (t: number) => {
      const v = base.clone().addScaledVector(direction, p.radius * t * 1.65);
      v.y = p.standalone ? .065 + Math.sin(t * Math.PI) * .1 : groundHeight(v.x, v.z) + .065;
      return v;
    };
    const nodes = far ? 5 : 8, stalk = Array.from({ length: nodes + 1 }, (_, i) => point(i / nodes));
    stem(s.bark, stalk, .017, .006, greens[0], 4);
    for (let l = 0; l < nodes; l++) {
      const t = .08 + l / nodes * .85, side = direction.clone().applyAxisAngle(V(0, 1, 0), (l % 2 ? 1 : -1) * 1.1).add(V(0, .45, 0));
      const size = p.height * (.63 + Math.sin(t * Math.PI) * .3);
      leaf(s.leaf, point(t), side, size, size * .44, size * .16, greens[l % 4], 'heart', [.02, 0, 0], far ? 3 : 5);
      if (!far && l % 4 === 0) flower(s, point(t).add(V(0, .15, 0)), V(0, 1, .1), p.height * .19, new THREE.Color('#fff0d4'), true);
    }
  }
}

export function growPlant(p: Plant, s: Surfaces, far: boolean) {
  const starts = p.alignToSlope ? Object.values(s).map(surface => surface.positions.length) : undefined;
  if (p.kind === 'palm') growPalm(p, s, far);
  else if (p.kind === 'mango' || p.kind === 'sea almond' || p.kind === 'sea grape') growBroadleaf(p, s, far);
  else if (p.kind === 'banana') growBanana(p, s, far);
  else if (p.kind === 'monstera' || p.kind === 'heart leaf') growAroid(p, s, far);
  else if (p.kind === 'cordyline') growCordyline(p, s, far);
  else if (p.kind === 'hibiscus') growHibiscus(p, s, far);
  else if (p.kind === 'trailing vine') { if (!far) growVine(p, s, far); }
  else if (p.kind === 'fern') { if (!far || p.hero) growFern(p, s, far); }
  else if (!far) growGrass(p, s, far);
  if (starts) {
    const base = V(p.x, p.y, p.z), point = V();
    const dx = (groundHeight(p.x + .12, p.z) - groundHeight(p.x - .12, p.z)) / .24;
    const dz = (groundHeight(p.x, p.z + .12) - groundHeight(p.x, p.z - .12)) / .24;
    const orientation = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(-dx, 1, -dz).normalize()), .62);
    Object.values(s).forEach((surface, index) => {
      for (let i = starts[index]; i < surface.positions.length; i += 3) {
        point.fromArray(surface.positions, i).sub(base).applyQuaternion(orientation).add(base);
        surface.positions[i] = point.x; surface.positions[i + 1] = point.y; surface.positions[i + 2] = point.z;
      }
    });
  }
}
