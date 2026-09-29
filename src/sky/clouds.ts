import * as THREE from 'three/webgpu';
import {
  Break, Fn, If, Loop, cameraPosition, dot, exp, float, max, min, mix,
  modelWorldMatrix, modelWorldMatrixInverse, normalize, positionGeometry,
  positionWorld, smoothstep, step, texture3D, uniform, varying, vec3, vec4,
} from 'three/tsl';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { seededRandom } from '../math';
import type { QualitySettings } from '../quality';
import type { TSLNode } from '../shading';
import type { EnvironmentLight } from './light';

interface CloudState {
  x: number; z: number; speed: number; phase: number; evolution: number; extinction: number;
  morph: THREE.Vector3; flow: THREE.Vector3; size: THREE.Vector3; density: number;
}
const FIELD_RADIUS = 2300, FIELD_SPAN = FIELD_RADIUS * 2;
const VOLUME_SIZE = 96;
const wrap = (value: number) => THREE.MathUtils.euclideanModulo(value + FIELD_RADIUS, FIELD_SPAN) - FIELD_RADIUS;

/**
 * Bake one cloud shape as three morph frames of smooth signed distance (RGB)
 * plus billow density (A). Storing distances instead of thresholded opacity
 * keeps edges crisp under magnification.
 */
function bakeCloudVolume(seed: number, kind: number) {
  const random = seededRandom(seed), noise = new ImprovedNoise();
  // A connected condensation base supports every crown. Keeping a broad
  // footprint in both horizontal axes avoids tall, finger-like end views.
  const flat = kind % 3 === 0;
  const lobes = [{ x: 0, y: -.105, z: 0, rx: .28, ry: .10, rz: .23 }];
  const count = 3 + kind % 3;
  for (let i = 0; i < count; i++) {
    const along = i / (count - 1);
    lobes.push({
      x: (along - .5) * .40 + (random() - .5) * .022,
      y: -.01 + Math.sin(along * Math.PI) * (flat ? .035 : .085),
      z: (random() - .5) * .065,
      rx: .125 + random() * .025,
      ry: (flat ? .18 : .215) + random() * .025,
      rz: .15 + random() * .035,
    });
  }
  // Foreground and rear billows make the silhouette coherent from every
  // azimuth, instead of arranging separate spheres along a thin strip.
  for (const side of [-1, 1]) {
    lobes.push({
      x: (random() - .5) * .15, y: -.035 + random() * .035, z: side * .135,
      rx: .15 + random() * .03, ry: .155 + random() * .03, rz: .15,
    });
    lobes.push({
      x: side * .26, y: -.085, z: (random() - .5) * .045,
      rx: .115, ry: .105 + random() * .02, rz: .18,
    });
  }
  const phases = lobes.map(() => random() * Math.PI * 2);
  const frames = [0, 1, 2].map(frame => lobes.map((lobe, i) => {
    const phase = phases[i] + frame * Math.PI * 2 / 3;
    return {
      x: lobe.x + Math.sin(phase) * .022,
      y: lobe.y + Math.cos(phase) * .030,
      z: lobe.z + Math.sin(phase + 1.7) * .018,
      rx: 1 / (lobe.rx * (1 + Math.sin(phase + .8) * .15)),
      ry: 1 / (lobe.ry * (1 + Math.cos(phase + 1.4) * .20)),
      rz: 1 / (lobe.rz * (1 + Math.sin(phase + 2.2) * .14)),
    };
  }));
  const size = VOLUME_SIZE, data = new Uint16Array(size ** 3 * 4);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size - .5, py = (y + .5) / size - .5, pz = (z + .5) / size - .5;
    const index = ((z * size + y) * size + x) * 4;
    const large = noise.noise(px * 10 + seed, py * 10, pz * 10);
    const small = noise.noise(px * 25, py * 25 + seed, pz * 25);
    for (let frame = 0; frame < frames.length; frame++) {
      let distance = 1;
      for (const lobe of frames[frame]) {
        const dx = (px - lobe.x) * lobe.rx, dy = (py - lobe.y) * lobe.ry, dz = (pz - lobe.z) * lobe.rz;
        const d = (Math.sqrt(dx * dx + dy * dy + dz * dz) - 1) * .17;
        const join = Math.max(.018 - Math.abs(distance - d), 0) / .018;
        distance = Math.min(distance, d) - join * join * .0045;
      }
      // Detail travels through the billows as they grow and dissolve, rather
      // than leaving a fixed noise texture painted on a changing silhouette.
      const vapor = noise.noise(px * 16 + seed, py * 16 - frame * .7, pz * 16 + frame * .45);
      data[index + frame] = THREE.DataUtils.toHalfFloat(distance + large * .010 + small * .003 + vapor * .006);
    }
    data[index + 3] = THREE.DataUtils.toHalfFloat(.78 + large * .18);
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.name = `Cloud · evolving vapor volume ${kind + 1}`;
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Ray-marched trade-wind cumulus. Water droplets mostly scatter light; optical depth follows actual path length. */
export function createClouds(environment: EnvironmentLight, quality: QualitySettings) {
  const root = new THREE.Group(); root.name = 'Clouds · evolving trade-wind cumulus';
  const environmentRoot = new THREE.Group(); environmentRoot.name = root.name;
  const steps = uniform(quality.cloudSteps, 'int');
  // Object uniforms are shared by the visible mesh and its environment capture.
  const morph = uniform(new THREE.Vector3()).onObjectUpdate(({ object }) => (object!.userData.cloud as CloudState).morph);
  const flow = uniform(new THREE.Vector3()).onObjectUpdate(({ object }) => (object!.userData.cloud as CloudState).flow);
  const optical = uniform(0).onObjectUpdate(({ object }) => (object!.userData.cloud as CloudState).density);
  const volumes = Array.from({ length: 6 }, (_, i) => bakeCloudVolume(183 + i * 271, i));
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = volumes.map(volume => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    material.name = 'Cloud · transmitted and scattered sunlight / moonlight';
    const sample = (point: TSLNode) => {
      // A slow curl bends individual billows; it does not scale the whole cloud.
      const curl = vec3(point.y.mul(point.z), point.x.mul(point.x).sub(.08), point.x.mul(point.y)).mul(flow);
      const coordinate = point.add(curl);
      const field = texture3D(volume, coordinate.add(.5)).level(float(0));
      // Interpolate distance first, then reconstruct density in the shader.
      // Baking this narrow transition into opacity makes voxel edges visible.
      const distance = dot(field.rgb, morph);
      const vapor = float(1).sub(smoothstep(-.018, .006, distance));
      const billow = field.a.sub(.78).div(.18);
      const base = smoothstep(-.255, -.185, coordinate.y.add(billow.mul(.010)));
      const boundary = max(max(coordinate.x.abs(), coordinate.y.abs()), coordinate.z.abs());
      const border = float(1).sub(smoothstep(.40, .465, boundary));
      return vapor.mul(base).mul(border).mul(field.a).mul(optical);
    };
    material.colorNode = Fn(() => {
      const origin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz);
      const ray = normalize(positionGeometry.sub(origin)).toVar();
      const inverse = mix(vec3(-1), vec3(1), step(0, ray)).div(ray.abs().max(.00001));
      const near = vec3(-.5).sub(origin).mul(inverse), far = vec3(.5).sub(origin).mul(inverse);
      const enter = min(near, far), leave = max(near, far);
      const start = max(max(enter.x, enter.y), enter.z).max(0).toVar();
      const end = min(min(leave.x, leave.y), leave.z).toVar();
      const stride = end.sub(start).max(0).div(float(steps)).toVar();
      const metersPerStep = modelWorldMatrix.mul(vec4(ray, 0)).xyz.length().mul(stride).toVar();
      const sun = normalize(modelWorldMatrixInverse.mul(vec4(environment.sunDirection, 0)).xyz).toVar();
      const moon = normalize(modelWorldMatrixInverse.mul(vec4(environment.moonDirection, 0)).xyz).toVar();
      const sunMeters = modelWorldMatrix.mul(vec4(sun, 0)).xyz.length().toVar();
      const moonMeters = modelWorldMatrix.mul(vec4(moon, 0)).xyz.length().toVar();
      const view = normalize(positionWorld.sub(cameraPosition)).toVar();
      const phase = (source: TSLNode) => dot(view, source).max(0).pow(10).mul(.65).add(.7);
      const sunPhase = phase(vec3(environment.sunDirection)).toVar(), moonPhase = phase(vec3(environment.moonDirection)).toVar();
      const haze = float(1).sub(exp(positionWorld.sub(cameraPosition).length().mul(-.00020))).toVar();
      const backdrop = environment.radiance(view).toVar();
      const fillDirection = normalize(vec3(environment.sunDirection.x, .18, environment.sunDirection.z));
      const skyFill = environment.radiance(fillDirection).mul(.13).toVar();
      const scattered = vec3(0).toVar(), transmission = float(1).toVar();

      const illumination = (point: TSLNode, source: TSLNode, meters: TSLNode, radiance: TSLNode, scattering: TSLNode) => {
        // The density seen by light is exactly the density seen by the eye,
        // including morphing, deformation and evaporation at the field boundary.
        const depth = sample(point.add(source.mul(.035))).mul(.055)
          .add(sample(point.add(source.mul(.10))).mul(.085))
          .add(sample(point.add(source.mul(.21))).mul(.14))
          .add(sample(point.add(source.mul(.38))).mul(.22))
          .add(sample(point.add(source.mul(.65))).mul(.30)).mul(meters);
        const single = exp(depth.negate()).mul(scattering);
        const multiple = exp(depth.mul(-.28)).mul(.30);
        return radiance.mul(single.add(multiple)).mul(.36);
      };
      Loop(steps, ({ i }) => {
        const point = origin.add(ray.mul(start.add(float(i).add(.5).mul(stride)))).toVar();
        const extinction = sample(point).toVar();
        If(extinction.greaterThan(.000001), () => {
          const ambient = mix(environment.horizon.mul(.32), environment.zenith.mul(.60).add(environment.horizon.mul(.22)), point.y.add(.5)).add(skyFill).toVar();
          If(environment.sunLit.greaterThan(0), () => {
            ambient.addAssign(illumination(point, sun, sunMeters, vec3(environment.solarRadiance), sunPhase));
          });
          If(environment.moonLit.greaterThan(0), () => {
            ambient.addAssign(illumination(point, moon, moonMeters, vec3(environment.lunarRadiance), moonPhase));
          });
          const opacity = float(1).sub(exp(extinction.mul(metersPerStep).negate())).toVar();
          scattered.addAssign(mix(ambient, backdrop, haze).mul(opacity).mul(transmission));
          transmission.mulAssign(float(1).sub(opacity));
          If(transmission.lessThan(.008), () => { Break(); });
        });
      });
      const alpha = float(1).sub(transmission);
      return vec4(scattered.div(alpha.max(.0001)), alpha);
    })();
    return material;
  });

  const random = seededRandom(5927);
  const clouds: { mesh: THREE.Mesh; reflection: THREE.Mesh; state: CloudState }[] = [];
  // A continuous size distribution favors medium clouds with occasional large
  // banks. No cloud has a fixed role; growth and evaporation change the mix.
  for (let index = 0; index < 44; index++) {
    // Stratify azimuth, then jitter it: chance alone leaves conspicuous empty
    // sectors, while rings or equal spacing look arranged from the beach.
    const angle = index * 2.399963229728653 + (random() - .5) * .9;
    const overhead = index < 7, distant = !overhead && index % 4 === 0;
    const radius = overhead ? 150 + random() * 650 : distant ? 1300 + random() * 750 : 650 + Math.sqrt(random()) * 800;
    const altitude = overhead ? 500 + random() * 180 : distant ? 180 + random() * 190 : 240 + random() * 250;
    const centerX = Math.cos(angle) * radius, centerZ = Math.sin(angle) * radius;
    const width = 150 + random() ** 2.3 * 560;
    let x = centerX + (random() - .5) * (width + 180);
    let z = centerZ + (random() - .5) * (width + 140);
    const height = altitude + (random() - .5) * 55;
    // Avoid overlapping silhouettes at formation. Subsequent wind and growth
    // remain independent, so the field can still gather and disperse naturally.
    const candidate = new THREE.Vector3(x, height, z);
    const footprint = Math.atan(width * .42 / candidate.length());
    for (let attempt = 0; attempt < 16; attempt++) {
      const overlaps = clouds.some(cloud => candidate.angleTo(cloud.mesh.position)
        < footprint + Math.atan(cloud.state.size.x * .42 / cloud.mesh.position.length()));
      if (!overlaps) break;
      const bearing = Math.atan2(candidate.z, candidate.x) + .23;
      const distance = Math.hypot(x, z);
      candidate.set(Math.cos(bearing) * distance, height, Math.sin(bearing) * distance);
    }
    x = candidate.x; z = candidate.z;
    const state: CloudState = {
      // A steady trade wind carries lower clouds across the view within minutes;
      // higher layers move faster, so the sky has visible depth and shear.
      x, z, speed: 3.2 + height * .003 + random() * 1.4,
      phase: random() * Math.PI * 2, evolution: .026 + random() * .022,
      extinction: (.016 + random() * .012) * (1 - THREE.MathUtils.smoothstep(width, 300, 700) * .35),
      morph: new THREE.Vector3(), flow: new THREE.Vector3(), size: new THREE.Vector3(), density: 0,
    };
    const mesh = new THREE.Mesh(geometry, materials[Math.floor(random() * materials.length)]);
    mesh.name = `Trade-wind cloud ${clouds.length + 1}`;
    mesh.position.set(x, height, z);
    state.size.set(width, width * (.43 + random() * .12), width * (.74 + random() * .18));
    mesh.scale.copy(state.size);
    mesh.rotation.y = -Math.atan2(z, x) - Math.PI / 2 + (random() - .5) * .65;
    mesh.renderOrder = -98;
    mesh.userData.cloud = state;
    const reflection = mesh.clone();
    reflection.userData.cloud = state;
    root.add(mesh); environmentRoot.add(reflection);
    clouds.push({ mesh, reflection, state });
  }
  let elapsed = 0;
  function update(dt: number, motion = true) {
    if (motion) elapsed += dt;
    for (const { mesh, reflection, state } of clouds) {
      const t = elapsed * state.evolution + state.phase;
      const a = Math.max(0, Math.cos(t) + .5) ** 2;
      const b = Math.max(0, Math.cos(t + Math.PI * 2 / 3) + .5) ** 2;
      const c = Math.max(0, Math.cos(t + Math.PI * 4 / 3) + .5) ** 2;
      const total = a + b + c;
      state.morph.set(a / total, b / total, c / total);
      state.flow.set(Math.sin(t * 1.3) * .24, Math.cos(t * .9 + 2) * .28, Math.sin(t * 1.1 + 4) * .22);
      // Growth is slower than billowing, and differs along each axis.
      mesh.scale.set(
        state.size.x * (.92 + .16 * Math.sin(t * .40 + state.phase)),
        state.size.y * (.94 + .12 * Math.sin(t * .53 + 2)),
        state.size.z * (.93 + .11 * Math.sin(t * .35 + 1)),
      );
      mesh.position.x = wrap(state.x + elapsed * state.speed);
      mesh.position.z = wrap(state.z + elapsed * state.speed * .38);
      // Evaporate before wrapping; new vapor condenses beyond the opposite edge.
      const edge = Math.max(Math.abs(mesh.position.x), Math.abs(mesh.position.z));
      const fade = 1 - THREE.MathUtils.smoothstep(edge, FIELD_RADIUS - 350, FIELD_RADIUS - 80);
      const life = THREE.MathUtils.smoothstep(Math.sin(t * .30 + state.phase), -.98, -.55);
      state.density = state.extinction * fade * life * (.92 + .08 * Math.sin(t * .7));
      mesh.visible = reflection.visible = fade * life > .001;
      reflection.position.copy(mesh.position);
      reflection.scale.copy(mesh.scale);
    }
  }
  update(0);
  return {
    root, environmentRoot, update,
    setQuality(quality: QualitySettings) { steps.value = quality.cloudSteps; },
  };
}
