import { dot, float, max, normalize, vec3 } from 'three/tsl';
import type { TSLNode } from '../shading';
import { ambientLight } from '../sky/light';
import type { CausticsField } from '../water/caustics';
import { fresnel } from '../water/optics';
import { gorgeSkyView } from './waterfallLayout';

/**
 * Light for the waterfall's water and spray, which shade themselves:
 * the same sun, moon, shadow maps and sky as every lit surface, with the
 * gorge's walls hiding part of the sky near its floor.
 */
export function createFallsLight(caustics: CausticsField) {
  const { sources } = caustics;
  let beams: TSLNode = vec3(0);
  for (const source of sources) beams = beams.add(source.radiance.mul(source.direction.y.max(0)));
  type Source = (typeof sources)[number];
  /**
   * Share of a beam reaching a point, averaged over a small disc around it
   * so shadow edges fall soft across the water and spray.
   */
  const shade = (source: Source, point: TSLNode, radius: number) => {
    let lit: TSLNode = source.shadowNode(point);
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      lit = lit.add(source.shadowNode(point.add(vec3(Math.cos(angle) * radius, (i % 2 - .5) * radius * .6, Math.sin(angle) * radius))));
    }
    return lit.div(7);
  };
  /** Skylight alone: a white horizontal surface's radiance, less the sun and moon. */
  const sky = ambientLight.div(.72).sub(beams.div(Math.PI)).max(0);

  return {
    sources,
    shade,
    sky,
    skyView: gorgeSkyView,
    /**
     * A diffusely scattering surface such as foam or aerated water. Light
     * from behind comes through in proportion to `translucency`.
     */
    diffuse(point: TSLNode, normal: TSLNode, translucency: TSLNode = float(0)) {
      let light: TSLNode = sky.mul(gorgeSkyView(point));
      for (const source of sources) {
        const facing = dot(normal, source.direction);
        light = light.add(source.radiance.mul(shade(source, point, .12))
          .mul(facing.max(0).add(facing.negate().max(0).mul(translucency))).mul(source.lit).div(Math.PI));
      }
      return light;
    },
    /** Sun and moon glitter on a water surface (GGX microfacets, exact Fresnel). */
    glints(normal: TSLNode, eye: TSLNode, alpha2: TSLNode, point: TSLNode) {
      let light: TSLNode = vec3(0);
      const facing = max(dot(normal, eye), .001);
      for (const source of sources) {
        const halfway = normalize(source.direction.add(eye));
        const nh = max(dot(normal, halfway), 0), nl = max(dot(normal, source.direction), 0);
        const distribution = alpha2.div(nh.mul(nh).mul(alpha2.sub(1)).add(1).pow(2).mul(Math.PI));
        const visibility = float(.5).div(nl.mul(facing.mul(facing).mul(float(1).sub(alpha2)).add(alpha2).sqrt())
          .add(facing.mul(nl.mul(nl).mul(float(1).sub(alpha2)).add(alpha2).sqrt())).max(.0001));
        light = light.add(source.radiance.mul(shade(source, point, .12)).mul(source.lit)
          .mul(distribution.mul(visibility).mul(fresnel(max(dot(source.direction, halfway), .001))).mul(nl).min(60)));
      }
      return light;
    },
  };
}

export type FallsLight = ReturnType<typeof createFallsLight>;
