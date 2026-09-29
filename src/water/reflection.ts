import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrix, cameraViewMatrix, float, getViewPosition, max, min, mix,
  normalize, positionView, reflect, reflector, smoothstep, uniform, vec3, vec4,
} from 'three/tsl';
import type { QualitySettings } from '../quality';
import type { TSLNode } from '../shading';
import type { EnvironmentMap } from '../sky/environmentMap';
import { waterImmersion, waterTransmission, waterViewHeight } from './optics';

/**
 * Own the planar mirror, its capture budget, and both sides of its water optics.
 * `roughness` (perceptual) comes from the wave slopes each pixel cannot resolve.
 */
export function createOceanReflection(
  ocean: THREE.Mesh, normal: TSLNode, eye: TSLNode, roughness: TSLNode,
  environmentMap: EnvironmentMap, quality: QualitySettings, waterBody: (ray: TSLNode) => TSLNode,
) {
  const submerged = uniform(0);
  const reflection = reflector({ resolutionScale: quality.reflectionScale, bounces: false, depth: true, generateMipmaps: true });
  const mirrorInverseProjection = uniform(new THREE.Matrix4());
  ocean.add(reflection.target);
  const getCamera = reflection.reflector.getVirtualCamera.bind(reflection.reflector);
  reflection.reflector.getVirtualCamera = camera => {
    const mirror = getCamera(camera); mirror.layers.set(submerged.value > .5 ? 0 : 1); return mirror;
  };
  const updateReflection = reflection.reflector.updateBefore.bind(reflection.reflector);
  const lastPosition = new THREE.Vector3(), lastRotation = new THREE.Quaternion();
  let capturedAt = -Infinity, rendered = false;
  reflection.reflector.updateBefore = frame => {
    if (!frame.camera) return;
    const now = performance.now() / 1000;
    const moving = lastPosition.distanceToSquared(frame.camera.position) > .0025 || lastRotation.angleTo(frame.camera.quaternion) > .003;
    const below = submerged.value > .5;
    const reflectionHz = below ? Math.min(30, quality.reflectionHz) : quality.reflectionHz;
    if (rendered && (!moving || below) && now - capturedAt < 1 / reflectionHz) return;
    updateReflection(frame);
    mirrorInverseProjection.value.copy(getCamera(frame.camera).projectionMatrix).invert();
    lastPosition.copy(frame.camera.position); lastRotation.copy(frame.camera.quaternion);
    capturedAt = now; rendered = true;
  };
  // Project the wave-reflected ray into the flat mirror's camera. A fixed
  // world-XZ UV offset separates the reflected sun from its specular glint
  // as the viewer turns. Both now follow the same surface normal.
  const reflectedRay = reflect(eye.negate(), normal);
  const reflectedClip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(reflectedRay.mul(vec3(1, -1, 1)), 0)));
  const reflectionUV = reflectedClip.xy.div(max(reflectedClip.w, .001)).mul(-.5).add(.5);
  reflection.uvNode = reflectionUV.clamp(.001, .999);

  // At grazing angles, waves send rays outside the mirror's image or below
  // its clipping plane. Fade to the sky there instead of stretching a dark
  // border across the distant water. Follow environment changes at sunset.
  const skyDirection = normalize(vec3(reflectedRay.x, max(reflectedRay.y, .025), reflectedRay.z));
  const skyReflection = environmentMap.sample(skyDirection, roughness.clamp(.04, .6));
  const edgeDistance = min(min(reflectionUV.x, float(1).sub(reflectionUV.x)),
    min(reflectionUV.y, float(1).sub(reflectionUV.y)));
  const mirrorCoverage = smoothstep(0, .04, edgeDistance)
    .mul(smoothstep(0, .04, reflectedRay.y)).mul(smoothstep(0, .1, reflectedClip.w));
  const surfaceMirror = reflection.level(roughness.sub(.12).max(0).mul(10)).rgb;
  const reflectedColor = mix(skyReflection.rgb, surfaceMirror, mirrorCoverage.mul(float(1).sub(smoothstep(50, 180, positionView.z.negate()))));

  const mirrorDepth = reflection.getDepthNode();
  mirrorDepth.uvNode = reflectionUV.clamp(.001, .999);
  const mirrorView = getViewPosition(reflectionUV.clamp(.001, .999), mirrorDepth, mirrorInverseProjection);
  const reflectionDistance = mirrorView.length().sub(positionView.length()).clamp(0, 90);
  // Below, the mirrored ray crosses water to the reef: its image dims and
  // the water body's own light replaces it. Open water is only that light.
  const reflectedTransmission = waterTransmission(reflectionDistance);
  const body = waterBody(reflectedRay);
  const submergedReflection = reflection.level(float(1.3)).rgb.mul(reflectedTransmission)
    .add(body.mul(vec3(1).sub(reflectedTransmission)));
  const submergedCoverage = smoothstep(0, .055, edgeDistance)
    .mul(smoothstep(0, .08, reflectedRay.y.negate())).mul(smoothstep(0, .1, reflectedClip.w));
  const reefMirror = mix(body, submergedReflection, submergedCoverage);

  function setResolution() {
    reflection.reflector.resolutionScale = submerged.value > .5
      ? Math.min(.5, quality.reflectionScale) : quality.reflectionScale;
    rendered = false;
  }

  return {
    submerged,
    surface: reflectedColor,
    underwater: reefMirror,
    updateViewer(depth: number, surfaceHeight: number) {
      const wasBelow = submerged.value > .5;
      submerged.value = waterImmersion(depth);
      // The mirror must share the local waterline too, otherwise a crest can
      // put the eye underwater while its underside capture still faces away.
      reflection.target.position.z = waterViewHeight(surfaceHeight, depth);
      reflection.target.updateMatrixWorld(true);
      if (wasBelow === (submerged.value > .5)) return;
      reflection.target.rotation.y = submerged.value > .5 ? Math.PI : 0;
      reflection.target.updateMatrixWorld(true);
      setResolution();
    },
    setQuality(settings: QualitySettings) {
      quality = settings;
      setResolution();
    },
  };
}
