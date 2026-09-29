import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraWorldMatrix, color, dot, float, fract, getViewPosition, mix,
  pass, positionLocal, positionWorld, screenUV, sin, smoothstep, time, uniform, uv, vec3, vec4, type ShaderNodeObject,
} from 'three/tsl';
import { seededRandom } from '../math';
import type { QualitySettings } from '../quality';
import { billboardGeometry } from '../render/billboards';
import { renderWhen, type TSLNode } from '../shading';
import type { CausticsField } from './caustics';
import { waterTransmission } from './optics';
import type { UnderwaterLight } from './underwaterLight';

/** Henyey–Greenstein phase (1/sr): the diffraction peak of millimeter flakes. */
const diffraction = (cosine: TSLNode) => float(1 - .9 ** 2).div(float(1 + .9 ** 2).sub(cosine.mul(1.8)).pow(1.5)).mul(1 / (4 * Math.PI));

/** Suspended plankton and settling marine snow, in a continuous world-space current. */
export function createMarineParticles(
  camera: THREE.PerspectiveCamera, light: UnderwaterLight, caustics: CausticsField,
  scenePass: THREE.PassNode, immersion: ShaderNodeObject<THREE.UniformNode<number>>,
) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const random = seededRandom(419321);
  const count = 6400;
  const geometry = billboardGeometry(count, () => {
    const x = random() * 32, y = random() * 18, z = random() * 32;
    const phase = random() * Math.PI * 2, speed = .55 + random() * .9;
    // Most particles resolve as a speck. Occasional larger organic flakes
    // provide close parallax without filling the water with oversized bubbles.
    const size = .007 + Math.pow(random(), 3) * .030;
    const flake = random();
    return { position: [x, y, z], particleSeed: [phase, speed, size, flake] };
  });

  const seed = attribute('particleSeed', 'vec4');
  const current = vec3(time.mul(.035).add(sin(time.mul(.13).add(seed.x)).mul(.16)),
    time.mul(-.014).mul(seed.y).add(sin(time.mul(.19).add(seed.x)).mul(.1)),
    time.mul(.017).add(sin(time.mul(.09).add(seed.x.mul(2))).mul(.23)));
  const extent = vec3(32, 18, 32);
  const wrapped = fract(positionLocal.add(current).sub(cameraPosition).div(extent).add(.5)).sub(.5).mul(extent);
  const center = cameraPosition.add(wrapped);
  const p = uv().sub(.5).mul(2);
  const size = seed.z.mul(sin(time.mul(.3).add(seed.x)).mul(.12).add(1));
  const corner = vec3(p.x.mul(size), p.y.mul(size).mul(mix(float(.52), float(1), seed.w)), 0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    blending: THREE.AdditiveBlending,
  });
  material.name = 'Water column · suspended plankton and marine snow';
  material.positionNode = center.add(cameraWorldMatrix.mul(vec4(corner, 0)).xyz);

  const ray = positionWorld.sub(cameraPosition);
  const distance = ray.length();
  // A flake larger than the wavelength removes twice its cross-section from a
  // beam: half diffracted into a narrow forward peak, half scattered widely
  // by its surface. Seen against the sun, motes in a shaft blaze.
  const point = positionWorld;
  let incident: TSLNode = light.downwelling(point).add(light.upwelling(point)).mul(1 / (2 * Math.PI));
  for (const source of caustics.sources) {
    const phase = diffraction(dot(ray.normalize(), source.waterDirection)).add(1 / (4 * Math.PI));
    incident = incident.add(source.irradianceNode(point).mul(source.focusNode(point, float(.05)))
      .mul(source.shadowNode(point)).mul(phase).mul(source.lit));
  }
  const tint = mix(color('#a8d8cc'), color('#f3eccf'), seed.w).mul(.8);
  material.colorNode = tint.mul(incident).mul(waterTransmission(distance));
  const disc = float(1).sub(smoothstep(.08, 1, p.length())).pow(1.6);
  const range = smoothstep(.22, 1.2, distance).mul(float(1).sub(smoothstep(10, 15, distance)));
  const verticalRange = float(1).sub(smoothstep(6.8, 8.8, positionWorld.y.sub(cameraPosition.y).abs()));
  const submerged = float(1).sub(smoothstep(-.24, -.07, positionWorld.y));
  // Sample the main scene's opaque depth to soften intersections. Compositing
  // after the water volume makes each mote absorb over its own short path,
  // instead of disappearing under the distant seabed's much stronger fog.
  const inverseProjection = uniform(camera.projectionMatrixInverse);
  const opaqueDistance = getViewPosition(screenUV, scenePass.getTextureNode('depth'), inverseProjection).length();
  const intersection = smoothstep(0, .22, opaqueDistance.sub(distance));
  material.opacityNode = disc.mul(range).mul(verticalRange).mul(submerged).mul(intersection).mul(seed.w.mul(.3).add(.35));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Drifting marine snow · near and distant parallax';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  const particlePass = pass(scene, camera);
  renderWhen(particlePass, () => immersion.value > 0);
  return {
    /** Add the plankton, rendered in their own pass, to the underwater view. */
    apply(view: TSLNode) {
      return view.add(particlePass.getTextureNode('output').rgb.mul(immersion));
    },
    setQuality(quality: QualitySettings) {
      geometry.setDrawRange(0, Math.min(count, quality.plankton) * 6);
    },
  };
}
