import * as THREE from 'three/webgpu';
import { time as shaderTime } from 'three/tsl';
import { seededRandom, smoothstep, TAU, V } from '../math';
import { BUNGALOW } from '../structures/bungalowLayout';
import { PIER } from '../structures/pierLayout';
import { createBirdGeometries } from './birdModel';
import type { Plant } from './plants';
import type { RockPlacement } from './rocks';
import { groundHeight, shoreZ } from './terrain';

const UP = V(0, 1, 0);
const BIRD_COUNT = 12;
const FOOT_HEIGHT = .225;
const GRAVITY = 9.81;
/** Terns fish by day and stay on their roosts after dusk. */
const DAYLIGHT = .25;
/** A perched tern lets people come this close before it flies. */
const FLIGHT_DISTANCE = 4.5;
/** Airspeed in metres per second, and the steepest bank of a turn. */
const CRUISE = 7.2;
const MAX_BANK = .9;
/** Terns keep this much air between themselves and the canopy, rocks, and roofs. */
const HEADROOM = 2.5;
/** The bay where terns fish: across the shore and out over the lagoon, in metres. */
const FISHING_X = 55;
const FISHING_OFFSHORE: [number, number] = [14, 70];

type Perch = {
  position: THREE.Vector3;
  kind: 'palm' | 'rock' | 'pier';
  /** Resting heading, and the open side a tern approaches from. */
  yaw: number; approach: THREE.Vector3;
  windPhase?: number; frondWeight?: number; windSeed?: number;
  owner?: Bird;
};

/**
 * perched: resting, looking about, preening.
 * flying: on an errand, steering by banked turns.
 * landing: a committed glide onto the reserved perch.
 */
type Mode = 'perched' | 'flying' | 'landing';
/** fish: patrol the bay, hover, and plunge. roost: return to a perch. */
type Errand = 'fish' | 'roost';

type Bird = {
  root: THREE.Group; parts: THREE.Object3D[]; scale: number; random: () => number;
  perch?: Perch;
  mode: Mode; errand: Errand;
  // Flight: heading, airspeed, climb rate and the bank that turns the bird.
  yaw: number; speed: number; vy: number; bank: number; pitch: number;
  goal: THREE.Vector3; goalUntil: number;
  /** An escape heading held for a few seconds after being flushed. */
  escapeUntil: number;
  fishingGround: THREE.Vector3; tripEnds: number;
  nextScan: number; hoverUntil: number; hover: number;
  /** 0 none, 1 plunging, 2 climbing out of the water. */
  dive: number;
  takeoff: number;
  // Landing glide, from where it began toward the moving perch.
  landFrom: THREE.Vector3; landVelocity: THREE.Vector3; landStart: number; landDuration: number; flare: number;
  restUntil: number; flushAt: number;
  // Pose.
  phase: number; flap: number; flapAmount: number; fold: number;
  look: number; lookTarget: number; nextLook: number;
};

/** The direction from the shore out to sea at a point on the bay. */
const seaward = (x: number) => V(-.022 * x, 0, -1).normalize();

/** Pier posts, the exposed tops of rock formations, and a seaward frond of each palm near the bay. */
function findPerches(plants: Plant[], rocks: { root: THREE.Object3D; placements: RockPlacement[] }) {
  const perches: Perch[] = [];
  // Pier posts are approached from open water beside the pier.
  for (const [x, z] of [[PIER.x + 4.3, -10.94], [PIER.x - 4.3, -10.94], [PIER.x + 1.72, 6.1], [PIER.x - 1.72, 10.1]]) {
    perches.push({ position: V(x, PIER.deckY + 1.127, z), kind: 'pier', yaw: 2.8, approach: V(Math.sign(x - PIER.x), 0, 0) });
  }
  rocks.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const skyY = new THREE.Box3().setFromObject(rocks.root).max.y + 2;
  const rockTops: THREE.Vector3[] = [];
  for (const { x, z, habitat } of rocks.placements) {
    if (Math.abs(x) > 90 || z > 60 || z < -40) continue;
    ray.set(V(x, skyY, z), V(0, -1, 0));
    const hit = ray.intersectObjects(rocks.root.children, true)[0];
    if (!hit) continue;
    rockTops.push(hit.point.clone());
    if (Math.abs(x) > 72 || z > 26 || z < -35 || habitat === 'falls') continue;
    // Only the first exposed surface can support a bird; a flatter face
    // underneath another formation is not an available landing place.
    if (!hit.face || hit.face.normal.y < .62 || hit.point.y < .55) continue;
    if (perches.some(perch => perch.position.distanceToSquared(hit.point) < 36)) continue;
    perches.push({ position: hit.point.clone().add(V(0, .014, 0)), kind: 'rock', yaw: 2.8, approach: seaward(x) });
  }
  for (const plant of plants) {
    if (plant.kind !== 'palm' || Math.abs(plant.x) > 60 || plant.z > 40) continue;
    // Reconstruct a seaward frond's midrib using the same seed and growth rule.
    const random = seededRandom(plant.seed), phase = random() * TAU;
    const count = plant.hero ? 12 : 11;
    let best: Perch | undefined, bestFacing = 0;
    for (let f = 0; f < count; f++) {
      const age = f / (count - 1), angle = phase + f * 2.3999632297;
      const length = plant.height * (.46 + random() * .085) * (.85 + age * .15);
      const width = length * (.225 + random() * .025);
      if (f < 4 || Math.sin(angle) > bestFacing) continue;
      bestFacing = Math.sin(angle);
      const t = .5, rise = length * (.51 - age * .33), droop = length * (.04 + age * .5);
      const frond = (leafT: number) => {
        const u = .075 + leafT * .925;
        return V(plant.x + (plant.leanX ?? 0) + Math.cos(angle) * length * u,
          plant.y + plant.height + .2 - age * .23 + Math.sin(u * Math.PI * .86) * rise - droop * u * u,
          plant.z + (plant.leanZ ?? 0) + Math.sin(angle) * length * u);
      };
      const normal = V(-Math.sin(angle), 0, Math.cos(angle)).cross(frond(.51).sub(frond(.49))).normalize();
      if (normal.y < 0) normal.negate();
      // splitBlade raises its folded leaf web above the woody rachis. The
      // toes sit on that visible ridge, including its own flutter weights.
      const position = frond(t).addScaledVector(normal, width * .98 * .21).add(V(0, .012, 0));
      best = {
        position, kind: 'palm', yaw: Math.atan2(Math.cos(angle), Math.sin(angle)),
        // Come in along the frond, from beyond its tip.
        approach: V(Math.cos(angle), 0, Math.sin(angle)),
        windPhase: plant.x * .071 + plant.z * .053 + (plant.seed % 1000) * .00628 * .12,
        frondWeight: t ** 1.6 * .8, windSeed: (plant.seed % 1000) * .00628,
      };
    }
    if (best) perches.push(best);
  }
  return { perches, rockTops };
}

const SKY_CELL = 2, SKY_MIN_X = -140, SKY_MIN_Z = -60, SKY_COLUMNS = 141, SKY_ROWS = 101;

/** The height of everything solid on the island: ground, crowns, rocks and roofs. */
function createAirspace(plants: Plant[], rockTops: THREE.Vector3[]) {
  const top = new Float32Array(SKY_COLUMNS * SKY_ROWS);
  for (let row = 0; row < SKY_ROWS; row++) for (let column = 0; column < SKY_COLUMNS; column++) {
    top[row * SKY_COLUMNS + column] = Math.max(0, groundHeight(SKY_MIN_X + column * SKY_CELL, SKY_MIN_Z + row * SKY_CELL));
  }
  const raise = (x: number, z: number, radius: number, height: number) => {
    const reach = radius + SKY_CELL;
    const minColumn = Math.max(0, Math.floor((x - reach - SKY_MIN_X) / SKY_CELL));
    const maxColumn = Math.min(SKY_COLUMNS - 1, Math.ceil((x + reach - SKY_MIN_X) / SKY_CELL));
    const minRow = Math.max(0, Math.floor((z - reach - SKY_MIN_Z) / SKY_CELL));
    const maxRow = Math.min(SKY_ROWS - 1, Math.ceil((z + reach - SKY_MIN_Z) / SKY_CELL));
    for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
      const cx = SKY_MIN_X + column * SKY_CELL, cz = SKY_MIN_Z + row * SKY_CELL;
      if (Math.hypot(cx - x, cz - z) > reach) continue;
      const index = row * SKY_COLUMNS + column;
      top[index] = Math.max(top[index], height);
    }
  };
  for (const plant of plants) {
    if (plant.height < 1.5) continue;
    const palm = plant.kind === 'palm';
    raise(plant.x + (plant.leanX ?? 0), plant.z + (plant.leanZ ?? 0), palm ? plant.height * .5 : plant.radius, plant.y + plant.height * (palm ? 1.15 : 1.05) + .3);
  }
  for (const rock of rockTops) raise(rock.x, rock.z, 3, rock.y);
  raise(PIER.x, (PIER.seaZ + PIER.headLandZ) / 2, PIER.headWidth * .75, PIER.deckY + 5);
  raise(BUNGALOW.x, BUNGALOW.z, 9, groundHeight(BUNGALOW.x, BUNGALOW.z) + 8);

  /** Conservative: the highest of the four surrounding cells. */
  return (x: number, z: number) => {
    const column = Math.floor((x - SKY_MIN_X) / SKY_CELL), row = Math.floor((z - SKY_MIN_Z) / SKY_CELL);
    if (column < 0 || row < 0 || column >= SKY_COLUMNS - 1 || row >= SKY_ROWS - 1) return Math.max(0, groundHeight(x, z));
    const index = row * SKY_COLUMNS + column;
    return Math.max(top[index], top[index + 1], top[index + SKY_COLUMNS], top[index + SKY_COLUMNS + 1]);
  };
}

/** Twelve terns share ten sculpted, articulated geometry parts. */
export function createBirds(plants: Plant[], rocks: { root: THREE.Object3D; placements: RockPlacement[] }) {
  const root = new THREE.Group(); root.name = 'Island terns · fishing trips and roosts';
  const geometries = createBirdGeometries();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .85, side: THREE.DoubleSide, vertexColors: true });
  const batches = geometries.map((geometry, i) => {
    const mesh = new THREE.InstancedMesh(geometry, material, BIRD_COUNT);
    mesh.name = `Terns · ${['bodies', 'heads', 'tails', 'left arms', 'left primaries', 'right arms', 'right primaries', 'feet', 'left folded feathers', 'right folded feathers'][i]}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.count = 0;
    root.add(mesh); return mesh;
  });
  const birds: Bird[] = [];
  const { perches, rockTops } = findPerches(plants, rocks);
  const skyline = createAirspace(plants, rockTops);
  let initialized = false, lastSeconds: number | undefined, time = 0;
  const target = V(), velocity = V(), scratch = V();
  const orientation = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function perchPosition(perch: Perch, scale: number, output: THREE.Vector3) {
    output.copy(perch.position); output.y += FOOT_HEIGHT * scale;
    if (perch.windPhase !== undefined) {
      const phase = perch.windPhase, windTime = (shaderTime as unknown as THREE.UniformNode<number>).value;
      const gust = (Math.sin(windTime * .84 + phase) * .68 + Math.sin(windTime * .37 - phase * .63) * .32) * .19;
      const frond = Math.sin(windTime * 1.19 + phase) * (perch.frondWeight ?? 0) * .16;
      const flutter = Math.sin(windTime * 3.5 + perch.position.x * .8 + perch.position.z * .65 + (perch.windSeed ?? 0)) * .25 * .045;
      output.x += gust + frond + flutter; output.y += frond * .2 + flutter * .35; output.z += gust * .56 + frond * .38;
    }
    return output;
  }

  /** The point in open air from which the final glide onto a perch begins. */
  function approachPoint(perch: Perch, output: THREE.Vector3) {
    output.copy(perch.position).addScaledVector(perch.approach, 9);
    output.y = Math.max(perch.position.y + 3.2, skyline(output.x, output.z) + HEADROOM);
    return output;
  }

  function choosePerch(bird: Bird, player: THREE.Vector3) {
    const position = bird.root.position;
    const choices = perches
      .filter(perch => !perch.owner && perch.position.distanceToSquared(player) > 7.5 ** 2)
      .sort((a, b) => a.position.distanceToSquared(position) - b.position.distanceToSquared(position))
      .slice(0, 5);
    const perch = choices[Math.floor(bird.random() * choices.length)];
    if (bird.perch?.owner === bird) bird.perch.owner = undefined;
    bird.perch = perch;
    if (perch) perch.owner = bird;
  }

  function chooseFishingGround(bird: Bird) {
    const x = (bird.random() * 2 - 1) * FISHING_X;
    const offshore = FISHING_OFFSHORE[0] + bird.random() * (FISHING_OFFSHORE[1] - FISHING_OFFSHORE[0]);
    bird.fishingGround.set(x, 0, shoreZ(x) - offshore);
    bird.tripEnds = time + 35 + bird.random() * 50;
  }

  function patrol(bird: Bird) {
    const angle = bird.random() * TAU, radius = 4 + bird.random() * 12;
    bird.goal.set(bird.fishingGround.x + Math.cos(angle) * radius, 5 + bird.random() * 4.5, bird.fishingGround.z + Math.sin(angle) * radius);
    bird.goalUntil = time + 12;
  }

  function depart(bird: Bird, player: THREE.Vector3, daylight: number, flushed: boolean) {
    const position = bird.root.position;
    if (bird.perch?.owner === bird) bird.perch.owner = undefined;
    bird.mode = 'flying';
    bird.takeoff = 1.2;
    bird.speed = 1; bird.vy = 1.4; bird.bank = 0;
    // Leave away from the intruder, otherwise out to sea.
    const away = seaward(position.x);
    if (flushed) {
      scratch.copy(position).sub(player).setY(0);
      if (scratch.lengthSq() > .01) away.lerp(scratch.normalize(), .7).normalize();
    }
    bird.goal.copy(position).addScaledVector(away, 16).addScaledVector(UP, 6);
    bird.escapeUntil = time + (flushed ? 3.5 : 2);
    if (daylight > DAYLIGHT) {
      bird.errand = 'fish';
      chooseFishingGround(bird);
      if (flushed) bird.tripEnds = time + 12 + bird.random() * 20;
    } else bird.errand = 'roost';
    bird.perch = undefined;
    if (!flushed) return;
    // Alarm spreads: nearby roosting birds usually go up together.
    for (const other of birds) {
      if (other.mode !== 'perched' || other.root.position.distanceToSquared(position) > 64) continue;
      if (other.random() < .7) other.flushAt = Math.min(other.flushAt, time + .15 + other.random() * .5);
    }
  }

  function beginLanding(bird: Bird) {
    bird.mode = 'landing';
    bird.landFrom.copy(bird.root.position);
    bird.landVelocity.set(Math.sin(bird.yaw) * bird.speed, bird.vy, Math.cos(bird.yaw) * bird.speed);
    perchPosition(bird.perch!, bird.scale, target);
    const distance = target.distanceTo(bird.landFrom);
    bird.landDuration = THREE.MathUtils.clamp(distance / Math.max(1.5, (bird.speed + 1) * .5) * 1.15, 1.2, 5);
    bird.landStart = time;
  }

  /** Decide where the bird is heading this moment. */
  function chooseGoal(bird: Bird, player: THREE.Vector3, daylight: number) {
    const position = bird.root.position;
    if (time < bird.escapeUntil) return;
    if (bird.errand === 'fish' && (time > bird.tripEnds || daylight < DAYLIGHT)) {
      bird.errand = 'roost';
      bird.dive = 0; bird.hoverUntil = 0;
    }
    if (bird.errand === 'roost') {
      if (!bird.perch || bird.perch.position.distanceToSquared(player) < 6 ** 2) choosePerch(bird, player);
      if (!bird.perch) {
        // Every roost is taken or disturbed: keep circling the bay.
        bird.errand = 'fish';
        chooseFishingGround(bird);
        return;
      }
      approachPoint(bird.perch, bird.goal);
      if (position.distanceTo(bird.goal) > 3.5) return;
      // Land only when already heading in toward the perch; otherwise swing
      // back out along the approach and line up again.
      const toX = bird.perch.position.x - position.x, toZ = bird.perch.position.z - position.z;
      if ((Math.sin(bird.yaw) * toX + Math.cos(bird.yaw) * toZ) / Math.max(Math.hypot(toX, toZ), .01) > .5) beginLanding(bird);
      else {
        bird.goal.addScaledVector(bird.perch.approach, 12);
        bird.escapeUntil = time + 2.5;
      }
      return;
    }

    // Fishing: patrol, stop to hover over prey, and sometimes plunge.
    if (bird.dive === 1) {
      bird.goal.set(position.x + Math.sin(bird.yaw) * 2, .12, position.z + Math.cos(bird.yaw) * 2);
      if (position.y < .25) {
        bird.dive = 2; bird.takeoff = 1; bird.vy = .6;
        bird.goal.set(position.x + Math.sin(bird.yaw) * 12, 6.5, position.z + Math.cos(bird.yaw) * 12);
      }
      return;
    }
    if (bird.dive === 2) {
      if (position.y > 4) { bird.dive = 0; patrol(bird); }
      return;
    }
    if (bird.hoverUntil > time) return;
    if (bird.hoverUntil > 0) {
      // The end of a hover: dive on the prey, or give up and move on.
      bird.hoverUntil = 0;
      if (bird.random() < .55) bird.dive = 1; else patrol(bird);
      bird.nextScan = time + 4 + bird.random() * 6;
      return;
    }
    if (time > bird.nextScan && position.y > 3.5) {
      bird.nextScan = time + 4 + bird.random() * 6;
      if (bird.random() < .5) {
        bird.hoverUntil = time + 1.2 + bird.random() * 1.6;
        bird.goal.set(position.x + Math.sin(bird.yaw), position.y, position.z + Math.cos(bird.yaw));
        return;
      }
    }
    const arrived = Math.hypot(bird.goal.x - position.x, bird.goal.z - position.z) < 4;
    if (arrived || time > bird.goalUntil) patrol(bird);
  }

  /** Banked-turn flight: roll sets the turn rate, flapping sets speed and climb. */
  function fly(bird: Bird, dt: number, player: THREE.Vector3) {
    const position = bird.root.position;
    let wishX = bird.goal.x - position.x, wishZ = bird.goal.z - position.z;
    const goalDistance = Math.max(Math.hypot(wishX, wishZ), .01);
    wishX /= goalDistance; wishZ /= goalDistance;
    let lift = 0;
    for (const other of birds) {
      if (other === bird || other.mode === 'perched') continue;
      const dx = position.x - other.root.position.x, dy = position.y - other.root.position.y, dz = position.z - other.root.position.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 3 || distance < .01) continue;
      const push = (1 - distance / 3) * 1.5 / distance;
      wishX += dx * push; wishZ += dz * push; lift += dy * push;
    }
    const nearPlayer = 1 - smoothstep(2, 6, position.distanceTo(player));
    lift += nearPlayer * 3;

    const hovering = bird.hoverUntil > time;
    bird.hover = THREE.MathUtils.damp(bird.hover, hovering ? 1 : 0, 3, dt);
    const error = Math.atan2(Math.sin(Math.atan2(wishX, wishZ) - bird.yaw), Math.cos(Math.atan2(wishX, wishZ) - bird.yaw));
    if (bird.speed < 2.5) {
      // Slow flight turns directly, with the wings; no banking.
      bird.yaw += THREE.MathUtils.clamp(error * 2, -1.8, 1.8) * dt;
      bird.bank = THREE.MathUtils.damp(bird.bank, 0, 4, dt);
    } else {
      bird.bank = THREE.MathUtils.damp(bird.bank, THREE.MathUtils.clamp(error * 1.3, -MAX_BANK, MAX_BANK), 5, dt);
      bird.yaw += GRAVITY * Math.tan(bird.bank) / bird.speed * dt;
    }

    // Slow down to tighten a turn close to the goal.
    const tightTurn = (1 - smoothstep(6, 14, goalDistance)) * smoothstep(.6, 2.2, Math.abs(error)) * .45;
    const targetSpeed = hovering ? .3 : bird.dive === 1 ? 3 : CRUISE * (bird.errand === 'roost' ? .9 : 1) * (1 - tightTurn);
    const accel = targetSpeed > bird.speed ? 3 + bird.takeoff * 2 : 2.5;
    bird.speed += THREE.MathUtils.clamp(targetSpeed - bird.speed, -accel * dt, accel * dt);

    const headX = Math.sin(bird.yaw), headZ = Math.cos(bird.yaw);
    const floor = Math.max(skyline(position.x, position.z), skyline(position.x + headX * 7, position.z + headZ * 7),
      skyline(position.x + headX * 14, position.z + headZ * 14)) + HEADROOM;
    const targetY = bird.dive === 1 ? bird.goal.y : Math.max(bird.goal.y + lift, floor);
    const climb = bird.dive === 1 ? -7.5 : THREE.MathUtils.clamp((targetY - position.y) * .9, -3, 2.6);
    bird.vy = THREE.MathUtils.damp(bird.vy, climb, bird.dive === 1 ? 5 : 3, dt);
    position.x += Math.sin(bird.yaw) * bird.speed * dt;
    position.z += Math.cos(bird.yaw) * bird.speed * dt;
    // Climb hard out of any canopy; only a plunge comes down to the water.
    if (!bird.dive && position.y < skyline(position.x, position.z) + .8) bird.vy = Math.max(bird.vy, 2.6);
    position.y = Math.max(position.y + bird.vy * dt, .1, groundHeight(position.x, position.z) + .2);
    bird.takeoff = Math.max(0, bird.takeoff - dt);

    const pitch = THREE.MathUtils.clamp(-Math.atan2(bird.vy, Math.max(bird.speed, 2)), -.6, 1.3) - bird.hover * .45;
    bird.pitch = THREE.MathUtils.damp(bird.pitch, pitch, 6, dt);
    euler.set(bird.pitch, bird.yaw, -bird.bank);
    orientation.setFromEuler(euler);
    bird.root.quaternion.slerp(orientation, 1 - Math.exp(-dt * 10));
  }

  /** A cubic glide from the bird's flight path onto the perch, arriving slow and level. */
  function land(bird: Bird, dt: number, player: THREE.Vector3) {
    const perch = bird.perch!;
    const s = Math.min(1, (time - bird.landStart) / bird.landDuration), T = bird.landDuration;
    if (s < .7 && perch.position.distanceToSquared(player) < 3.5 ** 2) {
      // Pull up and look for somewhere quieter.
      bird.mode = 'flying';
      bird.escapeUntil = time + 1.5;
      bird.goal.copy(bird.root.position).addScaledVector(UP, 5).addScaledVector(perch.approach, 8);
      choosePerch(bird, player);
      return;
    }
    perchPosition(perch, bird.scale, target);
    const arrival = scratch.copy(perch.approach).multiplyScalar(-.9).setY(-.25);
    const s2 = s * s, s3 = s2 * s;
    const position = bird.root.position;
    position.copy(bird.landFrom).multiplyScalar(2 * s3 - 3 * s2 + 1)
      .addScaledVector(bird.landVelocity, (s3 - 2 * s2 + s) * T)
      .addScaledVector(target, -2 * s3 + 3 * s2)
      .addScaledVector(arrival, (s3 - s2) * T);
    velocity.copy(bird.landFrom).multiplyScalar((6 * s2 - 6 * s) / T)
      .addScaledVector(bird.landVelocity, 3 * s2 - 4 * s + 1)
      .addScaledVector(target, (-6 * s2 + 6 * s) / T)
      .addScaledVector(arrival, 3 * s2 - 2 * s);
    const horizontal = Math.hypot(velocity.x, velocity.z);
    if (horizontal > .3) {
      const turn = Math.atan2(Math.sin(Math.atan2(velocity.x, velocity.z) - bird.yaw), Math.cos(Math.atan2(velocity.x, velocity.z) - bird.yaw));
      bird.yaw += turn * (1 - Math.exp(-dt * 6));
      bird.bank = THREE.MathUtils.damp(bird.bank, THREE.MathUtils.clamp(turn * 2, -.5, .5) * (1 - s), 4, dt);
    }
    bird.speed = horizontal; bird.vy = velocity.y;
    bird.flare = smoothstep(.45, 1, s);
    bird.pitch = THREE.MathUtils.damp(bird.pitch, -Math.atan2(velocity.y, Math.max(horizontal, 1.5)) * (1 - bird.flare * .8) - bird.flare * .35, 6, dt);
    euler.set(bird.pitch, bird.yaw, -bird.bank);
    orientation.setFromEuler(euler);
    bird.root.quaternion.slerp(orientation, 1 - Math.exp(-dt * 10));
    if (s >= 1) {
      bird.mode = 'perched';
      bird.flare = 0;
      bird.restUntil = time + 25 + bird.random() * 55;
      bird.flushAt = Infinity;
    }
  }

  function rest(bird: Bird, dt: number, player: THREE.Vector3, daylight: number) {
    const perch = bird.perch!;
    perchPosition(perch, bird.scale, bird.root.position);
    const turn = Math.atan2(Math.sin(perch.yaw - bird.yaw), Math.cos(perch.yaw - bird.yaw));
    bird.yaw += turn * (1 - Math.exp(-dt * .75));
    bird.bank = 0; bird.pitch = 0; bird.speed = 0; bird.vy = 0;
    euler.set(0, bird.yaw, 0); orientation.setFromEuler(euler);
    bird.root.quaternion.slerp(orientation, 1 - Math.exp(-dt * 7));
    if (dt === 0) return;
    if (bird.root.position.distanceTo(player) < FLIGHT_DISTANCE) bird.flushAt = Math.min(bird.flushAt, time);
    if (time >= bird.flushAt) depart(bird, player, daylight, true);
    else if (daylight > DAYLIGHT && time > bird.restUntil) depart(bird, player, daylight, false);
  }

  function initialize(daylight: number) {
    for (let i = 0; i < BIRD_COUNT; i++) {
      const random = seededRandom(8121 + i * 971), rig = new THREE.Group();
      const body = new THREE.Object3D(), head = new THREE.Object3D(), tail = new THREE.Object3D(), feet = new THREE.Object3D();
      const folded = [new THREE.Object3D(), new THREE.Object3D()];
      head.position.set(0, .077, .195); rig.add(body, head, tail, feet, ...folded);
      const wings: THREE.Object3D[] = [];
      for (const sign of [-1, 1]) {
        const arm = new THREE.Object3D(), hand = new THREE.Object3D();
        arm.position.set(sign * .064, .037, .005); hand.position.x = sign * .4;
        arm.add(hand); rig.add(arm); wings.push(arm, hand);
      }
      const scale = .8 + random() * .18;
      rig.scale.setScalar(scale);
      const bird: Bird = {
        root: rig, parts: [body, head, tail, ...wings, feet, ...folded], scale, random,
        mode: 'perched', errand: 'fish',
        yaw: 0, speed: 0, vy: 0, bank: 0, pitch: 0,
        goal: V(), goalUntil: 0, escapeUntil: 0, fishingGround: V(), tripEnds: 0,
        nextScan: random() * 6, hoverUntil: 0, hover: 0, dive: 0, takeoff: 0,
        landFrom: V(), landVelocity: V(), landStart: 0, landDuration: 1, flare: 0,
        restUntil: 5 + random() * 40, flushAt: Infinity,
        phase: random() * TAU, flap: random() * TAU, flapAmount: .2, fold: 1,
        look: 0, lookTarget: 0, nextLook: 1 + random() * 3,
      };
      birds.push(bird);
      // By day, half the colony is already out fishing.
      if (i >= BIRD_COUNT / 2 && daylight > DAYLIGHT) {
        chooseFishingGround(bird);
        rig.position.set(bird.fishingGround.x, 6 + random() * 3, bird.fishingGround.z);
        bird.mode = 'flying'; bird.fold = 0; bird.yaw = random() * TAU; bird.speed = CRUISE;
        patrol(bird);
        continue;
      }
      // Spread roosting birds across the island's perches.
      const free = perches.filter(perch => !perch.owner);
      const perch = free[Math.floor(random() * free.length)];
      if (!perch) continue;
      perch.owner = bird; bird.perch = perch;
      bird.yaw = perch.yaw + (random() - .5) * .8;
      perchPosition(perch, scale, rig.position);
    }
    for (const bird of birds) {
      bird.root.rotation.set(0, bird.yaw, 0);
      if (bird.mode !== 'perched' || bird.perch) continue;
      // Roosting birds without a free perch go looking for one.
      bird.mode = 'flying'; bird.errand = 'roost'; bird.fold = 0; bird.speed = CRUISE;
      bird.root.position.set(0, 8, shoreZ(0) - 30);
    }
    batches.forEach(batch => { batch.count = BIRD_COUNT; });
    initialized = true;
  }

  /** Wings, head and tail follow what the bird is doing. */
  function pose(bird: Bird, dt: number, daylight: number) {
    const resting = bird.mode === 'perched';
    const landing = bird.mode === 'landing' ? bird.flare : 0;
    const departure = smoothstep(0, 1.2, bird.takeoff);
    bird.fold = THREE.MathUtils.damp(bird.fold, resting ? 1 : bird.dive === 1 ? .42 : 0, resting ? 5 : 9, dt);
    const glide = smoothstep(-.15, .4, Math.sin(time * .58 + bird.phase) + Math.sin(time * .21 + bird.phase * 2) * .3);
    const climb = resting ? 0 : smoothstep(.4, 2.5, bird.vy) * .8;
    const power = resting ? 0 : bird.dive === 1 ? 0 : Math.max(departure, landing * .8, climb, bird.hover, (1 - glide) * .7);
    bird.flapAmount = THREE.MathUtils.damp(bird.flapAmount, power, 5, dt);
    bird.flap += dt * (4.2 + departure * 1.1 + bird.hover * 1.4 + landing * .5) * TAU;
    const stroke = Math.sin(bird.flap), fold = bird.fold;
    // The model has properly layered closed feathers. Tuck the articulated
    // flight wings into the body while the resting coverts settle over them.
    const closed = smoothstep(.28, .88, fold), open = Math.max(.001, 1 - closed);
    for (let side = 0; side < 2; side++) {
      const sign = side ? 1 : -1, arm = bird.parts[3 + side * 2], hand = bird.parts[4 + side * 2];
      arm.rotation.set(.04 + landing * .24, sign * (fold * 1.32 + landing * .14), sign * (.055 + stroke * bird.flapAmount * .68) * (1 - fold) - sign * fold * .5);
      arm.scale.set((1 - fold * .27) * open, open, open);
      hand.rotation.set(0, sign * fold * 1.28, sign * (Math.sin(bird.flap - .75) * bird.flapAmount * .33 + .08) * (1 - fold));
      hand.scale.x = 1 - fold * .61;
      bird.parts[8 + side].scale.setScalar(Math.max(.001, closed));
    }
    const head = bird.parts[1];
    bird.nextLook -= dt * (daylight > DAYLIGHT ? 1 : .3);
    if (bird.nextLook <= 0) {
      bird.lookTarget = (bird.random() - .5) * (resting ? 1.85 : .38);
      bird.nextLook = .7 + bird.random() * 3.2;
    }
    // A hovering tern fixes its gaze straight down on the water.
    bird.look = THREE.MathUtils.damp(bird.look, bird.lookTarget * (1 - bird.hover), 8, dt);
    const preen = resting && daylight > DAYLIGHT ? smoothstep(.87, .98, Math.sin(time * .36 + bird.phase)) : 0;
    head.rotation.set(preen * .42 + bird.hover * .55 + (resting ? Math.sin(time * 1.2 + bird.phase) * .035 : .015), bird.look * (1 - preen) + preen * 2.45, preen * .14, 'YXZ');
    head.position.y = .077 - preen * .012;
    bird.parts[2].rotation.set(landing * -.25 - bird.hover * .3 + Math.sin(time * 1.7 + bird.phase) * .025, bird.bank * .15, 0);
    bird.parts[2].scale.x = 1 + Math.max(landing, bird.hover) * .45;
    bird.parts[7].scale.y = .16 + Math.max(fold, landing, departure * .75) * .84;
    bird.root.updateMatrixWorld(true);
  }

  return {
    root,
    update(seconds: number, player: THREE.Vector3, motion: boolean, daylight: number) {
      if (!initialized) initialize(daylight);
      const elapsed = lastSeconds === undefined ? 0 : Math.max(0, seconds - lastSeconds);
      lastSeconds = seconds;
      // Bound catch-up so returning from the background cannot skip a landing.
      const dt = motion ? Math.min(elapsed, .1) : 0;
      time += dt;
      for (let i = 0; i < birds.length; i++) {
        const bird = birds[i];
        if (bird.mode === 'perched') rest(bird, dt, player, daylight);
        if (bird.mode === 'flying' && dt > 0) {
          chooseGoal(bird, player, daylight);
          if (bird.mode === 'flying') fly(bird, dt, player);
        }
        if (bird.mode === 'landing' && dt > 0) land(bird, dt, player);
        pose(bird, dt, daylight);
        bird.parts.forEach((part, j) => batches[j].setMatrixAt(i, part.matrixWorld));
      }
      batches.forEach(batch => { batch.instanceMatrix.needsUpdate = true; });
    },
  };
}
