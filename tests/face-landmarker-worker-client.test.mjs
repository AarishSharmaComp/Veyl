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
    this.respondReady = !MockWorker.blockNextReady;
    MockWorker.blockNextReady = false;
    this.respondFrames = true;
    this.terminated = false;
    workers.push(this);
  }

  postMessage(message) {
    if (message.type === 'INIT' && this.respondReady) queueMicrotask(() => this.onmessage?.({ data: { type: 'READY' } }));
    if (message.type === 'FRAME' && this.respondFrames) queueMicrotask(() => this.onmessage?.({ data: {
      type: 'RESULT', id: message.id,
      result: { timestamp: message.timestamp, pose: { centerX: 0.5, centerY: 0.45, width: 0.3, height: 0.12, roll: 0.02 }, inferenceMs: 5 }
    } }));
  }

  terminate() { this.terminated = true; }
}

MockWorker.blockNextReady = false;

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
URL.createObjectURL = () => 'blob:http://video.example/face-worker';
URL.revokeObjectURL = () => undefined;

const bundled = await build({
  stdin: { contents: "export { FaceLandmarkerWorkerClient } from './src/camera/face-landmarker-worker-client';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
const { FaceLandmarkerWorkerClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('face worker client initializes, transfers a bitmap, and returns one pose', async () => {
  const client = new FaceLandmarkerWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/face_landmarker.task');
  const result = await client.detect({ videoWidth: 640, videoHeight: 480 }, 100);
  assert.equal(result.timestamp, 100);
  assert.equal(result.pose.centerX, 0.5);
  assert.equal(client.ready, true);
  assert.equal(client.offloaded, true);
  assert.equal(bitmaps.at(-1).closeCalls, 0, 'the worker owns the transferred bitmap');
  client.close();
});

test('face worker failure rejects pending inference and records the fallback reason', async () => {
  const client = new FaceLandmarkerWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/face_landmarker.task');
  const worker = workers.at(-1);
  worker.respondFrames = false;
  const pending = client.detect({ videoWidth: 640, videoHeight: 480 }, 100);
  await Promise.resolve();
  worker.onerror?.({ message: 'face worker crashed' });
  await assert.rejects(pending, /face worker crashed|closed/);
  assert.equal(client.ready, false);
  assert.match(client.offloadError, /face worker crashed/);
});

test('closing the face worker rejects pending requests and terminates it', async () => {
  const client = new FaceLandmarkerWorkerClient();
  await client.initialize('https://extension.test/wasm/', 'https://extension.test/models/face_landmarker.task');
  const worker = workers.at(-1);
  worker.respondFrames = false;
  const pending = client.detect({ videoWidth: 640, videoHeight: 480 }, 100);
  await Promise.resolve();
  client.close();
  await assert.rejects(pending, /closed/);
  assert.equal(worker.terminated, true);
  assert.ok(bitmaps.length > 0);
});

test('closing during face worker initialization rejects the initialization promise', async () => {
  const client = new FaceLandmarkerWorkerClient();
  MockWorker.blockNextReady = true;
  const pending = client.initialize('https://extension.test/wasm/', 'https://extension.test/models/face_landmarker.task');
  const worker = workers.at(-1);
  client.close();
  await assert.rejects(pending, /closed/);
  assert.equal(worker.terminated, true);
  assert.equal(client.ready, false);
});

test.after(() => {
  for (const [name, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  URL.createObjectURL = priorCreateObjectUrl;
  URL.revokeObjectURL = priorRevokeObjectUrl;
});
