import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { validateBuild } from '../scripts/validate-build.mjs';

function writeAsset(directory, path, data) {
  const destination = resolve(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, data);
}

function writeJson(directory, path, value) {
  writeAsset(directory, path, JSON.stringify(value));
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-build-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  writeJson(directory, 'manifest.json', manifest);
  for (const path of ['content.js', 'page-bridge.js', 'hand-gesture-worker.js', 'background.js', 'popup.html', 'popup.js', 'popup.css',
    'licenses/NOTICE.md', 'licenses/Apache-2.0.txt']) {
    writeAsset(directory, path, 'test fixture\n');
  }
  writeAsset(directory, 'page-bridge.js', 'globalThis.__veylMediaPipeCreateScriptUrl = true;\n');
  for (const path of Object.values(manifest.icons)) {
    writeAsset(directory, path, readFileSync(new URL(`../public/${path}`, import.meta.url)));
  }
  const provenance = {
    models: ['selfie_segmenter.tflite', 'hand_landmarker.task'].map((file) => {
      const data = Buffer.from(`test model: ${file}`);
      writeAsset(directory, `models/${file}`, data);
      return { file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    })
  };
  writeJson(directory, 'models/models.json', provenance);
  for (const variant of ['vision_wasm_internal', 'vision_wasm_nosimd_internal']) {
    writeAsset(directory, `wasm/${variant}.js`, '/* test WASM loader */');
    writeAsset(directory, `wasm/${variant}.wasm`, Buffer.from('0061736d01000000', 'hex'));
  }
  return { directory, manifest, provenance };
}

test('a complete package passes validation without a browser or an existing dist', (t) => {
  const { directory, manifest } = fixture(t);
  assert.deepEqual(validateBuild(directory), manifest);
});

for (const [name, change] of [
  ['an empty model list', (models) => { models.length = 0; }],
  ['a missing required model entry', (models) => { models.pop(); }],
  ['a duplicated model replacing a required entry', (models) => { models[1] = models[0]; }]
]) {
  test(`package validation rejects ${name} even when both model files exist`, (t) => {
    const { directory, provenance } = fixture(t);
    change(provenance.models);
    writeJson(directory, 'models/models.json', provenance);
    assert.throws(() => validateBuild(directory), /required model/);
  });
}

for (const sizes of [[], ['16', '32', '48']]) {
  test(`package validation rejects omitted icon metadata (${sizes.length} sizes declared)`, (t) => {
    const { directory, manifest } = fixture(t);
    manifest.icons = Object.fromEntries(sizes.map((size) => [size, manifest.icons[size]]));
    manifest.action.default_icon = { ...manifest.icons };
    writeJson(directory, 'manifest.json', manifest);
    assert.throws(() => validateBuild(directory), /required runtime icon/);
  });
}

test('package validation rejects missing action icon metadata', (t) => {
  const { directory, manifest } = fixture(t);
  delete manifest.action.default_icon['128'];
  writeJson(directory, 'manifest.json', manifest);
  assert.throws(() => validateBuild(directory));
});

for (const path of ['background.js', 'models/models.json', 'models/hand_landmarker.task', 'icons/veyl-128.png',
  'wasm/vision_wasm_nosimd_internal.wasm', 'licenses/NOTICE.md']) {
  test(`package validation rejects a missing ${path}`, (t) => {
    const { directory } = fixture(t);
    rmSync(resolve(directory, path));
    assert.throws(() => validateBuild(directory), /Missing\/empty build asset/);
  });
}

test('package validation rejects a missing manifest', (t) => {
  const { directory } = fixture(t);
  rmSync(resolve(directory, 'manifest.json'));
  assert.throws(() => validateBuild(directory), /ENOENT/);
});

test('package validation rejects an empty required asset', (t) => {
  const { directory } = fixture(t);
  writeAsset(directory, 'licenses/Apache-2.0.txt', '');
  assert.throws(() => validateBuild(directory), /Missing\/empty build asset/);
});

test('package validation rejects truncated models and same-size checksum corruption', (t) => {
  const { directory } = fixture(t);
  const path = 'models/selfie_segmenter.tflite';
  const data = readFileSync(resolve(directory, path));
  writeAsset(directory, path, data.subarray(0, -1));
  assert.throws(() => validateBuild(directory), /Unexpected model size/);
  data[0] ^= 0xff;
  writeAsset(directory, path, data);
  assert.throws(() => validateBuild(directory), /Model checksum mismatch/);
});

test('package validation checks the full PNG signature and declared icon dimensions', (t) => {
  const { directory } = fixture(t);
  const path = 'icons/veyl-16.png';
  const png = readFileSync(resolve(directory, path));
  const corrupt = Buffer.from(png);
  corrupt[0] = 0;
  writeAsset(directory, path, corrupt);
  assert.throws(() => validateBuild(directory), /PNG/);
  writeAsset(directory, path, png.subarray(0, 12));
  assert.throws(() => validateBuild(directory), /PNG/);
  png.writeUInt32BE(32, 16);
  writeAsset(directory, path, png);
  assert.throws(() => validateBuild(directory));
});

for (const [name, hex] of [
  ['bad magic', '0102030401000000'],
  ['a truncated header', '0061736d'],
  ['an invalid section after a valid header', '0061736d01000000010200']
]) {
  test(`package validation rejects WASM with ${name}`, (t) => {
    const { directory } = fixture(t);
    writeAsset(directory, 'wasm/vision_wasm_internal.wasm', Buffer.from(hex, 'hex'));
    assert.throws(() => validateBuild(directory));
  });
}
