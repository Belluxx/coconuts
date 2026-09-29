import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { seabedHeight } from '../land/terrain';
import { TAU, V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { PartBuilder } from './builder';
import { PIER, PIER_BENCHES, PIER_ROWBOAT, pierDeckHeight } from './pierLayout';
import type { TimberMaterials } from './timber';

const X = V(1, 0, 0), Y = V(0, 1, 0);
type Builder = PartBuilder<keyof TimberMaterials>;

function bolt(b: Builder, center: THREE.Vector3, axis: THREE.Vector3, radius = .022) {
  b.cylinder('metal', center.clone().addScaledVector(axis, -.003), center.clone().addScaledVector(axis, .004), radius * 1.7, radius * 1.7, false, 12);
  b.cylinder('metal', center, center.clone().addScaledVector(axis, .014), radius, radius, false, 6);
}

function lashing(b: Builder, x: number, y: number, z: number, radius: number, turns = 3) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= turns * 20; i++) {
    const angle = i / 20 * TAU;
    points.push(V(x + Math.cos(angle) * radius, y + i / 20 * .047, z + Math.sin(angle) * radius));
  }
  b.tube('rope', points, .022, turns * 18, 5, false);
}

/** Two sagging rope rails between posts. */
function rail(b: Builder, a: THREE.Vector3, c: THREE.Vector3) {
  for (const height of [.48, .97]) {
    const p = a.clone().add(V(0, height, 0)), q = c.clone().add(V(0, height, 0));
    const middle = p.clone().lerp(q, .5);
    middle.y -= p.distanceTo(q) * .065;
    b.tube('rope', [p, middle, q], .028, 16, 8);
  }
}

function pile(b: Builder, x: number, z: number, top: number, radius = .18, railPost = false) {
  const bottom = seabedHeight(x, z) - .55;
  const geometry = new THREE.CylinderGeometry(radius * .95, radius * 1.09, top - bottom, 14, 9);
  const p = geometry.getAttribute('position');
  // Coherent taper and fluting preserve closed caps and shared ring seams.
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
    const angle = Math.atan2(pz, px);
    const radial = 1 + Math.sin(angle * 5 + x) * .035 + Math.sin(py * 2 + angle * 3) * .013;
    p.setXYZ(i, px * radial, py, pz * radial);
  }
  geometry.computeVertexNormals();
  geometry.rotateZ(-Math.PI / 2);
  b.add(geometry, 'piles', V(x, (bottom + top) / 2, z), new THREE.Quaternion().setFromUnitVectors(X, Y));
  b.cylinder('endgrain', V(x, top - .006, z), V(x, top + .007, z), radius * .94, radius * .92, true, 14);
  if (railPost) {
    lashing(b, x, top - .23, z, radius * 1.03);
    // A scarfed cap with a shallow end check, visible when standing beside it.
    b.beam('frame', V(x - radius * .6, top + .009, z), V(x + radius * .25, top + .009, z + .017), .002, .004, false, .0005);
  }
}

function deckBoard(length: number, thickness: number, width: number, contoured: boolean) {
  if (!contoured) return new RoundedBoxGeometry(length, thickness, width, 1, .006);
  // The sand curves across the ramp as well as along it. Interior vertices keep
  // the visible boards fitted closely to the sand beneath the ramp.
  const geometry = new THREE.BoxGeometry(length, thickness, width, Math.ceil(length / .45), 1, 2);
  const position = geometry.getAttribute('position');
  const core = V(length / 2 - .006, thickness / 2 - .006, width / 2 - .006);
  const point = V(), nearest = V();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    nearest.copy(point).clamp(core.clone().negate(), core);
    point.sub(nearest).normalize().multiplyScalar(.006).add(nearest);
    position.setXYZ(i, point.x, point.y, point.z);
  }
  return geometry;
}

function deck(b: Builder) {
  const { x, width, headWidth, seaZ, headLandZ, landZ, boardThickness, boardGap } = PIER;
  const addRows = (near: number, far: number, span: number, head: boolean) => {
    const count = Math.ceil((far - near) / .285), pitch = (far - near) / count;
    for (let row = 0; row < count; row++) {
      const z = near + (row + .5) * pitch;
      b.section = head ? 'Head' : z > PIER.rampSeaZ ? 'Beach approach' : z > 5 ? 'Inner span' : 'Outer span';
      // Platform butt joints sit on the two outer longitudinal stringers.
      const joints = head ? [-span / 2, row % 2 ? 1.5 : -1.5, span / 2] : [-span / 2, span / 2];
      for (let part = 1; part < joints.length; part++) {
        const left = x + joints[part - 1] + (part > 1 ? boardGap / 2 : 0);
        const right = x + joints[part] - (part < joints.length - 1 ? boardGap / 2 : 0);
        const geometry = deckBoard(right - left, boardThickness, pitch - boardGap, z > PIER.rampSeaZ);
        geometry.translate((left + right) / 2, -boardThickness / 2, z);
        const p = geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + pierDeckHeight(p.getX(i), p.getZ(i)));
        geometry.computeVertexNormals();
        // Store physical timber coordinates before the board enters its batch.
        const grain = new Float32Array(p.count * 3), offset = b.random() * 50;
        for (let i = 0; i < p.count; i++) grain.set([p.getX(i) - left + offset, p.getY(i) - pierDeckHeight(p.getX(i), p.getZ(i)) + .22, p.getZ(i) - z + .08], i * 3);
        geometry.setAttribute('grain', new THREE.BufferAttribute(grain, 3));
        b.add(geometry, 'deck');
        // Recessed fasteners on every bearing line, with paired end screws.
        const bearings = head ? [-4.12, -3, -1.5, 0, 1.5, 3, 4.12] : [-1.5, 0, 1.5];
        if (part > 1) bearings.push(left - x + .048);
        if (part < joints.length - 1) bearings.push(right - x - .048);
        for (const dx of bearings) {
          const px = x + dx;
          if (px < left + .035 || px > right - .035) continue;
          for (const dz of [-.075, .075]) {
            // Only the flush head is visible; buried screw shanks need no mesh.
            const head = new THREE.CircleGeometry(.0105, 8);
            head.rotateX(-Math.PI / 2);
            b.add(head, 'metal', V(px, pierDeckHeight(px, z + dz) + .001, z + dz), new THREE.Quaternion(), false);
          }
        }
        // Occasional short longitudinal end checks; never silhouette-breaking damage.
        if (row % 5 === 1) {
          const end = part % 2 ? left + .025 : right - .29;
          b.tube('frame', [V(end, pierDeckHeight(end, z) + .001, z + .04), V(end + .12, pierDeckHeight(end + .12, z) + .001, z + .044), V(end + .24, pierDeckHeight(end + .24, z) + .001, z + .039)], .0018, 5, 3, false);
        }
      }
    }
  };
  // Disjoint head and walkway: there are no doubled boards or coplanar faces.
  addRows(seaZ, headLandZ, headWidth, true);
  addRows(headLandZ, landZ, width, false);
}

function structure(b: Builder) {
  const { x, deckY, headLandZ, landZ } = PIER;
  const stations = [-1.9, 2.1, 6.1, 10.1, 14.1, 18.1, 21.8];
  for (let i = 0; i < stations.length; i++) {
    const z = stations[i], y = pierDeckHeight(x, z);
    b.section = z > PIER.rampSeaZ ? 'Beach approach' : z > 5 ? 'Inner span' : 'Outer span';
    b.box('frame', V(x, y - .53, z), 4.08, .25, .25);
    for (const side of [-1, 1]) {
      const px = x + side * 1.72;
      const railing = z < 18;
      pile(b, px, z, y + (railing ? 1.12 : -.2), .16, railing);
      bolt(b, V(px, y - .52, z + .13), V(0, 0, 1), .027);
      if (i && z < 15) {
        const previous = stations[i - 1], previousY = pierDeckHeight(x, previous);
        rail(b, V(px, previousY, previous), V(px, y, z));
        // Diagonal braces join the pile to the next bent's bearer.
        b.beam('frame', V(px, previousY - 1.49, previous), V(px, y - .66, z), .15, .15);
        bolt(b, V(px + side * .09, previousY - 1.45, previous + .12), V(side, 0, 0));
      }
    }
    if (z < 15) b.beam('frame', V(x - 1.62, y - 1.35, z), V(x + 1.62, y - .7, z), .14, .14);
  }
  // Three stringers, segmented where the beach approach starts to descend.
  const beamJoints = [headLandZ, 2.1, 6.1, 10.1, PIER.rampSeaZ];
  for (let z = PIER.rampSeaZ + .7; z < landZ; z += .7) beamJoints.push(z);
  beamJoints.push(landZ);
  for (let i = 1; i < beamJoints.length; i++) {
    const z = beamJoints[i - 1], end = beamJoints[i];
    b.section = z >= PIER.rampSeaZ ? 'Beach approach' : z > 5 ? 'Inner span' : 'Outer span';
    for (const dx of [-1.5, 0, 1.5]) b.beam('frame', V(x + dx, pierDeckHeight(x + dx, z) - .285, z), V(x + dx, pierDeckHeight(x + dx, end) - .285, end), .28, .16, true, .006);
    for (const side of [-1, 1]) b.beam('frame', V(x + side * 1.81, pierDeckHeight(x + side * 1.81, z) - .17, z), V(x + side * 1.81, pierDeckHeight(x + side * 1.81, end) - .17, end), .25, .075, true, .006);
  }
  b.section = 'Head';
  for (const z of [-10.8, -6.85, -2.95]) {
    b.box('frame', V(x, deckY - .55, z), 8.9, .3, .26);
    for (const dx of [-4.14, -1.5, 1.5, 4.14]) {
      pile(b, x + dx, z, deckY - .17, dx === -4.14 || dx === 4.14 ? .22 : .19);
      bolt(b, V(x + dx, deckY - .54, z + .14), V(0, 0, 1), .029);
    }
    for (const side of [-1, 1]) b.beam('frame', V(x + side * 4.14, deckY - 1.65, z), V(x + side * 1.5, deckY - .72, z), .18, .18);
  }
  for (const dx of [-4.12, -3, -1.5, 0, 1.5, 3, 4.12]) b.beam('frame', V(x + dx, deckY - .29, PIER.seaZ + .1), V(x + dx, deckY - .29, headLandZ - .1), .29, .16);
  // A 25mm deck overhang keeps board ends off the fascia's exterior plane.
  for (const dx of [-4.435, 4.435]) b.beam('frame', V(x + dx, deckY - .2, PIER.seaZ), V(x + dx, deckY - .2, headLandZ), .34, .08);
  for (const z of [PIER.seaZ + .04, headLandZ - .04]) b.box('frame', V(x, deckY - .2, z), 8.84, .34, .08);

  const edgePosts = [[-4.3, -10.94], [4.3, -10.94], [-4.3, -6.8], [4.3, -4.9], [-4.3, -2.82], [4.3, -2.82]];
  for (const [dx, z] of edgePosts) pile(b, x + dx, z, deckY + 1.12, .16, true);
  rail(b, V(x - 4.3, deckY, -10.94), V(x - 4.3, deckY, -6.8));
  rail(b, V(x - 4.3, deckY, -6.8), V(x - 4.3, deckY, -2.82));
  rail(b, V(x + 4.3, deckY, -4.9), V(x + 4.3, deckY, -2.82));
  // The front apron and starboard berth stay open for boat access.
  for (const side of [-1, 1]) {
    pile(b, x + side * 1.72, -2.82, deckY + 1.12, .16, true);
    rail(b, V(x + side * 4.3, deckY, -2.82), V(x + side * 1.72, deckY, -2.82));
    rail(b, V(x + side * 1.72, deckY, -2.82), V(x + side * 1.72, deckY, stations[0]));
  }
}

function shelter(b: Builder) {
  b.section = 'Shelter';
  const { x, deckY } = PIER;
  const centerZ = -6.35, eave = deckY + 2.94, rise = 1.45;
  const postX = 2.35, postZ = 1.93;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = x + sx * postX, z = centerZ + sz * postZ;
    b.beam('frame', V(px, deckY - .42, z), V(px, eave + .05, z), .22, .22, true, .018);
    b.box('metal', V(px, deckY + .065, z), .246, .13, .246, false, .009);
    bolt(b, V(px + sx * .13, deckY + .07, z), V(sx, 0, 0), .023);
    for (const axis of [V(-sx, 0, 0), V(0, 0, -sz)]) {
      const a = V(px, eave - .77, z), c = V(px, eave - .08, z).addScaledVector(axis, .72);
      b.beam('frame', a, c, .14, .14);
      bolt(b, a.clone().add(V(0, 0, .075)), V(0, 0, 1));
    }
    lashing(b, px, eave - .12, z, .157, 3);
  }
  for (const sx of [-1, 1]) b.beam('frame', V(x + sx * postX, eave, centerZ - 2.34), V(x + sx * postX, eave, centerZ + 2.34), .23, .2);
  for (const sz of [-1, 1]) {
    const z = centerZ + sz * postZ;
    b.box('frame', V(x, eave + .08, z), 5.35, .24, .2);
    b.beam('frame', V(x, eave + .13, z), V(x, eave + rise - .05, z), .14, .14);
    for (const sx of [-1, 1]) b.beam('frame', V(x + sx * 1.75, eave + .21, z), V(x, eave + rise - .13, z), .105, .105);
  }
  b.beam('frame', V(x, eave + rise - .06, centerZ - 2.92), V(x, eave + rise - .06, centerZ + 2.92), .18, .18);
  // Exposed rafters, purlins and lashings support the roof's overlapping courses.
  for (let i = 0; i <= 8; i++) {
    const z = centerZ - 2.68 + i * .67;
    for (const sx of [-1, 1]) b.beam('frame', V(x, eave + rise, z), V(x + sx * 3.15, eave - .08, z), .105, .105);
  }
  for (const sx of [-1, 1]) for (const u of [.24, .51, .79, 1]) {
    b.beam('frame', V(x + sx * 3.15 * u, eave + rise * (1 - u) + .025, centerZ - 2.78), V(x + sx * 3.15 * u, eave + rise * (1 - u) + .025, centerZ + 2.78), .065, .065);
  }

  // Each leaf ribbon has a crowned middle and a drooping, irregular cut end.
  // Closed under-roof slabs prevent light leaks through the overlapping courses.
  for (const sx of [-1, 1]) {
    const a = V(x, eave + rise + .025, centerZ), c = V(x + sx * 3.23, eave - .05, centerZ);
    b.beam('thatchEdge', a, c, .18, 5.75, true, .028);
    for (let course = 0; course < 7; course++) {
      const u0 = course / 7, u1 = Math.min(1.065, (course + 1.65) / 7);
      for (let strip = 0; strip < 61; strip++) {
        const z = centerZ - 2.91 + strip * .097 + (b.random() - .5) * .025;
        const width = .105 + b.random() * .027, tip = u1 + (b.random() - .5) * .046;
        const points: number[] = [], grain: number[] = [], colors: number[] = [], indices: number[] = [];
        const shade = .28 + b.random() * .65;
        for (let step = 0; step <= 3; step++) for (let edge = 0; edge < 3; edge++) {
          const t = step / 3, u = THREE.MathUtils.lerp(u0, tip, t);
          const pz = z + (edge - 1) * width * .5 + Math.sin(t * 2.4 + strip) * .015;
          const py = eave + rise * (1 - u) + .15 + (1 - t) * .09 + (edge === 1 ? .022 : 0) - Math.pow(t, 5) * .09;
          points.push(x + sx * u * 3.23, py, pz);
          grain.push(u * 3.23, 0, pz + 15);
          const c = shade * (edge === 1 ? 1 : .87);
          colors.push(c, c, c);
          if (step < 3 && edge < 2) {
            const k = step * 3 + edge;
            // Ribbons have upward winding on each mirrored roof slope.
            if (sx > 0) indices.push(k, k + 1, k + 3, k + 1, k + 4, k + 3);
            else indices.push(k, k + 3, k + 1, k + 1, k + 3, k + 4);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        geometry.setAttribute('grain', new THREE.Float32BufferAttribute(grain, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        b.add(geometry, 'thatch');
        if (course === 6 && strip % 2 === 0) {
          const end = V(x + sx * tip * 3.23, eave + rise * (1 - tip) + .035, z);
          b.tube('thatch', [end.clone().add(V(-sx * .22, .14, 0)), end, end.clone().add(V(sx * .07, -.10 - b.random() * .07, .012))], .014, 5, 5);
        }
      }
    }
  }
  // Rounded ridge bundles cap the meeting slopes; bindings read in silhouette.
  for (let i = 0; i < 30; i++) {
    const z = centerZ - 2.92 + i * .201;
    b.cylinder('thatch', V(x, eave + rise + .13, z), V(x, eave + rise + .13, z + .22), .16, .145, true, 10);
    if (i % 3 === 0) b.tube('rope', [V(x - .18, eave + rise + .1, z), V(x, eave + rise + .31, z), V(x + .18, eave + rise + .1, z)], .019, 10, 6);
  }

  // Built-in slatted benches leave a 3.4m clear passage through the pavilion.
  for (const bench of PIER_BENCHES) {
    const { side: sx, x: px, z: centerZ, halfLength, seatY } = bench;
    for (const z of [centerZ - 1.45, centerZ + 1.45]) {
      for (const dx of [-.19, .19]) b.beam('frame', V(px + dx, deckY, z), V(px + dx, deckY + .44, z), .075, .075);
      b.box('frame', V(px, deckY + .39, z), .62, .09, .09);
      b.beam('frame', V(px + sx * .22, deckY + .36, z), V(px + sx * .32, deckY + 1.01, z), .065, .065);
    }
    for (let slat = 0; slat < 4; slat++) b.beam('deck', V(px - .23 + slat * .153, seatY - .025, centerZ - halfLength), V(px - .23 + slat * .153, seatY - .025, centerZ + halfLength), .05, .135, true, .01);
    for (let slat = 0; slat < 3; slat++) b.beam('deck', V(px + sx * (.255 + slat * .019), deckY + .7 + slat * .125, centerZ - halfLength), V(px + sx * (.255 + slat * .019), deckY + .7 + slat * .125, centerZ + halfLength), .105, .042, true, .009);
  }
}

function fittings(b: Builder) {
  b.section = 'Head';
  const { x, deckY } = PIER;
  // Cast two-horn cleats with feet and attachment bolts, inset from the edge.
  for (const [dx, z] of [[3.98, -9.7], [3.98, -5.1], [-1.05, -10.83], [1.05, -10.83]]) {
    const px = x + dx;
    b.box('metal', V(px, deckY + .018, z), .3, .032, .16, false, .016);
    for (const sign of [-1, 1]) {
      b.cylinder('metal', V(px + sign * .075, deckY + .03, z), V(px + sign * .075, deckY + .15, z), .03, .026, false, 10);
      bolt(b, V(px + sign * .108, deckY + .035, z), Y, .015);
    }
    b.tube('metal', [V(px - .28, deckY + .2, z), V(px - .17, deckY + .165, z), V(px + .17, deckY + .165, z), V(px + .28, deckY + .2, z)], .036, 14, 9, false);
  }
  // Boarding ladder sits on the port apron, clear of both boats and their routes.
  for (const dx of [-3.45, -2.7]) {
    const px = x + dx;
    b.tube('metal', [V(px, -.95, -11.46), V(px, deckY + .37, -11.46), V(px, deckY + .68, -11.36), V(px, deckY + .71, -11.08), V(px, deckY + .43, -10.79), V(px, deckY + .02, -10.79)], .037, 36, 10);
    for (const z of [-10.8, -11.06]) b.box('metal', V(px, deckY + .014, z), .14, .022, .13, false, .012);
  }
  for (let rung = 0; rung < 7; rung++) {
    const y = -.75 + rung * .34;
    b.box('metal', V(x - 3.075, y, -11.46), .79, .055, .13, true, .014);
  }
  // Timber rubbing strakes protect the working berth. Ends remain underwater.
  for (const z of [-9.4, -5.45]) {
    b.beam('piles', V(x + 4.57, -.48, z), V(x + 4.57, deckY - .04, z), .19, .2, true, .025);
    b.tube('rope', [V(x + 4.2, deckY + .04, z - .09), V(x + 4.59, deckY + .12, z), V(x + 4.65, .5, z)], .025, 14, 6);
  }
  // Flemished spare line, low on the berth apron and out of the central walkway.
  const coil: THREE.Vector3[] = [];
  for (let i = 0; i <= 160; i++) {
    const angle = i / 32 * TAU, radius = .10 + i / 160 * .25;
    coil.push(V(x + 3.65 + Math.cos(angle) * radius, deckY + .025, -8.82 + Math.sin(angle) * radius));
  }
  b.tube('rope', coil, .018, 180, 6, false);
}

/** The old jetty: deck, piles, pavilion, fittings, and the rowboat's mooring line. */
export function createPier(materials: TimberMaterials, collisions: IslandCollisions) {
  const root = new THREE.Group();
  root.name = 'The old jetty';
  const builder = new PartBuilder(materials, { seed: 824713, collisions });
  builder.section = 'Head';
  deck(builder);
  structure(builder);
  shelter(builder);
  fittings(builder);
  builder.build(root);
  // The working line is separate so boarding the rowboat can release it.
  const mooring = new THREE.Group();
  mooring.name = 'Rowboat · mooring line';
  const line = new PartBuilder(materials);
  line.tube('rope', [V(PIER.x + 3.98, PIER.deckY + .16, -9.7), V(-18.6, 1.06, -9.85), V(PIER_ROWBOAT.x + .35, .79, PIER_ROWBOAT.z - 2)], .019, 24, 7);
  line.build(mooring);
  root.add(mooring);
  return { root, mooring };
}
