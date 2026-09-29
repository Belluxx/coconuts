import * as THREE from 'three/webgpu';
import { latticeHash, smoothstep as ease } from '../math';
import { baseGround, groundHeight, terrainNoise } from './terrain';
import { GORGE, LIP, POOL_LEVEL, gorgeInner, gorgeRadius, hillside, toWorld } from './waterfallLayout';

/** Granite splits into sheets parallel to the old surface and into blocks across them. */
const SHEET = 1.7, BLOCK = 1.35;

/**
 * Radial offset of the rock face from the gorge's plan radius: exfoliation
 * sheets and joint blocks that jut and recede, each sheet's face leaning back
 * so the next one overhangs it; the plunge pool's spray and eddies have
 * undercut the base behind the curtain, and the brink overhangs its recess.
 */
function faceOffset(angle: number, y: number, radius: number, rim: number) {
  const sheet = (y + terrainNoise(angle * 3.1, 7.3) * .45) / SHEET;
  const layer = Math.floor(sheet), within = sheet - layer;
  const arc = (angle * radius + terrainNoise(y * .4, 3.7) * .7) / BLOCK;
  const block = Math.floor(arc), across = arc - block;
  // Blocks meet in short chamfers rather than knife edges.
  const jut = (latticeHash(layer, block, 811) - .5) * .5 * (1 - ease(.82, 1, across))
    + (latticeHash(layer, block + 1, 811) - .5) * .5 * ease(.82, 1, across);
  // The brink itself stays exactly where the water leaves it.
  const brink = Math.exp(-((angle / .35) ** 2)) * ease(LIP.y - 2.2, LIP.y - .2, y);
  let offset = (jut + within * .18) * (1 - brink);
  offset += 1.05 * Math.exp(-((angle / .55) ** 2)) * (1 - ease(POOL_LEVEL, POOL_LEVEL + 4.5, y));
  offset += .5 * Math.exp(-((angle / .4) ** 2)) * ease(LIP.y - .05, LIP.y - 1.4, y);
  // Weathering rounds the top edge back.
  return offset + ease(rim - .7, rim, y) * .22 * (1 - brink);
}

/** Crease darkness under each overhanging sheet, for the stone material. */
const crease = (y: number, angle: number) => 1 - ease(0, .22, (y + terrainNoise(angle * 3.1, 7.3) * .45) / SHEET % 1);

/** The horseshoe's rock walls, faceted like the island's other stone. */
export function createGorgeWall() {
  const columns = 96, rows = 76, capRows = 6;
  const positions: number[] = [], colors: number[] = [], creases: number[] = [], feet: number[] = [], indices: number[] = [];
  const span = GORGE.span + .3, stride = rows + capRows + 1;
  for (let column = 0; column <= columns; column++) {
    const angle = -span + 2 * span * column / columns;
    const radius = gorgeRadius(angle), inner = gorgeInner(angle);
    const at = (r: number) => toWorld(GORGE.back - Math.cos(angle) * r, Math.sin(angle) * r);
    const ground = (r: number) => { const p = at(r); return groundHeight(p.x, p.z); };
    // The face rises to the hillside above its plan line, and to a low lip at the mouth.
    const floor = ground(radius - .35), end = inner + .75;
    const rim = Math.max(floor + .3, hillside(at(radius).x, at(radius).z, baseGround(at(radius).x, at(radius).z)));
    const bottom = floor - .7;
    const tint = .94 + latticeHash(Math.floor(angle * 4), 0, 97) * .1;
    // Past the mouth, where no step in the ground needs covering, the lip dwindles into the slope.
    const emerge = ease(span, GORGE.span - .15, Math.abs(angle));
    const vertex = (r: number, height: number, creaseValue: number) => {
      const p = at(r), below = groundHeight(p.x, p.z) - .12;
      const y = below + (height - below) * emerge;
      positions.push(p.x, y, p.z);
      colors.push(tint, tint * (.99 + creaseValue * .01), tint * .98);
      creases.push(creaseValue);
      feet.push(y - floor);
    };
    for (let row = 0; row <= rows; row++) {
      const y = bottom + (rim - bottom) * row / rows;
      vertex(radius + faceOffset(angle, y, radius, rim), y, crease(y, angle));
    }
    // A cap carries the rock back over the terrain's step and tucks under the ground beyond it.
    const top = radius + faceOffset(angle, rim, radius, rim), tuck = ground(end) - .04;
    for (let k = 1; k <= capRows; k++) {
      const r = top + (end - top) * k / capRows, t = k / capRows;
      vertex(r, k === capRows ? tuck : Math.max(ground(r) + .02, rim + (tuck - rim) * t), 0);
    }
    if (column < columns) for (let row = 0; row < stride - 1; row++) {
      const a = column * stride + row, b = a + stride;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  indexed.setAttribute('rockCrease', new THREE.Float32BufferAttribute(creases, 1));
  indexed.setAttribute('rockFoot', new THREE.Float32BufferAttribute(feet, 1));
  indexed.setIndex(indices);
  // Hard normals per facet, like the rest of the island's stone.
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
