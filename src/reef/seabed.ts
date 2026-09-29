import * as THREE from 'three/webgpu';
import { attribute, color, float, positionLocal, positionWorld, sin, time, vec3 } from 'three/tsl';
import { createRockGeometry, createRockMaterial } from '../land/rocks';
import { seabedHeight, terrainNoise } from '../land/terrain';
import { seededRandom, V } from '../math';
import type { IslandCollisions } from '../player/collisions';
import { reliefNormal, surfaceNoise3D, type TSLNode } from '../shading';
import { ColoredGeometryBuilder, createCoralTemplates, type CoralSpecies, type CoralTemplate } from './coral';
import { createScallopGeometry, createSeaStarGeometry } from './coralGeometry';
import { MARINE_HABITATS, REEF_HABITATS } from './habitats';
import { SeabedPlacement, chooseMarineHabitat, reefFootprint, sampleMarineHabitat, settleColonyOnSeabed } from './placement';

const COLONY_SPECIES_ORDER = ['brain', 'staghorn', 'foliose', 'sponge', 'table', 'fan', 'barrel'] as const;

type ColonyBatch = {
  template: CoralTemplate;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[];
};

/** Living tissue shared by every reef surface; its variants differ only in sidedness and motion. */
function createReefMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .91, vertexColors: true });
  material.name = 'Reef · living tissue in caustic light';
  const tissue = surfaceNoise3D(positionWorld.mul(19));
  const pores = surfaceNoise3D(positionWorld.mul(63));
  const pigment = tissue.mul(.11).add(pores.mul(.045)).add(.98);
  material.colorNode = color('#ffffff').mul(pigment);
  material.normalNode = reliefNormal(tissue.mul(.0015).add(pores.mul(.0004)));
  return material;
}

/** Uneven reef gardens and seagrass meadows separated by luminous open sand. */
export function createSeabed(scene: THREE.Scene, collisions: IslandCollisions) {
  const group = new THREE.Group();
  group.name = 'Living reef · coral terraces, gorgonian gardens, and seagrass';
  scene.add(group);
  // Decorative passes continue the last habitat's random stream. Keep their
  // construction order stable to preserve the world's seeded details.
  let random = seededRandom(946317);
  const dummy = new THREE.Object3D();
  const obstacleMeshes = new Set<THREE.InstancedMesh>();
  // Only the solid masses need physics. A 20-triangle rounded envelope per
  // colony prevents camera penetration without obstructing open coral thickets.
  const collisionSphere = new THREE.IcosahedronGeometry(1, 0);
  // An icosahedron's circumradius is 1, but its axis extents are smaller.
  // Normalize those extents so the cheap proxy reaches the visible bounds.
  collisionSphere.computeBoundingBox();
  const extent = collisionSphere.boundingBox!.getSize(V()).multiplyScalar(.5);
  collisionSphere.scale(1 / extent.x, 1 / extent.y, 1 / extent.z);
  const addSolidEnvelope = (bounds: THREE.Box3, transform: THREE.Matrix4) => {
    const center = bounds.getCenter(V()), radius = bounds.getSize(V()).multiplyScalar(.49);
    const proxy = collisionSphere.clone().scale(radius.x, radius.y, radius.z).translate(center.x, center.y, center.z);
    proxy.applyMatrix4(transform);
    collisions.addGeometry(proxy);
    proxy.dispose();
  };

  const reefMaterial = createReefMaterial();
  const doubleSided = (positionNode?: TSLNode) => {
    const material = reefMaterial.clone();
    material.side = THREE.DoubleSide;
    if (positionNode) material.positionNode = positionNode;
    return material;
  };
  const coralMaterial = doubleSided();

  const habitats = MARINE_HABITATS;
  const habitatGroups = new Map<string, THREE.Group>();
  for (const habitat of habitats) {
    const chunk = new THREE.Group();
    chunk.name = `Marine habitat · ${habitat.id} · ${habitat.zone}`;
    group.add(chunk);
    habitatGroups.set(habitat.id, chunk);
  }
  const placement = new SeabedPlacement();

  // Weathered granite fragments embedded in the sand.
  const stoneGeometry = createRockGeometry(946317, 'boulder', 'near');
  stoneGeometry.computeBoundingBox();
  const stoneMaterial = createRockMaterial();
  const stoneMeshes: THREE.InstancedMesh[] = [];
  const stoneColors = ['#a3a38b', '#b5b09a', '#93977f', '#c3bba3'].map(hex => new THREE.Color(hex));
  for (const habitat of habitats) {
    random = seededRandom(habitat.seed + 31);
    const capacity = habitat.kind === 'reef' ? 15 : 9;
    const stones = new THREE.InstancedMesh(stoneGeometry, stoneMaterial, capacity);
    stones.name = 'Submerged weathered granite';
    let placed = 0;
    for (let stone = 0; stone < capacity; stone++) for (let attempt = 0; attempt < 20; attempt++) {
      const p = sampleMarineHabitat(random, habitat, 1.02);
      const large = habitat.kind === 'reef' && stone < 3;
      const radius = Math.min(large ? .63 + random() * .78 : .06 + Math.pow(random(), 2) * .44, Math.max(.065, -p.y * .36));
      const height = Math.min(radius * (.35 + random() * .3), Math.max(.05, -p.y * .42));
      dummy.position.copy(p).add(V(0, height * .06, 0));
      dummy.rotation.set((random() - .5) * .22, random() * Math.PI * 2, (random() - .5) * .15);
      dummy.scale.set(radius * (1.05 + random() * .4), height, radius * (.72 + random() * .35));
      dummy.updateMatrix();
      const bounds = stoneGeometry.boundingBox!.clone().applyMatrix4(dummy.matrix);
      const candidate = reefFootprint(bounds);
      if (!placement.hasSpace(candidate, .16)) continue;
      placement.reserve(candidate);
      stones.setMatrixAt(placed, dummy.matrix);
      stones.setColorAt(placed, stoneColors[stone % stoneColors.length].clone().multiplyScalar(.9 + random() * .14));
      if (large) addSolidEnvelope(stoneGeometry.boundingBox!, dummy.matrix);
      placed++;
      break;
    }
    stones.count = placed;
    stones.receiveShadow = true;
    stones.castShadow = true;
    stones.computeBoundingSphere();
    habitatGroups.get(habitat.id)!.add(stones);
    obstacleMeshes.add(stones);
    stoneMeshes.push(stones);
  }
  group.updateMatrixWorld(true);
  const substrateRay = new THREE.Raycaster();
  const substrateHits: THREE.Intersection[] = [];
  const onSubstrate = (point: THREE.Vector3) => {
    substrateHits.length = 0;
    substrateRay.set(V(point.x, 0, point.z), V(0, -1, 0));
    for (const stones of stoneMeshes) stones.raycast(substrateRay, substrateHits);
    for (const hit of substrateHits) if (hit.point.y > point.y && hit.point.y < -.3) point.y = hit.point.y;
    return point;
  };

  const details = new ColoredGeometryBuilder();
  const finishColored = (name: string, material: THREE.Material) => {
    const mesh = new THREE.Mesh(details.build(), material);
    mesh.name = name;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Small, broken aprons of shell grit and algae visually root the reef. Their
  // feathered, sand-coloured edges follow the terrain, with bare gaps inside.
  const apronPositions: number[] = [], apronColors: number[] = [];
  for (const habitat of habitats) {
    const core = new THREE.Color(habitat.kind === 'grass' ? '#929b6e' : habitat.kind === 'reef' ? '#aea78b' : '#c5bba0');
    const sand = new THREE.Color('#d7ccb0');
    for (let island = 0; island < (habitat.kind === 'reef' ? 8 : 5); island++) {
      const center = sampleMarineHabitat(random, habitat, .82);
      const radius = .65 + random() * (habitat.kind === 'reef' ? 1.6 : 1.25);
      const vertex = (a: number, t: number) => {
        const edge = 1 + Math.sin(a * 3 + island) * .18 + Math.cos(a * 7 + habitat.x) * .09;
        const x = center.x + Math.cos(a) * radius * t * edge;
        const z = center.z + Math.sin(a) * radius * t * edge * .68;
        const pigment = terrainNoise(x * 3.7, z * 3.7);
        apronPositions.push(x, seabedHeight(x, z) + .012 + (1 - t) * .012, z);
        const tint = core.clone().lerp(sand, Math.pow(t, 3) * .93).multiplyScalar(.99 + pigment * .05);
        apronColors.push(tint.r, tint.g, tint.b);
      };
      for (let segment = 0; segment < 24; segment++) for (let row = 0; row < 4; row++) {
        const a = segment / 24 * Math.PI * 2, b = (segment + 1) / 24 * Math.PI * 2;
        const inner = row / 4, outer = (row + 1) / 4;
        vertex(a, inner); vertex(b, outer); vertex(a, outer);
        if (row > 0) { vertex(a, inner); vertex(b, inner); vertex(b, outer); }
      }
    }
  }
  const apronGeometry = new THREE.BufferGeometry();
  apronGeometry.setAttribute('position', new THREE.Float32BufferAttribute(apronPositions, 3));
  apronGeometry.setAttribute('color', new THREE.Float32BufferAttribute(apronColors, 3));
  apronGeometry.computeVertexNormals();
  const aprons = new THREE.Mesh(apronGeometry, reefMaterial);
  aprons.name = 'Broken reef aprons · algae and shell grit fading into sand';
  aprons.receiveShadow = true;
  group.add(aprons);

  // Small, bleached coral fragments collect in the sheltered sides of deposits.
  const rubbleColors = ['#d2cbb1', '#bfbda5', '#cbc3a9', '#c7c7ab'].map(hex => new THREE.Color(hex));
  for (let i = 0; i < 86; i++) {
    const habitat = chooseMarineHabitat(random, i % 3 === 0 ? 'rubble' : 'reef');
    const p = sampleMarineHabitat(random, habitat, 1.04);
    if (p.y > -.4) continue;
    const tint = rubbleColors[i % rubbleColors.length];
    const yaw = random() * Math.PI * 2;
    const length = .13 + random() * .3;
    const a = p.clone().add(V(0, .026, 0));
    const b = a.clone().add(V(Math.cos(yaw) * length, .03 + random() * .055, Math.sin(yaw) * length));
    details.branch(a, b, .024 + random() * .019, tint);
    const fork = a.clone().lerp(b, .52);
    details.branch(fork, fork.clone().add(V(Math.cos(yaw + 1.1) * length * .53, .045 + random() * .07, Math.sin(yaw + 1.1) * length * .53)), .021, tint);
    if (i % 3 === 0) details.add(new THREE.IcosahedronGeometry(1, 1), tint, p.clone().add(V(.15, .055, -.12)), V(.13, .07, .09));
  }
  finishColored('Pale worn coral rubble at the reef edges', reefMaterial);

  // Attachment stays still; the lattice flexes slowly with the same current
  // as the grass. At metre scale, a centimetre of motion is sufficient.
  const fanFlex = attribute('fanFlex', 'float');
  const fanCurrent = sin(time.mul(.48).add(positionLocal.x.mul(.32))).mul(fanFlex).mul(.022);
  const fanMaterial = doubleSided(positionLocal.add(vec3(fanCurrent.mul(.32), float(0), fanCurrent)));

  const templates = createCoralTemplates(random);

  for (const habitat of REEF_HABITATS) {
    random = seededRandom(habitat.seed + 941);
    const targetCount = THREE.MathUtils.clamp(Math.round(habitat.rx * habitat.rz * .70), 42, 62);
    const batches = new Map<CoralSpecies, ColonyBatch>();
    for (let colony = 0; colony < targetCount; colony++) {
      const speciesIndex = (colony + habitat.seed) % COLONY_SPECIES_ORDER.length;
      const name = COLONY_SPECIES_ORDER[speciesIndex];
      const variant = (habitat.seed + speciesIndex) % 3;
      const template = templates.find(item => item.name === name && item.variant === variant)!;
      for (let attempt = 0; attempt < 56; attempt++) {
        const p = sampleMarineHabitat(random, habitat, .94);
        // Most colonies are young to mature, with occasional larger specimens.
        const growth = colony % 13 === 0 ? .95 + random() * .18 : .43 + Math.pow(random(), 1.2) * .65;
        const size = Math.min(growth, Math.max(.18, -p.y * .47));
        dummy.position.copy(p).add(V(0, -.025, 0));
        dummy.rotation.set((random() - .5) * .08, random() * Math.PI * 2, (random() - .5) * .08);
        dummy.scale.set(size * (.9 + random() * .22), size * (.78 + random() * .32), size * (.88 + random() * .24));
        if (name === 'staghorn' || name === 'sponge' || name === 'barrel') dummy.scale.y *= .85;
        if (name === 'fan') {
          dummy.rotation.y = -.5 + random() * 1.9;
          dummy.scale.multiplyScalar(1.08);
        }
        dummy.updateMatrix();
        let bounds = template.geometry.boundingBox!.clone().applyMatrix4(dummy.matrix);
        let candidate = reefFootprint(bounds);
        if (!placement.hasSpace(candidate)) continue;
        if (!settleColonyOnSeabed(dummy, p, candidate.radius, template.roots)) continue;
        bounds = template.geometry.boundingBox!.clone().applyMatrix4(dummy.matrix);
        candidate = reefFootprint(bounds);
        placement.reserve(candidate);
        if (!batches.has(name)) batches.set(name, { template, matrices: [], colors: [] });
        const batch = batches.get(name)!;
        batch.matrices.push(dummy.matrix.clone());
        batch.colors.push(template.palette[(colony + variant) % template.palette.length].clone().multiplyScalar(.9 + random() * .17));
        if (template.solid) addSolidEnvelope(template.geometry.boundingBox!, dummy.matrix);
        break;
      }
    }
    for (const [name, batch] of batches) {
      const colonies = new THREE.InstancedMesh(batch.template.geometry, name === 'fan' ? fanMaterial : coralMaterial, batch.matrices.length);
      colonies.name = `Reef ${name} · ${habitat.id}`;
      for (let i = 0; i < batch.matrices.length; i++) {
        colonies.setMatrixAt(i, batch.matrices[i]);
        colonies.setColorAt(i, batch.colors[i]);
      }
      colonies.receiveShadow = true;
      colonies.castShadow = name !== 'fan';
      colonies.computeBoundingSphere();
      habitatGroups.get(habitat.id)!.add(colonies);
      obstacleMeshes.add(colonies);
    }
  }

  // Small grazing urchins shelter at reef margins. The spines are real tapered
  // geometry, so their silhouettes stay fine when a swimmer comes close.
  details.add(new THREE.SphereGeometry(1, 16, 10), new THREE.Color('#3c3347'), V(0, .075, 0), V(.11, .075, .11));
  for (let spine = 0; spine < 76; spine++) {
    const azimuth = spine * 2.399963, elevation = .07 + Math.asin((spine + .5) / 76) * .94;
    const direction = V(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation));
    const length = .105 + random() * .12;
    const origin = direction.clone().multiply(V(.095, .068, .095)).add(V(0, .075, 0));
    const quaternion = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), direction);
    const tint = new THREE.Color(spine % 4 === 0 ? '#71627e' : '#40384f');
    details.add(new THREE.ConeGeometry(.0032 + random() * .0014, length, 4), tint,
      origin.addScaledVector(direction, length * .49), V(1, 1, 1), quaternion);
  }
  const urchinGeometry = details.build();
  const urchins = new THREE.InstancedMesh(urchinGeometry, coralMaterial, 34);
  urchins.name = 'Long-spined reef urchins';
  let urchinCount = 0;
  for (let i = 0; i < urchins.count; i++) {
    let p: THREE.Vector3 | undefined;
    for (let attempt = 0; attempt < 24; attempt++) {
      const habitat = chooseMarineHabitat(random, 'reef');
      const candidate = sampleMarineHabitat(random, habitat, 1.04);
      if (placement.hasDetailSpace(candidate, .34)) { p = candidate; break; }
    }
    if (!p) continue;
    dummy.position.copy(p);
    dummy.rotation.set(0, random() * Math.PI * 2, 0);
    dummy.scale.setScalar(.78 + random() * .58);
    dummy.updateMatrix();
    urchins.setMatrixAt(urchinCount++, dummy.matrix);
  }
  urchins.count = urchinCount;
  urchins.receiveShadow = true;
  group.add(urchins);

  // Thin ribbons move with a slow current. They have actual curved silhouettes,
  // with motion weighted at the tips so every root stays attached to the sand.
  const grassPositions: number[] = [], grassColors: number[] = [], grassFlex: number[] = [];
  const grassPalette = ['#697d51', '#75865a', '#52674a'].map(hex => new THREE.Color(hex));
  const grassVertex = (p: THREE.Vector3, c: THREE.Color, flex: number) => {
    grassPositions.push(p.x, p.y, p.z);
    grassColors.push(c.r, c.g, c.b);
    grassFlex.push(flex);
  };
  for (let tuft = 0; tuft < 690; tuft++) {
    const habitat = chooseMarineHabitat(random, tuft < 510 ? 'grass' : 'reef');
    const p = sampleMarineHabitat(random, habitat, tuft < 510 ? 1 : 1.08);
    if (!placement.hasDetailSpace(p, .63)) continue;
    const substrate = onSubstrate(p.clone());
    if (substrate.y - p.y > .055) continue;
    // Clear little channels also wind through the meadows themselves.
    if (terrainNoise(p.x * .58, p.z * .61) < -.27) continue;
    if (p.y > -.45 || p.y < -10.5) continue;
    const bladeCount = 4 + Math.floor(random() * 5);
    for (let blade = 0; blade < bladeCount; blade++) {
      const yaw = random() * Math.PI * 2;
      const length = Math.min(.22 + random() * .56, -p.y * .68);
      const width = .015 + random() * .017;
      const origin = p.clone().add(V((random() - .5) * .2, .014, (random() - .5) * .2));
      const tint = grassPalette[(tuft + blade) % grassPalette.length].clone().multiplyScalar(.87 + random() * .23);
      const side = V(Math.cos(yaw), 0, Math.sin(yaw));
      const bend = V(.52 + Math.sin(yaw) * .23, 0, .38 + Math.cos(yaw) * .18);
      const point = (t: number, across: number) => {
        const bladeWidth = width * Math.pow(Math.sin(Math.PI * (.16 + t * .84)), .8);
        return origin.clone().add(V(0, length * t, 0))
          .addScaledVector(bend, length * t * t)
          .addScaledVector(side, across * bladeWidth)
          .add(V(0, (1 - Math.abs(across)) * bladeWidth * .26, 0));
      };
      const midrib = tint.clone().multiplyScalar(1.10), edge = tint.clone().multiplyScalar(.93);
      for (let row = 0; row < 6; row++) for (const sign of [-1, 1]) {
        const a = row / 6, b = (row + 1) / 6;
        if (sign < 0) {
          grassVertex(point(a, sign), edge, a * a); grassVertex(point(b, sign), edge, b * b); grassVertex(point(a, 0), midrib, a * a);
          grassVertex(point(a, 0), midrib, a * a); grassVertex(point(b, sign), edge, b * b); grassVertex(point(b, 0), midrib, b * b);
        } else {
          grassVertex(point(a, sign), edge, a * a); grassVertex(point(a, 0), midrib, a * a); grassVertex(point(b, sign), edge, b * b);
          grassVertex(point(a, 0), midrib, a * a); grassVertex(point(b, 0), midrib, b * b); grassVertex(point(b, sign), edge, b * b);
        }
      }
    }
  }
  const grassGeometry = new THREE.BufferGeometry();
  grassGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grassPositions, 3));
  grassGeometry.setAttribute('color', new THREE.Float32BufferAttribute(grassColors, 3));
  grassGeometry.setAttribute('flex', new THREE.Float32BufferAttribute(grassFlex, 1));
  grassGeometry.computeVertexNormals();
  const current = sin(time.mul(.71).add(positionLocal.x.mul(.9)).add(positionLocal.z.mul(.57))).mul(attribute('flex', 'float')).mul(.049);
  const grasses = new THREE.Mesh(grassGeometry, doubleSided(positionLocal.add(vec3(current, float(0), current.mul(.63)))));
  grasses.name = 'Uneven seagrass meadows · slow underwater current';
  grasses.receiveShadow = true;
  group.add(grasses);

  // Shells and occasional living stars are discoveries at the scale of a hand.
  for (let i = 0; i < 112; i++) {
    const habitat = chooseMarineHabitat(random);
    const p = sampleMarineHabitat(random, habitat, 1.35);
    if (p.y > -.23 || !placement.hasDetailSpace(p, .15)) continue;
    const radius = .07 + random() * .085;
    const yaw = random() * Math.PI * 2;
    const geometry = createScallopGeometry(i * 1.7);
    const tint = new THREE.Color(i % 4 === 0 ? '#cfb4a0' : '#ddd6bc');
    details.add(geometry, tint, p.add(V(0, .014, 0)), V(radius, radius, radius), new THREE.Quaternion().setFromEuler(new THREE.Euler(.04, yaw, -.03)));
  }
  const starPalette = ['#bd7c51', '#be9264', '#67879e'].map(hex => new THREE.Color(hex));
  for (let star = 0; star < 24; star++) {
    const habitat = chooseMarineHabitat(random, star % 3 ? 'reef' : undefined);
    const p = onSubstrate(sampleMarineHabitat(random, habitat, 1.17));
    if (p.y > -.3 || !placement.hasDetailSpace(p, .25)) continue;
    const radius = .12 + random() * .13;
    const geometry = createSeaStarGeometry(star * 1.31);
    details.add(geometry, starPalette[star % starPalette.length], p.add(V(0, .018, 0)), V(radius, radius, radius), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), random() * Math.PI * 2));
  }
  finishColored('Quiet details in the coral sand', coralMaterial);
  collisionSphere.dispose();
  group.updateMatrixWorld(true);
  const chunkBounds = habitats.map(habitat => {
    const chunk = habitatGroups.get(habitat.id)!;
    const bounds = new THREE.Box3().setFromObject(chunk);
    const center = bounds.isEmpty() ? V(habitat.x, 0, habitat.z) : bounds.getCenter(V());
    const size = bounds.isEmpty() ? V() : bounds.getSize(V());
    return { chunk, center, radius: Math.hypot(size.x, size.z) * .5 };
  });
  // Wildlife receives explicit world bounds. Preserve scene traversal order so
  // summing avoidance forces remains stable across habitat and species batches.
  const obstacleBounds: THREE.Box3[] = [];
  const instanceTransform = new THREE.Matrix4();
  group.traverse(object => {
    if (!(object instanceof THREE.InstancedMesh) || !obstacleMeshes.has(object)) return;
    object.geometry.computeBoundingBox();
    object.updateWorldMatrix(true, false);
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, instanceTransform);
      instanceTransform.premultiply(object.matrixWorld);
      obstacleBounds.push(object.geometry.boundingBox!.clone().applyMatrix4(instanceTransform));
    }
  });

  // The reef never moves: skip per-frame matrix updates.
  group.traverse(object => { object.updateMatrix(); object.matrixAutoUpdate = false; });
  return {
    group,
    /** World bounds of every solid colony and boulder, for wildlife to swim around. */
    obstacleBounds: Object.freeze(obstacleBounds),
    /** Hide habitats out of view range; this also serves the water mirror, which shares X/Z. */
    update(cameraPosition: THREE.Vector3) {
      const range = cameraPosition.y < -.12 ? 102 : 145;
      for (const { chunk, center, radius } of chunkBounds) {
        chunk.visible = Math.hypot(cameraPosition.x - center.x, cameraPosition.z - center.z) < range + radius;
      }
    },
  };
}
