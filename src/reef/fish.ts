import * as THREE from 'three/webgpu';
import { seededRandom, smoothstep, TAU } from '../math';
import type { QualitySettings } from '../quality';
import { createReefFishGeometry, type ReefSpecies } from './fishGeometry';
import { createMarineFishMaterial } from './fishMaterial';
import { REEF_HABITATS } from './habitats';
import { SEA_LEVEL, type Feeling, type Seascape } from './seascape';

const MAX_STEP = .1;
/** Neighbourhood cells, and the farthest any fish reads another. */
const CELL = 2;
const GRID_WIDTH = 4096;
const GRID_ORIGIN = 1024;
/** Fish track a handful of nearby companions, never the whole school. */
const COMPANIONS = 7;
const SURFACE_GAP = .34;

/**
 * school: polarized, moving as one; splits around a threat and closes behind it.
 * shoal: a loose cloud around one coral head; hides in the reef when alarmed.
 * pair: mated partners that forage within a body length of each other.
 * solitary: works its own patch of reef.
 */
type Social = 'school' | 'shoal' | 'pair' | 'solitary';

type Species = {
  species: ReefSpecies;
  name: string;
  /** Residents per reef, and how many share one school, shoal or pair. */
  count: number; group: number;
  size: number; sizeVariation: number;
  social: Social;
  /** Height kept above the reef in metres; for schools, the share of the open water column. */
  altitude: [number, number];
  /** Share of the reef's radii that a group ranges over. */
  range: number;
  /** Swimming speeds in metres per second. */
  cruise: number; burst: number;
  /** Distance at which an approaching diver makes this species flee. */
  flight: number;
  /** Share of time spent pecking at the reef. */
  forage: number;
  /** How freely an individual meanders instead of holding its course. */
  wander: number;
  beat: number;
};

const SPECIES: Species[] = [
  { species: 'silver', name: 'Silversides · offshore baitfish schools', count: 48, group: 48, size: .20, sizeVariation: .11,
    social: 'school', altitude: [.38, .72], range: 1.2, cruise: .55, burst: 2.8, flight: 4.8, forage: 0, wander: .35, beat: 9 },
  { species: 'anthias', name: 'Peach and rose anthias · clouds over coral heads', count: 24, group: 8, size: .22, sizeVariation: .075,
    social: 'shoal', altitude: [.5, 1.6], range: .55, cruise: .17, burst: 2.3, flight: 3.3, forage: 0, wander: 1, beat: 10.5 },
  { species: 'sergeant', name: 'Five-bar sergeant majors · loose shoals', count: 10, group: 10, size: .29, sizeVariation: .13,
    social: 'shoal', altitude: [.7, 2.2], range: .65, cruise: .3, burst: 2.4, flight: 3.9, forage: .1, wander: .8, beat: 7.5 },
  { species: 'butterfly', name: 'Threaded butterflyfish · foraging pairs', count: 6, group: 2, size: .35, sizeVariation: .12,
    social: 'pair', altitude: [.25, .9], range: .6, cruise: .22, burst: 1.8, flight: 2.7, forage: .45, wander: .9, beat: 7 },
  { species: 'blueTang', name: 'Royal blue tangs · roving grazers', count: 4, group: 4, size: .36, sizeVariation: .14,
    social: 'shoal', altitude: [.4, 1.5], range: .85, cruise: .38, burst: 2.5, flight: 3.5, forage: .3, wander: .7, beat: 7.5 },
  { species: 'bannerfish', name: 'Longfin bannerfish · trailing dorsal pennants', count: 2, group: 2, size: .39, sizeVariation: .13,
    social: 'pair', altitude: [.5, 1.4], range: .5, cruise: .22, burst: 1.8, flight: 2.8, forage: .2, wander: .8, beat: 7 },
  { species: 'parrotfish', name: 'Turquoise parrotfish · reef grazers', count: 2, group: 1, size: .53, sizeVariation: .22,
    social: 'solitary', altitude: [.2, .8], range: .8, cruise: .3, burst: 2.0, flight: 2.9, forage: .6, wander: .7, beat: 6 },
  { species: 'wrasse', name: 'Ribbon wrasse · quick reef wanderers', count: 6, group: 1, size: .32, sizeVariation: .17,
    social: 'solitary', altitude: [.15, .7], range: .85, cruise: .5, burst: 2.6, flight: 3.2, forage: .35, wander: 1.3, beat: 10 },
];

/** How strongly each social style matches its companions' heading and stays with them. */
const BONDS: Record<Social, { align: number; cohere: number }> = {
  school: { align: 1.5, cohere: .9 },
  shoal: { align: .3, cohere: .55 },
  pair: { align: 0, cohere: 0 },
  solitary: { align: 0, cohere: 0 },
};

type Population = ReturnType<typeof createPopulation>;
type Fish = {
  population: Population;
  spec: Species;
  reef: number;
  /** Fish of one school, shoal or pair share a group id. */
  group: number;
  partner?: Fish;
  // Identity and anatomy, fixed at creation.
  scale: number; length: number; halfHeight: number;
  tint: THREE.Color; phase: number; beat: number; amplitude: number;
  rank: number; altitude: number; cruise: number;
  siteX: number; siteZ: number; rangeX: number; rangeZ: number;
  // Motion: fish swim forward along their body axis at `speed`, rising or sinking at `vy`.
  awake: boolean;
  x: number; y: number; z: number;
  yaw: number; speed: number; vy: number;
  pitch: number; bank: number;
  // Alarm persists for a while; a school keeps its split direction until it calms.
  fear: number; splitX: number; splitZ: number;
  nibble: number; nibbleUntil: number; nextNibble: number;
  stroke: number; fade: number;
  // Neighbours read this frame's snapshot, never a half-updated fish.
  sx: number; sy: number; sz: number; svx: number; svz: number; sfear: number;
};

function createPopulation(spec: Species, material: THREE.MeshStandardNodeMaterial) {
  const geometry = createReefFishGeometry(spec.species);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const capacity = spec.count * 8;
  const side = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  side.setUsage(THREE.DynamicDrawUsage);
  const motion = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  motion.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('swimSide', side);
  geometry.setAttribute('fishMotion', motion);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = spec.name;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color('#ffffff'));
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  return {
    spec, mesh, side, motion, capacity,
    length: Math.max(-bounds.min.x, bounds.max.x),
    // Include the dorsal pennant and a little pitch.
    halfHeight: Math.max(-bounds.min.y, bounds.max.y) + Math.max(-bounds.min.x, bounds.max.x) * .2,
  };
}

/** Eight reef species, each living by its own social rules on every reef terrace. */
export function createFish(scene: THREE.Scene, seascape: Seascape) {
  const group = new THREE.Group();
  group.name = 'Reef ecosystem · eight species and living schools';
  scene.add(group);
  const material = createMarineFishMaterial();
  const populations = SPECIES.map(spec => createPopulation(spec, material));
  for (const { mesh } of populations) group.add(mesh);

  // Every reef keeps deterministic residents; only nearby reefs are awake.
  const random = seededRandom(227501);
  const residents: Fish[][][] = REEF_HABITATS.map((reef, reefIndex) => populations.map(population => {
    const { spec } = population;
    const fish: Fish[] = [];
    const groupSites: [number, number][] = [];
    for (let local = 0; local < spec.count; local++) {
      const groupIndex = Math.floor(local / spec.group);
      if (!groupSites[groupIndex]) {
        const angle = random() * TAU, radius = spec.social === 'school' ? 0 : Math.sqrt(random()) * .6;
        groupSites[groupIndex] = [reef.x + Math.cos(angle) * reef.rx * radius, reef.z + Math.sin(angle) * reef.rz * radius];
      }
      const [siteX, siteZ] = groupSites[groupIndex];
      // A shoal gathers around its own coral head; others range over the reef.
      const spread = spec.social === 'shoal' ? spec.range * .45 : spec.range;
      const scale = spec.size + random() * spec.sizeVariation;
      const [low, high] = spec.altitude;
      const member: Fish = {
        population, spec, reef: reefIndex, group: reefIndex * 64 + groupIndex,
        scale, length: population.length * scale, halfHeight: population.halfHeight * scale,
        tint: new THREE.Color().setHSL(.08 + SPECIES.indexOf(spec) * .035, .05 + random() * .09, .90 + random() * .085),
        phase: random() * TAU, beat: spec.beat * (.85 + random() * .3), amplitude: .08 + random() * .03,
        rank: (local * .61803398875 + reefIndex * .37) % 1,
        altitude: low + random() * (high - low), cruise: spec.cruise * (.85 + random() * .3),
        siteX, siteZ, rangeX: reef.rx * spread + 1, rangeZ: reef.rz * spread + 1,
        awake: false, x: 0, y: 0, z: 0, yaw: 0, speed: 0, vy: 0, pitch: 0, bank: 0,
        fear: 0, splitX: 0, splitZ: 0, nibble: 0, nibbleUntil: 0, nextNibble: random() * 6,
        stroke: random() * TAU, fade: 0,
        sx: 0, sy: 0, sz: 0, svx: 0, svz: 0, sfear: 0,
      };
      if (spec.social === 'pair' && local % 2) {
        member.partner = fish[local - 1];
        fish[local - 1].partner = member;
        member.altitude = fish[local - 1].altitude;
      }
      fish.push(member);
    }
    return fish;
  }));

  let quality: QualitySettings;
  let lastTime: number | undefined;
  const diver = new THREE.Vector3(), lastDiver = new THREE.Vector3(), diverVelocity = new THREE.Vector3();
  let hasDiver = false, diverInWater = false;
  const reefOrder = REEF_HABITATS.map((_, index) => ({ index, distance: 0 }));
  const feeling: Feeling = { climb: 0, turn: 0 };
  const drawn = populations.map(() => 0);

  // A spatial hash of this frame's awake fish; buckets are reused between frames.
  const cells = new Map<number, Fish[]>();
  const usedCells: number[] = [];
  const cellKey = (x: number, z: number) =>
    (Math.floor(x / CELL) + GRID_ORIGIN) * GRID_WIDTH + Math.floor(z / CELL) + GRID_ORIGIN;

  const ceilingOf = (fish: Fish) => SEA_LEVEL - SURFACE_GAP - fish.halfHeight;
  const bottomOf = (fish: Fish, x: number, z: number) => seascape.solidAt(x, z) + fish.halfHeight + .05;

  function preferredHeight(fish: Fish, x: number, z: number) {
    const bottom = bottomOf(fish, x, z);
    if (fish.spec.social === 'school') return bottom + .3 + (ceilingOf(fish) - bottom - .3) * fish.altitude;
    // Reef fish drop toward shelter when alarmed, and touch down to feed.
    const altitude = fish.altitude * (1 - fish.fear * .8) * (1 - fish.nibble * .92);
    return bottom + altitude;
  }

  function spawn(fish: Fish) {
    const local = residents[fish.reef][populations.indexOf(fish.population)].indexOf(fish);
    const school = fish.spec.social === 'school';
    // Schools start packed and polarized; others appear somewhere in their range.
    const heading = school ? REEF_HABITATS[fish.reef].seed % 7 : Math.random() * TAU;
    for (let attempt = 0; attempt < 10; attempt++) {
      let x: number, z: number;
      if (school) {
        const angle = local * 2.399963, radius = Math.sqrt((local + .5) / fish.spec.count);
        x = fish.siteX + Math.cos(angle) * radius * 2.6 + attempt * 2.5 * Math.cos(heading + 1.57);
        z = fish.siteZ + Math.sin(angle) * radius * 1.3 - attempt * 2.5 * Math.sin(heading + 1.57);
      } else if (fish.partner?.awake) {
        x = fish.partner.x + Math.cos(fish.phase) * .5;
        z = fish.partner.z + Math.sin(fish.phase) * .5;
      } else {
        const angle = Math.random() * TAU, radius = Math.sqrt(Math.random()) * .6;
        x = fish.siteX + Math.cos(angle) * fish.rangeX * radius;
        z = fish.siteZ + Math.sin(angle) * fish.rangeZ * radius;
      }
      const bottom = bottomOf(fish, x, z), ceiling = ceilingOf(fish);
      if (bottom > ceiling - .05) continue;
      fish.x = x; fish.z = z;
      fish.y = THREE.MathUtils.clamp(preferredHeight(fish, x, z), bottom, ceiling);
      fish.yaw = fish.partner?.awake ? fish.partner.yaw : heading + (school ? (Math.random() - .5) * .2 : 0);
      fish.speed = fish.cruise; fish.vy = 0; fish.pitch = fish.bank = 0;
      fish.fear = 0; fish.nibble = 0; fish.nibbleUntil = 0; fish.fade = 0;
      fish.awake = true;
      return;
    }
  }

  function snapshot(fish: Fish) {
    fish.sx = fish.x; fish.sy = fish.y; fish.sz = fish.z;
    fish.svx = Math.cos(fish.yaw) * fish.speed; fish.svz = -Math.sin(fish.yaw) * fish.speed;
    fish.sfear = fish.fear;
    const key = cellKey(fish.x, fish.z);
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    if (bucket.length === 0) usedCells.push(key);
    bucket.push(fish);
  }

  /** Wake nearby reefs, put distant ones to sleep, and index everyone awake. */
  function wakeReefs(density: number, reach: number) {
    for (const item of reefOrder) {
      const reef = REEF_HABITATS[item.index];
      item.distance = Math.hypot(reef.x - diver.x, reef.z - diver.z);
    }
    reefOrder.sort((a, b) => a.distance - b.distance);
    for (const key of usedCells) cells.get(key)!.length = 0;
    usedCells.length = 0;
    for (const { index, distance } of reefOrder) {
      for (const fishes of residents[index]) for (const fish of fishes) {
        if (distance > reach + 40) { fish.awake = false; continue; }
        const wanted = distance < reach + 20 && (fish.spec.count <= 4 || fish.rank < density);
        if (!fish.awake && wanted) spawn(fish);
        if (fish.awake) snapshot(fish);
      }
    }
  }

  // Scratch values shared by each fish's decision.
  let sepX = 0, sepY = 0, sepZ = 0, alignX = 0, alignZ = 0, centerX = 0, centerY = 0, centerZ = 0, companions = 0, alarm = 0;
  let awayX = 0, awayZ = 0;

  function readNeighbours(fish: Fish) {
    sepX = sepY = sepZ = alignX = alignZ = centerX = centerY = centerZ = 0;
    companions = 0; alarm = 0;
    const key = cellKey(fish.x, fish.z);
    const sight = Math.min(CELL, fish.length * 9);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = cells.get(key + dx * GRID_WIDTH + dz);
      if (!bucket) continue;
      for (const other of bucket) {
        if (other === fish) continue;
        const ox = fish.x - other.sx, oy = fish.y - other.sy, oz = fish.z - other.sz;
        const distance = Math.hypot(ox, oy, oz);
        if (distance > sight) continue;
        // Personal space applies across species.
        const spacing = (fish.length + other.length) * .9;
        if (distance < spacing) {
          const push = (1 - distance / spacing) ** 2 / Math.max(distance, .01);
          sepX += ox * push; sepY += oy * push; sepZ += oz * push;
        }
        // Alarm spreads through the reef, fading a little at every relay.
        alarm = Math.max(alarm, other.sfear * (other.population === fish.population ? .8 : .45));
        if (other.group !== fish.group || companions >= COMPANIONS) continue;
        alignX += other.svx; alignZ += other.svz;
        centerX += other.sx; centerY += other.sy; centerZ += other.sz;
        companions++;
      }
    }
  }

  function updateFear(fish: Fish, dt: number) {
    let stimulus = 0;
    awayX = Math.cos(fish.phase); awayZ = Math.sin(fish.phase);
    if (diverInWater) {
      const dx = fish.x - diver.x, dy = fish.y - diver.y, dz = fish.z - diver.z;
      const distance = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz);
      if (horizontal > .01) { awayX = dx / horizontal; awayZ = dz / horizontal; }
      // A diver closing in is far more alarming than one hanging still.
      const closing = Math.max(0, (diverVelocity.x * dx + diverVelocity.y * dy + diverVelocity.z * dz) / Math.max(distance, .1));
      const reach = fish.spec.flight * (.8 + Math.min(1.2, closing * .55));
      stimulus = (1 - smoothstep(reach * .3, reach, distance)) * (.55 + Math.min(.45, closing * .3));
    }
    const target = Math.max(stimulus, alarm);
    const calm = fish.fear < .08;
    fish.fear += (target - fish.fear) * (1 - Math.exp(-dt * (target > fish.fear ? 7 : .45)));
    if (calm && fish.fear >= .08) {
      // A school splits to whichever side of the diver's path it is already on.
      const speed = Math.hypot(diverVelocity.x, diverVelocity.z);
      const acrossX = speed > .15 ? -diverVelocity.z / speed : -awayZ, acrossZ = speed > .15 ? diverVelocity.x / speed : awayX;
      const offset = (fish.x - diver.x) * acrossX + (fish.z - diver.z) * acrossZ;
      const side = Math.abs(offset) > .05 ? Math.sign(offset) : Math.sign(Math.sin(fish.phase)) || 1;
      fish.splitX = acrossX * side; fish.splitZ = acrossZ * side;
    }
  }

  function updateFish(fish: Fish, t: number, dt: number) {
    const { spec } = fish;
    readNeighbours(fish);
    updateFear(fish, dt);

    // Feeding bouts come and go; a frightened fish stops eating.
    if (t > fish.nextNibble) {
      fish.nextNibble = t + 2 + Math.random() * 5;
      if (fish.fear < .1 && Math.random() < spec.forage) fish.nibbleUntil = t + 1.5 + Math.random() * 3;
    }
    const nibbling = t < fish.nibbleUntil && fish.fear < .1 ? 1 : 0;
    fish.nibble += (nibbling - fish.nibble) * (1 - Math.exp(-dt * 2));

    const headX = Math.cos(fish.yaw), headZ = -Math.sin(fish.yaw);
    // Meander: a slow drift in the preferred course, shared by a whole school.
    const phase = spec.social === 'school' ? fish.group * 1.7 : fish.phase;
    const drift = (Math.sin(t * .29 + phase) * .6 + Math.sin(t * .71 + phase * 2.3) * .4) * spec.wander;
    let wishX = Math.cos(fish.yaw + drift) * (1 - fish.fear * .8);
    let wishZ = -Math.sin(fish.yaw + drift) * (1 - fish.fear * .8);

    // Home: an elastic boundary around the group's site.
    const hx = fish.x - fish.siteX, hz = fish.z - fish.siteZ;
    const stray = Math.hypot(hx / fish.rangeX, hz / fish.rangeZ);
    const pull = smoothstep(.55, 1.2, stray) * 1.8 / Math.max(Math.hypot(hx, hz), .01);
    wishX -= hx * pull; wishZ -= hz * pull;

    // Companions: match their heading and keep near their centre.
    const bond = BONDS[spec.social];
    let centerDY = 0;
    if (companions > 0) {
      const alignLength = Math.hypot(alignX, alignZ);
      if (alignLength > .01) { wishX += alignX / alignLength * bond.align; wishZ += alignZ / alignLength * bond.align; }
      const cx = centerX / companions - fish.x, cz = centerZ / companions - fish.z, distance = Math.hypot(cx, cz);
      const gather = smoothstep(fish.length * 2, CELL, distance) * bond.cohere / Math.max(distance, .01);
      wishX += cx * gather; wishZ += cz * gather;
      centerDY = centerY / companions - fish.y;
    }
    const partner = fish.partner?.awake ? fish.partner : undefined;
    if (partner) {
      const px = partner.sx - fish.x, pz = partner.sz - fish.z, distance = Math.hypot(px, pz);
      const gather = smoothstep(.35, 1.6, distance) * 1.6 / Math.max(distance, .01);
      wishX += px * gather + partner.svx * .8; wishZ += pz * gather + partner.svz * .8;
      centerDY = partner.sy - fish.y;
    }
    wishX += sepX * 1.4; wishZ += sepZ * 1.4;

    // Flight: straight away, while a school also parts around the diver.
    const split = spec.social === 'school' ? 1.3 : .3;
    wishX += (awayX + fish.splitX * split) * fish.fear * 3;
    wishZ += (awayZ + fish.splitZ * split) * fish.fear * 3;

    // Reef ahead: rise over it, or turn toward the lower shoulder.
    const ceiling = ceilingOf(fish);
    const reach = fish.length * 3 + fish.speed * 1.2;
    seascape.feel(fish.x, fish.y, fish.z, headX, headZ, reach, fish.halfHeight + .12, ceiling, feeling);
    if (feeling.turn) {
      wishX += -headZ * feeling.turn * 3 - headX;
      wishZ += headX * feeling.turn * 3 - headZ;
    }

    // Turn the body toward the wish; fish only swim forward.
    const wishYaw = Math.hypot(wishX, wishZ) > .001 ? Math.atan2(-wishZ, wishX) : fish.yaw;
    const error = Math.atan2(Math.sin(wishYaw - fish.yaw), Math.cos(wishYaw - fish.yaw));
    const maxTurn = 1.3 + fish.fear * 5 + (feeling.turn ? 1 : 0);
    const turn = THREE.MathUtils.clamp(error * (2.2 + fish.fear * 5), -maxTurn, maxTurn);
    fish.yaw += turn * dt;
    const pace = (.85 + Math.sin(t * .23 + fish.phase * 3) * .15) * (1 - fish.nibble * .75);
    // Slow down to turn sharply; a startled fish bursts instead.
    const targetSpeed = (fish.cruise * pace * (1 - smoothstep(1.2, 2.6, Math.abs(error)) * .6) + fish.fear * spec.burst);
    const accel = targetSpeed > fish.speed ? .8 + fish.fear * 9 : 1.2;
    fish.speed += THREE.MathUtils.clamp(targetSpeed - fish.speed, -accel * dt, accel * dt);

    // Rise and sink toward a preferred height, over the reef and with companions.
    let wishY = preferredHeight(fish, fish.x, fish.z) - fish.y + centerDY * .35 + sepY * .5;
    if (spec.social === 'school') wishY += Math.sign(fish.y - diver.y) * fish.fear * .8;
    const wishVy = THREE.MathUtils.clamp(wishY * .9, -.4 - fish.fear * .4, .4 + fish.fear * .4)
      + Math.min(feeling.climb * 2.2, 1.2);
    fish.vy += THREE.MathUtils.clamp(wishVy - fish.vy, -1.2 * dt, 1.2 * dt);

    // A little sideways slip lets tight schools keep their spacing.
    const slip = -sepX * Math.sin(fish.yaw) - sepZ * Math.cos(fish.yaw);
    const slipSpeed = THREE.MathUtils.clamp(slip * .15, -.15, .15);
    const oldX = fish.x, oldZ = fish.z;
    const x = oldX + (Math.cos(fish.yaw) * fish.speed - Math.sin(fish.yaw) * slipSpeed) * dt;
    const z = oldZ + (-Math.sin(fish.yaw) * fish.speed - Math.cos(fish.yaw) * slipSpeed) * dt;
    let y = fish.y + fish.vy * dt;

    // Solid reef is never crossed. Stop and turn if the next step is blocked.
    const bottom = bottomOf(fish, x, z);
    const trapped = bottomOf(fish, oldX, oldZ) > fish.y + .02;
    if (!trapped && (bottom > ceiling || bottom > y + dt * 1.5 + .02)) {
      fish.speed *= .5;
      fish.yaw -= (feeling.turn || Math.sign(Math.sin(fish.phase)) || 1) * 2 * dt;
      y = Math.max(y, bottomOf(fish, oldX, oldZ));
    } else {
      fish.x = x; fish.z = z;
      y = Math.max(y, bottom);
    }
    if (y > ceiling) { y = ceiling; fish.vy = Math.min(fish.vy, 0); }
    if (y <= bottom) fish.vy = Math.max(fish.vy, 0);
    fish.y = y;

    // Body attitude follows motion: nose into climbs, head down to feed, lean into turns.
    const targetPitch = THREE.MathUtils.clamp(Math.atan2(fish.vy, Math.max(fish.speed, .12)), -.4, .4) - fish.nibble * .38;
    fish.pitch += (targetPitch - fish.pitch) * (1 - Math.exp(-dt * 3));
    const targetBank = THREE.MathUtils.clamp(-turn * .05, -.12, .12);
    fish.bank += (targetBank - fish.bank) * (1 - Math.exp(-dt * 3));
    fish.stroke += fish.beat * THREE.MathUtils.clamp(.35 + .65 * fish.speed / fish.cruise, .35, 2.6) * dt;
  }

  const dummy = new THREE.Object3D();
  function draw(population: Population, fish: Fish, slot: number, t: number) {
    const { mesh, side, motion } = population;
    dummy.position.set(fish.x, fish.y, fish.z);
    dummy.rotation.set(fish.bank, fish.yaw, fish.pitch + Math.sin(t * .38 + fish.phase) * .006, 'YZX');
    dummy.scale.setScalar(fish.scale * fish.fade);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, fish.tint);
    const matrix = dummy.matrix.elements;
    side.setXYZ(slot, matrix[8], matrix[9], matrix[10]);
    motion.setXYZ(slot, fish.stroke, fish.phase, fish.amplitude * (1 + fish.fear * .45));
  }

  function update(t: number, viewer?: THREE.Vector3) {
    const dt = lastTime === undefined ? 0 : THREE.MathUtils.clamp(t - lastTime, 0, MAX_STEP);
    lastTime = t;
    if (viewer) {
      diver.copy(viewer);
      if (hasDiver && dt > 0 && diver.distanceToSquared(lastDiver) < 16) {
        diverVelocity.lerp(lastDiver.sub(diver).negate().divideScalar(dt).clampLength(0, 8), 1 - Math.exp(-dt * 6));
      } else diverVelocity.set(0, 0, 0);
      lastDiver.copy(diver);
      hasDiver = true;
    }
    // Fish ignore people on the pier and beach; a swimmer's head is at the surface.
    diverInWater = hasDiver && diver.y < 1;
    const { fishDensity: density, fishDistance: reach } = quality;
    wakeReefs(density, reach);

    drawn.fill(0);
    for (const { index, distance } of reefOrder) {
      if (distance > reach + 40) break;
      for (let p = 0; p < populations.length; p++) {
        const population = populations[p];
        for (const fish of residents[index][p]) {
          if (!fish.awake) continue;
          if (dt > 0) updateFish(fish, t, dt);
          const wanted = distance < reach + 20 && (fish.spec.count <= 4 || fish.rank < density);
          const seen = 1 - smoothstep(reach - 14, reach, Math.hypot(fish.x - diver.x, fish.y - diver.y, fish.z - diver.z));
          fish.fade += ((wanted ? seen : 0) - fish.fade) * (1 - Math.exp(-dt * 4));
          if (!wanted && fish.fade < .002) { fish.awake = false; continue; }
          if (fish.fade < .002 || drawn[p] >= population.capacity) continue;
          draw(population, fish, drawn[p]++, t);
        }
      }
    }
    populations.forEach((population, p) => {
      population.mesh.count = drawn[p];
      population.mesh.instanceMatrix.needsUpdate = true;
      population.mesh.instanceColor!.needsUpdate = true;
      population.side.needsUpdate = true;
      population.motion.needsUpdate = true;
    });
  }

  return {
    group, update,
    setQuality(settings: QualitySettings) { quality = settings; },
  };
}
