import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the real pipeline/integration/compositor in memory. Only the native
// media/DOM and ML engines are boundaries; no source-text assertions are used.
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: "export * from './src/camera/camera-pipeline'; export * from './src/integration/camera-integration'; export * from './src/camera/compositor';",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  plugins: [{
    name: 'mock-model-engines',
    setup(builder) {
      builder.onResolve({ filter: /(?:person-segmenter|hand-gesture-detector)$/ }, ({ path }) => ({ path, namespace: 'models' }));
      builder.onLoad({ filter: /.*/, namespace: 'models' }, ({ path }) => {
        const hands = path.includes('hand-gesture');
        const kind = hands ? 'hand' : 'segment';
        const name = hands ? 'HandGestureDetector' : 'PersonSegmenter';
        return { contents: `export class ${name} {
          ready = false;
          state = globalThis.__cameraModels;
          async initialize() {
            const state = this.state;
            state.loads.${kind}++;
            state.inFlight.${kind}++;
            state.maxInFlight.${kind} = Math.max(state.maxInFlight.${kind}, state.inFlight.${kind});
            await state.gates.${kind}?.promise;
            state.inFlight.${kind}--;
            this.ready = true;
            state.live.${kind}++;
            state.maxLive.${kind} = Math.max(state.maxLive.${kind}, state.live.${kind});
          }
          close() {
            this.state.closes.${kind}++;
            if (this.ready) this.state.live.${kind}--;
            this.ready = false;
            this.reset();
          }
          reset() { this.state.resets.${kind}++; }
          segment(video) {
            this.state.inferences.segment++;
            if (this.state.segmentError) throw new Error('bad segmentation frame');
            return this.state.invalidMask ? { width: 2, height: 1, data: new Float32Array([1]) } : { width: 1, height: 1, data: new Float32Array([1]) };
          }
          detect(video) {
            this.state.inferences.hand++;
            this.state.handSources.push(video.srcObject.getVideoTracks()[0].id);
            if (this.state.handError) throw new Error('bad hand frame');
            return { handTracked: true, confirmed: this.state.confirmGesture === true };
          }
        }` };
      });
    }
  }]
});
const { CameraPipeline, installCameraIntegration, Compositor } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const settings = {
  realTimeRemoval: false, useBackgroundPlate: false, gestureDetection: false,
  gestureSensitivity: 0.62, gestureCooldownMs: 1100, animations: false,
  animationIntensity: 0.7, performanceMode: 'balanced'
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function environment(t, overrides = {}) {
  const env = {
    captures: [], videos: [], canvases: [], calls: [], queue: [], events: [],
    callbacks: new Map(), nextFrame: 1, nextTrack: 1,
    videoReady: 4, playHangs: false, integrations: [],
    models: {
      loads: { segment: 0, hand: 0 }, closes: { segment: 0, hand: 0 },
      live: { segment: 0, hand: 0 }, maxLive: { segment: 0, hand: 0 },
      inFlight: { segment: 0, hand: 0 }, maxInFlight: { segment: 0, hand: 0 },
      inferences: { segment: 0, hand: 0 }, resets: { segment: 0, hand: 0 },
      gates: {}, handSources: [], segmentError: false, handError: false
    }
  };

  class NativeTrack extends EventTarget {
    constructor(kind = 'video', options = {}) {
      super();
      this.kind = kind;
      this.id = `native-${env.nextTrack++}`;
      this.label = options.label ?? `${kind} source`;
      this.readyState = 'live';
      this.enabled = true;
      this.muted = false;
      this.contentHint = '';
      this.stopCalls = 0;
      this.canvas = options.canvas;
      this.settings = { width: 640, height: 480, frameRate: 60, deviceId: this.id, ...options.settings };
      this.constraints = {};
      this.constraintCalls = [];
    }
    stop() { this.stopCalls++; this.readyState = 'ended'; }
    clone() {
      const clone = new NativeTrack(this.kind, { canvas: this.canvas, settings: this.settings, label: this.label });
      clone.readyState = this.readyState;
      clone.enabled = this.enabled;
      clone.contentHint = this.contentHint;
      return clone;
    }
    getSettings() {
      if (this.canvas) return { width: this.canvas.width, height: this.canvas.height, frameRate: 30 };
      return { ...this.settings };
    }
    getConstraints() { return { ...this.constraints }; }
    getCapabilities() { return { width: { min: 1, max: 4096 }, frameRate: { min: 1, max: 60 } }; }
    async applyConstraints(constraints = {}) {
      this.constraintCalls.push(constraints);
      if (this.rejectConstraints) throw new Error('overconstrained');
      this.constraints = constraints;
      for (const name of ['width', 'height', 'frameRate']) if (typeof constraints[name] === 'number') this.settings[name] = constraints[name];
    }
    mute(value) { this.muted = value; this.dispatchEvent(new Event(value ? 'mute' : 'unmute')); }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }

  class NativeStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((candidate) => candidate !== track); }
    clone() { return new NativeStream(this.tracks.map((track) => NativeTrack.prototype.clone.call(track))); }
  }

  class Video extends EventTarget {
    constructor() { super(); this.readyState = env.videoReady; env.videos.push(this); }
    set srcObject(stream) {
      this.stream = stream;
      const track = stream?.getVideoTracks()[0];
      this.videoWidth = track?.settings.width ?? 0;
      this.videoHeight = track?.settings.height ?? 0;
    }
    get srcObject() { return this.stream; }
    play() { return env.playHangs ? new Promise(() => {}) : Promise.resolve(); }
    pause() { this.paused = true; }
    frame() { this.readyState = 4; this.dispatchEvent(new Event('loadeddata')); }
  }

  class Canvas {
    constructor() {
      this.width = 300; this.height = 150;
      this.draws = []; this.maskWrites = 0; this.offFrames = 0;
      const canvas = this;
      this.context = {
        drawImage(source) {
          if (canvas.failNextDraw) { canvas.failNextDraw = false; throw new Error('draw failed'); }
          canvas.draws.push({ source: source.srcObject?.getVideoTracks()[0] ?? source, filter: this.filter, alpha: this.globalAlpha });
        },
        putImageData(image) { canvas.maskWrites++; canvas.lastMask = new Uint8ClampedArray(image.data); },
        fillRect() { canvas.offFrames++; },
        setTransform() {}, save() {}, restore() {}, clearRect() {},
        translate() {}, rotate() {}, beginPath() {}, arc() {}, stroke() {}
      };
      env.canvases.push(this);
    }
    getContext() { return this.context; }
    captureStream(rate) {
      assert.ok(this.draws.length, 'a usable video frame must be drawn before capture');
      const track = new NativeTrack('video', { canvas: this });
      env.captures.push({ canvas: this, track, rate });
      return new NativeStream([track]);
    }
  }

  class Sender {
    constructor(track) { this.track = track; this.calls = []; }
    async replaceTrack(track) {
      this.calls.push(track);
      if (this.gate) await this.gate.promise;
      if (this.rejectNext) { this.rejectNext = false; throw new Error('replacement rejected'); }
      this.track = track;
    }
  }

  class PeerConnection {
    connectionState = 'new';
    senders = [];
    addTrack(track, ...streams) {
      const sender = new Sender(track);
      sender.streams = streams;
      this.senders.push(sender);
      return sender;
    }
    addTransceiver(trackOrKind, init) {
      const sender = new Sender(typeof trackOrKind === 'string' ? null : trackOrKind);
      this.senders.push(sender);
      return { sender, init };
    }
    removeTrack(sender) {
      if (!this.senders.includes(sender)) throw new Error('wrong connection');
      sender.track = null;
    }
    close() { this.connectionState = 'closed'; }
  }

  const globalValues = {
    MediaStream: NativeStream,
    MediaStreamTrack: NativeTrack,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    document: { createElement: (tag) => tag === 'video' ? new Video() : new Canvas() },
    requestAnimationFrame: (callback) => { const id = env.nextFrame++; env.callbacks.set(id, callback); return id; },
    cancelAnimationFrame: (id) => env.callbacks.delete(id),
    __cameraModels: env.models
  };
  const prior = new Map();
  for (const [name, value] of Object.entries(globalValues)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  env.pipeline = new CameraPipeline({ ...settings, ...overrides }, (event) => env.events.push(event));
  env.mediaDevices = { getUserMedia(constraints) {
    env.calls.push(constraints);
    const response = env.queue.shift();
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  } };
  env.install = (options = {}) => {
    const integration = installCameraIntegration(env.pipeline, {
      mediaDevices: env.mediaDevices,
      peerConnectionPrototype: PeerConnection.prototype,
      senderPrototype: Sender.prototype,
      ...options
    });
    env.integrations.push(integration);
    return integration;
  };
  env.camera = (withAudio = true, options = {}) => {
    const video = new NativeTrack('video', options);
    const audio = withAudio ? new NativeTrack('audio') : null;
    const stream = new NativeStream(audio ? [video, audio] : [video]);
    return { video, audio, stream };
  };
  env.tick = async (timestamp = 1000) => {
    const callbacks = [...env.callbacks.values()];
    env.callbacks.clear();
    for (const callback of callbacks) callback(timestamp);
    await flush();
  };
  env.get = (camera, constraints = { video: true, audio: true }) => {
    env.queue.push(camera.stream);
    return env.mediaDevices.getUserMedia(constraints);
  };
  Object.assign(env, { NativeTrack, NativeStream, Sender, PeerConnection });
  t.after(async () => {
    for (const gate of Object.values(env.models.gates)) gate.resolve();
    for (const integration of env.integrations) await integration.dispose();
    env.pipeline.dispose();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return env;
}

test('one capture source survives acquisitions; output stop/clone leases preserve exact audio and fallback', async (t) => {
  const env = environment(t);
  const first = env.camera(), second = env.camera();
  const a = await env.pipeline.attach(first.stream);
  const outputA = a.getVideoTracks()[0], cloneA = outputA.clone();
  const b = await env.pipeline.attach(second.stream);
  const outputB = b.getVideoTracks()[0];
  assert.equal(env.captures.length, 1);
  assert.notEqual(outputA, outputB);
  assert.equal(outputA.readyState, 'live');
  assert.equal(first.video.stopCalls, 0);
  assert.equal(a.getAudioTracks()[0], first.audio);
  assert.equal(b.getAudioTracks()[0], second.audio);
  assert.equal(env.videos.every((video) => !video.srcObject?.getAudioTracks().length), true);
  assert.equal(env.captures[0].canvas.draws.at(-1).source, second.video);
  outputB.stop();
  assert.equal(second.video.readyState, 'ended');
  assert.equal(env.captures[0].track.readyState, 'live');
  assert.equal(env.captures[0].canvas.draws.at(-1).source, first.video);
  outputA.stop();
  assert.equal(first.video.readyState, 'live', 'a track clone owns an independent lease');
  cloneA.stop();
  assert.equal(first.video.readyState, 'ended', 'last stop releases input synchronously without ended');
  assert.equal(env.captures[0].track.readyState, 'ended');
  assert.equal(first.audio.stopCalls, 0);
  assert.equal(second.audio.stopCalls, 0);
});

test('native MediaStream.clone descendants are known and all returned streams restore original video', async (t) => {
  const env = environment(t);
  const camera = env.camera();
  const returned = await env.pipeline.attach(camera.stream);
  const clonedStream = returned.clone();
  const clonedTrack = clonedStream.getVideoTracks()[0];
  assert.equal(env.pipeline.getOriginalTrack(clonedTrack), camera.video);
  assert.equal(env.pipeline.isProcessedTrack(clonedTrack), true);
  assert.equal(env.pipeline.restoreOutputStreams(), 2);
  assert.equal(returned.getVideoTracks()[0], camera.video);
  assert.equal(clonedStream.getVideoTracks()[0], camera.video);
  assert.equal(returned.getAudioTracks()[0], camera.audio);
  clonedTrack.stop();
  env.pipeline.deactivate({ retainOutputs: [] });
  assert.equal(camera.video.readyState, 'live', 'restoration transferred input ownership');
  assert.equal(camera.audio.stopCalls, 0);
});

test('borrowing processed stop/clone methods preserves the native receiver and never adopts an unknown track', async (t) => {
  const env = environment(t);
  const camera = env.camera();
  const output = (await env.pipeline.attach(camera.stream)).getVideoTracks()[0];
  const unknown = new env.NativeTrack('video', { label: 'screen' });
  const clone = output.clone.call(unknown);
  assert.equal(env.pipeline.isProcessedTrack(clone), false);
  output.stop.call(unknown);
  assert.equal(unknown.readyState, 'ended');
  assert.equal(output.readyState, 'live');
  assert.equal(camera.video.readyState, 'live');
  const processedClone = output.clone();
  output.stop.call(processedClone);
  output.stop();
  assert.equal(camera.video.readyState, 'ended', 'borrowed stops still release known leases synchronously');
  assert.equal(camera.audio.stopCalls, 0);
});

test('gUM routes both native originals and already processed clones; disable restores actual senders and audio', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const camera = env.camera();
  const returned = await env.get(camera);
  const processed = returned.getVideoTracks()[0];
  const clone = processed.clone();
  const pc = new env.PeerConnection();
  const originalSender = pc.addTrack(camera.video, camera.stream);
  const processedSender = pc.addTrack(clone, returned);
  const transceiver = pc.addTransceiver(processed, { direction: 'sendonly' });
  const receiveOnly = pc.addTransceiver('video', { direction: 'recvonly' });
  assert.equal(originalSender.track, processed);
  assert.equal(processedSender.track, clone);
  assert.equal(receiveOnly.sender.track, null);
  assert.equal(integration.currentState.outboundCount, 3);
  assert.equal(env.pipeline.currentStatus.cameraRoute, 'outbound');
  const result = await integration.setActive(false);
  assert.equal(result.restoredSenders, 3);
  assert.equal(result.reloadRequired, false);
  for (const sender of [originalSender, processedSender, transceiver.sender]) assert.equal(sender.track, camera.video);
  assert.equal(returned.getVideoTracks()[0], camera.video);
  assert.equal(returned.getAudioTracks()[0], camera.audio);
  assert.equal(camera.video.readyState, 'live');
  assert.equal(camera.audio.stopCalls, 0);
  assert.equal(processed.readyState, 'ended');
  assert.equal(clone.readyState, 'ended');
  assert.equal(env.calls.length, 1);
});

test('probe then reacquire through actual gUM keeps the second stream live when the first stream stops', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const probe = env.camera(), actual = env.camera();
  const first = await env.get(probe), second = await env.get(actual);
  first.getVideoTracks()[0].stop();
  assert.equal(second.getVideoTracks()[0].readyState, 'live');
  const pc = new env.PeerConnection();
  pc.addTrack(second.getVideoTracks()[0], second);
  assert.equal(integration.currentState.outboundCount, 1);
  assert.equal(env.captures.length, 1);
  assert.equal(probe.video.readyState, 'ended');
  assert.equal(actual.video.readyState, 'live');
  assert.equal(probe.audio.stopCalls + actual.audio.stopCalls, 0);
});

test('unknown screen/remote/canvas/audio tracks pass unchanged and do not demote another camera route', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const camera = env.camera();
  const returned = await env.get(camera);
  const pc = new env.PeerConnection();
  pc.addTrack(returned.getVideoTracks()[0]);
  for (const label of ['screen', 'remote', 'site canvas', 'audio']) {
    const track = new env.NativeTrack(label === 'audio' ? 'audio' : 'video', { label });
    assert.equal(env.pipeline.getOriginalTrack(track), null);
    assert.equal(env.pipeline.routeVideoTrack(track), track);
    const sender = pc.addTrack(track);
    assert.equal(sender.track, track);
    assert.equal(pc.addTransceiver(track).sender.track, track);
    await sender.replaceTrack(track);
    assert.equal(sender.track, track);
    assert.equal(integration.currentState.outboundCount, 1);
    assert.equal(env.pipeline.currentStatus.cameraRoute, 'outbound');
  }
});

test('replaceTrack commits registry only on resolution and a rejection preserves the prior binding', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const first = env.camera(false), second = env.camera(false);
  const a = (await env.get(first)).getVideoTracks()[0];
  const b = (await env.get(second)).getVideoTracks()[0];
  const pc = new env.PeerConnection();
  const sender = pc.addTrack(a);
  sender.rejectNext = true;
  await assert.rejects(sender.replaceTrack(second.video), /rejected/);
  assert.equal(sender.track, a);
  assert.equal(integration.currentState.outboundCount, 1);
  sender.gate = deferred();
  const replacement = sender.replaceTrack(b);
  assert.equal(sender.track, a);
  assert.equal(integration.currentState.outboundCount, 1);
  sender.gate.resolve();
  await replacement;
  assert.equal(sender.track, b);
  const result = await integration.setActive(false);
  assert.equal(result.restoredSenders, 1);
  assert.equal(sender.track, second.video, 'registry uses the resolved processed track, not the old input');
});

test('aggregate outbound count survives removeTrack and close on two different connections', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const output = (await env.get(env.camera())).getVideoTracks()[0];
  const pc1 = new env.PeerConnection(), pc2 = new env.PeerConnection();
  const sender1 = pc1.addTrack(output), sender2 = pc2.addTrack(output.clone());
  assert.equal(integration.currentState.outboundCount, 2);
  assert.throws(() => pc1.removeTrack(sender2), /wrong connection/);
  assert.equal(integration.currentState.outboundCount, 2);
  pc1.removeTrack(sender1);
  assert.equal(integration.currentState.outboundCount, 1);
  assert.equal(env.pipeline.currentStatus.cameraRoute, 'outbound');
  pc2.close();
  assert.equal(integration.currentState.outboundCount, 0);
  assert.equal(env.pipeline.currentStatus.cameraRoute, 'processed');
});

test('disable waits for an in-flight successful replacement before releasing that processed clone', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const camera = env.camera();
  const returned = await env.get(camera);
  const output = returned.getVideoTracks()[0], clone = output.clone();
  const pc = new env.PeerConnection();
  const sender = pc.addTransceiver('video').sender;
  sender.gate = deferred();
  const replacing = sender.replaceTrack(clone);
  const disabling = integration.setActive(false);
  assert.equal(integration.currentState.active, false);
  assert.equal(clone.readyState, 'live');
  sender.gate.resolve();
  await replacing;
  const result = await disabling;
  assert.equal(result.reloadRequired, false);
  assert.equal(sender.track, camera.video);
  assert.equal(clone.readyState, 'ended');
  assert.equal(camera.audio.stopCalls, 0);
});

test('disable reconciles actual tracks on observed senders when a site retained native replaceTrack', async (t) => {
  const env = environment(t);
  const nativeReplace = env.Sender.prototype.replaceTrack;
  const integration = env.install();
  const camera = env.camera();
  const returned = await env.get(camera);
  const output = returned.getVideoTracks()[0];
  const pc = new env.PeerConnection();
  const sender = pc.addTransceiver('video').sender;
  await nativeReplace.call(sender, output);
  const result = await integration.dispose();
  assert.equal(result.restoredSenders, 1);
  assert.equal(sender.track, camera.video);
  assert.equal(output.readyState, 'ended');
  assert.equal(camera.audio.stopCalls, 0);
});

test('rejected restoration retains live passthrough, closes ML, and reports reload until output stops', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  const integration = env.install();
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera();
  const returned = await env.get(camera);
  await flush();
  const output = returned.getVideoTracks()[0];
  const pc = new env.PeerConnection();
  const sender = pc.addTrack(output);
  sender.rejectNext = true;
  const result = await integration.dispose();
  assert.equal(result.failedSenders, 1);
  assert.equal(result.reloadRequired, true);
  assert.equal(sender.track, output);
  assert.equal(output.readyState, 'live');
  assert.equal(env.models.live.segment + env.models.live.hand, 0);
  assert.equal(returned.getVideoTracks()[0], camera.video);
  assert.equal(camera.audio.stopCalls, 0);
  const canvas = env.captures[0].canvas;
  const draws = canvas.draws.length;
  await env.tick(2000);
  await env.tick(2100);
  assert.ok(canvas.draws.length > draws, 'passthrough continues drawing, rather than freezing the sender');
  assert.equal(canvas.draws.at(-1).source, camera.video);
  assert.equal(canvas.draws.at(-1).filter, 'none');
  assert.match(env.pipeline.currentStatus.error, /Reload required/);
  output.stop();
  assert.equal(integration.currentState.reloadRequired, false);
  assert.equal(integration.currentState.outboundCount, 0);
  assert.equal(camera.video.readyState, 'live', 'restoration transferred camera ownership to the site');
});

test('disable during native permission does not wait for permission or process its eventual result', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  const integration = env.install();
  const permission = deferred(), camera = env.camera();
  env.queue.push(permission.promise);
  const pending = env.mediaDevices.getUserMedia({ video: true, audio: true });
  const result = await integration.dispose();
  assert.equal(result.reloadRequired, false);
  permission.resolve(camera.stream);
  assert.equal(await pending, camera.stream);
  assert.equal(env.captures.length, 0);
  assert.equal(env.models.loads.segment + env.models.loads.hand, 0);
  assert.equal(camera.video.stopCalls + camera.audio.stopCalls, 0);
});

test('disable aborts a bounded attach/play wait and preserves the entire original stream', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  env.videoReady = 1;
  env.playHangs = true;
  const integration = env.install();
  const camera = env.camera();
  const pending = env.get(camera);
  await flush();
  assert.equal(env.videos.length, 1);
  await integration.setActive(false);
  assert.equal(await pending, camera.stream);
  assert.equal(env.videos[0].srcObject, null);
  assert.equal(env.captures.length, 0);
  assert.equal(camera.audio.stopCalls + camera.video.stopCalls, 0);
});

test('early authorization starts native gUM immediately and waits for the active decision before processing', async (t) => {
  const env = environment(t);
  const permission = deferred();
  let allowed = false;
  const integration = env.install({ active: () => allowed, authorize: () => permission.promise });
  const camera = env.camera();
  const pending = env.get(camera);
  assert.equal(env.calls.length, 1);
  await flush();
  assert.equal(env.captures.length, 0);
  allowed = true;
  await integration.setActive(true); // Confirming the early hook must not invalidate the request.
  permission.resolve(true);
  const returned = await pending;
  assert.notEqual(returned, camera.stream);
  assert.equal(returned.getAudioTracks()[0], camera.audio);
  assert.equal(integration.currentState.active, true);
});

test('authorization timeout and disabled wrappers return exact native streams without processing', async (t) => {
  const env = environment(t);
  const integration = env.install({ authorize: () => new Promise(() => {}), authorizationTimeoutMs: 5 });
  const camera = env.camera();
  assert.equal(await env.get(camera), camera.stream);
  assert.equal(env.captures.length, 0);
  await integration.setActive(false);
  assert.equal(await env.get(camera), camera.stream);
  assert.equal(env.calls.length, 2);
  assert.equal(camera.audio.stopCalls, 0);
});

test('authorization rejection and native gUM rejection preserve native results and never acquire extra media', async (t) => {
  const env = environment(t);
  const errors = [];
  const integration = env.install({ authorize: () => Promise.reject(new Error('not authorized')), onError: (error) => errors.push(error) });
  const camera = env.camera();
  assert.equal(await env.get(camera), camera.stream);
  const nativeError = new Error('permission denied');
  env.queue.push(nativeError);
  await assert.rejects(env.mediaDevices.getUserMedia({ video: true }), (error) => error === nativeError);
  await flush();
  assert.equal(env.captures.length, 0);
  assert.equal(env.calls.length, 2);
  assert.ok(errors.some((error) => error.message === 'not authorized'));
  await integration.dispose();
});

test('an active callback revoked during frame preparation returns the original and tears down the unreturned output', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  let allowed = true;
  env.videoReady = 1;
  const integration = env.install({ active: () => allowed });
  const camera = env.camera();
  const pending = env.get(camera);
  await flush();
  allowed = false;
  env.videos[0].frame();
  assert.equal(await pending, camera.stream);
  await flush();
  assert.equal(integration.currentState.active, false);
  assert.equal(env.captures[0].track.readyState, 'ended');
  assert.equal(camera.video.readyState, 'live');
  assert.equal(camera.audio.stopCalls, 0);
});

test('dispose restores descriptor shape and captured wrappers become inert', async (t) => {
  const env = environment(t);
  const before = Object.getOwnPropertyDescriptor(env.mediaDevices, 'getUserMedia');
  const integration = env.install({ active: false });
  const captured = env.mediaDevices.getUserMedia;
  const camera = env.camera();
  assert.equal(await env.get(camera), camera.stream);
  await integration.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(env.mediaDevices, 'getUserMedia'), before);
  env.queue.push(camera.stream);
  assert.equal(await captured.call(env.mediaDevices, { video: true }), camera.stream);
  assert.equal(env.captures.length, 0);
});

test('WebRTC descriptors restore exactly and captured add/replace wrappers are inert after disposal', async (t) => {
  const env = environment(t);
  const peerBefore = Object.getOwnPropertyDescriptors(env.PeerConnection.prototype);
  const senderBefore = Object.getOwnPropertyDescriptor(env.Sender.prototype, 'replaceTrack');
  const integration = env.install();
  const add = env.PeerConnection.prototype.addTrack;
  const replace = env.Sender.prototype.replaceTrack;
  const camera = env.camera();
  const returned = await env.get(camera);
  const output = returned.getVideoTracks()[0];
  const pc = new env.PeerConnection();
  const sender = pc.addTrack(output);
  await integration.dispose();
  for (const name of ['addTrack', 'addTransceiver', 'removeTrack', 'close']) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(env.PeerConnection.prototype, name), peerBefore[name]);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(env.Sender.prototype, 'replaceTrack'), senderBefore);
  assert.equal(add.call(pc, camera.video).track, camera.video);
  await replace.call(sender, camera.video);
  assert.equal(sender.track, camera.video);
  assert.equal(env.captures.length, 1);
});

test('dispose preserves a site-installed later wrapper and restores inherited native APIs by deleting its own property', async (t) => {
  const env = environment(t);
  const nativePrototype = env.mediaDevices;
  env.mediaDevices = Object.create(nativePrototype);
  const integration = env.install();
  assert.equal(Object.hasOwn(env.mediaDevices, 'getUserMedia'), true);
  const captured = env.mediaDevices.getUserMedia;
  const later = function (constraints) { return captured.call(this, constraints); };
  Object.defineProperty(env.mediaDevices, 'getUserMedia', { value: later, writable: true, configurable: true });
  await integration.dispose();
  assert.equal(env.mediaDevices.getUserMedia, later);
  const camera = env.camera();
  assert.equal(await env.get(camera), camera.stream);
  assert.equal(env.captures.length, 0);
  const another = Object.create(nativePrototype);
  const installed = installCameraIntegration(env.pipeline, { mediaDevices: another, peerConnectionPrototype: null, senderPrototype: null });
  env.integrations.push(installed);
  await installed.dispose();
  assert.equal(Object.hasOwn(another, 'getUserMedia'), false);
});

test('enabling alone and setting assets/settings do not acquire cameras or load models', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  const integration = env.install({ active: false });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  await env.pipeline.setSettings({ ...settings, realTimeRemoval: true, gestureDetection: true });
  await integration.setActive(true);
  assert.equal(env.calls.length, 0);
  assert.deepEqual(env.models.loads, { segment: 0, hand: 0 });
});

test('enabled polling and nonterminal mute/unmute pause ML without altering consumer enabled state', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera();
  const output = (await env.pipeline.attach(camera.stream)).getVideoTracks()[0];
  await flush();
  const clone = output.clone();
  assert.deepEqual(env.models.loads, { segment: 1, hand: 1 });
  output.enabled = false;
  clone.enabled = false;
  await env.tick(1000);
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 });
  assert.deepEqual(env.models.inferences, { segment: 0, hand: 0 });
  clone.enabled = true;
  await env.tick(1100);
  assert.deepEqual(env.models.loads, { segment: 2, hand: 2 });
  camera.video.mute(true);
  assert.equal(output.readyState, 'live');
  assert.equal(clone.enabled, true);
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 });
  camera.video.mute(false);
  await flush();
  assert.equal(output.enabled, false, 'unmute must not switch a site-disabled output on');
  assert.deepEqual(env.models.loads, { segment: 3, hand: 3 });
  assert.equal(camera.audio.stopCalls, 0);
});

test('source changes reuse singleton models, reset gestures, and raw stop without ended falls back', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const first = env.camera(), second = env.camera();
  const a = await env.pipeline.attach(first.stream);
  await flush();
  await env.tick(1000);
  const resets = env.models.resets.hand;
  const b = await env.pipeline.attach(second.stream);
  await env.tick(1200);
  assert.deepEqual(env.models.loads, { segment: 1, hand: 1 });
  assert.ok(env.models.resets.hand > resets);
  second.video.stop();
  await env.tick(1400);
  assert.equal(env.captures[0].canvas.draws.at(-1).source, first.video);
  assert.equal(a.getVideoTracks()[0].readyState, 'live');
  assert.equal(b.getVideoTracks()[0].readyState, 'live');
  assert.deepEqual(env.models.handSources, [first.video.id, second.video.id, first.video.id]);
});

test('rapid disable/re-enable cannot overlap asynchronous model construction or resurrect a disposed model', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  env.models.gates.segment = deferred();
  env.models.gates.hand = deferred();
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera();
  const output = (await env.pipeline.attach(camera.stream)).getVideoTracks()[0];
  output.enabled = false;
  await env.tick(1000);
  output.enabled = true;
  await env.tick(1100);
  assert.deepEqual(env.models.loads, { segment: 1, hand: 1 });
  env.models.gates.segment.resolve();
  env.models.gates.hand.resolve();
  await flush();
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 }, 'late old generation is closed');
  await env.tick(1200);
  assert.deepEqual(env.models.loads, { segment: 2, hand: 2 });
  assert.deepEqual(env.models.maxInFlight, { segment: 1, hand: 1 });
  assert.deepEqual(env.models.maxLive, { segment: 1, hand: 1 });
  env.pipeline.dispose();
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 });
});

test('deactivation while model creation is pending closes late models and does not stop site-owned input/audio', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  env.models.gates.segment = deferred();
  env.models.gates.hand = deferred();
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const integration = env.install();
  const camera = env.camera();
  const returned = await env.get(camera);
  await integration.dispose();
  assert.equal(returned.getVideoTracks()[0], camera.video);
  env.models.gates.segment.resolve();
  env.models.gates.hand.resolve();
  await flush();
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 });
  assert.equal(env.pipeline.currentStatus.modelReady, false);
  assert.equal(camera.video.stopCalls + camera.audio.stopCalls, 0);
});

test('direct deactivation safely retains existing output consumers and disables all effects/models', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera();
  const returned = await env.pipeline.attach(camera.stream);
  const output = returned.getVideoTracks()[0];
  await flush();
  env.pipeline.deactivate();
  assert.equal(output.readyState, 'live');
  assert.equal(returned.getVideoTracks()[0], camera.video);
  assert.deepEqual(env.models.live, { segment: 0, hand: 0 });
  const count = env.captures[0].canvas.draws.length;
  await env.tick(performance.now() + 100);
  assert.ok(env.captures[0].canvas.draws.length > count);
  output.stop();
  assert.equal(camera.video.readyState, 'live');
  assert.equal(camera.audio.stopCalls, 0);
});

test('an ended original restores a sender to null while other live acquisitions are never reacquired', async (t) => {
  const env = environment(t);
  const integration = env.install();
  const first = env.camera(), second = env.camera();
  const a = await env.get(first), b = await env.get(second);
  const pc = new env.PeerConnection();
  const sender = pc.addTrack(b.getVideoTracks()[0]);
  second.video.stop();
  await env.tick(1000);
  assert.equal(a.getVideoTracks()[0].readyState, 'live');
  assert.equal(env.captures[0].canvas.draws.at(-1).source, first.video);
  const result = await integration.dispose();
  assert.equal(result.restoredSenders, 1);
  assert.equal(sender.track, null);
  assert.deepEqual(b.getVideoTracks(), []);
  assert.equal(env.calls.length, 2);
  assert.equal(first.audio.stopCalls + second.audio.stopCalls, 0);
});

test('usable frame readiness is required, play itself is bounded, and a failed acquisition preserves audio and earlier outputs', async (t) => {
  const env = environment(t);
  env.playHangs = true;
  const first = env.camera();
  const a = await env.pipeline.attach(first.stream);
  assert.equal(a.getVideoTracks()[0].readyState, 'live', 'an available frame is usable even if play never settles');
  env.videoReady = 1;
  const second = env.camera();
  await assert.rejects(env.pipeline.attach(second.stream, { width: 1920, height: 1080 }), /usable video frame/);
  assert.equal(a.getVideoTracks()[0].readyState, 'live');
  assert.equal(first.video.stopCalls + first.audio.stopCalls, 0);
  assert.equal(second.video.stopCalls + second.audio.stopCalls, 0);
  assert.equal(env.captures.length, 1);
});

test('processed metadata reports actual canvas output and source constraints forward defensively', async (t) => {
  const env = environment(t);
  const camera = env.camera(false, { settings: { width: 1280, height: 720, frameRate: 60 } });
  const output = (await env.pipeline.attach(camera.stream)).getVideoTracks()[0];
  const clone = output.clone();
  assert.equal(output.getSettings().width, 1280);
  assert.equal(output.getSettings().frameRate, 30);
  assert.equal(output.getSettings().deviceId, camera.video.id);
  assert.equal(output.getCapabilities().frameRate.max, 30);
  const constraints = { width: 320, height: 240 };
  await clone.applyConstraints(constraints);
  assert.equal(camera.video.constraintCalls[0], constraints);
  assert.deepEqual(output.getConstraints(), constraints);
  camera.video.rejectConstraints = true;
  await assert.rejects(output.applyConstraints({ width: 99999 }), /overconstrained/);
  camera.video.getCapabilities = () => { throw new Error('unsupported'); };
  assert.deepEqual(output.getCapabilities(), {});
  assert.equal(env.pipeline.getOriginalTrack(clone), camera.video);
});

test('hand errors preserve segmentation while segmentation errors use a live fallback', async (t) => {
  const env = environment(t, { realTimeRemoval: true, gestureDetection: true });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera();
  const output = (await env.pipeline.attach(camera.stream)).getVideoTracks()[0];
  await flush();
  env.pipeline.toggleEffect();
  // Integral mock frame timestamps keep the exact 100 ms cadence independent
  // of floating-point rounding in performance.now() + an interval.
  const start = Math.ceil(performance.now()) + 1000;
  await env.tick(start);
  const canvas = env.captures[0].canvas, maskCanvas = env.canvases[2];
  assert.ok(maskCanvas.maskWrites > 0);
  const validWrites = maskCanvas.maskWrites;
  env.models.handError = true;
  await env.tick(start + 20);
  assert.equal(env.models.inferences.hand, 1, 'hand inference is not rerun before its cadence');
  assert.equal(env.models.inferences.segment, 1, 'segmentation is not rerun before its cadence');
  await env.tick(start + 100);
  assert.equal(env.models.inferences.hand, 2, 'the failing hand inference actually ran');
  assert.ok(maskCanvas.maskWrites > validWrites, 'segmentation remains usable when hand inference fails');
  const handErrorWrites = maskCanvas.maskWrites;
  assert.match(env.pipeline.currentStatus.error, /hand gesture frame was skipped/);
  env.models.handError = false;
  env.models.segmentError = true;
  await env.tick(start + 200);
  assert.equal(maskCanvas.maskWrites, handErrorWrites);
  assert.equal(canvas.draws.at(-1).filter, 'none');
  canvas.failNextDraw = true;
  await env.tick(start + 300);
  assert.equal(canvas.draws.at(-1).source, camera.video, 'outer frame recovery also redraws live pixels');
  assert.equal(output.readyState, 'live');
  assert.equal(camera.audio.stopCalls, 0);
});

test('a confirmed local camera gesture toggles the real pipeline effect without microphone access', async (t) => {
  const env = environment(t, { gestureDetection: true });
  await env.pipeline.setAssetBaseUrl('https://extension.test/');
  const camera = env.camera(false);
  await env.pipeline.attach(camera.stream); await flush();
  env.models.confirmGesture = true;
  await env.tick(Math.ceil(performance.now()) + 1000);
  assert.equal(env.pipeline.currentStatus.effectActive, true);
  assert.ok(env.events.some((event) => event.type === 'GESTURE_DETECTED'));
  assert.equal(env.calls.length, 0, 'the gesture detector never asks for its own camera or microphone');
});

test('a confident person mask is fully opaque on the first frame, not a persistent ghost', (t) => {
  const env = environment(t);
  const compositor = new Compositor(); compositor.resize(640, 480);
  const [,,maskCanvas] = env.canvases.slice(-3);
  const background = { ready: true, drawCover(context) { context.drawImage({ plate: true }); } };
  const options = { hidden: true, transitionStrength: 1, realTimeRemoval: true, useBackgroundPlate: true };
  compositor.render({}, background, { data: new Float32Array([0.85]), width: 1, height: 1 }, options);
  assert.equal(maskCanvas.lastMask[3], 255);
});

test('empty person mask preserves live regions, and a missing mask uses the plate instead of a black hole', (t) => {
  const env = environment(t);
  const compositor = new Compositor(); compositor.resize(640, 480);
  const [,,maskCanvas] = env.canvases.slice(-3);
  const plate = { plate: true };
  const background = { ready: true, drawCover(context) { context.drawImage(plate); } };
  const options = { hidden: true, transitionStrength: 1, realTimeRemoval: true, useBackgroundPlate: true };
  compositor.render({}, background, { data: new Float32Array([0]), width: 1, height: 1 }, options);
  assert.equal(maskCanvas.lastMask[3], 0);
  compositor.render({}, background, null, options);
  assert.equal(compositor.canvas.draws.at(-1).source, plate);
});
