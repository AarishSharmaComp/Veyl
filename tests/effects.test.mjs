import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: "export { DisappearanceEffect } from './src/effects/disappearance-effect'; export { DisintegrationEffect } from './src/effects/disintegration';",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser'
});

class FakeContext {
  draws = [];
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  filter = 'none';
  save() {}
  restore() {}
  clearRect() {}
  setTransform() {}
  translate() {}
  rotate() {}
  beginPath() {}
  arc() {}
  stroke() {}
  drawImage(...args) { this.draws.push({ args, alpha: this.globalAlpha, filter: this.filter }); }
}

class FakeCanvas {
  width = 300;
  height = 150;
  context = new FakeContext();
  getContext() { return this.context; }
}

const priorDocument = globalThis.document;
globalThis.document = { createElement: () => new FakeCanvas() };
const { DisappearanceEffect, DisintegrationEffect } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
void priorDocument;

test('disappearance timing advances through pixelation, shatter, and stable disappearance', () => {
  const effect = new DisappearanceEffect();
  const started = performance.now();
  effect.start('disappear', 760);
  assert.equal(effect.sample(started).state, 'pixelating');
  assert.equal(effect.sample(started + 300).state, 'shattering');
  assert.equal(effect.sample(started + 800).state, 'disappeared');
  assert.equal(effect.sample(started + 800).visibility, 1);
  effect.start('reappear', 360);
  const reappearedAt = performance.now();
  assert.equal(effect.sample(reappearedAt).state, 'reappearing');
  assert.equal(effect.sample(reappearedAt + 400).state, 'none');
});

test('disintegration captures only a valid mask and renders reusable pixel/fragments', () => {
  const effect = new DisintegrationEffect();
  const video = { videoWidth: 320, videoHeight: 240 };
  const maskCanvas = new FakeCanvas(); maskCanvas.width = 4; maskCanvas.height = 4;
  const mask = { width: 4, height: 4, data: new Float32Array(16).fill(1) };
  assert.equal(effect.capture(video, mask, maskCanvas, { x: 40, y: 30, width: 160, height: 180 }, 0.7, 'disappear'), true);
  assert.ok(effect.fragmentCount >= 500, 'the subject is split into fine-grained mask-derived fragments');
  const output = new FakeContext();
  assert.equal(effect.render(output, { state: 'pixelating', progress: 0.2, visibility: 0.2, pixelation: 0.6, shatter: 0 }), true);
  assert.equal(effect.render(output, { state: 'shattering', progress: 0.7, visibility: 0.7, pixelation: 1, shatter: 0.7 }), true);
  assert.ok(output.draws.length > 1, 'pixel stage and fragment stage both draw into the output');
  assert.ok(output.draws.length <= 4, 'fragments are composited through a reusable buffer rather than one output draw per tile');
  effect.reset();
  assert.equal(effect.active, false);
  assert.equal(effect.fragmentCount, 0);
});

test('disintegration refuses a mask with no foreground instead of inventing a region', () => {
  const effect = new DisintegrationEffect();
  const canvas = new FakeCanvas();
  assert.equal(effect.capture(
    { videoWidth: 320, videoHeight: 240 },
    { width: 4, height: 4, data: new Float32Array(16) },
    canvas,
    { x: 0, y: 0, width: 320, height: 240 },
    0.7,
    'disappear'
  ), false);
  assert.equal(effect.active, false);
});

test('late shatter reaches zero pixel-stage opacity and terminal frames clear the effect', () => {
  const effect = new DisintegrationEffect();
  const canvas = new FakeCanvas(); canvas.width = 4; canvas.height = 4;
  assert.equal(effect.capture(
    { videoWidth: 320, videoHeight: 240 },
    { width: 4, height: 4, data: new Float32Array(16).fill(1) },
    canvas,
    { x: 0, y: 0, width: 320, height: 240 },
    0.7,
    'disappear'
  ), true);
  const output = new FakeContext();
  assert.equal(effect.render(output, { state: 'shattering', progress: 0.999, visibility: 0.999, pixelation: 1, shatter: 1 }), true);
  assert.equal(output.draws[0].alpha, 0, 'the captured person mosaic is absent at the end of shattering');
  const drawsBeforeTerminal = output.draws.length;
  assert.equal(effect.render(output, { state: 'disappeared', progress: 1, visibility: 1, pixelation: 1, shatter: 1 }), false);
  assert.equal(output.draws.length, drawsBeforeTerminal, 'a terminal frame does not draw a stale fragment layer');
  assert.equal(effect.active, false);
});
