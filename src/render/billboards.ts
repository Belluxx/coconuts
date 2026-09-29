import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three/webgpu';

const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * One quad per particle for shader-animated billboards. All four corners carry
 * the particle's attributes, including its center as `position`; the vertex
 * shader spreads them apart using `uv`.
 */
export function billboardGeometry(count: number, particle: (index: number) => Record<string, number[]>) {
  const attributes = new Map<string, number[]>(), uvs: number[] = [], indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const values = Object.entries(particle(i));
    for (const [u, v] of CORNERS) {
      for (const [name, value] of values) {
        if (!attributes.has(name)) attributes.set(name, []);
        attributes.get(name)!.push(...value);
      }
      uvs.push(u, v);
    }
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geometry = new BufferGeometry();
  for (const [name, data] of attributes) geometry.setAttribute(name, new Float32BufferAttribute(data, data.length / (count * 4)));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // The unlit billboard materials ignore normals; a constant one completes the layout.
  const normals = new Float32Array(count * 12);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}
