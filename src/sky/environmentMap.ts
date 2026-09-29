import * as THREE from 'three/webgpu';
import { mix, pmremTexture, uniform } from 'three/tsl';
import type { TSLNode } from '../shading';
import type { SkyPosition } from './celestial';

/** Crossfade sky captures so indirect light never steps while time is changing. */
export function createEnvironmentMap(renderer: THREE.WebGPURenderer, scene: THREE.Scene, sky: THREE.Mesh, position: SkyPosition) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const captureScene = new THREE.Scene(); captureScene.add(sky);
  const capture = (target?: THREE.RenderTarget) => pmrem.fromScene(captureScene, 0, .1, 5000, { size: 128, renderTarget: target });
  const targets = [capture(), capture()];
  const blend = uniform(0);
  const sample = (direction?: TSLNode, roughness?: TSLNode) => mix(
    pmremTexture(targets[0].texture, direction, roughness),
    pmremTexture(targets[1].texture, direction, roughness), blend,
  );
  scene.environment = targets[0].texture;
  scene.environmentNode = sample();
  scene.environmentIntensity = 1;
  const sun = position.sun.clone(), moon = position.moon.clone();
  let active = 0, started = -Infinity, captured = performance.now() / 1000;
  const duration = .18;
  return {
    sample,
    /** Recapture both targets, e.g. after temporarily revealed scenery. */
    prepare() {
      targets.forEach(target => capture(target));
      blend.value = active;
      started = -Infinity;
      captured = performance.now() / 1000;
    },
    update(seconds: number, position: SkyPosition) {
      const progress = THREE.MathUtils.smoothstep(seconds - started, 0, duration);
      blend.value = active === 1 ? progress : 1 - progress;
      if (progress < 1) return;
      const changed = sun.angleTo(position.sun) > .001 || moon.angleTo(position.moon) > .002;
      // Vapor drifts and changes shape even while the celestial sky is still.
      if (!changed && seconds - captured < 5) return;
      active = 1 - active;
      capture(targets[active]);
      started = seconds; captured = seconds;
      sun.copy(position.sun); moon.copy(position.moon);
    },
  };
}

export type EnvironmentMap = ReturnType<typeof createEnvironmentMap>;
