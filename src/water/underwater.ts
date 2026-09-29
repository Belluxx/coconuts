import { Vector2, type Node, type PassNode, type PerspectiveCamera, type UniformNode, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, dot, exp, float, fract, getViewPosition, max, mix, normalize,
  rtt, screenCoordinate, screenUV, uniform, vec2, vec3, vec4, type ShaderNodeObject,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type { QualitySettings } from '../quality';
import { renderWhen, type TSLNode } from '../shading';
import type { CausticsField } from './caustics';
import { waterTransmission, waterViewHeight } from './optics';
import type { UnderwaterLight } from './underwaterLight';

/** Integrate the light scattered toward the eye along the visible water segment of each view ray. */
export function createUnderwaterView(
  renderer: WebGPURenderer, camera: PerspectiveCamera, scenePass: PassNode,
  light: UnderwaterLight, caustics: CausticsField, immersion: ShaderNodeObject<UniformNode<number>>,
) {
  const submersion = uniform(0), steps = uniform(48, 'int');
  const underwater = () => immersion.value > 0;
  const eye = uniform(camera.position), cameraWorld = uniform(camera.matrixWorld);
  const inverseProjection = uniform(camera.projectionMatrixInverse);
  const sceneDepth = scenePass.getTextureNode('depth');
  const viewPosition = getViewPosition(screenUV, sceneDepth, inverseProjection);
  const worldRay = normalize(cameraWorld.mul(vec4(normalize(viewPosition), 0)).xyz);
  // Only upward rays leave the water. Downward rays retain their full optical
  // path even when the eye is just a few millimeters below a wave crest.
  const surfaceDistance = worldRay.y.greaterThan(0)
    .select(submersion.div(max(worldRay.y, .00001)), float(250));
  const distance = viewPosition.length().min(surfaceDistance).clamp(0, 250);
  const marchDistance = distance.min(80);
  // A stable subpixel offset breaks up marching bands without temporal shimmer.
  const jitter = fract(fract(dot(screenCoordinate, vec2(.06711056, .00583715))).mul(52.9829189));
  // Short-range occlusion gives plates, sponge mouths and coral roots contact
  // with their surroundings. Reconstruct normals from the existing depth so
  // the whole island does not need another full-resolution render attachment.
  // r180's runtime accepts null for reconstructed normals; its declarations do not.
  const contact = ao(sceneDepth, null as unknown as Node, camera);
  contact.resolutionScale = .5;
  contact.radius.value = .65;
  contact.thickness.value = 1.2;
  contact.distanceFallOff.value = .85;
  contact.scale.value = 1;
  contact.samples.value = 12;
  renderWhen(contact, underwater);

  const scattering = Fn(() => {
    const scattered = vec3(0).toVar();
    If(immersion.greaterThan(.0001), () => {
      const along = light.scatteringAlong(worldRay);
      // How far the refracted shafts drift sideways per meter along the ray:
      // a march step can resolve no finer caustic detail than this.
      const drift = worldRay.xz.sub(caustics.sun.waterDirection.xz.mul(worldRay.y.div(caustics.sun.waterDirection.y))).length().toVar();
      Loop(steps, ({ i }) => {
        // Spend more of the integration budget in the near water where shafts
        // and silhouettes need definition, while still reaching the distant blue.
        const near = float(i).div(float(steps)).pow(1.35).mul(marchDistance);
        const far = float(i).add(1).div(float(steps)).pow(1.35).mul(marchDistance);
        const stride = far.sub(near);
        const at = near.add(stride.mul(jitter.mul(.7).add(.15)));
        const point = eye.add(worldRay.mul(at)).toVar();
        scattered.addAssign(along(point, drift.mul(stride).max(.02)).mul(waterTransmission(at)).mul(stride));
      });
      // Past the march, the open water adds its own unbounded glow.
      const end = eye.add(worldRay.mul(marchDistance));
      scattered.addAssign(light.bodyRadiance(end.xz, worldRay)
        .mul(waterTransmission(marchDistance).sub(waterTransmission(distance))));
    });
    return vec4(scattered, distance);
  })();
  // The volume is smooth by nature. Integrate it once at half resolution while
  // keeping sky, silhouettes, fish and seabed at the native scene resolution.
  const volume = rtt(scattering, 1, 1);
  volume.updateBeforeType = 'frame';
  renderWhen(volume, underwater);
  const texel = uniform(new Vector2(1, 1)), size = new Vector2();
  const neighbors = [vec2(0), vec2(texel.x, 0), vec2(texel.x.negate(), 0), vec2(0, texel.y), vec2(0, texel.y.negate())];
  const softVolume = Fn(() => {
    const light = vec3(0).toVar(), weightSum = float(0).toVar();
    neighbors.forEach((offset, i) => {
      const sample = volume.sample(screenUV.add(offset).clamp(.001, .999));
      // Depth-aware reconstruction keeps shafts behind fish and pier posts,
      // avoiding bright fringes where low-resolution samples cross a silhouette.
      const weight = exp(sample.a.sub(distance).abs().div(max(.15, distance.mul(.025))).negate()).mul(i === 0 ? .4 : .15);
      light.addAssign(sample.rgb.mul(weight)); weightSum.addAssign(weight);
    });
    return light.div(weightSum.max(.00001));
  })();
  const contactTexture = contact.getTextureNode();
  const softContact = Fn(() => {
    const occlusion = float(0).toVar(), weightSum = float(0).toVar();
    for (const offset of neighbors) {
      const coords = screenUV.add(offset).clamp(.001, .999);
      const neighbor = getViewPosition(coords, sceneDepth.sample(coords), inverseProjection);
      const weight = exp(neighbor.z.sub(viewPosition.z).abs().mul(-12));
      occlusion.addAssign(contactTexture.sample(coords).r.mul(weight)); weightSum.addAssign(weight);
    }
    return occlusion.div(weightSum.max(.0001)).clamp(0, 1);
  })();

  return {
    /** Contact shadows, absorption along the view ray, and in-scattered light. */
    apply(lit: TSLNode) {
      const grounded = lit.mul(mix(float(1), softContact, float(.42)));
      return mix(lit, grounded.mul(waterTransmission(distance)).add(softVolume), immersion);
    },
    /** Follow the camera across the moving waterline; `immersion` is already current. */
    update(surfaceHeight: number) {
      const depth = surfaceHeight - camera.position.y;
      submersion.value = Math.max(0, waterViewHeight(surfaceHeight, depth) - camera.position.y);
      if (!underwater()) return;
      renderer.getDrawingBufferSize(size);
      const width = Math.max(1, Math.ceil(size.x / 2)), height = Math.max(1, Math.ceil(size.y / 2));
      if (volume.width !== width || volume.height !== height) {
        volume.setSize(width, height); texel.value.set(1 / width, 1 / height);
      }
    },
    setQuality(quality: QualitySettings) {
      steps.value = quality.underwaterSteps;
      contact.samples.value = quality.contactShadowSamples;
    },
  };
}
