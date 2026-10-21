import { FilesetResolver, HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { FingerGestureStateMachine, GestureUpdate } from './gesture-state-machine';

export interface HandGestureResult extends GestureUpdate {
  inferenceMs: number;
}

export class HandGestureDetector {
  private landmarker: HandLandmarker | null = null;
  private initializing: Promise<void> | null = null;
  private lifecycle = 0;
  private lastTimestamp = -1;
  private readonly stateMachine = new FingerGestureStateMachine();

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
    const options = {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' as const },
      runningMode: 'VIDEO' as const,
      numHands: 1,
      minHandDetectionConfidence: 0.52,
      minHandPresenceConfidence: 0.48,
      minTrackingConfidence: 0.48
    };

    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, options);
      if (this.lifecycle !== lifecycle) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
    } catch (gpuError) {
      if (this.lifecycle !== lifecycle) return;
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' as const }
      });
      if (this.lifecycle !== lifecycle) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
      console.warn('[Veyl] GPU hand tracking unavailable; using CPU fallback.', gpuError);
    }
  }

  detect(video: HTMLVideoElement, timestamp: number, sensitivity: number, cooldownMs: number): HandGestureResult {
    if (!this.landmarker || timestamp <= this.lastTimestamp) {
      return {
        state: this.stateMachine.currentState,
        handTracked: false,
        candidate: false,
        confirmed: false,
        pinchDistance: null,
        releaseVelocity: 0,
        inferenceMs: 0
      };
    }

    this.lastTimestamp = timestamp;
    const started = performance.now();
    const result = this.landmarker.detectForVideo(video, timestamp);
    const hand = result.landmarks[0];
    const confidence = result.handedness?.[0]?.[0]?.score ?? 0;
    const label = result.handedness?.[0]?.[0]?.categoryName;
    const handedness = label === 'Left' || label === 'Right' ? label : undefined;
    const update = this.stateMachine.update(
      hand ? { timestamp, landmarks: hand.map(toGestureLandmark), confidence, handedness,
        frameAspectRatio: video.videoWidth / Math.max(1, video.videoHeight) } : null,
      sensitivity,
      cooldownMs
    );
    return { ...update, inferenceMs: performance.now() - started };
  }

  reset(): void {
    this.lastTimestamp = -1;
    this.stateMachine.reset();
  }

  close(): void {
    this.lifecycle += 1;
    this.landmarker?.close();
    this.landmarker = null;
    // Keep the in-flight promise until its own finally runs; rapid off/on must
    // not construct a second task while a cancelled first task is still loading.
    this.reset();
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }
}

function toGestureLandmark(landmark: NormalizedLandmark): { x: number; y: number; z?: number } {
  return { x: landmark.x, y: landmark.y, z: landmark.z };
}
