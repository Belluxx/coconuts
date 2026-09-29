import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { EYE_HEIGHT, SWIM_EYE_HEIGHT, type IslandCollisions } from './collisions';
import { findRestSpot, getRestPose, REST_ACTIONS, type RestKind } from './resting';
import type { Rowboat } from './rowing';

type Journey = {
  points: Vector3[];
  lengths: number[];
  distance: number;
  fromRotation: Quaternion;
  toRotation: Quaternion;
  elapsed: number;
  duration: number;
  segment: number;
  segmentDistance: number;
  traveled: number;
};

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyC']);
const SWIM_DEPTH = EYE_HEIGHT - SWIM_EYE_HEIGHT;

/** Walking, swimming, diving and rowing, with interruptible paths between landmarks. */
export class IslandControls {
  onInteraction?: () => void;
  onNotice?: (message: string) => void;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private readonly movementTarget = new Vector3();
  private readonly desiredVelocity = new Vector3();
  private readonly blockedMovement = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly initialPosition: Vector3;
  private readonly initialTarget: Vector3;
  private yaw = 0;
  private pitch = 0;
  private wheelVelocity = 0;
  private swimming = false;
  private waterDepth = 0;
  private viewBob = 0;
  private journey?: Journey;
  private rest?: { position: Vector3; exit: Vector3; kind: RestKind };
  private restTransition?: { from: Vector3; to: Vector3; elapsed: number };
  private boatTransition?: { from: Vector3; elapsed: number };
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private enabled = true;
  private lookEnabled = true;
  private mousePaused = false;
  private mousePosition?: { x: number; y: number };
  private wasPointerLocked = false;
  private pointerLockRequest = 0;
  private pointerLockPending = false;

  /** The desktop app provides `activate`, a user activation that lets the mouse lock when the window gains focus. */
  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly collisions: IslandCollisions,
    private readonly waterHeight: (x: number, z: number) => number,
    private readonly rowboat: Rowboat,
    private readonly activate?: () => Promise<unknown>,
  ) {
    collisions.project(camera.position);
    this.position.copy(camera.position);
    this.updateMovementMode();
    this.initialPosition = camera.position.clone();
    this.initialTarget = camera.position.clone().add(camera.getWorldDirection(new Vector3()).multiplyScalar(30));
    this.readRotation();
    this.updateCursor();
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerUp);
    canvas.addEventListener('lostpointercapture', this.pointerUp);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.contextMenu);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    window.addEventListener('focus', this.windowFocus);
    document.addEventListener('visibilitychange', this.visibilityChange);
    document.addEventListener('mousemove', this.mouseMove);
    document.addEventListener('pointerlockchange', this.pointerLockChange);
    document.addEventListener('focusin', this.focusIn);
    if (document.hasFocus()) this.windowFocus();
  }

  get isTraveling(): boolean { return !!this.journey; }
  get isRowing(): boolean { return this.rowboat.occupied; }
  get boatAction(): string | undefined {
    if (!this.enabled || !this.lookEnabled || this.rest || this.restTransition || this.boatTransition || this.journey) return;
    if (this.isRowing) return 'Leave the boat';
    return this.rowboat.canBoard(this.camera.position) ? 'Board the rowboat' : undefined;
  }
  get isSwimming(): boolean { return this.swimming; }
  get restAction(): string | undefined {
    if (!this.enabled || !this.lookEnabled || this.isRowing) return;
    if (this.rest) return REST_ACTIONS[this.rest.kind].leave;
    if (this.journey || this.restTransition || this.swimming) return;
    const spot = findRestSpot(this.camera.position);
    return spot ? REST_ACTIONS[spot.kind].enter : undefined;
  }

  toggleRowing(): void {
    if (!this.boatAction) return;
    this.interact();
    if (this.isRowing) {
      const exit = this.rowboat.dismount();
      if (!exit) { this.onNotice?.('There’s no room to step out here. Row a little clear of the obstacles.'); return; }
      this.position.copy(exit.position);
      this.camera.position.copy(exit.position);
      this.swimming = exit.swimming;
      this.viewBob = 0;
      this.updateMovementMode();
      this.clearInput();
      return;
    }
    this.boatTransition = { from: this.camera.position.clone(), elapsed: 0 };
    this.rowboat.board();
    this.swimming = false;
    this.viewBob = 0;
    this.clearInput();
    this.yaw = this.rowboat.heading + Math.PI;
    this.pitch = -.16;
  }

  toggleResting(): void {
    if (!this.restAction) return;
    this.interact();
    if (this.rest) { this.standUp(); return; }
    const spot = findRestSpot(this.camera.position);
    if (!spot) return;
    const pose = getRestPose(spot, this.camera.position);
    // Every spot returns to the clear floor where the player approached it.
    const exit = this.position.clone();
    this.collisions.project(exit);
    this.rest = { position: pose.position, exit, kind: spot.kind };
    this.clearInput();
    this.restTransition = { from: this.camera.position.clone(), to: pose.position, elapsed: 0 };
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
  }

  private standUp(): void {
    if (!this.rest) return;
    this.restTransition = { from: this.camera.position.clone(), to: this.rest.exit, elapsed: 0 };
    if (this.rest.kind === 'lie') this.pitch = 0;
    this.rest = undefined;
    this.clearInput();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.interrupt();
      this.blur();
      this.position.copy(this.camera.position);
    }
    this.updateCursor();
  }

  setLookEnabled(enabled: boolean): void {
    if (this.lookEnabled === enabled) return;
    this.lookEnabled = enabled;
    this.mousePosition = undefined;
    if (!enabled) {
      this.clearInput();
      this.releasePointerLock();
    }
    this.updateCursor();
  }

  /** Walk (or swim) a clear path to `position`, turning to face `target`. */
  goTo(position: Vector3, target: Vector3, duration = 3.2): void {
    if (this.isRowing) {
      this.rowboat.returnToBerth();
      this.position.copy(this.collisions.boatLanding(this.rowboat.seatPosition()) ?? this.initialPosition);
      this.camera.position.copy(this.position);
      this.boatTransition = undefined;
      this.swimming = false;
      this.updateMovementMode();
      this.clearInput();
    }
    // Landmark travel starts in the clear aisle even when leaving furniture.
    if (this.rest || this.restTransition) {
      this.camera.position.copy(this.rest?.exit ?? this.restTransition!.to);
      this.position.copy(this.camera.position);
      this.rest = undefined;
      this.restTransition = undefined;
    }
    const destination = position.clone();
    this.collisions.project(destination);
    // A temporary camera computes a look rotation without changing the live view.
    const aim = this.camera.clone();
    aim.position.copy(destination);
    aim.lookAt(target);
    const start = this.camera.position.clone();
    this.collisions.project(start);
    const points = this.collisions.findPath(start, destination);
    if (points.length < 2) return;
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.z - points[index].z));
    this.journey = {
      points, lengths, distance: lengths.reduce((sum, length) => sum + length, 0),
      fromRotation: this.camera.quaternion.clone(),
      toRotation: aim.quaternion.clone(),
      elapsed: 0, segment: 0, segmentDistance: 0, traveled: 0,
      duration: Math.max(0.05, duration),
    };
    this.velocity.set(0, 0, 0);
    this.wheelVelocity = 0;
    this.keys.clear();
  }

  /** Travel back to the starting view on the shore. */
  returnHome(duration: number): void { this.goTo(this.initialPosition, this.initialTarget, duration); }

  update(dt: number, time: number): void {
    dt = Math.min(Math.max(dt, 0), 0.05);
    const forwardInput = Number(this.held('KeyW', 'ArrowUp')) - Number(this.held('KeyS', 'ArrowDown'));
    const rightInput = Number(this.held('KeyD', 'ArrowRight')) - Number(this.held('KeyA', 'ArrowLeft'));
    const canRow = this.enabled && this.lookEnabled && !this.boatTransition;
    this.yaw += this.rowboat.update(dt, canRow ? forwardInput : 0, canRow ? rightInput : 0, this.reducedMotion.matches);
    if (!this.enabled) {
      if (this.isRowing) this.camera.position.copy(this.rowboat.seatPosition());
      return;
    }
    if (this.journey) {
      const journey = this.journey;
      journey.elapsed += dt;
      const t = Math.min(journey.elapsed / journey.duration, 1);
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      let remaining = Math.max(0, eased * journey.distance - journey.traveled);
      // Visit every crossed corner, even when reduced motion completes a route in one frame.
      while (journey.segment < journey.lengths.length && remaining > 1e-8) {
        const length = journey.lengths[journey.segment];
        const distance = Math.min(remaining, length - journey.segmentDistance);
        journey.segmentDistance += distance;
        const progress = length > 0 ? journey.segmentDistance / length : 1;
        this.movementTarget.lerpVectors(journey.points[journey.segment], journey.points[journey.segment + 1], progress);
        this.collisions.move(this.position, this.movementTarget, this.position);
        remaining -= distance;
        if (journey.segmentDistance >= length - 1e-8) { journey.segment++; journey.segmentDistance = 0; }
      }
      journey.traveled = eased * journey.distance;
      this.updateMovementMode();
      this.updateEyeHeight(dt);
      this.camera.quaternion.slerpQuaternions(journey.fromRotation, journey.toRotation, eased);
      if (t >= 1) {
        this.journey = undefined;
        this.readRotation();
      }
      return;
    }

    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.rotation.setFromEuler(this.euler);
    this.camera.quaternion.slerp(this.rotation, 1 - Math.exp(-13 * dt));
    if (this.isRowing) {
      const seat = this.rowboat.seatPosition();
      if (this.boatTransition) {
        this.boatTransition.elapsed += dt;
        const t = this.reducedMotion.matches ? 1 : Math.min(this.boatTransition.elapsed / .5, 1);
        this.camera.position.lerpVectors(this.boatTransition.from, seat, t * t * (3 - 2 * t));
        if (t === 1) this.boatTransition = undefined;
      } else this.camera.position.copy(seat);
      this.position.copy(this.camera.position);
      return;
    }
    if (this.restTransition) {
      const transition = this.restTransition;
      transition.elapsed += dt;
      const t = this.reducedMotion.matches ? 1 : Math.min(transition.elapsed / .45, 1);
      this.camera.position.lerpVectors(transition.from, transition.to, t * t * (3 - 2 * t));
      this.position.copy(this.camera.position);
      if (t === 1) this.restTransition = undefined;
      return;
    }
    if (this.rest) {
      this.camera.position.copy(this.rest.position);
      return;
    }
    this.forward.set(0, 0, -1).applyQuaternion(this.rotation);
    if (!this.swimming) this.forward.setY(0).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.rotation).setY(0).normalize();

    // Water first slows wading, then carries the body in the direction of the view.
    const immersion = MathUtils.smoothstep(this.waterDepth, .25, SWIM_DEPTH);
    const speed = MathUtils.lerp(4.5, 2.2, immersion)
      * (this.held('ShiftLeft', 'ShiftRight') ? MathUtils.lerp(2.1, 1.6, immersion) : 1);
    this.desiredVelocity.copy(this.forward).multiplyScalar(forwardInput).addScaledVector(this.right, rightInput);
    if (this.swimming) this.desiredVelocity.y += Number(this.keys.has('Space')) - Number(this.keys.has('KeyC'));
    if (this.desiredVelocity.lengthSq() > 0) this.desiredVelocity.normalize().multiplyScalar(speed);
    // Scroll and pinch obey the same swimming speed limit as the keyboard.
    this.desiredVelocity.addScaledVector(this.forward, this.wheelVelocity);
    this.desiredVelocity.clampLength(0, speed);
    const surfaceEye = this.waterHeight(this.position.x, this.position.z) + SWIM_EYE_HEIGHT;
    if (this.swimming && this.desiredVelocity.y >= 0) {
      // Gentle buoyancy returns an idle swimmer to the surface; deliberate dives win.
      const lift = surfaceEye - this.position.y;
      this.desiredVelocity.y += lift > .5 ? .18 : MathUtils.clamp(lift * 3, -.8, .8);
    }
    this.velocity.lerp(this.desiredVelocity, 1 - Math.exp(-MathUtils.lerp(7, 2.6, immersion) * dt));
    const oldX = this.position.x, oldZ = this.position.z;
    this.movementTarget.copy(this.position).addScaledVector(this.velocity, dt);
    this.wheelVelocity *= Math.exp(-7 * dt);
    if (this.swimming) {
      this.movementTarget.y = Math.min(this.movementTarget.y, this.waterHeight(this.movementTarget.x, this.movementTarget.z) + SWIM_EYE_HEIGHT);
      this.collisions.swim(this.position, this.movementTarget, this.position);
    } else {
      this.collisions.move(this.position, this.movementTarget, this.position);
    }
    // Retain motion along a wall, but discard velocity that the solid surface stopped.
    this.blockedMovement.subVectors(this.movementTarget, this.position);
    if (!this.swimming) this.blockedMovement.y = 0;
    const blockedDistanceSq = this.blockedMovement.lengthSq();
    if (blockedDistanceSq > 1e-10) {
      const intoObstacle = this.velocity.dot(this.blockedMovement) / blockedDistanceSq;
      if (intoObstacle > 0) this.velocity.addScaledVector(this.blockedMovement, -intoObstacle);
    }
    this.updateMovementMode();
    this.updateEyeHeight(dt);
    const stride = Math.min(Math.hypot(this.position.x - oldX, this.position.z - oldZ) / Math.max(dt, .001) / 4.5, 1);
    this.viewBob = this.reducedMotion.matches ? 0 : Math.sin(time * 8) * .013 * stride * (1 - immersion);
    this.camera.position.y += this.viewBob;
  }

  private updateMovementMode(): void {
    this.waterDepth = this.collisions.waterDepth(this.position, this.swimming);
    // A small gap between entering and leaving keeps the hint stable at the edge.
    if (!this.swimming) this.swimming = this.waterDepth > SWIM_DEPTH;
    else if (this.waterDepth < SWIM_DEPTH - .15 && this.collisions.standFromWater(this.position)) {
      this.swimming = false;
      this.velocity.y = 0;
    }
  }

  private updateEyeHeight(dt: number): void {
    const immersion = MathUtils.smoothstep(this.waterDepth, .25, SWIM_DEPTH);
    const floatingEye = this.waterHeight(this.position.x, this.position.z) + SWIM_EYE_HEIGHT;
    const eyeY = this.swimming && !this.journey ? this.position.y
      : Math.max(this.position.y, floatingEye * immersion + SWIM_EYE_HEIGHT * (1 - immersion));
    const previousY = this.camera.position.y - this.viewBob;
    this.camera.position.set(this.position.x, MathUtils.lerp(previousY, eyeY, 1 - Math.exp(-MathUtils.lerp(16, 5, immersion) * dt)), this.position.z);
    this.viewBob = 0;
  }

  private held(a: string, b: string): boolean { return this.keys.has(a) || this.keys.has(b); }

  private readRotation(): void {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = this.euler.y;
    this.pitch = MathUtils.clamp(this.euler.x, -1.35, 1.35);
  }

  private interrupt(): void {
    if (this.journey) {
      this.journey = undefined;
      this.position.copy(this.camera.position);
      this.readRotation();
    }
  }

  private interact(): void {
    this.interrupt();
    this.onInteraction?.();
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (event.pointerType === 'mouse' && event.button === 2 && !this.isRowing && this.boatAction) {
      this.toggleRowing();
      this.canvas.focus({ preventScroll: true });
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.interact();
    if (!this.lookEnabled) return;
    this.canvas.focus({ preventScroll: true });
    if (event.pointerType === 'mouse') {
      if (!this.activate) this.mousePaused = false;
      this.mousePosition = { x: event.clientX, y: event.clientY };
      this.updateCursor();
      this.lockPointer();
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.canvas.setPointerCapture(event.pointerId);
  };

  private mouseMove = (event: MouseEvent): void => {
    if (!this.canLook || !document.hasFocus()) return;
    if (document.pointerLockElement === this.canvas) {
      this.look(event.movementX, event.movementY);
    } else if (event.target === this.canvas) {
      if (this.mousePosition) this.look(event.clientX - this.mousePosition.x, event.clientY - this.mousePosition.y);
      this.mousePosition = { x: event.clientX, y: event.clientY };
    } else {
      this.mousePosition = undefined;
    }
  };

  private look(dx: number, dy: number): void {
    if ((!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.interrupt();
    this.yaw -= dx * 0.0024;
    this.pitch = MathUtils.clamp(this.pitch - dy * 0.0024, -1.35, 1.35);
  }

  private pointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (this.pointers.size === 1) {
      this.look(dx, dy);
    } else if (!this.rest && !this.restTransition && !this.isRowing) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const previousDistance = Math.hypot(pointer.x - other.x, pointer.y - other.y);
        const distance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        this.wheelVelocity = MathUtils.clamp(this.wheelVelocity + (distance - previousDistance) * 0.5, -12, 12);
      }
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  };

  private pointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private pointerLeave = (): void => { this.mousePosition = undefined; };

  private wheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.rest || this.restTransition || this.isRowing) return;
    this.interact();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    this.wheelVelocity = MathUtils.clamp(this.wheelVelocity - delta * 0.06, -12, 12);
  };

  private keyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape' || (event.code === 'Tab' && document.pointerLockElement === this.canvas)) {
      this.pauseMouse();
    }
    if (!this.enabled) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="slider"]')) return;
    if (event.code === 'KeyF') {
      if (!event.repeat && this.boatAction) { event.preventDefault(); this.toggleRowing(); }
      else if (!event.repeat && this.restAction) { event.preventDefault(); this.toggleResting(); }
      return;
    }
    if (this.isRowing && event.code.startsWith('Shift')) {
      event.preventDefault();
      if (!event.repeat) this.toggleRowing();
      return;
    }
    if (!MOVE_KEYS.has(event.code)) return;
    if ((event.code === 'Space' || event.code === 'KeyC') && !this.swimming) return;
    event.preventDefault();
    if (!event.code.startsWith('Shift')) this.standUp();
    if (!this.keys.has(event.code)) this.interact();
    this.keys.add(event.code);
  };

  private keyUp = (event: KeyboardEvent): void => { this.keys.delete(event.code); };
  private contextMenu = (event: Event): void => { event.preventDefault(); };
  private get canLook(): boolean {
    return this.enabled && this.lookEnabled && !this.mousePaused
      && (!this.activate || document.pointerLockElement === this.canvas);
  }
  private updateCursor(): void {
    this.canvas.style.cursor = this.canLook ? 'none' : 'default';
    this.canvas.classList.toggle('mouse-looking', this.canLook);
  }
  private lockPointer(): void { void this.requestPointerLock(); }
  private async requestPointerLock(): Promise<void> {
    if (this.pointerLockPending || !this.canCapturePointer) return;
    const request = ++this.pointerLockRequest;
    this.pointerLockPending = true;
    try {
      // Keep activation and capture in one cancellable request. Focus can change
      // while the desktop process is granting activation.
      if (this.activate) await this.activate();
      if (request !== this.pointerLockRequest || !this.canCapturePointer) return;
      if (document.pointerLockElement !== this.canvas) await this.canvas.requestPointerLock();
      if (request !== this.pointerLockRequest) return;
      this.mousePaused = document.pointerLockElement !== this.canvas && !!this.activate;
    } catch {
      // Browsers retain hover look; desktop capture can be retried with a click.
      if (request === this.pointerLockRequest && this.activate) this.mousePaused = true;
    } finally {
      if (request === this.pointerLockRequest) {
        this.pointerLockPending = false;
        this.updateCursor();
      }
    }
  }
  private get canCapturePointer(): boolean {
    return this.enabled && this.lookEnabled && document.hasFocus() && !document.hidden;
  }
  private releasePointerLock(): void {
    ++this.pointerLockRequest;
    this.pointerLockPending = false;
    // An intentional release may notify us after a subsequent focus event.
    this.wasPointerLocked = false;
    if (document.pointerLockElement === this.canvas) {
      this.mousePaused = true;
      document.exitPointerLock();
    }
  }
  private pauseMouse(): void {
    this.mousePaused = true;
    this.clearInput();
    this.releasePointerLock();
    this.updateCursor();
  }
  private pointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (this.wasPointerLocked && !locked) {
      this.mousePaused = true;
      this.clearInput();
    }
    this.wasPointerLocked = locked;
    this.mousePosition = undefined;
    if (locked && this.pointerLockPending && this.canCapturePointer) this.mousePaused = false;
    if (locked && (!this.canLook || !this.canCapturePointer)) this.releasePointerLock();
    this.updateCursor();
  };
  private clearInput(): void {
    this.keys.clear();
    for (const id of this.pointers.keys()) {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    }
    this.pointers.clear();
    this.mousePosition = undefined;
    this.velocity.set(0, 0, 0);
    this.wheelVelocity = 0;
  }
  private focusIn = (event: FocusEvent): void => {
    if (event.target !== this.canvas) {
      this.clearInput();
      this.releasePointerLock();
    }
  };
  private blur = (): void => { this.pauseMouse(); };
  private windowFocus = (): void => {
    // Open panels and letters keep the cursor; Escape still releases it.
    if (!this.activate || !this.enabled || !this.lookEnabled) return;
    this.mousePaused = true;
    this.canvas.focus({ preventScroll: true });
    this.updateCursor();
    this.lockPointer();
  };
  private visibilityChange = (): void => { if (document.hidden) this.blur(); };
}
