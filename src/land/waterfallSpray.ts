import * as THREE from 'three/webgpu';
import {
  attribute, cameraFar, cameraNear, cameraPosition, cameraWorldMatrix, cos, cross, dot, exp, float, fract, mix,
  normalize, perspectiveDepthToViewZ, positionView, positionWorld, screenUV, sin, smoothstep, time, uv, varying,
  vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl';
import { seededRandom } from '../math';
import { billboardGeometry } from '../render/billboards';
import { surfaceNoise, type TSLNode } from '../shading';
import type { FallsLight } from './waterfallLight';
import { FLOW, IMPACT, IMPACT_POINT, LIP, POOL, POOL_LEVEL, toWorld } from './waterfallLayout';

const GRAVITY = 9.81;
/** Trade wind across the island, as for the lagoon's chop. */
const WIND = new THREE.Vector2(.29, .96).multiplyScalar(.6);

/** Motion under gravity with linear air drag toward terminal speed `terminal`. */
function ballistic(start: TSLNode, velocity: TSLNode, terminal: TSLNode, age: TSLNode) {
  const relax = terminal.div(GRAVITY);
  const decay = float(1).sub(exp(age.div(relax).negate()));
  const drift = velocity.mul(relax).mul(decay);
  const fall = relax.mul(GRAVITY).mul(age.sub(relax.mul(decay)));
  const speed = velocity.mul(exp(age.div(relax).negate())).sub(vec3(0, relax.mul(GRAVITY).mul(decay), 0));
  return { position: start.add(drift).sub(vec3(0, fall, 0)), velocity: speed };
}

/** Soft intersections with the rock and the pool's bed, from the scene's depth. */
const softness = (distance: number) => smoothstep(0, distance,
  positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(screenUV), cameraNear, cameraFar)));

/**
 * Light on spray and vapour, chosen for looks: skylight from the open part
 * of the gorge, a soft even share of the sun and moon, and a bright glow when
 * they shine through the vapour toward the eye. All but the shadow is worked
 * out once per particle corner.
 */
function vapourLight(light: FallsLight, center: TSLNode) {
  const view = normalize(center.sub(cameraPosition));
  let color: TSLNode = varying(light.sky.mul(light.skyView(center).mul(.7).add(.3)));
  for (const source of light.sources) {
    const through = dot(view, source.direction).max(0);
    const glow = varying(source.radiance.mul(source.lit).mul(through.pow(8).mul(.6).add(.16)));
    // Vapour has no hard edges: its shadows are averaged over half a meter.
    color = color.add(glow.mul(light.shade(source, mix(center, positionWorld, .5), .5)));
  }
  return color;
}

/**
 * Splash drops thrown up from the impact, and vapour: a churning cloud rising
 * off the boil, a veil lying over the pool, and a shroud around the foot of
 * the falling water.
 */
export function createWaterfallSpray(light: FallsLight) {
  const root = new THREE.Group();
  root.name = 'Waterfall · splash and vapour';
  const random = seededRandom(92417);
  const outward = Math.atan2(FLOW.z, FLOW.x);

  // Splash: millimeter drops leave the impact at a few meters per second.
  const splash = billboardGeometry(500, () => {
    const azimuth = outward + (random() - .5) * 3.4, elevation = .45 + random() * .8, speed = 2.2 + random() * 4.4;
    const spread = Math.sqrt(random()) * .9, side = random() * Math.PI * 2;
    return {
      position: [IMPACT_POINT.x + Math.cos(side) * spread, POOL_LEVEL + .05, IMPACT_POINT.z + Math.sin(side) * spread],
      splashVelocity: [Math.cos(azimuth) * Math.cos(elevation) * speed, Math.sin(elevation) * speed, Math.sin(azimuth) * Math.cos(elevation) * speed],
      splashSeed: [random(), 3 + random() * 5, .004 + random() ** 2 * .012, 1.1 + random() * .7],
    };
  });
  const splashMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  splashMaterial.forceSinglePass = true;
  {
    const seed = attribute('splashSeed', 'vec4');
    const age = fract(time.div(seed.w).add(seed.x)).mul(seed.w);
    // The downdraft blows the smallest drops outward.
    const breeze = vec3(FLOW.x, 0, FLOW.z).mul(float(1.6).mul(float(1).sub(exp(age.negate()))));
    const motion = ballistic(attribute('position', 'vec3'), attribute('splashVelocity', 'vec3'), seed.y, age);
    const center = motion.position.add(breeze.mul(age));
    const view = normalize(center.sub(cameraPosition));
    const along = normalize(motion.velocity.add(vec3(0, .001, 0)));
    const across = normalize(cross(along, view));
    const corner = uv().sub(.5).mul(2);
    const length = seed.z.add(motion.velocity.length().mul(.012));
    splashMaterial.positionNode = center.add(along.mul(corner.y.mul(length))).add(across.mul(corner.x.mul(seed.z)));
    const alive = varying(smoothstep(POOL_LEVEL - .02, POOL_LEVEL + .04, center.y).mul(smoothstep(0, .05, age)));
    splashMaterial.colorNode = vapourLight(light, center).mul(1.3);
    splashMaterial.opacityNode = float(1).sub(smoothstep(.3, 1, corner.length())).mul(alive).mul(.55);
  }
  const drops = new THREE.Mesh(splash, splashMaterial);
  drops.name = 'Waterfall · splash drops';
  drops.renderOrder = 2.5;
  splash.boundingSphere = new THREE.Sphere(new THREE.Vector3(IMPACT_POINT.x, POOL_LEVEL + 1.5, IMPACT_POINT.z), 6);
  root.add(drops);

  // Vapour puffs. Each is born, swells, drifts and fades on its own cycle.
  type Puff = { at: { x: number; z: number }; y: number; azimuth: number; reach: number; rise: number; size: number; growth: number; life: number; density: number };
  const puffs: Puff[] = [];
  // Rising off the boil and rolling outward across the pool.
  for (let i = 0; i < 70; i++) {
    const side = random() * Math.PI * 2, spread = Math.sqrt(random()) * .6;
    puffs.push({
      at: { x: IMPACT_POINT.x + Math.cos(side) * spread, z: IMPACT_POINT.z + Math.sin(side) * spread },
      y: POOL_LEVEL + .2 + random() * .6, azimuth: outward + (random() - .5) * 5.2, reach: 1.5 + random() * 2.5,
      rise: .3 + random() * .4, size: .9 + random() * .6, growth: .35, life: 5 + random() * 3, density: .6,
    });
  }
  // A low veil lying over the water.
  for (let i = 0; i < 44; i++) {
    const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * .95;
    puffs.push({
      at: toWorld(POOL.along + Math.cos(angle) * radius * POOL.radiusAlong, Math.sin(angle) * radius * POOL.radiusAcross),
      y: POOL_LEVEL + .15 + random() * .35, azimuth: outward + (random() - .5) * 4, reach: .3 + random() * .5,
      rise: .03 + random() * .05, size: 2.2 + random() * 1.3, growth: .12, life: 9 + random() * 5, density: .35,
    });
  }
  // A shroud around the foot of the falling water.
  for (let i = 0; i < 16; i++) {
    puffs.push({
      at: toWorld(IMPACT * (.75 + random() * .3), (random() - .5) * 2.6),
      y: POOL_LEVEL + 1 + random() * 4, azimuth: outward + (random() - .5) * 2, reach: .8,
      rise: .1, size: .8 + random() * .5, growth: .25, life: 4 + random() * 2, density: .35,
    });
  }
  const mist = billboardGeometry(puffs.length, i => {
    const puff = puffs[i];
    return {
      position: [puff.at.x, puff.y, puff.at.z],
      mistMotion: [Math.cos(puff.azimuth), Math.sin(puff.azimuth), puff.reach, puff.rise],
      mistShape: [random(), puff.size, puff.growth, puff.life],
      mistLook: [random() * 40, (random() - .5) * .3, puff.density, 0],
    };
  });
  const mistMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mistMaterial.forceSinglePass = true;
  {
    const motion = attribute('mistMotion', 'vec4'), shape = attribute('mistShape', 'vec4'), look = attribute('mistLook', 'vec4');
    const age = fract(time.div(shape.w).add(shape.x)).mul(shape.w);
    const cycle = age.div(shape.w);
    // Pushed out by the falling water's downdraft, lifted by its own warmth, carried by the wind.
    const reach = motion.z.mul(float(1).sub(exp(age.div(-2))));
    const sway = vec3(sin(age.mul(.7).add(look.x)), 0, cos(age.mul(.6).add(look.x.mul(1.3)))).mul(.35);
    const center = attribute('position', 'vec3')
      .add(vec3(motion.x.mul(reach), age.mul(motion.w), motion.y.mul(reach)))
      .add(vec3(WIND.x, 0, WIND.y).mul(age.mul(.5))).add(sway);
    const size = shape.y.add(shape.z.mul(age));
    const corner = uv().sub(.5).mul(2);
    mistMaterial.positionNode = center.add(cameraWorldMatrix.mul(vec4(corner.mul(size), 0, 0)).xyz);
    // Billows from the baked noise, slowly turning and rolling inside each puff.
    const turn = look.x.add(look.y.mul(age));
    const spun = vec2(corner.x.mul(cos(turn)).sub(corner.y.mul(sin(turn))), corner.x.mul(sin(turn)).add(corner.y.mul(cos(turn))));
    const billow = surfaceNoise(spun.mul(1.1).add(vec2(look.x, age.mul(.1)))).mul(.6)
      .add(surfaceNoise(spun.mul(2.7).add(vec2(age.mul(-.15), look.x.mul(1.7)))).mul(.4));
    const profile = float(1).sub(smoothstep(.15, 1, corner.length().add(billow.mul(.3))));
    const fade = varying(smoothstep(0, .2, cycle).mul(float(1).sub(smoothstep(.45, 1, cycle))).mul(look.z)
      // Thin out close to the eye rather than fill the screen.
      .mul(smoothstep(.6, 2.5, center.sub(cameraPosition).length())));
    mistMaterial.colorNode = vapourLight(light, center);
    mistMaterial.opacityNode = profile.mul(mix(float(.55), float(1), smoothstep(-.3, .6, billow))).mul(fade)
      .mul(softness(1.2)).mul(smoothstep(POOL_LEVEL - .1, POOL_LEVEL + .4, positionWorld.y))
      .mul(smoothstep(LIP.y + 3, LIP.y - 3, positionWorld.y));
  }
  const cloud = new THREE.Mesh(mist, mistMaterial);
  cloud.name = 'Waterfall · vapour';
  cloud.renderOrder = 2.6;
  mist.boundingSphere = new THREE.Sphere(new THREE.Vector3(IMPACT_POINT.x, POOL_LEVEL + 3, IMPACT_POINT.z), 12);
  root.add(cloud);
  return root;
}
