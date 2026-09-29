import * as THREE from 'three/webgpu';
import {
  asin, atan, attribute, cameraPosition, cameraProjectionMatrixInverse, cross, dot, exp, float, fract, getViewPosition, max,
  mix, mx_noise_float, normalWorld, normalize, positionLocal, positionView, positionWorld, reflect, screenUV,
  smoothstep, time, transformNormalToView, uv, vec2, vec3, viewportDepthTexture, viewportSafeUV,
} from 'three/tsl';
import type { IslandCollisions } from '../player/collisions';
import { seededRandom } from '../math';
import { billboardGeometry } from '../render/billboards';
import { surfaceCellular, surfaceNoise, type TSLNode } from '../shading';
import type { EnvironmentMap } from '../sky/environmentMap';
import type { CausticsField } from '../water/caustics';
import { WATER_IOR, fresnel } from '../water/optics';
import type { RefractionCapture } from '../water/refraction';
import { createRockGeometry, createRockMaterial } from './rocks';
import { groundHeight } from './terrain';
import { createGorgeWall } from './waterfallGorge';
import {
  ACROSS, BRINK, CREEK, DISCHARGE, FALL_HEIGHT, FALL_TIME, FLOW, IMPACT_POINT, LIP, POOL, POOL_LEVEL,
  creekHalfWidth, gorgeHorizon, toWorld,
} from './waterfallLayout';
import { createFallsLight, type FallsLight } from './waterfallLight';
import { createWaterfallSpray } from './waterfallSpray';

const GRAVITY = 9.81;
/**
 * A forest stream: pure water with a trace of tannin from leaf litter, and
 * a little fine silt (1/m, red, green, blue).
 */
const FRESH_ABSORPTION = vec3(.31, .086, .105);
const FRESH_SCATTERING = .08, FRESH_BACKSCATTER = .0016;
/** Diffuse light the surface reflects back down from below: 1 − (1 − 0.066)/n². */
const INTERNAL_REFLECTANCE = 1 - (1 - .066) / WATER_IOR ** 2;

/** Normal-depth flow (Manning) of the discharge over a channel of half-width `half` and bed slope `slope`. */
function normalFlow(half: number, slope: number, roughness: number) {
  const q = DISCHARGE / (2 * half);
  const depth = Math.max(.03, Math.min(.45, (q * roughness / Math.sqrt(Math.max(slope, .005))) ** .6));
  return { depth, speed: q / depth };
}

/**
 * Shading shared by the pool and the creek, from the same optics as the
 * lagoon: Fresnel reflection of the sky and of the gorge's walls, the bed
 * seen through the water with Beer–Lambert absorption, light trapped under
 * the surface, the n² law, bubble clouds and foam rafts.
 */
function freshwater(
  light: FallsLight, refraction: RefractionCapture, environmentMap: EnvironmentMap,
  normal: TSLNode, alpha2: TSLNode, bubbles: TSLNode, foam: TSLNode,
) {
  const point = positionWorld;
  const eye = normalize(cameraPosition.sub(point));
  const facing = max(dot(normal, eye), .001);
  const reflectance = fresnel(facing);
  const floorAt = (coords: TSLNode) => getViewPosition(coords, viewportDepthTexture(coords), cameraProjectionMatrixInverse);
  const path = floorAt(screenUV).sub(positionView).length().min(20).toVar();
  const ripple = transformNormalToView(normal).sub(transformNormalToView(vec3(0, 1, 0))).xy;
  const shifted = viewportSafeUV(screenUV.add(ripple.mul(vec2(1, -1)).mul(path.min(1.2).mul(.05)).div(positionView.z.negate().max(1))).clamp(.001, .999));
  const bed = refraction.sample(shifted).rgb;
  const extinction = FRESH_ABSORPTION.add(FRESH_SCATTERING);
  const image = exp(extinction.mul(path).negate());
  // Daylight reaching the water: the radiance of a white horizontal surface there.
  const white = light.diffuse(point, vec3(0, 1, 0));
  const trapping = vec3(1).div(vec3(1).sub(bed.div(white.max(.0001)).clamp(0, 1).mul(image).mul(image).mul(INTERNAL_REFLECTANCE)));
  const ratio = FRESH_ABSORPTION.mul(1.5).div(FRESH_BACKSCATTER);
  const body = ratio.add(1).sub(ratio.mul(ratio).add(ratio.mul(2)).sqrt()).mul(white).mul(vec3(1).sub(image));
  const clear = float(1).sub(bubbles);
  const below = bed.mul(image).mul(trapping).add(body).mul(clear.mul(clear)).add(white.mul(bubbles));
  const transmitted = below.mul(float(1).sub(reflectance)).div(WATER_IOR ** 2);
  // The gorge's walls fill the reflection below their rim.
  const mirrored = reflect(eye.negate(), normal);
  const horizontal = normalize(mirrored.xz.add(vec2(.0001, 0)));
  const wall = smoothstep(-.03, .03, gorgeHorizon(point, horizontal).sub(asin(mirrored.y.clamp(-1, 1))));
  const sky = environmentMap.sample(mirrored, alpha2.sqrt().sqrt().clamp(.03, .5)).rgb;
  const rock = light.sky.mul(.5).mul(.16);
  const reflected = mix(sky, rock, wall).mul(reflectance);
  const glints = light.glints(normal, eye, alpha2, point).mul(float(1).sub(wall));
  const foamLight = white.mul(.75);
  const color = mix(reflected.add(transmitted).add(glints), foamLight, foam);
  const vertical = path.mul(eye.y.max(.05));
  return { color, opacity: smoothstep(.002, .02, vertical) };
}

/** The free-falling nappe: its centerline and edges follow the ballistic path from the brink. */
function nappeGeometry() {
  const rows = 90, columns = 32, positions: number[] = [], coords: number[] = [], falls: number[] = [], indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    const fall = (FALL_HEIGHT + .2) * (row / rows) ** 1.15, t = Math.sqrt(2 * fall / GRAVITY);
    for (let column = 0; column <= columns; column++) {
      const u = column / columns * 2 - 1;
      // Friction on the channel's sides slows the edges; the sheet spreads as it falls.
      const along = BRINK.speed * (1 - .28 * u * u) * t;
      const across = u * LIP.width / 2 * (1 + .035 * fall) * (1 - .05 * Math.exp(-fall / .3) * u ** 8);
      const p = toWorld(along, across);
      positions.push(p.x, LIP.y - .05 + BRINK.depth / 2 - fall, p.z);
      coords.push(column / columns, t);
      falls.push(fall);
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column;
        indices.push(a, a + columns + 1, a + 1, a + 1, a + columns + 1, a + columns + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  geometry.setAttribute('fall', new THREE.Float32BufferAttribute(falls, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Leaving the brink the sheet is clear and glassy. Turbulence roughens it,
 * and within a few meters it breaks up into aerated fingers and packets that
 * scatter light like snow. Every texture here rides with the water: it is a
 * function of the moment each parcel left the brink, so features stretch as
 * the water accelerates.
 */
function createNappe(light: FallsLight, refraction: RefractionCapture, environmentMap: EnvironmentMap) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.name = 'Waterfall · free-falling nappe';
  material.forceSinglePass = true;
  const u = uv().x.mul(2).sub(1), fall = attribute('fall', 'float');
  const launch = time.sub(uv().y);
  const lane = u.mul(5.5).add(mx_noise_float(vec2(u.mul(2), launch.mul(.15))).mul(.8));
  const fingers = mx_noise_float(vec2(lane, launch.mul(.35))).mul(.5).add(.5);
  const packets = mx_noise_float(vec2(u.mul(13).add(fingers.mul(1.5)), launch.mul(5.5))).mul(.5).add(.5);
  const fine = mx_noise_float(vec2(u.mul(40), launch.mul(16)));
  const edge = smoothstep(.55, 1, u.abs());
  const aeration = float(1).sub(exp(fall.div(-2.4))).max(edge.mul(float(1).sub(exp(fall.div(-.7))))).toVar();
  const structure = fingers.mul(.55).add(packets.mul(.45)).add(fine.mul(.08));
  const white = aeration.mul(smoothstep(.3, .68, structure).mul(.7).add(.3)).toVar();
  // The sheet flaps gently as air drags on it.
  const flap = mx_noise_float(vec2(u.mul(1.5), launch.mul(1.3))).mul(.05).mul(fall.div(FALL_HEIGHT));
  material.positionNode = positionLocal.add(vec3(FLOW.x, 0, FLOW.z).mul(flap));

  const eye = normalize(cameraPosition.sub(positionWorld));
  const facingEye = normalWorld.mul(dot(normalWorld, eye).sign()).toVar();
  const downstream = normalize(cross(facingEye, vec3(ACROSS.x, 0, ACROSS.z)));
  const tilt = vec2(mx_noise_float(vec2(u.mul(9), launch.mul(2))), mx_noise_float(vec2(u.mul(9).add(5), launch.mul(2.3)))).mul(.3);
  const normal = normalize(facingEye.add(vec3(ACROSS.x, 0, ACROSS.z).mul(tilt.x)).add(downstream.mul(tilt.y)));
  const reflectance = fresnel(dot(normal, eye).abs().max(.001));
  const sky = environmentMap.sample(reflect(eye.negate(), normal), float(.06)).rgb;
  const behind = refraction.sample(viewportSafeUV(screenUV.add(tilt.mul(.012)).clamp(.001, .999))).rgb;
  const glassy = sky.mul(reflectance).add(behind.mul(float(1).sub(reflectance).pow(2)))
    .add(light.glints(normal, eye, float(.004), positionWorld));
  // Aerated water: a thick scattering layer that also passes light from behind.
  const aerated = light.diffuse(positionWorld, facingEye, float(.45)).mul(.82);
  material.colorNode = mix(glassy, aerated, white);
  const fray = float(1).sub(smoothstep(.8, 1, u.abs().add(packets.mul(.18).mul(aeration))));
  const settle = smoothstep(POOL_LEVEL - .1, POOL_LEVEL + .15, positionWorld.y);
  material.opacityNode = max(white.mul(.95), max(float(1).sub(aeration).mul(.9), aeration.mul(.2))).mul(fray).mul(settle);
  const mesh = new THREE.Mesh(nappeGeometry(), material);
  mesh.name = 'Waterfall · nappe';
  mesh.renderOrder = 2.3;
  return mesh;
}

/**
 * Aerated packets shed from the breaking sheet. Air drag slows them toward
 * terminal speed, so they lag the jet's core; the eye sees them as streaks.
 */
function createPackets(light: FallsLight) {
  const random = seededRandom(66103);
  const geometry = billboardGeometry(1200, () => {
    const u = random() * 2 - 1, start = toWorld(0, u * LIP.width / 2);
    const speed = BRINK.speed * (1 - .28 * u * u);
    const lateral = (random() - .5) * .35 + u * .12;
    return {
      position: [start.x, LIP.y, start.z],
      packetVelocity: [FLOW.x * speed + ACROSS.x * lateral, 0, FLOW.z * speed + ACROSS.z * lateral],
      packetSeed: [random(), 7 + random() * 7, .05 + random() ** 2 * .12, 0],
    };
  });
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.name = 'Waterfall · aerated packets';
  material.forceSinglePass = true;
  const seed = attribute('packetSeed', 'vec4');
  const life = FALL_TIME * 1.7;
  const age = fract(time.div(life).add(seed.x)).mul(life);
  const relax = seed.y.div(GRAVITY), decay = float(1).sub(exp(age.div(relax).negate()));
  const velocity0 = attribute('packetVelocity', 'vec3');
  const center = attribute('position', 'vec3').add(velocity0.mul(relax).mul(decay))
    .sub(vec3(0, seed.y.mul(age.sub(relax.mul(decay))), 0));
  const velocity = velocity0.mul(exp(age.div(relax).negate())).sub(vec3(0, seed.y.mul(decay), 0));
  const view = normalize(center.sub(cameraPosition));
  const along = normalize(velocity.add(vec3(0, -.001, 0))), across = normalize(cross(along, view));
  const corner = uv().sub(.5).mul(2);
  const length = seed.z.add(velocity.length().mul(.045));
  material.positionNode = center.add(along.mul(corner.y.mul(length))).add(across.mul(corner.x.mul(seed.z)));
  const fall = float(LIP.y).sub(center.y);
  const alive = smoothstep(1, 3, fall).mul(smoothstep(POOL_LEVEL, POOL_LEVEL + .2, center.y));
  material.colorNode = light.diffuse(positionWorld, view.negate(), float(.5)).mul(.82);
  material.opacityNode = float(1).sub(smoothstep(.35, 1, corner.length())).mul(alive).mul(.8);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Waterfall · packets';
  mesh.renderOrder = 2.4;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(IMPACT_POINT.x, POOL_LEVEL + FALL_HEIGHT / 2, IMPACT_POINT.z), FALL_HEIGHT);
  return mesh;
}

/**
 * The plunge pool. The jet drives a bubble plume and a boil; surface water
 * streams radially out of it toward the boulder rim. Foam made in the boil
 * rides that flow and bursts along the way: its cover at each point follows
 * from the travel time. Capillary ripples ring outward from the impact.
 */
function createPool(light: FallsLight, refraction: RefractionCapture, environmentMap: EnvironmentMap) {
  const positions: number[] = [], indices: number[] = [], rings = 28, sectors = 96;
  for (let ring = 0; ring <= rings; ring++) for (let sector = 0; sector <= sectors; sector++) {
    const radius = 1.22 * ring / rings, angle = sector / sectors * Math.PI * 2;
    const p = toWorld(POOL.along + Math.cos(angle) * radius * POOL.radiusAlong, Math.sin(angle) * radius * POOL.radiusAcross);
    positions.push(p.x, POOL_LEVEL, p.z);
    if (ring < rings && sector < sectors) {
      const a = ring * (sectors + 1) + sector;
      indices.push(a, a + 1, a + sectors + 1, a + 1, a + sectors + 2, a + sectors + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const xz = positionWorld.xz;
  const offset = xz.sub(vec2(IMPACT_POINT.x, IMPACT_POINT.z));
  const distance = offset.length().max(.05).toVar();
  const radial = offset.div(distance);
  // Radial outflow from the boil: spreading keeps speed × radius constant.
  const boilSpeed = 1.3, boilRadius = .7;
  const velocity = radial.mul(float(boilSpeed * boilRadius).div(distance.max(boilRadius))).toVar();
  const age = distance.mul(distance).sub(boilRadius ** 2).max(0).div(2 * boilSpeed * boilRadius);
  const coverage = exp(age.div(-7));
  // Flow-mapped lace: two phases of the pattern, each advected half a cycle apart.
  const lace = (phase: number) => {
    const cycle = fract(time.div(2.4).add(phase));
    const drifted = xz.sub(velocity.mul(cycle.mul(2.4))).add(phase * 7.3);
    const warped = drifted.add(vec2(surfaceNoise(drifted.mul(.9)), surfaceNoise(drifted.mul(.8).add(17))).mul(.3));
    return {
      pattern: surfaceCellular(warped.mul(2.6)).mul(.75).add(surfaceCellular(warped.mul(10).add(5)).mul(.25)),
      wavelets: vec2(surfaceNoise(drifted.mul(5)), surfaceNoise(drifted.mul(5).add(3))),
      weight: float(1).sub(cycle.mul(2).sub(1).abs()),
    };
  };
  const a = lace(0), b = lace(.5);
  const pattern = a.pattern.mul(a.weight).add(b.pattern.mul(b.weight));
  const threshold = float(1).sub(coverage.mul(1.1));
  const foam = smoothstep(threshold, threshold.add(.12), pattern).mul(.92);
  // The plume under the impact: optically thick bubbles, two-stream reflectance.
  const plume = exp(distance.div(1.1).pow(2).negate()).mul(40);
  const bubbles = plume.div(plume.add(2));
  // Surface slopes: the turbulent boil, ripples ringing outward, and wavelets in the flow.
  const boil = exp(distance.div(-1.1));
  const churn = vec2(mx_noise_float(vec3(xz.mul(2.2), time.mul(1.7))), mx_noise_float(vec3(xz.mul(2.2).add(9), time.mul(1.7)))).mul(boil.mul(.55));
  // Capillary–gravity ripples: each wavelength travels at its own speed and spreads cylindrically.
  let ringing: TSLNode = float(0);
  for (const [k, amplitude, phase] of [[18, .0045, 0], [29, .003, 1.7], [46, .0018, 4.1]]) {
    const omega = Math.sqrt(GRAVITY * k + 7.4e-5 * k ** 3);
    const wobble = mx_noise_float(vec2(atan(offset.y, offset.x).mul(3), float(phase))).mul(2);
    ringing = ringing.add(float(k * amplitude).mul(distance.mul(k).sub(time.mul(omega)).add(wobble).cos()));
  }
  const ringSlope = radial.mul(ringing.div(distance.add(.5).sqrt()));
  const wavelets = a.wavelets.mul(a.weight).add(b.wavelets.mul(b.weight)).mul(.04);
  const slope = churn.add(ringSlope).add(wavelets);
  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  const alpha2 = float(.003).add(boil.mul(.05));
  const surface = freshwater(light, refraction, environmentMap, normal, alpha2, bubbles, foam);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.name = 'Waterfall · plunge pool';
  material.forceSinglePass = true;
  material.colorNode = surface.color;
  material.opacityNode = surface.opacity;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Waterfall · plunge pool';
  mesh.renderOrder = 2.1;
  return mesh;
}

type Course = typeof CREEK;
/**
 * The creek as a flat ribbon at its water surface; the banks rise through
 * it. Depth and speed follow Manning's equation along the bed; the travel
 * time carries foam downstream at the local speed, while standing waves
 * over the stones stay put.
 */
function streamGeometry(course: Course, half: (s: number) => number, surface: (s: number, bed: number, flow: ReturnType<typeof normalFlow>) => number, roughness: number) {
  const step = .1, stations = Math.ceil(course.length / step), columns = 12;
  const positions: number[] = [], coords: number[] = [], flows: number[] = [], indices: number[] = [];
  let travel = 0;
  for (let i = 0; i <= stations; i++) {
    const s = i * step * course.length / (stations * step);
    const p = course.at(s), ahead = course.at(Math.min(course.length, s + .4)), behind = course.at(Math.max(0, s - .4));
    const bed = groundHeight(p.x, p.z);
    const drop = groundHeight(behind.x, behind.z) - groundHeight(ahead.x, ahead.z);
    const slope = Math.max(.005, drop / Math.hypot(ahead.x - behind.x, ahead.z - behind.z));
    const flow = normalFlow(half(s), slope, roughness);
    const y = surface(s, bed, flow);
    if (i > 0) travel += step / flow.speed;
    for (let column = 0; column <= columns; column++) {
      const across = (column / columns * 2 - 1) * (half(s) + .9);
      positions.push(p.x - p.tz * across, y, p.z + p.tx * across);
      coords.push(column / columns, s);
      flows.push(flow.speed, travel, slope, flow.speed / Math.sqrt(GRAVITY * flow.depth));
      if (i < stations && column < columns) {
        const a = i * (columns + 1) + column;
        indices.push(a, a + columns + 1, a + 1, a + 1, a + columns + 1, a + columns + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  geometry.setAttribute('streamFlow', new THREE.Float32BufferAttribute(flows, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function streamMaterial(light: FallsLight, refraction: RefractionCapture, environmentMap: EnvironmentMap, fade: TSLNode) {
  const flow = attribute('streamFlow', 'vec4');
  const across = uv().x.mul(2).sub(1), s = uv().y;
  const launch = time.sub(flow.y);
  // Shallow supercritical flow over sand carries standing and roll waves; only
  // steeper, faster water breaks its surface and entrains air.
  const aeration = smoothstep(.12, .35, flow.z).mul(.6).add(smoothstep(2.5, 5, flow.w).mul(.25)).clamp(0, 1).toVar();
  const moving = mx_noise_float(vec2(across.mul(4), launch.mul(3))).mul(.5).add(.5);
  const standing = mx_noise_float(vec2(across.mul(3.2), s.mul(2.4)));
  const cover = smoothstep(float(1).sub(aeration), float(1.2).sub(aeration), moving.mul(.7).add(standing.mul(.3).add(.3))).mul(aeration);
  const slope = vec2(
    mx_noise_float(vec2(across.mul(5), launch.mul(4))).mul(.08).add(standing.mul(.12).mul(flow.w.min(3).div(3))),
    mx_noise_float(vec2(across.mul(5).add(7), s.mul(3).sub(launch))).mul(.08),
  );
  const normal = normalize(vec3(slope.x, 1, slope.y));
  const surface = freshwater(light, refraction, environmentMap, normal, float(.006).add(aeration.mul(.05)), aeration.mul(.45), cover);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.forceSinglePass = true;
  material.colorNode = surface.color;
  material.opacityNode = surface.opacity.mul(fade);
  return material;
}

/** Smooth stones on the pool's bed, lit by the pool's own caustics. */
function createBedStones(caustics: CausticsField) {
  const random = seededRandom(734);
  const material = createRockMaterial();
  const poolLight = caustics.lightNode(positionWorld.sub(vec3(0, POOL_LEVEL, 0)));
  material.emissiveNode = (material.colorNode as TSLNode).mul(poolLight);
  const stones = new THREE.InstancedMesh(createRockGeometry(87342, 'boulder', 'far'), material, 44);
  const transform = new THREE.Object3D();
  for (let i = 0; i < stones.count; i++) {
    const angle = random() * Math.PI * 2, radius = .35 + Math.sqrt(random()) * .7;
    const { x, z } = toWorld(POOL.along + Math.cos(angle) * radius * POOL.radiusAlong, Math.sin(angle) * radius * POOL.radiusAcross);
    const size = .08 + random() ** 1.5 * .26;
    transform.position.set(x, groundHeight(x, z) + size * .12, z);
    transform.rotation.set(random() * .4, random() * Math.PI, random() * .4);
    transform.scale.set(size * 1.3, size * .5, size);
    transform.updateMatrix(); stones.setMatrixAt(i, transform.matrix);
  }
  stones.name = 'Waterfall · rounded bed stones';
  stones.receiveShadow = true;
  return stones;
}

/**
 * A spring-fed creek slides across its bench and over a granite brink, and
 * falls twelve and a half meters into a boulder-rimmed pool in the horseshoe
 * gorge it has cut.
 */
export function createWaterfall(caustics: CausticsField, refraction: RefractionCapture, environmentMap: EnvironmentMap, collisions: IslandCollisions) {
  const light = createFallsLight(caustics);
  const root = new THREE.Group();
  root.name = 'Waterfall · spring, brink, gorge and pool';

  const wallGeometry = createGorgeWall();
  const wall = new THREE.Mesh(wallGeometry, createRockMaterial());
  wall.name = 'Waterfall · horseshoe gorge walls';
  wall.castShadow = wall.receiveShadow = true;
  collisions.addGeometry(wallGeometry);
  root.add(wall, createBedStones(caustics));

  // The creek thins to the brink's depth as it accelerates over the lip.
  const creek = new THREE.Mesh(streamGeometry(CREEK, creekHalfWidth, (s, bed, flow) =>
    bed + flow.depth + (BRINK.depth - flow.depth) * THREE.MathUtils.smoothstep(s, CREEK.length - 1.2, CREEK.length), .045),
  streamMaterial(light, refraction, environmentMap, smoothstep(0, .6, uv().y)));
  creek.name = 'Waterfall · spring creek';
  creek.renderOrder = 2.2;
  // Transparent water and mist draw after the sea's surface, which writes no
  // depth; from below the sea they would show straight through it.
  const water = new THREE.Group();
  water.name = 'Waterfall · water and mist';
  water.add(createPool(light, refraction, environmentMap), creek, createNappe(light, refraction, environmentMap), createPackets(light));
  water.add(createWaterfallSpray(light));
  root.add(water);
  return {
    root,
    setSubmerged(submerged: boolean) { water.visible = !submerged; },
  };
}

/** Where the falling water strikes the pool, and the power it dissipates there (W). */
export const WATERFALL_IMPACT = {
  position: new THREE.Vector3(IMPACT_POINT.x, POOL_LEVEL, IMPACT_POINT.z),
  power: 1000 * GRAVITY * DISCHARGE * FALL_HEIGHT,
};
