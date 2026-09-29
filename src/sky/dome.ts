import * as THREE from 'three/webgpu';
import { asin, atan, attribute, cameraPosition, color, dot, exp, float, normalize, positionLocal, positionWorld, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { DEG } from '../math';
import type { SkyPosition } from './celestial';
import type { EnvironmentLight } from './light';

// Enlarge the visible discs for the beach view; astronomy uses their centers.
const SUN_RADIUS = .38 * DEG;
const MOON_RADIUS = .40 * DEG;
const MILKY_WAY_STRENGTH = .40; // Brightness multiplier; 0 hides the Milky Way.

/** Actual catalog directions, with magnitude-sized soft discs and B-V colors. */
function starGeometry(stars: number[][]) {
  const positions: number[] = [], colors: number[] = [], coords: number[] = [], magnitudes: number[] = [];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  for (const [hours, declination, magnitude, bv] of stars) {
    const ra = hours * Math.PI / 12, dec = declination * DEG;
    const center = new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
    const right = new THREE.Vector3(-Math.sin(ra), Math.cos(ra), 0);
    const up = new THREE.Vector3().crossVectors(center, right);
    const radius = (.055 + Math.max(0, 5 - magnitude) * .010) * DEG;
    const tint = new THREE.Color('#c3d7ff').lerp(new THREE.Color('#fff4df'), THREE.MathUtils.clamp((bv + .25) / 1.15, 0, 1));
    if (bv > .9) tint.lerp(new THREE.Color('#ffd1a0'), Math.min(1, (bv - .9) / 1.1));
    const brightness = Math.min(12, .85 * 10 ** (.27 * (6.5 - magnitude)));
    for (const [x, y] of corners) {
      const vertex = center.clone().addScaledVector(right, x * radius).addScaledVector(up, y * radius).normalize().multiplyScalar(2150);
      positions.push(vertex.x, vertex.y, vertex.z);
      colors.push(tint.r * brightness, tint.g * brightness, tint.b * brightness);
      coords.push((x + 1) / 2, (y + 1) / 2); magnitudes.push(magnitude);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map(value => value / 2150), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  geometry.setAttribute('magnitude', new THREE.Float32BufferAttribute(magnitudes, 1));
  return geometry;
}

/** Sky radiance, sun and moon discs, the HYG star catalog, and the Milky Way. */
export async function createSkyDome(environment: EnvironmentLight) {
  const [catalog, milkyWay] = await Promise.all([
    fetch('./sky/hyg-stars.json').then(response => {
      if (!response.ok) throw new Error('The bundled HYG star catalog could not be loaded.');
      return response.json() as Promise<{ stars: number[][] }>;
    }),
    new THREE.TextureLoader().loadAsync('./sky/milky-way.webp'),
  ]);
  milkyWay.name = 'NASA / Ernie Wright · Milky Way, J2000';
  milkyWay.colorSpace = THREE.SRGBColorSpace;
  milkyWay.wrapS = THREE.RepeatWrapping;
  const { sunDirection: sun, moonDirection: moon, stars: starsVisible, moonVisibility } = environment;
  const inverseCelestial = uniform(new THREE.Matrix3());
  const starRotation = new THREE.Matrix4();
  const root = new THREE.Group(); root.name = 'Sky · celestial sphere';
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const direction = normalize(positionLocal);
  const sunDot = dot(direction, sun).max(0), moonDot = dot(direction, moon).max(0);
  const atmosphere = environment.radiance(direction);
  const solarDisc = smoothstep(Math.cos(SUN_RADIUS + .025 * DEG), Math.cos(SUN_RADIUS - .025 * DEG), sunDot);
  const sunlight = environment.solarRadiance.mul(solarDisc.mul(12));
  const moonRadius = Math.sin(MOON_RADIUS);
  const moonPlane = direction.sub(moon.mul(moonDot)).div(moonRadius);
  const moonR2 = dot(moonPlane, moonPlane);
  const onMoon = float(1).sub(smoothstep(.90, 1, moonR2)).mul(smoothstep(0, .1, moonDot));
  const moonNormal = moonPlane.sub(moon.mul(float(1).sub(moonR2).max(0).sqrt()));
  const lunarShade = smoothstep(-.035, .06, dot(moonNormal, sun));
  const lunarDisc = color('#e8e5dd').mul(lunarShade.mul(1.6).add(.012)).mul(onMoon).mul(moonVisibility);
  const lunarHalo = environment.lunarRadiance.mul(moonDot.pow(180).mul(.045).add(moonDot.pow(900).mul(.22)));
  // NASA's celestial map is centered at RA 0h, with RA increasing leftward.
  // Texture UV v increases northward after TextureLoader's standard flipY.
  const eq = inverseCelestial.mul(direction);
  const galacticUV = vec2(float(.5).sub(atan(eq.y, eq.x).div(2 * Math.PI)), asin(eq.z.clamp(-1, 1)).div(Math.PI).add(.5));
  const galaxy = texture(milkyWay, galacticUV).rgb.mul(vec3(.56, .65, .85))
    .mul(environment.galaxy).mul(MILKY_WAY_STRENGTH).mul(smoothstep(0, .18, direction.y));
  const diffuseSky = atmosphere.add(lunarHalo);
  const clear = diffuseSky.add(galaxy).mul(float(1).sub(onMoon.mul(moonVisibility)))
    .add(sunlight).add(lunarDisc);
  material.colorNode = clear;
  material.name = 'Marine atmosphere · shared radiance';
  // Direct sources already have lights and water glints. Excluding their tiny
  // discs from the convolution avoids double illumination and PMREM sparkles.
  const environmentMaterial = material.clone();
  environmentMaterial.colorNode = diffuseSky;
  environmentMaterial.name = 'Marine atmosphere · diffuse environment';
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2200, 40, 24), material);
  mesh.name = 'Island sky'; mesh.renderOrder = -100; mesh.frustumCulled = false; root.add(mesh);

  const starMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  starMaterial.name = 'HYG · apparent magnitude and stellar color';
  const starDirection = normalize(positionWorld.sub(cameraPosition));
  const extinction = smoothstep(.005, .22, starDirection.y);
  const disc = exp(uv().sub(.5).length().pow(2).mul(-25)).sub(Math.exp(-6.25)).max(0);
  const reveal = smoothstep(attribute('magnitude', 'float').sub(1.0), attribute('magnitude', 'float').add(.6), starsVisible.mul(8));
  const moonMask = float(1).sub(smoothstep(Math.cos(MOON_RADIUS), Math.cos(MOON_RADIUS * .95), dot(starDirection, moon)));
  starMaterial.colorNode = attribute('color', 'vec3');
  starMaterial.opacityNode = disc.mul(reveal).mul(starsVisible).mul(extinction).mul(moonMask);
  const stars = new THREE.Mesh(starGeometry(catalog.stars), starMaterial);
  stars.name = `HYG v4.1 · ${catalog.stars.length} stars`; stars.renderOrder = -99; stars.frustumCulled = false; root.add(stars);

  return {
    root, environmentMesh: new THREE.Mesh(mesh.geometry, environmentMaterial),
    setSky(position: SkyPosition) {
      stars.setRotationFromMatrix(starRotation.setFromMatrix3(position.equatorialToWorld));
      inverseCelestial.value.copy(position.equatorialToWorld).transpose();
    },
    /** The sky is infinitely far away: it travels with the viewer. */
    update(camera: THREE.Camera) { root.position.copy(camera.position); },
  };
}
