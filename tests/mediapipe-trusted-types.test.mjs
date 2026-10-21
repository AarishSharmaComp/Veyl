import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { contents: "export * from './src/camera/mediapipe-trusted-types';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'iife', globalName: 'veylTrustedTypes'
});

function environment(trustedTypes) {
  const context = vm.createContext({ URL, console: { error() {} }, trustedTypes });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context;
}

const extensionBase = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const loader = `${extensionBase}wasm/vision_wasm_internal.js`;

test('the adapter returns a TrustedScriptURL only for the packaged MediaPipe loaders', () => {
  const policies = [];
  const context = environment({
    createPolicy(name, rules) {
      policies.push({ name, rules });
      return { createScriptURL: (value) => {
        const checked = rules.createScriptURL(value);
        return { value: checked, toString: () => checked };
      } };
    }
  });

  context.veylTrustedTypes.installMediaPipeTrustedTypesAdapter(extensionBase);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].name, 'veyl-mediapipe-loader-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(context.__veylMediaPipeCreateScriptUrl(loader).value, loader);
  assert.equal(context.__veylMediaPipeCreateScriptUrl(`${extensionBase}wasm//vision_wasm_internal.js`).value,
    `${extensionBase}wasm//vision_wasm_internal.js`);
  assert.throws(() => context.__veylMediaPipeCreateScriptUrl('https://example.test/loader.js'), /unapproved loader source/);
  assert.throws(() => context.__veylMediaPipeCreateScriptUrl(`${extensionBase}models/hand_landmarker.task`), /unapproved loader source/);
});

test('policy creation failure is surfaced and leaves no adapter installed', () => {
  const context = environment({ createPolicy: () => { throw new Error('blocked by page policy'); } });
  assert.throws(() => context.veylTrustedTypes.installMediaPipeTrustedTypesAdapter(extensionBase), /policy creation was disallowed/);
  assert.equal(context.__veylMediaPipeTrustedTypesAdapter, undefined);
  assert.equal(context.__veylMediaPipeCreateScriptUrl, undefined);
});

test('the adapter remains fail-closed without Trusted Types', () => {
  const context = environment(undefined);
  context.veylTrustedTypes.installMediaPipeTrustedTypesAdapter(extensionBase);
  assert.equal(context.__veylMediaPipeCreateScriptUrl(loader), loader);
  assert.throws(() => context.__veylMediaPipeCreateScriptUrl('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/wasm/vision_wasm_internal.js'), /unapproved loader source/);
});

test('a page cannot spoof adapter state and skip installing the validator', () => {
  const context = environment(undefined);
  Object.defineProperty(context, '__veylMediaPipeTrustedTypesAdapter', {
    configurable: true, value: { extensionBaseUrl: extensionBase }
  });
  assert.throws(() => context.veylTrustedTypes.installMediaPipeTrustedTypesAdapter(extensionBase), /already bound/);
  assert.equal(context.__veylMediaPipeCreateScriptUrl, undefined);
});

test('worker blob URLs are branded only after the VEYL adapter receives them', () => {
  const policies = [];
  const context = environment({
    createPolicy(name, rules) {
      policies.push({ name, rules });
      return { createScriptURL: (value) => ({ value: rules.createScriptURL(value), toString: () => value }) };
    }
  });
  context.veylTrustedTypes.installMediaPipeTrustedTypesAdapter(extensionBase);
  const blobUrl = 'blob:http://video.example/veyl-worker';
  assert.throws(() => context.veylTrustedTypes.createMediaPipeWorkerScriptUrl(blobUrl), /not created by VEYL/);
  context.veylTrustedTypes.registerMediaPipeWorkerScriptUrl(blobUrl);
  const trusted = context.veylTrustedTypes.createMediaPipeWorkerScriptUrl(blobUrl);
  assert.equal(trusted.value, blobUrl);
  assert.throws(() => context.veylTrustedTypes.createMediaPipeWorkerScriptUrl('blob:http://video.example/not-approved'), /not created by VEYL/);
  assert.equal(policies.some(({ name }) => name.startsWith('veyl-mediapipe-worker-')), true);
});
