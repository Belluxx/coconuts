import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, attribute, cross, dFdx, dFdy, dot, float, floor, fract, max, mix, normalWorld,
  positionLocal, positionWorld, reference, refract, smoothstep, texture,
  uniform, varyingProperty, vec2, vec3, vec4, type ShaderNodeObject,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TSLNode } from '../shading';
import type { EnvironmentLight } from '../sky/light';
import { CHOP_TILE as TILE, FOCUSING_CHOP, chopHeight, chopNormal } from './chop';
import { WATER_IOR, beamTransmission, fresnel, surfaceTransmission, underwaterLightDirection, unscatteredFraction } from './optics';
import { seaTime } from './seaState';

const RESOLUTION = 384;
/** Focal planes of the photon atlas, in meters below the surface. */
const DEPTHS = [.5, 1.2, 2.5, 4.5, 7.5, 12, 18];
const TEXEL = TILE / RESOLUTION;
/** The sun's angular diameter (radians) blurs every caustic in proportion to depth. */
const SUN_DIAMETER = .0093;

/** Photon grids for every focal depth, side by side in one atlas, with guard cells beyond each tile. */
function photonGrid() {
  const parts = DEPTHS.map((depth, band) => {
    const part = new THREE.PlaneGeometry(TILE + 10, TILE + 10, 192, 192);
    const count = part.getAttribute('position').count;
    part.setAttribute('focusDepth', new THREE.Float32BufferAttribute(new Float32Array(count).fill(depth), 1));
    part.setAttribute('focusBand', new THREE.Float32BufferAttribute(new Float32Array(count).fill(band), 1));
    return part;
  });
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

/** Another lookup of a texture node's texture, sharing its binding and its current value. */
function lookup(node: ShaderNodeObject<THREE.TextureNode>, uv: TSLNode) {
  const sample = node.clone();
  sample.referenceNode = node;
  sample.uvNode = uv;
  return sample;
}

/**
 * Sunlight and moonlight below the surface. Photons refract through the
 * actual wave facets; the ratio of each facet's area to the area it lights
 * at a given depth is the irradiance relative to a flat sea, mean one. The
 * same field lights the seabed, the fish, and the shafts in the water.
 */
export function createCaustics(renderer: THREE.WebGPURenderer, environment: EnvironmentLight, sun: THREE.DirectionalLight, moon: THREE.DirectionalLight) {
  const sourcePosition = varyingProperty('vec3', 'causticSourcePosition');
  const receivingPosition = varyingProperty('vec3', 'causticReceivingPosition');
  const incidence = varyingProperty('float', 'causticIncidence');
  const incomingDirection = uniform(new THREE.Vector3(0, 1, 0));
  const flatTransmission = uniform(1);
  const incoming = incomingDirection.negate();
  const flatRay = refract(incoming, vec3(0, 1, 0), float(1 / WATER_IOR));
  const material = new THREE.NodeMaterial();
  material.name = 'Water · photon density at seven depths';
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthTest = false; material.depthWrite = false;
  material.side = THREE.DoubleSide; material.forceSinglePass = true; material.toneMapped = false;
  material.vertexNode = Fn(() => {
    const depth = attribute('focusDepth', 'float');
    const offset = flatRay.xz.mul(depth).div(max(flatRay.y.negate(), .05));
    const xz = positionLocal.xy.sub(offset);
    const height = chopHeight(xz, float(seaTime), FOCUSING_CHOP).toVar();
    const normal = chopNormal(xz, float(seaTime), FOCUSING_CHOP).toVar();
    const origin = vec3(xz.x, height, xz.y).toVar();
    const direction = refract(incoming, normal, float(1 / WATER_IOR)).toVar();
    const distance = height.add(depth).div(max(direction.y.negate(), .05));
    const floor = origin.add(direction.mul(distance)).toVar();
    sourcePosition.assign(origin); receivingPosition.assign(floor);
    incidence.assign(max(dot(normal, incomingDirection), 0));
    const u = floor.x.div(TILE).add(.5).add(attribute('focusBand', 'float')).div(DEPTHS.length);
    return vec4(u.mul(2).sub(1), floor.z.mul(-2).div(TILE), .5, 1);
  })();
  material.fragmentNode = Fn(() => {
    // Guard geometry provides photons across each tile's edge, but cannot spill
    // into the neighboring depth band of the atlas.
    If(receivingPosition.x.abs().greaterThan(TILE / 2).or(receivingPosition.z.abs().greaterThan(TILE / 2)), () => { Discard(); });
    // Power through the facet, over the area it lands on, relative to a flat sea.
    const sourceArea = cross(dFdx(sourcePosition), dFdy(sourcePosition)).length();
    const receivingArea = cross(dFdx(receivingPosition), dFdy(receivingPosition)).length();
    const intercepted = incidence.mul(float(1).sub(fresnel(float(incidence)))).div(incomingDirection.y.max(.02).mul(flatTransmission));
    const density = sourceArea.div(receivingArea.max(.0000001)).mul(intercepted).clamp(0, 24);
    return vec4(vec3(density), 1);
  })();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const photons = new THREE.Mesh(photonGrid(), material);
  photons.frustumCulled = false;
  const photonScene = new THREE.Scene().add(photons);
  const fallbackShadow = new THREE.DepthTexture(1, 1);
  fallbackShadow.compareFunction = THREE.LessCompare;
  const sources = [
    { light: sun, direction: environment.sunDirection, radiance: environment.solarRadiance, lit: environment.sunLit },
    { light: moon, direction: environment.moonDirection, radiance: environment.lunarRadiance, lit: environment.moonLit },
  ].map(({ light, direction, radiance, lit }) => {
    const target = new THREE.RenderTarget(RESOLUTION * DEPTHS.length, RESOLUTION, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    target.texture.name = `${light.name} · refracted photon atlas`;
    const atlas = texture(target.texture);
    // Both depend only on the source; update() computes them once per frame.
    const waterDirection = uniform(new THREE.Vector3(0, 1, 0));
    const transmittance = uniform(1);
    const surfaceIrradiance = uniform(new THREE.Color());
    const shadowMap = texture(fallbackShadow), shadowMatrix = uniform(light.shadow.matrix);
    const shadowSize = uniform(light.shadow.mapSize);
    const shadowBias = reference('bias', 'float', light.shadow);
    const shadowNormalBias = reference('normalBias', 'float', light.shadow);
    const shadowReady = uniform(0);
    /**
     * Relative irradiance at a point: the photon atlas between its focal
     * planes. `footprint` is the pixel's (or ray step's) world-space size,
     * measured outside any branch. The sun's disc blurs deeper caustics.
     */
    const densityNode = (point: TSLNode, footprint: TSLNode) => {
      const depth = point.y.negate().max(0);
      let plane: TSLNode = float(0);
      for (let i = 0; i < DEPTHS.length - 1; i++) plane = plane.add(depth.sub(DEPTHS[i]).div(DEPTHS[i + 1] - DEPTHS[i]).clamp(0, 1));
      const band = plane.floor().min(DEPTHS.length - 2), blend = plane.sub(band);
      const blur = max(footprint, depth.mul(SUN_DIAMETER).div(waterDirection.y.max(.2)));
      const lod = blur.div(TEXEL).max(1).log2().min(6);
      const texelSize = float(2).pow(lod).div(RESOLUTION);
      const uv = fract(point.xz.div(TILE).add(.5)).mul(float(1).sub(texelSize)).add(texelSize.mul(.5));
      const first = lookup(atlas, vec2(uv.x.add(band).div(DEPTHS.length), uv.y)).level(lod).r;
      const second = lookup(atlas, vec2(uv.x.add(band).add(1).div(DEPTHS.length), uv.y)).level(lod).r;
      return mix(float(1), mix(first, second, blend), smoothstep(0, DEPTHS[0], depth));
    };
    /**
     * Focusing of the direct beam. Particles deflect photons out of the
     * caustic filaments; only the unscattered share keeps the pattern.
     */
    const focusNode = (point: TSLNode, footprint: TSLNode) => {
      const path = point.y.negate().max(0).div(waterDirection.y.max(.05));
      return densityNode(point, footprint).sub(1).mul(unscatteredFraction(path)).add(1);
    };
    const shadowAt = (point: TSLNode, filtered: boolean) => {
      const coord = shadowMatrix.mul(vec4(point, 1));
      const projected = coord.xyz.div(coord.w);
      const uv = vec2(projected.x, float(1).sub(projected.y));
      const coverage = smoothstep(0, .015, uv.x).mul(float(1).sub(smoothstep(.985, 1, uv.x)))
        .mul(smoothstep(0, .015, uv.y)).mul(float(1).sub(smoothstep(.985, 1, uv.y)))
        .mul(smoothstep(0, .005, projected.z.mul(2).sub(1)))
        .mul(float(1).sub(smoothstep(.995, 1, projected.z.mul(2).sub(1))));
      // LightShadow's matrix includes a legacy z*.5+.5 bias even on WebGPU.
      // Match Three's ShadowNode by undoing it before the depth comparison.
      const depth = projected.z.mul(2).sub(1).add(shadowBias);
      const compare = (coords: TSLNode) => lookup(shadowMap, coords).compare(depth);
      let visibility;
      if (filtered) {
        // Bilinear PCF smooths the binary nearest-filtered depth samples. This
        // is only used by material caustics, never inside the volume march.
        const pixel = uv.mul(shadowSize).sub(.5), blend = fract(pixel);
        const base = floor(pixel).add(.5).div(shadowSize), texel = vec2(1).div(shadowSize);
        visibility = mix(mix(compare(base), compare(base.add(vec2(texel.x, 0))), blend.x),
          mix(compare(base.add(vec2(0, texel.y))), compare(base.add(texel)), blend.x), blend.y);
      } else visibility = compare(uv);
      return mix(float(1), visibility, coverage.mul(shadowReady));
    };
    const shadowNode = (point: TSLNode) => {
      // The volume follows the bent underwater ray to the surface to query
      // occlusion from piers, cliffs and foliage with a single comparison.
      const entry = point.add(waterDirection.mul(point.y.negate().max(0).div(waterDirection.y)));
      return shadowAt(entry.add(vec3(0, .06, 0)), false);
    };
    // Caustics under piers and hulls fade out across the same soft edge as
    // the island's shadows (Atmosphere's filter spans about 18 cm).
    const receiverShadowNode = (point: TSLNode, normal: TSLNode) => {
      const biased = point.add(normal.mul(shadowNormalBias));
      let lit: TSLNode = shadowAt(biased, true);
      for (const [x, z] of [[.09, 0], [-.09, 0], [0, .09], [0, -.09]]) lit = lit.add(shadowAt(biased.add(vec3(x, 0, z)), true));
      return lit.div(5);
    };
    /** Mean irradiance of the refracted beam, normal to it, at a point. */
    const irradianceNode = (point: TSLNode) =>
      surfaceIrradiance.mul(beamTransmission(point.y.negate().max(0).div(waterDirection.y.max(.05))));
    return { target, light, direction, radiance, lit, waterDirection, transmittance, surfaceIrradiance,
      shadowMap, shadowReady, densityNode, focusNode, shadowNode, receiverShadowNode, irradianceNode };
  });

  let state = THREE.RendererUtils.saveRendererState(renderer);
  const viewport = new THREE.Vector4(), scissor = new THREE.Vector4();

  return {
    sources,
    sun: sources[0],
    /**
     * Extra light that focusing adds to a submerged surface, per unit albedo:
     * multiply by the surface color and add as emission. For water the sea's
     * own lighting does not reach, such as the freshwater pool.
     */
    lightNode(worldPosition: TSLNode = positionWorld) {
      return Fn(() => {
        // Build shared inputs before branching: a node first built inside a
        // branch is left unset for later uses outside it. Derivatives are also
        // undefined in divergent branches, so measure the footprint here.
        const point = vec3(worldPosition).toVar();
        const normal = normalWorld.toVar();
        const footprint = max(dFdx(point.xz).length(), dFdy(point.xz).length()).toVar();
        const light = vec3(0).toVar();
        If(point.y.lessThan(-.025), () => {
          for (const source of sources) If(source.lit.greaterThan(0), () => {
            const facing = dot(normal, source.waterDirection).max(0);
            light.addAssign(source.irradianceNode(point).mul(source.focusNode(point, footprint).sub(1))
              .mul(facing).mul(source.receiverShadowNode(point, normal)).mul(1 / Math.PI));
          });
          light.mulAssign(float(1).sub(smoothstep(-.16, -.025, point.y)));
        });
        return light;
      })();
    },
    /** Redraw the photon atlases of lit sources. */
    update({ prepare = false } = {}) {
      renderer.getViewport(viewport); renderer.getScissor(scissor);
      state = THREE.RendererUtils.resetRendererState(renderer, state);
      try {
        renderer.setScissorTest(false); renderer.setClearColor(0x000000, 0);
        for (const source of sources) {
          underwaterLightDirection(source.direction.value, source.waterDirection.value);
          source.transmittance.value = surfaceTransmission(source.direction.value.y);
          source.surfaceIrradiance.value.copy(source.radiance.value).multiplyScalar(source.transmittance.value);
          if (source.light.shadow.map?.depthTexture) {
            source.shadowMap.value = source.light.shadow.map.depthTexture;
            source.shadowReady.value = 1;
          }
          // Every consumer skips an unlit source; no wasted atlas pass.
          if (!prepare && !source.lit.value) continue;
          incomingDirection.value.copy(source.direction.value);
          flatTransmission.value = source.transmittance.value;
          renderer.setRenderTarget(source.target); renderer.render(photonScene, camera);
        }
      } finally {
        THREE.RendererUtils.restoreRendererState(renderer, state);
        renderer.setViewport(viewport); renderer.setScissor(scissor);
      }
    },
  };
}

export type CausticsField = ReturnType<typeof createCaustics>;
