import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const workers = [];
const bitmaps = [];

class MockWorker {
  constructor(url) {
    this.url = url;
    this.respondFrames = true;
    this.terminated = false;
    workers.push(this);
  }

  postMessage(message) {
    if (message.type === 'INIT') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'READY' } }));
    } else if (message.type === 'FRAME' && this.respondFrames) {
      queueMicrotask(() => this.onmessage?.({ data: {
        type: 'RESULT',
        id: message.id,
        result: {
          state: 'idle', handTracked: false, candidate: false, confirmed: false,
          pinchDistance: null, releaseVelocity: 0, inferenceMs: 4, landmarks: null,
          diagnostics: {
            phase: 'idle', reason: 'test-result', pinchDistance: null, distanceDelta: null,
            middleRadius: null, middleRadiusDelta: null, releaseVelocity: 0,
            sampleGapMs: 40, contactFrames: 0, releaseFrames: 0,
             cooldownRemainingMs: 0, landmarksUsable: false, trackingQuality: 'missing', fistScore: null
          }
        }
      } }));
    }
  }

  terminate() { this.terminated = true; }
}

const prior = new Map([
  ['Worker', Object.getOwnPropertyDescriptor(globalThis, 'Worker')],
  ['createImageBitmap', Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')],
  ['__veylMediaPipeTrustedTypesAdapter', Object.getOwnPropertyDescriptor(globalThis, '__veylMediaPipeTrustedTypesAdapter')],
  ['__veylMediaPipeCreateScriptUrl', Object.getOwnPropertyDescriptor(globalThis, '__veylMediaPipeCreateScriptUrl')]
]);
const priorCreateObjectUrl = URL.createObjectURL;
const priorRevokeObjectUrl = URL.revokeObjectURL;

Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: MockWorker });
Object.defineProperty(globalThis, 'createImageBitmap', {
  configurable: true,
  writable: true,
  value: async () => {
    const bitmap = { closeCalls: 0, close() { this.closeCalls += 1; } };
    bitmaps.push(bitmap);
    return bitmap;
  }
});
Object.defineProperty(globalThis, '__veylMediaPipeTrustedTypesAdapter', { configurable: true, writable: true, value: { extensionBaseUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' } });
Object.defineProperty(globalThis, '__veylMediaPipeCreateScriptUrl', { configurable: true, writable: true, value: (value) => value });
URL.createObjectURL = () => 'blob:http://video.example/worker';
URL.revokeObjectURL = () => undefined;

const bundled = await build({
  stdin: { contents: "export { HandGestureWorkerClient } from './src/gestures/hand-gesture-worker-client';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
const { HandGestureWorkerClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('worker client initializes, transfers a frame, and returns the worker result', async () => {
  const client = new HandGestureWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/hand_landmarker.task');
  const result = await client.detect({ videoWidth: 640, videoHeight: 480 }, 100, 0.62, 1100);
  assert.equal(result.inferenceMs, 4);
  assert.equal(client.ready, true);
  assert.equal(client.offloaded, true);
  client.close();
});

test('worker failure rejects pending inference and clears the offload state', async () => {
  const client = new HandGestureWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/hand_landmarker.task');
  const worker = workers.at(-1);
  worker.respondFrames = false;
  const pending = client.detect({ videoWidth: 640, videoHeight: 480 }, 100, 0.62, 1100);
  await Promise.resolve();
  worker.onerror?.({ message: 'worker crashed' });
  await assert.rejects(pending, /worker crashed|closed/);
  assert.equal(client.ready, false);
  assert.match(client.offloadError, /worker crashed/);
});

test('closing the worker rejects pending requests and terminates it', async () => {
  const client = new HandGestureWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/hand_landmarker.task');
  const worker = workers.at(-1);
  worker.respondFrames = false;
  const pending = client.detect({ videoWidth: 640, videoHeight: 480 }, 100, 0.62, 1100);
  await Promise.resolve();
  client.close();
  await assert.rejects(pending, /closed/);
  assert.equal(worker.terminated, true);
  assert.ok(bitmaps.length > 0);
});

test.after(() => {
  for (const [name, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  URL.createObjectURL = priorCreateObjectUrl;
  URL.revokeObjectURL = priorRevokeObjectUrl;
});
