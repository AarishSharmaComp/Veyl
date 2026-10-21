import { BackgroundManager } from './background-manager';
import { SegmentationFrame } from './person-segmenter';
import { DisintegrationEffect } from '../effects/disintegration';
import type { EffectFrame } from '../effects/disappearance-effect';

export interface CompositeOptions {
  hidden: boolean;
  transitionStrength: number;
  realTimeRemoval: boolean;
  useBackgroundPlate: boolean;
  effectState?: EffectFrame['state'];
  backgroundMismatch?: boolean;
  confidenceThreshold?: number;
}

export class Compositor {
  readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly replacementCanvas = document.createElement('canvas');
  private readonly replacementContext: CanvasRenderingContext2D;
  private readonly maskCanvas = document.createElement('canvas');
  private readonly maskContext: CanvasRenderingContext2D;
  private readonly disintegration = new DisintegrationEffect();
  private smoothedMask: Float32Array | null = null;
  private maskPixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  private maskImageData: ImageData | null = null;
  private maskWidth = 0;
  private maskHeight = 0;

  constructor() {
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    const replacementContext = this.replacementCanvas.getContext('2d', { alpha: true });
    const maskContext = this.maskCanvas.getContext('2d', { alpha: true });
    if (!context || !replacementContext || !maskContext) throw new Error('Canvas 2D rendering is unavailable.');
    this.context = context;
    this.replacementContext = replacementContext;
    this.maskContext = maskContext;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.replacementCanvas.width = width;
    this.replacementCanvas.height = height;
    this.maskWidth = 0;
    this.maskHeight = 0;
    this.smoothedMask = null;
    this.maskPixels = null;
    this.maskImageData = null;
    this.disintegration.reset();
  }

  resetMask(): void {
    this.maskWidth = 0;
    this.maskHeight = 0;
    this.smoothedMask = null;
    this.maskPixels = null;
    this.maskImageData = null;
    this.maskCanvas.width = 0;
    this.maskCanvas.height = 0;
  }

  resetVisualEffects(): void {
    this.disintegration.reset();
  }

  render(video: HTMLVideoElement, background: BackgroundManager, mask: SegmentationFrame | null, options: CompositeOptions): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const effectState = options.effectState ?? (options.hidden ? 'shattering' : 'none');
    const livePlateAvailable = options.useBackgroundPlate && background.ready && !options.backgroundMismatch;
    const effectPlateAvailable = options.useBackgroundPlate && background.ready;

    // A completed normal-mode disappearance is a terminal output state. Do
    // not draw the source frame first and then hope a later alpha blend fully
    // covers it; the captured plate is authoritative for this whole frame.
    if (!options.realTimeRemoval && options.hidden && effectState === 'disappeared') {
      if (effectPlateAvailable) this.renderFullPlate(background);
      else this.renderGracefulFallback(video, mask, 1);
      return;
    }

    this.resetOutputState();
    this.context.drawImage(video, 0, 0, width, height);

    // Segmentation is allowed to run independently, but a disabled removal
    // setting must leave this normal visible frame exactly as the source video.
    // The only normal-mode work below is the explicitly enabled live-removal
    // compositor.
    if (!options.hidden || options.transitionStrength <= 0) {
      if (!options.realTimeRemoval || !mask) return;
      if (!livePlateAvailable) return;
      if (!this.updateMask(mask, options.confidenceThreshold ?? 0.43, 1)) return;
      this.renderLiveBackgroundReplacement(background);
      return;
    }

    // In normal mode the disappearance animation resolves to the captured
    // plate itself. Do not use the person mask as a partial overlay here: the
    // mask is for fragment generation, while the stable final output is the
    // saved background snapshot.
    if (!options.realTimeRemoval) {
      if (effectPlateAvailable) this.drawPlateWithAlpha(background, options.transitionStrength);
      else this.renderGracefulFallback(video, mask, options.transitionStrength);
      return;
    }

    if (!livePlateAvailable) {
      this.renderGracefulFallback(video, mask, options.transitionStrength);
      return;
    }

    if (!mask) {
      this.drawPlateWithAlpha(background, options.transitionStrength);
      return;
    }

    // In live-removal mode the person mask scopes the plate overlay during the
    // disappearance transition; normal disabled-mode transitions use the full
    // captured plate branch above.
    if (!this.updateMask(mask, options.confidenceThreshold ?? 0.43, options.transitionStrength)) {
      this.renderGracefulFallback(video, null, options.transitionStrength);
      return;
    }

    this.renderMaskedPlate(background, options.transitionStrength);
  }

  beginDisintegration(
    video: HTMLVideoElement,
    mask: SegmentationFrame | null,
    intensity: number,
    mode: 'disappear' | 'reappear'
  ): boolean {
    if (!mask || !validMask(mask) || !this.updateMask(mask, 0.43, 1)) {
      this.disintegration.reset();
      return false;
    }
    const bounds = this.getMaskBounds(mask, 0.42);
    return this.disintegration.capture(video, mask, this.maskCanvas, bounds, intensity, mode);
  }

  renderDisintegration(context: CanvasRenderingContext2D, frame: EffectFrame): boolean {
    return this.disintegration.render(context, frame);
  }

  get disintegrationFragmentCount(): number {
    return this.disintegration.fragmentCount;
  }

  private drawPlateWithAlpha(background: BackgroundManager, alpha: number): void {
    this.context.save();
    this.context.globalAlpha = alpha;
    background.drawCover(this.context, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

  private renderFullPlate(background: BackgroundManager): void {
    this.resetOutputState();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    background.drawCover(this.context, this.canvas.width, this.canvas.height);
  }

  private resetOutputState(): void {
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'source-over';
    this.context.filter = 'none';
  }

  private renderLiveBackgroundReplacement(background: BackgroundManager): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.replacementContext.save();
    this.replacementContext.globalCompositeOperation = 'source-over';
    this.replacementContext.globalAlpha = 1;
    this.replacementContext.imageSmoothingEnabled = true;
    this.replacementContext.clearRect(0, 0, width, height);
    background.drawCover(this.replacementContext, width, height);
    // The stored mask is the person. Remove that region from the plate so the
    // live source, already drawn on the main canvas, remains visible there.
    this.replacementContext.globalCompositeOperation = 'destination-out';
    this.replacementContext.drawImage(this.maskCanvas, 0, 0, width, height);
    this.replacementContext.restore();
    this.context.save();
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'source-over';
    this.context.drawImage(this.replacementCanvas, 0, 0, width, height);
    this.context.restore();
  }

  private renderMaskedPlate(background: BackgroundManager, alpha: number): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.replacementContext.save();
    this.replacementContext.globalCompositeOperation = 'source-over';
    this.replacementContext.globalAlpha = 1;
    this.replacementContext.imageSmoothingEnabled = true;
    this.replacementContext.clearRect(0, 0, width, height);
    background.drawCover(this.replacementContext, width, height);
    this.replacementContext.globalCompositeOperation = 'destination-in';
    this.replacementContext.drawImage(this.maskCanvas, 0, 0, width, height);
    this.replacementContext.restore();
    this.context.save();
    this.context.globalAlpha = 1;
    this.context.drawImage(this.replacementCanvas, 0, 0, width, height);
    this.context.restore();
    void alpha;
  }

  private updateMask(mask: SegmentationFrame, threshold: number, strength: number): boolean {
    if (mask.width <= 0 || mask.height <= 0 || mask.data.length !== mask.width * mask.height) return false;
    if (!mask.data.every(Number.isFinite)) return false;
    const firstMask = mask.width !== this.maskWidth || mask.height !== this.maskHeight || !this.smoothedMask;
    if (mask.width !== this.maskWidth || mask.height !== this.maskHeight || !this.smoothedMask) {
      this.maskWidth = mask.width;
      this.maskHeight = mask.height;
      this.maskCanvas.width = mask.width;
      this.maskCanvas.height = mask.height;
      this.smoothedMask = new Float32Array(mask.data.length);
      this.maskPixels = new Uint8ClampedArray(new ArrayBuffer(mask.width * mask.height * 4));
      this.maskImageData = new ImageData(this.maskPixels, mask.width, mask.height);
    }

    const smoothed = this.smoothedMask;
    const pixels = this.maskPixels;
    if (!pixels || !this.maskImageData) return false;
    for (let index = 0; index < mask.data.length; index += 1) {
      const value = Math.max(0, Math.min(1, mask.data[index]));
      if (firstMask) smoothed[index] = value;
      else {
        // Follow newly visible pixels quickly, but remove stale foreground
        // promptly. A large symmetric history weight leaves a visible plate
        // silhouette behind a moving person.
        const historyWeight = value < smoothed[index] ? 0.16 : 0.30;
        smoothed[index] = smoothed[index] * historyWeight + value * (1 - historyWeight);
      }
      // Feather only a narrow boundary band. The interior saturates to opaque
      // plate pixels and the exterior reaches zero quickly, reducing grey and
      // colour fringes without turning the mask into a hard cutout.
      const low = Math.max(0, threshold - 0.11);
      const high = Math.min(1, threshold + 0.11);
      const normalized = Math.max(0, Math.min(1, (smoothed[index] - low) / Math.max(0.01, high - low)));
      const feathered = normalized * normalized * (3 - 2 * normalized) * strength;
      const offset = index * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(feathered * 255);
    }
    this.maskContext.putImageData(this.maskImageData, 0, 0);
    return true;
  }

  private renderGracefulFallback(video: HTMLVideoElement, mask: SegmentationFrame | null, strength: number): void {
    if (!mask) {
      // There is no honest way to remove a person without either a valid mask
      // or a clean plate. Keep the track live and visible, but make the
      // degraded state obvious instead of silently claiming a full removal.
      this.context.save();
      this.context.globalAlpha = Math.min(0.82, 0.22 + strength * 0.35);
      this.context.filter = `blur(${Math.max(2, strength * 7)}px)`;
      this.context.drawImage(video, -3, -3, this.canvas.width + 6, this.canvas.height + 6);
      this.context.filter = 'none';
      this.context.restore();
      return;
    }
    // Without a plate there is no honest way to reconstruct hidden scenery. A soft live
    // blur keeps the track valid and avoids a black frame while explaining the limitation.
    if (!this.updateMask(mask, 0.46, strength * 0.82)) {
      this.renderGracefulFallback(video, null, strength);
      return;
    }
    this.replacementContext.globalCompositeOperation = 'source-over';
    this.replacementContext.globalAlpha = 1;
    this.replacementContext.filter = 'blur(8px)';
    this.replacementContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.replacementContext.drawImage(video, -4, -4, this.canvas.width + 8, this.canvas.height + 8);
    this.replacementContext.filter = 'none';
    this.replacementContext.globalCompositeOperation = 'destination-in';
    this.replacementContext.drawImage(this.maskCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.replacementCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  getMaskBounds(mask: SegmentationFrame | null, threshold = 0.42): { x: number; y: number; width: number; height: number } {
    if (!mask) return { x: this.canvas.width * 0.25, y: this.canvas.height * 0.1, width: this.canvas.width * 0.5, height: this.canvas.height * 0.8 };
    let minX = mask.width;
    let minY = mask.height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < mask.height; y += 1) {
      for (let x = 0; x < mask.width; x += 1) {
        if (mask.data[y * mask.width + x] < threshold) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (minX === mask.width || minY === mask.height) return { x: this.canvas.width * 0.25, y: this.canvas.height * 0.1, width: this.canvas.width * 0.5, height: this.canvas.height * 0.8 };
    return {
      x: (minX / mask.width) * this.canvas.width,
      y: (minY / mask.height) * this.canvas.height,
      width: (Math.max(1, maxX - minX + 1) / mask.width) * this.canvas.width,
      height: (Math.max(1, maxY - minY + 1) / mask.height) * this.canvas.height
    };
  }
}

function validMask(mask: SegmentationFrame): boolean {
  return mask.width > 0 && mask.height > 0 && mask.data.length === mask.width * mask.height && mask.data.every(Number.isFinite);
}
