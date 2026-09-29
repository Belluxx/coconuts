import * as THREE from 'three/webgpu';
import { cameraPosition, dFdx, dFdy, densityFogFactor, dot, float, fog, normalize, positionWorld, texture, vec2 } from 'three/tsl';
import type { QualitySettings } from '../quality';
import type { TSLNode } from '../shading';
import { NORTH, type SkyPosition } from './celestial';
import { createClouds } from './clouds';
import { createDistantIslands } from './distantIslands';
import { createSkyDome } from './dome';
import { createEnvironmentLight, type EnvironmentLight } from './light';

/** Radius of the shadow blur in shadow-map UV: about 18 cm across the island's 200 m shadow frustum. */
const SOFTNESS = .0009;
/** A Vogel spiral fills the blur disc evenly with few taps. */
const DISC = Array.from({ length: 16 }, (_, i) => {
  const radius = Math.sqrt((i + .5) / 16) * SOFTNESS, angle = i * 2.39996;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
});

/**
 * Wide, soft shadows: sixteen bilinear depth comparisons spread over a disc.
 * A wide filter on sloping ground would compare distant taps against the
 * wrong depth, so each tap follows the receiver's plane through the map.
 */
function softShadow({ depthTexture, shadowCoord }: { depthTexture: THREE.DepthTexture; shadowCoord: TSLNode }) {
  // Hardware filtering blends each comparison over its four nearest texels.
  depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter;
  const dx = dFdx(shadowCoord.xyz), dy = dFdy(shadowCoord.xyz);
  const determinant = dx.x.mul(dy.y).sub(dy.x.mul(dx.y));
  const safe = determinant.abs().lessThan(1e-14).select(float(1e-14), determinant);
  const plane = vec2(dy.y.mul(dx.z).sub(dx.y.mul(dy.z)), dx.x.mul(dy.z).sub(dy.x.mul(dx.z))).div(safe).clamp(-2, 2);
  let lit: TSLNode = float(0);
  for (const [u, v] of DISC) {
    const offset = vec2(u, v);
    lit = lit.add(texture(depthTexture, shadowCoord.xy.add(offset)).compare(shadowCoord.z.add(dot(offset, plane))));
  }
  return lit.div(DISC.length);
}

/** Sun, moon and scattered sky light coexist throughout the whole day. */
export async function createAtmosphere(scene: THREE.Scene, quality: QualitySettings) {
  const environment = createEnvironmentLight();
  const sky = await createSkyDome(environment);
  const clouds = createClouds(environment, quality);
  sky.root.add(clouds.root);
  sky.environmentMesh.add(clouds.environmentRoot);
  scene.add(sky.root);

  const directional = (name: string, size: number, lit: EnvironmentLight['sunLit']) => {
    const source = new THREE.DirectionalLight(0xffffff, 1);
    source.name = name;
    source.castShadow = true;
    source.shadow.mapSize.set(size, size);
    source.shadow.autoUpdate = false;
    // A source below the horizon skips its sixteen soft-shadow taps in every
    // material. The branch is on a uniform, so no shader variant is compiled.
    Object.assign(source.shadow, { filterNode: (inputs: Parameters<typeof softShadow>[0]) => lit.greaterThan(0).select(softShadow(inputs), float(1)) });
    source.shadow.camera.layers.set(2);
    Object.assign(source.shadow.camera, { left: -100, right: 100, top: 85, bottom: -80, near: 10, far: 360 });
    source.shadow.normalBias = .045; source.shadow.bias = -.00015;
    source.shadow.camera.up.copy(NORTH);
    source.target.position.set(0, 0, 5);
    scene.add(source, source.target);
    return source;
  };
  const sun = directional('Sun · transmitted daylight', quality.shadowSize, environment.sunLit);
  const moon = directional('Moon · phase-dependent silver light', Math.min(quality.shadowSize, 2048), environment.moonLit);
  // Distant objects disappear into the same directional sky as their backdrop.
  scene.fogNode = fog(environment.radiance(normalize(positionWorld.sub(cameraPosition))), densityFogFactor(environment.haze));
  const distantIslands = createDistantIslands();
  scene.add(distantIslands);
  let previousTime = 0;
  const shadowFocus = new THREE.Vector3(), viewDirection = new THREE.Vector3();
  const shadowRight = new THREE.Vector3(), shadowUp = new THREE.Vector3();
  const shadowSources = [[sun, environment.sunDirection.value], [moon, environment.moonDirection.value]] as const;

  function frameUnderwaterShadows(camera: THREE.Camera, surfaceHeight: number) {
    // Underwater visibility is much shorter than the island panorama. Spend
    // shadow texels on the nearby reef, with a smooth transition at the surface.
    const immersion = THREE.MathUtils.smoothstep(surfaceHeight - camera.position.y, .1, 1.2);
    camera.getWorldDirection(viewDirection);
    shadowFocus.copy(camera.position).addScaledVector(viewDirection, 12);
    for (const [source, direction] of shadowSources) {
      const shadowCamera = source.shadow.camera;
      shadowCamera.left = THREE.MathUtils.lerp(-100, -38, immersion);
      shadowCamera.right = THREE.MathUtils.lerp(100, 38, immersion);
      shadowCamera.top = THREE.MathUtils.lerp(85, 38, immersion);
      shadowCamera.bottom = THREE.MathUtils.lerp(-80, -38, immersion);
      shadowCamera.updateProjectionMatrix();
      source.shadow.normalBias = THREE.MathUtils.lerp(.045, .018, immersion);
      source.target.position.set(0, 0, 5).lerp(shadowFocus, immersion);
      if (immersion > 0) {
        // A stationary shadow grid keeps the fine coral shadows from crawling
        // as the swimmer moves. Keep the light's depth axis unconstrained.
        shadowRight.crossVectors(NORTH, direction).normalize();
        shadowUp.crossVectors(direction, shadowRight).normalize();
        const texelX = (shadowCamera.right - shadowCamera.left) / source.shadow.mapSize.x;
        const texelY = (shadowCamera.top - shadowCamera.bottom) / source.shadow.mapSize.y;
        const x = source.target.position.dot(shadowRight), y = source.target.position.dot(shadowUp);
        source.target.position.addScaledVector(shadowRight, Math.round(x / texelX) * texelX - x);
        source.target.position.addScaledVector(shadowUp, Math.round(y / texelY) * texelY - y);
      }
      source.position.copy(source.target.position).addScaledVector(direction, 180);
    }
  }

  function resizeShadow(source: THREE.DirectionalLight, size: number) {
    if (source.shadow.mapSize.x === size) return;
    source.shadow.mapSize.set(size, size);
    source.shadow.needsUpdate = true;
  }

  return {
    sun, moon, environment, distantIslands,
    light: environment.light,
    /** Sky without the sun and moon discs, for the environment-map capture. */
    environmentMesh: sky.environmentMesh,
    setQuality(quality: QualitySettings) {
      clouds.setQuality(quality);
      resizeShadow(sun, quality.shadowSize);
      resizeShadow(moon, Math.min(quality.shadowSize, 2048));
    },
    setSky(position: SkyPosition) {
      environment.update(position);
      sky.setSky(position);
      sun.position.copy(sun.target.position).addScaledVector(position.sun, 180);
      moon.position.copy(moon.target.position).addScaledVector(position.moon, 180);
      sun.color.copy(environment.solarRadiance.value);
      moon.color.copy(environment.lunarRadiance.value);
    },
    updateShadows(prepare = false) {
      // Warm both maps before sampling, even when a source is below the horizon.
      // After that, only sources lighting the island need a redraw.
      sun.shadow.needsUpdate = prepare || environment.sunLit.value > 0;
      moon.shadow.needsUpdate = prepare || environment.moonLit.value > 0;
    },
    update(seconds: number, camera: THREE.Camera, motion: boolean, surfaceHeight: number) {
      sky.update(camera);
      frameUnderwaterShadows(camera, surfaceHeight);
      clouds.update(Math.max(0, seconds - previousTime), motion);
      previousTime = seconds;
    },
  };
}

export type Atmosphere = Awaited<ReturnType<typeof createAtmosphere>>;
