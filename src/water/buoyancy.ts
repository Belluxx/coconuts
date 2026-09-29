import { MathUtils, type Object3D } from 'three/webgpu';

/** Fit the water under the hull, averaging out ripples smaller than the boat. */
export function floatHull(
  hull: Object3D, surfaceHeight: (x: number, z: number) => number,
  length: number, width: number, waterline: number, dt: number, heel = 0, motion = 1,
) {
  const yaw = hull.rotation.y, sin = Math.sin(yaw), cos = Math.cos(yaw);
  const across = width * .36, along = length * .4;
  let height = 0, pitch = 0, roll = 0;
  for (const fore of [-1, 0, 1]) for (const side of [-1, 0, 1]) {
    const x = hull.position.x + side * across * cos + fore * along * sin;
    const z = hull.position.z - side * across * sin + fore * along * cos;
    const water = surfaceHeight(x, z);
    height += water;
    pitch += water * fore;
    roll += water * side;
  }
  // Heave uses this frame's water; only angular motion has a little hull inertia.
  // YXZ keeps yaw independent of the local pitch/roll, including while steering.
  hull.position.y = waterline + height / 9;
  hull.rotation.set(
    MathUtils.damp(hull.rotation.x, -Math.atan(pitch / (6 * along)) * motion, 12, dt),
    yaw,
    MathUtils.damp(hull.rotation.z, (Math.atan(roll / (6 * across)) + heel) * motion, 10, dt),
    'YXZ',
  );
}
