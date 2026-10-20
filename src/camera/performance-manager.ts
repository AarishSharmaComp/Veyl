import { PerformanceMode } from '../shared/types';

const TARGET_FRAME_INTERVAL: Record<PerformanceMode, number> = {
  quality: 34,
  balanced: 52,
  performance: 86
};

export class PerformanceManager {
  private mode: PerformanceMode = 'balanced';
  private lastInferenceAt = 0;
  private inferenceMs = 0;
  private frameCount = 0;
  private fpsWindowStarted = performance.now();
  private fps = 0;

  setMode(mode: PerformanceMode): void {
    this.mode = mode;
  }

  shouldInfer(now: number): boolean {
    const adaptivePenalty = this.inferenceMs > 85 ? 24 : this.inferenceMs > 55 ? 10 : 0;
    return now - this.lastInferenceAt >= TARGET_FRAME_INTERVAL[this.mode] + adaptivePenalty;
  }

  beginInference(now: number): void {
    this.lastInferenceAt = now;
  }

  recordInference(durationMs: number): void {
    this.inferenceMs = this.inferenceMs * 0.8 + durationMs * 0.2;
  }

  recordFrame(now: number): void {
    this.frameCount += 1;
    const elapsed = now - this.fpsWindowStarted;
    if (elapsed >= 1000) {
      this.fps = (this.frameCount * 1000) / elapsed;
      this.frameCount = 0;
      this.fpsWindowStarted = now;
    }
  }

  getFps(): number {
    return Math.round(this.fps);
  }

  getInferenceMs(): number {
    return Math.round(this.inferenceMs);
  }
}
