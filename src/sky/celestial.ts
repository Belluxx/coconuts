import * as THREE from 'three/webgpu';
import { DEG } from '../math';

/** Milliseconds per day. */
export const DAY = 86_400_000;
/** Days since the J2000.0 epoch (Julian date 2451545). */
const daysSinceJ2000 = (date: Date) => date.getTime() / DAY + 2440587.5 - 2451545;
const WEST = new THREE.Vector3(116, 0, -163).normalize();
export const NORTH = new THREE.Vector3(-WEST.z, 0, WEST.x);
const UP = new THREE.Vector3(0, 1, 0);
const wrap = (angle: number) => (angle % 360 + 360) % 360;

interface Observer { latitude: number; longitude: number }
export interface SkyPosition {
  sun: THREE.Vector3;
  moon: THREE.Vector3;
  moonPhase: number;
  morning: boolean;
  /** Maps catalog J2000 equatorial xyz into the island's horizon frame. */
  equatorialToWorld: THREE.Matrix3;
}

/** Greenwich mean sidereal angle, using UTC as an approximation to UT1. */
function siderealAngle(date: Date, longitude: number) {
  const d = daysSinceJ2000(date), t = d / 36525;
  return wrap(280.46061837 + 360.98564736629 * d + .000387933 * t * t - t * t * t / 38710000 + longitude) * DEG;
}

function horizonMatrix(date: Date, observer: Observer) {
  const latitude = observer.latitude * DEG, angle = siderealAngle(date, observer.longitude);
  const pole = UP.clone().multiplyScalar(Math.sin(latitude)).addScaledVector(NORTH, Math.cos(latitude));
  const meridian = UP.clone().multiplyScalar(Math.cos(latitude)).addScaledVector(NORTH, -Math.sin(latitude));
  const x = meridian.clone().multiplyScalar(Math.cos(angle)).addScaledVector(WEST, Math.sin(angle));
  const y = meridian.multiplyScalar(Math.sin(angle)).addScaledVector(WEST, -Math.cos(angle));
  return new THREE.Matrix3().set(x.x, y.x, pole.x, x.y, y.y, pole.y, x.z, y.z, pole.z);
}

/** IAU 1976 precession, adequate for the present-day visual sky. */
function precession(date: Date) {
  const t = daysSinceJ2000(date) / 36525;
  const zeta = (2306.2181 * t + .30188 * t * t + .017998 * t ** 3) / 3600 * DEG;
  const z = (2306.2181 * t + 1.09468 * t * t + .018203 * t ** 3) / 3600 * DEG;
  const theta = (2004.3109 * t - .42665 * t * t - .041833 * t ** 3) / 3600 * DEG;
  const rotation = new THREE.Matrix4().makeRotationZ(z)
    .multiply(new THREE.Matrix4().makeRotationY(-theta))
    .multiply(new THREE.Matrix4().makeRotationZ(zeta));
  return new THREE.Matrix3().setFromMatrix4(rotation);
}

const equatorial = (longitude: number, latitude: number, obliquity: number) => {
  const x = Math.cos(longitude) * Math.cos(latitude), y = Math.sin(longitude) * Math.cos(latitude), z = Math.sin(latitude);
  return new THREE.Vector3(x, y * Math.cos(obliquity) - z * Math.sin(obliquity), y * Math.sin(obliquity) + z * Math.cos(obliquity));
};

/** Low-precision solar and lunar ephemerides; all bodies share one UTC instant. */
export function skyAt(date: Date, observer: Observer, target?: SkyPosition): SkyPosition {
  const sky = target ?? { sun: new THREE.Vector3(), moon: new THREE.Vector3(), moonPhase: 0, morning: true, equatorialToWorld: new THREE.Matrix3() };
  const d = daysSinceJ2000(date);
  const obliquity = (23.439291 - .0000003563 * d) * DEG;
  const solarMean = wrap(357.5291 + .98560028 * d) * DEG;
  const solarLongitude = (wrap(280.459 + .98564736 * d) + 1.9148 * Math.sin(solarMean) + .0200 * Math.sin(2 * solarMean)) * DEG;
  const lunarMean = wrap(134.963 + 13.064993 * d) * DEG;
  const elongation = wrap(297.850 + 12.190749 * d) * DEG;
  const argument = wrap(93.272 + 13.229350 * d) * DEG;
  const lunarLongitude = (wrap(218.316 + 13.176396 * d) + 6.289 * Math.sin(lunarMean)
    + 1.274 * Math.sin(2 * elongation - lunarMean) + .658 * Math.sin(2 * elongation)
    + .214 * Math.sin(2 * lunarMean) - .186 * Math.sin(solarMean) - .114 * Math.sin(2 * argument)) * DEG;
  const lunarLatitude = (5.128 * Math.sin(argument) + .280 * Math.sin(lunarMean + argument)
    + .277 * Math.sin(lunarMean - argument) + .173 * Math.sin(2 * elongation - argument)) * DEG;
  const horizon = horizonMatrix(date, observer);
  sky.sun.copy(equatorial(solarLongitude, 0, obliquity)).applyMatrix3(horizon).normalize();
  sky.moon.copy(equatorial(lunarLongitude, lunarLatitude, obliquity)).applyMatrix3(horizon).normalize();
  sky.moonPhase = (1 - sky.sun.dot(sky.moon)) / 2;
  sky.equatorialToWorld.copy(horizon).multiply(precession(date));
  sky.morning = minutesNow(date, observer) < 720;
  return sky;
}

/** Mean solar time at the bundled country center; no timezone service or DST. */
export function minutesNow(date: Date, observer: Observer) {
  return ((date.getTime() / 60000 + observer.longitude * 4) % 1440 + 1440) % 1440;
}

export function todayAt(minutes: number, today: Date, observer: Observer) {
  const offset = observer.longitude * 240000;
  return new Date(Math.floor((today.getTime() + offset) / DAY) * DAY - offset + minutes * 60000);
}

export const elevation = (direction: THREE.Vector3) => Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)) / DEG;
