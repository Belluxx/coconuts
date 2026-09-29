import { Vector3 } from 'three/webgpu';
import { groundHeight } from '../land/terrain';

/** Placement and furniture anchors. Walking surfaces come from the finished mesh. */
export const BUNGALOW = Object.freeze({ x: 10, z: 29, yaw: .18 });
export const BUNGALOW_CHAIR = Object.freeze({ x: -1.65, z: .31, seatY: .475 });
export const BUNGALOW_VERANDA_CHAIR = Object.freeze({ x: -2.09, z: -2.66, seatY: .505 });
export const BUNGALOW_BED = Object.freeze({ x: 1.35, z: 1.43, mattressY: .73, pillowZ: 2.12 });
export function bungalowPoint(x: number, y: number, z: number): Vector3 {
  const c = Math.cos(BUNGALOW.yaw), s = Math.sin(BUNGALOW.yaw);
  return new Vector3(BUNGALOW.x + x * c + z * s, y, BUNGALOW.z - x * s + z * c);
}
const landing = bungalowPoint(0, 0, -5.35);
export const bungalowFloorY = groundHeight(landing.x, landing.z) + 1.05;

export function inBungalowClearing(x: number, z: number, margin = 0): boolean {
  const dx = x - BUNGALOW.x, dz = z - BUNGALOW.z;
  const c = Math.cos(BUNGALOW.yaw), s = Math.sin(BUNGALOW.yaw);
  const localX = dx * c - dz * s, localZ = dx * s + dz * c;
  return Math.abs(localX) < 3.65 + margin && localZ > -5.65 - margin && localZ < 3.65 + margin;
}
