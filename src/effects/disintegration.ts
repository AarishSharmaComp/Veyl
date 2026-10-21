import { drawShockwave } from './shockwave';
import type { EffectFrame } from './disappearance-effect';
import type { SegmentationFrame } from '../camera/person-segmenter';

export interface DisintegrationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Fragment {
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  rotation: number;
  spin: number;
  delay: number;
  duration: number;
}

/**
 * Captures one mask-scoped subject snapshot and renders a low-resolution
 * pixel stage followed by deterministic tile fragments. It never owns a media
 * track and is cleared by the camera pipeline on source/model lifecycle reset.
 */
export class DisintegrationEffect {
  private readonly subjectCanvas = document.createElement('canvas');
  private readonly subjectContext: CanvasRenderingContext2D;
  private readonly pixelCanvas = document.createElement('canvas');
  private readonly pixelContext: CanvasRenderingContext2D;
  private readonly fragmentCanvas = document.createElement('canvas');
  private readonly fragmentContext: CanvasRenderingContext2D;
  private subjectPixels: ImageData | null = null;
  private pixelImageData: ImageData | null = null;
  private fragments: Fragment[] = [];
  private bounds: DisintegrationBounds = { x: 0, y: 0, width: 0, height: 0 };
  private mode: 'disappear' | 'reappear' = 'disappear';
  private snapshotReady = false;
  private intensity = 0.7;

  constructor() {
    const subjectContext = this.subjectCanvas.getContext('2d', { alpha: true });
    const pixelContext = this.pixelCanvas.getContext('2d', { alpha: true });
    const fragmentContext = this.fragmentCanvas.getContext('2d', { alpha: true });
    if (!subjectContext || !pixelContext || !fragmentContext) throw new Error('Canvas 2D rendering is unavailable.');
    this.subjectContext = subjectContext;
    this.pixelContext = pixelContext;
    this.fragmentContext = fragmentContext;
  }

  capture(
    video: HTMLVideoElement,
    mask: SegmentationFrame,
    maskCanvas: HTMLCanvasElement,
    bounds: DisintegrationBounds,
    intensity: number,
    mode: 'disappear' | 'reappear'
  ): boolean {
    if (!validMask(mask) || bounds.width <= 0 || bounds.height <= 0 || maskCanvas.width <= 0 || maskCanvas.height <= 0) {
      this.reset();
      return false;
    }
    const width = Math.max(1, Math.round(video.videoWidth || mask.width));
    const height = Math.max(1, Math.round(video.videoHeight || mask.height));
    this.subjectCanvas.width = width;
    this.subjectCanvas.height = height;
    this.fragmentCanvas.width = width;
    this.fragmentCanvas.height = height;
    this.subjectContext.setTransform(1, 0, 0, 1, 0, 0);
    this.subjectContext.globalAlpha = 1;
    this.subjectContext.globalCompositeOperation = 'source-over';
    this.subjectContext.clearRect(0, 0, width, height);
    this.subjectContext.drawImage(video, 0, 0, width, height);
    this.subjectContext.globalCompositeOperation = 'destination-in';
    this.subjectContext.drawImage(maskCanvas, 0, 0, width, height);
    this.subjectContext.globalCompositeOperation = 'source-over';
    try {
      this.subjectPixels = this.subjectContext.getImageData(0, 0, width, height);
    } catch {
      // The deterministic test canvas may not expose readback. The browser
      // path uses the batched ImageData mosaic below; the scale fallback keeps
      // the effect usable on unusual canvas implementations.
      this.subjectPixels = null;
    }

    this.bounds = clampBounds(bounds, width, height);
    this.intensity = clamp(Number.isFinite(intensity) ? intensity : 0.7, 0, 1);
    this.mode = mode;
    this.fragments = createFragments(mask, this.bounds, this.intensity, width, height, mode);
    this.snapshotReady = this.fragments.length > 0;
    if (!this.snapshotReady) this.reset();
    return this.snapshotReady;
  }

  render(context: CanvasRenderingContext2D, frame: EffectFrame): boolean {
    if (frame.state === 'none' || frame.state === 'disappeared') {
      // Terminal/static frames must never inherit a previous pixel or fragment
      // layer. The compositor owns the authoritative live/plate frame for
      // these states; this renderer only owns transition pixels.
      this.reset();
      return false;
    }
    if (!this.snapshotReady) return false;
    if (frame.state === 'pixelating' || frame.state === 'shattering') {
      this.renderPixelation(context, frame);
      this.renderFragments(context, frame);
      if (frame.state === 'shattering' && this.mode === 'disappear') {
        const progress = clamp(frame.shatter, 0, 1);
        drawShockwave(
          context,
          this.bounds.x + this.bounds.width / 2,
          this.bounds.y + this.bounds.height * 0.48,
          Math.max(this.bounds.width, this.bounds.height) * (0.12 + progress * 0.65),
          1 - progress,
          this.intensity
        );
      }
      return true;
    }
    if (frame.state === 'reappearing') {
      this.renderFragments(context, frame);
      return true;
    }
    return false;
  }

  reset(): void {
    this.fragments = [];
    this.snapshotReady = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.subjectContext.setTransform(1, 0, 0, 1, 0, 0);
    this.subjectContext.globalCompositeOperation = 'source-over';
    this.subjectContext.clearRect(0, 0, this.subjectCanvas.width, this.subjectCanvas.height);
    this.subjectPixels = null;
    this.pixelContext.setTransform(1, 0, 0, 1, 0, 0);
    this.pixelContext.globalCompositeOperation = 'source-over';
    this.pixelContext.clearRect(0, 0, this.pixelCanvas.width, this.pixelCanvas.height);
    this.pixelImageData = null;
    this.fragmentContext.setTransform(1, 0, 0, 1, 0, 0);
    this.fragmentContext.globalCompositeOperation = 'source-over';
    this.fragmentContext.clearRect(0, 0, this.fragmentCanvas.width, this.fragmentCanvas.height);
  }

  get active(): boolean {
    return this.snapshotReady;
  }

  get fragmentCount(): number {
    return this.fragments.length;
  }

  private renderPixelation(context: CanvasRenderingContext2D, frame: EffectFrame): void {
    const blockSize = Math.max(4, Math.round(4 + frame.pixelation * (8 + this.intensity * 10)));
    const pixelWidth = Math.max(1, Math.ceil(this.bounds.width));
    const pixelHeight = Math.max(1, Math.ceil(this.bounds.height));
    if (this.pixelCanvas.width !== pixelWidth || this.pixelCanvas.height !== pixelHeight) {
      this.pixelCanvas.width = pixelWidth;
      this.pixelCanvas.height = pixelHeight;
      this.pixelImageData = null;
    }
    this.pixelContext.setTransform(1, 0, 0, 1, 0, 0);
    this.pixelContext.globalAlpha = 1;
    this.pixelContext.globalCompositeOperation = 'source-over';
    this.pixelContext.clearRect(0, 0, pixelWidth, pixelHeight);
    this.pixelContext.imageSmoothingEnabled = false;
    if (this.subjectPixels && typeof this.pixelContext.putImageData === 'function') {
      if (!this.pixelImageData) {
        this.pixelImageData = new ImageData(new Uint8ClampedArray(pixelWidth * pixelHeight * 4), pixelWidth, pixelHeight);
      }
      const pixels = this.pixelImageData.data;
      pixels.fill(0);
      for (let y = 0; y < pixelHeight; y += blockSize) {
        for (let x = 0; x < pixelWidth; x += blockSize) {
          const sample = this.sampleSubjectCell(x, y, Math.min(blockSize, pixelWidth - x), Math.min(blockSize, pixelHeight - y));
          if (sample[3] <= 0) continue;
          for (let row = y; row < Math.min(pixelHeight, y + blockSize); row += 1) {
            for (let column = x; column < Math.min(pixelWidth, x + blockSize); column += 1) {
              const offset = (row * pixelWidth + column) * 4;
              pixels[offset] = sample[0];
              pixels[offset + 1] = sample[1];
              pixels[offset + 2] = sample[2];
              pixels[offset + 3] = sample[3];
            }
          }
        }
      }
      this.pixelContext.putImageData(this.pixelImageData, 0, 0);
    } else {
      const sourceWidth = Math.max(1, Math.ceil(this.bounds.width / blockSize));
      const sourceHeight = Math.max(1, Math.ceil(this.bounds.height / blockSize));
      this.pixelContext.drawImage(this.subjectCanvas, this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height,
        0, 0, sourceWidth, sourceHeight);
      context.imageSmoothingEnabled = false;
    }

    context.save();
    context.globalCompositeOperation = 'source-over';
    // The pixel stage is the captured person image. It must be fully gone by
    // the end of shattering; leaving an opacity floor creates the exact
    // blurry/semi-transparent person ghost seen over the completed plate.
    context.globalAlpha = Math.max(0, 1 - frame.shatter);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.pixelCanvas, 0, 0, pixelWidth, pixelHeight, this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height);
    context.restore();
  }

  private sampleSubjectCell(x: number, y: number, width: number, height: number): [number, number, number, number] {
    const image = this.subjectPixels;
    if (!image) return [0, 0, 0, 0];
    const samples = [
      [x + width * 0.25, y + height * 0.25],
      [x + width * 0.75, y + height * 0.25],
      [x + width * 0.25, y + height * 0.75],
      [x + width * 0.75, y + height * 0.75],
      [x + width * 0.5, y + height * 0.5]
    ];
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (const [localX, localY] of samples) {
      const sourceX = Math.max(0, Math.min(image.width - 1, Math.round(this.bounds.x + localX)));
      const sourceY = Math.max(0, Math.min(image.height - 1, Math.round(this.bounds.y + localY)));
      const offset = (sourceY * image.width + sourceX) * 4;
      const sampleAlpha = image.data[offset + 3] / 255;
      red += image.data[offset] * sampleAlpha;
      green += image.data[offset + 1] * sampleAlpha;
      blue += image.data[offset + 2] * sampleAlpha;
      alpha += sampleAlpha;
    }
    alpha /= samples.length;
    if (alpha <= 0) return [0, 0, 0, 0];
    const premultipliedAlpha = Math.max(0.01, alpha * samples.length);
    return [
      Math.round(red / premultipliedAlpha),
      Math.round(green / premultipliedAlpha),
      Math.round(blue / premultipliedAlpha),
      Math.round(alpha * 255)
    ];
  }

  private renderFragments(context: CanvasRenderingContext2D, frame: EffectFrame): void {
    const travel = this.mode === 'disappear' ? frame.shatter : 1 - frame.shatter;
    const fragmentContext = this.fragmentContext;
    fragmentContext.setTransform(1, 0, 0, 1, 0, 0);
    fragmentContext.globalCompositeOperation = 'source-over';
    fragmentContext.globalAlpha = 1;
    fragmentContext.clearRect(0, 0, this.fragmentCanvas.width, this.fragmentCanvas.height);
    fragmentContext.save();
    for (const fragment of this.fragments) {
      const local = clamp((travel - fragment.delay) / fragment.duration, 0, 1);
      if (local <= 0) continue;
      const progress = easeOutCubic(local);
      const x = fragment.startX + (fragment.endX - fragment.startX) * progress;
      const y = fragment.startY + (fragment.endY - fragment.startY) * progress;
      const opacity = this.mode === 'disappear' ? (1 - local) : local;
      if (opacity <= 0) continue;
      fragmentContext.globalAlpha = opacity * 0.94;
      fragmentContext.translate(x + fragment.width / 2, y + fragment.height / 2);
      fragmentContext.rotate(fragment.rotation + fragment.spin * progress);
      fragmentContext.drawImage(
        this.subjectCanvas,
        fragment.sourceX,
        fragment.sourceY,
        fragment.width,
        fragment.height,
        -fragment.width / 2,
        -fragment.height / 2,
        fragment.width,
        fragment.height
      );
      fragmentContext.setTransform(1, 0, 0, 1, 0, 0);
    }
    fragmentContext.restore();
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.drawImage(this.fragmentCanvas, 0, 0, this.subjectCanvas.width, this.subjectCanvas.height);
    context.restore();
  }
}

function createFragments(
  mask: SegmentationFrame,
  bounds: DisintegrationBounds,
  intensity: number,
  width: number,
  height: number,
  mode: 'disappear' | 'reappear'
): Fragment[] {
  const maximum = Math.round(520 + intensity * 820);
  const desiredCell = Math.sqrt((bounds.width * bounds.height) / maximum);
  const cell = Math.max(4, Math.min(14, Math.round(desiredCell)));
  const candidates: Array<{ x: number; y: number; width: number; height: number }> = [];
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height * 0.48;
  const random = seededRandom((mask.width * 73856093) ^ (mask.height * 19349663) ^ Math.round(intensity * 1000));

  for (let y = bounds.y; y < bounds.y + bounds.height; y += cell) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += cell) {
      const fragmentWidth = Math.min(cell, width - x);
      const fragmentHeight = Math.min(cell, height - y);
      if (fragmentWidth <= 0 || fragmentHeight <= 0 || maskCoverage(mask, x, y, fragmentWidth, fragmentHeight, width, height) < 0.18) continue;
      candidates.push({ x, y, width: fragmentWidth, height: fragmentHeight });
    }
  }

  const selected = candidates.length <= maximum
    ? candidates
    : Array.from({ length: maximum }, (_, index) => candidates[Math.min(candidates.length - 1,
      Math.floor((index + 0.5) * candidates.length / maximum))]);
  const fragments: Fragment[] = [];
  for (const candidate of selected) {
      const x = candidate.x;
      const y = candidate.y;
      const fragmentWidth = candidate.width;
      const fragmentHeight = candidate.height;
      const fragmentCenterX = x + fragmentWidth / 2;
      const fragmentCenterY = y + fragmentHeight / 2;
      let directionX = fragmentCenterX - centerX;
      let directionY = fragmentCenterY - centerY;
      const length = Math.hypot(directionX, directionY) || 1;
      directionX /= length;
      directionY /= length;
      const dispersion = Math.max(width, height) * (0.18 + random() * 0.42) * (0.72 + intensity * 0.8);
      const endX = x + directionX * dispersion + (random() - 0.5) * cell * 2;
      const endY = y + directionY * dispersion + (random() - 0.5) * cell * 2 - random() * cell * 0.7;
      const originX = mode === 'disappear' ? x : endX;
      const originY = mode === 'disappear' ? y : endY;
      const targetX = mode === 'disappear' ? endX : x;
      const targetY = mode === 'disappear' ? endY : y;
      fragments.push({
        sourceX: x,
        sourceY: y,
        width: fragmentWidth,
        height: fragmentHeight,
        startX: originX,
        startY: originY,
        endX: targetX,
        endY: targetY,
        rotation: (random() - 0.5) * 0.45,
        spin: (random() - 0.5) * 0.9,
        delay: random() * 0.12,
        duration: 0.52 + random() * 0.48
      });
  }
  return fragments;
}

function maskCoverage(mask: SegmentationFrame, x: number, y: number, width: number, height: number, outputWidth: number, outputHeight: number): number {
  const points = [
    [x + width * 0.2, y + height * 0.2],
    [x + width * 0.8, y + height * 0.2],
    [x + width * 0.2, y + height * 0.8],
    [x + width * 0.8, y + height * 0.8],
    [x + width * 0.5, y + height * 0.5]
  ];
  let maximum = 0;
  for (const [sampleX, sampleY] of points) {
    const normalizedX = clamp(sampleX / Math.max(1, outputWidth), 0, 1);
    const normalizedY = clamp(sampleY / Math.max(1, outputHeight), 0, 1);
    const maskX = Math.min(mask.width - 1, Math.max(0, Math.round(normalizedX * (mask.width - 1))));
    const maskY = Math.min(mask.height - 1, Math.max(0, Math.round(normalizedY * (mask.height - 1))));
    const value = mask.data[maskY * mask.width + maskX];
    if (Number.isFinite(value)) maximum = Math.max(maximum, Math.max(0, Math.min(1, value)));
  }
  return maximum;
}

function validMask(mask: SegmentationFrame): boolean {
  return mask.width > 0 && mask.height > 0 && mask.data.length === mask.width * mask.height && mask.data.every(Number.isFinite);
}

function clampBounds(bounds: DisintegrationBounds, width: number, height: number): DisintegrationBounds {
  const x = Math.max(0, Math.min(width, bounds.x));
  const y = Math.max(0, Math.min(height, bounds.y));
  const right = Math.max(x + 1, Math.min(width, bounds.x + bounds.width));
  const bottom = Math.max(y + 1, Math.min(height, bounds.y + bounds.height));
  return { x, y, width: right - x, height: bottom - y };
}

function seededRandom(seed: number): () => number {
  let value = (seed >>> 0) || 0x9e3779b9;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ value >>> 15, 1 | value);
    result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
