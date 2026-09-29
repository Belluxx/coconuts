import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRockGeometry } from '../land/rocks';
import { seededRandom } from '../math';

/** The distant shore uses the same broken stone silhouettes as the island. */
export function createDistantIslands() {
  const random = seededRandom(317), parts: THREE.BufferGeometry[] = [];
  const stone = new THREE.Color('#789da5'), crown = new THREE.Color('#649578');
  for (let island = 0; island < 8; island++) {
    const x = -520 + island * 145 + random() * 28, z = -430 - random() * 180;
    const width = 12 + random() * 15, height = 22 + random() * 24;
    const count = 3 + Math.floor(random() * 3);
    for (let part = 0; part < count; part++) {
      const offset = (part - (count - 1) * .5) * width * .73;
      const prominence = 1 - Math.abs(part - (count - 1) * .5) / count;
      const sy = height * prominence * (.55 + random() * .45);
      const geometry = createRockGeometry(6731 + island * 119 + part * 31, part === 1 ? 'cliff' : 'boulder', 'near');
      const normals = geometry.getAttribute('normal'), points = geometry.getAttribute('position');
      const colors: number[] = [];
      for (let i = 0; i < points.count; i++) {
        const cover = THREE.MathUtils.smoothstep(normals.getY(i), .3, .88)
          * THREE.MathUtils.smoothstep(points.getY(i), -.45, .55);
        const tint = stone.clone().lerp(crown, cover).multiplyScalar(.94 + random() * .06);
        colors.push(tint.r, tint.g, tint.b);
      }
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.deleteAttribute('rockCrease'); geometry.deleteAttribute('rockFoot');
      geometry.scale(width * (.65 + random() * .25), sy, width * (.55 + random() * .18));
      geometry.rotateY(random() * .8);
      geometry.translate(x + offset, sy * .04 - 3.2, z + random() * 12);
      parts.push(geometry);
    }
  }
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Distant islands · fractured headlands and planted crowns';
  return mesh;
}
