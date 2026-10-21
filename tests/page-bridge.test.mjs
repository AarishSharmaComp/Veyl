import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/page/page-bridge.ts'], bundle: true, write: false, format: 'iife',
  plugins: [{ name: 'media-boundaries', setup(builder) {
    builder.onResolve({ filter: /camera-pipeline$/ }, () => ({ path: 'pipeline', namespace: 'boundary' }));
    builder.onResolve({ filter: /camera-integration$/ }, () => ({ path: 'integration', namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, ({ path }) => ({ contents: path === 'pipeline' ? `
      export class CameraPipeline {
        currentStatus = { cameraAvailable: false, pipelineInitialized: false, effectActive: false, cameraRoute: 'waiting' };
        constructor(settings, event) { this.event = event; globalThis.media.pipeline = this; }
        setSiteContext() { globalThis.media.contexts++; }
        async setBackground(value) { globalThis.media.backgrounds.push(value); }
        async setSettings(value) { globalThis.media.settings.push(value); await globalThis.media.modelGate; }
        async setAssetBaseUrl(value) { globalThis.media.assets.push(value); }
        toggleEffect() { this.currentStatus.effectActive = !this.currentStatus.effectActive; globalThis.media.toggles++; }
        async captureBackground() { if(globalThis.media.captureError) throw new Error('camera unavailable'); this.event({type:'BACKGROUND_CAPTURED',background:{width:1}}); }
        async deleteBackground() { this.event({type:'BACKGROUND_DELETED'}); }
      }` : `
      export function installCameraIntegration(pipeline, options) {
        globalThis.media.installs++; globalThis.media.authorization = options.authorize;
        const integration = { currentState: {disposed:false}, async setActive(enabled) { globalThis.media.activations.push(enabled); },
          async dispose() { integration.currentState.disposed = true; globalThis.media.disposals++; } };
        return integration;
      }` }));
  } }] });

async function flush() { for (let step = 0; step < 30; step++) await Promise.resolve(); }
function environment() {
  const listeners = new Map(); const intervals = []; const messages = [];
  const media = { installs: 0, disposals: 0, contexts: 0, toggles: 0, settings: [], assets: [], backgrounds: [], activations: [], pipeline: null };
  const window = { addEventListener(type, listener) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    postMessage(message) { messages.push(structuredClone(message)); }, setInterval(callback) { intervals.push(callback); } };
  const document = { addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, media, document, location: { origin: 'https://video.example', href: 'https://video.example/', hostname: 'video.example' }, URL, Date, console });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const send = (message, origin = 'https://video.example') => {
    for (const handler of listeners.get('message') ?? []) handler({ source: window, origin, data: { source: 'veyl-content', ...message } });
  };
  const config = (enabled, extra = {}) => send({ type: 'CONFIG', sessionId: 'session-id-123', payload: { siteKey: 'https://video.example', siteLabel: 'Test site',
    sessionId: 'session-id-123', siteEnabled: enabled, hostPermissionGranted: enabled,
    settings: { gestureDetection: false }, background: null, assetBaseUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', ...extra } });
  return { window, context, messages, media, listeners, intervals, send, config };
}

test('early bridge does not load models/open cameras before verified configuration', async () => {
  const env = environment(); assert.equal(env.media.installs, 1); assert.equal(env.media.assets.length, 0);
  assert.equal(env.media.settings.length, 0); assert.equal(env.media.contexts, 0);
  const decision = env.media.authorization(); env.config(false); await flush();
  assert.equal(await decision, false); assert.equal(env.media.assets.length, 0); assert.equal(env.media.disposals, 1);
});
test('enabled configuration binds the exact origin, and duplicate injection does not add hooks/listeners', async () => {
  const env = environment(); env.config(true); await flush();
  assert.equal(await env.media.authorization(), true); assert.equal(env.media.assets.length, 1);
  const count = env.listeners.get('message').size;
  vm.runInContext(bundle.outputFiles[0].text, env.context); assert.equal(env.listeners.get('message').size, count);
  assert.equal(env.media.installs, 1);
});
test('wrong-origin and stale-session commands cannot toggle or capture', async () => {
  const env = environment(); env.config(true); await flush(); env.media.pipeline.currentStatus.cameraAvailable = true; env.media.pipeline.currentStatus.pipelineInitialized = true;
  env.send({ type: 'TOGGLE_EFFECT', sessionId: 'wrong-session' });
  env.send({ type: 'TOGGLE_EFFECT', sessionId: 'session-id-123' }, 'https://evil.example'); await flush();
  assert.equal(env.media.toggles, 0);
  env.send({ type: 'TOGGLE_EFFECT', sessionId: 'session-id-123', requestId: 'toggle-1' }); await flush();
  assert.equal(env.media.toggles, 1); assert.equal(env.messages.find((message) => message.requestId === 'toggle-1').payload.ok, true);
});
test('background capture reports real failures rather than acknowledging page readiness as success', async () => {
  const env = environment(); env.config(true); await flush(); env.media.captureError = true;
  env.send({ type: 'CAPTURE_BACKGROUND', sessionId: 'session-id-123', requestId: 'capture-1' }); await flush();
  const response = env.messages.find((message) => message.type === 'COMMAND_RESULT' && message.requestId === 'capture-1');
  assert.equal(response.payload.ok, false); assert.match(response.payload.error, /unavailable/);
});
test('disabled policy restores the integration even while model initialization is still pending', async () => {
  const env = environment(); let release; env.media.modelGate = new Promise((resolve) => { release = resolve; });
  env.config(true); await flush(); env.config(false); await flush();
  assert.equal(env.media.disposals, 1); release(); await flush();
  assert.equal(env.messages.filter((message) => message.type === 'STATUS').at(-1).payload.siteEnabled, false);
});
test('BFCache restore signals READY without creating another bridge or listener', async () => {
  const env = environment(); env.config(true); await flush();
  for (const callback of env.listeners.get('pagehide')) callback({ persisted: true }); await flush();
  for (const callback of env.listeners.get('pageshow')) callback({ persisted: true });
  assert.equal(env.messages.at(-1).type, 'READY'); env.config(true); await flush();
  assert.equal(env.media.installs, 2); assert.equal(env.listeners.get('message').size, 1);
});
