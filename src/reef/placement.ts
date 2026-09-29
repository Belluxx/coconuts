import * as THREE from 'three/webgpu';
import { MARINE_HABITATS, marineChannelClear, type MarineHabitat } from './habitats';
import { seabedHeight } from '../land/terrain';

const MINIMUM_COLONY_GAP = .22;

type Footprint = { x: number; z: number; radius: number; top: number };

/** Conservative horizontal bounds keep neighboring silhouettes separate. */
export function reefFootprint(bounds: THREE.Box3): Footprint {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  return { x: center.x, z: center.z, radius: Math.hypot(size.x, size.z) * .5, top: bounds.max.y };
}

/** Shared clearance rules for stones, colonies, and the small details around them. */
export class SeabedPlacement {
  private readonly footprints: Footprint[] = [];

  hasSpace(candidate: Footprint, gap = MINIMUM_COLONY_GAP) {
    return candidate.top < -.22
      && marineChannelClear(candidate.x, candidate.z, candidate.radius)
      && this.footprints.every(other =>
        Math.hypot(candidate.x - other.x, candidate.z - other.z) > candidate.radius + other.radius + gap);
  }

  hasDetailSpace(point: THREE.Vector3, radius: number) {
    return this.footprints.every(other =>
      Math.hypot(point.x - other.x, point.z - other.z) > other.radius + radius + .07);
  }

  reserve(footprint: Footprint) {
    this.footprints.push(footprint);
  }
}

/** Reject sharp slopes, then lower the colony until all basal contacts reach sand. */
export function settleColonyOnSeabed(
  colony: THREE.Object3D,
  floorPoint: THREE.Vector3,
  radius: number,
  roots: readonly THREE.Vector3[],
) {
  const { x, y, z } = floorPoint;
  const sampleRadius = radius * .65;
  const slope = Math.max(
    Math.abs(seabedHeight(x + sampleRadius, z) - y),
    Math.abs(seabedHeight(x - sampleRadius, z) - y),
    Math.abs(seabedHeight(x, z + sampleRadius) - y),
    Math.abs(seabedHeight(x, z - sampleRadius) - y),
  );
  if (slope > .28) return false;

  // Include downhill roots; the burial margin covers interpolation error in
  // the rendered 2 m offshore terrain grid without burying broad coral plates.
  let settle = 0;
  for (const root of roots) {
    const contact = root.clone().applyMatrix4(colony.matrix);
    settle = Math.min(settle, seabedHeight(contact.x, contact.z) - contact.y - .035);
  }
  if (settle < -.14) return false;

  colony.position.y += settle;
  colony.updateMatrix();
  return true;
}

const HABITATS_BY_KIND = {
  reef: MARINE_HABITATS.filter(habitat => habitat.kind === 'reef'),
  grass: MARINE_HABITATS.filter(habitat => habitat.kind === 'grass'),
  rubble: MARINE_HABITATS.filter(habitat => habitat.kind === 'rubble'),
};

export function chooseMarineHabitat(random: () => number, kind?: MarineHabitat['kind']): MarineHabitat {
  const choices = kind ? HABITATS_BY_KIND[kind] : MARINE_HABITATS;
  let weight = random() * choices.reduce((sum, habitat) => sum + habitat.weight, 0);
  return choices.find(habitat => (weight -= habitat.weight) <= 0) ?? choices[choices.length - 1];
}

/** Sample an irregular, coast-aligned patch on the same surface used by the terrain. */
export function sampleMarineHabitat(random: () => number, habitat: MarineHabitat, spread = 1) {
  const angle = random() * Math.PI * 2;
  const radius = Math.pow(random(), .65) * spread;
  const edge = 1 + Math.sin(angle * 3 + habitat.x) * .16 + Math.cos(angle * 5) * .09;
  const x = habitat.x + Math.cos(angle) * radius * habitat.rx * edge;
  const distance = habitat.d + Math.sin(angle) * radius * habitat.rz * edge + Math.sin((x - habitat.x) * .6) * .35;
  const z = habitat.z + distance - habitat.d;
  return new THREE.Vector3(x, seabedHeight(x, z), z);
}
