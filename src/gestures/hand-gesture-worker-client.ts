import type { HandGestureResult } from './hand-gesture-detector';
import { createMediaPipeWorkerScriptUrl, registerMediaPipeWorkerScriptUrl } from '../camera/mediapipe-trusted-types';

interface WorkerReady { type: 'READY' }
interface WorkerResult { type: 'RESULT'; id: number; result: HandGestureResult }
interface WorkerFailure { type: 'ERROR'; error: string; id?: number }
interface WorkerDebug { type: 'DEBUG'; stage: string }
type WorkerMessage = WorkerReady | WorkerResult | WorkerFailure | WorkerDebug;

interface PendingResult {
  resolve: (result: HandGestureResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WARMUP_FRAME_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 800;

/**
 * Runs synchronous MediaPipe inference away from the page's render/main thread.
 * The worker owns the detector and receives only local ImageBitmap frames.
 */
export class HandGestureWorkerClient {
  private worker: Worker | null = null;
  private initializing: Promise<void> | null = null;
  private readyState = false;
  private failure: string | null = null;
  private nextId = 0;
  private completedFrames = 0;
  private workerStage = '';
  private pending = new Map<number, PendingResult>();

  async initialize(wasmBaseUrl: string, modelUrl: string): Promise<void> {
    if (this.readyState) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.start(wasmBaseUrl, modelUrl).finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async start(wasmBaseUrl: string, modelUrl: string): Promise<void> {
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      throw new Error('This browser cannot run hand tracking in a worker.');
    }
    const extensionWorkerUrl = new URL('hand-gesture-worker.js', new URL(wasmBaseUrl).origin + '/').toString();
    // A page cannot construct a Worker directly from a chrome-extension:// URL
    // even when the file is web-accessible. The bootstrap contains no external
    // code; it imports the packaged worker by its exact extension URL. The host
    // page's worker-src policy still controls whether this offload is allowed,
    // and initialization falls back to the main-thread detector if blocked.
    const extensionOrigin = new URL(extensionWorkerUrl).origin;
    const bootstrap = `(function(){const u=${JSON.stringify(extensionWorkerUrl)};const o=${JSON.stringify(extensionOrigin)};const t=globalThis.trustedTypes;const workerPolicy=t?t.createPolicy('veyl-mediapipe-worker-bootstrap',{createScriptURL(v){if(v!==u)throw new Error('Unapproved VEYL worker source');return v;}}):null;const nativeImportScripts=self.importScripts.bind(self);if(t){const wasmPolicy=t.createPolicy('veyl-mediapipe-wasm-bootstrap',{createScriptURL(v){const x=new URL(v);const p=x.pathname;const ok=p==='/wasm/vision_wasm_internal.js'||p==='/wasm/vision_wasm_nosimd_internal.js'||p==='/wasm/vision_wasm_module_internal.js'||p==='/wasm//vision_wasm_internal.js'||p==='/wasm//vision_wasm_nosimd_internal.js'||p==='/wasm//vision_wasm_module_internal.js';if(x.origin!==o||!ok)throw new Error('Unapproved VEYL WASM source');return v;}});self.importScripts=function(){const a=Array.prototype.map.call(arguments,function(v){return wasmPolicy.createScriptURL(String(v));});nativeImportScripts.apply(self,a);};}nativeImportScripts(workerPolicy?workerPolicy.createScriptURL(u):u);})();`;
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }));
    let worker: Worker;
    try {
      registerMediaPipeWorkerScriptUrl(bootstrapUrl);
      worker = new Worker(createMediaPipeWorkerScriptUrl(bootstrapUrl) as string);
    } finally {
      URL.revokeObjectURL(bootstrapUrl);
    }
    this.failure = null;
    this.completedFrames = 0;
    this.workerStage = '';
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
          if (message.type === 'READY') {
            this.readyState = true;
            resolve();
          } else if (message.type === 'DEBUG') {
            this.workerStage = message.stage;
        } else if (message.type === 'RESULT') {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          this.completedFrames += 1;
          waiting.resolve(message.result);
          } else {
            const error = new Error(message.error);
            if (message.id !== undefined) {
              const waiting = this.pending.get(message.id);
              if (waiting) {
                this.pending.delete(message.id);
                clearTimeout(waiting.timer);
                waiting.reject(error);
              }
            } else {
              this.failWorker(error);
              reject(error);
            }
          }
        };
        worker.onerror = (event) => {
          const error = new Error(event.message || 'The hand-tracking worker failed.');
          this.failWorker(error);
          if (!this.readyState) reject(error);
        };
      });
    try {
      worker.postMessage({ type: 'INIT', wasmBaseUrl, modelUrl });
      await ready;
    } catch (error) {
      this.failure = toErrorMessage(error);
      this.close();
      throw error;
    }
  }

  async detect(video: HTMLVideoElement, timestamp: number, sensitivity: number, cooldownMs: number): Promise<HandGestureResult> {
    if (!this.worker || !this.readyState) return emptyResult();
    const bitmap = await createImageBitmap(video);
    const id = ++this.nextId;
    const timeoutMs = this.completedFrames === 0 ? WARMUP_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS;
    const result = new Promise<HandGestureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        const stage = this.workerStage ? ` at ${this.workerStage}` : '';
        const error = new Error(`Hand-tracking worker timed out after ${timeoutMs} ms${stage}.`);
        waiting.reject(error);
        this.failWorker(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.worker.postMessage({ type: 'FRAME', id, timestamp, sensitivity, cooldownMs, bitmap }, [bitmap]);
    } catch (error) {
      bitmap.close();
      const waiting = this.pending.get(id);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(id);
      }
      this.failWorker(error);
      throw error;
    }
    return result;
  }

  reset(): void {
    try { this.worker?.postMessage({ type: 'RESET' }); } catch { /* The next frame will trigger fallback. */ }
  }

  close(): void {
    const error = new Error('Hand-tracking worker closed.');
    this.rejectPending(error);
    const worker = this.worker;
    this.worker = null;
    this.readyState = false;
    this.initializing = null;
    worker?.terminate();
  }

  get ready(): boolean {
    return this.readyState;
  }

  get offloaded(): boolean { return this.readyState && this.worker !== null; }

  get offloadError(): string | null { return this.failure; }

  private failWorker(error: unknown): void {
    this.failure = toErrorMessage(error);
    const worker = this.worker;
    this.worker = null;
    this.readyState = false;
    this.rejectPending(error instanceof Error ? error : new Error(this.failure));
    worker?.terminate();
  }

  private rejectPending(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}

function emptyResult(): HandGestureResult {
  return { state: 'idle', handTracked: false, candidate: false, confirmed: false,
    pinchDistance: null, releaseVelocity: 0, inferenceMs: 0, landmarks: null,
    diagnostics: {
      phase: 'idle', reason: 'worker-not-ready', pinchDistance: null, distanceDelta: null,
      middleRadius: null, middleRadiusDelta: null, releaseVelocity: 0, sampleGapMs: null,
       contactFrames: 0, releaseFrames: 0, cooldownRemainingMs: 0,
       landmarksUsable: false, trackingQuality: 'missing', fistScore: null
    } };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
