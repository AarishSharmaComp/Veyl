import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Exercise the real model wrappers. Only the third-party engine is replaced;
// GPU/CPU construction, cancellation, copying, and result cleanup remain real.
const bundle = await build({
  stdin: {
    contents: "export * from './src/camera/person-segmenter'; export * from './src/gestures/hand-gesture-detector';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts'
  },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  plugins: [{
    name: 'mediapipe-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^@mediapipe\/tasks-vision$/ }, () => ({ path: 'engine', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
        export const FilesetResolver = { forVisionTasks: (...args) => globalThis.__veylModelBoundary.fileset(...args) };
        export const ImageSegmenter = { createFromOptions: (...args) => globalThis.__veylModelBoundary.create('person', ...args) };
        export const HandLandmarker = { createFromOptions: (...args) => globalThis.__veylModelBoundary.create('hand', ...args) };
      ` }));
    }
  }]
});
const { PersonSegmenter, HandGestureDetector } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function boundary(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, '__veylModelBoundary');
  const state = {
    filesetCalls: [], creates: [], tasks: [],
    fileset: async (path) => { state.filesetCalls.push(path); await state.filesetGate?.promise; return { path }; },
    create: async (kind, fileset, options) => {
      state.creates.push({ kind, fileset, options });
      if (state.factory) return state.factory(kind, options);
      return state.task();
    },
    task: () => {
      const task = {
        closes: 0, timestamps: [],
        close() { this.closes++; },
        segmentForVideo(video, timestamp) { this.timestamps.push(timestamp); return state.segmentResult; },
        detectForVideo(video, timestamp) { this.timestamps.push(timestamp); return state.handResult ?? { landmarks: [], handedness: [] }; }
      };
      state.tasks.push(task);
      return task;
    }
  };
  Object.defineProperty(globalThis, '__veylModelBoundary', { configurable: true, value: state });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, '__veylModelBoundary', prior);
    else delete globalThis.__veylModelBoundary;
  });
  return state;
}

for (const [name, Model] of [['person', PersonSegmenter], ['hand', HandGestureDetector]]) {
  test(`${name}: concurrent initialization creates one GPU task and close releases it`, async (t) => {
    const state = boundary(t); state.filesetGate = deferred();
    const model = new Model();
    const first = model.initialize('local-wasm', 'local-model');
    const second = model.initialize('local-wasm', 'local-model');
    assert.equal(state.filesetCalls.length, 1);
    assert.equal(model.ready, false);
    state.filesetGate.resolve(); await Promise.all([first, second]);
    assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0].options.baseOptions.delegate, 'GPU');
    assert.equal(state.creates[0].options.baseOptions.modelAssetPath, 'local-model');
    assert.equal(model.ready, true);
    model.close(); model.close();
    assert.equal(state.tasks[0].closes, 1);
    assert.equal(model.ready, false);
  });

  test(`${name}: cancellation before WASM resolution avoids constructing any task`, async (t) => {
    const state = boundary(t); state.filesetGate = deferred();
    const model = new Model(); const pending = model.initialize('wasm', 'model');
    model.close(); const repeated = model.initialize('wasm', 'model');
    state.filesetGate.resolve(); await Promise.all([pending, repeated]);
    assert.equal(state.filesetCalls.length, 1);
    assert.equal(state.creates.length, 0);
    assert.equal(model.ready, false);
    await model.initialize('wasm', 'model');
    assert.equal(state.creates.length, 1);
    assert.equal(model.ready, true); model.close();
  });

  test(`${name}: close during GPU construction closes a late task without resurrecting it`, async (t) => {
    const state = boundary(t); const gate = deferred();
    state.factory = () => gate.promise;
    const model = new Model(); const pending = model.initialize('wasm', 'model'); await flush();
    assert.equal(state.creates.length, 1); model.close();
    const repeated = model.initialize('wasm', 'model');
    const lateTask = state.task(); gate.resolve(lateTask);
    await Promise.all([pending, repeated]);
    assert.equal(state.creates.length, 1);
    assert.equal(lateTask.closes, 1);
    assert.equal(model.ready, false);
  });

  test(`${name}: a cancelled GPU rejection must not start CPU fallback`, async (t) => {
    const state = boundary(t); const gate = deferred(); state.factory = () => gate.promise;
    const model = new Model(); const pending = model.initialize('wasm', 'model'); await flush();
    model.close(); gate.reject(new Error('GPU failed after cancellation')); await pending;
    assert.equal(state.creates.length, 1);
    assert.equal(model.ready, false);
  });

  test(`${name}: GPU failure falls back to CPU and CPU failure remains retryable`, async (t) => {
    const state = boundary(t); const model = new Model();
    state.factory = () => { throw new Error('delegate unavailable'); };
    await assert.rejects(model.initialize('wasm', 'model'), /delegate unavailable/);
    assert.deepEqual(state.creates.map(({ options }) => options.baseOptions.delegate), ['GPU', 'CPU']);
    assert.equal(model.ready, false);
    delete state.factory; await model.initialize('wasm', 'model');
    assert.equal(model.ready, true); model.close();
  });

  test(`${name}: cancellation during CPU fallback closes its eventual task`, async (t) => {
    const state = boundary(t); const gate = deferred(); const model = new Model();
    state.factory = (kind, options) => {
      if (options.baseOptions.delegate === 'GPU') throw new Error('GPU unavailable');
      return gate.promise;
    };
    const pending = model.initialize('wasm', 'model'); await flush();
    assert.deepEqual(state.creates.map(({ options }) => options.baseOptions.delegate), ['GPU', 'CPU']);
    model.close(); const lateTask = state.task(); gate.resolve(lateTask); await pending;
    assert.equal(model.ready, false); assert.equal(lateTask.closes, 1);
  });
}

function mask(width, height, values) {
  return { width, height, values: new Float32Array(values), closes: 0,
    getAsFloat32Array() { return this.values; }, close() { this.closes++; } };
}

test('person: copies native mask storage before closing it, and reuses same-size output buffers', async (t) => {
  const state = boundary(t); const model = new PersonSegmenter(); await model.initialize('wasm', 'model');
  const first = mask(2, 1, [1, 0.5]); const extra = mask(1, 1, [0]); const category = mask(2, 1, [1, 1]);
  state.segmentResult = { confidenceMasks: [first, extra], categoryMask: category };
  const result = model.segment({}, 10); const buffer = result.data;
  assert.notEqual(buffer, first.values); assert.deepEqual([...buffer], [1, 0.5]);
  first.values.fill(0); assert.deepEqual([...buffer], [1, 0.5]);
  assert.equal(first.closes, 1); assert.equal(extra.closes, 1); assert.equal(category.closes, 1);
  const next = mask(2, 1, [0.25, 0.75]); state.segmentResult = { confidenceMasks: [next] };
  const updated = model.segment({}, 20);
  assert.equal(updated.data, buffer); assert.deepEqual([...buffer], [0.25, 0.75]); assert.equal(next.closes, 1);
  model.close();
});

test('person: malformed mask length is rejected rather than retaining stale confidence values', async (t) => {
  const state = boundary(t); const model = new PersonSegmenter(); await model.initialize('wasm', 'model');
  state.segmentResult = { confidenceMasks: [mask(2, 1, [1, 1])] }; model.segment({}, 10);
  const malformed = mask(2, 1, [0]); state.segmentResult = { confidenceMasks: [malformed] };
  assert.equal(model.segment({}, 20), null); assert.equal(malformed.closes, 1);
  const category = mask(2, 1, [0, 0]); state.segmentResult = { categoryMask: category };
  assert.equal(model.segment({}, 30), null); assert.equal(category.closes, 1);
  model.close();
});

test('person: closes native masks even when reading a confidence buffer throws', async (t) => {
  const state = boundary(t); const model = new PersonSegmenter(); await model.initialize('wasm', 'model');
  const failed = mask(1, 1, [1]); const category = mask(1, 1, [1]);
  failed.getAsFloat32Array = () => { throw new Error('mask read failed'); };
  state.segmentResult = { confidenceMasks: [failed], categoryMask: category };
  assert.throws(() => model.segment({}, 10), /mask read failed/);
  assert.equal(failed.closes, 1); assert.equal(category.closes, 1); model.close();
});

test('both model wrappers avoid duplicate timestamps and stop inference after close', async (t) => {
  const state = boundary(t); const person = new PersonSegmenter(); const hand = new HandGestureDetector();
  await person.initialize('wasm', 'person'); await hand.initialize('wasm', 'hand');
  state.segmentResult = { confidenceMasks: [mask(1, 1, [1])] };
  const video = { videoWidth: 640, videoHeight: 480 };
  person.segment(video, 10); person.segment(video, 10); person.segment(video, 9);
  hand.detect(video, 10, 0.62, 1100); hand.detect(video, 10, 0.62, 1100); hand.detect(video, 9, 0.62, 1100);
  assert.deepEqual(state.tasks.map((task) => task.timestamps), [[10], [10]]);
  person.close(); hand.close();
  assert.equal(person.segment(video, 20), null);
  assert.equal(hand.detect(video, 20, 0.62, 1100).confirmed, false);
  assert.deepEqual(state.tasks.map((task) => task.timestamps), [[10], [10]]);
});

function handLandmarks({ contact = false } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[0] = { x: 0.50, y: 0.50, z: 0 };
  points[5] = { x: 0.42, y: 0.58, z: 0 };
  points[9] = { x: 0.50, y: 0.62, z: 0 };
  points[13] = { x: 0.58, y: 0.58, z: 0 };
  points[17] = { x: 0.65, y: 0.55, z: 0 };
  points[4] = { x: 0.50, y: contact ? 0.35 : 0.38, z: 0 };
  points[12] = { x: 0.50, y: 0.35, z: 0 };
  return points;
}

test('hand detector treats handedness score as identity metadata, not presence confidence', async (t) => {
  const state = boundary(t); const detector = new HandGestureDetector();
  await detector.initialize('wasm', 'hand');
  state.handResult = { landmarks: [handLandmarks()], handedness: [[{ score: 0.1, categoryName: 'Right' }]] };
  const result = detector.detect({ videoWidth: 640, videoHeight: 480 }, 10, 0.62, 1100);
  assert.equal(result.handTracked, true);
  detector.close();
});

test('hand detector clears stale contact evidence on repeated or reordered timestamps', async (t) => {
  const state = boundary(t); const detector = new HandGestureDetector();
  await detector.initialize('wasm', 'hand');
  state.handResult = { landmarks: [handLandmarks({ contact: true })], handedness: [[{ score: 0.9, categoryName: 'Right' }]] };
  detector.detect({ videoWidth: 640, videoHeight: 480 }, 0, 0.62, 1100);
  detector.detect({ videoWidth: 640, videoHeight: 480 }, 40, 0.62, 1100);
  const armed = detector.detect({ videoWidth: 640, videoHeight: 480 }, 80, 0.62, 1100);
  assert.equal(armed.candidate, true);
  const duplicate = detector.detect({ videoWidth: 640, videoHeight: 480 }, 80, 0.62, 1100);
  assert.equal(duplicate.handTracked, false);
  assert.equal(duplicate.candidate, false);
  const late = detector.detect({ videoWidth: 640, videoHeight: 480 }, 79, 0.62, 1100);
  assert.equal(late.handTracked, false);
  detector.close();
});
