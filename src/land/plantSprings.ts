import { DataTexture, FloatType, RGBAFormat, Vector3 } from 'three/webgpu';
import { EYE_HEIGHT } from '../player/collisions';
import type { Plant } from './plants';

/** Trees and palms block the player; everything else bends out of the way. */
export const hasSolidStem = (plant: Plant) => ['palm', 'sea almond', 'mango', 'sea grape'].includes(plant.kind);

/** One spring per soft plant; a tiny texture shares its bend across every mesh and material. */
export function createPlantSprings(plants: Plant[]) {
  const data = new Float32Array(plants.length * 4);
  const velocity = new Float32Array(plants.length * 2);
  const texture = new DataTexture(data, plants.length, 1, RGBAFormat, FloatType);
  texture.name = 'Vegetation · brush-through springs';
  const previous = new Vector3();
  let initialized = false;
  plants.forEach((plant, i) => {
    data[i * 4 + 2] = plant.y;
    data[i * 4 + 3] = hasSolidStem(plant) ? 0 : 1 / Math.max(.2, plant.height);
  });
  texture.needsUpdate = true;
  return {
    texture,
    update(dt: number, player: Vector3) {
      if (!initialized) { previous.copy(player); initialized = true; }
      const dx = player.x - previous.x, dz = player.z - previous.z;
      const distanceSq = dx * dx + dz * dz;
      const speed = Math.min(1, Math.sqrt(distanceSq) / Math.max(dt, .001) / 4.5);
      let changed = false;
      const steps = Math.max(1, Math.ceil(dt / .016)), step = dt / steps;
      plants.forEach((plant, i) => {
        if (hasSolidStem(plant)) return;
        const offset = i * 4, v = i * 2;
        // Sweep the contact along this frame's movement, including fast walking.
        const t = distanceSq > 1e-6 && distanceSq < 9
          ? Math.max(0, Math.min(1, ((plant.x - previous.x) * dx + (plant.z - previous.z) * dz) / distanceSq)) : 1;
        const awayX = plant.x - (previous.x + dx * t), awayZ = plant.z - (previous.z + dz * t);
        const distance = Math.hypot(awayX, awayZ), reach = Math.min(1.4, plant.radius * .75 + .35);
        const feet = player.y - EYE_HEIGHT;
        const overlap = plant.y < feet + 1.8 && plant.y + plant.height > feet + .05;
        const contact = overlap ? Math.max(0, 1 - distance / reach) : 0;
        // The body parts leaves to the sides and carries them slightly forward.
        let nx = awayX / Math.max(distance, .05) + dx / Math.max(dt, .001) * .08;
        let nz = awayZ / Math.max(distance, .05) + dz / Math.max(dt, .001) * .08;
        const length = Math.hypot(nx, nz);
        if (length < .01) { nx = Math.cos(plant.seed); nz = Math.sin(plant.seed); }
        else { nx /= length; nz /= length; }
        const bend = contact * Math.min(.48, plant.height * .48) * (.65 + speed * .35);
        const targetX = nx * bend, targetZ = nz * bend;
        if (!contact && Math.abs(data[offset]) + Math.abs(data[offset + 1]) + Math.abs(velocity[v]) + Math.abs(velocity[v + 1]) < .0001) return;
        for (let tick = 0; tick < steps; tick++) {
          velocity[v] += ((targetX - data[offset]) * 58 - velocity[v] * 10) * step;
          velocity[v + 1] += ((targetZ - data[offset + 1]) * 58 - velocity[v + 1] * 10) * step;
          data[offset] += velocity[v] * step;
          data[offset + 1] += velocity[v + 1] * step;
        }
        changed = true;
      });
      if (changed) texture.needsUpdate = true;
      previous.copy(player);
    },
  };
}
