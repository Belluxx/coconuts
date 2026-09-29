import * as THREE from 'three/webgpu';
import { floatHull } from '../water/buoyancy';
import { desktop, type AgentBottle, type AgentState } from './bridge';
import { createMessageUI } from './messages';

// The yacht moors in open water off the pier head, bow west, clear of the
// jetty's stringers (z -12), the ladder, and the moored rowboat.
const BERTH = new THREE.Vector3(-24, 0, -13.8);
const p = (x: number, z: number) => new THREE.Vector3(x, 0, z);
// Glide in from the lagoon along the pier head; leave to the west, then out to sea.
const APPROACH = [p(14, -48), p(4, -24), p(-6, -13.8), p(-14, -13.8), BERTH];
const DEPART = [p(-32, -14), p(-38, -21), p(-37, -33), p(-25, -50), p(-8, -72)];
const LAP = Array.from({ length: 8 }, (_, i) => p(-5 + Math.cos(-i / 8 * Math.PI * 2) * 46, -118 + Math.sin(-i / 8 * Math.PI * 2) * 22));
type Route = { curve: THREE.CatmullRomCurve3; length: number; kind: 'approach' | 'depart' | 'lap' };
/** A smooth route from the current pose; the second point keeps the heading continuous. */
function planRoute(position: THREE.Vector3, heading: number, points: THREE.Vector3[], kind: Route['kind']): Route {
  const start = p(position.x, position.z);
  const ahead = start.clone().add(p(Math.sin(heading), Math.cos(heading)).multiplyScalar(kind === 'depart' ? 6 : 10));
  const curve = new THREE.CatmullRomCurve3([start, ahead, ...points], false, 'centripetal');
  return { curve, length: curve.getLength(), kind };
}
function bottleMesh() {
  const group = new THREE.Group();
  const glass = new THREE.MeshStandardNodeMaterial({ color: '#5fb59a', roughness: .08, metalness: .1, transparent: true, opacity: .72, emissive: '#2c8f78', emissiveIntensity: .35 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.095, .095, .34, 16), glass);
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(.095, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  shoulder.position.y = .17;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(.035, .04, .13, 12), glass);
  neck.position.y = .3;
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(.036, .03, .06, 10), new THREE.MeshStandardNodeMaterial({ color: '#b98a55', roughness: .9 }));
  cork.position.y = .39;
  const scroll = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .26, 10), new THREE.MeshStandardNodeMaterial({ color: '#f3e3b8', roughness: .8 }));
  group.add(body, shoulder, neck, cork, scroll);
  group.rotation.z = Math.PI / 2 - .12;
  return group;
}

/**
 * The sailing yacht is the agent's messenger: it waits out at sea while an agent
 * works and comes alongside the jetty with a bottle when there is news.
 */
export function createMessageBoat(
  yacht: THREE.Object3D,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  waterHeight: (x: number, z: number) => number,
  onModalChange: (open: boolean) => void,
  canInteract: () => boolean,
) {
  let state: AgentState = { working: {}, bottles: [] };
  const picked = new Set<string>();
  const heading = { value: -Math.PI / 2, speed: 0 };
  yacht.position.set(BERTH.x, .1, BERTH.z);
  yacht.rotation.y = heading.value;
  const bottle = bottleMesh();
  // Rest the tilted bottle's lowest point on the cabin roof. It follows the
  // yacht's buoyancy, so it must not bob independently through the roof.
  const bottleBounds = new THREE.Box3().setFromObject(bottle, true);
  bottle.position.set(.45, 1.51 - bottleBounds.min.y + .002, .8);
  bottle.visible = false;
  yacht.add(bottle);
  let route: Route | undefined;
  let travelled = 0;
  const tangent = new THREE.Vector3();
  let mode: 'berth' | 'sea' = 'berth';
  let moored = true;

  const ui = createMessageUI(canvas, onModalChange);
  let waiting: AgentBottle[] = [];
  let jobs: AgentState['working'][string][] = [];

  function setState(next: AgentState) {
    state = next;
    waiting = state.bottles.filter(entry => {
      if (entry.question) return entry.question.state === 'pending';
      return !entry.read && !picked.has(entry.id);
    }).sort((a, b) => Number(!!b.question) - Number(!!a.question));
    jobs = Object.values(state.working).filter(job => !job.waiting);
    mode = waiting.length || !jobs.length ? 'berth' : 'sea';
    // Only laps at sea can be cut short; harbour manoeuvres always finish.
    if (route?.kind === 'lap' && mode === 'berth') route = undefined;
    ui.refresh(state.bottles);
  }

  const bottleWorld = new THREE.Vector3();
  const nearBottle = () => bottle.visible && camera.position.distanceTo(bottle.getWorldPosition(bottleWorld)) < 6.5;
  const canPickUp = () => !ui.isReading && canInteract() && nearBottle() && waiting.length > 0;

  function pickUp() {
    if (!canPickUp()) return;
    const entry = waiting[0];
    ui.open(entry);
    picked.add(entry.id);
    setState(state);
    void desktop?.markRead(entry.id).catch(() => {});
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.code !== 'KeyE' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (canPickUp()) {
      event.preventDefault();
      pickUp();
    }
  };
  window.addEventListener('keydown', onKey);
  desktop?.onAgentState(setState);

  return {
    get canPickUp() { return canPickUp(); },
    get isReading() { return ui.isReading; },
    get hasQuestion() { return waiting[0]?.question?.state === 'pending'; },
    pickUp,
    /** Show what the boat is doing in the status note. */
    updateStatus(dt: number, visible: boolean) {
      ui.updateActivity({ jobs, bottles: waiting, moored: moored && mode === 'berth', nearby: nearBottle() }, dt, visible);
    },
    update(dt: number) {
      if (!route) {
        if (mode === 'berth' && !moored) {
          route = planRoute(yacht.position, heading.value, APPROACH, 'approach');
        } else if (mode === 'sea') {
          route = planRoute(yacht.position, heading.value, moored ? DEPART : LAP, moored ? 'depart' : 'lap');
          moored = false;
        }
        travelled = 0;
      }
      if (route) {
        const remaining = route.length - travelled;
        const cruise = route.kind === 'lap' ? 3.2 : 5.5;
        const speed = route.kind === 'approach' ? Math.min(cruise, .25 + Math.sqrt(2 * .4 * remaining)) : cruise;
        heading.speed = THREE.MathUtils.damp(heading.speed, speed, route.kind === 'depart' ? .6 : 1.2, dt);
        travelled = Math.min(route.length, travelled + heading.speed * dt);
        const u = travelled / route.length;
        const point = route.curve.getPointAt(u);
        route.curve.getTangentAt(u, tangent);
        yacht.position.x = point.x;
        yacht.position.z = point.z;
        heading.value = Math.atan2(tangent.x, tangent.z);
        yacht.rotation.y = heading.value;
        if (u >= 1) {
          if (route.kind === 'approach') {
            moored = true;
            heading.speed = 0;
          }
          route = undefined;
        }
      }
      floatHull(yacht, waterHeight, 9, 2.7, .10, dt, moored ? 0 : Math.min(heading.speed, 6) * .012);
      bottle.visible = moored && mode === 'berth' && waiting.length > 0;
    },
  };
}
