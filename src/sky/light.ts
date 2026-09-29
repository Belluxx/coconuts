import * as THREE from 'three/webgpu';
import { dot, exp, float, mix, smoothstep, uniform, vec3 } from 'three/tsl';
import { DEG } from '../math';
import type { TSLNode } from '../shading';
import { elevation, type SkyPosition } from './celestial';
const ramp = THREE.MathUtils.smootherstep;
const peak = (color: THREE.Color) => Math.max(color.r, color.g, color.b);

/** Shared irradiance for surfaces that do not use Three's lighting model. */
export const ambientLight = uniform(new THREE.Color(1, 1, 1));
export const directLight = uniform(1);

// Clear marine air. Values are linear radiance, before exposure or tone mapping.
const blueZenith = new THREE.Color('#398bce');
const blueHorizon = new THREE.Color('#bfdfea');
const nightZenith = new THREE.Color(.003, .006, .014);
const nightHorizon = new THREE.Color(.011, .020, .035);
const lunarTint = new THREE.Color('#b8cbe2');

/** Optical path through the air, relative to the zenith. */
function airMass(altitude: number) {
  const e = Math.max(0, altitude);
  return 1 / (Math.sin(e * DEG) + .50572 * (e + 6.07995) ** -1.6364);
}

function transmittedSun(target: THREE.Color, altitude: number, energy: number) {
  const path = airMass(altitude);
  return target.setRGB(Math.exp(-.020 * path), Math.exp(-.045 * path), Math.exp(-.085 * path)).multiplyScalar(energy);
}

function addLight(target: THREE.Color, source: THREE.Color, strength: number) {
  target.r += source.r * strength;
  target.g += source.g * strength;
  target.b += source.b * strength;
}

/**
 * One radiance model for the sky, haze, reflected environment and lights.
 * Solar altitude controls optical depth; twilight is scattered light that remains
 * after the ground loses direct sun. There are no day/night lighting modes.
 */
export function createEnvironmentLight() {
  const sunDirection = uniform(new THREE.Vector3(0, 1, 0));
  const moonDirection = uniform(new THREE.Vector3(0, -1, 0));
  const zenith = uniform(new THREE.Color()), horizon = uniform(new THREE.Color());
  const sunset = uniform(new THREE.Color()), rose = uniform(new THREE.Color());
  const solarRadiance = uniform(new THREE.Color()), lunarRadiance = uniform(new THREE.Color());
  // 1 while a source lights the island at all, else 0: below the horizon, or a
  // new moon. Shadows, caustics and cloud shading then skip it entirely.
  const sunLit = uniform(0), moonLit = uniform(0);
  const moonVisibility = uniform(0), stars = uniform(0);
  const galaxy = uniform(0);
  const haze = uniform(.0016);
  const light = { daylight: 1, chorus: 0, lamps: 0, exposure: 1 };

  /** View-dependent sky radiance, also used for aerial perspective. */
  function radiance(direction: TSLNode) {
    const height = direction.y.max(0);
    const solarDot = dot(direction, sunDirection).clamp(-1, 1);
    // Keeping the azimuth unnormalized also makes the glow vanish gracefully
    // when the sun is overhead; no singularity at the zenith or either pole.
    const towardSun = dot(direction.xz, sunDirection.xz).mul(.5).add(.5).clamp(0, 1);
    const elevationMix = float(1).sub(exp(height.mul(-4.2)));
    const base = mix(horizon, zenith, elevationMix);
    const warmBand = exp(height.mul(-9)).mul(towardSun.pow(3).mul(.85).add(.15));
    const oppositeBand = exp(height.sub(.11).div(.13).pow(2).negate())
      .mul(float(1).sub(towardSun).pow(2));
    const aureole = solarDot.max(0).pow(24).mul(.035)
      .add(solarDot.max(0).pow(240).mul(.10));
    const upper = base.add(sunset.mul(warmBand)).add(rose.mul(oppositeBand))
      .add(solarRadiance.mul(aureole));
    // The lower hemisphere is sand/sea bounce, not a second bright sky.
    const lower = horizon.mul(vec3(.28, .30, .30));
    return mix(lower, upper, smoothstep(-.18, .015, direction.y));
  }

  function update(position: SkyPosition) {
    const e = elevation(position.sun), moonAltitude = elevation(position.moon);
    sunDirection.value.copy(position.sun); moonDirection.value.copy(position.moon);
    // A bounded exponential joins twilight extinction to daylight with no
    // discontinuity in brightness or its rate of change at the horizon.
    const skyEnergy = 1 / (1 + Math.exp(-(e - 6.3) / 5));
    const daylight = ramp(e, -7, 7);
    const night = 1 - ramp(e, -15, -3);
    const visibleSun = ramp(e, -.85, .15);
    const moonlight = position.moonPhase ** 2 * ramp(moonAltitude, -.5, 6) * (1 - .95 * daylight);
    const afterglow = Math.exp(-(((e + 1) / 6.2) ** 2)) * ramp(e, -17, -8);

    zenith.value.copy(nightZenith); addLight(zenith.value, blueZenith, skyEnergy);
    horizon.value.copy(nightHorizon); addLight(horizon.value, blueHorizon, skyEnergy);
    addLight(zenith.value, lunarTint, moonlight * .018);
    addLight(horizon.value, lunarTint, moonlight * .030);
    sunset.value.setRGB(.85, .235, .065).multiplyScalar(afterglow);
    rose.value.setRGB(.20, .052, .075).multiplyScalar(afterglow);
    transmittedSun(solarRadiance.value, e, 3.1 * visibleSun);
    lunarRadiance.value.copy(lunarTint).multiplyScalar(.42 * moonlight);
    sunLit.value = Number(peak(solarRadiance.value) > .001);
    moonLit.value = Number(peak(lunarRadiance.value) > .001);
    moonVisibility.value = ramp(moonAltitude, -.8, .3);
    stars.value = (1 - ramp(e, -16, -5)) * (1 - moonlight * .35);
    galaxy.value = stars.value * (1 - moonlight * .8);
    haze.value = .00145 + afterglow * .00045;

    // Approximate cosine-weighted illumination of a horizontal white surface.
    // Foam, spray and water absorption now dim with the same light as the sand.
    ambientLight.value.copy(zenith.value).multiplyScalar(.55);
    addLight(ambientLight.value, horizon.value, .45);
    addLight(ambientLight.value, sunset.value, .12);
    addLight(ambientLight.value, solarRadiance.value, Math.max(0, position.sun.y) / Math.PI);
    addLight(ambientLight.value, lunarRadiance.value, Math.max(0, position.moon.y) / Math.PI);
    // Calibrate the authored water/spray albedos to this irradiance scale.
    ambientLight.value.multiplyScalar(.72);
    directLight.value = solarRadiance.value.r / 3.1;
    Object.assign(light, {
      daylight,
      lamps: 1 - ramp(e, -6, 5),
      exposure: .92 + night * .22,
      chorus: ramp(e, -7, -1) * (1 - ramp(e, 8, 22)) * (position.morning ? 1 : .45),
    });
  }

  return { light, sunDirection, moonDirection, zenith, horizon, solarRadiance, lunarRadiance,
    sunLit, moonLit, moonVisibility, stars, galaxy, haze, radiance, update };
}

export type EnvironmentLight = ReturnType<typeof createEnvironmentLight>;
