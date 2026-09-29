import * as THREE from 'three/webgpu';
import { attribute, color, float, floor, fract, fwidth, mix, positionLocal, positionWorld, sin, smoothstep, vec2 } from 'three/tsl';
import { reliefNormal } from '../shading';

/** Shared reef-fish skin and continuous GPU fin animation. */
export function createMarineFishMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .39, metalness: .13, side: THREE.DoubleSide });
  const surface = attribute('fishSurface', 'float');
  const scales = attribute('fishUv', 'vec2').mul(vec2(46, 28));
  const cell = vec2(fract(scales.x.add(floor(scales.y).mul(.5))).sub(.5), fract(scales.y).sub(.5));
  const scaleEdge = smoothstep(float(.32), float(.49), cell.length());
  const skin = smoothstep(float(.8), float(1), surface).mul(float(1).sub(smoothstep(float(1.1), float(1.8), surface)));
  const eye = smoothstep(float(1.1), float(1.8), surface);
  // Scale relief fades below a pixel instead of sparkling on distant shoals.
  const footprint = fwidth(scales);
  const scaleVisibility = float(1).sub(smoothstep(float(.55), float(1.15), footprint.x.max(footprint.y)));
  const scaleDetail = scaleEdge.mul(skin).mul(scaleVisibility);
  material.colorNode = color('#ffffff').mul(float(1).sub(scaleDetail.mul(.11)));
  material.roughnessNode = mix(mix(float(.54), float(.29).add(scaleDetail.mul(.17)), skin), float(.085), eye);
  material.metalnessNode = mix(float(.025), float(.18), skin);
  material.normalNode = reliefNormal(scaleDetail.mul(-.00048));
  const rest = attribute('position', 'vec3');
  const motion = attribute('fishMotion', 'vec3');
  // CPU integrates one phase per active fish; the body deformation stays on
  // the GPU. Changing escape cadence therefore never jumps the tail phase.
  const cycle = motion.x;
  const tailWeight = smoothstep(float(-.14), float(.73), rest.x.negate());
  const stroke = sin(cycle.add(rest.x.mul(7.5))).mul(tailWeight).mul(motion.z);
  const flutter = sin(cycle.mul(1.31).add(motion.y)).mul(attribute('finFlutter', 'float')).mul(.027);
  // positionLocal has already received the instance transform here. Deform along
  // each instance's scaled lateral axis, while measuring weights in rest space.
  material.positionNode = positionLocal.add(attribute('swimSide', 'vec3').mul(stroke.add(flutter)));
  return material;
}
