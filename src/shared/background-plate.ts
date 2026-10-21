import type { BackgroundPlate } from './types';

export function isBackgroundPlate(value: unknown): value is BackgroundPlate {
  if (!value || typeof value !== 'object') return false;
  const plate = value as Partial<BackgroundPlate>;
  return typeof plate.dataUrl === 'string' && plate.dataUrl.length <= 6_000_000
    && /^data:image\/(?:jpeg|png|webp);base64,[a-z\d+/]+=*$/i.test(plate.dataUrl)
    && Number.isInteger(plate.width) && plate.width! > 0 && plate.width! <= 8192
    && Number.isInteger(plate.height) && plate.height! > 0 && plate.height! <= 8192
    && typeof plate.capturedAt === 'number' && Number.isFinite(plate.capturedAt) && plate.capturedAt >= 0;
}
