import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('Manifest limits integration to Google Meet and installs the early page bridge', () => {
  const manifest = readJson('public/manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*']);
  assert.deepEqual(manifest.permissions, ['storage']);

  const contentScripts = manifest.content_scripts ?? [];
  assert.ok(contentScripts.some((entry) => entry.js?.includes('content.js') && entry.run_at === 'document_start'));
  assert.ok(contentScripts.some((entry) => entry.js?.includes('page-bridge.js') && entry.run_at === 'document_start' && entry.world === 'MAIN'));
  assert.ok(!manifest.host_permissions.some((permission) => permission === '<all_urls>' || permission.includes('*://*')));
});

test('The page bridge has a processed-track path and a recovery handshake', () => {
  const source = read('src/page/page-bridge.ts');
  assert.match(source, /getUserMedia/);
  assert.match(source, /RTCPeerConnection/);
  assert.match(source, /replaceTrack/);
  assert.match(source, /pipeline\.routeVideoTrack/);
  assert.match(source, /pipeline\.markOutboundTrack/);
  assert.match(source, /pipeline\.dispose/);
  assert.match(source, /case 'PING'/);
});

test('The pipeline separates processed video from microphone ownership', () => {
  const source = read('src/camera/camera-pipeline.ts');
  assert.match(source, /audioTrack\.clone\(\)/);
  assert.match(source, /releaseOutputAudio/);
  assert.match(source, /routeVideoTrack/);
  assert.match(source, /markOutboundTrack/);
  assert.doesNotMatch(source, /inputStream\?\.getTracks\(\)\.forEach/);
});

test('The compositor has an honest degraded fallback and reusable mask buffers', () => {
  const source = read('src/camera/compositor.ts');
  assert.match(source, /There is no honest way to remove a person/);
  assert.match(source, /maskImageData/);
  assert.match(source, /blur\(/);
});

test('The build validates assets before atomically replacing dist', () => {
  const source = read('scripts/build.mjs');
  assert.match(source, /dist-staging/);
  assert.match(source, /selfie_segmenter\.tflite/);
  assert.match(source, /renameSync\(staging, dist\)/);
  assert.match(source, /MediaPipe WASM assets are missing/);
});

test('The local model is present in source assets', () => {
  assert.ok(existsSync(resolve(root, 'public/models/selfie_segmenter.tflite')));
});

test('A completed build contains the manifest-referenced runtime files when dist exists', (t) => {
  const dist = resolve(root, 'dist');
  if (!existsSync(resolve(dist, 'manifest.json'))) {
    t.skip('Run npm run build to inspect generated extension assets.');
    return;
  }

  const manifest = readJson('dist/manifest.json');
  for (const file of ['content.js', 'page-bridge.js', 'background.js', 'popup.html', 'popup.js', 'popup.css']) {
    assert.ok(existsSync(resolve(dist, file)), `missing dist/${file}`);
  }
  assert.ok(existsSync(resolve(dist, 'models/selfie_segmenter.tflite')));
  assert.ok(existsSync(resolve(dist, 'wasm')));
  assert.ok(manifest.content_scripts.some((entry) => entry.js?.includes('page-bridge.js')));
});
