import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export function validateBuild(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Veyl — Live Camera Effects');
  assert.equal(manifest.action.default_title, 'Veyl');
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
  const version = manifest.version.split('.').map(Number);
  assert.ok(version.some(Boolean) && version.every((part) => part <= 65535), 'Invalid Chrome extension version');
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'activeTab']);
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes('hand-gesture-worker.js')),
    'The hand worker must be exposed only through the existing selected-page resource boundary');
  assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes('face-landmarker-worker.js')),
    'The face worker must be exposed only through the existing selected-page resource boundary');
  assert.ok(!('cover' in manifest || 'promotional_image' in manifest), 'Store art is not a manifest field');

  const file = (path) => {
    const resolved = resolve(directory, path);
    assert.ok(!relative(directory, resolved).startsWith(`..${sep}`), 'Asset path escapes the package');
    assert.ok(existsSync(resolved) && statSync(resolved).size > 0, `Missing/empty build asset: ${path}`);
    return readFileSync(resolved);
  };
  assert.deepEqual(Object.keys(manifest.icons).sort((a, b) => Number(a) - Number(b)), ['16', '32', '48', '128'],
    'Manifest must declare each required runtime icon size');
  assert.deepEqual(manifest.action.default_icon, manifest.icons, 'Action icons must match the runtime icon set');
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = file(path);
    assert.ok(png.length >= 24 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      'Chrome runtime icons must be PNG files');
    assert.equal(png.subarray(12, 16).toString(), 'IHDR', 'PNG icons must have an IHDR header');
    assert.equal(png.readUInt32BE(16), Number(size)); assert.equal(png.readUInt32BE(20), Number(size));
  }
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(entry.matches, ['https://meet.google.com/*'], 'Other sites must be registered only after enablement');
    assert.equal(entry.run_at, 'document_start');
    entry.js.forEach(file);
  }
  file(manifest.background.service_worker); file(manifest.action.default_popup); file('popup.css'); file('popup.js');
  const pageBridge = file('page-bridge.js').toString();
  assert.match(pageBridge, /__veylMediaPipeCreateScriptUrl/, 'Page bridge must use the VEYL MediaPipe loader adapter');
  assert.doesNotMatch(pageBridge, /goog#html/, 'The upstream unrestricted MediaPipe Trusted Types policy must not ship');
  assert.doesNotMatch(pageBridge, /\beval\s*\(|new\s+Function\s*\(/, 'Packaged page bridge must not introduce dynamic code execution');
  for (const [workerPath, label] of [['hand-gesture-worker.js', 'hand'], ['face-landmarker-worker.js', 'face']]) {
    const worker = file(workerPath).toString();
    assert.doesNotMatch(worker, /goog#html/, `The upstream unrestricted MediaPipe Trusted Types policy must not ship in the ${label} worker`);
    assert.doesNotMatch(worker, /\beval\s*\(|new\s+Function\s*\(/, `Packaged ${label} worker must not introduce dynamic code execution`);
  }
  file('licenses/NOTICE.md'); file('licenses/Apache-2.0.txt');
  const provenance = JSON.parse(file('models/models.json').toString());
  assert.deepEqual(provenance.models.map((model) => model.file).sort(), ['face_landmarker.task', 'hand_landmarker.task', 'selfie_segmenter.tflite'],
    'Model metadata must list each required model exactly once');
  for (const model of provenance.models) {
    const buffer = file(`models/${model.file}`);
    assert.equal(buffer.length, model.bytes, `Unexpected model size: ${model.file}`);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), model.sha256, `Model checksum mismatch: ${model.file}`);
  }
  for (const variant of ['vision_wasm_internal', 'vision_wasm_nosimd_internal']) {
    file(`wasm/${variant}.js`);
    assert.ok(WebAssembly.validate(file(`wasm/${variant}.wasm`)), `Invalid WASM module: ${variant}`);
  }
  return manifest;
}
