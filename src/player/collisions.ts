import { Box3, BufferGeometry, MathUtils, Ray, Triangle, Vector3 } from 'three/webgpu';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';
import { groundHeight, seabedHeight } from '../land/terrain';
import { PIER_ROWBOAT, SEA_RADIUS } from '../structures/pierLayout';

export const EYE_HEIGHT = 1.8;
export const SWIM_EYE_HEIGHT = .42;
const RADIUS = .3;
const BODY_HEIGHT = 1.95;
const SWIM_BODY_HEIGHT = 1.1;
const SWIM_EYE_OFFSET = .85;
const STEP_HEIGHT = .38;
const SKIN = .008;
const CONTACT_EPSILON = 1e-5;
const WALKABLE_NORMAL = .68;
const STRIDE = .12;
const FOOT_SAMPLES = [[0, 0], [RADIUS, 0], [-RADIUS, 0], [0, RADIUS], [0, -RADIUS], [.21, .21], [-.21, .21], [.21, -.21], [-.21, -.21]];
const inBounds = (x: number, z: number) => (x >= -100 && x <= 110 && z >= -100 && z <= 80)
  || (Math.hypot(x - PIER_ROWBOAT.x, z - PIER_ROWBOAT.z) <= SEA_RADIUS && groundHeight(x, z) < -.1);

type Contact = { normal: Vector3; depth: number };
type SurfaceNode = { bounds: Box3; left?: SurfaceNode; right?: SurfaceNode; triangles?: Triangle[] };

/** Median splits keep small board faces and broad rock faces in a compact index. */
function indexSurfaces(triangles: Triangle[]): SurfaceNode {
  // Centroids (times three) are measured once; each split only partitions
  // the triangles around their median instead of sorting them.
  const centers = new Float64Array(triangles.length * 3);
  triangles.forEach(({ a, b, c }, i) => {
    centers[i * 3] = a.x + b.x + c.x; centers[i * 3 + 1] = a.y + b.y + c.y; centers[i * 3 + 2] = a.z + b.z + c.z;
  });
  const order = Uint32Array.from(triangles.keys());
  const key = (i: number, axis: number) => centers[order[i] * 3 + axis];
  /** Quickselect: move the `k`th smallest key to `k`, smaller keys before it and larger after. */
  const select = (start: number, end: number, k: number, axis: number) => {
    let low = start, high = end - 1;
    while (low < high) {
      const pivot = key((low + high) >>> 1, axis);
      let i = low, j = high;
      while (i <= j) {
        while (key(i, axis) < pivot) i++;
        while (key(j, axis) > pivot) j--;
        if (i <= j) { [order[i], order[j]] = [order[j], order[i]]; i++; j--; }
      }
      if (k <= j) high = j;
      else if (k >= i) low = i;
      else return;
    }
  };
  const build = (start: number, end: number): SurfaceNode => {
    const bounds = new Box3();
    for (let i = start; i < end; i++) {
      const { a, b, c } = triangles[order[i]];
      bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    }
    if (end - start <= 16) return { bounds, triangles: Array.from(order.subarray(start, end), i => triangles[i]) };
    const size = bounds.getSize(new Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    const middle = (start + end) >>> 1;
    select(start, end, middle, axis);
    return { bounds, left: build(start, middle), right: build(middle, end) };
  };
  return build(0, triangles.length);
}

/** Static solid surfaces, independent of foliage animation. */
export class IslandCollisions {
  // Use Three's capsule/triangle contact math, with a bounded surface hierarchy.
  private readonly intersections = new Octree();
  private readonly triangles: Triangle[] = [];
  private surfaces?: SurfaceNode;
  private readonly bodyBounds = new Box3();
  private readonly contacts: Triangle[] = [];
  private readonly hitPoint = new Vector3();
  private readonly contactNormal = new Vector3();
  private readonly capsule = new Capsule(new Vector3(), new Vector3(), RADIUS);
  private readonly ray = new Ray(new Vector3(), new Vector3(0, -1, 0));
  private readonly normal = new Vector3();
  private readonly candidate = new Vector3();
  private readonly previous = new Vector3();

  addGeometry(geometry: BufferGeometry): void {
    const positions = geometry.getAttribute('position'), indices = geometry.index;
    for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
      const points = [0, 1, 2].map(j => new Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + j) : i + j));
      this.addTriangle(new Triangle(points[0], points[1], points[2]));
    }
  }

  /** Plant surfaces are already in world coordinates; only woody stems are supplied. */
  addStem(positions: number[], indices: number[], start: number): void {
    for (let i = start; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      this.addTriangle(new Triangle(new Vector3().fromArray(positions, a), new Vector3().fromArray(positions, b), new Vector3().fromArray(positions, c)));
    }
  }

  private addTriangle(triangle: Triangle): void {
    const { a, b, c } = triangle;
    const nearX = MathUtils.clamp(PIER_ROWBOAT.x, Math.min(a.x, b.x, c.x), Math.max(a.x, b.x, c.x));
    const nearZ = MathUtils.clamp(PIER_ROWBOAT.z, Math.min(a.z, b.z, c.z), Math.max(a.z, b.z, c.z));
    if (Math.hypot(nearX - PIER_ROWBOAT.x, nearZ - PIER_ROWBOAT.z) > SEA_RADIUS + 3 || triangle.getArea() < 1e-9) return;
    this.triangles.push(triangle);
  }

  build(): void { this.surfaces = indexSurfaces(this.triangles.splice(0)); }

  private nearby(node: SurfaceNode): void {
    if (!node.bounds.intersectsBox(this.bodyBounds)) return;
    if (node.triangles) this.contacts.push(...node.triangles);
    else { this.nearby(node.left!); this.nearby(node.right!); }
  }

  private contact(position: Vector3, swimming = false): Contact | false {
    const feet = position.y - (swimming ? SWIM_EYE_OFFSET : EYE_HEIGHT);
    const height = swimming ? SWIM_BODY_HEIGHT : BODY_HEIGHT;
    // Keep clearance in the shape, rather than adding a fresh shove at every impact.
    const radius = RADIUS + SKIN;
    this.capsule.radius = radius;
    this.capsule.start.set(position.x, feet + radius + SKIN, position.z);
    this.capsule.end.set(position.x, feet + height - radius, position.z);
    this.bodyBounds.min.set(position.x - radius, feet + SKIN, position.z - radius);
    this.bodyBounds.max.set(position.x + radius, feet + height, position.z + radius);
    this.contacts.length = 0;
    if (this.surfaces) this.nearby(this.surfaces);
    let depth = CONTACT_EPSILON;
    for (const triangle of this.contacts) {
      const hit = this.intersections.triangleCapsuleIntersect(this.capsule, triangle) as Contact | false;
      if (hit && hit.depth > depth) {
        depth = hit.depth;
        this.contactNormal.copy(hit.normal);
      }
    }
    // Resolve real faces separately: a floor and wall do not form a climbable slope.
    return depth > CONTACT_EPSILON ? { normal: this.contactNormal, depth } : false;
  }

  private floor(node: SurfaceNode, height: number): number {
    const { x, y, z } = this.ray.origin, { min, max } = node.bounds;
    if (x < min.x || x > max.x || z < min.z || z > max.z || min.y > y || max.y <= height) return height;
    if (node.triangles) {
      for (const triangle of node.triangles) {
        if (triangle.getNormal(this.normal).y < WALKABLE_NORMAL) continue;
        const hit = this.ray.intersectTriangle(triangle.a, triangle.b, triangle.c, true, this.hitPoint);
        if (hit && hit.y > height) height = hit.y;
      }
      return height;
    }
    return this.floor(node.right!, this.floor(node.left!, height));
  }

  /** Sample a small foot area so a low lip is stepped onto before the body hits it. */
  private support(x: number, z: number, ceiling: number): number {
    let height = seabedHeight(x, z);
    if (this.surfaces) for (const [dx, dz] of FOOT_SAMPLES) {
      this.ray.origin.set(x + dx, ceiling + SKIN, z + dz);
      height = this.floor(this.surfaces, height);
    }
    return height;
  }

  /** Use the reachable floor, so a pier or rock above water still counts as land. */
  waterDepth(position: Vector3, swimming = false): number {
    const eyeOffset = swimming ? SWIM_EYE_OFFSET : EYE_HEIGHT;
    return Math.max(0, -this.support(position.x, position.z, position.y - eyeOffset + STEP_HEIGHT));
  }

  private eyeHeight(x: number, z: number, ceiling: number): number {
    return Math.max(this.support(x, z, ceiling) + EYE_HEIGHT, SWIM_EYE_HEIGHT);
  }

  project(position: Vector3): void {
    if (!inBounds(position.x, position.z)) {
      position.x = MathUtils.clamp(position.x, -100, 110);
      position.z = MathUtils.clamp(position.z, -100, 80);
    }
    const ceiling = Math.max(position.y - EYE_HEIGHT, seabedHeight(position.x, position.z)) + STEP_HEIGHT;
    position.y = this.eyeHeight(position.x, position.z, ceiling);
  }

  /** Standing up in shallows still needs headroom beneath rocks and the pier. */
  standFromWater(position: Vector3): boolean {
    const standing = position.clone();
    this.project(standing);
    if (this.contact(standing)) return false;
    position.copy(standing);
    return true;
  }

  /** A shorter swimming body can dive, surface and slide beneath solid structures. */
  swim(from: Vector3, target: Vector3, result: Vector3): void {
    const dx = target.x - from.x, dy = target.y - from.y, dz = target.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / STRIDE));
    result.copy(from);
    for (let step = 0; step < steps; step++) {
      const next = this.candidate.copy(result);
      next.x += dx / steps; next.y += dy / steps; next.z += dz / steps;
      const ceiling = result.y - SWIM_EYE_OFFSET + STEP_HEIGHT;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!inBounds(next.x, next.z)) break;
        next.y = Math.max(next.y, this.support(next.x, next.z, ceiling) + SWIM_EYE_OFFSET);
        const hit = this.contact(next, true);
        if (!hit) { result.copy(next); break; }
        next.addScaledVector(hit.normal, hit.depth);
      }
    }
  }

  /** A horizontal capsule encloses the rowboat's hull, including its submerged keel. */
  boatClear(x: number, z: number, heading: number): boolean {
    const sin = Math.sin(heading), cos = Math.cos(heading);
    for (const along of [-1.9, -.95, 0, .95, 1.9]) {
      const width = Math.abs(along) > 1.5 ? .32 : .8;
      for (const across of [-width, 0, width]) {
        if (groundHeight(x + sin * along + cos * across, z + cos * along - sin * across) > -.35) return false;
      }
    }
    this.capsule.radius = .8;
    this.capsule.start.set(x - sin * 1.55, .3, z - cos * 1.55);
    this.capsule.end.set(x + sin * 1.55, .3, z + cos * 1.55);
    this.bodyBounds.setFromPoints([this.capsule.start, this.capsule.end]).expandByScalar(.8);
    this.contacts.length = 0;
    if (this.surfaces) this.nearby(this.surfaces);
    const blocked = this.contacts.some(triangle => {
      const hit = this.intersections.triangleCapsuleIntersect(this.capsule, triangle) as Contact | false;
      return hit && hit.depth > .005;
    });
    this.capsule.radius = RADIUS;
    return !blocked;
  }

  /** Boarding and landing may cross a small gap, but never a wall or solid object. */
  clearBoardingLine(from: Vector3, to: Vector3): boolean {
    const distance = from.distanceTo(to);
    const ray = new Ray(from, to.clone().sub(from).normalize());
    this.bodyBounds.setFromPoints([from, to]).expandByScalar(.01);
    this.contacts.length = 0;
    if (this.surfaces) this.nearby(this.surfaces);
    return !this.contacts.some(triangle => {
      const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, this.hitPoint);
      return hit && hit.distanceTo(from) < distance - .05;
    });
  }

  swimmingClear(position: Vector3): boolean {
    return inBounds(position.x, position.z) && !this.contact(position, true);
  }

  /** Prefer a nearby clear shore or deck when stepping out of the boat. */
  boatLanding(from: Vector3): Vector3 | undefined {
    for (let radius = 1.2; radius <= 3.9; radius += .3) for (let i = 0; i < 32; i++) {
      const angle = i / 32 * Math.PI * 2;
      const x = from.x + Math.sin(angle) * radius, z = from.z + Math.cos(angle) * radius;
      if (!inBounds(x, z)) continue;
      const floor = this.support(x, z, 2.1);
      if (floor < -.28 || floor > 2.1) continue;
      const point = new Vector3(x, floor + EYE_HEIGHT, z);
      if (this.contact(point) || !this.clearBoardingLine(from, point)) continue;
      return point;
    }
  }

  /** Sweep in body-sized substeps: sprinting, wheel input and fast travel cannot tunnel. */
  move(from: Vector3, target: Vector3, result: Vector3): void {
    const dx = target.x - from.x, dz = target.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STRIDE));
    result.copy(from);
    for (let step = 0; step < steps; step++) this.advance(result, dx / steps, dz / steps);
  }

  private advance(position: Vector3, dx: number, dz: number): void {
    const previous = this.previous.copy(position), next = this.candidate.copy(position);
    next.x += dx; next.z += dz;
    if (!inBounds(next.x, next.z)) return;
    const ceiling = Math.max(previous.y - EYE_HEIGHT, seabedHeight(next.x, next.z)) + STEP_HEIGHT;
    next.y = this.eyeHeight(next.x, next.z, ceiling);
    for (let attempt = 0; attempt < 8; attempt++) {
      const hit = this.contact(next);
      if (!hit) {
        // A changing foot support must not turn a forward step into a backward shove.
        if ((next.x - previous.x) * dx + (next.z - previous.z) * dz >= -(CONTACT_EPSILON ** 2)) position.copy(next);
        return;
      }
      // Shallow slopes and exposed roots can support feet; walls cannot lift the player.
      const rise = hit.normal.y > 0 ? hit.depth / hit.normal.y : Infinity;
      if (hit.normal.y >= WALKABLE_NORMAL && next.y - EYE_HEIGHT + rise <= ceiling) {
        next.y += rise;
      } else {
        const horizontal = hit.normal.x ** 2 + hit.normal.z ** 2;
        if (horizontal < .001) break; // Insufficient headroom for this step.
        next.x += hit.normal.x * hit.depth / horizontal;
        next.z += hit.normal.z * hit.depth / horizontal;
        if (!inBounds(next.x, next.z)) break;
        next.y = this.eyeHeight(next.x, next.z, ceiling);
      }
    }
    // A tight corner or ceiling leaves us at the last safe position.
    position.copy(previous);
  }

  private canTraverse(from: Vector3, to: Vector3): boolean {
    const point = from.clone(), target = from.clone();
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / STRIDE));
    for (let i = 1; i <= steps; i++) {
      target.lerpVectors(from, to, i / steps);
      this.move(point, target, point);
      if (Math.hypot(point.x - target.x, point.z - target.z) > .025) return false;
    }
    return true;
  }

  /** Route landmark travel through the same clearance used for walking and swimming. */
  findPath(start: Vector3, destination: Vector3): Vector3[] {
    if (this.canTraverse(start, destination)) return [start.clone(), destination.clone()];
    const spacing = .8;
    type Node = { x: number; z: number; position: Vector3; cost: number; score: number; parent?: Node; closed: boolean };
    const nodes = new Map<string, Node | null>(), queue: Node[] = [];
    const heuristic = (p: Vector3) => Math.hypot(p.x - destination.x, p.z - destination.z);
    const enqueue = (node: Node) => {
      let low = 0, high = queue.length;
      while (low < high) { const mid = (low + high) >>> 1; if (queue[mid].score > node.score) low = mid + 1; else high = mid; }
      queue.splice(low, 0, node);
    };
    const first: Node = { x: 0, z: 0, position: start.clone(), cost: 0, score: heuristic(start), closed: false };
    nodes.set('0,0', first); enqueue(first);
    for (let visited = 0; queue.length && visited < 12000; visited++) {
      const current = queue.pop()!;
      if (current.closed) continue;
      current.closed = true;
      if (heuristic(current.position) < spacing * 1.5 && this.canTraverse(current.position, destination)) {
        const path = [destination.clone()];
        for (let node: Node | undefined = current; node; node = node.parent) path.push(node.position);
        path.reverse();
        // Remove grid zigzags only where a swept body can take the shortcut.
        const smooth = [path[0]];
        for (let index = 0; index < path.length - 1;) {
          let end = Math.min(path.length - 1, index + 24);
          while (end > index + 1 && !this.canTraverse(path[index], path[end])) end--;
          smooth.push(path[end]); index = end;
        }
        return smooth;
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const x = current.x + dx, z = current.z + dz, key = `${x},${z}`;
        if (!nodes.has(key)) {
          const px = start.x + x * spacing, pz = start.z + z * spacing;
          let node: Node | null = null;
          if (inBounds(px, pz)) {
            const position = new Vector3(px, this.eyeHeight(px, pz, Math.max(current.position.y - EYE_HEIGHT, seabedHeight(px, pz)) + STEP_HEIGHT), pz);
            const hit = this.contact(position);
            if (!hit) node = { x, z, position, cost: Infinity, score: Infinity, closed: false };
          }
          nodes.set(key, node);
        }
        const node = nodes.get(key);
        const cost = current.cost + spacing * Math.hypot(dx, dz);
        if (!node || node.closed || cost >= node.cost || !this.canTraverse(current.position, node.position)) continue;
        const old = queue.indexOf(node);
        if (old >= 0) queue.splice(old, 1);
        node.cost = cost; node.score = cost + heuristic(node.position); node.parent = current;
        enqueue(node);
      }
    }
    return [start.clone()];
  }
}
