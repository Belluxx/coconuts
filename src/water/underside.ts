import {
  cameraProjectionMatrix, cameraViewMatrix, dot, float, getScreenPosition, min, mix, refract,
  smoothstep, vec3, vec4, viewportSafeUV,
} from 'three/tsl';
import type { TSLNode } from '../shading';
import type { EnvironmentMap } from '../sky/environmentMap';
import type { EnvironmentLight } from '../sky/light';
import { WATER_IOR, fresnel } from './optics';
import type { RefractionCapture } from './refraction';

/**
 * The surface seen from below. Within Snell's window, 97° wide, the whole sky
 * and island are compressed and brightened by n²; beyond the critical angle
 * the surface is a perfect mirror of the water and the reef (total internal
 * reflection). Waves bend and break the window's edge.
 *
 * `alpha2` is the GGX roughness of unresolved slopes; `reflected` the
 * radiance arriving along the mirrored ray from the water below.
 */
export function undersideView(
  normal: TSLNode, eye: TSLNode, alpha2: TSLNode, reflected: TSLNode, opaqueDepth: (uv: TSLNode) => TSLNode,
  refractionCapture: RefractionCapture, environment: EnvironmentLight, environmentMap: EnvironmentMap,
) {
  const up = eye.negate();
  const cosine = dot(up, normal).clamp(.0001, 1);
  const sine2 = float(1).sub(cosine.mul(cosine)).mul(WATER_IOR ** 2);
  // Fresnel depends only on the angle in air; there is none past the critical angle.
  const reflectance = sine2.greaterThanEqual(1).select(float(1), fresnel(float(1).sub(sine2).max(0).sqrt()));
  const airRay = refract(up, normal.negate(), float(WATER_IOR)).add(vec3(0, .00001, 0)).normalize();
  const sky = environmentMap.sample(airRay, alpha2.sqrt().sqrt().clamp(.02, .6)).rgb;
  // Land, piers and boats above the water, where the bent ray finds them on screen.
  const airView = cameraViewMatrix.mul(vec4(airRay, 0));
  const airUV = getScreenPosition(airView.xyz, cameraProjectionMatrix);
  const airEdge = min(min(airUV.x, float(1).sub(airUV.x)), min(airUV.y, float(1).sub(airUV.y)));
  const airCoverage = smoothstep(0, .12, airEdge).mul(smoothstep(0, 1, airView.z.negate()));
  // The captured sky contains the sun and moon discs; they come from their lobes below.
  const discMask = (direction: EnvironmentLight['sunDirection']) =>
    smoothstep(Math.cos(.028), Math.cos(.014), dot(airRay, direction));
  const discs = discMask(environment.sunDirection).max(discMask(environment.moonDirection));
  const airSampleUV = viewportSafeUV(airUV.clamp(.001, .999));
  // Clouds come from one continuous world-space sky; keep the screen capture
  // for nearby land and piers, where it has geometry.
  const airGeometry = float(1).sub(smoothstep(.9995, .99995, opaqueDepth(airSampleUV)));
  const above = mix(sky, refractionCapture.sample(airSampleUV).rgb, airCoverage.mul(airGeometry).mul(float(1).sub(discs)));
  // Sun and moon through the rippled window: their irradiance spread over the
  // microfacet lobe, so the disc shimmers and widens but conserves energy.
  // A facet tilted by δ turns the ray in air by only (n − 1)·δ.
  const lobe = (direction: EnvironmentLight['sunDirection'], radiance: EnvironmentLight['solarRadiance']) => {
    const c = dot(airRay, direction).max(0);
    const width = alpha2.mul((WATER_IOR - 1) ** 2).add(.00002);
    return radiance.mul(width.div(c.mul(c).mul(width.sub(1)).add(1).pow(2).mul(Math.PI)).min(4e4))
      .mul(smoothstep(0, .06, direction.y));
  };
  const sources = lobe(environment.sunDirection, environment.solarRadiance)
    .add(lobe(environment.moonDirection, environment.lunarRadiance));
  // Radiance entering a denser medium is concentrated by n².
  const window = above.add(sources).mul(float(1).sub(reflectance)).mul(WATER_IOR ** 2);
  return window.add(reflected.mul(reflectance));
}
