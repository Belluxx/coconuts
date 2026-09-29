import * as THREE from 'three/webgpu';
import { float, texture, uniform, vec2 } from 'three/tsl';
import { coastDistance, seabedHeight, shoreZ } from '../land/terrain';
import { smoothstep as smooth } from '../math';
import type { TSLNode } from '../shading';
import { GRAVITY, seaTime } from './seaState';
import { SURF_START, swellForcing } from './swell';

/** Landward end of the simulated beach, in meters from the shoreline. */
export const SURF_END = 8;
/** Independent cross-shore transects along the bay, interpolated between. */
const TRANSECTS = 36, FIRST_X = -168, SPACING = 9.6;

// Textures resample the cells: coarse texels offshore, fine ones across the swash.
const SPLIT = -8, COARSE = .4, FINE = .05;
const COARSE_TEXELS = (SPLIT - SURF_START) / COARSE;
const TEXELS = COARSE_TEXELS + (SURF_END - SPLIT) / FINE;

const STEP = 1 / 120;
/** Water thinner than a millimeter is a film held by the sand; it no longer flows. */
const FLOWING = .001;
/** Depth at which a wetting cell's own water fully sets its drawn surface. */
const WETTED = .004;
/** Seconds over which thin water's drawn depth follows the simulation. */
const FRONT_EASING = .1;
/** Quadratic friction of a rippled sand bed. */
const FRICTION = .012;
/** Infiltration into dry carbonate sand (m/s), and the water its top centimeter holds. */
const PERMEABILITY = .003, PORE_WATER = .004;
/** A film over saturated sand still drains into its surface texture (m/s). */
const FILM_RUNOFF = .0004;
/** Surface sand relaxes to capillary equilibrium over this many seconds. */
const DRAINAGE = 45;
/** Van Genuchten retention of fine sand: air entry near 30 cm of suction. */
export const CAPILLARY_ALPHA = 3.5, CAPILLARY_N = 4;
/** Fraction of the turbulent energy loss spent pushing air below the surface. */
const ENTRAINMENT = .4;
/** Dissipation (m³/s³ per m²) below which no bubbles form; smooth waves stay clear. */
const QUIET = .03;
/** Surface coverage made by each meter of air that rises out of the water. */
const FOAM_PER_AIR = 60;
/** Seconds a foam raft lasts on water, and once stranded on draining sand. */
const FOAM_LIFE = 12, STRANDED_FOAM_LIFE = 2.5;
/** Foam patterns follow two material markers, each reset while the other is shown. */
export const MARKER_PERIOD = 8;

/** Saturation of surface sand at a height above the water table (van Genuchten). */
export function capillarySaturation(height: number) {
  return height <= 0 ? 1 : (1 + (CAPILLARY_ALPHA * height) ** CAPILLARY_N) ** (1 / CAPILLARY_N - 1);
}

export interface SurfSample { elevation: number; velocity: number; depth: number; foam: number; air: number }

/**
 * Nonlinear shallow-water transects from the reef flat to the dry beach.
 *
 * A well-balanced, wetting and drying finite-volume scheme carries the swell
 * across the surf zone: fronts steepen into bores on their own and run up the
 * sand as swash. The energy each bore loses entrains air; bubbles rise and
 * become foam rafts that drift with the water and burst. Swash soaks into the
 * sand, which then drains toward capillary equilibrium above the water table.
 */
export class SurfSimulation {
  readonly cells: number;
  readonly water = new Float32Array(TEXELS * TRANSECTS * 4);
  readonly foam = new Float32Array(TEXELS * TRANSECTS * 4);
  /** Mean elevation reached by the swash: the beach's water table. */
  waterTable = 0;
  time = 0;
  private readonly center: Float64Array;
  private readonly width: Float64Array;
  private readonly bed: Float64Array;
  private readonly h: Float64Array;
  /** Depth drawn per cell, with the fronts placed between cells. */
  private readonly drawn: Float64Array;
  private readonly q: Float64Array;
  private readonly air: Float64Array;
  private readonly bubbles: Float64Array;
  private readonly saturation: Float64Array;
  private readonly markers: [Float64Array, Float64Array];
  private readonly tables = new Float64Array(TRANSECTS);
  private readonly faces: { mass: Float64Array; left: Float64Array; right: Float64Array; loss: Float64Array; air: Float64Array; foam: Float64Array };
  private readonly previous: Float64Array;
  private readonly texelCell = new Int32Array(TEXELS);
  private readonly texelWeight = new Float32Array(TEXELS);
  private accumulator = 0;

  constructor() {
    // Tenth-meter cells across the swash, widening to 60 cm on the reef flat.
    const edges = [SURF_END];
    while (edges[edges.length - 1] > SURF_START) {
      const edge = edges[edges.length - 1];
      const spacing = edge > -6 ? .1 : Math.min(.6, .1 + (-6 - edge) * .02);
      edges.push(edge - spacing < SURF_START + spacing * .5 ? SURF_START : edge - spacing);
    }
    edges.reverse();
    const n = this.cells = edges.length - 1;
    this.center = new Float64Array(n);
    this.width = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.center[i] = (edges[i] + edges[i + 1]) / 2; this.width[i] = edges[i + 1] - edges[i]; }
    const field = () => new Float64Array(n * TRANSECTS);
    this.bed = field(); this.h = field(); this.drawn = field(); this.q = field(); this.air = field(); this.bubbles = field();
    this.saturation = field(); this.markers = [field(), field()];
    const face = () => new Float64Array(n + 1);
    this.faces = { mass: face(), left: face(), right: face(), loss: face(), air: face(), foam: face() };
    this.previous = new Float64Array(n);
    for (let j = 0; j < TRANSECTS; j++) for (let i = 0; i < n; i++) {
      const x = FIRST_X + j * SPACING, k = j * n + i;
      this.bed[k] = seabedHeight(x, shoreZ(x) + this.center[i]);
      this.h[k] = Math.max(0, -this.bed[k]);
      this.saturation[k] = capillarySaturation(this.bed[k]);
      this.markers[0][k] = this.markers[1][k] = this.center[i];
    }
    for (let t = 0; t < TEXELS; t++) {
      const d = t < COARSE_TEXELS ? SURF_START + (t + .5) * COARSE : SPLIT + (t - COARSE_TEXELS + .5) * FINE;
      let i = 0;
      while (i < n - 2 && this.center[i + 1] < d) i++;
      this.texelCell[t] = i;
      this.texelWeight[t] = Math.max(0, Math.min(1, (d - this.center[i]) / (this.center[i + 1] - this.center[i])));
    }
    // Arrive at a living shoreline: waves already breaking, sand already
    // soaked by earlier swash, foam already drifting.
    for (let i = 0; i < 30 / STEP; i++) this.step();
    this.resample();
  }

  /** Advance by real seconds; returns whether the textures changed. */
  update(seconds: number) {
    this.accumulator += Math.min(Math.max(seconds, 0), .25);
    if (this.accumulator < STEP) return false;
    let steps = 0;
    while (this.accumulator >= STEP) { this.step(); this.accumulator -= STEP; steps++; }
    this.resample(steps * STEP);
    return true;
  }

  private step() {
    const before = this.time;
    this.time += STEP;
    for (const [index, offset] of [[0, 0], [1, MARKER_PERIOD / 2]] as const) {
      if (Math.floor((this.time + offset) / MARKER_PERIOD) === Math.floor((before + offset) / MARKER_PERIOD)) continue;
      const marker = this.markers[index];
      for (let k = 0; k < marker.length; k++) marker[k] = this.center[k % this.cells];
    }
    let table = 0;
    for (let j = 0; j < TRANSECTS; j++) {
      this.stepTransect(j, swellForcing(FIRST_X + j * SPACING, this.time));
      table += this.tables[j];
    }
    this.waterTable = table / TRANSECTS;
  }

  private stepTransect(j: number, incoming: number) {
    const n = this.cells, o = j * n, dt = STEP;
    const { bed, h, q, air, bubbles, saturation, width, faces } = this;
    const { mass, left, right, loss } = faces;

    // Absorbing, generating boundary: prescribe only the incoming characteristic.
    const depth = Math.max(.5, -bed[o]);
    const edgeVelocity = h[o] > FLOWING ? q[o] / h[o] : 0;
    const outgoing = edgeVelocity - 2 * Math.sqrt(GRAVITY * h[o]);
    const entering = 2 * Math.sqrt(GRAVITY * depth) + 2 * incoming * Math.sqrt(GRAVITY / depth);
    const ghostH = ((entering - outgoing) / 4) ** 2 / GRAVITY, ghostU = (entering + outgoing) / 2;

    for (let f = 0; f <= n; f++) {
      const l = o + f - 1, r = o + f;
      const hl = f === 0 ? ghostH : h[l], bl = f === 0 ? bed[o] : bed[l];
      const ul = f === 0 ? ghostU : hl > FLOWING ? q[l] / hl : 0;
      const hr = f === n ? hl : h[r], br = f === n ? bl : bed[r];
      const ur = f === n ? -ul : hr > FLOWING ? q[r] / hr : 0;
      // Hydrostatic reconstruction keeps still water still over sloping sand.
      const top = Math.max(bl, br);
      const a = Math.max(0, hl + bl - top), c = Math.max(0, hr + br - top);
      const speed = Math.max(Math.abs(ul) + Math.sqrt(GRAVITY * a), Math.abs(ur) + Math.sqrt(GRAVITY * c));
      const flux = .5 * (a * ul + c * ur - speed * (c - a));
      const momentum = .5 * (a * ul * ul + c * ur * ur + .5 * GRAVITY * (a * a + c * c) - speed * (c * ur - a * ul));
      mass[f] = flux;
      left[f] = momentum + .5 * GRAVITY * (hl * hl - a * a);
      right[f] = momentum + .5 * GRAVITY * (hr * hr - c * c);
      // Energy the flux removes: its entropy production. It vanishes for smooth
      // waves and concentrates in bores and collapsing swash fronts.
      const jump = c - a, shear = ur - ul;
      loss[f] = Math.max(0, .5 * speed * ((GRAVITY * jump - .5 * (ur * ur - ul * ul)) * jump + shear * (c * ur - a * ul)));
      // Bubbles and foam ride with the water that crosses this face.
      const upstream = flux >= 0 ? a : c;
      const velocity = upstream > FLOWING ? Math.max(-speed, Math.min(speed, flux / upstream)) : 0;
      const from = flux >= 0 ? l : r, inside = flux >= 0 ? f > 0 : f < n;
      faces.air[f] = inside ? velocity * air[from] : 0;
      faces.foam[f] = inside ? velocity * bubbles[from] : 0;
    }

    const table = this.tables[j];
    let shoreline = bed[o] + h[o], connected = true;
    for (let i = 0; i < n; i++) {
      const k = o + i, ratio = dt / width[i];
      let water = Math.max(0, h[k] - ratio * (mass[i + 1] - mass[i]));
      let discharge = q[k] - ratio * (left[i + 1] - right[i]);
      // Semi-implicit friction stays stable as the last millimeters drain.
      discharge /= 1 + dt * FRICTION * Math.abs(discharge) / Math.max(water * water, 1e-8);
      // Swash soaks into unsaturated sand; a thin film also runs off into it.
      const soak = Math.min(water, dt * (PERMEABILITY * (1 - saturation[k]) + (water < .003 ? FILM_RUNOFF : 0)));
      if (soak > 0) {
        discharge *= (water - soak) / water;
        water -= soak;
        saturation[k] = Math.min(1, saturation[k] + soak / PORE_WATER);
      }
      if (water < FLOWING) {
        discharge = 0;
        const equilibrium = capillarySaturation(bed[k] - table);
        saturation[k] = equilibrium + (saturation[k] - equilibrium) * Math.exp(-dt / DRAINAGE);
      }
      h[k] = water; q[k] = discharge;
      connected &&= water > .002;
      if (connected) shoreline = bed[k] + water;

      // Bubbles: entrained by dissipation, carried by the flow, rising out
      // within a second or two, faster in the shallows. Rising air feeds foam.
      const dissipation = (loss[i] + loss[i + 1]) * .5 / width[i];
      let entrained = air[k] - ratio * (faces.air[i + 1] - faces.air[i])
        + dt * ENTRAINMENT * Math.max(0, dissipation - QUIET) / (GRAVITY * Math.max(.5 * water, .04));
      const capacity = .6 * water;
      let released = Math.max(0, entrained - capacity);
      entrained = Math.max(0, entrained - released);
      const rising = entrained * (1 - Math.exp(-dt / (.6 + 4 * water)));
      entrained -= rising; released += rising;
      air[k] = entrained;
      const raft = bubbles[k] - ratio * (faces.foam[i + 1] - faces.foam[i]) + released * FOAM_PER_AIR;
      bubbles[k] = Math.max(0, Math.min(1.25, raft * Math.exp(-dt / (water > .002 ? FOAM_LIFE : STRANDED_FOAM_LIFE))));
    }
    // The shoreline's mean height sets the water table inside the beach.
    this.tables[j] = table + (shoreline - table) * (1 - Math.exp(-dt / 40));

    // Material markers move with the water, so foam patterns drift, stretch and stall.
    for (const marker of this.markers) {
      this.previous.set(marker.subarray(o, o + n));
      for (let i = 1; i < n - 1; i++) {
        const k = o + i, velocity = h[k] > FLOWING ? q[k] / h[k] : 0;
        if (velocity === 0) continue;
        const next = velocity > 0 ? i - 1 : i + 1;
        const t = Math.min(1, Math.abs(velocity) * dt / Math.abs(this.center[i] - this.center[next]));
        marker[k] = this.previous[i] + (this.previous[next] - this.previous[i]) * t;
      }
    }
  }

  /**
   * Depth to draw in each cell. Over a stepped bed an advancing front fills
   * each cell before it spills into the next, so it moves in jumps. Drawn
   * instead where the front's surface meets the sloping sand, it slides
   * forward as that surface rises: past the last wet cell the surface runs on
   * level, and depth turns negative in the first cell whose bed rises above
   * it, so interpolation places the edge between cells. Each cell's own water
   * takes over gradually as it wets, and thin water eases toward its new
   * depth over a few frames, spreading the remaining spurts evenly in time.
   */
  private reconstructFronts(seconds: number) {
    const n = this.cells, { h, bed, drawn } = this;
    for (let j = 0; j < TRANSECTS; j++) {
      let surface = NaN;
      for (let i = 0; i < n; i++) {
        const k = j * n + i, reach = surface - bed[k];
        let target: number;
        if (reach > 0) {
          target = Math.max(h[k], reach + (h[k] - reach) * smooth(FLOWING, WETTED, h[k]));
          surface = bed[k] + target;
        } else if (h[k] > FLOWING) {
          target = h[k];
          surface = bed[k] + h[k];
        } else {
          target = reach < 0 ? reach : h[k];
          surface = NaN;
        }
        const lag = FRONT_EASING * (1 - smooth(.05, .15, target));
        drawn[k] = lag > 0 && seconds > 0 ? drawn[k] + (target - drawn[k]) * (1 - Math.exp(-seconds / lag)) : target;
      }
    }
  }

  /** Write the transects into both textures: the same data the CPU samples. */
  private resample(seconds = 0) {
    const n = this.cells, markerWeight = this.markerWeight();
    this.reconstructFronts(seconds);
    for (let j = 0; j < TRANSECTS; j++) for (let t = 0; t < TEXELS; t++) {
      const a = j * n + this.texelCell[t], b = a + 1, w = this.texelWeight[t], at = (j * TEXELS + t) * 4;
      const lerp = (field: Float64Array) => field[a] + (field[b] - field[a]) * w;
      const flow = (k: number) => this.h[k] > FLOWING ? this.q[k] / this.h[k] : 0;
      const depth = Math.max(0, lerp(this.drawn));
      this.water[at] = lerp(this.bed) + depth;
      this.water[at + 1] = flow(a) + (flow(b) - flow(a)) * w;
      this.water[at + 2] = depth;
      this.water[at + 3] = lerp(this.saturation);
      this.foam[at] = lerp(this.bubbles);
      this.foam[at + 1] = lerp(this.air);
      this.foam[at + 2] = lerp(this.markers[0]);
      this.foam[at + 3] = lerp(this.markers[1]);
    }
    foamMarkers.value = markerWeight;
  }

  /** Weight of the first marker: zero as it resets, one while the second does. */
  private markerWeight() {
    return 1 - Math.abs((this.time / MARKER_PERIOD % 1) * 2 - 1);
  }

  /** Surf state at `x` and cross-shore distance `d`, bilinear like the shader. */
  sample(x: number, d: number, result: SurfSample): SurfSample {
    const texel = Math.max(0, Math.min(TEXELS - 1.001, surfTexel(d) - .5));
    const row = Math.max(0, Math.min(TRANSECTS - 1.001, (x - FIRST_X) / SPACING));
    const c = Math.floor(texel), r = Math.floor(row), u = texel - c, v = row - r;
    const channel = (data: Float32Array, k: number) => {
      const at = (rr: number, cc: number) => data[(rr * TEXELS + cc) * 4 + k];
      return (at(r, c) * (1 - u) + at(r, c + 1) * u) * (1 - v) + (at(r + 1, c) * (1 - u) + at(r + 1, c + 1) * u) * v;
    };
    result.elevation = channel(this.water, 0); result.velocity = channel(this.water, 1);
    result.depth = channel(this.water, 2); result.foam = channel(this.foam, 0); result.air = channel(this.foam, 1);
    return result;
  }
}

/** Texel coordinate (texel centers at .5) of a cross-shore distance. */
function surfTexel(d: number) {
  return d < SPLIT ? (d - SURF_START) / COARSE : COARSE_TEXELS + (d - SPLIT) / FINE;
}

/** Blend weight of the first foam marker; the shader crossfades the pair. */
export const foamMarkers = uniform(1);
/** Mean swash elevation; sand above it drains to capillary equilibrium. */
export const waterTable = uniform(0);

let simulation: SurfSimulation | undefined;
let waterMap: THREE.DataTexture | undefined;
let foamMap: THREE.DataTexture | undefined;

function surfMap(data: Float32Array, name: string) {
  const map = new THREE.DataTexture(data, TEXELS, TRANSECTS, THREE.RGBAFormat, THREE.FloatType);
  map.name = name;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
}

/** The simulation spins up 30 seconds of surf, so start it on first use. */
export function surf() {
  if (!simulation) {
    simulation = new SurfSimulation();
    waterMap = surfMap(simulation.water, 'Surf · surface elevation, velocity, depth, sand saturation');
    foamMap = surfMap(simulation.foam, 'Surf · foam rafts, entrained air, flow markers');
    seaTime.value = simulation.time;
    waterTable.value = simulation.waterTable;
  }
  return simulation;
}

/** Advance the surf; returns the simulation so audio can listen to the same waves. */
export function updateSurf(seconds: number) {
  const waves = surf();
  if (waves.update(seconds)) waterMap!.needsUpdate = foamMap!.needsUpdate = true;
  seaTime.value = waves.time;
  waterTable.value = waves.waterTable;
  return waves;
}

function surfUV(xz: TSLNode) {
  const d = coastDistance(xz);
  const texel = d.lessThan(SPLIT).select(d.sub(SURF_START).div(COARSE), d.sub(SPLIT).div(FINE).add(COARSE_TEXELS));
  return vec2(
    texel.div(TEXELS).clamp(.5 / TEXELS, 1 - .5 / TEXELS),
    xz.x.sub(FIRST_X).div(SPACING).add(.5).div(TRANSECTS).clamp(.5 / TRANSECTS, 1 - .5 / TRANSECTS),
  );
}

/** Surface elevation, cross-shore velocity, water depth and sand saturation. */
export const surfWater = (xz: TSLNode) => { surf(); return texture(waterMap!, surfUV(xz)).level(float(0)); };
/** Foam coverage, entrained air (m), and the two material markers. */
export const surfFoam = (xz: TSLNode) => { surf(); return texture(foamMap!, surfUV(xz)).level(float(0)); };
/** Where the simulated transects apply: along the bay, up to the dry beach. */
export const surfCoverage = (xz: TSLNode) => float(1)
  .sub(xz.x.abs().sub(FIRST_X + (TRANSECTS - 1) * SPACING - 8).div(12).clamp(0, 1))
  .mul(float(1).sub(coastDistance(xz).sub(SURF_END - 1).clamp(0, 1)));
