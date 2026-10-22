import { FaceLandmarker, FilesetResolver, NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface FacePose {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  roll: number;
}

export interface FaceTrackingResult {
  timestamp: number;
  pose: FacePose | null;
  inferenceMs: number;
}

export type FaceFrameSource = HTMLVideoElement | ImageBitmap;

export class FaceLandmarkerDetector {
  private landmarker: FaceLandmarker | null = null;
  private initializing: Promise<void> | null = null;
  private lifecycle = 0;
  private lastTimestamp = -1;

  async initialize(wasmBaseUrl: string, modelUrl: string): Promise<void> {
    if (this.landmarker) return;
    if (this.initializing) return this.initializing;
    const lifecycle = this.lifecycle;
    this.initializing = this.create(wasmBaseUrl, modelUrl, lifecycle).finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async create(wasmBaseUrl: string, modelUrl: string, lifecycle: number): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl);
    if (this.lifecycle !== lifecycle) return;

    const common = {
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      minFaceDetectionConfidence: 0.52,
      minFacePresenceConfidence: 0.48,
      minTrackingConfidence: 0.48,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    };
    const gpuCanvas = createGpuCanvas();

    try {
      if (!gpuCanvas) throw new Error('GPU face tracking requires a canvas-capable worker.');
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...common,
        canvas: gpuCanvas,
        baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' as const }
      });
      if (this.lifecycle !== lifecycle) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
    } catch (gpuError) {
      if (this.lifecycle !== lifecycle) return;
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...common,
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' as const }
      });
      if (this.lifecycle !== lifecycle) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
      console.warn('[Veyl] GPU face tracking unavailable; using CPU fallback.', gpuError);
    }
  }

  detect(source: FaceFrameSource, timestamp: number): FaceTrackingResult | null {
    if (!this.landmarker || timestamp <= this.lastTimestamp) return null;
    this.lastTimestamp = timestamp;
    const started = performance.now();
    try {
      const result = this.landmarker.detectForVideo(source, timestamp);
      return {
        timestamp,
        pose: facePoseFromLandmarks(result.faceLandmarks?.[0]),
        inferenceMs: performance.now() - started
      };
    } catch (error) {
      this.lastTimestamp = -1;
      throw error;
    }
  }

  reset(): void {
    this.lastTimestamp = -1;
  }

  close(): void {
    this.lifecycle += 1;
    this.landmarker?.close();
    this.landmarker = null;
    this.reset();
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  get offloaded(): boolean {
    return false;
  }

  get offloadError(): string | null {
    return null;
  }
}

export function facePoseFromLandmarks(landmarks: NormalizedLandmark[] | undefined): FacePose | null {
  if (!landmarks || landmarks.length <= 263) return null;
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  if (![leftEye, rightEye, forehead, chin].every(validLandmark)) return null;

  const points = landmarks.filter(validLandmark);
  if (points.length < 4) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const boundsWidth = Math.max(...xs) - Math.min(...xs);
  const boundsHeight = Math.max(...ys) - Math.min(...ys);
  const eyeSpan = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  const faceHeight = Math.abs(chin.y - forehead.y);
  const centerX = (leftEye.x + rightEye.x) / 2;
  const centerY = (leftEye.y + rightEye.y) / 2 + Math.max(0.01, faceHeight * 0.045);
  const width = Math.max(boundsWidth, eyeSpan * 2.05);
  const height = Math.max(eyeSpan * 0.72, faceHeight * 0.28);
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  if (![centerX, centerY, width, height, roll].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { centerX, centerY, width, height, roll };
}

function validLandmark(value: NormalizedLandmark | undefined): value is NormalizedLandmark {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    value.x >= -0.2 && value.x <= 1.2 && value.y >= -0.2 && value.y <= 1.2;
}

function createGpuCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
  const scope = globalThis as typeof globalThis & {
    OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
  };
  if (scope.OffscreenCanvas) return new scope.OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas;
  }
  return null;
}
