import * as THREE from 'three/webgpu';
import { If, cameraViewMatrix, dFdx, dFdy, dot, float, max, mix, normalize, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { filterDirectLight } from '../render/localLighting';
import type { TSLNode } from '../shading';
import { ambientLight, type EnvironmentLight } from '../sky/light';
import { seabedDepth } from './bathymetry';
import type { CausticsField } from './caustics';
import { beamTransmission, diffuseAttenuation, diffuseTransmission, waterExtinction, waterPhase, waterScattering } from './optics';

/** Sand, coral and rubble reflect this share of the light reaching the lagoon floor. */
const SEABED_ALBEDO = .35;
/** Fresnel transmission of diffuse skylight into the water. */
const SKY_TRANSMISSION = .93;
/** Upwelling light is more diffuse than downwelling: its mean cosine is about half. */
const UPWELLING_PATH = 2;

/** 1 below the mean waterline, fading to 0 over its last five centimeters. */
const submergedAt = (y: TSLNode) => float(1).sub(smoothstep(-.05, 0, y));

/**
 * Light below the surface, from the water's optical properties alone.
 *
 * The sun and moon refract into the water, lose energy along their bent
 * paths and are focused by the waves; every submerged surface receives them
 * that way through its ordinary lighting. Skylight dims with depth. The same
 * three fields — direct beam, diffuse downwelling, and light reflected up by
 * the seabed — scatter toward the eye along every underwater view ray.
 */
export function createUnderwaterLight(scene: THREE.Scene, caustics: CausticsField, environment: EnvironmentLight) {
  const skyIrradiance = uniform(new THREE.Color());
  const { sources } = caustics;

  filterDirectLight((light, { lightDirection, lightColor }) => {
    const source = sources.find(candidate => candidate.light === light);
    if (!source) return { lightDirection, lightColor };
    const point = positionWorld;
    const footprint = max(dFdx(point.xz).length(), dFdy(point.xz).length()).toVar();
    const below = submergedAt(point.y).toVar();
    const factor = vec3(1).toVar();
    If(below.greaterThan(0).and(source.lit.greaterThan(0)), () => {
      const path = point.y.negate().max(0).div(source.waterDirection.y.max(.05));
      const underwater = beamTransmission(path).mul(source.transmittance).mul(source.focusNode(point, footprint));
      factor.assign(mix(vec3(1), underwater, below));
    });
    const refracted = normalize(cameraViewMatrix.transformDirection(source.waterDirection));
    return { lightDirection: normalize(mix(lightDirection, refracted, below)), lightColor: vec3(lightColor).mul(factor) };
  });
  // Skylight on submerged surfaces: every material's environment lighting.
  const depthOf = (point: TSLNode) => point.y.negate().max(0);
  const environmentNode = scene.environmentNode as TSLNode;
  scene.environmentNode = environmentNode.mul(mix(vec3(1),
    diffuseTransmission(depthOf(positionWorld)).mul(SKY_TRANSMISSION), submergedAt(positionWorld.y)));

  /** Downwelling irradiance at a point: skylight plus sunlight that scattering has made diffuse. */
  const downwelling = (point: TSLNode) => {
    const depth = depthOf(point);
    const diffuse = diffuseTransmission(depth);
    let light: TSLNode = skyIrradiance.mul(SKY_TRANSMISSION).mul(diffuse);
    for (const source of sources) {
      const horizontal = source.surfaceIrradiance.mul(source.waterDirection.y);
      const direct = beamTransmission(depth.div(source.waterDirection.y.max(.05)));
      light = light.add(horizontal.mul(diffuse.sub(direct).max(0)));
    }
    return light;
  };
  /** Light the seabed reflects back up, reaching a point above it. */
  const upwelling = (point: TSLNode) => {
    const floor = seabedDepth(point.xz).max(depthOf(point));
    const atFloor = downwelling(vec3(point.x, floor.negate(), point.z));
    let direct: TSLNode = vec3(0);
    for (const source of sources) {
      direct = direct.add(source.surfaceIrradiance.mul(source.waterDirection.y)
        .mul(beamTransmission(floor.div(source.waterDirection.y.max(.05)))));
    }
    return atFloor.add(direct).mul(SEABED_ALBEDO)
      .mul(diffuseTransmission(floor.sub(depthOf(point)).mul(UPWELLING_PATH)));
  };

  /**
   * In-scattering along one view ray (unit `ray`, away from the eye).
   * Phase terms depend only on directions, so they are built once per ray;
   * the returned function gives the radiance scattered toward the eye per
   * meter at a point. `footprint` sets how finely caustic shafts resolve.
   */
  function scatteringAlong(ray: TSLNode) {
    const sourcePhases = sources.map(source => waterPhase(dot(ray, source.waterDirection).clamp(-1, 1)).toVar());
    // Downwelling photons travel down: they reach an upward ray by forward scattering.
    const downPhase = waterPhase(ray.y, .6).toVar();
    const upPhase = waterPhase(ray.y.negate(), .75).toVar();
    return (point: TSLNode, footprint: TSLNode, shadowed = true) => {
      let light: TSLNode = downwelling(point).mul(downPhase).add(upwelling(point).mul(upPhase));
      sources.forEach((source, index) => {
        let beam: TSLNode = source.irradianceNode(point).mul(source.focusNode(point, footprint)).mul(sourcePhases[index]);
        if (shadowed) beam = beam.mul(source.shadowNode(point));
        light = light.add(beam.mul(source.lit));
      });
      return light.mul(waterScattering);
    };
  }

  /**
   * Radiance of open water seen along `ray` from a point near the surface:
   * the in-scattering of an unbounded path, deepening as the ray descends.
   * Multiply by (1 − transmission) for a path that meets something.
   */
  function bodyRadiance(xz: TSLNode, ray: TSLNode) {
    const point = vec3(xz.x, -.2, xz.y);
    return scatteringAlong(ray)(point, float(4), false)
      .div(waterExtinction.add(diffuseAttenuation.mul(ray.y.negate().max(0))));
  }

  return {
    downwelling, upwelling, scatteringAlong, bodyRadiance,
    /** Carry the sky's current irradiance into the water. */
    update() {
      const sky = skyIrradiance.value.copy(ambientLight.value).multiplyScalar(1 / .72);
      const sun = environment.sunDirection.value, moon = environment.moonDirection.value;
      const solar = environment.solarRadiance.value, lunar = environment.lunarRadiance.value;
      sky.r -= (solar.r * Math.max(sun.y, 0) + lunar.r * Math.max(moon.y, 0)) / Math.PI;
      sky.g -= (solar.g * Math.max(sun.y, 0) + lunar.g * Math.max(moon.y, 0)) / Math.PI;
      sky.b -= (solar.b * Math.max(sun.y, 0) + lunar.b * Math.max(moon.y, 0)) / Math.PI;
      sky.setRGB(Math.max(sky.r, 0), Math.max(sky.g, 0), Math.max(sky.b, 0)).multiplyScalar(Math.PI);
    },
  };
}

export type UnderwaterLight = ReturnType<typeof createUnderwaterLight>;
