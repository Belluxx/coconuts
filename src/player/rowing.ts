import { BufferAttribute, DynamicDrawUsage, MathUtils, Mesh, Object3D, Vector3 } from 'three/webgpu';
import { PIER_ROWBOAT, SEA_RADIUS } from '../structures/pierLayout';
import { floatHull } from '../water/buoyancy';
import { SWIM_EYE_HEIGHT, type IslandCollisions } from './collisions';

/** +Z is the bow. Steering follows the hull while the passenger can look around. */
export class Rowboat {
  occupied = false;
  private speed = 0;
  private turnSpeed = 0;
  private readonly velocity = new Vector3();
  private readonly seat = new Vector3();
  private readonly oars: { pivot: Object3D; side: number; phase: number; effort: number }[];
  private readonly mooringDelta = new Vector3();
  /** Rope vertices follow the stern in proportion to their distance from the pier ring. */
  private readonly mooringLines: {
    mesh: Mesh; positions: BufferAttribute; rest: Float32Array; weights: Float32Array;
    end: Vector3; attachment: Vector3;
  }[] = [];

  constructor(
    readonly root: Object3D,
    oars: { pivot: Object3D; side: number }[],
    private readonly mooring: Object3D,
    private readonly yacht: Object3D,
    private readonly collisions: IslandCollisions,
    private readonly waterHeight: (x: number, z: number) => number,
  ) {
    this.oars = oars.map(oar => ({ ...oar, phase: 0, effort: 0 }));
    mooring.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const positions = object.geometry.getAttribute('position') as BufferAttribute;
      const grain = object.geometry.getAttribute('grain');
      if (!grain) return;
      const rest = new Float32Array(positions.array), weights = new Float32Array(positions.count);
      let length = 0, endCount = 0;
      for (let i = 0; i < grain.count; i++) length = Math.max(length, grain.getX(i));
      if (length <= 0) return;
      const end = new Vector3();
      for (let i = 0; i < positions.count; i++) {
        weights[i] = grain.getX(i) / length;
        // Average the final tube ring, excluding its duplicated texture seam.
        if (weights[i] > .99999 && grain.getY(i) < Math.PI * 2 - .0001) {
          end.add(this.mooringDelta.fromBufferAttribute(positions, i));
          endCount++;
        }
      }
      if (!endCount) return;
      end.divideScalar(endCount);
      const attachment = root.worldToLocal(object.localToWorld(end.clone()));
      positions.setUsage(DynamicDrawUsage);
      (object.geometry.getAttribute('normal') as BufferAttribute).setUsage(DynamicDrawUsage);
      this.mooringLines.push({ mesh: object, positions, rest, weights, end, attachment });
    });
  }

  get heading(): number { return this.root.rotation.y; }

  seatPosition(): Vector3 {
    // Keep the horizon level and the seated eye above passing waves.
    return this.seat.set(0, 1.55, -1.03).applyQuaternion(this.root.quaternion).add(this.root.position);
  }

  canBoard(position: Vector3): boolean {
    return !this.occupied && Math.hypot(position.x - this.root.position.x, position.z - this.root.position.z) < 3.9
      && Math.abs(position.y - this.seatPosition().y) < 2.4
      && this.collisions.clearBoardingLine(position, this.seatPosition());
  }

  board(): void {
    this.occupied = true;
    this.mooring.visible = false;
    this.stop();
  }

  /** Step onto nearby land, or slip into clear water beside the hull. */
  dismount(): { position: Vector3; swimming: boolean } | undefined {
    const landing = this.collisions.boatLanding(this.seatPosition());
    if (landing) { this.occupied = false; this.stop(); return { position: landing, swimming: false }; }
    // Try both sides and the stern, keeping the swimmer clear of the hull and piles.
    for (const [across, along] of [[1.65, -1.03], [-1.65, -1.03], [0, -3.25]]) {
      const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
      const x = this.root.position.x + across * cos + along * sin;
      const z = this.root.position.z - across * sin + along * cos;
      const position = new Vector3(x, this.waterHeight(x, z) + SWIM_EYE_HEIGHT, z);
      if (!this.collisions.swimmingClear(position) || !this.collisions.clearBoardingLine(this.seatPosition(), position)) continue;
      this.occupied = false;
      this.stop();
      return { position, swimming: true };
    }
  }

  returnToBerth(): void {
    this.occupied = false;
    this.stop();
    this.root.position.set(PIER_ROWBOAT.x, .15, PIER_ROWBOAT.z);
    this.root.rotation.y = PIER_ROWBOAT.yaw;
    this.mooring.visible = true;
  }

  private stop(): void {
    this.speed = this.turnSpeed = 0;
    this.velocity.set(0, 0, 0);
  }

  private updateMooring(): void {
    if (!this.mooring.visible) return;
    for (const line of this.mooringLines) {
      this.root.localToWorld(this.mooringDelta.copy(line.attachment));
      line.mesh.worldToLocal(this.mooringDelta).sub(line.end);
      const { positions, rest, weights } = line;
      // Zero weight fixes the pier ring; the far ring follows the stern exactly.
      for (let i = 0; i < positions.count; i++) {
        positions.setXYZ(i,
          rest[i * 3] + this.mooringDelta.x * weights[i],
          rest[i * 3 + 1] + this.mooringDelta.y * weights[i],
          rest[i * 3 + 2] + this.mooringDelta.z * weights[i]);
      }
      positions.needsUpdate = true;
      line.mesh.geometry.computeVertexNormals();
      line.mesh.geometry.computeBoundingSphere();
    }
  }

  private clear(x: number, z: number, heading: number): boolean {
    // Stay inside the rendered sea, with ample room beyond the messenger's route.
    if (Math.hypot(x - PIER_ROWBOAT.x, z - PIER_ROWBOAT.z) > SEA_RADIUS || !this.collisions.boatClear(x, z, heading)) return false;
    // The messenger moves independently, so include its current hull each frame.
    const sin = Math.sin(this.yacht.rotation.y), cos = Math.cos(this.yacht.rotation.y);
    for (const along of [-1.55, 0, 1.55]) {
      const dx = x + Math.sin(heading) * along - this.yacht.position.x;
      const dz = z + Math.cos(heading) * along - this.yacht.position.z;
      const across = dx * cos - dz * sin, forward = dx * sin + dz * cos;
      if (across ** 2 + (forward - MathUtils.clamp(forward, -3.3, 3.3)) ** 2 < 2.15 ** 2) return false;
    }
    return true;
  }

  /** Return the hull's turn so the view follows steering without taking over mouse look. */
  update(dt: number, forward: number, turn: number, reducedMotion: boolean): number {
    if (!this.occupied) forward = turn = 0;
    const oldHeading = this.heading;
    if (this.occupied) {
      const targetSpeed = forward > 0 ? 6.8 : forward < 0 ? -2.8 : turn ? 1 : 0;
      this.speed = MathUtils.damp(this.speed, targetSpeed, forward || turn ? 1.5 : .85, dt);
      this.turnSpeed = MathUtils.damp(this.turnSpeed, -turn * 1.05, 4, dt);
      const nextHeading = this.heading + this.turnSpeed * dt;
      if (this.clear(this.root.position.x, this.root.position.z, nextHeading)) this.root.rotation.y = nextHeading;
      else this.turnSpeed = 0;
      const blend = 1 - Math.exp(-3 * dt);
      this.velocity.x = MathUtils.lerp(this.velocity.x, Math.sin(this.heading) * this.speed, blend);
      this.velocity.z = MathUtils.lerp(this.velocity.z, Math.cos(this.heading) * this.speed, blend);
      // Short hull sweeps also cover slow frames without tunnelling through a pile.
      const steps = Math.max(1, Math.ceil(this.velocity.length() * dt / .12));
      const dx = this.velocity.x * dt / steps, dz = this.velocity.z * dt / steps;
      for (let i = 0; i < steps; i++) {
        const { x, z } = this.root.position;
        if (this.clear(x + dx, z + dz, this.heading)) { this.root.position.x += dx; this.root.position.z += dz; }
        else { this.speed = 0; this.velocity.set(0, 0, 0); break; }
      }
    }
    floatHull(this.root, this.waterHeight, 4.9, 1.7, .15, dt,
      this.turnSpeed * this.speed * .006, reducedMotion ? .25 : 1);
    this.updateMooring();
    for (const oar of this.oars) {
      const drive = MathUtils.clamp(forward + turn * oar.side, -1, 1);
      oar.effort = MathUtils.damp(oar.effort, Math.abs(drive), 5, dt);
      oar.phase += drive * dt * 4.8;
      const sweep = Math.sin(oar.phase) * .58;
      oar.pivot.rotation.y = oar.side * MathUtils.lerp(-1.13, sweep, oar.effort);
      oar.pivot.rotation.z = oar.side * (-.28 - Math.cos(oar.phase) * .24) * oar.effort;
    }
    return this.heading - oldHeading;
  }
}
