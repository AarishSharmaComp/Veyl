import { FilesetResolver, ImageSegmenter, MPMask } from '@mediapipe/tasks-vision';

export interface SegmentationFrame {
  data: Float32Array;
  width: number;
  height: number;
}

export class PersonSegmenter {
  private segmenter: ImageSegmenter | null = null;
  private initializing: Promise<void> | null = null;
  private lastTimestamp = -1;
  private lifecycle = 0;

  async initialize(wasmBaseUrl: string, modelUrl: string): Promise<void> {
    if (this.segmenter) return;
    if (this.initializing) return this.initializing;

    const lifecycle = this.lifecycle;
    this.initializing = this.create(wasmBaseUrl, modelUrl, lifecycle).finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async create(wasmBaseUrl: string, modelUrl: string, lifecycle: number): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl);
    const options = {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' as const },
      runningMode: 'VIDEO' as const,
      outputConfidenceMasks: true,
      outputCategoryMask: false
    };

    try {
      const segmenter = await ImageSegmenter.createFromOptions(fileset, options);
      if (this.lifecycle !== lifecycle) {
        segmenter.close();
        return;
      }
      this.segmenter = segmenter;
    } catch (gpuError) {
      // CPU is slower but keeps older laptops and GPU-disabled Chrome profiles usable.
      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' as const }
      });
      if (this.lifecycle !== lifecycle) {
        segmenter.close();
        return;
      }
      this.segmenter = segmenter;
      console.warn('[Snap] GPU segmentation unavailable; using CPU fallback.', gpuError);
    }
  }

  segment(video: HTMLVideoElement, timestamp: number): SegmentationFrame | null {
    if (!this.segmenter || timestamp <= this.lastTimestamp) return null;
    this.lastTimestamp = timestamp;

    const result = this.segmenter.segmentForVideo(video, timestamp);
    const mask = result.confidenceMasks?.[0] ?? null;
    if (!mask) {
      this.closeMasks(result.confidenceMasks);
      result.categoryMask?.close();
      return null;
    }

    try {
      const data = mask.getAsFloat32Array();
      return {
        data: new Float32Array(data),
        width: mask.width,
        height: mask.height
      };
    } finally {
      this.closeMasks(result.confidenceMasks);
      result.categoryMask?.close();
    }
  }

  private closeMasks(masks: MPMask[] | undefined): void {
    masks?.forEach((mask) => mask.close());
  }

  close(): void {
    this.lifecycle += 1;
    this.segmenter?.close();
    this.segmenter = null;
    this.lastTimestamp = -1;
  }

  get ready(): boolean {
    return this.segmenter !== null;
  }
}
