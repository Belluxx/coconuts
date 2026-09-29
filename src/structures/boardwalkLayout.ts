import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { groundHeight } from '../land/terrain';
import { smoothstep } from '../math';
import { PIER } from './pierLayout';

export interface BoardwalkFrame { center: Vector3; right: Vector3 }
export interface BoardwalkRoute {
  name: string;
  width: number;
  length: number;
  frames: BoardwalkFrame[];
}

function route(name: string, points: number[][]): BoardwalkRoute {
  const curve = new CatmullRomCurve3(points.map(([x, z]) => new Vector3(x, 0, z)), false, 'centripetal');
  curve.arcLengthDivisions = 1200;
  const length = curve.getLength(), count = Math.ceil(length / .24), width = 2.5;
  const frames = Array.from({ length: count + 1 }, (_, i) => {
    const center = curve.getPointAt(i / count), tangent = curve.getTangentAt(i / count);
    const right = new Vector3(tangent.z, 0, -tangent.x).normalize();
    let terrain = -Infinity;
    for (const side of [-1, -.5, 0, .5, 1]) {
      const edge = center.clone().addScaledVector(right, side * (width / 2 + .1));
      terrain = Math.max(terrain, groundHeight(edge.x, edge.z));
    }
    // Low, walk-on ends rise into a ventilated timber deck over the undergrowth.
    const fromEnd = Math.min(i, count - i) * length / count;
    center.y = terrain + .09 + smoothstep(0, 3, fromEnd) * .29;
    return { center, right };
  });
  // Lift hollows to give the carpentry a gentle continuous grade, never burying it.
  const rise = length / count * .48;
  for (let i = 1; i <= count; i++) frames[i].center.y = Math.max(frames[i].center.y, frames[i - 1].center.y - rise);
  for (let i = count - 1; i >= 0; i--) frames[i].center.y = Math.max(frames[i].center.y, frames[i + 1].center.y - rise);
  return { name, width, length, frames };
}

/** Authored paths and landscape clearances only; finished meshes supply all collisions. */
export const BOARDWALKS: BoardwalkRoute[] = [
  route('Palm trail', [[PIER.x, PIER.landZ + .02], [-24, 29], [-21, 37], [-16, 44], [-8, 51], [-2, 61], [-3, 73]]),
  route('Garden trail', [[19.5, 24.5], [20, 29], [18, 37], [12, 44], [8, 52], [9, 61], [12, 73]]),
];

export function boardwalkFrame(route: BoardwalkRoute, distance: number): BoardwalkFrame {
  const index = Math.max(0, Math.min(1, distance / route.length)) * (route.frames.length - 1);
  const a = Math.min(Math.floor(index), route.frames.length - 2), blend = index - a;
  return {
    center: route.frames[a].center.clone().lerp(route.frames[a + 1].center, blend),
    right: route.frames[a].right.clone().lerp(route.frames[a + 1].right, blend).normalize(),
  };
}

export function inBoardwalkClearing(x: number, z: number, margin = 0): boolean {
  for (const route of BOARDWALKS) {
    const radius = route.width / 2 + .25 + margin;
    for (let i = 0; i < route.frames.length - 1; i++) {
      const a = route.frames[i].center, b = route.frames[i + 1].center;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      if ((x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2 < radius * radius) return true;
    }
  }
  return false;
}
