import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptMediaPipeVisionBundle } from '../scripts/mediapipe-loader.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const upstream = readFileSync(resolve(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs'), 'utf8');

test('the locked MediaPipe bundle rewrites its dynamic loader through Veyl’s narrow adapter', () => {
  const transformed = adaptMediaPipeVisionBundle(upstream, 'vision_bundle.mjs');
  assert.equal((upstream.match(/createPolicy\("goog#html"/g) ?? []).length, 1);
  assert.equal((transformed.match(/createPolicy\("goog#html"/g) ?? []).length, 0);
  assert.equal((upstream.match(/e\.src=t\.toString\(\)/g) ?? []).length, 1);
  assert.equal((transformed.match(/e\.src=t\.toString\(\)/g) ?? []).length, 0);
  assert.equal((transformed.match(/globalThis\.__veylMediaPipeCreateScriptUrl\(t\.toString\(\)/g) ?? []).length, 1);
});

test('the loader transform fails closed if the upstream sink changes shape', () => {
  assert.throws(() => adaptMediaPipeVisionBundle('const loader = true;', 'fixture.mjs'), /expected one upstream identity Trusted Types policy/);
  const policy = 'let ji,Vi=globalThis.trustedTypes;function Xi(t){var e;return void 0===ji&&(ji=function(){let t=null;if(!Vi)return t;try{const e=t=>t;t=Vi.createPolicy("goog#html",{createHTML:e,createScript:e,createScriptURL:e})}catch(t){}return t}()),t=(e=ji)?e.createScriptURL(t):t,new class{constructor(t){this.g=t}toString(){return this.g+""}}(t)}';
  assert.throws(() => adaptMediaPipeVisionBundle(policy, 'fixture.mjs'), /expected one script\.src assignment/);
  assert.throws(() => adaptMediaPipeVisionBundle(`${policy}e.src=t.toString();e.src=t.toString();`, 'fixture.mjs'), /found 2/);
});
