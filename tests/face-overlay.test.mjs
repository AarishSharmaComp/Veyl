import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({
  stdin: { contents: "export * from './src/camera/face-overlay-renderer';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
const { FaceOverlayRenderer, FACE_OVERLAY_HOLD_MS, FACE_OVERLAY_FADE_MS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function context() {
  return {
    saves: 0, restores: 0, strokes: 0, fills: 0,
    save() { this.saves++; }, restore() { this.restores++; }, translate() {}, rotate() {},
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    fill() { this.fills++; }, stroke() { this.strokes++; }
  };
}

const pose = { centerX: 0.5, centerY: 0.45, width: 0.3, height: 0.12, roll: 0.04 };

test('face overlay draws on a valid pose and suppresses drawing during effects', () => {
  const renderer = new FaceOverlayRenderer();
  const output = context();
  renderer.update(pose, 100);
  assert.equal(renderer.render(output, 640, 480, 100, true), true);
  assert.ok(output.strokes > 0);
  const strokes = output.strokes;
  assert.equal(renderer.render(output, 640, 480, 110, false), false);
  assert.equal(output.strokes, strokes);
});

test('face overlay ignores out-of-order results and fades after a bounded tracking loss', () => {
  const renderer = new FaceOverlayRenderer();
  const output = context();
  renderer.update(pose, 100);
  renderer.update({ ...pose, centerX: 0.1 }, 90);
  assert.equal(renderer.render(output, 640, 480, 100, true), true);
  renderer.update(null, 120);
  assert.equal(renderer.render(output, 640, 480, 120 + FACE_OVERLAY_HOLD_MS, true), true);
  assert.equal(renderer.render(output, 640, 480, 120 + FACE_OVERLAY_HOLD_MS + FACE_OVERLAY_FADE_MS - 1, true), true);
  assert.equal(renderer.render(output, 640, 480, 120 + FACE_OVERLAY_HOLD_MS + FACE_OVERLAY_FADE_MS + 1, true), false);
});

test('face overlay reset clears a pose immediately', () => {
  const renderer = new FaceOverlayRenderer();
  const output = context();
  renderer.update(pose, 100);
  renderer.reset();
  assert.equal(renderer.render(output, 640, 480, 100, true), false);
});

test('face overlay treats invalid poses and inference failures as tracking loss', () => {
  const renderer = new FaceOverlayRenderer();
  const output = context();
  renderer.update(pose, 100);
  renderer.update({ ...pose, width: Number.NaN }, 120);
  assert.equal(renderer.render(output, 640, 480, 120 + FACE_OVERLAY_HOLD_MS, true), true);
  renderer.markMissing(140);
  assert.equal(renderer.render(output, 640, 480, 140 + FACE_OVERLAY_HOLD_MS + FACE_OVERLAY_FADE_MS + 1, true), false);
});
