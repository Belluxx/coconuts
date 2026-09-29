import * as THREE from 'three/webgpu';
import { Fn, If, float, pass, renderOutput, screenUV, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { QualitySettings } from '../quality';
import type { CausticsField } from '../water/caustics';
import { daylightRemaining, waterImmersion } from '../water/optics';
import { createMarineParticles } from '../water/particles';
import { createUnderwaterView } from '../water/underwater';
import type { UnderwaterLight } from '../water/underwaterLight';
import { LampLighting } from './localLighting';

/**
 * Desktop WebGPU only. Three's automatic WebGL fallback is disabled explicitly:
 * shader features, render targets, and the quality budget all target WebGPU.
 */
export async function createRenderer(canvas: HTMLCanvasElement, quality: QualitySettings) {
  if (!navigator.gpu) throw new Error('This island requires desktop WebGPU. Enable hardware acceleration and open it in a WebGPU-capable desktop browser.');
  const renderer = new THREE.WebGPURenderer({
    canvas,
    // FXAA avoids resolving multisampled HDR buffers at every refraction copy.
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer._getFallback = null;
  renderer.lighting = new LampLighting();
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = .92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/** Scene pass, then underwater optics and plankton, bloom, a soft vignette, tone mapping and FXAA. */
export function createPostProcessing(
  renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
  light: UnderwaterLight, caustics: CausticsField,
) {
  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  // How far the eye is below the moving waterline, eased over two centimeters.
  const immersion = uniform(0);
  const underwater = createUnderwaterView(renderer, camera, scenePass, light, caustics, immersion);
  const plankton = createMarineParticles(camera, light, caustics, scenePass, immersion);
  const lit = scenePass.getTextureNode('output').rgb;
  // Above the water, skip the underwater composite entirely, in the bloom pass as well as the output.
  const view = Fn(() => {
    const color = vec3(lit).toVar();
    If(immersion.greaterThan(0), () => { color.assign(plankton.apply(underwater.apply(color))); });
    return color;
  })();
  const glow = bloom(view, .16, .45, 1.08);
  const vignette = smoothstep(.35, .78, screenUV.sub(.5).length()).mul(.09);
  post.outputColorTransform = false;
  post.outputNode = fxaa(renderOutput(vec4(view.add(glow.rgb).mul(float(1).sub(vignette)), 1), renderer.toneMapping, renderer.outputColorSpace));
  // Below the surface there is no bright sky, and daylight dims and turns
  // blue with depth. The eye adapts to it over a second or two.
  let adaptation = 1;
  return {
    render: () => post.render(),
    /** The eye is below the waterline, at least in part. */
    get underwater() { return immersion.value > 0; },
    /** Exposure gain of the adapted eye. */
    get adaptation() { return adaptation; },
    /** Follow the camera across the moving waterline. */
    update(surfaceHeight: number, seconds = 1) {
      const depth = surfaceHeight - camera.position.y;
      immersion.value = waterImmersion(depth);
      underwater.update(surfaceHeight);
      const target = 1 + immersion.value * (1.4 / daylightRemaining(depth) ** .7 - 1);
      adaptation += (target - adaptation) * (1 - Math.exp(-seconds / 1.2));
    },
    setQuality(quality: QualitySettings) {
      underwater.setQuality(quality);
      plankton.setQuality(quality);
    },
  };
}

export type PostProcessing = ReturnType<typeof createPostProcessing>;
