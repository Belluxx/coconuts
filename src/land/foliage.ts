import * as THREE from 'three/webgpu';
import {
  attribute, dFdx, dFdy, diffuseColor, faceDirection, float, mix,
  positionLocal, sin, smoothstep, time, textureLoad, ivec2, vec2, vec3,
} from 'three/tsl';
import { V } from '../math';
import { reliefNormal, surfaceNoise } from '../shading';

const UP = V(0, 1, 0);
/** Crown sway, frond swing and leaf flutter weights of a vertex. */
export type Wind = [number, number, number];
export type LeafShape = 'almond' | 'mango' | 'grape' | 'fern' | 'grass' | 'heart' | 'cordyline';

/** Every vertex retains its plant's root and three independent movement weights. */
export class FoliageSurface {
  positions: number[] = [];
  colors: number[] = [];
  uvs: number[] = [];
  winds: number[] = [];
  anchors: number[] = [];
  plantIndices: number[] = [];
  plantIndex = 0;
  surfaces: number[] = [];
  indices: number[] = [];
  anchor = V();
  vertex(p: THREE.Vector3, c: THREE.Color, wind: Wind = [0, 0, 0], u = 0, v = 0, surface = 0) {
    const i = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(c.r, c.g, c.b);
    this.uvs.push(u, v);
    this.winds.push(...wind);
    this.anchors.push(this.anchor.x, this.anchor.y, this.anchor.z);
    this.surfaces.push(surface);
    this.plantIndices.push(this.plantIndex);
    return i;
  }
  quad(a: number, b: number, c: number, d: number) { this.indices.push(a, b, d, b, c, d); }
  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    // This Three WebGPU backend promotes 16-bit integer indices on upload.
    // Store the final format now so recorded resident memory stays accurate.
    geometry.setIndex(new THREE.Uint32BufferAttribute(this.indices, 1));
    geometry.computeVertexNormals();
    // Collapsed blade tips have zero-area adjacent faces; copy the neighboring
    // normal so even tip vertices have a usable shading frame.
    const normals = geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) if (Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) < .1) {
      let j = Math.max(0, i - 3);
      if (Math.hypot(normals.getX(j), normals.getY(j), normals.getZ(j)) < .1) j = Math.min(normals.count - 1, i + 3);
      const replacement = V(normals.getX(j), normals.getY(j), normals.getZ(j));
      if (replacement.lengthSq() < .01) replacement.set(0, 1, 0);
      replacement.normalize();
      normals.setXYZ(i, replacement.x, replacement.y, replacement.z);
    }
    // GPU-supported packed formats keep dense foliage resident without full
    // float attributes for color, UVs or slowly varying wind parameters.
    const packedColor = new Uint8Array(normals.count * 4), packedNormal = new Int16Array(normals.count * 4);
    const packedWind = new Uint16Array(normals.count * 4);
    const packedUV = new THREE.Uint16BufferAttribute(new Uint16Array(normals.count * 2), 2, true);
    const packedAnchor = new THREE.Int16BufferAttribute(new Int16Array(normals.count * 4), 4, true);
    for (let i = 0; i < normals.count; i++) {
      for (let j = 0; j < 3; j++) {
        packedColor[i * 4 + j] = Math.round(THREE.MathUtils.clamp(this.colors[i * 3 + j], 0, 1) * 255);
        packedNormal[i * 4 + j] = Math.round(normals.array[i * 3 + j] * 32767);
        packedWind[i * 4 + j] = Math.round(THREE.MathUtils.clamp(this.winds[i * 3 + j] / (j === 0 ? 1.25 : 1), 0, 1) * 65535);
      }
      packedColor[i * 4 + 3] = this.surfaces[i] * 255;
      packedUV.setXY(i, this.uvs[i * 2] / 4, this.uvs[i * 2 + 1] / 32);
      packedAnchor.setXYZW(i, this.anchors[i * 3] / 128, this.anchors[i * 3 + 1] / 128, this.anchors[i * 3 + 2] / 8, this.plantIndices[i] / 32767);
    }
    geometry.setAttribute('color', new THREE.Uint8BufferAttribute(packedColor, 4, true));
    geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(packedNormal, 4), 3, 0, true));
    geometry.setAttribute('wind', new THREE.Uint16BufferAttribute(packedWind, 4, true));
    geometry.setAttribute('uv', packedUV);
    geometry.setAttribute('windAnchor', packedAnchor);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    // Bounds include compound gusts and the extra bend from brushing past.
    geometry.boundingBox?.expandByScalar(1.35);
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 1.35;
    return geometry;
  }
}

/** Tapered ring geometry, with continuous frames and closed ends. */
export function stem(surface: FoliageSurface, points: THREE.Vector3[], radius: number, tipRadius: number,
  tint: THREE.Color, sides = 7, weights: Wind[] = points.map(() => [0, 0, 0])) {
  const rings: number[][] = [];
  let distance = 0;
  const firstTangent = points[1].clone().sub(points[0]).normalize();
  const axis = Math.abs(firstTangent.y) > .93 ? V(1, 0, 0) : UP;
  const reference = firstTangent.clone().cross(axis).normalize();
  for (let j = 0; j < points.length; j++) {
    if (j) distance += points[j].distanceTo(points[j - 1]);
    const tangent = points[Math.min(j + 1, points.length - 1)].clone().sub(points[Math.max(0, j - 1)]).normalize();
    const right = reference.clone().addScaledVector(tangent, -reference.dot(tangent)).normalize();
    const normal = right.clone().cross(tangent).normalize();
    const t = j / (points.length - 1);
    const foot = 1 + Math.exp(-t * 22) * .24;
    const r = THREE.MathUtils.lerp(radius, tipRadius, t) * foot;
    const row: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = k / sides * Math.PI * 2;
      const irregular = 1 + Math.sin(a * 3 + t * 8) * .028;
      const p = points[j].clone().addScaledVector(right, Math.cos(a) * r * irregular).addScaledVector(normal, Math.sin(a) * r * irregular);
      row.push(surface.vertex(p, tint, weights[j], k / sides * Math.PI * 2 * radius, distance));
    }
    if (j) for (let k = 0; k < sides; k++) surface.quad(rings[j - 1][k], row[k], row[k + 1], rings[j - 1][k + 1]);
    rings.push(row);
  }
  for (const j of [0, points.length - 1]) {
    const center = surface.vertex(points[j], tint, weights[j], 0, distance);
    for (let k = 0; k < sides; k++) {
      if (j === 0) surface.indices.push(center, rings[j][k], rings[j][k + 1]);
      else surface.indices.push(center, rings[j][k + 1], rings[j][k]);
    }
  }
}

/** Folded, curved blades with a raised midrib and separately shaded margins. */
export function leaf(surface: FoliageSurface, origin: THREE.Vector3, direction: THREE.Vector3,
  length: number, width: number, droop: number, tint: THREE.Color, shape: LeafShape,
  baseWind: Wind, segments = 5, roll = 0) {
  const forward = direction.clone().normalize();
  const right = forward.clone().cross(UP).normalize();
  if (right.lengthSq() < .01) right.set(1, 0, 0);
  right.applyAxisAngle(forward, roll);
  const normal = right.clone().cross(forward).normalize();
  let previous: number[] | undefined;
  const centerTint = tint.clone().lerp(new THREE.Color('#c5db48'), .18);
  const tipTint = tint.clone().lerp(new THREE.Color('#c4d839'), .08);
  const shadeTint = tint.clone().multiplyScalar(.78);
  const acrossSegments = shape === 'heart' ? 4 : 2;
  for (let j = 0; j <= segments; j++) {
    const t = j / segments;
    let profile = Math.pow(Math.max(0, Math.sin(t * Math.PI)), shape === 'grape' || shape === 'heart' ? .48 : shape === 'grass' ? .92 : .68);
    if (shape === 'almond') profile *= .68 + t * .57;
    if (shape === 'heart') profile *= 1.35 - t * .85;
    if (shape === 'cordyline') profile *= 1.16 - t * .28;
    const half = profile * width;
    const point = origin.clone().addScaledVector(forward, length * t).addScaledVector(normal, Math.sin(t * Math.PI) * length * .065);
    point.y -= droop * t * t;
    const wind: Wind = [baseWind[0], baseWind[1], baseWind[2] + t * t * Math.min(length, 1.4) * .55];
    const row: number[] = [];
    // Blade tips are single vertices, removing four near-zero-area triangles
    // per leaf without changing the silhouette or curved central ridge.
    const tip = j === 0 || j === segments;
    for (let k = tip ? acrossSegments / 2 : 0; k <= (tip ? acrossSegments / 2 : acrossSegments); k++) {
      const across = k / acrossSegments * 2 - 1, edge = k === 0 || k === acrossSegments;
      const p = point.clone().addScaledVector(right, across * half);
      p.addScaledVector(normal, half * (.15 * (1 - across * across) - across * across * (.11 + .1 * Math.sin(t * 5 + roll))));
      if (shape === 'heart' && edge) p.addScaledVector(forward, -length * .25 * profile * (1 - t) ** 3);
      const col = j === segments ? tipTint : k === 0 ? shadeTint : k === acrossSegments ? tint : centerTint;
      row.push(surface.vertex(p, col, wind, k / acrossSegments, t, shape === 'grass' ? 1 : 0));
    }
    if (previous) {
      for (let k = 0; k < acrossSegments; k++) {
        if (previous.length === 1) surface.indices.push(previous[0], row[k + 1], row[k]);
        else if (row.length === 1) surface.indices.push(previous[k], previous[k + 1], row[0]);
        else surface.quad(previous[k], previous[k + 1], row[k + 1], row[k]);
      }
    }
    previous = row;
  }
}

/** A continuous web and individually cut lobes make real slits in the silhouette. */
export function splitBlade(surface: FoliageSurface, point: (t: number) => THREE.Vector3,
  side: THREE.Vector3, length: number, width: number, tint: THREE.Color, lobes: number,
  wind: (t: number) => Wind, options: { heart?: boolean; perforated?: boolean; fold?: number; slit?: number } = {}) {
  const normal = side.clone().cross(point(.51).sub(point(.49))).normalize();
  if (normal.y < 0) normal.negate();
  const shape = (t: number) => Math.max(0, Math.sin(Math.PI * t)) ** (options.heart ? .54 : .7) * (options.heart ? 1.2 - t * .45 : .94 + t * .08);
  const edgeTint = tint.clone().multiplyScalar(.79);
  const sunTint = tint.clone().lerp(new THREE.Color('#c4df30'), .14);
  const ribTint = tint.clone().lerp(new THREE.Color('#d0df63'), .3);
  const web = options.heart ? .16 : .11;
  const fold = options.fold ?? .17;
  const bladePoint = (t: number, across: number) => {
    const half = width * shape(t), p = point(t).addScaledVector(side, across * half);
    p.addScaledVector(normal, half * (fold * (1 - Math.abs(across)) - .07 * across * across));
    return p;
  };
  const centerRows: number[][] = [];
  for (let j = 0; j <= lobes * 2; j++) {
    const t = j / (lobes * 2), row: number[] = [];
    for (const across of [-web, 0, web]) row.push(surface.vertex(bladePoint(t, across), across === 0 ? ribTint : tint, wind(t), across * .5 + .5, t));
    if (j) for (let k = 0; k < 2; k++) surface.quad(centerRows[j - 1][k], centerRows[j - 1][k + 1], row[k + 1], row[k]);
    centerRows.push(row);
  }
  for (const sign of [-1, 1]) for (let l = 0; l < lobes; l++) {
    const start = l / lobes, stop = (l + 1) / lobes, rows: number[][] = [];
    const fractions = options.perforated ? [web, .31, .56, .78, 1] : [web, .5, 1];
    for (let j = 0; j <= 3; j++) {
      const f = j / 3, row: number[] = [];
      for (let k = 0; k < fractions.length; k++) {
        const across = fractions[k], outer = (across - web) / (1 - web);
        // A narrow V opens toward the outside; the two halves are staggered.
        const slit = (options.slit ?? .19) * outer * (1 - f) / lobes;
        const t = Math.min(.999, Math.max(.001, start + (stop - start) * f + slit + sign * .008 * outer));
        const p = bladePoint(t, across * sign);
        p.addScaledVector(normal, Math.sin(f * Math.PI) * length * .008 * outer);
        const col = k === 0 ? tint : sign < 0 ? edgeTint : sunTint;
        row.push(surface.vertex(p, col, wind(t), across * sign * .5 + .5, t));
      }
      if (j) for (let k = 0; k < fractions.length - 1; k++) {
        if (options.perforated && l > 0 && l < lobes - 1 && l % 2 === 0 && j === 2 && k === 1) continue;
        if (sign > 0) surface.quad(rows[j - 1][k], rows[j - 1][k + 1], row[k + 1], row[k]);
        else surface.quad(rows[j - 1][k + 1], rows[j - 1][k], row[k], row[k + 1]);
      }
      rows.push(row);
    }
  }
}

/** A shared root field keeps trunks, petioles, rachises and blades attached. */
function vegetationWind(brush?: THREE.DataTexture) {
  const anchor = attribute('windAnchor', 'vec4');
  const root = anchor.xyz.mul(vec3(128, 128, 8)), weight = attribute('wind', 'vec3').mul(vec3(1.25, 1, 1));
  const phase = root.x.mul(.071).add(root.y.mul(.053)).add(root.z.mul(.12));
  const gust = sin(time.mul(.84).add(phase)).mul(.68).add(sin(time.mul(.37).sub(phase.mul(.63))).mul(.32));
  const crown = gust.mul(weight.x).mul(.19);
  const frond = sin(time.mul(1.19).add(phase)).mul(weight.y).mul(.16);
  const flutter = sin(time.mul(3.5).add(positionLocal.x.mul(.8)).add(positionLocal.z.mul(.65)).add(root.z)).mul(weight.z).mul(.045);
  const wind = vec3(crown.add(frond).add(flutter), frond.mul(.2).add(flutter.mul(.35)), crown.mul(.56).add(frond.mul(.38)));
  if (!brush) return positionLocal.add(wind);
  const index = anchor.w.mul(32767).round();
  const bend = textureLoad(brush, ivec2(index, 0));
  const height = positionLocal.y.sub(bend.z).max(0).mul(bend.w).clamp(0, 1.4).pow(1.2);
  const displacement = vec3(bend.x, bend.xy.length().mul(-.24), bend.y).mul(height);
  return positionLocal.add(wind).add(displacement);
}

/** Pigmented tissue scatters actual scene lights, with thicker, opaque veins. */
function createLeafMaterial(brush?: THREE.DataTexture) {
  const material = new THREE.MeshSSSNodeMaterial({ side: THREE.DoubleSide, roughness: .56, metalness: 0 });
  material.name = 'Reference foliage · jade cuticle, lime veins and translucent edges';
  const st = attribute('uv', 'vec2').mul(vec2(4, 32)), across = st.x.sub(.5).abs();
  const midrib = float(1).sub(smoothstep(.012, .03, across));
  const phase = st.y.mul(9).sub(across.mul(4.2));
  const width = dFdx(phase).abs().add(dFdy(phase).abs());
  const veins = float(1).sub(smoothstep(.025, .07, phase.fract().sub(.5).abs()))
    .mul(smoothstep(.025, .055, across)).mul(float(1).sub(smoothstep(.13, .5, width)));
  const tissue = surfaceNoise(st.mul(64)).mul(.026);
  const underside = float(1).sub(faceDirection).mul(.5);
  material.colorNode = attribute('color', 'vec4').rgb.mul(float(.98).add(midrib.mul(.16)).add(veins.mul(.12)).add(tissue))
    .mul(mix(vec3(1), vec3(1.13, 1.12, .93), underside));
  material.roughnessNode = float(.5).add(underside.mul(.18)).add(veins.mul(.06)).add(tissue).clamp(.43, .78);
  material.normalNode = reliefNormal(midrib.mul(.00016).add(veins.mul(.00007)).add(tissue.mul(.00016)));
  material.thicknessColorNode = diffuseColor.rgb.mul(vec3(1.55, 1.24, .56)).mul(float(1).sub(midrib.mul(.62)).sub(veins.mul(.25)));
  material.thicknessDistortionNode = float(.25);
  material.thicknessAmbientNode = float(.015);
  material.thicknessAttenuationNode = float(.45);
  material.thicknessPowerNode = float(2.4);
  material.thicknessScaleNode = float(1.25);
  material.positionNode = vegetationWind(brush);
  return material;
}

export function createVegetationMaterials(brush?: THREE.DataTexture) {
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: .9 });
  bark.name = 'Reference trunks · honey bark with sculpted growth rings';
  const st = attribute('uv', 'vec2').mul(vec2(4, 32)), palm = attribute('color', 'vec4').a;
  const noise = surfaceNoise(st.mul(vec2(18, 2)));
  const fibers = surfaceNoise(st.mul(vec2(155, 8)));
  const phase = st.y.mul(6.75).add(sin(st.x.mul(9)).mul(.12));
  const scar = sin(phase).abs().pow(14).mul(float(1).sub(smoothstep(.5, 2, dFdx(phase).abs().add(dFdy(phase).abs())))).mul(palm);
  bark.colorNode = attribute('color', 'vec4').rgb.mul(float(.99).add(noise.mul(.09)).add(fibers.mul(.04)).sub(scar.mul(.1)));
  bark.roughnessNode = float(.84).add(noise.mul(.055)).add(scar.mul(.1));
  bark.normalNode = reliefNormal(fibers.mul(.0012).sub(scar.mul(.002)));
  bark.positionNode = vegetationWind(brush);
  const blossom = new THREE.MeshSSSNodeMaterial({ roughness: .67, side: THREE.DoubleSide });
  blossom.name = 'Vegetation · cupped hibiscus petals and pollen';
  blossom.colorNode = attribute('color', 'vec4').rgb;
  blossom.thicknessColorNode = diffuseColor.rgb.mul(.7);
  blossom.thicknessScaleNode = float(.6);
  blossom.positionNode = vegetationWind(brush);
  return { bark, leaf: createLeafMaterial(brush), blossom };
}
