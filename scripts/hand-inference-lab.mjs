import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMediaPipeLoaderPlugin } from './mediapipe-loader.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const browserPath = process.env.BROWSER_BIN;
const inputPath = process.env.HAND_IMAGE;
if (!browserPath) throw new Error('Set BROWSER_BIN to a Chromium/Chrome-for-Testing executable.');
if (!inputPath) throw new Error('Set HAND_IMAGE to a local hand image. The lab does not upload or persist it.');

const input = await readFile(resolve(inputPath));
const bundle = await build({
  stdin: {
    contents: `export { HandGestureDetector } from './src/gestures/hand-gesture-detector';
export { installMediaPipeTrustedTypesAdapter } from './src/camera/mediapipe-trusted-types';`,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'VeylHandLab',
  platform: 'browser',
  target: ['chrome111', 'es2022'],
  plugins: [createMediaPipeLoaderPlugin()]
});

const contentType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[extname(inputPath).toLowerCase()] ?? 'image/png';
const trustedTypesEnforced = process.env.VEYL_TRUSTED_TYPES === '1';
const server = createServer((request, response) => {
  if (request.url === '/lab.js') {
    response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].contents); return;
  }
  if (request.url === '/input') {
    response.setHeader('Content-Type', contentType); response.end(input); return;
  }
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    if (trustedTypesEnforced) response.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'");
    response.end(`<!doctype html><meta charset="utf-8"><title>VEYL hand inference lab</title>
      <script src="/lab.js"></script><script>
      window.handLab = { async run(baseUrl) {
        const image = new Image(); image.src = '/input'; await image.decode();
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / image.naturalWidth, 720 / image.naturalHeight);
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const stream = canvas.captureStream(1);
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.srcObject = stream;
        await video.play(); await new Promise((resolve) => requestAnimationFrame(resolve));
        VeylHandLab.installMediaPipeTrustedTypesAdapter(baseUrl);
        const detector = new VeylHandLab.HandGestureDetector();
        await detector.initialize(baseUrl + 'wasm/', baseUrl + 'models/hand_landmarker.task');
        const samples = [];
        for (let index = 0; index < 3; index += 1) {
          const result = detector.detect(video, performance.now() + index * 100, 0.62, 1100);
          samples.push({ handTracked: result.handTracked, state: result.state, candidate: result.candidate,
            inferenceMs: result.inferenceMs, landmarkCount: result.landmarks?.length ?? 0,
            landmarks: result.landmarks?.slice(0, 3) ?? null });
        }
        const modelReady = detector.ready; detector.close();
        stream.getTracks().forEach((track) => track.stop());
        return { modelReady, trustedTypes: Boolean(globalThis.trustedTypes), samples };
      } };
      </script>`);
    return;
  }
  response.statusCode = 404; response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = await mkdtemp(resolve(tmpdir(), 'veyl-hand-lab-'));
let stderr = '';
const child = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--load-extension=${resolve(root, 'dist')}`,
  `--disable-extensions-except=${resolve(root, 'dist')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const connections = [];

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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

async function waitFor(work, label, timeout = 30000) {
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
  const workerTarget = await waitFor(async () => {
    const targets = await (await fetch(`${debugOrigin}/json/list`)).json();
    return targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  }, 'Unpacked extension worker');
  const worker = new CDP(workerTarget.webSocketDebuggerUrl);
  const baseUrl = new URL('/', workerTarget.url).href;
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const target = await waitFor(async () => (await (await fetch(`${debugOrigin}/json/list`)).json()).find((item) => item.id === targetId), 'Hand lab target');
  const page = new CDP(target.webSocketDebuggerUrl);
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => page.evaluate('Boolean(window.handLab?.run)'), 'Hand lab bootstrap');
  const result = await page.evaluate(`window.handLab.run(${JSON.stringify(baseUrl)})`);
  assert.equal(result.modelReady, true, 'The real hand landmarker did not become ready');
  const samplesWithHands = result.samples.filter((sample) => sample.landmarkCount === 21);
  if (process.env.REQUIRE_HAND === '1') assert.ok(samplesWithHands.length, 'No hand landmarks were detected in the supplied image.');
  console.log(JSON.stringify({ evidence: 'Real bundled MediaPipe HandLandmarker inference', trustedTypesEnforced,
    input: inputPath, samples: result.samples, detectedFrames: samplesWithHands.length }, null, 2));
} catch (error) {
  console.error('Hand inference lab failed:', error.message); console.error(stderr.slice(-5000)); process.exitCode = 1;
} finally {
  for (const connection of connections) {
    for (const waiting of connection.pending.values()) clearTimeout(waiting.timer);
    connection.socket.close();
  }
  server.close(); child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
