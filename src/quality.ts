import { loadSetting, saveSetting } from './storage';

export type QualityLevel = 'low' | 'medium' | 'high';

/** Every value a visual preset changes. */
export interface QualitySettings {
  pixelRatio: number;
  shadowSize: number;
  shadowHz: number;
  reflectionScale: number;
  reflectionHz: number;
  cloudSteps: number;
  localLights: number;
  localLightDistance: number;
  /** Distance within which vegetation uses full-detail meshes. */
  vegetationNear: number;
  /** Also use full-detail vegetation in reflections and shadows. */
  detailedVegetationPasses: boolean;
  /** Ocean grid spacing across the bay and at the shoreline, in meters. */
  oceanStep: number;
  shoreStep: number;
  underwaterSteps: number;
  contactShadowSamples: number;
  plankton: number;
  /** Fraction of each shoal that swims, and the distance at which fish fade out. */
  fishDensity: number;
  fishDistance: number;
  /** Turtles and rays drawn at once. */
  visitors: number;
}

// Target roughly 60 / 30 / 15 fps on M1 at 1440×847; actual rates vary by view.
export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    pixelRatio: 1, shadowSize: 2048, shadowHz: 20,
    reflectionScale: .5, reflectionHz: 15, cloudSteps: 40,
    localLights: 6, localLightDistance: 90,
    vegetationNear: 40, detailedVegetationPasses: false,
    oceanStep: .75, shoreStep: .32,
    underwaterSteps: 32, contactShadowSamples: 8, plankton: 2200,
    fishDensity: .48, fishDistance: 48, visitors: 7,
  },
  medium: {
    pixelRatio: 1.5, shadowSize: 3072, shadowHz: 30,
    reflectionScale: .75, reflectionHz: 30, cloudSteps: 64,
    localLights: 12, localLightDistance: 160,
    vegetationNear: 85, detailedVegetationPasses: false,
    oceanStep: .5, shoreStep: .24,
    underwaterSteps: 48, contactShadowSamples: 12, plankton: 4400,
    fishDensity: .74, fishDistance: 60, visitors: 11,
  },
  high: {
    // Every lamp stays lit, including lamps seen only in the water's reflection.
    pixelRatio: 2, shadowSize: 4096, shadowHz: 60,
    reflectionScale: 1, reflectionHz: 60, cloudSteps: 96,
    localLights: Infinity, localLightDistance: Infinity,
    vegetationNear: 180, detailedVegetationPasses: true,
    oceanStep: .32, shoreStep: .16,
    underwaterSteps: 64, contactShadowSamples: 16, plankton: 6400,
    fishDensity: 1, fishDistance: 72, visitors: 16,
  },
};

const KEY = 'coconuts.quality';

export function isQualityLevel(value: unknown): value is QualityLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function loadQuality(): QualityLevel {
  const saved = loadSetting(KEY);
  return isQualityLevel(saved) ? saved : 'medium';
}

export const saveQuality = (level: QualityLevel) => saveSetting(KEY, level);
