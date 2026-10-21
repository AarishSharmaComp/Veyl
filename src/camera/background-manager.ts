import { BackgroundPlate } from '../shared/types';

export class BackgroundManager {
  private plate: BackgroundPlate | null = null;
  private image: HTMLImageElement | null = null;
  private revision = 0;

  async setPlate(plate: BackgroundPlate | null): Promise<void> {
    if (plate && this.ready && plate.dataUrl === this.plate?.dataUrl) return;
    const revision = ++this.revision;
    if (!plate) {
      this.plate = null;
      this.image = null;
      return;
    }
    if (!plate.dataUrl.startsWith('data:image/') || !Number.isFinite(plate.width) || !Number.isFinite(plate.height) || plate.width <= 0 || plate.height <= 0) {
      throw new Error('The saved background has invalid image data.');
    }

    const image = new Image();
    image.decoding = 'async';
    await loadImage(image, plate.dataUrl);
    if (revision !== this.revision) return;
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The saved background image is empty.');
    this.plate = plate;
    this.image = image;
  }

  get current(): BackgroundPlate | null {
    return this.plate;
  }

  get ready(): boolean {
    return Boolean(this.plate && this.image?.complete && this.image.naturalWidth > 0);
  }

  get source(): HTMLImageElement | null {
    return this.image;
  }

  capture(video: HTMLVideoElement, width: number, height: number): BackgroundPlate {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('The camera returned invalid dimensions for background capture.');
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / width, 720 / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for background capture.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height,
      capturedAt: Date.now()
    };
  }

  drawCover(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.image || !this.plate) return;
    const sourceRatio = this.plate.width / this.plate.height;
    const targetRatio = width / height;
    let drawWidth = width;
    let drawHeight = height;
    let offsetX = 0;
    let offsetY = 0;

    if (sourceRatio > targetRatio) {
      drawWidth = height * sourceRatio;
      offsetX = (width - drawWidth) / 2;
    } else if (sourceRatio < targetRatio) {
      drawHeight = width / sourceRatio;
      offsetY = (height - drawHeight) / 2;
    }

    context.drawImage(this.image, offsetX, offsetY, drawWidth, drawHeight);
  }

  async compareToVideo(video: HTMLVideoElement, width: number, height: number): Promise<boolean> {
    if (!this.image || !this.plate) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;

    drawCoverSource(context, video, video.videoWidth || width, video.videoHeight || height, canvas.width, canvas.height);
    const current = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawCoverSource(context, this.image, this.plate.width, this.plate.height, canvas.width, canvas.height);
    const captured = context.getImageData(0, 0, canvas.width, canvas.height).data;

    let difference = 0;
    let samples = 0;
    // Use the outer border where a centered webcam subject is least likely to be.
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        const outerBorder = x < canvas.width * 0.2 || x > canvas.width * 0.8 || y < canvas.height * 0.18;
        if (!outerBorder) continue;
        const index = (y * canvas.width + x) * 4;
        difference += Math.abs(current[index] - captured[index]);
        difference += Math.abs(current[index + 1] - captured[index + 1]);
        difference += Math.abs(current[index + 2] - captured[index + 2]);
        samples += 3;
      }
    }
    const average = difference / Math.max(samples, 1);
    const aspectMismatch = Math.abs(this.plate.width / this.plate.height - width / height) > 0.045;
    return aspectMismatch || average > 38;
  }
}

function drawCoverSource(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number
): void {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let drawWidth = width;
  let drawHeight = height;
  let offsetX = 0;
  let offsetY = 0;

  if (sourceRatio > targetRatio) {
    drawWidth = height * sourceRatio;
    offsetX = (width - drawWidth) / 2;
  } else if (sourceRatio < targetRatio) {
    drawHeight = width / sourceRatio;
    offsetY = (height - drawHeight) / 2;
  }

  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
}

async function loadImage(image: HTMLImageElement, source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The saved background image could not be decoded.'));
    image.src = source;
  });
  if (typeof image.decode === 'function') await image.decode();
}
