import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMediaPipeLoaderPlugin } from './mediapipe-loader.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const browserPath = process.env.BROWSER_BIN;
if (!browserPath) throw new Error('Set BROWSER_BIN to a visible Chromium/Chrome executable.');

const bundle = await build({
  stdin: {
    contents: "export { HandGestureDetector } from './src/gestures/hand-gesture-detector';",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'VeylGestureLab',
  platform: 'browser',
  target: ['chrome111', 'es2022'],
  plugins: [createMediaPipeLoaderPlugin()]
});

const dist = resolve(root, 'dist');
const wasmDirectory = resolve(dist, 'wasm');
const modelPath = resolve(dist, 'models/hand_landmarker.task');
try { await readFile(modelPath); } catch { throw new Error('Run npm run build before starting the standalone gesture lab.'); }

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath === '/lab.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    if (requestPath === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html());
      return;
    }
    if (requestPath === '/models/hand_landmarker.task') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(await readFile(modelPath));
      return;
    }
    if (requestPath.startsWith('/wasm/') && basename(requestPath) === requestPath.slice('/wasm/'.length)) {
      const file = resolve(wasmDirectory, basename(requestPath));
      if (!file.startsWith(`${wasmDirectory}/`)) throw new Error('Invalid WASM path.');
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
      response.end(await readFile(file));
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolvePromise) => server.listen(Number(process.env.VEYL_LAB_PORT) || 0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
const profile = await mkdtemp(resolve(tmpdir(), 'veyl-gesture-lab-'));
const child = spawn(browserPath, [
  '--new-window', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  `--user-data-dir=${profile}`, url
], { stdio: 'inherit' });

console.log(`VEYL standalone gesture lab: ${url}`);
console.log('The page uses the production HandGestureDetector, requests camera-only access, and keeps all measurements local.');
console.log('Use Ctrl+C to stop the lab.');

const shutdown = () => {
  child.kill('SIGTERM');
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await new Promise((resolvePromise) => child.once('exit', resolvePromise));
server.close();
await rm(profile, { recursive: true, force: true });

function html() {
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VEYL gesture lab</title>
<style>
  :root { color-scheme: dark; font: 15px/1.45 system-ui, sans-serif; background: #101016; color: #f4efff; }
  body { max-width: 1100px; margin: 0 auto; padding: 24px; }
  button { border: 0; border-radius: 8px; padding: 10px 14px; background: #b68aff; color: #18121f; font-weight: 700; cursor: pointer; }
  video { width: min(760px, 100%); display: block; margin-top: 16px; border-radius: 12px; background: #000; transform: scaleX(-1); }
  pre { white-space: pre-wrap; background: #1c1924; border: 1px solid #3c334b; border-radius: 10px; padding: 14px; min-height: 220px; }
  .hint { color: #c9bdd8; max-width: 760px; }
</style>
<h1>VEYL finger-snap detector lab</h1>
<p class="hint">This page is independent of the extension and Google Meet. Show one steady hand, hold thumb and middle fingertip together briefly, then curl the middle finger inward quickly. The production detector's measurements and rejection reason appear below.</p>
<button id="start">Start camera</button>
<video id="video" autoplay muted playsinline></video>
<pre id="output">Camera is stopped.</pre>
<script src="/lab.js"></script>
<script>
  globalThis.__VEYL_DEBUG_GESTURES = true;
  const button = document.getElementById('start');
  const video = document.getElementById('video');
  const output = document.getElementById('output');
  let detector;
  let stream;
  let running = false;
  let inFlight = false;
  let lastRequest = -Infinity;
  let lastTimestamp = -Infinity;
  let confirmations = 0;
  let sampleCount = 0;
  let lastResult = null;
  let lastError = null;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      globalThis.__veylMediaPipeCreateScriptUrl = (value) => {
        const url = new URL(value, location.href);
        const allowed = new Set(['/wasm/vision_wasm_internal.js', '/wasm/vision_wasm_nosimd_internal.js', '/wasm/vision_wasm_module_internal.js', '/wasm/vision_wasm_internal.wasm', '/wasm/vision_wasm_nosimd_internal.wasm', '/wasm/vision_wasm_module_internal.wasm']);
        if (url.origin !== location.origin || !allowed.has(url.pathname)) throw new Error('The local lab rejected a non-local MediaPipe loader.');
        return value;
      };
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = stream;
      await video.play();
      detector = new VeylGestureLab.HandGestureDetector();
      await detector.initialize(location.origin + '/wasm/', location.origin + '/models/hand_landmarker.task');
      running = true;
      button.textContent = 'Camera running';
      requestAnimationFrame(loop);
    } catch (error) {
      lastError = String(error);
      button.disabled = false;
      render();
    }
  });
  function loop(now) {
    if (!running) return;
    const timestamp = Math.max(now, lastTimestamp + 1);
    if (!inFlight && timestamp - lastRequest >= 70 && video.readyState >= 2) {
      inFlight = true;
      lastRequest = timestamp;
      Promise.resolve().then(() => detector.detect(video, timestamp, 0.62, 1100)).then((result) => {
        lastResult = result;
        lastTimestamp = timestamp;
        sampleCount += 1;
        if (result.confirmed) confirmations += 1;
        render();
      }).catch((error) => {
        lastError = String(error);
        render();
      }).finally(() => { inFlight = false; });
    }
    requestAnimationFrame(loop);
  }
  function render() {
    const result = lastResult;
    const diagnostics = result?.diagnostics;
    output.textContent = JSON.stringify({
      camera: stream ? 'running' : 'stopped',
      modelReady: Boolean(detector?.ready),
      handTracked: result?.handTracked ?? false,
      state: result?.state ?? 'idle',
      candidate: result?.candidate ?? false,
      confirmed: result?.confirmed ?? false,
      confirmedGesture: result?.confirmedGesture ?? null,
      confirmations,
      samples: sampleCount,
      inferenceMs: result?.inferenceMs ?? 0,
      landmarks: result?.landmarks?.length ?? 0,
      pinchDistance: diagnostics?.pinchDistance ?? null,
      fistScore: diagnostics?.fistScore ?? null,
      distanceDelta: diagnostics?.distanceDelta ?? null,
      middleRadius: diagnostics?.middleRadius ?? null,
      middleRadiusDelta: diagnostics?.middleRadiusDelta ?? null,
      releaseVelocity: diagnostics?.releaseVelocity ?? 0,
      sampleGapMs: diagnostics?.sampleGapMs ?? null,
      contactFrames: diagnostics?.contactFrames ?? 0,
      releaseFrames: diagnostics?.releaseFrames ?? 0,
      cooldownRemainingMs: diagnostics?.cooldownRemainingMs ?? 0,
      reason: diagnostics?.reason ?? 'waiting-for-hand',
      trackingQuality: diagnostics?.trackingQuality ?? 'missing',
      error: lastError
    }, null, 2);
  }
</script>`;
}
