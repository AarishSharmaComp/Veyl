import { HandGestureDetector } from './hand-gesture-detector';

interface InitMessage { type: 'INIT'; wasmBaseUrl: string; modelUrl: string }
interface FrameMessage { type: 'FRAME'; id: number; timestamp: number; sensitivity: number; cooldownMs: number; bitmap: ImageBitmap }
interface ResetMessage { type: 'RESET' }
type WorkerRequest = InitMessage | FrameMessage | ResetMessage;

declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const detector = new HandGestureDetector();
let initialized = false;

self.onmessage = (event) => {
  void handle(event.data);
};

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === 'INIT') {
    try {
      await detector.initialize(message.wasmBaseUrl, message.modelUrl);
      initialized = true;
      self.postMessage({ type: 'READY' });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: toErrorMessage(error) });
    }
    return;
  }
  if (message.type === 'RESET') {
    detector.reset();
    return;
  }
  if (!initialized) {
    message.bitmap.close();
    self.postMessage({ type: 'ERROR', id: message.id, error: 'The hand-tracking worker is not initialized.' });
    return;
  }
  try {
    const result = detector.detect(message.bitmap, message.timestamp, message.sensitivity, message.cooldownMs);
    self.postMessage({ type: 'RESULT', id: message.id, result });
  } catch (error) {
    self.postMessage({ type: 'ERROR', id: message.id, error: toErrorMessage(error) });
  } finally {
    message.bitmap.close();
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
