import * as THREE from 'three/webgpu';
import { attribute, color, mix, sin, vec3 } from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { V as v } from '../math';
import { surfaceNoise3D } from '../shading';
import { PartBuilder } from './builder';

const sides = 64;
type Finish = 'hull' | 'interior' | 'blue' | 'wood' | 'darkWood' | 'rope' | 'metal' | 'glass' | 'sail' | 'seam';
type Builder = PartBuilder<Finish>;

function boatMaterials(): Record<Finish, THREE.MeshStandardNodeMaterial> {
  const surface = (name: string, hex: string, roughness: number) => {
    const material = new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
    material.name = `Boats · ${name}`;
    return material;
  };
  const wood = surface('honey teak', '#d5a567', .74);
  const grain = attribute('grain', 'vec3');
  const broad = surfaceNoise3D(grain.mul(vec3(.6, 7, 7)));
  const rings = sin(grain.z.mul(112).add(broad.mul(3))).mul(.04);
  wood.colorNode = mix(color('#b68147'), color('#e5bf81'), broad.mul(.16).add(rings).add(.6));
  const darkWood = wood.clone();
  darkWood.name = 'Boats · shaded timber';
  darkWood.colorNode = mix(color('#986b3c'), color('#bf965f'), broad.mul(.18).add(rings).add(.5));
  const sail = surface('warm ivory sailcloth', '#fff9e7', .94);
  sail.side = THREE.DoubleSide;
  const weave = surfaceNoise3D(grain.mul(95)).mul(.012).add(.988);
  sail.colorNode = color('#fff9e7').mul(weave);
  const metal = surface('brushed bronze fittings', '#b79859', .42);
  metal.metalness = .55;
  const glass = surface('deep blue cabin glazing', '#337789', .21);
  glass.metalness = .18;
  return {
    hull: surface('ivory painted hull', '#f6f7df', .42),
    interior: surface('cream cockpit', '#e7d9b5', .78),
    blue: surface('lagoon blue sheer stripe', '#218fb9', .48),
    wood, darkWood, rope: surface('flax rigging', '#cfb885', .95),
    metal, glass, sail, seam: surface('sail panel stitching', '#d9d8bc', .96),
  };
}

interface Hull { length: number; width: number; rim: number }

function hullPoint(hull: Hull, angle: number, y: number, breadth: number, lengthScale = 1) {
  const fore = Math.cos(angle);
  const sheer = Math.pow(Math.abs(fore), 4) * (fore > 0 ? .25 : .12);
  return v(Math.sin(angle) * hull.width / 2 * (1 - fore * .23) * breadth,
    y + sheer * Math.max(0, y / hull.rim), fore * hull.length / 2 * lengthScale);
}

function ringSurface(hull: Hull, rings: [number, number, number][], reverse = false) {
  const positions: number[] = [], indices: number[] = [];
  for (const [height, breadth, length] of rings) {
    for (let i = 0; i <= sides; i++) positions.push(...hullPoint(hull, i / sides * Math.PI * 2, height, breadth, length).toArray());
  }
  for (let row = 0; row < rings.length - 1; row++) for (let i = 0; i < sides; i++) {
    const a = row * (sides + 1) + i, b = a + sides + 1;
    if (reverse) indices.push(a, b, a + 1, a + 1, b, b + 1);
    else indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const smooth = mergeVertices(geometry, .00001);
  geometry.dispose();
  smooth.computeVertexNormals();
  return smooth;
}

function outline(hull: Hull, y: number, breadth = 1, length = 1) {
  return Array.from({ length: sides }, (_, i) => hullPoint(hull, i / sides * Math.PI * 2, y, breadth, length));
}

function hull(b: Builder, h: Hull) {
  // Several curved stations give the hull a rounded belly, a shallow chine and
  // a lifted bow; the inner skin joins the outer skin at a solid timber gunwale.
  b.add(ringSurface(h, [[-.44, 0, .64], [-.36, .32, .78], [-.13, .65, .89], [.14, .85, .95], [h.rim - .22, .975, .991], [h.rim, 1, 1]]), 'hull');
  b.add(ringSurface(h, [[h.rim - .225, .978, .992], [h.rim - .07, 1.002, 1.001]]), 'blue');
  b.add(ringSurface(h, [[.07, .54, .71], [.16, .77, .87], [h.rim - .015, .925, .957]], true), 'interior');
  b.add(ringSurface(h, [[h.rim, 1, 1], [h.rim - .015, .925, .957]]), 'wood');
  b.tube('wood', outline(h, h.rim + .022, 1.002), .045, 96, 7, true, true);
  b.tube('hull', outline(h, h.rim - .265, .966, .988), .019, 96, 7, true, true);
}

function dinghyFloor(b: Builder, h: Hull) {
  // Cut every floorboard to a curved outline inside the lower hull. Rectangular
  // plank ends would pierce the narrowing bow and stern below the waterline.
  const footprint = outline(h, 0, .59, .7).map(point => new THREE.Vector2(point.x, -point.z));
  const clip = (polygon: THREE.Vector2[], boundary: number, sign: number) => {
    const points: THREE.Vector2[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], c = polygon[(i + 1) % polygon.length];
      const insideA = (a.x - boundary) * sign >= 0, insideC = (c.x - boundary) * sign >= 0;
      if (insideA) points.push(a.clone());
      if (insideA !== insideC) points.push(a.clone().lerp(c, (boundary - a.x) / (c.x - a.x)));
    }
    return points;
  };
  for (let i = -3; i <= 3; i++) {
    const x = i * h.width * .085, halfWidth = h.width * .039;
    const points = clip(clip(footprint, x - halfWidth, 1), x + halfWidth, -1);
    if (points.length < 3) continue;
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points), {
      depth: .052, bevelEnabled: true, bevelSize: .005, bevelThickness: .005, bevelSegments: 2, steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    b.add(geometry, 'wood', v(0, .095, 0));
  }
  for (const ratio of [-.29, -.12, .08, .28]) {
    const z = h.length * ratio;
    const halfWidth = h.width * .43 * Math.sqrt(1 - (ratio * 2) ** 2) * (1 - ratio * .46);
    b.tube('wood', [v(-halfWidth, h.rim - .04, z), v(-halfWidth * .85, .28, z), v(-halfWidth * .5, .145, z), v(halfWidth * .5, .145, z), v(halfWidth * .85, .28, z), v(halfWidth, h.rim - .04, z)], .027);
  }
}

function oar(b: Builder, sign: number) {
  // Built around the oarlock so each oar can sweep and dip independently.
  const root = v(-sign * .48, 0, 0), tip = v(sign * 1.9, 0, 0);
  b.cylinder('wood', root, tip, .039, .032);
  const direction = tip.clone().sub(root).normalize();
  const shape = new THREE.Shape();
  shape.moveTo(-.065, -.32);
  shape.quadraticCurveTo(-.145, -.14, -.13, .26);
  shape.quadraticCurveTo(0, .34, .13, .26);
  shape.quadraticCurveTo(.145, -.14, .065, -.32);
  shape.closePath();
  const blade = new THREE.ExtrudeGeometry(shape, { depth: .026, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .012, bevelThickness: .012, curveSegments: 7 });
  blade.rotateX(Math.PI / 2);
  const turn = new THREE.Quaternion().setFromAxisAngle(v(0, 1), Math.atan2(direction.x, direction.z));
  b.add(blade, 'wood', tip.clone().addScaledVector(direction, .16), turn);
  b.cylinder('darkWood', root, root.clone().addScaledVector(direction, .29), .045);
}

function dinghy(b: Builder, h: Hull) {
  dinghyFloor(b, h);
  for (const z of [-1.03, .85]) {
    const width = h.width * .82 * Math.sqrt(1 - (z / (h.length / 2)) ** 2);
    b.box('wood', v(0, h.rim - .155, z), width, .095, .35, true, .026);
    for (const side of [-1, 1]) b.box('darkWood', v(side * width * .41, .3, z), .07, .34, .3, true, .01);
  }
  for (const side of [-1, 1]) {
    const x = side * h.width * .48;
    b.cylinder('metal', v(x, h.rim, -.04), v(x, h.rim + .14, -.04), .019);
    b.tube('metal', [v(x - .055, h.rim + .17, -.04), v(x, h.rim + .095, -.04), v(x + .055, h.rim + .17, -.04)], .014);
  }
  const rope: THREE.Vector3[] = [];
  for (let i = 0; i <= 100; i++) {
    const angle = i / 25 * Math.PI * 2, radius = .12 + i / 100 * .16;
    rope.push(v(Math.cos(angle) * radius, .182, -1.48 + Math.sin(angle) * radius));
  }
  b.tube('rope', rope, .017, 125);
}

function sail(b: Builder, a: THREE.Vector3, peak: THREE.Vector3, clew: THREE.Vector3, belly: number) {
  const sample = (u: number, w: number) => {
    const foot = 1 - u - w;
    const point = a.clone().multiplyScalar(foot).addScaledVector(peak, u).addScaledVector(clew, w);
    point.x += Math.max(0, foot * u * w) * 27 * belly;
    // Broad tension folds vanish cleanly at the reinforced edges.
    point.x += Math.sin(w * 31 + u * 5) * Math.max(0, foot * u * w) * .35;
    return point;
  };
  const n = 22, positions: number[] = [], indices: number[] = [], rows: number[] = [];
  for (let i = 0; i <= n; i++) {
    rows.push(positions.length / 3);
    for (let j = 0; j <= n - i; j++) positions.push(...sample(i / n, j / n).toArray());
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
    const a = rows[i] + j, c = rows[i + 1] + j;
    indices.push(a, c, a + 1);
    if (j < n - i - 1) indices.push(a + 1, c, c + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  b.add(geometry, 'sail');
  for (const edge of [[a, peak], [peak, clew], [clew, a]]) b.cylinder('sail', edge[0], edge[1], .018);
  for (const u of [.18, .36, .54, .72, .88]) {
    const line = Array.from({ length: 18 }, (_, i) => sample(u, (1 - u) * i / 17).add(v(.006, 0, 0)));
    b.tube('seam', line, .0055, 22);
  }
}

function sailboat(b: Builder, h: Hull) {
  // Foredeck and afterdeck follow the hull outline, with an open, recessed
  // cockpit behind the cabin instead of a sphere pressed through the hull.
  const deckShape = new THREE.Shape();
  const rim = outline(h, 0, .927, .957);
  deckShape.moveTo(rim[0].x, -rim[0].z);
  for (const p of rim.slice(1)) deckShape.lineTo(p.x, -p.z);
  deckShape.closePath();
  const cockpit = new THREE.Path();
  cockpit.moveTo(-.66, 1.03);
  cockpit.lineTo(-.66, 2.87);
  cockpit.quadraticCurveTo(0, 3.15, .66, 2.87);
  cockpit.lineTo(.66, 1.03);
  cockpit.closePath();
  deckShape.holes.push(cockpit);
  const deck = new THREE.ExtrudeGeometry(deckShape, { depth: .085, bevelEnabled: true, bevelSize: .025, bevelThickness: .025, bevelSegments: 2, steps: 1 });
  deck.rotateX(-Math.PI / 2);
  b.add(deck, 'interior', v(0, h.rim - .055, 0));
  for (const side of [-1, 1]) {
    b.box('wood', v(side * .83, .96, -1.99), .33, .15, 2.02, true, .045);
    b.box('interior', v(side * .68, .69, -1.98), .06, .51, 1.93, true, .022);
  }
  b.box('interior', v(0, .69, -1.04), 1.4, .51, .06, true, .025);
  b.box('interior', v(0, .69, -2.96), 1.24, .51, .08, true, .025);
  b.box('wood', v(0, .48, -1.98), 1.25, .065, 1.92, true, .03);
  b.box('wood', v(0, 1.03, -2.93), 1.4, .11, .35, true, .035);
  b.cylinder('wood', v(0, 1.06, -3.36), v(.19, 1.18, -2.33), .035, .045);

  b.box('wood', v(0, 1.13, .68), 1.53, .49, 2.13, true, .12);
  b.box('hull', v(0, 1.435, .68), 1.7, .15, 2.31, true, .073);
  for (const side of [-1, 1]) for (const z of [.04, .67, 1.3]) {
    b.box('hull', v(side * .759, 1.19, z), .038, .275, .46, true, .018);
    b.box('glass', v(side * .781, 1.19, z), .018, .208, .389, true, .009);
  }
  b.box('darkWood', v(0, 1.15, -.399), .64, .37, .028, true, .018);
  b.box('glass', v(0, 1.22, 1.753), .8, .21, .02, true, .007);
  b.box('wood', v(0, 1.542, .27), .66, .065, .76, true, .025);

  const mast = v(0, .94, -.55), top = v(0, 12.8, -.55);
  b.cylinder('wood', mast, top, .081, .043);
  b.cylinder('wood', v(0, 2.05, -.55), v(0, 2.12, -4.03), .067, .049);
  b.cylinder('metal', v(-.52, 8.1, -.55), v(.52, 8.1, -.55), .021);
  for (const z of [-4.1, 4.25]) b.cylinder('rope', v(0, 12.57, -.55), v(0, 1.15, z), .012);
  for (const side of [-1, 1]) b.tube('rope', [v(side * 1.1, 1.07, -.3), v(side * .52, 8.1, -.55), v(0, 12.48, -.55)], .012);
  sail(b, v(.025, 2.24, -.65), v(.025, 12.33, -.65), v(.025, 2.34, -3.91), .48);
  sail(b, v(.04, 1.59, 4.06), v(.04, 11.96, -.35), v(.04, 2.31, -.33), .45);
  b.tube('rope', [v(.035, 2.32, -3.89), v(.05, 1.45, -2.75), v(.47, 1.07, -2.1)], .014);
  // Small pale fenders read clearly against the cyan water at the jetty.
  for (const side of [-1, 1]) for (const z of [-1.15, 1.3]) {
    b.tube('rope', [v(side * 1.19, 1.01, z), v(side * 1.38, .72, z)], .013);
    b.add(new THREE.CapsuleGeometry(.088, .32, 4, 10), 'hull', v(side * 1.39, .51, z));
  }
}

/** The rowboat and the messenger yacht. +Z is the bow; the origin sits at the waterline. */
export function createBoats() {
  const materials = boatMaterials();
  const build = (name: string, dimensions: Hull, fitOut: (b: Builder, hull: Hull) => void) => {
    const root = new THREE.Group();
    root.name = name;
    const builder = new PartBuilder(materials, { bevelSegments: 2 });
    hull(builder, dimensions);
    fitOut(builder, dimensions);
    builder.build(root);
    return root;
  };
  const rowboatHull = { length: 4.9, width: 1.7, rim: .66 };
  const rowboat = build('The little rowboat', rowboatHull, dinghy);
  // Each oar is built around its oarlock so it can sweep and dip independently.
  const oars = [-1, 1].map(side => {
    const pivot = new THREE.Group();
    pivot.position.set(side * rowboatHull.width * .48, rowboatHull.rim + .14, -.04);
    pivot.rotation.y = -side * 1.13;
    const builder = new PartBuilder(materials, { bevelSegments: 2 });
    oar(builder, side);
    builder.build(pivot);
    rowboat.add(pivot);
    return { pivot, side };
  });
  const yacht = build('The messenger yacht', { length: 9, width: 2.7, rim: .95 }, sailboat);
  return { rowboat, oars, yacht };
}
