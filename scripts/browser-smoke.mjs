import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const browserPath = process.env.BROWSER_BIN;
if (!browserPath) throw new Error('Set BROWSER_BIN to a Chromium/Chrome-for-Testing executable supporting unpacked extensions. No personal browser profile is used.');
const trustedTypesEnforced = process.env.VEYL_TRUSTED_TYPES === '1';
const profile = await mkdtemp(resolve(tmpdir(), 'veyl-synthetic-smoke-'));
const fixture = await readFile(resolve(root, 'tests/fixtures/loopback.js'));
const bridge = await readFile(resolve(root, 'dist/page-bridge.js'));
const server = createServer((request, response) => {
  if (request.url === '/bridge.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bridge); }
  else if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(fixture); }
  else {
    response.setHeader('Content-Type', 'text/html');
    if (trustedTypesEnforced) response.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'");
    response.end(`<!doctype html><meta charset="utf-8"><title>Veyl synthetic loopback</title><body>
      <script>window.microphoneRequests=0; const native=navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia=function(c){if(c?.audio)window.microphoneRequests++;return native.call(this,c)};</script>
      <script src="/bridge.js"></script><script src="/fixture.js"></script>`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let stderr = '';
const child = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--load-extension=${resolve(root, 'dist')}`, `--disable-extensions-except=${resolve(root, 'dist')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('error', (error) => { stderr += error.message; });
const connections = [];
let page;

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.next = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data); const waiting = this.pending.get(message.id);
      if (!waiting) return; this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result);
    };
    connections.push(this);
  }
  async call(method, params = {}) {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

async function waitFor(work, label, timeout = 20000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await work(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

try {
  const endpoint = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Browser debugging startup');
  const debugOrigin = endpoint.replace(/^ws:/, 'http:').split('/devtools/')[0];
  const browser = new CDP(endpoint);
  const version = await browser.call('Browser.getVersion');
  const workerTarget = await waitFor(async () => {
    const targets = await (await fetch(`${debugOrigin}/json/list`)).json();
    return targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  }, 'Unpacked extension worker');
  const worker = new CDP(workerTarget.webSocketDebuggerUrl);
  const manifest = await worker.evaluate('chrome.runtime.getManifest()');
  assert.equal(manifest.name, 'Veyl — Live Camera Effects');
  assert.equal(manifest.action.default_title, 'Veyl');
  const baseUrl = new URL('/', workerTarget.url).href;
  // Parse port-specific registration using the real browser implementation.
  // This temporary fixture registration is not used to run its bridge.
  const registration = await worker.evaluate(`(async()=>{
    await chrome.scripting.registerContentScripts([{id:'veyl-smoke-port-check',matches:['http://127.0.0.1:${port}/*'],js:['content.js'],runAt:'document_start'}]);
    await chrome.scripting.unregisterContentScripts({ids:['veyl-smoke-port-check']});return true;
  })()`);
  assert.equal(registration, true);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const target = await waitFor(async () => (await (await fetch(`${debugOrigin}/json/list`)).json()).find((item) => item.id === targetId), 'Fixture target');
  page = new CDP(target.webSocketDebuggerUrl);
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => page.evaluate('Boolean(window.veylSmoke?.configure)'), 'Fixture bootstrap');
  if (trustedTypesEnforced) assert.equal(await page.evaluate('Boolean(window.trustedTypes)'), true);
  await page.evaluate(`window.veylSmoke.configure(${JSON.stringify(baseUrl)},true,true,true)`);
  const started = await page.evaluate('window.veylSmoke.start()');
  assert.equal(started.microphoneRequests, 0);
  await waitFor(() => page.evaluate('window.veylSmoke.remote?.readyState >= 2 && window.veylSmoke.status?.cameraRoute === "outbound"'), 'Loopback processed video');
  await waitFor(() => page.evaluate('window.veylSmoke.status?.modelReady && window.veylSmoke.status?.gestureDetectionActive'), 'Both real local MediaPipe models', 45000);
  await waitFor(() => page.evaluate('window.veylSmoke.status?.lastHandInferenceAt !== null'), 'First hand inference', 45000);
  const modelState = await page.evaluate('({modelReady:veylSmoke.status.modelReady, handModelReady:veylSmoke.status.gestureDetectionActive, handInferenceOffloaded:veylSmoke.status.handInferenceOffloaded, handInferenceOffloadError:veylSmoke.status.handInferenceOffloadError, handInferenceMs:veylSmoke.status.handInferenceMs, workerType:typeof Worker, imageBitmapType:typeof createImageBitmap, fps:veylSmoke.status.fps})');

  await page.evaluate(`window.veylSmoke.configure(${JSON.stringify(baseUrl)},true,false,true)`);
  await waitFor(() => page.evaluate('window.veylSmoke.status?.modelReady === true'), 'Segmentation remains available with normal removal compositing off');
  const requestId = await page.evaluate('window.veylSmoke.toggle()');
  await waitFor(() => page.evaluate(`window.veylSmoke.replies.get(${JSON.stringify(requestId)})?.ok`), 'Disappear command');
  let hiddenOutputMode = 'unknown';
  const hiddenPixel = await waitFor(async () => {
    const evidence = await page.evaluate('({pixel:window.veylSmoke.pixel(), mismatch:Boolean(window.veylSmoke.status?.backgroundMismatch)})');
    const pixel = evidence.pixel;
    const plateMatch = Math.abs(pixel[0] - 192) < 18 && Math.abs(pixel[1] - 32) < 18 && Math.abs(pixel[2] - 64) < 18;
    const safeFallback = pixel[3] === 255 && Math.max(pixel[0], pixel[1], pixel[2]) > 8;
    if (evidence.mismatch && safeFallback) hiddenOutputMode = 'graceful-fallback';
    if (!evidence.mismatch && plateMatch) hiddenOutputMode = 'background-plate';
    return ((evidence.mismatch ? safeFallback : plateMatch) && pixel);
  }, 'Hidden output received by remote peer');
  await new Promise((resolve) => setTimeout(resolve, 650));
  const appearId = await page.evaluate('window.veylSmoke.toggle()');
  await waitFor(() => page.evaluate(`window.veylSmoke.replies.get(${JSON.stringify(appearId)})?.ok`), 'Reappear command');
  await waitFor(async () => {
    const pixel = await page.evaluate('window.veylSmoke.pixel()');
    return Math.abs(pixel[0] - hiddenPixel[0]) > 25 || Math.abs(pixel[1] - hiddenPixel[1]) > 25 || Math.abs(pixel[2] - hiddenPixel[2]) > 25;
  }, 'Live frame restored to remote peer');
  await page.evaluate(`window.veylSmoke.configure(${JSON.stringify(baseUrl)},false,false)`);
  await waitFor(() => page.evaluate('veylSmoke.sender.track !== veylSmoke.processed && veylSmoke.processed.readyState === "ended"'), 'Original sender restoration');
  assert.equal(await page.evaluate('window.microphoneRequests'), 0);
  await page.evaluate('window.veylSmoke.stop()');
  console.log(JSON.stringify({ browser: version.product, evidence: 'Synthetic local WebRTC loopback, NOT a Meet/OmeTV call',
    trustedTypesEnforced, manifestName: manifest.name, explicitPortRegistration: true, ...modelState,
    hiddenOutputMode, receivedHiddenPixel: hiddenPixel, reappearance: true, originalSenderRestored: true, microphoneRequests: 0 }, null, 2));
} catch (error) {
  console.error('Browser smoke failed:', error.message);
  if (page) {
    try { console.error('Page evidence:', JSON.stringify(await page.evaluate('({status:window.veylSmoke?.status,errors:window.veylSmoke?.errors})'))); }
    catch (pageError) { console.error('Page evidence unavailable:', pageError.message); }
  }
  console.error(stderr.slice(-5000));
  process.exitCode = 1;
} finally {
  for (const connection of connections) {
    for (const waiting of connection.pending.values()) clearTimeout(waiting.timer);
    connection.socket.close();
  }
  server.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
