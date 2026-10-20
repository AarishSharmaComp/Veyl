import { DEFAULT_SETTINGS, SnapSettings } from './types';

export function sanitizeSettings(value: Partial<SnapSettings> | null | undefined): SnapSettings {
  const candidate = value ?? {};
  const performanceMode = candidate.performanceMode;

  return {
    realTimeRemoval: candidate.realTimeRemoval !== false,
    useBackgroundPlate: candidate.useBackgroundPlate !== false,
    snapDetection: candidate.snapDetection === true,
    snapSensitivity: clampNumber(candidate.snapSensitivity, DEFAULT_SETTINGS.snapSensitivity, 0, 1),
    animations: candidate.animations !== false,
    animationIntensity: clampNumber(candidate.animationIntensity, DEFAULT_SETTINGS.animationIntensity, 0, 1),
    performanceMode:
      performanceMode === 'quality' || performanceMode === 'performance' || performanceMode === 'balanced'
        ? performanceMode
        : DEFAULT_SETTINGS.performanceMode
  };
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
