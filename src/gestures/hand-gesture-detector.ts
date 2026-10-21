import { FilesetResolver, HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { FingerGestureStateMachine, GestureDiagnostics, GestureLandmark, GestureUpdate } from './gesture-state-machine';

export interface HandGestureResult extends GestureUpdate {
  inferenceMs: number;
  /** Local diagnostic output; never sent through the extension bridge. */
  landmarks: GestureLandmark[] | null;
  /** Numeric/decision diagnostics; raw camera frames and landmarks stay local. */
  diagnostics: GestureDiagnostics;
}

export type HandFrameSource = HTMLVideoElement | ImageBitmap;

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

  detect(video: HandFrameSource, timestamp: number, sensitivity: number, cooldownMs: number): HandGestureResult {
    if (!this.landmarker) return this.emptyResult();
    if (timestamp <= this.lastTimestamp) {
      // Clear contact/release evidence, but keep the detector clock at the last
      // accepted timestamp so a late frame cannot rewind temporal accounting.
      const update = this.stateMachine.update(null, sensitivity, cooldownMs);
      return this.finish(update, 0, null);
    }

    const started = performance.now();
    try {
      const result = this.landmarker.detectForVideo(video, timestamp);
      this.lastTimestamp = timestamp;
      const hand = result.landmarks?.[0];
      const landmarks = hand ? hand.map(toGestureLandmark) : null;
      const label = result.handedness?.[0]?.[0]?.categoryName;
      const handedness = label === 'Left' || label === 'Right' ? label : undefined;
      // Handedness score measures left/right classification, not hand presence
      // or landmark quality. MediaPipe has already applied its detection and
      // presence thresholds before returning a hand landmark set.
      const update = landmarks
        ? this.stateMachine.update(
          { timestamp, landmarks, handedness, frameAspectRatio: frameAspectRatio(video) },
          sensitivity,
          cooldownMs
        )
        : this.stateMachine.updateMissing(timestamp);
      return this.finish(update, performance.now() - started, landmarks);
    } catch (error) {
      this.lastTimestamp = -1;
      this.stateMachine.reset();
      throw error;
    }
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

  get offloaded(): boolean { return false; }

  get offloadError(): string | null { return null; }

  private finish(update: GestureUpdate, inferenceMs: number, landmarks: GestureLandmark[] | null): HandGestureResult {
    const result = { ...update, inferenceMs, landmarks, diagnostics: this.stateMachine.diagnostics };
    debugGestureResult(result);
    return result;
  }

  private emptyResult(): HandGestureResult {
    return {
      state: this.stateMachine.currentState,
      handTracked: false,
      candidate: false,
      confirmed: false,
      pinchDistance: null,
      releaseVelocity: 0,
      inferenceMs: 0,
      landmarks: null,
      diagnostics: this.stateMachine.diagnostics
    };
  }
}

function toGestureLandmark(landmark: NormalizedLandmark): { x: number; y: number; z?: number } {
  return { x: landmark.x, y: landmark.y, z: landmark.z };
}

function frameAspectRatio(source: HandFrameSource): number {
  const width = 'videoWidth' in source ? source.videoWidth : source.width;
  const height = 'videoHeight' in source ? source.videoHeight : source.height;
  return width / Math.max(1, height);
}

let lastDebugReason = '';
let lastDebugState = '';

function debugGestureResult(result: HandGestureResult): void {
  const page = globalThis as typeof globalThis & { __VEYL_DEBUG_GESTURES?: boolean };
  if (!page.__VEYL_DEBUG_GESTURES) return;
  const marker = `${result.state}:${result.diagnostics.reason}`;
  if (!result.confirmed && marker === `${lastDebugState}:${lastDebugReason}`) return;
  lastDebugState = result.state;
  lastDebugReason = result.diagnostics.reason;
  console.debug('[Veyl gesture]', {
    state: result.state,
    confirmed: result.confirmed,
    handTracked: result.handTracked,
    diagnostics: result.diagnostics
  });
}
