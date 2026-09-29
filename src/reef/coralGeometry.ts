import * as THREE from 'three/webgpu';
import { TAU, V } from '../math';

/** Small sculpted reef forms; local colour carries raised edges and growth rings. */
class ReefSurface {
  positions: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  normalOverrides = new Map<number, THREE.Vector3>();

  vertex(point: THREE.Vector3, light = 1, warmth = 0) {
    this.positions.push(point.x, point.y, point.z);
    this.colors.push(light, light * (1 - warmth * .12), light * (1 - warmth * .22));
    return this.positions.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, d, b, c, d);
  }

  finish(wrap = 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    if (wrap) {
      const normals = geometry.getAttribute('normal');
      for (let start = 0; start + wrap <= normals.count; start += wrap) {
        const end = start + wrap - 1;
        const normal = V(normals.getX(start) + normals.getX(end), normals.getY(start) + normals.getY(end), normals.getZ(start) + normals.getZ(end)).normalize();
        normals.setXYZ(start, normal.x, normal.y, normal.z);
        normals.setXYZ(end, normal.x, normal.y, normal.z);
      }
    }
    const normals = geometry.getAttribute('normal');
    for (const [index, normal] of this.normalOverrides) normals.setXYZ(index, normal.x, normal.y, normal.z);
    return geometry;
  }
}

/** Unequal fleshy lobes and winding ridges make a coral head instead of a ball. */
export function createCoralHeadGeometry(seed: number) {
  const surface = new ReefSurface();
  const sides = 64, rows = 24;
  for (let row = 0; row <= rows; row++) {
    const v = row / rows, phi = v * Math.PI;
    for (let side = 0; side <= sides; side++) {
      const theta = side / sides * TAU;
      const lobes = 1 + Math.sin(theta * 3 + seed) * .095 + Math.cos(theta * 5 - phi * 2 + seed) * .055;
      const ridgeWave = Math.sin(theta * 16 + Math.sin(phi * 7 + seed) * 2.8 + Math.sin(theta * 3) * .8);
      const ridge = Math.pow((ridgeWave + 1) * .5, 2) * .081 * Math.sin(phi);
      const radius = Math.sin(phi) * lobes * (.91 + ridge);
      const y = .42 + Math.cos(phi) * .43 + ridge * .45 + Math.sin(theta * 4 + seed) * .038 * Math.sin(phi);
      surface.vertex(V(Math.cos(theta) * radius, y, Math.sin(theta) * radius * .87), .79 + ridgeWave * .12 + (1 - v) * .16, .12);
      if (row < rows && side < sides) {
        const a = row * (sides + 1) + side;
        surface.quad(a, a + 1, a + sides + 2, a + sides + 1);
      }
    }
  }
  return surface.finish(sides + 1);
}

/** A cupped foliose coral with scalloped, pale growing edges and a real underside. */
export function createCoralPlateGeometry(seed: number) {
  const surface = new ReefSurface();
  const sectors = 48, rows = 6;
  const layerSize = (sectors + 1) * (rows + 1);
  for (let layer = 0; layer < 2; layer++) for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    for (let segment = 0; segment <= sectors; segment++) {
      const angle = segment / sectors * TAU;
      const scallop = 1 + Math.sin(angle * 7 + seed) * .073 + Math.cos(angle * 3 - seed) * .061;
      const radius = t * scallop;
      const fold = Math.sin(angle * 7 + seed) * .043 * t * t;
      const rib = Math.cos(angle * 24 + Math.sin(t * 4)) * .011 * t;
      const y = .055 + t * t * .17 + fold + rib - layer * (.045 - t * .023);
      const edge = THREE.MathUtils.smoothstep(t, .76, 1);
      surface.vertex(V(Math.cos(angle) * radius, y, Math.sin(angle) * radius * .89), (layer ? .70 : .88) + edge * .14 + rib * 2, edge * .08);
      if (row < rows && segment < sectors) {
        const a = layer * layerSize + row * (sectors + 1) + segment;
        if (layer) surface.quad(a, a + sectors + 1, a + sectors + 2, a + 1);
        else surface.quad(a, a + 1, a + sectors + 2, a + sectors + 1);
      }
    }
  }
  for (let segment = 0; segment < sectors; segment++) {
    const a = rows * (sectors + 1) + segment;
    surface.quad(a, a + 1, a + layerSize + 1, a + layerSize);
  }
  return surface.finish(sectors + 1);
}

/** A tapered organic branch, including its rounded tip, in world coordinates. */
export function createCoralBranchGeometry(a: THREE.Vector3, b: THREE.Vector3, radius: number, bend = .07) {
  const direction = b.clone().sub(a), length = direction.length();
  const side = direction.clone().cross(Math.abs(direction.y) > length * .9 ? V(1, 0, 0) : V(0, 1, 0)).normalize();
  const across = direction.clone().normalize().cross(side).normalize();
  const lower = a.clone().lerp(b, .32).addScaledVector(side, length * bend * .8);
  const upper = a.clone().lerp(b, .72).addScaledVector(side, length * bend * 1.4).addScaledVector(across, length * bend * .32);
  const curve = new THREE.CubicBezierCurve3(a, lower, upper, b);
  const surface = new ReefSurface();
  const bodySegments = 7, capSegments = 4, sides = 8;
  const capRadius = Math.min(radius * .66, length * .2);
  const bodyEnd = 1 - capRadius / Math.max(length, .0001);
  const capCenter = curve.getPoint(bodyEnd), capAxis = curve.getTangent(bodyEnd);
  for (let ring = 0; ring <= bodySegments + capSegments; ring++) {
    const isCap = ring > bodySegments;
    const t = Math.min(ring / bodySegments, 1) * bodyEnd;
    const capAngle = Math.max(0, ring - bodySegments) / capSegments * Math.PI * .5;
    const point = isCap ? capCenter.clone().addScaledVector(capAxis, Math.sin(capAngle) * capRadius) : curve.getPoint(t);
    const tangent = isCap ? capAxis : curve.getTangent(t);
    const u = side.clone().cross(tangent).normalize(), v = tangent.clone().cross(u).normalize();
    // The cap occupies one tip radius along the axis. Its closely spaced rings
    // preserve a blunt rounded end instead of tapering a long segment to a spike.
    const ringRadius = isCap ? capRadius * Math.cos(capAngle) : THREE.MathUtils.lerp(radius, capRadius, t / bodyEnd);
    for (let sideIndex = 0; sideIndex <= sides; sideIndex++) {
      const theta = sideIndex / sides * TAU;
      const r = ringRadius * (1 + Math.sin(theta * 3 + t * 8) * .025 * Math.cos(capAngle));
      surface.vertex(point.clone().addScaledVector(u, Math.cos(theta) * r).addScaledVector(v, Math.sin(theta) * r), .86 + t * .16);
      if (ring < bodySegments + capSegments && sideIndex < sides) {
        const index = ring * (sides + 1) + sideIndex;
        surface.quad(index, index + 1, index + sides + 2, index + sides + 1);
      }
    }
  }
  return surface.finish(sides + 1);
}

/** Compact curved twigs let whole colonies share a single instanced mesh. */
function reefTwig(surface: ReefSurface, a: THREE.Vector3, b: THREE.Vector3, radius: number, tip = .56, shade = 1, rings = 4, sides = 8) {
  const length = a.distanceTo(b);
  const axis = b.clone().sub(a).normalize();
  const u = axis.clone().cross(Math.abs(axis.y) > .92 ? V(1, 0, 0) : V(0, 1, 0)).normalize();
  const v = axis.clone().cross(u).normalize();
  const start = surface.positions.length / 3;
  const capRings = sides >= 8 ? 3 : 1;
  const tipRadius = Math.min(radius * tip, length * .19);
  const bodyLength = length - tipRadius;
  const end = b.clone().addScaledVector(axis, -tipRadius);
  for (let row = 0; row <= rings + capRings; row++) {
    const t = Math.min(row / rings, 1), cap = Math.max(0, row - rings) / capRings * Math.PI * .5;
    const center = row <= rings
      ? a.clone().lerp(end, t).addScaledVector(u, Math.sin(t * Math.PI) * radius * .65)
      : end.clone().addScaledVector(axis, Math.sin(cap) * tipRadius);
    const r = row <= rings ? THREE.MathUtils.lerp(radius, tipRadius, t) : Math.cos(cap) * tipRadius;
    const tangent = axis.clone().multiplyScalar(bodyLength)
      .addScaledVector(u, Math.cos(t * Math.PI) * radius * .65 * Math.PI).normalize();
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * TAU;
      const radial = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
      const polyp = 1 + Math.sin(angle * 3 + t * 11) * .017;
      const index = surface.vertex(center.clone().addScaledVector(radial, r * polyp), shade * (.82 + t * .19 + Math.sin(cap) * .04));
      // Analytic normals join both sides of the UV seam and keep the living
      // growth tip round; a single conical cap reads as a cut pencil nearby.
      const normal = row <= rings
        ? radial.clone().addScaledVector(tangent, (radius - tipRadius) / Math.max(.001, bodyLength)).normalize()
        : radial.clone().multiplyScalar(Math.cos(cap)).addScaledVector(axis, Math.sin(cap)).normalize();
      surface.normalOverrides.set(index, normal);
      if (row < rings + capRings && side < sides) {
        const index = start + row * (sides + 1) + side;
        surface.quad(index, index + 1, index + sides + 2, index + sides + 1);
      }
    }
  }
}

/** Acropora grows outward, then upward into a dense canopy of pale living tips. */
export function createStaghornGeometry(seed: number) {
  const surface = new ReefSurface();
  const random = (n: number) => { const value = Math.sin(seed * 71.31 + n * 127.1) * 43758.5453; return value - Math.floor(value); };
  for (let stalk = 0; stalk < 19; stalk++) {
    const angle = stalk * 2.399963 + seed;
    const reach = .24 + Math.sqrt(stalk / 19) * .65;
    const base = V(Math.cos(angle) * .07, .025, Math.sin(angle) * .07);
    const shoulder = V(Math.cos(angle) * reach * .64, .20 + random(stalk) * .14, Math.sin(angle) * reach * .64);
    const crown = V(Math.cos(angle) * reach, .52 + random(stalk + 31) * .28, Math.sin(angle) * reach);
    reefTwig(surface, base, shoulder, .055, .8, .83);
    reefTwig(surface, shoulder, crown, .041, .56);
    for (let twig = 0; twig < 4; twig++) {
      const t = .28 + twig * .16;
      const origin = shoulder.clone().lerp(crown, t);
      const yaw = angle + (twig % 2 ? -1 : 1) * (1.0 + random(stalk + twig + 83) * .5);
      const end = origin.clone().add(V(Math.cos(yaw) * (.13 + t * .10), .19 + random(stalk * 4 + twig + 131) * .13, Math.sin(yaw) * (.13 + t * .10)));
      reefTwig(surface, origin, end, .025, .53, 1.02);
      if (twig > 1) reefTwig(surface, end.clone().lerp(origin, .42), end.clone().add(V(Math.cos(yaw + 1.1) * .10, .085, Math.sin(yaw + 1.1) * .10)), .016, .50, 1.07);
    }
  }
  return surface.finish();
}

/** A sponge has a rolled osculum and a shaded inner wall, never a solid cap. */
export function createSpongeGeometry(seed: number, barrel = false) {
  const surface = new ReefSurface();
  const sides = 40, rows = 12, ringSize = sides + 1;
  const lean = V(Math.sin(seed * 2.7) * .085, 0, Math.cos(seed) * .055);
  const radiusAt = (t: number, angle: number) => {
    const profile = barrel ? .36 + Math.sin(t * Math.PI * .91) * .21 - t * .05 : .13 + t * .052 + Math.sin(t * Math.PI) * .045;
    return profile * (1 + Math.sin(angle * 7 + t * 4 + seed) * .043 + Math.cos(angle * 13 + seed) * .022);
  };
  // The outer skin returns over the lip and down the inside of the chimney.
  for (let layer = 0; layer < 2; layer++) for (let row = 0; row <= rows; row++) {
    const t = row / rows, height = layer ? 1 - t * .79 : t;
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * TAU;
      const radius = layer ? radiusAt(height, angle) - (barrel ? .073 : .038) : radiusAt(height, angle);
      const rim = Math.sin(angle * 5 + seed) * .023 * height * height;
      const pleat = Math.sin(angle * (barrel ? 20 : 14) + Math.sin(height * 7 + seed)) * .013;
      const pigment = Math.sin(angle * 21 + height * 59) * Math.cos(angle * 13 - height * 37) * .055;
      const illumination = layer ? .84 - t * .63 : .79 + height * .18 + pleat * 4;
      surface.vertex(V(Math.cos(angle) * (radius + pleat), height + rim + .018, Math.sin(angle) * (radius + pleat)).addScaledVector(lean, height * height), illumination + pigment, .15);
      if (row < rows && side < sides) {
        const index = layer * (rows + 1) * ringSize + row * ringSize + side;
        surface.quad(index, index + ringSize, index + ringSize + 1, index + 1);
      }
    }
  }
  for (let side = 0; side < sides; side++) {
    const outer = rows * ringSize + side, inner = (rows + 1) * ringSize + side;
    surface.quad(outer, inner, inner + 1, outer + 1);
  }
  const innerBottom = surface.vertex(V(lean.x * .04, .22, lean.z * .04), .18);
  const start = (2 * rows + 1) * ringSize;
  for (let side = 0; side < sides; side++) surface.indices.push(start + side, start + side + 1, innerBottom);
  return surface.finish(ringSize);
}

/** Fine open gorgonian lattice, with unequal lobes and a gently twisted plane. */
export function createSeaFanGeometry(seed: number) {
  const surface = new ReefSurface();
  const rays = 27;
  const point = (ray: number, t: number) => {
    const a = -.99 + ray / (rays - 1) * 1.98;
    const reach = .93 + Math.sin(ray * 1.77 + seed) * .05 + Math.sin(a * 4 + seed) * .065;
    return V(Math.sin(a) * reach * t, .25 + Math.cos(a) * reach * t, Math.sin(a * 3 + t * 4 + seed) * .053 * t);
  };
  reefTwig(surface, V(), V(.015, .29, 0), .046, .62, .64);
  for (let ray = 0; ray < rays; ray++) {
    let previous = V(.015, .25, 0);
    for (let segment = 1; segment <= 8; segment++) {
      const t = segment / 8;
      const next = point(ray, t);
      reefTwig(surface, previous, next, .0125 * (1 - t * .53), .89, .94 + t * .13, 1, 4);
      if (ray < rays - 1 && segment > 2 && (ray + segment) % 9 !== 0) {
        const neighbor = point(ray + 1, t + Math.sin(ray * 2 + seed) * .022);
        reefTwig(surface, next, neighbor, .0045, .86, 1.08, 1, 4);
        if (segment > 4) reefTwig(surface, previous.clone().lerp(next, .52), point(ray + 1, t - .058), .0036, .86, 1.02, 1, 4);
      }
      previous = next;
    }
  }
  return surface.finish();
}

/** A scallop valve with raised radial ribs, a rolled lip and a concave back. */
export function createScallopGeometry(seed: number) {
  const surface = new ReefSurface();
  const sectors = 48, rows = 8, layerSize = (sectors + 1) * (rows + 1);
  for (let layer = 0; layer < 2; layer++) for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    for (let segment = 0; segment <= sectors; segment++) {
      const s = segment / sectors, a = -1.25 + s * 2.5;
      const rib = Math.cos(s * Math.PI * 24);
      const radius = t * (1 + rib * .025 * t + Math.sin(s * Math.PI * 2 + seed) * .025);
      const arch = Math.sin(t * Math.PI * .9) * .22 * Math.sin(s * Math.PI);
      const y = arch + rib * .015 * Math.sin(t * Math.PI * .7) - layer * .037;
      const growth = Math.cos(t * 32 + seed) * .014;
      surface.vertex(V(Math.sin(a) * radius, y, Math.cos(a) * radius), (layer ? .76 : .91) + rib * .046 + growth, .18 + t * .12);
      if (row < rows && segment < sectors) {
        const index = layer * layerSize + row * (sectors + 1) + segment;
        if (layer) surface.quad(index, index + 1, index + sectors + 2, index + sectors + 1);
        else surface.quad(index, index + sectors + 1, index + sectors + 2, index + 1);
      }
    }
  }
  for (let segment = 0; segment < sectors; segment++) {
    const index = rows * (sectors + 1) + segment;
    surface.quad(index, index + layerSize, index + layerSize + 1, index + 1);
  }
  return surface.finish();
}

/** Five gently bent, cushioned arms blend into one continuous starfish body. */
export function createSeaStarGeometry(seed: number) {
  const surface = new ReefSurface();
  const sides = 80, rows = 6, layerSize = (sides + 1) * (rows + 1);
  for (let layer = 0; layer < 2; layer++) for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * TAU, wave = (1 + Math.cos(angle * 5)) * .5;
      const arm = Math.pow(wave, 3.6);
      const radius = t * (.33 + arm * (.64 + Math.sin(angle * 3 + seed) * .08));
      const twist = angle + Math.sin(angle * 5 + seed) * .035 * t;
      const dome = Math.pow(Math.max(0, 1 - t * t), .62);
      const pores = Math.sin(angle * 30 + t * 18) * Math.sin(t * 45) * .006 * dome;
      const y = layer ? -.026 * dome : dome * (.15 - arm * t * .075) + pores;
      surface.vertex(V(Math.cos(twist) * radius, y, Math.sin(twist) * radius), (layer ? .72 : .94) + dome * .08 + pores * 2, .24);
      if (row < rows && side < sides) {
        const index = layer * layerSize + row * (sides + 1) + side;
        if (layer) surface.quad(index, index + sides + 1, index + sides + 2, index + 1);
        else surface.quad(index, index + 1, index + sides + 2, index + sides + 1);
      }
    }
  }
  return surface.finish(sides + 1);
}
