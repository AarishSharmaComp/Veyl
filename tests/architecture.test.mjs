import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBuild } from '../scripts/validate-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('Manifest brands Veyl and limits injection to built-in plus optional origins', () => {
  const manifest = readJson('public/manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.name, /^Veyl/);
  assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'activeTab']);
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*']);
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  assert.ok(manifest.optional_host_permissions.includes('http://localhost/*'));
  assert.ok(manifest.icons['16'].endsWith('veyl-16.png'));

  const contentScripts = manifest.content_scripts ?? [];
  assert.ok(contentScripts.some((entry) => entry.js?.includes('content.js') && entry.run_at === 'document_start'));
  assert.ok(contentScripts.some((entry) => entry.js?.includes('page-bridge.js') && entry.run_at === 'document_start' && entry.world === 'MAIN'));
  assert.ok(contentScripts.every((entry) => entry.matches.every((match) => match === 'https://meet.google.com/*')));
  assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes('face-landmarker-worker.js')));
  assert.ok(!manifest.web_accessible_resources[0].resources.some((resource) => resource.includes('background')));
});

test('The page bridge has a processed-track path and a recovery handshake', () => {
  const bridge = read('src/page/page-bridge.ts');
  const source = read('src/integration/camera-integration.ts');
  assert.match(bridge, /installCameraIntegration/);
  assert.match(source, /getUserMedia/);
  assert.match(source, /RTCPeerConnection/);
  assert.match(source, /replaceTrack/);
  assert.match(source, /pipeline\.routeVideoTrack/);
  assert.match(source, /pipeline\.setOutboundTracks/);
  assert.match(source, /pipeline\.deactivate/);
  assert.match(bridge, /CONFIG/);
  assert.match(bridge, /DEACTIVATE/);
  assert.match(bridge, /message\.type === 'PING'/);
});

test('The pipeline separates processed video from microphone ownership', () => {
  const source = read('src/camera/camera-pipeline.ts');
  assert.match(source, /Audio tracks belong to the calling website/);
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

test('The local model is present in source assets', () => {
  assert.ok(existsSync(resolve(root, 'public/models/selfie_segmenter.tflite')));
  assert.ok(existsSync(resolve(root, 'public/models/hand_landmarker.task')));
  assert.ok(existsSync(resolve(root, 'public/models/face_landmarker.task')));
  for (const size of [16, 32, 48, 128]) assert.ok(existsSync(resolve(root, `public/icons/veyl-${size}.png`)));
  assert.ok(existsSync(resolve(root, 'assets/brand/veyl-mark.svg')));
  assert.ok(existsSync(resolve(root, 'assets/promotional/veyl-cover.svg')));
});

test('Character Studio is an explicit popup opt-in', () => {
  assert.match(read('src/popup/popup.html'), /id="character-toggle"/);
  assert.match(read('src/popup/popup.ts'), /characterStudio: elements\.characterToggle\.checked/);
});

test('The active detector is camera-based and does not contain microphone analysis', () => {
  const source = read('src/gestures/hand-gesture-detector.ts');
  const stateMachine = read('src/gestures/gesture-state-machine.ts');
  assert.match(source, /HandLandmarker/);
  assert.match(source, /detectForVideo/);
  assert.match(stateMachine, /cooldown/);
  assert.doesNotMatch(source, /AudioContext|ScriptProcessor|getUserMedia/);
  assert.doesNotMatch(read('src/page/page-bridge.ts'), /AudioContext|ScriptProcessor|audio:\s*\{/);
});

test('Site policy and storage migration are present', () => {
  const siteSource = read('src/shared/sites.ts');
  const storageSource = read('src/shared/site-storage.ts');
  const settingsSource = read('src/shared/settings.ts');
  assert.match(siteSource, /url\.protocol === 'https:'/);
  assert.match(siteSource, /localhost/);
  assert.match(siteSource, /url\.username \|\| url\.password/);
  assert.match(storageSource, /migrateStoredState/);
  assert.match(storageSource, /MEET_SITE_KEY/);
  assert.match(settingsSource, /snapDetection/);
  assert.match(settingsSource, /gestureDetection/);
});

test('A completed build passes package asset validation when dist exists', (t) => {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) {
    t.skip('Run npm run build to inspect generated extension assets.');
    return;
  }

  const manifest = validateBuild(dist);
  assert.ok(manifest.content_scripts.some((entry) => entry.js?.includes('page-bridge.js')));
});
