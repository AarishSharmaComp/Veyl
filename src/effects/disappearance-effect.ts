export type EffectTransition = 'none' | 'pixelating' | 'shattering' | 'disappeared' | 'reappearing';

export interface EffectFrame {
  state: EffectTransition;
  progress: number;
  visibility: number;
  pixelation: number;
  shatter: number;
}

/**
 * Owns only the timing/state of the visual transition. Rendering remains in
 * the compositor so gesture detection and camera ownership stay independent.
 */
export class DisappearanceEffect {
  private transition: EffectTransition = 'none';
  private startedAt = 0;
  private duration = 760;

  start(kind: 'disappear' | 'reappear', duration = kind === 'disappear' ? 760 : 360): void {
    if (kind === 'disappear') {
      if (this.transition === 'pixelating' || this.transition === 'shattering' || this.transition === 'disappeared') return;
      this.transition = 'pixelating';
    } else {
      if (this.transition === 'reappearing' || this.transition === 'none') return;
      this.transition = 'reappearing';
    }
    this.startedAt = performance.now();
    this.duration = Math.max(1, duration);
  }

  reset(): void {
    this.transition = 'none';
    this.startedAt = 0;
    this.duration = 760;
  }

  get state(): EffectTransition {
    return this.transition;
  }

  sample(now = performance.now()): EffectFrame {
    if (this.transition === 'none') return { state: 'none', progress: 0, visibility: 0, pixelation: 0, shatter: 0 };
    if (this.transition === 'disappeared') return { state: 'disappeared', progress: 1, visibility: 1, pixelation: 1, shatter: 1 };

    const progress = clamp((now - this.startedAt) / this.duration, 0, 1);
    if (this.transition === 'reappearing') {
      if (progress >= 1) {
        this.transition = 'none';
        return { state: 'none', progress: 1, visibility: 0, pixelation: 0, shatter: 0 };
      }
      return {
        state: 'reappearing',
        progress,
        visibility: 1 - progress,
        pixelation: 1 - progress,
        shatter: 1 - progress
      };
    }

    if (progress >= 1) {
      this.transition = 'disappeared';
      return { state: 'disappeared', progress: 1, visibility: 1, pixelation: 1, shatter: 1 };
    }
    const pixelation = clamp(progress / 0.34, 0, 1);
    const shatter = clamp((progress - 0.22) / 0.78, 0, 1);
    this.transition = shatter > 0 ? 'shattering' : 'pixelating';
    return {
      state: this.transition,
      progress,
      visibility: progress,
      pixelation,
      shatter
    };
  }

  get isTransitioning(): boolean {
    return this.transition === 'pixelating' || this.transition === 'shattering' || this.transition === 'reappearing';
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
