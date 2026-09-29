import { uniform } from 'three/tsl';

export const GRAVITY = 9.81;
/** Surface tension over density (m³/s²): capillary restoring force on short ripples. */
const CAPILLARITY = 7.4e-5;

/** Simulated seconds; every wave, foam and caustic effect follows this clock. */
export const seaTime = uniform(0);

/** Angular frequency of a free wave of wavenumber k in water of the given depth. */
export function angularFrequency(k: number, depth = Infinity) {
  return Math.sqrt((GRAVITY * k + CAPILLARITY * k ** 3) * Math.tanh(k * Math.min(depth, 500)));
}

/**
 * Linear gravity-wave dispersion, ω² = gk·tanh(kh), solved for k by Newton
 * iteration, with the group velocity that carries the wave energy.
 */
export function dispersion(omega: number, depth: number) {
  let k = Math.max(omega * omega / GRAVITY, omega / Math.sqrt(GRAVITY * depth));
  for (let i = 0; i < 12; i++) {
    const t = Math.tanh(k * depth);
    k -= (GRAVITY * k * t - omega * omega) / (GRAVITY * (t + k * depth * (1 - t * t)));
  }
  const kh = k * depth;
  const group = omega / k * .5 * (1 + (kh > 20 ? 0 : 2 * kh / Math.sinh(2 * kh)));
  return { k, group };
}
