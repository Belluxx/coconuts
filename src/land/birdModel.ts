import * as THREE from 'three/webgpu';
import { TAU, V } from '../math';

const clamp = THREE.MathUtils.clamp;
const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));
const IVORY = new THREE.Color('#f0eedf'), WHITE = new THREE.Color('#faf8ed');
const PEARL = new THREE.Color('#c5cfca'), SAGE = new THREE.Color('#aebfba'), SILVER = new THREE.Color('#d6ddd5');
const CAP = new THREE.Color('#293d42'), DARK = new THREE.Color('#142a30');
const BILL = new THREE.Color('#64685e'), FOOT = new THREE.Color('#696f5c');
const EYELID = new THREE.Color('#727e70'), PRIMARY = new THREE.Color('#536e69');

/** Small sculpting primitives; all design coordinates are +Y up, +Z toward the bill. */
class Sculpture {
  vertices: THREE.Vector3[] = [];
  colors: THREE.Color[] = [];
  private faces: number[][] = [];

  vertex(position: THREE.Vector3, tint: THREE.Color) {
    this.vertices.push(position.clone()); this.colors.push(tint);
    return this.vertices.length - 1;
  }

  face(vertices: number[], reverse = false) {
    this.faces.push(reverse ? [...vertices].reverse() : vertices);
  }

  surface(rings: THREE.Vector3[][], colors: THREE.Color[][], close = true, reverse = false) {
    const rows = rings.map((ring, i) => ring.map((point, j) => this.vertex(point, colors[i][j])));
    const n = rows[0].length;
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < (close ? n : n - 1); j++) {
      const k = (j + 1) % n, a = rows[i], b = rows[i + 1];
      this.face([a[j], a[k], b[k], b[j]], reverse);
    }
    return rows;
  }

  ellipsoid(center: THREE.Vector3, radius: THREE.Vector3, tint: THREE.Color, segments = 16, rings = 10) {
    const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
    for (let i = 0; i <= rings; i++) {
      const lat = -Math.PI / 2 + Math.PI * i / rings;
      const row: THREE.Vector3[] = [];
      for (let j = 0; j < segments; j++) {
        const a = j * TAU / segments;
        row.push(V(center.x + radius.x * Math.cos(lat) * Math.cos(a),
          center.y + radius.y * Math.sin(lat), center.z + radius.z * Math.cos(lat) * Math.sin(a)));
      }
      rows.push(row); colors.push(Array(segments).fill(tint));
    }
    this.surface(rows, colors, true, true);
  }

  tube(points: THREE.Vector3[], radii: number[], tint: THREE.Color, sides = 7) {
    const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
    for (let i = 0; i < points.length; i++) {
      const direction = points[Math.min(i + 1, points.length - 1)].clone().sub(points[Math.max(i - 1, 0)]).normalize();
      const right = direction.clone().cross(V(1, 0, 0));
      if (right.length() < .01) right.copy(direction).cross(V(0, 1, 0));
      right.normalize();
      const up = direction.clone().cross(right).normalize();
      rows.push(Array.from({ length: sides }, (_, j) => points[i].clone()
        .addScaledVector(right, radii[i] * Math.cos(j * TAU / sides))
        .addScaledVector(up, radii[i] * Math.sin(j * TAU / sides))));
      colors.push(Array(sides).fill(tint));
    }
    const indices = this.surface(rows, colors);
    this.face(indices[0], true); this.face(indices[indices.length - 1]);
  }

  /** A rounded shoulder, raised rachis, and fine curved tip around a full feather hull. */
  feather(start: THREE.Vector3, end: THREE.Vector3, width: number, tint: THREE.Color,
    depth = .004, bend = .005, steps = 9) {
    const normal = V(0, 1, 0), axis = end.clone().sub(start).normalize();
    const lateral = normal.clone().cross(axis).normalize();
    const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, fullness = Math.max(.001, Math.sin(Math.PI * t)) ** .65 * (1 - .32 * t);
      const center = start.clone().lerp(end, t).addScaledVector(normal, Math.sin(Math.PI * t) * bend);
      const row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
      for (let j = 0; j < 8; j++) {
        const a = j * TAU / 8, cross = Math.cos(a);
        row.push(center.clone().addScaledVector(lateral, width * fullness * cross)
          .addScaledVector(normal, depth * fullness * Math.sin(a)));
        tints.push(mix(tint, WHITE, .12 * Math.abs(cross) + .045 * t));
      }
      rows.push(row); colors.push(tints);
    }
    this.surface(rows, colors);
  }

  finish(name: string, pivot = V()) {
    const normals = this.vertices.map(() => V()), triangles: number[] = [];
    const faceNormal = V(), before = V(), after = V();
    for (const face of this.faces) {
      // Angle-weighted polygon normals keep the original sculpted smoothing,
      // independent of the diagonal used to triangulate each curved quad.
      faceNormal.set(0, 0, 0);
      for (let j = 0; j < face.length; j++) {
        const a = this.vertices[face[j]], b = this.vertices[face[(j + 1) % face.length]];
        faceNormal.x += (a.y - b.y) * (a.z + b.z);
        faceNormal.y += (a.z - b.z) * (a.x + b.x);
        faceNormal.z += (a.x - b.x) * (a.y + b.y);
      }
      faceNormal.normalize();
      for (let j = 0; j < face.length; j++) {
        const center = this.vertices[face[j]];
        // Feather tips and spherical poles collapse a ring into one point.
        // Skip coincident corners so those vertices still receive the normal
        // of their surviving triangle instead of an unlit zero vector.
        for (let offset = 1; offset < face.length; offset++) {
          before.copy(this.vertices[face[(j + face.length - offset) % face.length]]).sub(center);
          if (before.lengthSq() > 1e-20) break;
        }
        for (let offset = 1; offset < face.length; offset++) {
          after.copy(this.vertices[face[(j + offset) % face.length]]).sub(center);
          if (after.lengthSq() > 1e-20) break;
        }
        const length = before.length() * after.length();
        if (length > 1e-18) normals[face[j]].addScaledVector(faceNormal, Math.acos(clamp(before.dot(after) / length, -1, 1)));
      }
      if (face.length === 4 && this.vertices[face[1]].distanceToSquared(this.vertices[face[3]])
        < this.vertices[face[0]].distanceToSquared(this.vertices[face[2]])) {
        triangles.push(face[0], face[1], face[3], face[1], face[2], face[3]);
      } else {
        for (let j = 1; j < face.length - 1; j++) triangles.push(face[0], face[j], face[j + 1]);
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.name = name;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.vertices.flatMap(p => p.clone().sub(pivot).toArray()), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals.flatMap(n => n.normalize().toArray()), 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors.flatMap(color => color.toArray()), 3));
    geometry.setIndex(triangles); geometry.computeBoundingSphere();
    return geometry;
  }
}

function createBody() {
  const body = new Sculpture();
  const profiles = [
    [-.237, .000, .002, .002], [-.219, .003, .029, .026], [-.186, .004, .051, .044],
    [-.142, .004, .067, .065], [-.093, .002, .079, .083], [-.041, .000, .083, .096],
    [.008, .000, .081, .098], [.055, .005, .077, .092], [.098, .015, .068, .082],
    [.133, .033, .055, .073], [.163, .046, .047, .065], [.192, .048, .042, .055],
    [.217, .049, .032, .041], [.233, .049, .006, .012],
  ];
  const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
  for (const [z, y, rx, ry] of profiles) {
    const row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
    for (let j = 0; j < 28; j++) {
      const theta = j * TAU / 28;
      row.push(V(rx * Math.cos(theta), y + ry * Math.sin(theta), z));
      const dorsal = Math.max(0, (Math.sin(theta) - .45) / .55) * clamp((.16 - z) / .16, 0, 1);
      tints.push(mix(IVORY, PEARL, dorsal * .83));
    }
    rows.push(row); colors.push(tints);
  }
  body.surface(rows, colors);
  return body.finish('Body');
}

function createHead() {
  const head = new Sculpture(), pivot = V(0, .077, .195);
  const point = (x: number, y: number, z: number) => V(x, y, z).add(pivot);
  const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
  for (const degrees of [-90, -77, -64, -51, -38, -25, -12, 0, 7.8, 8, 18, 30, 43, 57, 72, 90]) {
    const lat = degrees * Math.PI / 180, row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
    for (let j = 0; j < 32; j++) {
      const a = j * TAU / 32;
      const x = .062 * Math.cos(lat) * Math.cos(a);
      const z = .087 * Math.cos(lat) * Math.sin(a) - .027 * Math.max(0, -Math.sin(lat)) ** 1.1;
      const y = .065 * Math.sin(lat) + (.007 + .010 * Math.sin(a)) * Math.cos(lat) ** 2;
      row.push(point(x, y, z));
      tints.push(degrees >= 8 ? mix(CAP, DARK, Math.max(0, Math.sin(a)) * .2) : WHITE);
    }
    rows.push(row); colors.push(tints);
  }
  head.surface(rows, colors, true, true);
  const billRows: THREE.Vector3[][] = [], billColors: THREE.Color[][] = [];
  for (const [z, y, rx, ry] of [[.061, -.016, .022, .017], [.087, -.014, .017, .014],
    [.122, -.013, .012, .010], [.162, -.016, .007, .006], [.198, -.020, .0006, .0007]]) {
    const row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
    for (let j = 0; j < 10; j++) {
      const a = j * TAU / 10;
      row.push(point(rx * Math.cos(a), y + ry * Math.sin(a), z));
      tints.push(mix(BILL, DARK, .15 + .5 * Math.max(0, (z - .10) / .10)));
    }
    billRows.push(row); billColors.push(tints);
  }
  head.surface(billRows, billColors);
  for (const side of [-1, 1]) {
    head.tube([point(side * .020, -.017, .071), point(side * .0145, -.016, .105),
      point(side * .007, -.017, .157), point(side * .0007, -.020, .195)], [.0008, .0008, .00065, .0002], DARK, 5);
    head.ellipsoid(point(side * .0593, 0, .026), V(.0032, .0070, .0080), EYELID, 12, 8);
    head.ellipsoid(point(side * .0615, 0, .026), V(.0029, .0055, .0062), DARK, 12, 8);
    head.ellipsoid(point(side * .0638, .0020, .0280), V(.0009, .0012, .0013), WHITE, 8, 5);
    head.ellipsoid(point(side * .015, -.010, .094), V(.0011, .0013, .0033), DARK, 8, 5);
  }
  return head.finish('Head', pivot);
}

function createTail() {
  const tail = new Sculpture();
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const spread = (i + .5) / 4;
    tail.feather(V(side * (.009 + i * .008), .002 + i * .001, -.168),
      V(side * (.015 + spread ** 1.25 * .078), -.010 + i * .002, -.284 - spread ** 1.8 * .147),
      .020 - i * .0018, mix(IVORY, SILVER, .09 + i * .025), .0026, .002);
  }
  return tail.finish('Tail');
}

/** Hermite interpolation gives the silhouette a continuous sweep between landmarks. */
function smoothSections(sections: number[][], count: number) {
  return Array.from({ length: count + 1 }, (_, step) => {
    const x = sections[0][0] + (sections[sections.length - 1][0] - sections[0][0]) * step / count;
    let i = sections.findIndex((section, j) => j > 0 && section[0] >= x) - 1;
    if (i < 0) i = sections.length - 2;
    const a = sections[i], b = sections[i + 1];
    const prev = sections[Math.max(0, i - 1)], after = sections[Math.min(sections.length - 1, i + 2)];
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, ...a.slice(1).map((_, offset) => {
      const k = offset + 1;
      const slopeA = (b[k] - prev[k]) / (b[0] - prev[0]) * (b[0] - a[0]);
      const slopeB = (after[k] - a[k]) / (after[0] - a[0]) * (b[0] - a[0]);
      return (2 * t ** 3 - 3 * t * t + 1) * a[k] + (t ** 3 - 2 * t * t + t) * slopeA
        + (-2 * t ** 3 + 3 * t * t) * b[k] + (t ** 3 - t * t) * slopeB;
    })];
  });
}

function createFlightWing(side: number, outer: boolean) {
  const wing = new Sculpture();
  const sections = outer ? [
    [.374, .056, -.200, .002], [.4, .045, -.205, -.0015], [.49, .002, -.222, -.009],
    [.59, -.067, -.255, -.010], [.69, -.150, -.291, -.004], [.78, -.238, -.330, .004], [.86, -.344, -.359, .012],
  ] : [
    [0, .089, -.123, 0], [.065, .113, -.135, .014], [.14, .124, -.147, .023],
    [.22, .115, -.165, .024], [.30, .088, -.187, .016], [.4, .045, -.205, 0], [.427, .032, -.210, -.002],
  ];
  const top: THREE.Vector3[][] = [], bottom: THREE.Vector3[][] = [];
  const colorsTop: THREE.Color[][] = [], colorsBottom: THREE.Color[][] = [];
  for (const [x, leading, trailing, ridge] of smoothSections(sections, outer ? 35 : 28)) {
    const upper: THREE.Vector3[] = [], lower: THREE.Vector3[] = [];
    const tintsUpper: THREE.Color[] = [], tintsLower: THREE.Color[] = [];
    const phase = (x - (outer ? .4 : 0)) / (outer ? .065 : .055) * TAU;
    const scallop = .5 - .5 * Math.cos(phase);
    for (let j = 0; j < 13; j++) {
      const t = j / 12, z = leading * (1 - t) + (trailing + scallop * .0045) * t;
      const thickness = outer ? .018 - .006 * clamp((x - .40) / .12, 0, 1) : .018;
      const camber = Math.sin(t * Math.PI) * thickness;
      const rib = scallop * .0018 * Math.max(0, (t - .35) / .65);
      const y = .037 + ridge + camber + rib;
      // The arm's softly scalloped sleeve hides the moving hand's proximal edge.
      const overlap = outer ? 0 : Math.max(0, (x - .36) / .067) ** 2
        * (.003 * Math.sin(t * Math.PI) + .001 * Math.sin(t * Math.PI * 6));
      upper.push(V(side * (.064 + x + overlap), y, .005 + z));
      lower.push(V(side * (.064 + x + overlap), y - .006 * Math.sin(t * Math.PI) - .0015, .005 + z));
      let shade = mix(PEARL, IVORY, Math.max(0, (t - .68) / .32) * .8);
      shade = mix(shade, SAGE, Math.max(0, Math.cos(phase)) ** 10 * .42 * Math.max(0, (t - .32) / .68));
      if (outer) shade = mix(shade, PRIMARY, Math.max(0, (x - .58) / .28) * Math.max(0, (t - .32) / .68) * .82);
      tintsUpper.push(shade); tintsLower.push(mix(IVORY, WHITE, .4));
    }
    top.push(upper); bottom.push(lower); colorsTop.push(tintsUpper); colorsBottom.push(tintsLower);
  }
  const up = wing.surface(top, colorsTop, false, side > 0);
  const down = wing.surface(bottom, colorsBottom, false, side < 0);
  for (let i = 0; i < up.length - 1; i++) {
    const a = up[i], b = up[i + 1], c = down[i], d = down[i + 1];
    wing.face([a[0], c[0], d[0], b[0]], side < 0);
    wing.face([a[12], b[12], d[12], c[12]], side < 0);
  }
  for (const i of [0, up.length - 1]) for (let j = 0; j < 12; j++) {
    // Separate end-cap vertices prevent their sideways normals from darkening
    // the flight surface at the articulated elbow.
    const cap = [up[i][j], down[i][j], down[i][j + 1], up[i][j + 1]]
      .map(k => wing.vertex(wing.vertices[k], wing.colors[k]));
    wing.face(cap, i === 0 ? side > 0 : side < 0);
  }
  return wing.finish(`Wing${outer ? 'Outer' : 'Inner'}${side < 0 ? 'L' : 'R'}`, V(side * (outer ? .464 : .064), .037, .005));
}

function createFoldedWing(side: number) {
  const folded = new Sculpture();
  const profile = [
    [.113, .060, .034, .003, .004], [.084, .067, .039, .026, .031], [.041, .074, .033, .033, .047],
    [-.014, .077, .019, .035, .058], [-.075, .075, .011, .033, .057], [-.132, .072, .009, .029, .043],
    [-.188, .065, .009, .023, .029], [-.242, .054, .008, .015, .014], [-.299, .039, .005, .001, .002],
  ];
  const rows: THREE.Vector3[][] = [], colors: THREE.Color[][] = [];
  for (const [z, x, y, rx, ry] of profile) {
    const row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
    for (let j = 0; j < 20; j++) {
      const a = j * TAU / 20;
      row.push(V(side * (x + rx * Math.cos(a)), y + ry * Math.sin(a), z));
      tints.push(mix(PEARL, SILVER, .3 + .22 * Math.sin(a)));
    }
    rows.push(row); colors.push(tints);
  }
  folded.surface(rows, colors, true, side > 0);
  const point = (z: number, angle: number, elevation: number) => {
    let i = profile.findIndex((section, j) => j > 0 && section[0] <= z) - 1;
    if (i < 0) i = profile.length - 2;
    const a = profile[i], b = profile[i + 1], t = (z - a[0]) / (b[0] - a[0]);
    const [, x, y, rx, ry] = a.map((value, k) => value + (b[k] - value) * t);
    return V(side * (x + (rx + elevation) * Math.cos(angle)), y + (ry + elevation) * Math.sin(angle), z);
  };
  // Each vane follows the convex mantle, with nested tips and attached roots.
  for (let layer = 0; layer < 2; layer++) for (let f = 0; f < (layer === 0 ? 5 : 4); f++) {
    const featherRows: THREE.Vector3[][] = [], featherColors: THREE.Color[][] = [];
    const angle = -.85 + f * .37 + layer * .13;
    const start = .067 - layer * .132 - f * .004, end = -.134 - layer * .122 + f * .006;
    for (let step = 0; step < 12; step++) {
      const t = step / 11, z = start + (end - start) * t, width = Math.sin(Math.PI * t) ** .6 * .21;
      const row: THREE.Vector3[] = [], tints: THREE.Color[] = [];
      for (let j = 0; j < 8; j++) {
        const a = j * TAU / 8;
        row.push(point(z, angle + Math.cos(a) * width, .0008 + Math.sin(Math.PI * t) * (.0015 + Math.sin(a) * .0011)));
        const tint = mix(SILVER, SAGE, .10 + layer * .13 + (f % 2) * .06);
        tints.push(mix(tint, IVORY, Math.abs(Math.cos(a)) * .12));
      }
      featherRows.push(row); featherColors.push(tints);
    }
    folded.surface(featherRows, featherColors, true, side < 0);
  }
  return folded.finish(`FoldedWing${side < 0 ? 'L' : 'R'}`);
}

function createFeet() {
  const feet = new Sculpture();
  for (const side of [-1, 1]) {
    const x = side * .030;
    feet.tube([V(x, -.072, -.014), V(x, -.115, -.034), V(x, -.147, -.025), V(x, -.207, .006)],
      [.0055, .0047, .0048, .0040], FOOT);
    feet.ellipsoid(V(x, -.151, -.023), V(.0051, .0060, .0055), FOOT, 8, 6);
    for (const i of [-1, 0, 1]) {
      const tip = V(x + i * .024, -.222, .055 - Math.abs(i) * .012);
      feet.tube([V(x, -.207, .006), V(x + i * .015, -.219, .026), tip], [.0038, .0030, .0018], FOOT, 6);
      feet.tube([tip, V(tip.x + i * .002, -.225, tip.z + .005)], [.0018, .0004], DARK, 5);
    }
    feet.tube([V(x, -.210, .004), V(x + side * .006, -.223, -.023), V(x + side * .007, -.225, -.028)],
      [.0035, .0023, .0004], FOOT, 6);
  }
  return feet.finish('Feet');
}

/** Ten shared, pivot-local rig parts, built once for the entire island population. */
export function createBirdGeometries() {
  return [createBody(), createHead(), createTail(),
    createFlightWing(-1, false), createFlightWing(-1, true),
    createFlightWing(1, false), createFlightWing(1, true), createFeet(),
    createFoldedWing(-1), createFoldedWing(1)];
}
