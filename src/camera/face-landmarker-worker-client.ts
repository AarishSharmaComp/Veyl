import { FaceTrackingResult, FaceFrameSource } from './face-landmarker';
import { createMediaPipeWorkerScriptUrl, registerMediaPipeWorkerScriptUrl } from './mediapipe-trusted-types';

interface WorkerReady { type: 'READY' }
interface WorkerResult { type: 'RESULT'; id: number; result: FaceTrackingResult | null }
interface WorkerFailure { type: 'ERROR'; error: string; id?: number }
type WorkerMessage = WorkerReady | WorkerResult | WorkerFailure;

interface PendingResult {
  resolve: (result: FaceTrackingResult | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WARMUP_FRAME_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 800;

export class FaceLandmarkerWorkerClient {
  private worker: Worker | null = null;
  private initializing: Promise<void> | null = null;
  private readyState = false;
  private failure: string | null = null;
  private nextId = 0;
  private completedFrames = 0;
  private initializationReject: ((error: Error) => void) | null = null;
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
      throw new Error('This browser cannot run face tracking in a worker.');
    }
    const extensionWorkerUrl = new URL('face-landmarker-worker.js', new URL(wasmBaseUrl).origin + '/').toString();
    const extensionOrigin = new URL(extensionWorkerUrl).origin;
    const bootstrap = `(function(){const u=${JSON.stringify(extensionWorkerUrl)};const o=${JSON.stringify(extensionOrigin)};const t=globalThis.trustedTypes;const workerPolicy=t?t.createPolicy('veyl-face-worker-bootstrap',{createScriptURL(v){if(v!==u)throw new Error('Unapproved VEYL face worker source');return v;}}):null;const nativeImportScripts=self.importScripts.bind(self);if(t){const wasmPolicy=t.createPolicy('veyl-face-wasm-bootstrap',{createScriptURL(v){const x=new URL(v);const p=x.pathname;const ok=p==='/wasm/vision_wasm_internal.js'||p==='/wasm/vision_wasm_nosimd_internal.js'||p==='/wasm/vision_wasm_module_internal.js'||p==='/wasm//vision_wasm_internal.js'||p==='/wasm//vision_wasm_nosimd_internal.js'||p==='/wasm//vision_wasm_module_internal.js';if(x.origin!==o||!ok)throw new Error('Unapproved VEYL WASM source');return v;}});self.importScripts=function(){const a=Array.prototype.map.call(arguments,function(v){return wasmPolicy.createScriptURL(String(v));});nativeImportScripts.apply(self,a);};}nativeImportScripts(workerPolicy?workerPolicy.createScriptURL(u):u);})();`;
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
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.initializationReject = reject;
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === 'READY') {
          this.readyState = true;
          this.initializationReject = null;
          resolve();
        } else if (message.type === 'RESULT') {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          this.completedFrames += 1;
          waiting.resolve(message.result);
        } else if (message.id !== undefined) {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          waiting.reject(new Error(message.error));
        } else {
          const error = new Error(message.error);
          this.failWorker(error);
          reject(error);
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || 'The face-tracking worker failed.');
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

  async detect(video: FaceFrameSource, timestamp: number): Promise<FaceTrackingResult | null> {
    if (!this.worker || !this.readyState) return null;
    const bitmap = await createImageBitmap(video);
    const id = ++this.nextId;
    const timeoutMs = this.completedFrames === 0 ? WARMUP_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS;
    const result = new Promise<FaceTrackingResult | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        const error = new Error(`Face-tracking worker timed out after ${timeoutMs} ms.`);
        waiting.reject(error);
        this.failWorker(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.worker.postMessage({ type: 'FRAME', id, timestamp, bitmap }, [bitmap]);
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
    const error = new Error('Face-tracking worker closed.');
    this.initializationReject?.(error);
    this.initializationReject = null;
    this.rejectPending(error);
    const worker = this.worker;
    this.worker = null;
    this.readyState = false;
    this.initializing = null;
    worker?.terminate();
  }

  get ready(): boolean { return this.readyState; }
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
