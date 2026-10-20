export type EffectTransition = 'none' | 'disappear' | 'reappear';

export class DisappearanceEffect {
  private transition: EffectTransition = 'none';
  private startedAt = 0;
  private duration = 360;

  start(kind: Exclude<EffectTransition, 'none'>, duration = 360): void {
    this.transition = kind;
    this.startedAt = performance.now();
    this.duration = duration;
  }

  get state(): EffectTransition {
    return this.transition;
  }

  progress(now = performance.now()): number {
    if (this.transition === 'none') return 1;
    const value = Math.min(1, (now - this.startedAt) / this.duration);
    if (value >= 1 && this.transition === 'reappear') {
      this.transition = 'none';
    }
    return value;
  }

  get isTransitioning(): boolean {
    return this.transition !== 'none';
  }
}
