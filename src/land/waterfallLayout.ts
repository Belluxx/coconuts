import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { Fn, If, atan, exp, float, max, smoothstep, vec2 } from 'three/tsl';
import { smoothstep as ease } from '../math';
import type { TSLNode } from '../shading';
import { terrainNoise } from './terrain';

/*
 * A spring-fed creek crosses a rock bench on the steep eastern hillside and
 * plunges into a horseshoe gorge it has cut into the slope. The plunge pool
 * has no outlet: a ring of boulders holds it, and the water seeps away
 * through the gravel beneath them.
 *
 * Distances are in a frame at the brink: `along` runs downstream (out of the
 * hill toward the lagoon), `across` to its left. Hydraulics set the shapes.
 */
const GRAVITY = 9.81;

/** Downstream and across-stream directions in the world's xz plane. */
export const FLOW = { x: -.75, z: -.6614 } as const;
export const ACROSS = { x: .6614, z: -.75 } as const;

/** The brink: a bedrock lip over which the creek spills. */
export const LIP = { x: 61.6, y: 14, z: 1.15, width: 2.4 } as const;
/** A small island stream in the wet season (m³/s). */
export const DISCHARGE = .45;
const unitDischarge = DISCHARGE / LIP.width;
const criticalDepth = Math.cbrt(unitDischarge ** 2 / GRAVITY);
/** At a free overfall the brink depth is 0.715 of critical depth (Rouse). */
export const BRINK = { depth: .715 * criticalDepth, speed: unitDischarge / (.715 * criticalDepth) } as const;

/** The pool stands where seepage through the gravel balances the inflow. */
export const POOL_LEVEL = 1.5;
/** Free fall from the brink to the pool, and where the nappe's centerline lands. */
export const FALL_HEIGHT = LIP.y - POOL_LEVEL;
export const FALL_TIME = Math.sqrt(2 * FALL_HEIGHT / GRAVITY);
export const IMPACT = BRINK.speed * FALL_TIME;
/** Plunge pool: an ellipse centred just past the impact, deepest beneath it. */
export const POOL = { along: 3.3, radiusAlong: 3.1, radiusAcross: 2.8, y: POOL_LEVEL } as const;
/** Horseshoe gorge: radius at the back, and the half-angle its walls wrap. */
export const GORGE = { back: 4.3, span: 1.95 } as const;
const FLOOR = POOL_LEVEL + .3;
/** The boulder rim on the pool's open side; past it the gravel fan falls to the beach. */
export const POOL_RIM = POOL.along + POOL.radiusAlong + 1;
/** The beach flat below the gorge's mouth. */
const BEACH = 1.02;

export const toWorld = (along: number, across: number) => ({
  x: LIP.x + FLOW.x * along + ACROSS.x * across, z: LIP.z + FLOW.z * along + ACROSS.z * across,
});
export function toLocal(x: number, z: number) {
  const dx = x - LIP.x, dz = z - LIP.z;
  return { along: dx * FLOW.x + dz * FLOW.z, across: dx * ACROSS.x + dz * ACROSS.z };
}
export const IMPACT_POINT = toWorld(IMPACT, 0);
export const POOL_CENTER = toWorld(POOL.along, 0);

/** Polar position about the gorge's center; angle 0 points at the brink. */
export function gorgePolar(along: number, across: number) {
  const back = along - GORGE.back;
  return { radius: Math.hypot(back, across), angle: Math.atan2(across, -back) };
}
/** Plan radius of the gorge wall: joints and slabs break its curve. */
export function gorgeRadius(angle: number) {
  const t = angle / GORGE.span;
  return GORGE.back * (1 + .22 * t * t) + .3 * Math.sin(3.1 * angle) + .14 * Math.sin(7.3 * angle);
}

/** A smooth watercourse centerline, sampled densely for nearest-point queries. */
function watercourse(points: [number, number][]) {
  const curve = new CatmullRomCurve3(points.map(([along, across]) => {
    const p = toWorld(along, across);
    return new Vector3(p.x, 0, p.z);
  }), false, 'centripetal');
  const length = curve.getLength(), count = Math.ceil(length / .05);
  const samples = Array.from({ length: count + 1 }, (_, i) => curve.getPointAt(i / count));
  const minX = Math.min(...samples.map(p => p.x)) - 4, maxX = Math.max(...samples.map(p => p.x)) + 4;
  const minZ = Math.min(...samples.map(p => p.z)) - 4, maxZ = Math.max(...samples.map(p => p.z)) + 4;
  return {
    length,
    /** Point and unit downstream tangent at a distance along the course. */
    at(s: number) {
      const t = Math.max(0, Math.min(1, s / length));
      const point = curve.getPointAt(t), tangent = curve.getTangentAt(t);
      return { x: point.x, z: point.z, tx: tangent.x, tz: tangent.z };
    },
    /** Distance along the course and from its centerline, or undefined when far away. */
    nearest(x: number, z: number) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) return undefined;
      let best = Infinity, index = 0;
      for (let i = 0; i < samples.length; i++) {
        const d = (samples[i].x - x) ** 2 + (samples[i].z - z) ** 2;
        if (d < best) { best = d; index = i; }
      }
      return { s: index / count * length, distance: Math.sqrt(best) };
    },
  };
}

/** From the spring at the back of the bench to the brink. */
export const CREEK = watercourse([[-7.2, 1.7], [-5.6, .6], [-4, 1.1], [-2.3, .2], [-.9, .05], [0, 0]]);
/** Rise of the creek bed from brink to spring; about a one-in-ten slope. */
const CREEK_FALL = .85;
export const creekBed = (s: number) => LIP.y + CREEK_FALL * (1 - s / CREEK.length);
/** The channel widens onto the flat bedrock slab of the brink. */
export const creekHalfWidth = (s: number) => .65 + .55 * (s / CREEK.length) ** 2;

/** Normalized radius in the pool's ellipse, with a weathered shoreline. */
export function poolRadius(along: number, across: number) {
  const angle = Math.atan2(across, along - POOL.along);
  const shore = 1 + Math.sin(angle * 3 + .5) * .05 + Math.sin(angle * 5) * .03;
  return Math.hypot((along - POOL.along) / POOL.radiusAlong, across / POOL.radiusAcross) / shore;
}

function gorgeFloor(x: number, z: number, along: number, across: number) {
  const pool = poolRadius(along, across);
  // Scour is deepest beneath the impact, where the plunging jet digs in.
  const impact = Math.hypot(along - IMPACT, across);
  const scour = (.2 + .9 * Math.exp(-((impact / 1.7) ** 2))) * (1 - ease(.55, 1.02, pool));
  const rubble = terrainNoise(x * 1.9, z * 1.7) * .07 * ease(1, 1.4, pool);
  // Past the boulder rim the gravel fan falls away to the beach.
  const fan = ease(POOL_RIM + .2, POOL_RIM + 3.5, along) * (FLOOR - BEACH);
  return POOL_LEVEL - scour + ease(.95, 1.5, pool) * (FLOOR - POOL_LEVEL) + rubble - fan;
}

/** The rock face stands in front of this radius; the terrain steps up behind it, clear of the undercut. */
export const gorgeInner = (angle: number) => gorgeRadius(angle) + 1.15 + .7 * Math.exp(-((angle / .55) ** 2));

/** The hillside above and around the gorge: a bench cut behind the brink, and the creek's channel across it. */
export function hillside(x: number, z: number, ground: number) {
  const { along, across } = toLocal(x, z);
  let height = ground;
  const upstream = -along;
  if (upstream > -3) {
    const outside = Math.hypot(Math.max(0, upstream - 7.8), Math.max(0, Math.abs(across) - 3.9 - Math.max(0, upstream) * .12));
    height = Math.min(height, LIP.y + .35 + .1 * Math.max(0, upstream) + outside * 1.35 + terrainNoise(x * .9, z * .9) * .12);
  }
  const creek = CREEK.nearest(x, z);
  if (creek && creek.distance < 3.5) {
    const width = creekHalfWidth(creek.s);
    height = Math.min(height, creekBed(creek.s) - .05 + ease(width * .5, width * 1.5, creek.distance) * .5);
  }
  return height;
}

/**
 * Sculpt the natural hillside: the bench and creek, the horseshoe gorge below
 * them, and the gravel fan through its mouth. The gorge's walls are a separate
 * rock mesh; the terrain steps up behind them.
 */
export function waterfallTerrain(x: number, z: number, ground: number) {
  if (x < 46 || x > 74 || z < -14 || z > 12) return ground;
  const { along, across } = toLocal(x, z);
  let height = hillside(x, z, ground);
  const { radius, angle } = gorgePolar(along, across);
  const mouth = ease(GORGE.span - .25, GORGE.span + .15, Math.abs(angle));
  const clamped = Math.max(-GORGE.span - .3, Math.min(GORGE.span + .3, angle));
  const inner = gorgeRadius(clamped) + (gorgeInner(clamped) - gorgeRadius(clamped)) * (1 - mouth);
  const blend = ease(inner, inner + .25 + 2.75 * mouth, radius);
  if (blend < 1) height = gorgeFloor(x, z, along, across) * (1 - blend) + height * blend;
  return height;
}

/** The sculpted area; terrain tiles covering it are built at the finest resolution. */
export const FALLS_BOUNDS = { minX: 46, maxX: 74, minZ: -14, maxZ: 12 } as const;

/** Gravel and sand floor between the gorge's walls, easing out through its mouth. */
export function gorgeFloorWeight(x: number, z: number) {
  const { along, across } = toLocal(x, z);
  const { radius, angle } = gorgePolar(along, across);
  const clamped = Math.max(-GORGE.span - .3, Math.min(GORGE.span + .3, angle));
  const mouth = ease(GORGE.span - .25, GORGE.span + .15, Math.abs(angle));
  const edge = gorgeRadius(clamped) + .9 * (1 - mouth);
  return 1 - ease(edge, edge + .3 + 2.5 * mouth, radius);
}

/** Spray keeps the ground near the impact damp. */
export function fallsSprayWetness(x: number, z: number) {
  return Math.exp(-Math.hypot(x - IMPACT_POINT.x, z - IMPACT_POINT.z) / 3.2);
}
/** Sand and gravel beside the creek and the pool, and the seep below the rim. */
export function fallsBedWetness(x: number, z: number) {
  if (x < 46 || x > 74 || z < -14 || z > 12) return 0;
  const { along, across } = toLocal(x, z);
  let wet = 1 - ease(1, 1.4, poolRadius(along, across));
  const near = CREEK.nearest(x, z);
  if (near) wet = Math.max(wet, 1 - ease(creekHalfWidth(near.s) * .9, creekHalfWidth(near.s) * 1.8, near.distance));
  return wet;
}

/** Water, and the curtain's footprint, that roots, stones and paths must keep clear of. */
export function inFallsWater(x: number, z: number, margin = 0) {
  if (x < 44 || x > 76 || z < -16 || z > 14) return false;
  const { along, across } = toLocal(x, z);
  if (poolRadius(along, across) < 1 + margin / 2.8) return true;
  if (along > -1 - margin && along < IMPACT + 1 + margin && Math.abs(across) < 1.9 + margin) return true;
  const near = CREEK.nearest(x, z);
  return !!near && near.distance < creekHalfWidth(near.s) + margin;
}
/** Inside the gorge, between its walls. */
export function inGorge(x: number, z: number, margin = 0) {
  const { along, across } = toLocal(x, z);
  const { radius, angle } = gorgePolar(along, across);
  return Math.abs(angle) < GORGE.span + .2 && radius < gorgeRadius(Math.max(-GORGE.span, Math.min(GORGE.span, angle))) + 1.2 + margin;
}

/** Shader mask of the plunge pool's water, for light that only its floor receives. */
export function poolMask(xz: TSLNode) {
  const offset = xz.sub(vec2(LIP.x, LIP.z));
  const along = offset.dot(vec2(FLOW.x, FLOW.z)).sub(POOL.along).div(POOL.radiusAlong);
  const across = offset.dot(vec2(ACROSS.x, ACROSS.z)).div(POOL.radiusAcross);
  return float(1).sub(smoothstep(.9, 1.1, vec2(along, across).length()));
}

/**
 * Spray wetness of a surface at a world position, for shaders: strongest at
 * the impact and on the rock just behind the curtain, drying with distance.
 */
export function sprayWetness(position: TSLNode) {
  const impact = vec2(IMPACT_POINT.x, IMPACT_POINT.z);
  const lip = vec2(LIP.x, LIP.z);
  const around = exp(position.xz.sub(impact).length().div(-3.2)).mul(float(1).sub(smoothstep(POOL_LEVEL + 2, POOL_LEVEL + 6, position.y)));
  // The rock face behind the curtain stays wet from the brink down.
  const behind = exp(position.xz.sub(lip).length().div(-1.6)).mul(float(1).sub(smoothstep(LIP.y, LIP.y + .8, position.y)));
  return max(around, behind).clamp(0, 1);
}

const center = toWorld(GORGE.back, 0);
/**
 * Elevation (radians) of the gorge's rim seen from a point along a horizontal
 * direction. The walls are tallest behind the brink and fall to nothing at
 * the mouth; outside the gorge nothing rises.
 */
export function gorgeHorizon(point: TSLNode, direction: TSLNode) {
  const q = point.xz.sub(vec2(center.x, center.z));
  const radius = GORGE.back * 1.15;
  const along = q.dot(direction);
  const reach = along.negate().add(along.mul(along).sub(q.dot(q)).add(radius * radius).max(0).sqrt());
  const exit = q.add(direction.mul(reach));
  const back = vec2(-FLOW.x, -FLOW.z);
  const height = smoothstep(-.35, .75, exit.normalize().dot(back)).mul(FALL_HEIGHT + .4).add(POOL_LEVEL).sub(point.y);
  const inside = float(1).sub(smoothstep(radius - .4, radius + .4, q.length()));
  return atan(height.max(0), reach.max(.05)).mul(inside);
}

/** Share of the sky's light that reaches a point past the gorge's walls; only points inside pay for it. */
export const gorgeSkyView = (point: TSLNode) => Fn(() => {
  const view = float(1).toVar();
  If(point.xz.sub(vec2(center.x, center.z)).length().lessThan(GORGE.back * 1.15 + .4), () => {
    let blocked: TSLNode = float(0);
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [.71, .71], [-.71, .71], [.71, -.71], [-.71, -.71]]) {
      blocked = blocked.add(gorgeHorizon(point, vec2(x, z)).sin().pow(2));
    }
    view.assign(float(1).sub(blocked.div(8)));
  });
  return view;
})();
