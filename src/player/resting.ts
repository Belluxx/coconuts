import { Line3, Vector3 } from 'three/webgpu';
import { BUNGALOW, BUNGALOW_BED as bed, BUNGALOW_CHAIR as chair, BUNGALOW_VERANDA_CHAIR as verandaChair, bungalowFloorY, bungalowPoint } from '../structures/bungalowLayout';
import { PIER, PIER_BENCHES } from '../structures/pierLayout';
import { EYE_HEIGHT } from './collisions';

export type RestKind = 'sit' | 'lie';
type RestPose = { position: Vector3; yaw: number; pitch: number };
type ApproachArea = { x: readonly [number, number]; y: readonly [number, number]; z: readonly [number, number] };

/** A place to sit or lie down. Areas and poses are local to `origin`, rotated by `yaw` (radians). */
type RestSpot = {
  kind: RestKind;
  origin: Vector3;
  yaw: number;
  /** Clear standing eye positions from which this spot can be used. */
  approach: readonly ApproachArea[];
  pose: RestPose & {
    /** Optional end of a long seat; the player rests at the closest point on the segment. */
    end?: Vector3;
  };
};

export const REST_ACTIONS: Record<RestKind, { enter: string; leave: string }> = {
  sit: { enter: 'Sit down', leave: 'Stand up' },
  lie: { enter: 'Lie down', leave: 'Get up' },
};

const bungalow = { origin: bungalowPoint(0, bungalowFloorY, 0), yaw: BUNGALOW.yaw };
const standingY: readonly [number, number] = [EYE_HEIGHT - .25, EYE_HEIGHT + .25];

/** Add spots here using furniture layout anchors; controls need no furniture-specific code. */
const REST_SPOTS: readonly RestSpot[] = [
  {
    ...bungalow,
    kind: 'sit',
    // Reach the chair from the open side, between the little table and front railing.
    approach: [{ x: [verandaChair.x + .65, verandaChair.x + 1.25], y: standingY, z: [verandaChair.z - .25, verandaChair.z + .18] }],
    pose: { position: new Vector3(verandaChair.x, verandaChair.seatY + .83, verandaChair.z), yaw: 0, pitch: .08 },
  },
  {
    ...bungalow,
    kind: 'sit',
    approach: [{ x: [chair.x - .65, chair.x + 1], y: standingY, z: [chair.z - .65, chair.z + .65] }],
    pose: { position: new Vector3(chair.x, chair.seatY + .83, chair.z), yaw: Math.PI, pitch: -.12 },
  },
  {
    ...bungalow,
    kind: 'lie',
    // Approach from the aisle or foot, keeping prompts away from exterior walls.
    approach: [
      { x: [bed.x - 1.6, bed.x - .8], y: standingY, z: [bed.z - 1.1, bed.pillowZ - .3] },
      { x: [bed.x - 1, bed.x + 1], y: standingY, z: [bed.z - 2, bed.z - 1.05] },
    ],
    pose: { position: new Vector3(bed.x, bed.mattressY + .28, bed.pillowZ), yaw: 0, pitch: 1.05 },
  },
  ...PIER_BENCHES.map((bench): RestSpot => {
    const seatY = bench.seatY - PIER.deckY;
    const halfLength = bench.halfLength - .3;
    return {
      kind: 'sit',
      origin: new Vector3(bench.x, PIER.deckY, bench.z),
      yaw: bench.side * Math.PI / 2,
      approach: [{ x: [-bench.halfLength - .3, bench.halfLength + .3], y: [seatY + .9, seatY + 1.7], z: [-1.65, -.25] }],
      pose: {
        position: new Vector3(-halfLength, seatY + .83, 0),
        end: new Vector3(halfLength, seatY + .83, 0),
        yaw: 0, pitch: 0,
      },
    };
  }),
];

const UP = new Vector3(0, 1, 0);

/** The spot usable from a standing eye position; definition order breaks ties. */
export function findRestSpot(eye: Vector3): RestSpot | undefined {
  return REST_SPOTS.find(spot => {
    const dx = eye.x - spot.origin.x, dz = eye.z - spot.origin.z;
    const c = Math.cos(spot.yaw), s = Math.sin(spot.yaw);
    const x = dx * c - dz * s, y = eye.y - spot.origin.y, z = dx * s + dz * c;
    return spot.approach.some(area => x >= area.x[0] && x <= area.x[1]
      && y >= area.y[0] && y <= area.y[1] && z >= area.z[0] && z <= area.z[1]);
  });
}

/** The world-space resting pose, nearest to the eye along a long seat. */
export function getRestPose(spot: RestSpot, eye: Vector3): RestPose {
  const position = spot.pose.position.clone();
  if (spot.pose.end) {
    const localEye = eye.clone().sub(spot.origin).applyAxisAngle(UP, -spot.yaw);
    new Line3(spot.pose.position, spot.pose.end).closestPointToPoint(localEye, true, position);
  }
  position.applyAxisAngle(UP, spot.yaw).add(spot.origin);
  return { position, yaw: spot.yaw + spot.pose.yaw, pitch: spot.pose.pitch };
}
