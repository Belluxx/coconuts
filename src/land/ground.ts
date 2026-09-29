import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, dFdx, dFdy, float, max, mix, normalWorld, positionWorld, sin, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import { latticeHash, seededRandom } from '../math';
import { reliefNormal, surfaceCellular, surfaceNoise, surfaceNoise3D } from '../shading';
import { onPier } from '../structures/pierLayout';
import type { CausticsField } from '../water/caustics';
import { coastDistance, groundHeight, seabedHeight, shoreZ, terrainNoise } from './terrain';
import { FALLS_BOUNDS, POOL_LEVEL, fallsBedWetness, fallsSprayWetness, gorgeFloorWeight, gorgeSkyView, poolMask } from './waterfallLayout';
import { beachWater, wetAlbedo } from './wetSand';

/** A seamless 38.4cm sample of carbonate sand: pigment, height, mineral, roughness.
 * Real mipmaps integrate subpixel grains instead of aliasing procedural noise.
 */
function createSandGrainTexture() {
  const size = 512, cells = 256, data = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number, salt: number) => latticeHash((x + cells) % cells, (y + cells) % cells, salt);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / 2, py = (y + .5) / 2, ix = Math.floor(px), iy = Math.floor(py);
    let closest = Infinity, identity = 0, mineral = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const dx = px - cx - hash(cx, cy, 1847), dy = py - cy - hash(cx, cy, 9731);
      const aspect = .76 + hash(cx, cy, 3691) * .48;
      const distance = dx * dx * aspect + dy * dy / aspect;
      if (distance < closest) { closest = distance; identity = hash(cx, cy, 45871); mineral = hash(cx, cy, 65419); }
    }
    const dome = Math.pow(Math.max(0, 1 - closest * 1.9), .55);
    const pigment = mineral > .977 ? .25 + identity * .27 : .57 + identity * .39;
    const i = (y * size + x) * 4;
    data[i] = Math.round(pigment * 255);
    data[i + 1] = Math.round(dome * (identity * .2 + .8) * 255);
    data[i + 2] = Math.round(mineral * 255);
    data[i + 3] = Math.round((.7 + identity * .27) * 255);
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.name = 'Sand · seamless carbonate grain PBR data';
  map.colorSpace = THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true; map.anisotropy = 8; map.needsUpdate = true;
  return map;
}

/** Physical sand scales in meters. Fine grains average out rather than shimmer. */
function createSandMaterial(caustics: CausticsField) {
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: .91, metalness: 0 });
  const grainTexture = createSandGrainTexture();
  material.name = 'Sand · carbonate grains, wind ripples, swash and capillary moisture';
  const p = positionWorld.xz;
  const d = coastDistance(p);
  const footprint = max(dFdx(p).length(), dFdy(p).length());
  const resolved = (frequency: number) => float(1).sub(smoothstep(.3, 1.25, footprint.mul(frequency)));
  const cloud = surfaceNoise(p.mul(.17)).mul(.5).add(.5);
  const drift = surfaceNoise(p.mul(.69));
  const coarse = surfaceNoise(p.mul(76));
  const grain = texture(grainTexture, p.div(.384));
  const grainVisibility = resolved(360);

  // Water in and on the sand comes from the surf: swash soaks it, then it
  // drains toward capillary equilibrium above the beach's water table. The
  // same grains darken wet; nothing is painted by elevation.
  const beach = beachWater(p, positionWorld.y);
  const dryColor = mix(color('#d6c5a5'), color('#e7dbc1'), cloud.mul(.65).add(.25));
  const mineralPigment = mix(color('#a49174'), color('#f2e4c9'), grain.r);
  const dryPigment = mix(dryColor, mineralPigment, grainVisibility.mul(.45))
    .mul(float(1).add(coarse.mul(resolved(76)).mul(.065)));
  // Covered grains hold water in every pore; the sea's surface above does the trapping.
  const pigment = wetAlbedo(dryPigment, max(beach.poreWater, beach.covered), beach.poreWater.mul(float(1).sub(beach.covered)));
  const seabed = float(1).sub(smoothstep(-.18, .03, positionWorld.y));

  // Broken wind-ripple trains: a slowly wandering direction and patch mask
  // avoid the evenly spaced, continuous sine stripes of a synthetic texture.
  const phase = p.x.mul(28).add(p.y.mul(9)).add(drift.mul(3.4)).add(cloud.mul(7));
  const ripples = sin(phase).mul(.62).add(sin(phase.mul(2).add(.7)).mul(.18));
  const ripplePatch = smoothstep(.32, .69, cloud).mul(float(1).sub(smoothstep(.2, .6, beach.saturation)))
    .mul(float(1).sub(smoothstep(10, 19, d)));
  // Broad orbital ripples cross the submerged channels. Their relief is in
  // world units and filtered at distance, so they never turn into moiré lines.
  const seaPhase = p.y.mul(14).add(p.x.mul(3.1)).add(drift.mul(2.4)).add(cloud.mul(4));
  const seaRipples = sin(seaPhase).mul(.7).add(sin(seaPhase.mul(2).add(.5)).mul(.19));
  const seaRippleMask = seabed.mul(float(1).sub(smoothstep(-9, -2, d))).mul(cloud.mul(.6).add(.4));
  const sandRelief = ripples.mul(.0034).mul(ripplePatch).mul(resolved(5.2))
    .add(seaRipples.mul(.011).mul(seaRippleMask).mul(resolved(2.7)))
    .add(coarse.mul(.00085).mul(resolved(76)))
    .add(grain.g.mul(.00085));

  // A continuous living sward reaches the back of the beach. Broad green
  // cushions, small moss islands and exposed granite share the same terrain;
  // even gaps between individual plants therefore read as tropical ground.
  const boundary = d.add(surfaceNoise(p.mul(.23)).mul(3.7)).add(drift.mul(.85));
  const soil = smoothstep(10.5, 17.5, boundary);
  const meadow = surfaceNoise(p.mul(.085)).mul(.5).add(.5);
  const mossPatch = smoothstep(-.2, .32, surfaceNoise(p.mul(.8)));
  const sward = mix(color('#386c39'), color('#89ac4e'), meadow)
    .mul(float(1).add(drift.mul(.13)));
  const moss = mix(color('#477c3c'), color('#759d43'), cloud);
  const livingGround = mix(sward, moss, mossPatch.mul(.46));
  // Exposed faces continue the gray stone of the cliff assets. Green cover
  // belongs to upward-facing shelves; XYZ pigment avoids vertical streaks.
  const slope = float(1).sub(smoothstep(.34, .78, normalWorld.y));
  const exposed = slope.mul(smoothstep(14, 23, d)).mul(.97);
  const stoneCloud = surfaceNoise3D(positionWorld.mul(.24)).mul(.5).add(.5);
  const mineralRock = mix(color('#8e989c'), color('#b4afa2'), stoneCloud);
  // The waterfall's water: spray around the impact, and the beds and banks of
  // the pool and streams. Its gorge floor is granite gravel and coarse sand.
  const falls = attribute('watercourseWetness', 'vec3');
  const spray = falls.x, bed = falls.y, gorge = falls.z;
  const freshwater = max(spray, bed);
  const gravel = mix(color('#6f6d64'), color('#b8ad96'), cloud.mul(.7).add(coarse.mul(.15)).add(.15))
    .mul(surfaceCellular(p.mul(9)).mul(.18).add(.9));
  const terrainColor = mix(mix(mix(pigment, livingGround, soil), mineralRock, exposed), gravel, gorge);
  // Soaked grains darken like the beach's; permanently wet margins grow an algal film.
  const soaked = wetAlbedo(terrainColor, freshwater, freshwater);
  const biofilm = mix(color('#4d5a3c'), color('#6d7648'), mossPatch).mul(soaked.dot(vec3(.33)).mul(1.4));
  const wetBanks = mix(soaked, biofilm, spray.mul(smoothstep(.45, .9, spray)).mul(float(1).sub(bed)).mul(.55));
  // Foam the backwash leaves behind rests on the sand until its bubbles burst.
  const groundColor = mix(wetBanks, color('#eef2ea'), beach.stranded.mul(float(1).sub(soil)).mul(.85));
  const wetRoughness = float(.6).add(grain.a.sub(.5).mul(grainVisibility).mul(.1)).add(coarse.mul(.035));
  const beachRoughness = mix(mix(float(.91), grain.a, grainVisibility.mul(.4)).add(coarse.mul(.025)), wetRoughness, beach.poreWater)
    .add(soil.mul(.05)).sub(freshwater.mul(.3)).clamp(.32, .98);
  // Menisci between damp grains keep a broad, broken sheen. Under the sea,
  // grains have no air above them: use their rough surface and the relative
  // mineral IOR, or the seabed carries a second, un-refracted reflection.
  material.roughnessNode = mix(beachRoughness, float(.92), beach.covered);
  material.iorNode = mix(float(1.5), float(1.5 / 1.333), beach.covered);
  // The backwash's film is a thin layer of water over the grains: a clear coat.
  // Spray only dampens the gorge's sand, which keeps a broken sheen.
  material.clearcoatNode = max(beach.film.mul(float(1).sub(soil)), spray.mul(.2));
  material.clearcoatRoughnessNode = mix(beach.filmRoughness, float(.35), spray);
  // The gorge's walls hide part of the sky from its floor.
  material.aoNode = gorgeSkyView(positionWorld);

  const turfRelief = surfaceNoise(p.mul(17)).mul(.007).mul(resolved(17))
    .add(surfaceNoise(p.mul(3.7)).mul(.013));
  const stoneRelief = surfaceNoise3D(positionWorld.mul(1.8)).mul(.008);
  const height = sandRelief.mul(float(1).sub(soil))
    .add(mix(turfRelief, stoneRelief, exposed).mul(soil));
  material.normalNode = reliefNormal(height);
  // Sea caustics reach the sand through the sun itself. Freshwater sits above
  // sea level; light its curved sand bed using depth below the pool, without
  // adding a second intersecting floor mesh.
  const poolLight = caustics.lightNode(positionWorld.sub(vec3(0, POOL_LEVEL, 0))).mul(poolMask(p));
  material.colorNode = groundColor;
  material.emissiveNode = groundColor.mul(poolLight);
  return material;
}

/** Shared band edges keep coast-aligned tiles continuous at every resolution. */
function createTerrainRows(hasWaterfall: boolean) {
  const distances = [-650, -450, -325, -260, -230];
  // Resolve the explored shelf so terrain triangles follow the coral roots.
  for (let d = -220; d < -65; d += 2) distances.push(d);
  for (let d = -65; d < -16; d += 1) distances.push(d);
  for (let d = -16; d <= 26; d += hasWaterfall ? .25 : .5) distances.push(d);
  // Fine rows also follow the carved freshwater channel.
  if (hasWaterfall) for (let d = 26.25; d < 44; d += .25) distances.push(d);
  else distances.push(30, 36);
  distances.push(44, 55, 70, 85);

  const coastRows = distances.length;
  const inlandRows = 8;
  const boundaries = [0, distances.indexOf(-16), distances.indexOf(.5), distances.indexOf(30), coastRows + inlandRows - 1];
  const bands = ['offshore bed', 'lagoon bed', 'walking beach', 'living inland ground'].map((name, index) => ({
    name,
    first: boundaries[index],
    last: boundaries[index + 1],
  }));

  return {
    bands,
    zAt(x: number, row: number) {
      if (row < coastRows) return shoreZ(x) + distances[row];
      // Inland rows converge on the terrain boundary instead of extending the coast.
      return THREE.MathUtils.lerp(shoreZ(x) + 85, 179, (row - coastRows + 1) / inlandRows);
    },
  };
}

/** Continuous coast-aligned tiles put vertices on the beach rather than the horizon. */
function buildTerrain(material: THREE.Material) {
  const meshes: THREE.Mesh[] = [];
  const coastGrid = createTerrainRows(false);
  const waterfallGrid = createTerrainRows(true);
  const normal = new THREE.Vector3();
  for (let tile = 0; tile < 11; tile++) {
    const x0 = -165 + tile * 30;
    const hasWaterfall = x0 < FALLS_BOUNDS.maxX && x0 + 30 > FALLS_BOUNDS.minX;
    const { bands, zAt } = hasWaterfall ? waterfallGrid : coastGrid;
    const columns = hasWaterfall ? 120 : 60;
    for (const { name, first, last } of bands) {
      const vertices = (columns + 1) * (last - first + 1);
      const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3);
      const uvs = new Float32Array(vertices * 2), wetness = new Float32Array(vertices * 3), indices: number[] = [];
      for (let row = first; row <= last; row++) for (let column = 0; column <= columns; column++) {
        const x = x0 + column * 30 / columns, z = zAt(x, row), y = seabedHeight(x, z);
        const i = (row - first) * (columns + 1) + column;
        positions.set([x, y, z], i * 3);
        const dx = (seabedHeight(x + .12, z) - seabedHeight(x - .12, z)) / .24;
        const dz = (seabedHeight(x, z + .12) - seabedHeight(x, z - .12)) / .24;
        normal.set(-dx, 1, -dz).normalize();
        normals.set(normal.toArray(), i * 3);
        uvs.set([x, z], i * 2);
        if (hasWaterfall) wetness.set([fallsSprayWetness(x, z), fallsBedWetness(x, z), gorgeFloorWeight(x, z)], i * 3);
        if (column < columns && row < last) indices.push(i, i + columns + 1, i + 1, i + 1, i + columns + 1, i + columns + 2);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setAttribute('watercourseWetness', new THREE.BufferAttribute(wetness, 3));
      geometry.setIndex(indices);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `Ground · ${name} ${tile + 1}`;
      mesh.receiveShadow = true;
      meshes.push(mesh);
    }
  }
  return meshes;
}

function buildSandFragments(root: THREE.Group) {
  const random = seededRandom(559731), dummy = new THREE.Object3D();
  const geometries = [new THREE.IcosahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0)].map(source => {
    const geometry = mergeVertices(source);
    source.dispose();
    return geometry;
  });
  for (const geometry of geometries) { geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
  const material = new THREE.MeshStandardNodeMaterial({ color: '#fff9ed', roughness: .87 });
  material.name = 'Sand · coarse shell grit and carbonate crumbs';
  const batches = new Map<string, { transforms: THREE.Matrix4[]; tints: THREE.Color[]; form: number }>();
  const palette = ['#d2c3a4', '#ddd0b5', '#e6d8bd', '#a58d70', '#c1ad8a'].map(c => new THREE.Color(c));
  for (let i = 0; i < 8500; i++) {
    const x = -46 + random() * 92, d = 1.4 + Math.pow(random(), .8) * 13;
    const z = shoreZ(x) + d;
    if (onPier(x, z) || groundHeight(x, z) > 2.4) continue;
    // The high-tide deposit is a broken band; the rest is mostly clean fine sand.
    const deposit = Math.exp(-(((d - 3.7 - terrainNoise(x * .17, 4)) / 1.8) ** 2));
    const pocket = .5 + terrainNoise(x * .22, z * .3) * .5;
    if (random() > .12 + deposit * pocket * .75) continue;
    const cell = Math.floor((x + 46) / 12), form = i % 2, key = `${cell}/${form}`;
    if (!batches.has(key)) batches.set(key, { transforms: [], tints: [], form });
    const size = .0035 + Math.pow(random(), 2) * .019;
    dummy.position.set(x, groundHeight(x, z) + size * .12, z);
    dummy.scale.set(size * (1 + random() * .6), size * (.28 + random() * .35), size * (.75 + random() * .45));
    dummy.rotation.set(random() * .4, random() * Math.PI * 2, random() * .35);
    dummy.updateMatrix();
    batches.get(key)!.transforms.push(dummy.matrix.clone());
    batches.get(key)!.tints.push(palette[i % palette.length]);
  }
  for (const [key, batch] of batches) {
    const mesh = new THREE.InstancedMesh(geometries[batch.form], material, batch.transforms.length);
    batch.transforms.forEach((transform, i) => { mesh.setMatrixAt(i, transform); mesh.setColorAt(i, batch.tints[i]); });
    mesh.computeBoundingBox(); mesh.computeBoundingSphere();
    mesh.name = `Sand · embedded shell grit ${key}`;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

/** Sand, seabed and the island's ground share one continuous surface, with shell grit on the beach. */
export function createGround(caustics: CausticsField) {
  const root = new THREE.Group();
  root.name = 'Island · sand and weathered ground';
  const terrain = buildTerrain(createSandMaterial(caustics));
  root.add(...terrain);
  buildSandFragments(root);
  return { root, terrain };
}
