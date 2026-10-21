import { DEFAULT_SETTINGS, VeylSettings } from './types';

export function sanitizeSettings(value: Partial<VeylSettings> & LegacyGestureSettings | null | undefined): VeylSettings {
  const candidate = value && typeof value === 'object' ? value : {};
  const legacySensitivity = candidate.snapSensitivity;
  const performanceMode = candidate.performanceMode;

  return {
    realTimeRemoval: candidate.realTimeRemoval !== false,
    useBackgroundPlate: candidate.useBackgroundPlate !== false,
    // Audio-trigger consent from an earlier version is NOT an opt-in to this
    // different visual feature. Only an explicit new camera-gesture flag enables it.
    gestureDetection: candidate.gestureDetection === true,
    gestureSensitivity: clampNumber(candidate.gestureSensitivity ?? legacySensitivity, DEFAULT_SETTINGS.gestureSensitivity, 0, 1),
    gestureCooldownMs: clampNumber(candidate.gestureCooldownMs, DEFAULT_SETTINGS.gestureCooldownMs, 450, 4000),
    animations: candidate.animations !== false,
    animationIntensity: clampNumber(candidate.animationIntensity, DEFAULT_SETTINGS.animationIntensity, 0, 1),
    performanceMode:
      performanceMode === 'quality' || performanceMode === 'performance' || performanceMode === 'balanced'
        ? performanceMode
        : DEFAULT_SETTINGS.performanceMode
  };
}

interface LegacyGestureSettings {
  snapDetection?: boolean;
  snapSensitivity?: number;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
