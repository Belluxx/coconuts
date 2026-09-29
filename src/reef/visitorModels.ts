import * as THREE from 'three/webgpu';
import { abs, attribute, color, cos, cross, dFdx, dFdy, dot, float, max, mix, positionLocal, positionView, positionWorld, pow, sign, sin, smoothstep, texture, time, transformNormalToView, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom, V } from '../math';
import { surfaceNoise3D } from '../shading';

export type MarineAnimalKind = 'turtle' | 'ray';

type Point = [number, number];

/** A clipped Voronoi cell gives each shell scute its own growth rings and wear. */
function scutePolygon(site: Point, sites: Point[]): Point[] {
  let polygon: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const other of sites) {
    if (other === site) continue;
    const nx = other[0] - site[0], ny = other[1] - site[1];
    const limit = (other[0] ** 2 + other[1] ** 2 - site[0] ** 2 - site[1] ** 2) / 2;
    const output: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = a[0] * nx + a[1] * ny - limit, db = b[0] * nx + b[1] * ny - limit;
      if (da <= 0) output.push(a);
      if ((da <= 0) !== (db <= 0)) {
        const t = da / (da - db);
        output.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    polygon = output;
  }
  return polygon;
}

function paintedTexture(size: number, paint: (context: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d')!, size);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

function shellTexture() {
  const random = seededRandom(53042);
  return paintedTexture(1024, (ctx, size) => {
    ctx.fillStyle = '#586044'; ctx.fillRect(0, 0, size, size);
    const sites: Point[] = [];
    for (let i = 0; i < 5; i++) sites.push([.5 + Math.sin(i * 3) * .013, .15 + i * .174]);
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) sites.push([.5 + side * (.245 + Math.sin(i * 1.7) * .025), .22 + i * .191]);
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      sites.push([.5 + Math.cos(angle) * .497, .5 + Math.sin(angle) * .497]);
    }
    const path = (polygon: Point[], center: Point, scale = 1) => {
      ctx.beginPath();
      polygon.forEach((point, i) => {
        const x = (center[0] + (point[0] - center[0]) * scale) * size;
        const y = (center[1] + (point[1] - center[1]) * scale) * size;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    for (const center of sites) {
      const polygon = scutePolygon(center, sites);
      ctx.save(); path(polygon, center);
      const gradient = ctx.createRadialGradient(center[0] * size, center[1] * size, 2, center[0] * size, center[1] * size, size * .19);
      gradient.addColorStop(0, '#9b9460'); gradient.addColorStop(.38, '#77794d'); gradient.addColorStop(1, '#414e39');
      ctx.fillStyle = gradient; ctx.fill(); ctx.clip();
      // Fine radiating keratin fibers and interrupted concentric growth rings.
      for (let i = 0; i < 115; i++) {
        const angle = random() * Math.PI * 2, length = .06 + random() * .2;
        ctx.strokeStyle = random() < .5 ? 'rgba(201,190,123,.075)' : 'rgba(35,51,32,.10)';
        ctx.lineWidth = .5 + random() * 2;
        const r = random() * .045;
        ctx.beginPath(); ctx.moveTo((center[0] + Math.cos(angle) * r) * size, (center[1] + Math.sin(angle) * r) * size);
        ctx.quadraticCurveTo((center[0] + Math.cos(angle + .06) * length * .5) * size, (center[1] + Math.sin(angle + .06) * length * .5) * size, (center[0] + Math.cos(angle) * length) * size, (center[1] + Math.sin(angle) * length) * size); ctx.stroke();
      }
      for (let i = 0; i < 11; i++) {
        path(polygon, center, .31 + i * .058);
        ctx.strokeStyle = i % 2 ? 'rgba(200,183,119,.14)' : 'rgba(37,49,32,.15)';
        ctx.lineWidth = .7; ctx.stroke();
      }
      ctx.restore(); path(polygon, center);
      ctx.strokeStyle = '#293b2b'; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = '#aeac77'; ctx.lineWidth = .8; ctx.stroke();
    }
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = random() < .5 ? 'rgba(219,204,146,.055)' : 'rgba(16,31,25,.06)';
      ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
    }
  });
}

function skinTexture() {
  const random = seededRandom(6138);
  return paintedTexture(512, (ctx, size) => {
    ctx.fillStyle = '#b1b28b'; ctx.fillRect(0, 0, size, size);
    const sites: Point[] = [];
    for (let row = -1; row < 20; row++) for (let col = -1; col < 20; col++) {
      sites.push([(col + (row % 2) * .5 + (random() - .5) * .63) / 18, (row + (random() - .5) * .63) / 18]);
    }
    for (const center of sites) {
      const polygon = scutePolygon(center, sites);
      if (!polygon.length) continue;
      ctx.beginPath();
      polygon.forEach((point, i) => { if (i) ctx.lineTo(point[0] * size, point[1] * size); else ctx.moveTo(point[0] * size, point[1] * size); });
      ctx.closePath();
      const hue = 61 + random() * 14, light = 41 + random() * 10;
      ctx.fillStyle = `hsl(${hue} 17% ${light}%)`; ctx.fill();
      ctx.strokeStyle = '#b5b28d'; ctx.lineWidth = 1.05; ctx.stroke();
    }
    for (let i = 0; i < 4500; i++) {
      ctx.fillStyle = 'rgba(33,44,28,.075)';
      ctx.fillRect(random() * size, random() * size, 1, 2);
    }
  });
}

function eagleRayTexture() {
  const random = seededRandom(14126);
  return paintedTexture(1024, (ctx, size) => {
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#31464b'); gradient.addColorStop(.48, '#2b4149'); gradient.addColorStop(1, '#3f5759');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
    // Blue-noise spacing avoids the regular polka-dot rows of a painted toy.
    const dots: Point[] = [];
    for (let attempt = 0; attempt < 2600 && dots.length < 790; attempt++) {
      const x = random() * size, y = random() * size;
      if (dots.some(point => (point[0] - x) ** 2 + (point[1] - y) ** 2 < 15 ** 2)) continue;
      dots.push([x, y]);
      const r = 1.8 + random() ** .6 * 3.7;
      ctx.fillStyle = `rgba(204,211,189,${.37 + random() * .39})`;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * (.67 + random() * .5), random() * Math.PI, 0, Math.PI * 2); ctx.fill();
      if (random() < .10) {
        ctx.fillStyle = 'rgba(37,61,65,.5)'; ctx.beginPath(); ctx.ellipse(x + r * .13, y, r * .44, r * .36, .2, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (let i = 0; i < 14000; i++) {
      ctx.fillStyle = random() < .5 ? 'rgba(181,200,188,.07)' : 'rgba(9,26,33,.08)';
      ctx.fillRect(random() * size, random() * size, 1, 1);
    }
  });
}

type AnimalPart = {
  position?: THREE.Vector3;
  scale?: THREE.Vector3;
  /** 0: solid tint, 1: shell or ray pattern, 2: turtle skin, 3: glossy eye. */
  region?: number;
  joint?: THREE.Vector3;
  /** Signed flipper side for turtles; wing/tail selection for rays. */
  flex?: number;
};

/** Merge shell, skin, eyes, and fins into one articulated draw call per animal. */
class AnimalGeometry {
  private parts: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, tint: string, part: AnimalPart = {}) {
    const { position = V(), scale = V(1, 1, 1), region = 0, joint = V(), flex = 0 } = part;
    geometry.scale(scale.x, scale.y, scale.z).translate(position.x, position.y, position.z);
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    if (source !== geometry) geometry.dispose();
    const count = source.getAttribute('position').count;
    const base = new THREE.Color(tint), colors = new Float32Array(count * 3), joints = new Float32Array(count * 3);
    const existing = source.getAttribute('color');
    for (let i = 0; i < count; i++) {
      colors[i * 3] = base.r * (existing?.getX(i) ?? 1);
      colors[i * 3 + 1] = base.g * (existing?.getY(i) ?? 1);
      colors[i * 3 + 2] = base.b * (existing?.getZ(i) ?? 1);
      joints.set([joint.x, joint.y, joint.z], i * 3);
    }
    source.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    source.setAttribute('joint', new THREE.Float32BufferAttribute(joints, 3));
    source.setAttribute('region', new THREE.Float32BufferAttribute(new Float32Array(count).fill(region), 1));
    source.setAttribute('flex', new THREE.Float32BufferAttribute(new Float32Array(count).fill(flex), 1));
    if (!source.hasAttribute('uv')) source.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    this.parts.push(source);
  }

  oval(point: THREE.Vector3, scale: THREE.Vector3, tint: string, region = 0) {
    this.add(new THREE.SphereGeometry(1, 28, 18), tint, { position: point, scale, region });
  }

  line(points: THREE.Vector3[], radius: number, tint: string, region = 0) {
    const curve = new THREE.CatmullRomCurve3(points);
    this.add(new THREE.TubeGeometry(curve, points.length * 5, radius, 6), tint, { region });
  }

  finish() {
    const merged = mergeGeometries(this.parts, false)!;
    this.parts.forEach(part => part.dispose());
    this.parts.length = 0;
    merged.computeBoundingSphere();
    // Shader strokes remain within this generous bound, including the tail.
    merged.boundingSphere!.radius += .55;
    return merged;
  }
}

function surfaceGeometry(positions: number[], uvs: number[], indices: number[], colors?: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function turtleGeometry() {
  const animal = new AnimalGeometry();
  animal.oval(V(0, .043, -.025), V(.414, .092, .615), '#c2b78c');
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const rings = 22, sides = 80;
  for (let ring = 0; ring <= rings; ring++) for (let side = 0; side <= sides; side++) {
    const r = ring / rings, a = side / sides * Math.PI * 2;
    const nx = Math.cos(a) * r, nz = Math.sin(a) * r;
    const rearTaper = 1 - Math.max(0, -nz) * .14;
    positions.push(nx * .447 * rearTaper, .084 + .249 * Math.pow(Math.max(0, 1 - r * r), .63), nz * .638 - .014);
    uvs.push(.5 + nx * .5, .5 + nz * .5);
    if (ring < rings && side < sides) {
      const i = ring * (sides + 1) + side;
      indices.push(i, i + 1, i + sides + 1, i + 1, i + sides + 2, i + sides + 1);
    }
  }
  animal.add(surfaceGeometry(positions, uvs, indices), '#ffffff', { region: 1 });
  const rim: THREE.Vector3[] = [];
  for (let i = 0; i <= 80; i++) {
    const a = i / 80 * Math.PI * 2, nz = Math.sin(a);
    rim.push(V(Math.cos(a) * .447 * (1 - Math.max(0, -nz) * .14), .083, nz * .638 - .014));
  }
  animal.line(rim, .0085, '#8b8e62');
  // One uninterrupted head profile: the mouth is not a protruding accessory.
  animal.oval(V(0, .058, .62), V(.117, .107, .205), '#cfccb0', 2);
  animal.oval(V(0, .073, .815), V(.151, .119, .203), '#d6d1ae', 2);
  for (const side of [-1, 1]) {
    animal.oval(V(side * .125, .116, .88), V(.032, .027, .031), '#8f9470');
    animal.oval(V(side * .145, .119, .881), V(.013, .021, .023), '#272f24', 3);
    animal.oval(V(side * .154, .12, .884), V(.006, .016, .017), '#081713', 3);
    animal.oval(V(side * .157, .126, .892), V(.0025, .004, .004), '#c2d0be', 3);
    animal.oval(V(side * .044, .089, .984), V(.009, .005, .006), '#536049');
    for (const rear of [false, true]) {
      const p: number[] = [], uv: number[] = [], idx: number[] = [];
      const joint = V(side * (rear ? .26 : .30), .063, rear ? -.46 : .36);
      const spanRings = 22, crossSides = 12;
      for (let ring = 0; ring <= spanRings; ring++) for (let edge = 0; edge <= crossSides; edge++) {
        const t = ring / spanRings, angle = edge / crossSides * Math.PI * 2;
        const chord = (rear ? .12 : .135) * Math.pow(1 - t, .42) + Math.sin(t * Math.PI) * (rear ? .047 : .065);
        const thickness = .020 * Math.pow(1 - t, .7) + .0008;
        p.push(joint.x + side * (rear ? .31 : .81) * t, joint.y - t * .045 + Math.sin(angle) * thickness, joint.z - (rear ? .24 : .28) * t - (rear ? 0 : .22) * t * t + Math.cos(angle) * chord);
        uv.push(t, edge / crossSides);
        if (ring < spanRings && edge < crossSides) {
          const i = ring * (crossSides + 1) + edge;
          if (side > 0) idx.push(i, i + crossSides + 1, i + 1, i + 1, i + crossSides + 1, i + crossSides + 2);
          else idx.push(i, i + 1, i + crossSides + 1, i + 1, i + crossSides + 2, i + crossSides + 1);
        }
      }
      animal.add(surfaceGeometry(p, uv, idx), rear ? '#d0cbb0' : '#d9d4b7', { region: 2, joint, flex: side * (rear ? 2 : 1) });
    }
  }
  animal.oval(V(0, .028, -.65), V(.035, .023, .11), '#9b9d75', 2);
  // The plastron's central suture and transverse seams remain visible below.
  animal.line([V(0, -.049, -.47), V(0, -.051, 0), V(0, -.039, .47)], .0025, '#969572');
  for (const z of [-.30, -.08, .17, .36]) animal.line([V(-.25, -.027, z + .023), V(0, -.050, z), V(.25, -.027, z + .023)], .002, '#aaa47e');
  return animal.finish();
}

function rayGeometry() {
  const animal = new AnimalGeometry(), positions: number[] = [], uvs: number[] = [], indices: number[] = [], colors: number[] = [];
  const rings = 72, sides = 40, white = new THREE.Color('#ffffff'), belly = new THREE.Color('#cbd0b7');
  const skinPoint = (x: number, z: number, offset = 0, underside = false) => {
    const u = Math.abs(x) / 1.22;
    const front = .40 - .68 * u + Math.sin(u * Math.PI) * .13 + .37 * Math.exp(-((x / .185) ** 4));
    const back = -.68 + .40 * u, chord = Math.max(.001, (front - back) / 2);
    const across = THREE.MathUtils.clamp((z - (front + back) / 2) / chord, -1, 1);
    const height = Math.sqrt(1 - across * across) * (.108 * Math.pow(1 - u, 1.4) + .0015);
    return V(x, (underside ? -height : height) - .021 * u + offset, z);
  };
  for (let ring = 0; ring <= rings; ring++) for (let side = 0; side <= sides; side++) {
    const x = (ring / rings * 2 - 1) * 1.22, u = Math.abs(x) / 1.22, angle = side / sides * Math.PI * 2;
    // A broad cephalic lobe grows from the same skin as the wings. The fourth
    // power keeps its shovel-shaped snout broad, with a smooth shoulder join.
    const head = .37 * Math.exp(-((x / .185) ** 4));
    const front = .40 - .68 * u + Math.sin(u * Math.PI) * .13 + head;
    const back = -.68 + .40 * u;
    const center = (front + back) / 2, chord = Math.max(.001, (front - back) / 2);
    const y = Math.sin(angle) * (.108 * Math.pow(1 - u, 1.4) + .0015) - .021 * u;
    const z = center + Math.cos(angle) * chord;
    positions.push(x, y, z); uvs.push(x / 2.5 + .5, z / 1.6 + .49);
    const c = white.clone().lerp(belly, THREE.MathUtils.smoothstep(-Math.sin(angle), -.05, .1));
    colors.push(c.r, c.g, c.b);
    if (ring < rings && side < sides) {
      const i = ring * (sides + 1) + side;
      indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2);
    }
  }
  const wing = surfaceGeometry(positions, uvs, indices, colors);
  animal.add(wing, '#ffffff', { region: 1, flex: 1 });
  for (const side of [-1, 1]) {
    animal.oval(skinPoint(side * .15, .418, -.002), V(.029, .016, .041), '#334d50');
    animal.oval(skinPoint(side * .161, .429, .010), V(.016, .009, .020), '#12282d', 3);
    animal.oval(skinPoint(side * .165, .432, .018), V(.011, .004, .014), '#091b20', 3);
    animal.oval(skinPoint(side * .168, .437, .023), V(.002, .001, .003), '#b6c7bf', 3);
    animal.oval(skinPoint(side * .168, .326, .001), V(.013, .0035, .026), '#1c363b');
    // Five short gill slits curve across the pale underside.
    for (let i = 0; i < 5; i++) {
      const z = .23 - i * .059;
      animal.line([skinPoint(side * .13, z, -.001, true), skinPoint(side * .20, z - .01, -.001, true), skinPoint(side * .26, z - .006, -.001, true)], .0032, '#81938a');
    }
  }
  animal.line([skinPoint(-.10, .597, -.001, true), skinPoint(0, .573, -.001, true), skinPoint(.10, .597, -.001, true)], .003, '#4e6965');
  const dorsalP: number[] = [], dorsalUv: number[] = [], dorsalIndices: number[] = [];
  for (let row = 0; row <= 16; row++) for (let side = 0; side <= 8; side++) {
    const t = row / 16, a = side / 8 * Math.PI * 2;
    const height = Math.sin(t * Math.PI) * .087;
    dorsalP.push(Math.sin(a) * .006 * Math.sin(t * Math.PI), skinPoint(0, -.43 - t * .25).y + height * (Math.cos(a) * .5 + .5) - .002, -.43 - t * .25);
    dorsalUv.push(t, side / 8);
    if (row < 16 && side < 8) { const i = row * 9 + side; dorsalIndices.push(i, i + 9, i + 1, i + 1, i + 9, i + 10); }
  }
  animal.add(surfaceGeometry(dorsalP, dorsalUv, dorsalIndices), '#344d50');
  // A tapered whip tail is part of the same mesh and sways behind the wings.
  const p: number[] = [], uv: number[] = [], idx: number[] = [], tailRings = 64, tailSides = 8;
  for (let ring = 0; ring <= tailRings; ring++) for (let side = 0; side <= tailSides; side++) {
    const t = ring / tailRings, a = side / tailSides * Math.PI * 2, radius = .019 * Math.pow(1 - t, 1.7) + .0015;
    p.push(Math.sin(t * 3.8) * t * .065 + Math.cos(a) * radius, -.012 - t * .05 + Math.sin(a) * radius, -.57 - t * 2.35);
    uv.push(t, side / tailSides);
    if (ring < tailRings && side < tailSides) {
      const i = ring * (tailSides + 1) + side;
      idx.push(i, i + tailSides + 1, i + 1, i + 1, i + tailSides + 1, i + tailSides + 2);
    }
  }
  animal.add(surfaceGeometry(p, uv, idx), '#30484b', { flex: 2 });
  return animal.finish();
}

/** Shared geometry and painted textures; each animal gets its own material for its animation phase. */
export function createVisitorModels() {
  const shell = shellTexture(), skin = skinTexture(), spots = eagleRayTexture();
  const turtle = turtleGeometry(), ray = rayGeometry();
  const region = attribute('region', 'float'), uv = attribute('uv', 'vec2');
  const isShell = smoothstep(float(.5), float(.9), region).mul(float(1).sub(smoothstep(float(1.1), float(1.5), region)));
  const isSkin = smoothstep(float(1.5), float(1.9), region).mul(float(1).sub(smoothstep(float(2.1), float(2.5), region)));
  const isEye = smoothstep(float(2.5), float(2.9), region);
  // Each animal keeps its own swimming phase; animals of a kind share one material.
  const phase = uniform(0).onObjectUpdate(({ object }) => object!.userData.swimPhase as number);
  const clock = time.add(phase);
  function createMaterial(kind: MarineAnimalKind) {
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .58, metalness: .015, side: THREE.DoubleSide });
    const rest = attribute('position', 'vec3'), flex = attribute('flex', 'float');
    const normal = attribute('normal', 'vec3');
    const micrograin = surfaceNoise3D(rest.mul(108));
    let normalX = normal.x, normalY = normal.y;
    if (kind === 'turtle') {
      const joint = attribute('joint', 'vec3');
      const rear = smoothstep(float(1.2), float(1.8), abs(flex));
      const along = abs(rest.x.sub(joint.x));
      const angle = sin(clock.mul(1.75).sub(along.mul(1.8)).add(rear.mul(1.4))).mul(sign(flex)).mul(mix(float(.48), float(.18), rear));
      const local = rest.sub(joint), c = cos(angle), s = sin(angle);
      mat.positionNode = vec3(local.x.mul(c).sub(local.y.mul(s)), local.x.mul(s).add(local.y.mul(c)), local.z).add(joint);
      normalX = normal.x.mul(c).sub(normal.y.mul(s));
      normalY = normal.x.mul(s).add(normal.y.mul(c));
      const paint = mix(color('#ffffff'), texture(shell, uv).rgb, isShell);
      mat.colorNode = paint.mul(mix(color('#ffffff'), texture(skin, uv).rgb, isSkin));
      mat.roughnessNode = mix(float(.54).add(micrograin.mul(.045)), float(.13), isEye);
    } else {
      const wing = float(1).sub(smoothstep(float(1.1), float(1.8), flex));
      const ax = abs(rest.x), phaseNode = clock.mul(1.63).sub(ax.mul(1.5));
      const lift = sin(phaseNode).mul(pow(ax, float(1.7))).mul(.27).mul(wing);
      const trailing = max(float(0), rest.z.negate().sub(.62));
      const tailSway = sin(clock.mul(1.2).add(rest.z.mul(2.3))).mul(pow(trailing, float(1.3))).mul(.027).mul(float(1).sub(wing));
      mat.positionNode = positionLocal.add(vec3(tailSway, lift, 0));
      const angle = sign(rest.x).mul(sin(phaseNode).mul(pow(ax, float(.7))).mul(.459).sub(cos(phaseNode).mul(pow(ax, float(1.7))).mul(.405))).mul(wing);
      normalX = normal.x.mul(cos(angle)).sub(normal.y.mul(sin(angle)));
      normalY = normal.x.mul(sin(angle)).add(normal.y.mul(cos(angle)));
      const dorsal = smoothstep(float(-.06), float(.015), normal.y).mul(isShell);
      mat.colorNode = mix(color('#ffffff'), texture(spots, uv).rgb, dorsal);
      mat.roughnessNode = mix(float(.46).add(micrograin.mul(.036)), float(.12), isEye);
    }
    const baseNormal = transformNormalToView(vec3(normalX, normalY, normal.z)).toVarying().normalize();
    const tissueHeight = kind === 'turtle'
      ? texture(shell, uv).r.mul(isShell).mul(.0017).add(texture(skin, uv).r.mul(isSkin).mul(.0010)).add(micrograin.mul(.00018))
      : micrograin.mul(.00023);
    // Microscopic keratin relief follows the already articulated normal.
    const dx = dFdx(positionView), dy = dFdy(positionView);
    const r1 = cross(dy, baseNormal), r2 = cross(baseNormal, dx), determinant = dot(dx, r1);
    const gradient = r1.mul(dFdx(tissueHeight)).add(r2.mul(dFdy(tissueHeight))).mul(determinant.sign());
    mat.normalNode = baseNormal.mul(max(determinant.abs(), .0000001)).sub(gradient).normalize();
    return mat;
  }

  const materials = { turtle: createMaterial('turtle'), ray: createMaterial('ray') };
  return {
    createMesh(kind: MarineAnimalKind, swimPhase: number) {
      const mesh = new THREE.Mesh(kind === 'turtle' ? turtle : ray, materials[kind]);
      mesh.userData.swimPhase = swimPhase;
      return mesh;
    },
  };
}
