import * as THREE from 'three/webgpu';
import { seededRandom, smoothstep, TAU, V } from '../math';
import type { QualitySettings } from '../quality';
import { MARINE_HABITATS, REEF_HABITATS, type MarineHabitat } from './habitats';
import type { Feeling, Seascape } from './seascape';
import { createVisitorModels, type MarineAnimalKind } from './visitorModels';

/** Keep shells and wingtips below the passing wave troughs. */
const SURFACE_LIMIT_Y = -.92;
const SIMULATION_RADIUS = 125;
const VISIBLE_RADIUS = 105;
const SHADOW_RADIUS = 55;
/** How far from home an animal's daily range extends. */
const RANGE = 48;

const PROFILES = {
  turtle: {
    name: 'Green sea turtle · grazing, surfacing to breathe',
    /** Swimming speeds in metres per second, and the fastest turn in radians per second. */
    cruise: .34, variation: .08, flee: 1.3, turn: .5,
    /** Horizontal reach including flippers, and the height it keeps above the reef when travelling. */
    radius: 1.13, altitude: [1.2, 2.1], pitchLimit: .32, bankLimit: .12,
    feeds: ['grass', 'reef'] as MarineHabitat['kind'][],
  },
  ray: {
    name: 'Spotted eagle ray · patrolling sand and rubble',
    cruise: .55, variation: .12, flee: 1.7, turn: .42,
    // The whip tail is part of the clearance envelope.
    radius: 2.9, altitude: [1.1, 2.6], pitchLimit: .18, bankLimit: .22,
    feeds: ['rubble', 'reef'] as MarineHabitat['kind'][],
  },
};

/**
 * travel: cross open water to the next feeding place.
 * feed: turtles crop grass and algae; rays skim the sand for shellfish.
 * breathe: turtles rise to the surface for air, then return.
 * visit: a curious animal makes one unhurried pass beside a calm diver.
 * flee: turn away from a diver who approaches too fast or too close.
 */
type Activity = 'travel' | 'feed' | 'breathe' | 'visit' | 'flee';

type Visitor = {
  mesh: THREE.Mesh;
  kind: MarineAnimalKind;
  profile: typeof PROFILES[MarineAnimalKind];
  home: MarineHabitat;
  scale: number; radius: number; belly: number; comfort: number;
  cruise: number; altitude: number;
  /** 0 is shy; 1 approaches calm divers. */
  curiosity: number;
  random: () => number;
  awake: boolean;
  yaw: number; speed: number; vy: number; pitch: number; bank: number;
  activity: Activity; until: number; goal: THREE.Vector3;
  nextBreath: number; nextThought: number; breathing: number;
};

/** Turtles and eagle rays: large, slow animals with daily routines across several reefs. */
export function createVisitors(scene: THREE.Scene, seascape: Seascape) {
  const group = new THREE.Group();
  group.name = 'Green sea turtles and spotted eagle rays';
  scene.add(group);
  const models = createVisitorModels();
  const visitors: Visitor[] = [];
  const feeling: Feeling = { climb: 0, turn: 0 };

  const bottomAt = (visitor: Visitor, x: number, z: number) => seascape.solidUnder(x, z, visitor.radius) + visitor.belly;
  const roomAt = (visitor: Visitor, x: number, z: number) => bottomAt(visitor, x, z) + .3 < SURFACE_LIMIT_Y;

  /** A feeding place within the home range: reef margins, seagrass, rubble, or open sand. */
  function chooseSpot(visitor: Visitor, out: THREE.Vector3) {
    const { home, random } = visitor;
    const nearby = MARINE_HABITATS.filter(habitat => visitor.profile.feeds.includes(habitat.kind)
      && Math.hypot(habitat.x - home.x, habitat.z - home.z) < RANGE);
    for (let attempt = 0; attempt < 16; attempt++) {
      const habitat = nearby[Math.floor(random() * nearby.length)] ?? home;
      const angle = random() * TAU;
      // Reefs are grazed from their edges; grass and rubble from within.
      const radius = habitat.kind === 'reef' ? 1.05 + random() * .3 : Math.sqrt(random()) * .7;
      let x = habitat.x + Math.cos(angle) * habitat.rx * radius, z = habitat.z + Math.sin(angle) * habitat.rz * radius;
      if (visitor.kind === 'ray' && random() < .35) {
        // Eagle rays also work the open sand between reefs.
        x = home.x + Math.cos(angle) * (14 + random() * 22);
        z = home.z + Math.sin(angle) * (14 + random() * 22);
      }
      if (!roomAt(visitor, x, z)) continue;
      return out.set(x, bottomAt(visitor, x, z), z);
    }
    return out.set(home.x, bottomAt(visitor, home.x, home.z), home.z - home.rz * 1.3);
  }

  function begin(visitor: Visitor, activity: Activity, t: number, duration: number) {
    visitor.activity = activity;
    visitor.until = t + duration;
  }

  function add(kind: MarineAnimalKind, home: MarineHabitat, scale: number, curiosity: number) {
    const profile = PROFILES[kind];
    const random = seededRandom(home.seed + visitors.length * 7919);
    const mesh = models.createMesh(kind, random() * 23);
    mesh.name = profile.name;
    mesh.scale.setScalar(scale);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
    const [low, high] = profile.altitude;
    const radius = scale * profile.radius;
    const visitor: Visitor = {
      mesh, kind, profile, home, scale, radius,
      belly: scale * .46 + .23, comfort: radius + .9,
      cruise: profile.cruise + random() * profile.variation, altitude: low + random() * (high - low),
      curiosity, random, awake: false,
      yaw: random() * TAU, speed: 0, vy: 0, pitch: 0, bank: 0,
      activity: 'travel', until: Infinity, goal: V(),
      nextBreath: 20 + random() * 120, nextThought: 5 + random() * 10, breathing: 0,
    };
    chooseSpot(visitor, mesh.position);
    mesh.position.y = Math.min(SURFACE_LIMIT_Y, mesh.position.y + visitor.altitude * .5);
    visitor.speed = visitor.cruise;
    chooseSpot(visitor, visitor.goal);
    visitors.push(visitor);
  }

  // A few residents near the beach, then a sparse population on the outer terraces.
  add('turtle', REEF_HABITATS[0], .84, .82);
  add('turtle', REEF_HABITATS[1], .67, .2);
  add('ray', REEF_HABITATS[0], 1.04, .66);
  add('ray', REEF_HABITATS[4], .82, .25);
  add('ray', REEF_HABITATS[3], .94, .38);
  const outerHomes = REEF_HABITATS.filter(home => home.zone !== 'lagoon');
  for (let i = 0; i < outerHomes.length; i++) {
    if (i % 3 === 2) continue;
    const home = outerHomes[i], random = seededRandom(home.seed + 9271);
    add(i % 3 === 0 ? 'turtle' : 'ray', home,
      i % 3 === 0 ? .72 + random() * .23 : .83 + random() * .27,
      i % 4 === 0 ? .7 + random() * .18 : .12 + random() * .29);
  }

  const diver = V(), lastDiver = V(), diverVelocity = V();
  let hasDiver = false, diverInWater = false, lastTime: number | undefined, budget = 0;
  const nearOrder = visitors.map(visitor => ({ visitor, distance: 0 }));

  /** React to the diver first, then to boredom, hunger, and the need for air. */
  function decide(visitor: Visitor, t: number, dt: number) {
    const position = visitor.mesh.position;
    const toX = position.x - diver.x, toY = position.y - diver.y, toZ = position.z - diver.z;
    const distance = diverInWater ? Math.hypot(toX, toY, toZ) : Infinity;
    const closing = diverInWater ? Math.max(0, (diverVelocity.x * toX + diverVelocity.y * toY + diverVelocity.z * toZ) / Math.max(distance, .1)) : 0;
    const shy = 1 - visitor.curiosity;
    const alarmDistance = visitor.comfort + 1.2 + shy * 2.5 + closing * 2.5;
    const threatened = distance < alarmDistance && (closing > .3 || distance < visitor.comfort + .6 || shy > .5);
    if (threatened && visitor.activity !== 'flee') {
      const horizontal = Math.max(Math.hypot(toX, toZ), .01);
      visitor.goal.set(position.x + toX / horizontal * 14, position.y - .3, position.z + toZ / horizontal * 14);
      begin(visitor, 'flee', t, 8 + visitor.random() * 5);
      visitor.nextThought = t + 40 + visitor.random() * 50;
      return;
    }

    const arrived = Math.hypot(visitor.goal.x - position.x, visitor.goal.z - position.z) < 2.5;
    if (visitor.activity === 'breathe') {
      if (position.y > SURFACE_LIMIT_Y - .08) visitor.breathing += dt;
      if (visitor.breathing > 3.5 || t > visitor.until) {
        visitor.nextBreath = t + 100 + visitor.random() * 110;
        chooseSpot(visitor, visitor.goal);
        begin(visitor, 'travel', t, 90);
      }
      return;
    }
    if (visitor.kind === 'turtle' && t > visitor.nextBreath && visitor.activity !== 'flee') {
      // Rise ahead along the current course, where the water is open.
      const x = position.x + Math.sin(visitor.yaw) * 6, z = position.z + Math.cos(visitor.yaw) * 6;
      visitor.goal.set(x, SURFACE_LIMIT_Y, z);
      visitor.breathing = 0;
      begin(visitor, 'breathe', t, 30);
      return;
    }

    if (t > visitor.nextThought && visitor.activity !== 'visit' && visitor.activity !== 'flee') {
      visitor.nextThought = t + 10 + visitor.random() * 14;
      const calm = diverVelocity.lengthSq() < 1;
      if (calm && distance > 5 && distance < 16 && visitor.random() < visitor.curiosity * .7) {
        // Pass alongside the diver at a comfortable distance, then carry on.
        const horizontal = Math.max(Math.hypot(toX, toZ), .01), side = visitor.random() < .5 ? -1 : 1;
        const passX = diver.x - toZ / horizontal * side * (visitor.comfort + 1.6);
        const passZ = diver.z + toX / horizontal * side * (visitor.comfort + 1.6);
        const leg = Math.max(Math.hypot(passX - position.x, passZ - position.z), .01);
        visitor.goal.set(passX + (passX - position.x) / leg * 9, diver.y - .4, passZ + (passZ - position.z) / leg * 9);
        begin(visitor, 'visit', t, 30);
        return;
      }
    }

    if (visitor.activity === 'feed') {
      if (t > visitor.until) {
        chooseSpot(visitor, visitor.goal);
        begin(visitor, 'travel', t, 90);
      } else if (arrived) {
        // Browse slowly around the feeding place.
        const angle = visitor.random() * TAU, reach = 2 + visitor.random() * 3;
        const x = visitor.goal.x + Math.cos(angle) * reach, z = visitor.goal.z + Math.sin(angle) * reach;
        if (roomAt(visitor, x, z)) visitor.goal.set(x, 0, z);
      }
    } else if (arrived || t > visitor.until) {
      if (visitor.activity === 'travel' && arrived) begin(visitor, 'feed', t, visitor.kind === 'turtle' ? 25 + visitor.random() * 35 : 10 + visitor.random() * 15);
      else {
        chooseSpot(visitor, visitor.goal);
        begin(visitor, 'travel', t, 90);
      }
    }
  }

  function steer(visitor: Visitor, t: number, dt: number) {
    const { profile } = visitor;
    const position = visitor.mesh.position;
    const headX = Math.sin(visitor.yaw), headZ = Math.cos(visitor.yaw);
    let wishX = visitor.goal.x - position.x, wishZ = visitor.goal.z - position.z;
    const goalDistance = Math.max(Math.hypot(wishX, wishZ), .01);
    wishX /= goalDistance; wishZ /= goalDistance;

    // Personal space around the diver and other large animals.
    if (diverInWater) {
      const dx = position.x - diver.x - diverVelocity.x, dz = position.z - diver.z - diverVelocity.z;
      const distance = Math.max(Math.hypot(dx, dz), .1);
      const push = (1 - smoothstep(visitor.comfort, visitor.comfort + 5, distance)) * 2.5 / distance;
      wishX += dx * push; wishZ += dz * push;
    }
    for (const other of visitors) {
      if (other === visitor || !other.awake) continue;
      const dx = position.x - other.mesh.position.x, dz = position.z - other.mesh.position.z;
      const reach = visitor.radius + other.radius + .6, distance = Math.max(Math.hypot(dx, dz), .1);
      if (distance > reach + 3 || Math.abs(position.y - other.mesh.position.y) > 2) continue;
      const push = (1 - smoothstep(reach, reach + 3, distance)) * 2 / distance;
      wishX += dx * push; wishZ += dz * push;
    }

    const ceiling = SURFACE_LIMIT_Y;
    const reach = visitor.radius + 1.5 + visitor.speed * 3;
    seascape.feel(position.x, position.y, position.z, headX, headZ, reach, visitor.belly + .25, ceiling, feeling);
    if (feeling.turn) {
      wishX += -headZ * feeling.turn * 3 - headX;
      wishZ += headX * feeling.turn * 3 - headZ;
    }

    const fleeing = visitor.activity === 'flee';
    const wishYaw = Math.atan2(wishX, wishZ);
    const error = Math.atan2(Math.sin(wishYaw - visitor.yaw), Math.cos(wishYaw - visitor.yaw));
    const maxTurn = profile.turn * (fleeing ? 2.4 : 1) * (feeling.turn ? 1.5 : 1);
    const turn = THREE.MathUtils.clamp(error * 1.2, -maxTurn, maxTurn);
    visitor.yaw += turn * dt;

    const pace = fleeing ? profile.flee
      : visitor.activity === 'feed' ? visitor.cruise * .4
      : visitor.activity === 'breathe' && visitor.breathing > 0 ? visitor.cruise * .35
      : visitor.cruise * (1 - smoothstep(4, 1, goalDistance) * .4);
    const targetSpeed = pace * (1 - smoothstep(1, 2.6, Math.abs(error)) * .5);
    const accel = fleeing ? .9 : .25;
    visitor.speed += THREE.MathUtils.clamp(targetSpeed - visitor.speed, -accel * dt, accel * dt);

    // Depth: cruise above the reef, drop to the bottom to feed, rise to breathe.
    const aheadX = position.x + headX * visitor.speed * 2, aheadZ = position.z + headZ * visitor.speed * 2;
    const bottom = Math.max(bottomAt(visitor, position.x, position.z), bottomAt(visitor, aheadX, aheadZ));
    let targetY = visitor.activity === 'feed' ? bottom + .2
      : visitor.activity === 'breathe' ? SURFACE_LIMIT_Y
      : visitor.activity === 'visit' ? visitor.goal.y
      : fleeing ? position.y - .3
      : bottom + visitor.altitude + Math.sin(t * .05 + visitor.home.seed) * .3;
    targetY = THREE.MathUtils.clamp(Math.max(targetY, position.y + feeling.climb), bottom + .1, SURFACE_LIMIT_Y);
    const wishVy = THREE.MathUtils.clamp((targetY - position.y) * .6, -.35, .45) + Math.min(feeling.climb * 1.5, .6);
    visitor.vy += THREE.MathUtils.clamp(wishVy - visitor.vy, -.5 * dt, .5 * dt);

    move(visitor, dt, turn);
  }

  function move(visitor: Visitor, dt: number, turn: number) {
    const { profile } = visitor;
    const position = visitor.mesh.position;
    const x = position.x + Math.sin(visitor.yaw) * visitor.speed * dt;
    const z = position.z + Math.cos(visitor.yaw) * visitor.speed * dt;
    let y = position.y + visitor.vy * dt;
    // Reef is never crossed: if the next step is too tall to clear, stop and turn.
    const bottom = bottomAt(visitor, x, z);
    const trapped = bottomAt(visitor, position.x, position.z) > position.y + .02;
    if (!trapped && (bottom > SURFACE_LIMIT_Y || bottom > y + dt * .8 + .02)) {
      visitor.speed *= .5;
      visitor.yaw -= (feeling.turn || 1) * profile.turn * dt;
    } else {
      position.x = x; position.z = z;
      if (y < bottom) { y = bottom; visitor.vy = Math.max(visitor.vy, 0); }
    }
    if (y > SURFACE_LIMIT_Y) { y = SURFACE_LIMIT_Y; visitor.vy = Math.min(visitor.vy, 0); }
    position.y = y;

    // A diver who swims straight at an animal is sidestepped, not passed through.
    if (diverInWater) {
      const dx = position.x - diver.x, dy = position.y - diver.y, dz = position.z - diver.z;
      const distance = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz);
      if (distance < visitor.comfort && horizontal > .01) {
        const step = Math.min(visitor.comfort - distance, 1.5 * dt) / horizontal;
        const nx = position.x + dx * step, nz = position.z + dz * step;
        if (bottomAt(visitor, nx, nz) <= Math.max(position.y, SURFACE_LIMIT_Y)) { position.x = nx; position.z = nz; }
      }
    }

    const pitch = THREE.MathUtils.clamp(-Math.atan2(visitor.vy, Math.max(visitor.speed, .15)), -profile.pitchLimit, profile.pitchLimit);
    visitor.pitch = THREE.MathUtils.damp(visitor.pitch, pitch, 2.2, dt);
    visitor.bank = THREE.MathUtils.damp(visitor.bank, THREE.MathUtils.clamp(-turn * .4, -profile.bankLimit, profile.bankLimit), 2, dt);
    visitor.mesh.rotation.set(visitor.pitch, visitor.yaw, visitor.bank, 'YXZ');
  }

  function updateVisibility(viewer?: THREE.Vector3) {
    for (const candidate of nearOrder) {
      candidate.distance = viewer ? candidate.visitor.mesh.position.distanceToSquared(viewer) : 0;
    }
    nearOrder.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < nearOrder.length; i++) {
      const { visitor, distance } = nearOrder[i];
      const { mesh } = visitor;
      mesh.visible = visitor.awake && (!viewer || (distance < VISIBLE_RADIUS ** 2 && i < budget));
      mesh.castShadow = mesh.visible && (!viewer || distance < SHADOW_RADIUS ** 2);
    }
  }

  function update(t: number, viewer?: THREE.Vector3) {
    const dt = lastTime === undefined ? 0 : THREE.MathUtils.clamp(t - lastTime, 0, .1);
    lastTime = t;
    if (viewer) {
      diver.copy(viewer);
      if (hasDiver && dt > 0 && diver.distanceToSquared(lastDiver) < 9) {
        diverVelocity.lerp(lastDiver.sub(diver).negate().divideScalar(dt).clampLength(0, 3.2), 1 - Math.exp(-dt * 3));
      } else diverVelocity.set(0, 0, 0);
      lastDiver.copy(diver);
      hasDiver = true;
    }
    diverInWater = hasDiver && diver.y < 1;

    for (const visitor of visitors) {
      // Distant animals pause where they are and resume when the diver returns.
      visitor.awake = !viewer || visitor.mesh.position.distanceToSquared(viewer) < SIMULATION_RADIUS ** 2;
      if (!visitor.awake || dt === 0) continue;
      decide(visitor, t, dt);
      steer(visitor, t, dt);
    }
    updateVisibility(viewer);
  }

  return {
    group, update,
    setQuality(quality: QualitySettings) { budget = quality.visitors; },
  };
}
