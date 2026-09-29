import * as THREE from 'three/webgpu';
import type { QualitySettings } from '../quality';
import type { Atmosphere } from '../sky/atmosphere';
import type { EnvironmentMap } from '../sky/environmentMap';
import type { CausticsField } from '../water/caustics';
import type { Ocean } from '../water/ocean';
import type { LocalLighting } from './localLighting';
import type { PostProcessing } from './renderer';

/** Render one real frame: refraction copies need active HDR render passes. */
export async function renderFrameAndWait(renderer: THREE.WebGPURenderer, render: () => void) {
  await new Promise<void>((resolve, reject) => {
    renderer.setAnimationLoop(() => {
      try { render(); resolve(); }
      catch (error) { reject(error); }
      finally { renderer.setAnimationLoop(null); }
    });
  });
  await renderer.waitForGPU();
}

interface Island {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  post: PostProcessing;
  quality: QualitySettings;
  atmosphere: Atmosphere;
  ocean: Ocean;
  localLighting: LocalLighting;
  environmentMap: EnvironmentMap;
  caustics: CausticsField;
  /** Animals that turn off their shadows when sleeping or far from the viewer. */
  dynamicShadowCasters: THREE.Object3D;
  /** Called before compiling the view from above and below the water. */
  beforePass(underwater: boolean): Promise<void>;
}

/**
 * Compile every material in its color, mirror and shadow passes, above and
 * below the water, so walking around never stalls on shader compilation.
 */
export async function preloadIsland({
  renderer, scene, camera, post, quality, atmosphere, ocean, localLighting, environmentMap, caustics, dynamicShadowCasters, beforePass,
}: Island) {
  const objects: { object: THREE.Object3D; visible: boolean; culled: boolean; layers: number; shadow: boolean }[] = [];
  const instances: { mesh: THREE.InstancedMesh; count: number }[] = [];
  const position = camera.position.clone(), rotation = camera.quaternion.clone();
  localLighting.prepare(quality);

  const updateWater = () => {
    camera.updateMatrixWorld(true);
    ocean.updateViewer(camera);
    post.update(ocean.surfaceHeight(camera.position.x, camera.position.z));
  };

  try {
    for (const root of [scene, atmosphere.environmentMesh]) root.traverse(object => {
      objects.push({ object, visible: object.visible, culled: object.frustumCulled,
        layers: object.layers.mask, shadow: object.castShadow });
      // Preserve the selected light budget. Enabling the original lamp objects
      // would compile a different lighting configuration from gameplay.
      if (!(object instanceof THREE.Light)) object.visible = true;
      object.frustumCulled = false;
      const detail = object.userData.vegetationDetail;
      if (detail) {
        object.layers.enable(0);
        for (const layer of [1, 2]) {
          if (detail === 'far' || quality.detailedVegetationPasses) object.layers.enable(layer);
          else object.layers.disable(layer);
        }
      }
      if (object instanceof THREE.InstancedMesh) {
        instances.push({ mesh: object, count: object.count });
        if (object.count === 0 && object.instanceMatrix.count > 0) object.count = 1;
      }
    });
    dynamicShadowCasters.traverse(object => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });

    // Crossing the surface changes the mirror's layers and lighting, and
    // activates the volume/particle passes. Exercise both with the real camera.
    for (const depth of [-2, 2]) {
      await beforePass(depth > 0);
      camera.position.set(4, ocean.surfaceHeight(4, -1) - depth, -1);
      camera.lookAt(18, depth > 0 ? -3 : 0, -9);
      updateWater();
      await renderFrameAndWait(renderer, () => {
        environmentMap.prepare();
        atmosphere.updateShadows(true);
        caustics.update({ prepare: true });
        post.render();
      });
    }
  } finally {
    for (const { object, visible, culled, layers, shadow } of objects) {
      object.visible = visible; object.frustumCulled = culled;
      object.layers.mask = layers; object.castShadow = shadow;
    }
    for (const { mesh, count } of instances) mesh.count = count;
    camera.position.copy(position); camera.quaternion.copy(rotation);
    updateWater();
    // Replace captures containing temporarily revealed scenery before play.
    environmentMap.prepare();
    atmosphere.updateShadows(true);
  }
}
