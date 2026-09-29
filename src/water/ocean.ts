import * as THREE from 'three/webgpu';
import {
  Fn, If, cameraPosition, cameraProjectionMatrix, cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, dFdx, dFdy,
  dot, float, getViewPosition, max, min, mix, normalize, positionLocal, positionView, positionWorld, refract,
  screenUV, smoothstep, vec2, vec3, vec4, viewportDepthTexture, viewportSafeUV,
} from 'three/tsl';
import { shoreZ } from '../land/terrain';
import type { QualitySettings } from '../quality';
import type { TSLNode } from '../shading';
import type { EnvironmentMap } from '../sky/environmentMap';
import { ambientLight, type EnvironmentLight } from '../sky/light';
import { chopLimit, chopSurface, windGust } from './chop';
import { foamLace } from './foam';
import { WATER_IOR, fresnel, waterTransmission } from './optics';
import { createOceanReflection } from './reflection';
import type { RefractionCapture } from './refraction';
import { longWaves, sampleSeaSurface, seaSurfaceHeight } from './surface';
import { surfFoam, updateSurf } from './surf';
import { undersideView } from './underside';
import type { UnderwaterLight } from './underwaterLight';

/** Diffuse light reflected back down by the surface from below: 1 − (1 − 0.066)/n². */
const INTERNAL_REFLECTANCE = 1 - (1 - .066) / WATER_IOR ** 2;
/** Entrained bubbles: about a millimeter across, scattering all but a sliver forward. */
const BUBBLE_RADIUS = .001, BUBBLE_ASYMMETRY = .85;

/** A fine coast-following grid resolves the moving water/sand intersection. */
function oceanGeometry({ oceanStep: xStep, shoreStep }: QualitySettings) {
  const xs = [-1800, -1000, -500, -280, -220, -185];
  for (let x = -165; x <= 165; x += xStep) xs.push(x);
  xs.push(185, 220, 280, 500, 1000, 1800);
  const ds = [-2200, -1800, -1400, -1100, -900, -750];
  // Swimmers can reach the shelf. Resolve swell geometry there too, instead
  // of stretching a handful of flat triangles across the whole open sea.
  for (let d = -650; d <= -120; d += 3) ds.push(d);
  for (let d = -110; d < -18; d += 1.5) ds.push(d);
  for (let d = -18; d <= 6; d += shoreStep) ds.push(d);
  ds.push(10, 18, 32, 60, 130, 350, 800, 2200);
  const positions: number[] = [], indices: number[] = [];
  for (let row = 0; row < ds.length; row++) for (let col = 0; col < xs.length; col++) {
    const x = xs[col], coast = shoreZ(THREE.MathUtils.clamp(x, -165, 165));
    positions.push(x, -(coast + ds[row]), 0);
    if (row < ds.length - 1 && col < xs.length - 1) {
      const i = row * xs.length + col;
      indices.push(i, i + xs.length, i + 1, i + 1, i + xs.length, i + xs.length + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The lagoon seen from the air. Every term is a physical path of light:
 * - sky and island reflected by the Fresnel reflectance of the local wave facet;
 * - sun and moon glitter from wave slopes too small to resolve (GGX microfacets);
 * - the real seabed, refracted through the column, attenuated by Beer–Lambert,
 *   multiply reflected between the sand and the underside of the surface, and
 *   dimmed by 1/n² as its radiance spreads into the air;
 * - light the water scatters toward the eye along the refracted ray: the same
 *   in-scattering a diver sees, from the sun, the sky and the bright seabed;
 * - bubble clouds in the surf, a two-stream scattering layer;
 * - foam rafts, opaque diffuse cover in the fraction the surf simulation sets.
 * From below, the same surface shows Snell's window and total internal reflection.
 */
export function createOcean(
  scene: THREE.Scene, refractionCapture: RefractionCapture, quality: QualitySettings,
  environment: EnvironmentLight, environmentMap: EnvironmentMap, light: UnderwaterLight,
) {
  updateSurf(0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  });
  material.name = 'Lagoon · refracted swell, surf, foam and water-body optics';

  const geometries = new Map<QualitySettings, THREE.BufferGeometry>();
  const geometryFor = (settings: QualitySettings) => {
    if (!geometries.has(settings)) geometries.set(settings, oceanGeometry(settings));
    return geometries.get(settings)!;
  };
  const ocean = new THREE.Mesh(geometryFor(quality), material);
  ocean.name = 'Clear tropical lagoon';
  ocean.rotation.x = -Math.PI / 2;
  // The opaque seabed has already been drawn before this transparent mesh.
  ocean.renderOrder = 1;
  scene.add(ocean);

  // Geometry carries the waves its triangles resolve; normals carry the rest.
  const localXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const viewerDistance = localXZ.sub(cameraPosition.xz).length();
  material.positionNode = positionLocal.add(vec3(0, 0, seaSurfaceHeight(localXZ,
    float(1).sub(smoothstep(80, 240, viewerDistance)), float(1).sub(smoothstep(500, 1100, viewerDistance)))));

  const worldXZ = positionWorld.xz;
  const footprint = max(dFdx(worldXZ).length(), dFdy(worldXZ).length()).toVar();
  const long = longWaves(worldXZ).toVar();
  const depth = long.y;
  const limit = chopLimit(depth).toVar();
  const chop = chopSurface(worldXZ, footprint, windGust(worldXZ)).toVar();
  const offset = max(footprint, .1);
  const longSlope = vec2(
    longWaves(worldXZ.add(vec2(offset, 0))).x.sub(longWaves(worldXZ.sub(vec2(offset, 0))).x),
    longWaves(worldXZ.add(vec2(0, offset))).x.sub(longWaves(worldXZ.sub(vec2(0, offset))).x),
  ).div(offset.mul(2));
  const slope = longSlope.add(chop.xy.mul(limit));
  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
  // GGX α² is the mean square slope this pixel leaves unresolved. Thin swash
  // carries no chop and turns glassy.
  const alpha2 = chop.z.mul(limit.mul(limit)).add(.0004).toVar();
  const eye = normalize(cameraPosition.sub(positionWorld)).toVar();
  const facing = max(dot(normal, eye), .001);
  const reflectance = fresnel(facing).toVar();

  // Seabed light bends at the surface. A flat surface only makes the bed look
  // shallower, and the bed is already drawn where the eye sees it; the waves
  // bend it further, so shift the screen by the difference between the rays
  // through the rippled and the flat surface. The column depth follows the
  // smooth bathymetry, so a fish and the sand behind it shift together.
  const below = refract(eye.negate(), normal, float(1 / WATER_IOR)).toVar();
  const calm = refract(eye.negate(), vec3(0, 1, 0), float(1 / WATER_IOR));
  const columnDepth = depth.min(12);
  const project = (point: TSLNode) => {
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(point, 1)));
    return clip.xy.div(clip.w.max(.001)).mul(vec2(.5, -.5));
  };
  const through = (ray: TSLNode) => positionWorld.add(ray.mul(columnDepth.div(ray.y.negate().max(.2))));
  // Near the screen's edge the shift can point off screen. Ease it away
  // there; clamping would stretch the edge row into streaks.
  const shift = project(through(below)).sub(project(through(calm))).toVar();
  const target = screenUV.add(shift);
  const onScreen = smoothstep(0, .04, min(min(target.x, float(1).sub(target.x)), min(target.y, float(1).sub(target.y))));
  const shiftedUV = viewportSafeUV(screenUV.add(shift.mul(onScreen)).clamp(.001, .999));
  const floorAt = (uv: TSLNode) => getViewPosition(uv, viewportDepthTexture(uv), cameraProjectionMatrixInverse);
  const shiftedFloor = floorAt(shiftedUV), straightFloor = floorAt(screenUV);
  // Anything nearer than this surface stands above the water and cannot be
  // seen through it; keep the unshifted image there.
  const behindSurface = shiftedFloor.z.lessThan(positionView.z);
  const refractedUV = behindSurface.select(shiftedUV, screenUV).toVar();
  const seen = behindSurface.select(shiftedFloor, straightFloor);
  // Its light reaches the surface along the bent ray, not the straight line
  // to where it is drawn: at a low eye that line grazes through far more water.
  const drop = positionWorld.y.sub(cameraWorldMatrix.mul(vec4(seen, 1)).y).max(0);
  const path = drop.div(below.y.negate().max(.2)).min(seen.sub(positionView).length()).min(250).toVar();
  const verticalDepth = straightFloor.sub(positionView).length().mul(eye.y.max(.035));

  // Bubble clouds in the surf: optically thick where the void fraction is
  // high, scattering almost only forward (two-stream, no absorption).
  const foamState = surfFoam(worldXZ).toVar();
  const voidFraction = foamState.y.div(depth.max(.01)).clamp(0, .6).toVar();
  const bubbleDepth = foamState.y.mul(1.5 / BUBBLE_RADIUS).mul(1 - BUBBLE_ASYMMETRY);
  const bubbleReflectance = bubbleDepth.div(bubbleDepth.add(2)).toVar();
  // Daylight on the water, as the radiance of a white horizontal surface.
  const white = ambientLight.div(.72);
  const image = waterTransmission(path);
  const behindWater = refractionCapture.sample(refractedUV).rgb;
  // Light leaving the sand partly reflects back down from the surface above
  // it, and returns again; the same trapping that darkens wet sand.
  const floorAlbedo = behindWater.div(white.max(.0001)).clamp(0, 1);
  const trapping = vec3(1).div(vec3(1).sub(floorAlbedo.mul(image).mul(image).mul(INTERNAL_REFLECTANCE)));
  const column = light.bodyRadiance(worldXZ, below).mul(vec3(1).sub(image));
  const bubbleTransmission = float(1).sub(bubbleReflectance);
  const upwelling = behindWater.mul(image).mul(trapping).add(column).mul(bubbleTransmission.mul(bubbleTransmission))
    .add(white.mul(bubbleReflectance));
  // Radiance crossing into the air spreads over a wider solid angle: the n² law.
  const transmitted = upwelling.mul(float(1).sub(reflectance)).div(WATER_IOR ** 2);

  const roughness = alpha2.sqrt().sqrt();
  const reflection = createOceanReflection(ocean, normal, eye, roughness, environmentMap, quality,
    ray => light.bodyRadiance(worldXZ, ray));
  const { submerged } = reflection;

  const glint = (direction: EnvironmentLight['sunDirection'], radiance: EnvironmentLight['solarRadiance']) => {
    const halfway = normalize(direction.add(eye));
    const nh = max(dot(normal, halfway), 0), nl = max(dot(normal, direction), 0);
    const distribution = alpha2.div(nh.mul(nh).mul(alpha2.sub(1)).add(1).pow(2).mul(Math.PI));
    const visibility = float(.5).div(
      nl.mul(facing.mul(facing).mul(float(1).sub(alpha2)).add(alpha2).sqrt())
        .add(facing.mul(nl.mul(nl).mul(float(1).sub(alpha2)).add(alpha2).sqrt())).max(.0001),
    );
    return radiance.mul(distribution.mul(visibility).mul(fresnel(max(dot(direction, halfway), .001))).mul(nl).min(80));
  };
  const glints = glint(environment.sunDirection, environment.solarRadiance)
    .add(glint(environment.moonDirection, environment.lunarRadiance));

  // Where the bore's void fraction is high the water is itself foam; behind
  // it, rafts of risen bubbles drift as lace. Neither outlines the posts.
  const roller = smoothstep(.15, .4, voidFraction).toVar();
  const cover = max(roller, foamLace(worldXZ, foamState).mul(.92)).mul(smoothstep(.003, .03, verticalDepth)).toVar();
  const foamRadiance = white.mul(mix(float(.55), float(.75), roller));
  const above = reflection.surface.mul(reflectance).add(transmitted).add(glints);
  const underside = undersideView(normal, eye, alpha2, reflection.underwater, uv => viewportDepthTexture(uv).x, refractionCapture, environment, environmentMap);
  // The view from above is always evaluated first, outside any branch: it
  // builds the wave normals and depth expressions both sides share. A node
  // first built inside a branch would be left unset outside it. The view
  // from below adds its own work only while the eye is underwater.
  material.colorNode = Fn(() => {
    const view = mix(above, foamRadiance, cover).toVar();
    If(submerged.greaterThan(0), () => {
      // Foam rafts pass diffuse daylight down: bright patches against the mirror.
      view.assign(mix(view, mix(underside, white.mul(.6), cover), submerged));
    });
    return view;
  })();
  // The last millimeters belong to the sand's own water film, which takes
  // over at exactly the simulated depth where this fades, so the two share one
  // waterline. The transects sample the beach along lines and the real sand
  // between them can lie lower, so the simulated depth, not the gap to the
  // sand, decides where water is. Rocks and posts still fade the edge.
  material.opacityNode = mix(smoothstep(.002, .008, verticalDepth.min(depth)), float(1), submerged);

  return {
    /** Water height at a point, matching the rendered surface. */
    surfaceHeight: sampleSeaSurface,
    /** Advance the surf simulation; returns it for the surf sounds. */
    update: updateSurf,
    updateViewer(camera: THREE.Camera) {
      const height = sampleSeaSurface(camera.position.x, camera.position.z);
      reflection.updateViewer(height - camera.position.y, height);
    },
    setQuality(settings: QualitySettings) {
      ocean.geometry = geometryFor(settings);
      reflection.setQuality(settings);
    },
  };
}

export type Ocean = ReturnType<typeof createOcean>;
