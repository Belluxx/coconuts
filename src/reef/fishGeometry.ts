import * as THREE from 'three/webgpu';
import { V } from '../math';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type ReefSpecies = 'silver' | 'anthias' | 'butterfly' | 'blueTang' | 'sergeant' | 'bannerfish' | 'parrotfish' | 'wrasse';

const smooth = THREE.MathUtils.smoothstep;
const PALETTES = {
  silver: ['#a3c4ce', '#2f5966', '#d9e1ce', '#779aa9'],
  anthias: ['#e98b43', '#b94e64', '#f2bf65', '#ca516b'],
  butterfly: ['#e6d9a2', '#cbb95c', '#f2dfa9', '#caaa48'],
  blueTang: ['#2e7fbb', '#224e87', '#4798ce', '#366caa'],
  sergeant: ['#d3d5ba', '#9fa455', '#e0ddc2', '#a3ad86'],
  bannerfish: ['#e7e3bf', '#d2c893', '#f0e9ce', '#dfc65d'],
  parrotfish: ['#389890', '#346d77', '#84b8a0', '#5578a0'],
  wrasse: ['#559c8e', '#427e80', '#bbbc91', '#658f87'],
} satisfies Record<ReefSpecies, string[]>;

const BODY_SHAPES = {
  silver: { height: .135, thickness: .072, rings: 18, sides: 12 },
  anthias: { height: .195, thickness: .096, rings: 26, sides: 18 },
  butterfly: { height: .32, thickness: .092, rings: 48, sides: 28 },
  blueTang: { height: .255, thickness: .096, rings: 48, sides: 28 },
  sergeant: { height: .252, thickness: .096, rings: 38, sides: 24 },
  bannerfish: { height: .325, thickness: .092, rings: 48, sides: 28 },
  parrotfish: { height: .267, thickness: .144, rings: 48, sides: 28 },
  wrasse: { height: .148, thickness: .096, rings: 48, sides: 28 },
} satisfies Record<ReefSpecies, { height: number; thickness: number; rings: number; sides: number }>;

const MARKINGS = {
  silverHighlight: new THREE.Color('#e1e9db'),
  silverStripe: new THREE.Color('#648e9c'),
  anthiasBlush: new THREE.Color('#d4648c'),
  butterflyChevron: new THREE.Color('#847e60'),
  tangMarking: new THREE.Color('#203247'),
  parrotStripe: new THREE.Color('#8c749f'),
  wrasseStripe: new THREE.Color('#294d51'),
};

function interleaveStaticAttributes(geometry: THREE.BufferGeometry) {
  // WebGPU guarantees eight vertex buffers. Pack the static attributes together
  // so instance matrices, tint and animation data leave ample buffer headroom.
  const layout = [
    ['position', 3], ['normal', 3], ['color', 3],
    ['fishUv', 2], ['fishSurface', 1], ['finFlutter', 1],
  ] as const;
  const stride = layout.reduce((sum, [, size]) => sum + size, 0);
  const vertexCount = geometry.getAttribute('position').count;
  const packed = new THREE.InterleavedBuffer(new Float32Array(vertexCount * stride), stride);
  let offset = 0;
  for (const [name, size] of layout) {
    const source = geometry.getAttribute(name);
    for (let i = 0; i < vertexCount; i++) for (let component = 0; component < size; component++) {
      packed.array[i * stride + offset + component] = source.getComponent(i, component);
    }
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(packed, size, offset));
    offset += size;
  }
}

/** Anatomical silhouettes, membranes and color patterns are authored in fish space. */
export function createReefFishGeometry(species: ReefSpecies) {
  const baitfish = species === 'silver';
  const small = baitfish || species === 'anthias';
  const discShaped = species === 'butterfly' || species === 'bannerfish';
  // Small shoaling fish use fewer vertices than species seen close to the reef.
  const { height, thickness, rings, sides } = BODY_SHAPES[species];
  const [flank, back, belly, fin] = PALETTES[species].map(c => new THREE.Color(c));
  const ink = new THREE.Color('#263537'), gold = new THREE.Color('#d9be4c');
  const pink = new THREE.Color('#b96689'), cyan = new THREE.Color('#69bdaf');
  const parts: THREE.BufferGeometry[] = [];
  const profile = (u: number) => {
    const round = Math.pow(Math.sin(Math.PI * (u * .925 + .027)), species === 'parrotfish' ? .63 : .79);
    return round * (.80 + u * .24) * (1 - smooth(u, .87, 1) * .76);
  };
  const centerY = (u: number) => Math.sin(u * Math.PI) * .009 - Math.pow(u, 7) * .022;
  const tintAt = (u: number, a: number) => {
    const y = Math.cos(a);
    const c = flank.clone().lerp(back, smooth(y, -.05, .95) * .8).lerp(belly, (1 - smooth(y, -.94, -.16)) * .83);
    if (species === 'silver') {
      c.lerp(MARKINGS.silverHighlight, Math.exp(-(((y + .12) / .12) ** 2)) * .55);
      c.lerp(MARKINGS.silverStripe, Math.exp(-(((y - .09) / .08) ** 2)) * .52);
    } else if (species === 'anthias') {
      c.lerp(pink, smooth(y, .36, .9) * .45);
      c.lerp(MARKINGS.anthiasBlush, Math.exp(-(((u - .80) / .18) ** 2) - ((y - .12) / .3) ** 2) * .5);
      c.lerp(gold, Math.exp(-(((y + .26) / .12) ** 2)) * .2);
    } else if (species === 'butterfly') {
      const chevrons = Math.cos((u * 8.5 + Math.abs(y) * .58) * Math.PI * 2);
      c.lerp(MARKINGS.butterflyChevron, smooth(chevrons, .86, .97) * (1 - smooth(u, .68, .82)) * .47);
      c.lerp(ink, (1 - smooth(Math.abs(u - .827 + y * .032), .029, .056)) * .97);
      const spot = Math.hypot((u - .20) / .052, (y - .25) / .16);
      c.lerp(gold, 1 - smooth(spot, 1, 1.48)).lerp(ink, 1 - smooth(spot, .66, 1));
    } else if (species === 'blueTang') {
      const marking = smooth(y, -.025, .19) * (1 - smooth(u, .69, .85));
      const blueIsland = Math.exp(-(((u - .37) / .19) ** 2) - ((y - .23) / .33) ** 2);
      c.lerp(MARKINGS.tangMarking, marking * (1 - blueIsland * .96));
      c.lerp(gold, (1 - smooth(u, .025, .19)) * (1 - smooth(Math.abs(y), .35, .8)));
    } else if (species === 'sergeant') {
      const bands = Math.cos((u * 5.2 + y * .032) * Math.PI * 2);
      c.lerp(ink, smooth(bands, .18, .6) * smooth(u, .055, .1) * (1 - smooth(u, .86, .95)) * .91);
    } else if (species === 'bannerfish') {
      const diagonal = u + y * .16;
      const bands = Math.max(1 - smooth(Math.abs(diagonal - .29), .085, .12), 1 - smooth(Math.abs(diagonal - .73), .075, .11));
      c.lerp(ink, bands * .98).lerp(gold, (1 - smooth(u, .04, .20)) * .8);
    } else if (species === 'parrotfish') {
      const cheek = smooth(u, .60, .83);
      const lines = Math.pow(Math.max(0, Math.sin((u * 3.2 + y * 2.3) * Math.PI * 2)), 7);
      c.lerp(pink, cheek * lines * .82).lerp(cyan, cheek * (1 - lines) * .23);
      c.lerp(MARKINGS.parrotStripe, Math.exp(-(((y + .24) / .11) ** 2)) * (1 - cheek) * .38);
    } else {
      const ribbons = Math.pow(Math.max(0, Math.cos((y * 2.8 + u * .3) * Math.PI * 2)), 7);
      c.lerp(pink, ribbons * .67);
      c.lerp(MARKINGS.wrasseStripe, Math.exp(-(((y - .035) / .095) ** 2)) * .48);
    }
    return c;
  };

  function add(geometry: THREE.BufferGeometry, tint: THREE.Color | string, point = V(), scale = V(1, 1, 1), surface = 0, flutter = 0) {
    geometry.scale(scale.x, scale.y, scale.z).translate(point.x, point.y, point.z);
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    const count = g.getAttribute('position').count;
    const c = tint instanceof THREE.Color ? tint : new THREE.Color(tint);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('fishUv', g.getAttribute('uv')?.clone() ?? new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    g.setAttribute('fishSurface', new THREE.Float32BufferAttribute(new Float32Array(count).fill(surface), 1));
    g.setAttribute('finFlutter', new THREE.Float32BufferAttribute(new Float32Array(count).fill(flutter), 1));
    g.deleteAttribute('uv');
    parts.push(g);
  }

  const positions: number[] = [], colors: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const u = ring / rings, width = profile(u);
    for (let side = 0; side <= sides; side++) {
      const a = side / sides * Math.PI * 2;
      positions.push(-.47 + u * .99, centerY(u) + Math.cos(a) * height * width, Math.sin(a) * thickness * width);
      const c = tintAt(u, a); colors.push(c.r, c.g, c.b); uv.push(u, side / sides);
      if (ring < rings && side < sides) {
        const i = ring * (sides + 1) + side;
        indices.push(i, i + 1, i + sides + 1, i + 1, i + sides + 2, i + sides + 1);
      }
    }
  }
  for (const ring of [0, rings]) for (let side = 1; side < sides - 1; side++) {
    const base = ring * (sides + 1);
    if (ring === 0) indices.push(base, base + side + 1, base + side);
    else indices.push(base, base + side, base + side + 1);
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  body.setAttribute('fishUv', new THREE.Float32BufferAttribute(uv, 2));
  body.setAttribute('fishSurface', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3).fill(1), 1));
  body.setAttribute('finFlutter', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3), 1));
  body.setIndex(indices); body.computeVertexNormals();
  const normals = body.getAttribute('normal');
  for (let ring = 0; ring <= rings; ring++) {
    const a = ring * (sides + 1), b = a + sides;
    const n = V(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z);
  }
  parts.push(body.toNonIndexed()); body.dispose();

  const ray = (points: THREE.Vector3[], tint: THREE.Color | string, radius = .0016) =>
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 6, radius, 3), tint);
  const membrane = (root: (t: number) => THREE.Vector3, rim: (t: number) => THREE.Vector3, tint: THREE.Color, count = 16, detail = false, flutter = 0) => {
    const p: number[] = [], uv: number[] = [], c: number[] = [], flex: number[] = [], idx: number[] = [];
    for (let i = 0; i <= count; i++) for (let j = 0; j <= 4; j++) {
      const t = i / count, s = j / 4;
      const point = root(t).lerp(rim(t), s);
      point.z += Math.sin(t * Math.PI) * Math.sin(s * Math.PI) * .012;
      p.push(point.x, point.y, point.z); uv.push(t, s); flex.push(flutter * s);
      const finTint = tint.clone().lerp(belly, s * .20).multiplyScalar(.88 + .12 * s);
      if (s > .8 && discShaped) finTint.lerp(gold, .32);
      c.push(finTint.r, finTint.g, finTint.b);
      if (i < count && j < 4) { const a = i * 5 + j; idx.push(a, a + 1, a + 5, a + 1, a + 6, a + 5); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.setAttribute('fishUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('fishSurface', new THREE.Float32BufferAttribute(new Float32Array(p.length / 3), 1));
    g.setAttribute('finFlutter', new THREE.Float32BufferAttribute(flex, 1));
    g.setIndex(idx); g.computeVertexNormals(); parts.push(g.toNonIndexed()); g.dispose();
    if (detail) for (let i = 1; i < count; i += species === 'sergeant' ? 4 : 2) {
      const t = i / count, a = root(t), b = rim(t);
      ray([a, a.clone().lerp(b, .5).add(V(0, 0, Math.sin(t * Math.PI) * .012)), b], tint.clone().multiplyScalar(.71), .0012);
    }
  };
  const tailTint = species === 'blueTang' || discShaped ? gold : fin;
  const fork = baitfish ? .23 : species === 'anthias' ? .19 : species === 'wrasse' || species === 'parrotfish' ? .055 : .15;
  const tailHeight = baitfish ? .41 : species === 'anthias' ? .56 : .50;
  membrane(t => V(-.458, (t - .5) * .063, 0), t => V(-.83 + Math.pow(1 - Math.abs(t * 2 - 1), 2) * fork, (t - .5) * tailHeight, Math.sin(t * Math.PI * 2) * .007), tailTint, small ? 14 : 20, !small);
  for (const sign of [-1, 1]) {
    const root = (t: number) => { const u = .10 + t * .68; return V(-.47 + u * .99, centerY(u) + sign * height * profile(u) * .97, 0); };
    const rim = (t: number) => {
      const pennant = species === 'bannerfish' && sign === 1 ? Math.exp(-(((t - .80) / .145) ** 2)) * .57 : 0;
      const plume = species === 'anthias' && sign === 1 ? .035 * Math.sin(t * Math.PI) : 0;
      return root(t).add(V(-Math.sin(t * Math.PI) * .027 - pennant * .66, sign * Math.pow(Math.sin(t * Math.PI), .74) * (discShaped ? .105 : .065) + pennant + plume, .006 * Math.sin(t * Math.PI)));
    };
    membrane(root, rim, species === 'bannerfish' && sign === 1 ? belly : fin, small ? 14 : 24, !small);
    const pectoral = species === 'blueTang' ? gold : species === 'parrotfish' ? pink : fin;
    membrane(t => V(.19 - t * .055, .006 - t * .061, sign * thickness * .83), t => V(-.07 - Math.sin(t * Math.PI) * .07, -.035 - t * .098, sign * (.12 + Math.sin(t * Math.PI) * .105)), pectoral, small ? 6 : 10, false, sign);
    if (!baitfish) membrane(t => V(.06 - t * .09, -height * .80, sign * thickness * .3), t => V(-.15 - t * .035, -height - .07 * Math.sin(t * Math.PI), sign * thickness * (.45 + .3 * Math.sin(t * Math.PI))), fin, 8);
  }
  const eyeU = discShaped ? .83 : .855, eyeX = -.47 + eyeU * .99;
  const eyeY = centerY(eyeU) + height * .26, eyeZ = thickness * profile(eyeU) * .915;
  const radius = baitfish ? .016 : species === 'parrotfish' ? .019 : .023;
  for (const sign of [-1, 1]) {
    if (!small) add(new THREE.SphereGeometry(radius * 1.12, 12, 8), back.clone().multiplyScalar(.55), V(eyeX, eyeY, sign * eyeZ), V(1, 1, .45), 2);
    add(new THREE.SphereGeometry(radius, small ? 8 : 14, small ? 6 : 10), species === 'blueTang' || species === 'parrotfish' ? '#98a38b' : '#bdb082', V(eyeX, eyeY, sign * (eyeZ + .004)), V(1, 1, .45), 2);
    add(new THREE.SphereGeometry(radius * .66, small ? 8 : 14, small ? 6 : 10), '#091d20', V(eyeX + .001, eyeY, sign * (eyeZ + .009)), V(1, 1, .6), 2);
    if (!baitfish) {
      add(new THREE.SphereGeometry(.0031, 8, 6), '#dbe7db', V(eyeX + .005, eyeY + .006, sign * (eyeZ + .016)), V(1, 1, .45), 2);
      ray([V(.235, height * .43, sign * thickness * .77), V(.202, height * .02, sign * thickness * .93), V(.231, -height * .41, sign * thickness * .79)], back.clone().multiplyScalar(.63), .002);
      ray([V(.49, -.028, sign * .010), V(.516, -.026, sign * .016), V(.522, -.031, sign * .004)], back.clone().multiplyScalar(.53), .0023);
      if (species === 'parrotfish') add(new THREE.SphereGeometry(.029, 12, 8), '#bacbbb', V(.497, -.018, sign * .013), V(.65, .60, .52), 2);
    }
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach(part => part.dispose());
  interleaveStaticAttributes(geometry);
  geometry.computeBoundingSphere();
  return geometry;
}
