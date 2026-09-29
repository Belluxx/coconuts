import * as THREE from 'three/webgpu';
import { attribute, color, dFdx, dFdy, float, mix, normalWorld, positionWorld, sin, smoothstep, vec3 } from 'three/tsl';
import { reliefNormal, surfaceNoise3D } from '../shading';

/** Timber, rope, thatch and fittings shared by every structure built with PartBuilder. */
export function createTimberMaterials() {
  // Grain coordinates are in meters in each untransformed piece of timber.
  // They survive batching, so grain follows rafters, braces and decking alike.
  const grain = attribute('grain', 'vec3');
  const tint = attribute('color', 'vec3');
  const noise = surfaceNoise3D(grain.mul(vec3(.58, 9, 9)));
  const rings = grain.yz.add(noise.mul(.026)).length().mul(255).add(noise.mul(3));
  const footprint = dFdx(rings).abs().add(dFdy(rings).abs());
  const filteredRings = sin(rings).mul(float(1).sub(smoothstep(.65, 3, footprint)));
  const pores = surfaceNoise3D(grain.mul(vec3(3, 145, 145)));
  const weather = surfaceNoise3D(grain.mul(vec3(.34, 2.1, 2.1))).mul(.5).add(.5);
  const pigment = filteredRings.mul(.052).add(noise.mul(.11)).add(pores.mul(.025)).add(.6).clamp();
  // Sub-millimeter relief, including end grain, without a texture atlas.
  const woodNormal = reliefNormal(filteredRings.mul(.00038).add(pores.mul(.00018)));

  const wood = (name: string, dark: string, light: string, silver: number) => {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: .83 });
    material.name = name;
    material.colorNode = mix(mix(color(dark), color(light), pigment), color('#d5b887'), weather.mul(silver))
      .mul(tint).mul(normalWorld.y.mul(.045).add(.955));
    material.roughnessNode = weather.mul(.14).add(.75);
    material.normalNode = woodNormal;
    return material;
  };
  const deck = wood('Timber · sun-warmed honey teak', '#a2713e', '#e0b57a', .16);
  const frame = wood('Timber · golden structural hardwood', '#81552f', '#cba16a', .09);
  const endgrain = wood('Timber · exposed end grain', '#976b3b', '#e0c18f', .12);

  // Piles darken and grow algae below the tide line.
  const piles = wood('Timber · tidal hardwood piles', '#795932', '#cca570', .15);
  const tideNoise = surfaceNoise3D(positionWorld.mul(vec3(8, 2, 8))).mul(.11);
  const wet = float(1).sub(smoothstep(-.22, .38, positionWorld.y.add(tideNoise)));
  const algae = float(1).sub(smoothstep(-.32, .06, positionWorld.y.add(tideNoise)))
    .mul(smoothstep(-1.1, -.38, positionWorld.y));
  piles.colorNode = mix(mix(piles.colorNode!, color('#3e3c2a').mul(tint), wet.mul(.62)), color('#525b39').mul(tint), algae.mul(.3));
  piles.roughnessNode = mix(float(.87), float(.53), wet);

  const rope = new THREE.MeshStandardNodeMaterial({ roughness: .96 });
  rope.name = 'Timber · laid natural-fiber rope';
  rope.colorNode = color('#dcc699').mul(tint).mul(sin(grain.x.mul(185).add(grain.y.mul(19))).mul(.055).add(.94));

  const thatch = new THREE.MeshStandardNodeMaterial({ roughness: .98, side: THREE.DoubleSide });
  thatch.name = 'Timber · layered palm thatch';
  const fiber = surfaceNoise3D(grain.mul(vec3(.7, 90, 90))).mul(.1).add(.92);
  thatch.colorNode = mix(color('#b28b49'), color('#edd08a'), tint.r.mul(.72).add(.19)).mul(fiber);
  const thatchEdge = thatch.clone();
  thatchEdge.name = 'Timber · thatch cut ends';
  thatchEdge.colorNode = color('#cfaa66').mul(tint);

  const metal = new THREE.MeshStandardNodeMaterial({ roughness: .39, metalness: .78 });
  metal.name = 'Timber · aged galvanized fittings';
  metal.colorNode = color('#73807c').mul(tint);
  return { deck, frame, endgrain, piles, rope, thatch, thatchEdge, metal };
}

export type TimberMaterials = ReturnType<typeof createTimberMaterials>;
