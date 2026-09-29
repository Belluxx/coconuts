import * as THREE from 'three/webgpu';
import { seededRandom, TAU } from '../math';
import type { IslandCollisions } from '../player/collisions';
import type { QualitySettings } from '../quality';
import { inBoardwalkClearing } from '../structures/boardwalkLayout';
import { bungalowPoint, inBungalowClearing } from '../structures/bungalowLayout';
import { createVegetationMaterials } from './foliage';
import { createPlantSprings, hasSolidStem } from './plantSprings';
import { createPlantSurfaces, growPlant, type Plant, type PlantKind } from './plants';
import { groundHeight, shoreZ, terrainNoise } from './terrain';
import { ACROSS, CREEK, FLOW, GORGE, creekHalfWidth, gorgeRadius, inFallsWater, inGorge, toWorld } from './waterfallLayout';

const CELL = 32;
const SEED = 38412;
/** Authored framing palms: x, z, height, lean x, lean z (meters). */
const HERO_PALMS = [
  [-39, 35, 17, 10, -3], [23, 34, 12.5, -2, -2.5], [-28, 21, 11.8, 3, -1],
  [32, 18, 10.2, -1.5, 1], [-36, 11, 12, 1, -2], [43, 11, 12.8, -2, -1],
  [-10, 55, 14, 2, -3], [44, -2, 9, -1, 1], [-43, 6, 9, 1, 1],
  [-49, -1, 12, 1.7, -1], [-58, -9, 10, 1, 1], [50, -10, 8.4, -1, 1],
  [37, 33, 10.4, -2, 1], [54, 25, 10.8, 1, 0], [64, 35, 9.8, -1, 2],
  [-2, 29, 8.7, -4, -4],
] as const;

/** Exclusions are applied to roots and crown radius, including the pier approach. */
function vegetationAllowed(x: number, z: number, radius = 0) {
  if (z - shoreZ(x) < 10 + radius * .3) return false;
  if (inFallsWater(x, z, radius + .4) || inGorge(x, z, radius * .5)) return false;
  if (Math.abs(x + 24) < 2.6 + radius && z > 12 - radius && z < 24 + radius) return false;
  if (Math.abs(x) < 9 + radius && z < 28 + radius) return false;
  return true;
}

function plantLayout(): Plant[] {
  const random = seededRandom(SEED), plants: Plant[] = [];
  const add = (kind: PlantKind, x: number, z: number, radius: number, height: number, extra: Partial<Plant> = {}) => {
    plants.push({ kind, x, y: groundHeight(x, z) - (kind === 'palm' || height > 2 ? .065 : 0), z, radius, height, seed: SEED + plants.length * 7919, ...extra });
  };
  HERO_PALMS.forEach(([x, z, height, leanX, leanZ], i) => add('palm', x, z, height * .5, height, { leanX, leanZ, hero: i < 7 || i === 15 }));
  for (let i = 0; i < 31; i++) {
    const x = i % 2 ? 47 + random() * 63 : -48 - random() * 61, z = shoreZ(x) + 16 + random() * 20;
    if (!vegetationAllowed(x, z, .5)) continue;
    const height = 5.5 + random() * 5.5;
    add('palm', x, z, height * .48, height, { leanX: (random() - .5) * 3, leanZ: (random() - .5) * 2 });
  }
  const trees: Plant[] = [];
  const groves = [
    [-65, 9, 19, 24], [-91, -12, 23, 27], [-75, 43, 23, 25],
    [-43, 86, 29, 21], [-9, 77, 25, 22], [23, 70, 23, 25],
    [45, 39, 18, 21], [70, 44, 22, 24], [93, 12, 23, 27],
    [113, -21, 20, 26], [113, 54, 18, 29],
  ];
  // Overlapping woodland islands create a layered canopy behind the beach.
  // Their open, grassy saddles are as deliberate as the densely planted slopes.
  for (let attempt = 0; attempt < 2800 && trees.length < 370; attempt++) {
    const grove = attempt % groves.length, [cx, cz, rx, rz] = groves[grove];
    const angle = random() * TAU, distance = Math.sqrt(random());
    const x = cx + Math.cos(angle) * distance * rx, z = cz + Math.sin(angle) * distance * rz;
    if (Math.abs(x) > 124 || z > 110 || z < -58 || !vegetationAllowed(x, z, 2)) continue;
    if (Math.hypot(x + 42, z - 54) < 21) continue;
    const patch = terrainNoise(x * .055, z * .06);
    if (patch < -.33 && random() < .65) continue;
    const slope = Math.hypot((groundHeight(x + .5, z) - groundHeight(x - .5, z)), (groundHeight(x, z + .5) - groundHeight(x, z - .5)));
    if (slope > 1.4 && random() < .7) continue;
    if (trees.some(tree => Math.hypot(x - tree.x, z - tree.z) < 2.9)) continue;
    const edge = z - shoreZ(x) < 28 || slope > 1.1;
    const kind: PlantKind = edge ? 'sea grape' : random() < (grove % 3 === 0 ? .8 : .35) ? 'sea almond' : 'mango';
    const radius = edge ? 1.8 + random() * 1.2 : 2.9 + random() * 1.65;
    add(kind, x, z, radius, radius * (kind === 'sea grape' ? .95 : kind === 'sea almond' ? 1.9 : 1.55));
    trees.push(plants[plants.length - 1]);
  }
  // Interlocking coastal crowns soften the exposed cliff feet and ledges.
  // These are separate ecology patches: they do not enter the open beach.
  const coastal: Plant[] = [];
  for (let attempt = 0; attempt < 850 && coastal.length < 115; attempt++) {
    const x = attempt % 3 ? 38 + random() * 87 : -43 - random() * 72;
    const z = shoreZ(x) + 14 + random() * 17;
    if (z > 40 || z < -59 || !vegetationAllowed(x, z, .8)) continue;
    if (terrainNoise(x * .13, z * .1) < -.28 || coastal.some(p => Math.hypot(x - p.x, z - p.z) < 1.8)) continue;
    const radius = 1.45 + random() * 1.35;
    add('sea grape', x, z, radius, radius * (1.05 + random() * .28));
    coastal.push(plants[plants.length - 1]);
  }
  const gardens = [[-37, 34], [-31, 27], [-36, 23], [-24, 34], [22, 34], [27, 27], [-14, 48], [18, 47],
    [-34, 20], [35, 35], [-30, 42], [34, 47], [43, 23], [-52, 12]];
  for (const [gx, gz] of gardens) for (let i = 0; i < 13; i++) {
    const angle = random() * TAU, distance = Math.sqrt(random());
    const x = gx + Math.cos(angle) * distance * 4.5, z = gz + Math.sin(angle) * distance * 3.5;
    if (!vegetationAllowed(x, z, .9)) continue;
    if (i === 0) add('banana', x, z, 1.15 + random() * .45, 1.9 + random() * .8);
    else if (i === 1) add('cordyline', x, z, .75 + random() * .3, 1.05 + random() * .6, { hero: true });
    else if (i < 4) add('hibiscus', x, z, .8 + random() * .3, .9 + random() * .45, { hero: true });
    else {
      const kind = (['monstera', 'heart leaf', 'fern', 'trailing vine'] as const)[i % 4];
      add(kind, x, z, .8 + random() * .5, kind === 'trailing vine' ? .35 : .7 + random() * .55, { hero: true });
    }
  }
  // Fern families nestle into humid woodland edges; broad leaves appear only
  // in sheltered pockets, with occasional bare turf visible between colonies.
  for (let i = 0; i < trees.length; i += 4) {
    const tree = trees[i];
    for (let j = 0; j < 3; j++) {
      const x = tree.x + (random() - .5) * 4, z = tree.z + (random() - .5) * 4;
      if (vegetationAllowed(x, z, 1)) add(j === 2 && i % 3 === 0 ? 'monstera' : 'fern',
        x, z, .65 + random() * .6, .5 + random() * .55);
    }
  }
  for (const [gx, gz] of [[-32, 29], [-36, 33], [-29, 25], [16, 35], [-21, 28], [25, 28], [-10, 47], [21, 43]]) {
    for (let j = 0; j < 4; j++) {
      const x = gx + (random() - .5) * 4, z = gz + (random() - .5) * 3;
      if (vegetationAllowed(x, z, .8)) add('hibiscus', x, z, .72 + random() * .26, .8 + random() * .4);
    }
  }
  for (let patch = 0; patch < 65; patch++) {
    const cx = (random() - .5) * 214, cz = shoreZ(cx) + 12.5 + random() * 9;
    const radius = 1.4 + random() * 2.5;
    for (let blade = 0; blade < 12; blade++) {
      const angle = random() * TAU, distance = Math.sqrt(random()) * radius;
      const x = cx + Math.cos(angle) * distance, z = cz + Math.sin(angle) * distance * .6;
      if (!vegetationAllowed(x, z, .3)) continue;
      add('beach grass', x, z, .3, .24 + random() * .35);
    }
  }
  // Spray keeps the gorge's floor humid: ferns and broad leaves crowd the foot
  // of its walls, the spring creek's banks and the bench. Roots stay clear of
  // the water; two palms on the rim lean out over the pool.
  const fallsRandom = seededRandom(73562);
  const understory = ['fern', 'heart leaf', 'fern', 'monstera'] as const;
  for (let i = 0; i < 44; i++) {
    const angle = (fallsRandom() * 2 - 1) * (GORGE.span - .1), inset = .3 + fallsRandom() * 1.1;
    const kind = understory[i % 4], radius = .35 + fallsRandom() * .4, height = .35 + fallsRandom() * .55;
    const r = gorgeRadius(angle) - inset, p = toWorld(GORGE.back - Math.cos(angle) * r, Math.sin(angle) * r);
    if (Math.abs(angle) > .6 && !inFallsWater(p.x, p.z, radius)) add(kind, p.x, p.z, radius, height, { alignToSlope: true });
  }
  for (let i = 0; i < 40; i++) {
    const s = fallsRandom() * CREEK.length, side = fallsRandom() < .5 ? -1 : 1;
    const c = CREEK.at(s), offset = creekHalfWidth(s) + .45 + fallsRandom() * 2;
    const x = c.x - c.tz * side * offset, z = c.z + c.tx * side * offset;
    const kind = i % 5 === 0 ? 'banana' : understory[i % 4], radius = .45 + fallsRandom() * .45;
    if (!inFallsWater(x, z, radius * .6) && !inGorge(x, z)) {
      add(kind, x, z, kind === 'banana' ? .9 : radius, kind === 'banana' ? 1.5 + fallsRandom() * .5 : .45 + fallsRandom() * .6, { alignToSlope: true });
    }
  }
  for (const side of [-1, 1]) {
    const p = toWorld(-1.2, side * 5.6);
    add('palm', p.x, p.z, 4.2, 8.6 + side * .7, { leanX: FLOW.x * 2.2 - ACROSS.x * side * 1.1, leanZ: FLOW.z * 2.2 - ACROSS.z * side * 1.1, hero: true });
  }
  // One seaward-leaning palm frames the cottage without changing the existing plant seeds.
  const cottagePalm = bungalowPoint(5.4, 0, 1.4);
  add('palm', cottagePalm.x, cottagePalm.z, 4.7, 10.1, { leanX: 1.8, leanZ: -.6, hero: true });
  return plants.filter(plant => !inBungalowClearing(plant.x, plant.z, plant.kind === 'palm' ? .55 : plant.radius * .8)
    && !inBoardwalkClearing(plant.x, plant.z, plant.kind === 'palm' ? .6 : plant.radius * .85));
}

/** A single plant at the origin, e.g. for a pot indoors; it sways but is never brushed. */
export function createPottedPlant(kind: PlantKind, height: number, radius: number, seed: number) {
  const plant: Plant = { kind, x: 0, y: 0, z: 0, height, radius, seed, hero: true, standalone: true };
  const root = new THREE.Group(), surfaces = createPlantSurfaces(), materials = createVegetationMaterials();
  growPlant(plant, surfaces, false);
  for (const key of ['bark', 'leaf', 'blossom'] as const) {
    if (!surfaces[key].indices.length) continue;
    const mesh = new THREE.Mesh(surfaces[key].geometry(), materials[key]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}

/**
 * Every plant is built twice per 32 m cell: full detail near the viewer and a
 * lighter version beyond `vegetationNear` (and, below High, in reflections and shadows).
 */
export function createVegetation(collisions: IslandCollisions) {
  const root = new THREE.Group();
  root.name = 'Island · tropical vegetation';
  const plants = plantLayout(), springs = createPlantSprings(plants);
  const materials = createVegetationMaterials(springs.texture), cells = new Map<string, Plant[]>();
  const indices = new Map(plants.map((plant, i) => [plant, i]));
  const detailCells: { near: THREE.Mesh[]; far: THREE.Mesh[]; bounds: THREE.Box3; detailed: boolean }[] = [];
  for (const plant of plants) {
    const key = `${Math.floor(plant.x / CELL)},${Math.floor(plant.z / CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(plant);
  }
  for (const [key, localPlants] of cells) {
    const group = new THREE.Group();
    group.name = `Vegetation · cell ${key}`;
    const near: THREE.Mesh[] = [], farMeshes: THREE.Mesh[] = [];
    for (const far of [false, true]) {
      const s = createPlantSurfaces();
      for (const p of localPlants) {
        // Root coordinates plus per-plant phase are copied unchanged to all parts.
        Object.values(s).forEach(surface => {
          surface.anchor.set(p.x, p.z, (p.seed % 1000) * .00628);
          surface.plantIndex = indices.get(p)!;
        });
        const stemStart = s.bark.indices.length;
        growPlant(p, s, far);
        if (!far && hasSolidStem(p)) collisions.addStem(s.bark.positions, s.bark.indices, stemStart);
      }
      for (const kind of ['bark', 'leaf', 'blossom'] as const) {
        if (!s[kind].indices.length) continue;
        const mesh = new THREE.Mesh(s[kind].geometry(), materials[kind]);
        mesh.name = `Vegetation · ${key}/${kind}`;
        // Detail meshes start in the view; simplified ones in the mirror and shadows.
        mesh.userData.vegetationDetail = far ? 'far' : 'near';
        mesh.layers.set(far ? 1 : 0);
        if (far) mesh.layers.enable(2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        (far ? farMeshes : near).push(mesh);
      }
    }
    root.add(group);
    detailCells.push({ near, far: farMeshes, bounds: new THREE.Box3().setFromObject(group), detailed: true });
  }
  let detailedPasses = false;
  return {
    root, plants,
    update(dt: number, player: THREE.Vector3, quality: QualitySettings) {
      springs.update(dt, player);
      for (const cell of detailCells) {
        const distance = cell.bounds.distanceToPoint(player);
        // A small overlap prevents flickering at the detail boundary.
        const detailed = distance < quality.vegetationNear + (cell.detailed ? 4 : 0);
        if (detailed === cell.detailed && detailedPasses === quality.detailedVegetationPasses) continue;
        cell.detailed = detailed;
        // Layer 0 is the view; 1 the water mirror; 2 the shadow casters.
        cell.near.forEach(mesh => detailed ? mesh.layers.enable(0) : mesh.layers.disable(0));
        cell.far.forEach(mesh => detailed ? mesh.layers.disable(0) : mesh.layers.enable(0));
        for (const layer of [1, 2]) {
          const secondaryDetail = detailed && quality.detailedVegetationPasses;
          cell.near.forEach(mesh => secondaryDetail ? mesh.layers.enable(layer) : mesh.layers.disable(layer));
          cell.far.forEach(mesh => secondaryDetail ? mesh.layers.disable(layer) : mesh.layers.enable(layer));
        }
      }
      detailedPasses = quality.detailedVegetationPasses;
    },
  };
}
