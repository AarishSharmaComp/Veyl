import { BackgroundManager } from './background-manager';
import { SegmentationFrame } from './person-segmenter';

export interface CompositeOptions {
  hidden: boolean;
  transitionStrength: number;
  realTimeRemoval: boolean;
  useBackgroundPlate: boolean;
  confidenceThreshold?: number;
}

export class Compositor {
  readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly replacementCanvas = document.createElement('canvas');
  private readonly replacementContext: CanvasRenderingContext2D;
  private readonly maskCanvas = document.createElement('canvas');
  private readonly maskContext: CanvasRenderingContext2D;
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
  }

  render(video: HTMLVideoElement, background: BackgroundManager, mask: SegmentationFrame | null, options: CompositeOptions): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'source-over';
    this.context.filter = 'none';
    this.context.drawImage(video, 0, 0, width, height);

    if (!options.hidden || options.transitionStrength <= 0) return;

    const plateAvailable = options.useBackgroundPlate && background.ready;
    if (!plateAvailable) {
      this.renderGracefulFallback(video, mask, options.transitionStrength);
      return;
    }

    if (!options.realTimeRemoval || !mask) {
      this.drawPlateWithAlpha(background, options.transitionStrength);
      return;
    }

    if (!this.updateMask(mask, options.confidenceThreshold ?? 0.43, options.transitionStrength)) {
      this.renderGracefulFallback(video, null, options.transitionStrength);
      return;
    }
    this.replacementContext.globalCompositeOperation = 'source-over';
    this.replacementContext.globalAlpha = 1;
    this.replacementContext.clearRect(0, 0, width, height);
    background.drawCover(this.replacementContext, width, height);
    this.replacementContext.globalCompositeOperation = 'destination-in';
    this.replacementContext.drawImage(this.maskCanvas, 0, 0, width, height);
    this.context.drawImage(this.replacementCanvas, 0, 0, width, height);
  }

  private drawPlateWithAlpha(background: BackgroundManager, alpha: number): void {
    this.context.save();
    this.context.globalAlpha = alpha;
    background.drawCover(this.context, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

  private updateMask(mask: SegmentationFrame, threshold: number, strength: number): boolean {
    if (mask.width <= 0 || mask.height <= 0 || mask.data.length !== mask.width * mask.height) return false;
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
      smoothed[index] = smoothed[index] * 0.58 + value * 0.42;
      const normalized = Math.max(0, Math.min(1, (smoothed[index] - threshold) / (1 - threshold)));
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
    this.replacementContext.filter = 'blur(15px)';
    this.replacementContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.replacementContext.drawImage(video, -7, -7, this.canvas.width + 14, this.canvas.height + 14);
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
    for (let y = 0; y < mask.height; y += 2) {
      for (let x = 0; x < mask.width; x += 2) {
        if (mask.data[y * mask.width + x] < threshold) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX <= minX || maxY <= minY) return { x: this.canvas.width * 0.25, y: this.canvas.height * 0.1, width: this.canvas.width * 0.5, height: this.canvas.height * 0.8 };
    return {
      x: (minX / mask.width) * this.canvas.width,
      y: (minY / mask.height) * this.canvas.height,
      width: ((maxX - minX) / mask.width) * this.canvas.width,
      height: ((maxY - minY) / mask.height) * this.canvas.height
    };
  }
}
