import * as THREE from 'three/webgpu';
import { V } from '../math';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createCoralBranchGeometry, createCoralHeadGeometry, createCoralPlateGeometry,
  createSeaFanGeometry, createSpongeGeometry, createStaghornGeometry,
} from './coralGeometry';


/** Combines temporary parts into one geometry while preserving their vertex pigment. */
export class ColoredGeometryBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(
    geometry: THREE.BufferGeometry,
    tint: THREE.Color,
    position: THREE.Vector3,
    scale = V(1, 1, 1),
    quaternion = new THREE.Quaternion(),
  ) {
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, quaternion, scale));
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.deleteAttribute('uv');
    const colors = new Float32Array(flat.getAttribute('position').count * 3);
    const localColors = flat.getAttribute('color');
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = tint.r * (localColors?.getX(i / 3) ?? 1);
      colors[i + 1] = tint.g * (localColors?.getY(i / 3) ?? 1);
      colors[i + 2] = tint.b * (localColors?.getZ(i / 3) ?? 1);
    }
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(flat);
  }

  branch(a: THREE.Vector3, b: THREE.Vector3, radius: number, tint: THREE.Color) {
    this.add(createCoralBranchGeometry(a, b, radius), tint, V());
  }

  /** Transfers ownership of the merged geometry to the caller. */
  build() {
    const geometry = mergeGeometries(this.parts, false)!;
    this.parts.forEach(part => part.dispose());
    this.parts.length = 0;
    return geometry;
  }
}

export type CoralSpecies = 'brain' | 'foliose' | 'table' | 'staghorn' | 'sponge' | 'barrel' | 'fan';
const CORAL_SPECIES: { name: CoralSpecies; palette: string[] }[] = [
  { name: 'brain', palette: ['#bfa060', '#97965c', '#a4aa71', '#b88e71'] },
  { name: 'foliose', palette: ['#b47a69', '#c18f6c', '#88a17b', '#a57690'] },
  { name: 'table', palette: ['#ac8460', '#bea777', '#748e99', '#a18bab'] },
  { name: 'staghorn', palette: ['#c8ab78', '#b7b38b', '#b783a6', '#76a5ab'] },
  { name: 'sponge', palette: ['#c18641', '#ba8c4c', '#985f7b', '#bf604b'] },
  { name: 'barrel', palette: ['#a1785b', '#a88464', '#827484'] },
  { name: 'fan', palette: ['#b47659', '#ab6d6c', '#a47691', '#c19268'] },
];

export type CoralTemplate = {
  name: CoralSpecies;
  variant: number;
  geometry: THREE.BufferGeometry;
  palette: THREE.Color[];
  solid: boolean;
  roots: THREE.Vector3[];
};

/** Keep the lowest contact in each basal cell when settling a colony on a slope. */
function findColonyRoots(geometry: THREE.BufferGeometry) {
  const rootCells = new Map<string, THREE.Vector3>();
  const points = geometry.getAttribute('position');
  for (let vertex = 0; vertex < points.count; vertex++) {
    if (points.getY(vertex) > geometry.boundingBox!.min.y + .035) continue;
    const root = V().fromBufferAttribute(points, vertex);
    const key = `${Math.round(root.x / .09)},${Math.round(root.z / .09)}`;
    const previous = rootCells.get(key);
    if (!previous || root.y < previous.y) rootCells.set(key, root);
  }
  return [...rootCells.values()];
}

/** Three reusable sculpted variants per species; the caller owns their geometry. */
export function createCoralTemplates(random: () => number): CoralTemplate[] {
  const builder = new ColoredGeometryBuilder();
  const white = new THREE.Color('#ffffff');

  const templates: CoralTemplate[] = [];
  for (const speciesEntry of CORAL_SPECIES) for (let variant = 0; variant < 3; variant++) {
    const seed = 3.71 + variant * 2.17;
    switch (speciesEntry.name) {
      case 'brain':
        for (let lobe = 0; lobe < 3; lobe++) {
          const a = lobe * 2.399 + seed;
          builder.add(createCoralHeadGeometry(seed + lobe * 7), white,
            V(Math.cos(a) * .29, .01, Math.sin(a) * .23), V(.67 - lobe * .095, .71 - lobe * .10, .64 - lobe * .08));
        }
        break;
      case 'foliose':
        for (let tier = 0; tier < 5; tier++) {
          const radius = 1.02 - tier * .155 + Math.sin(tier * 4.1 + seed) * .065, a = tier * 1.9 + seed;
          builder.add(createCoralPlateGeometry(seed + tier * .8), white.clone().multiplyScalar(.83 + tier * .045),
            V(Math.cos(a) * .19, tier * .115, Math.sin(a) * .17), V(radius, radius * .88, radius),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * .10, a, Math.cos(a) * .09)));
        }
        break;
      case 'table': {
        builder.branch(V(0, 0, 0), V(.06, .54, -.035), .13, white.clone().multiplyScalar(.72));
        for (let tier = 0; tier < 3; tier++) {
          const a = tier * 2.399 + seed;
          const center = V(Math.cos(a) * tier * .27, .40 + tier * .11, Math.sin(a) * tier * .27);
          builder.branch(V(.03, .27, 0), center, .058, white.clone().multiplyScalar(.79));
          const radius = .97 - tier * .14;
          builder.add(createCoralPlateGeometry(seed + tier), white, center, V(radius, .25, radius));
          // Fine upright corallites break the silhouette of the living table.
          for (let tip = 0; tip < 17; tip++) {
            const angle = tip * 2.399 + seed, reach = Math.sqrt((tip + .5) / 17) * radius * .89;
            const origin = center.clone().add(V(Math.cos(angle) * reach, .049, Math.sin(angle) * reach * .89));
            builder.branch(origin, origin.clone().add(V(.004, .055 + random() * .035, .002)), .011, white.clone().multiplyScalar(1.09));
          }
        }
        break;
      }
      case 'staghorn':
        builder.add(createStaghornGeometry(seed), white, V());
        break;
      case 'sponge':
        for (let chimney = 0; chimney < 4; chimney++) {
          const a = chimney * 2.399 + seed, height = .52 + random() * .61;
          builder.add(createSpongeGeometry(seed + chimney), white.clone().multiplyScalar(.9 + chimney * .035),
            V(Math.cos(a) * .23, 0, Math.sin(a) * .23), V(.83, height, .83),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.cos(a) * .10, a, Math.sin(a) * .08)));
        }
        break;
      case 'barrel':
        builder.add(createSpongeGeometry(seed, true), white, V());
        break;
      case 'fan':
        builder.add(createSeaFanGeometry(seed), white, V());
        break;
    }
    const geometry = builder.build();
    const solid = speciesEntry.name === 'brain' || speciesEntry.name === 'table'
      || speciesEntry.name === 'sponge' || speciesEntry.name === 'barrel';
    geometry.computeBoundingBox();
    if (speciesEntry.name === 'fan') {
      const positions = geometry.getAttribute('position');
      const flexibility = new Float32Array(positions.count);
      for (let vertex = 0; vertex < flexibility.length; vertex++) flexibility[vertex] = Math.max(0, positions.getY(vertex)) ** 2;
      geometry.setAttribute('fanFlex', new THREE.BufferAttribute(flexibility, 1));
    }
    templates.push({ name: speciesEntry.name, variant, geometry, solid, roots: findColonyRoots(geometry),
      palette: speciesEntry.palette.map(hex => new THREE.Color(hex)) });
  }

  return templates;
}
