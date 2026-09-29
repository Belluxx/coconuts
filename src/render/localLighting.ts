import * as THREE from 'three/webgpu';
import { If, vec3 } from 'three/tsl';
import { QUALITY, type QualitySettings } from '../quality';
import type { TSLNode } from '../shading';

type DirectLight = { lightDirection: TSLNode; lightColor: TSLNode };
type DirectLightFilter = (light: THREE.Light, direct: DirectLight) => DirectLight;
let directLightFilter: DirectLightFilter | undefined;

/** Let the sun and moon change with the receiving point, as they do below the water. Install before shaders build. */
export function filterDirectLight(filter: DirectLightFilter) { directLightFilter = filter; }

/**
 * Lamp slots keep their shaders through the day (see below), so each lamp's
 * lighting sits in a branch: a dark lamp, or one out of reach, costs a pixel
 * no BRDF evaluation. The sun and moon have lower light ids and are set up
 * first, outside any branch, so the terms all lights share are built there.
 */
class LampLightsNode extends THREE.LightsNode {
  setupDirectLight(...[builder, lightNode, lightData]: Parameters<THREE.LightsNode['setupDirectLight']>) {
    if (!(lightNode instanceof THREE.PointLightNode)) {
      const direct = lightData as unknown as DirectLight, light = (lightNode as THREE.AnalyticLightNode<THREE.Light>).light;
      const filtered = directLightFilter && light ? { ...lightData, ...directLightFilter(light, direct) } : lightData;
      return super.setupDirectLight(builder, lightNode, filtered);
    }
    const lightColor = vec3(lightData.lightColor).toVar();
    If(lightColor.dot(vec3(1)).greaterThan(.00001), () => super.setupDirectLight(builder, lightNode, { ...lightData, lightColor }));
  }
}

/** Install before the renderer initializes. */
export class LampLighting extends THREE.Lighting {
  createNode(lights: THREE.Light[] = []) { return new LampLightsNode().setLights(lights); }
}

/** Reuse a fixed set of shader light slots as the player walks between lamps. */
export function createLocalLighting(scene: THREE.Scene) {
  const sources: { light: THREE.PointLight; position: THREE.Vector3; score: number }[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!(object instanceof THREE.PointLight)) return;
    sources.push({ light: object, position: object.getWorldPosition(new THREE.Vector3()), score: 0 });
    object.visible = false;
  });
  const capacity = Math.min(sources.length, Math.max(...Object.values(QUALITY).map(quality => quality.localLights)));
  const slots = Array.from({ length: capacity }, () => {
    const light = new THREE.PointLight('#ffad48', 0, 8, 2);
    light.name = 'Island · nearby lamplight';
    light.layers.enable(1);
    light.visible = false;
    scene.add(light);
    return { light, source: undefined as typeof sources[number] | undefined };
  });
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), sphere = new THREE.Sphere();
  let selectionTime = -Infinity;
  let selected: typeof sources = [];
  let settings: QualitySettings | undefined;
  return {
    /** Enable the light slots of a preset so its shaders compile with the final light count. */
    prepare(quality: QualitySettings) {
      slots.forEach((slot, index) => { slot.light.visible = index < quality.localLights; });
    },
    update(dt: number, elapsed: number, camera: THREE.Camera, darkness: number, quality: QualitySettings) {
      const budget = Math.min(slots.length, quality.localLights);
      if (elapsed - selectionTime > .2 || settings !== quality) {
        selectionTime = elapsed; settings = quality;
        if (budget === sources.length && quality.localLightDistance === Infinity) {
          selected = sources;
        } else {
          camera.updateMatrixWorld();
          frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), THREE.WebGPUCoordinateSystem);
          for (const source of sources) {
            sphere.center.copy(source.position); sphere.radius = source.light.distance;
            const distance = Math.max(0, camera.position.distanceTo(source.position) - source.light.distance);
            source.score = distance < quality.localLightDistance && frustum.intersectsSphere(sphere)
              ? distance * (selected.includes(source) ? .8 : 1) : Infinity;
          }
          selected = sources.filter(source => Number.isFinite(source.score)).sort((a, b) => a.score - b.score).slice(0, budget);
        }
      }
      const assigned = new Set(slots.slice(0, budget).map(slot => slot.source).filter(source => source && selected.includes(source)));
      slots.forEach((slot, index) => {
        // Keep light identities stable: movement updates uniforms, not shader variants.
        const retained = index < budget && slot.source && selected.includes(slot.source);
        if (!retained) {
          slot.light.intensity *= Math.exp(-dt * 18);
          if (slot.light.intensity < .02 || darkness === 0) {
            slot.source = index < budget ? selected.find(source => !assigned.has(source)) : undefined;
            if (slot.source) assigned.add(slot.source);
          }
        }
        if (slot.source) {
          slot.light.position.copy(slot.source.position);
          slot.light.color.copy(slot.source.light.color);
          slot.light.distance = slot.source.light.distance;
          const target = index < budget && selected.includes(slot.source) ? slot.source.light.intensity * darkness : 0;
          slot.light.intensity = THREE.MathUtils.lerp(slot.light.intensity, target, 1 - Math.exp(-dt * 12));
        }
        // Keep shaders stable through sunset and movement. Removing dark slots
        // discards pipelines and causes compilation stalls on the next night walk.
        slot.light.visible = index < budget;
      });
    },
  };
}

export type LocalLighting = ReturnType<typeof createLocalLighting>;
