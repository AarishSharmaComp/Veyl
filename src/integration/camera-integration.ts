import type { CameraPipeline } from '../camera/camera-pipeline';

export interface CameraIntegrationOptions {
  /** Install only on a selected page. A callback is rechecked after authorization/attach. */
  active?: boolean | (() => boolean);
  /** Runs alongside native permission acquisition; false/rejection/timeout means passthrough. */
  authorize?: (constraints?: MediaStreamConstraints) => boolean | void | Promise<boolean | void>;
  /** Clamped to 0..1500 ms, measured from the native getUserMedia invocation. */
  authorizationTimeoutMs?: number;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | null;
  peerConnectionPrototype?: Pick<RTCPeerConnection, 'addTrack' | 'addTransceiver' | 'removeTrack' | 'close'> | null;
  senderPrototype?: Pick<RTCRtpSender, 'replaceTrack'> | null;
  onError?: (error: unknown) => void;
  onStateChange?: (state: CameraIntegrationState) => void;
}

export interface CameraIntegrationState {
  active: boolean;
  disposed: boolean;
  /** Aggregate live processed senders across all observed peer connections. */
  outboundCount: number;
  reloadRequired: boolean;
}

export interface CameraIntegrationResult {
  restoredSenders: number;
  failedSenders: number;
  restoredStreams: number;
  reloadRequired: boolean;
}

export interface CameraIntegration {
  readonly currentState: CameraIntegrationState;
  /** false takes effect synchronously; true never acquires a camera or microphone. */
  setActive(active: boolean): Promise<CameraIntegrationResult>;
  /** Restores owned descriptors immediately, then restores senders/streams and releases safe outputs. */
  dispose(): Promise<CameraIntegrationResult>;
}

interface SenderBinding {
  connection: RTCPeerConnection | null;
  track: MediaStreamTrack;
}

const emptyResult = (): CameraIntegrationResult => ({ restoredSenders: 0, failedSenders: 0, restoredStreams: 0, reloadRequired: false });

/**
 * Synchronous document_start prehook, independently injectable from page-message
 * authorization. It only processes native gUM video and routes tracks already
 * known to this pipeline. It neither discovers nor opens cameras on activation.
 */
export function installCameraIntegration(pipeline: CameraPipeline, options: CameraIntegrationOptions = {}): CameraIntegration {
  const mediaDevices = options.mediaDevices === undefined ? (typeof navigator === 'undefined' ? null : navigator.mediaDevices) : options.mediaDevices;
  const peerPrototype = options.peerConnectionPrototype === undefined ? (typeof RTCPeerConnection === 'undefined' ? null : RTCPeerConnection.prototype) : options.peerConnectionPrototype;
  const senderPrototype = options.senderPrototype === undefined ? (typeof RTCRtpSender === 'undefined' ? null : RTCRtpSender.prototype) : options.senderPrototype;
  const nativeReplace = senderPrototype?.replaceTrack;
  const bindings = new Map<RTCRtpSender, SenderBinding>();
  const connections = new Map<RTCPeerConnection, Set<RTCRtpSender>>();
  const senderConnections = new WeakMap<RTCRtpSender, RTCPeerConnection>();
  const closedConnections = new WeakSet<RTCPeerConnection>();
  const pendingReplacements = new Set<Promise<unknown>>();
  const restoreDescriptors: Array<() => void> = [];
  const authorizations = new Set<() => void>();
  let enabled = typeof options.active === 'boolean' ? options.active : true;
  let generation = 0;
  let disposed = false;
  let failedOutputs = new Set<MediaStreamTrack>();
  let transition: Promise<CameraIntegrationResult> = Promise.resolve(emptyResult());
  let disposePromise: Promise<CameraIntegrationResult> | null = null;

  function active(): boolean {
    if (disposed || !enabled) return false;
    try { return typeof options.active !== 'function' || options.active(); } catch (error) {
      report(error);
      return false;
    }
  }

  function report(error: unknown): void {
    try { options.onError?.(error); } catch { /* Observers cannot change native API behavior. */ }
  }

  function state(): CameraIntegrationState {
    const liveFailures = [...failedOutputs].some((track) => track.readyState === 'live');
    let outboundCount = 0;
    for (const [sender, binding] of bindings) {
      if (binding.connection && (closedConnections.has(binding.connection) || binding.connection.connectionState === 'closed')) continue;
      const track = sender.track;
      if (track?.readyState === 'live' && pipeline.isProcessedTrack(track)) outboundCount += 1;
    }
    return { active: active(), disposed, outboundCount, reloadRequired: liveFailures };
  }

  function publish(): void {
    pipeline.setOutboundTracks([...bindings.keys()].map((sender) => sender.track));
    try { options.onStateChange?.(state()); } catch { /* Observers are isolated. */ }
  }

  function remember(sender: RTCRtpSender, connection?: RTCPeerConnection): void {
    if (connection) {
      senderConnections.set(sender, connection);
      let senders = connections.get(connection);
      if (!senders) connections.set(connection, senders = new Set());
      senders.add(sender);
    }
    const owner = connection ?? senderConnections.get(sender) ?? null;
    if (owner && (closedConnections.has(owner) || owner.connectionState === 'closed')) {
      bindings.delete(sender);
      return;
    }
    const track = sender.track;
    if (track && pipeline.getOriginalTrack(track)) bindings.set(sender, { connection: owner, track });
    else bindings.delete(sender);
  }

  function refreshObservedSenders(): void {
    // A site may retain a prehook native replaceTrack reference. Reconcile the
    // actual tracks of observed senders at teardown, including senders initially
    // created with null/unknown tracks, without touching any unknown track.
    for (const [connection, senders] of connections) {
      for (const sender of senders) remember(sender, connection);
    }
  }

  function route(track: MediaStreamTrack | null): MediaStreamTrack | null {
    return track && active() && pipeline.getOriginalTrack(track) ? pipeline.routeVideoTrack(track) : track;
  }

  function waitForAuthorization(constraints?: MediaStreamConstraints): Promise<boolean> {
    if (!options.authorize) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (allowed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        authorizations.delete(cancel);
        resolve(allowed);
      };
      const cancel = () => finish(false);
      const requested = options.authorizationTimeoutMs ?? 1500;
      const timeout = Number.isFinite(requested) ? Math.max(0, Math.min(1500, requested)) : 1500;
      const timer = setTimeout(cancel, timeout);
      authorizations.add(cancel);
      try {
        void Promise.resolve(options.authorize!(constraints)).then((allowed) => finish(allowed !== false), (error) => {
          report(error);
          finish(false);
        });
      } catch (error) {
        report(error);
        finish(false);
      }
    });
  }

  if (mediaDevices) hook(mediaDevices, 'getUserMedia', (native) => function (this: MediaDevices, constraints?: MediaStreamConstraints) {
    // Native gUM starts immediately and exactly once, even before authorization.
    const nativeResult = native.call(this, constraints);
    if (disposed || !enabled || !constraints?.video) return nativeResult;
    const epoch = generation;
    const authorization = waitForAuthorization(constraints);
    return (async () => {
      const stream = await nativeResult;
      if (disposed || !enabled || generation !== epoch) return stream;
      if (!await authorization || !active() || generation !== epoch) return stream;
      try {
        const processed = await pipeline.attach(stream, typeof constraints.video === 'object' ? constraints.video : undefined);
        // suspend() invalidates pending attaches, including preparation/play waits.
        if (disposed || generation !== epoch) return stream;
        if (!active()) {
          // A callback can revoke authorization during frame preparation even
          // without a separate setActive(false) message.
          void disable();
          return stream;
        }
        return processed;
      } catch (error) {
        if (!disposed && enabled && generation === epoch) {
          pipeline.markOriginalFallback();
          report(error);
        }
        return stream;
      }
    })();
  }, restoreDescriptors, report);

  if (peerPrototype) {
    hook(peerPrototype, 'addTrack', (native) => function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
      if (disposed) return native.call(this, track, ...streams);
      const sender = native.call(this, route(track)!, ...streams);
      // Already-processed returned tracks and their clones still need bindings.
      remember(sender, this);
      publish();
      return sender;
    }, restoreDescriptors, report);

    hook(peerPrototype, 'addTransceiver', (native) => function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (disposed) return native.call(this, trackOrKind, init);
      const routed = typeof trackOrKind === 'string' ? trackOrKind : route(trackOrKind)!;
      const transceiver = native.call(this, routed, init);
      remember(transceiver.sender, this);
      publish();
      return transceiver;
    }, restoreDescriptors, report);

    hook(peerPrototype, 'removeTrack', (native) => function (this: RTCPeerConnection, sender: RTCRtpSender) {
      if (disposed) return native.call(this, sender);
      const result = native.call(this, sender);
      // Mutation follows native success only (including synchronous exceptions).
      bindings.delete(sender);
      publish();
      return result;
    }, restoreDescriptors, report);

    hook(peerPrototype, 'close', (native) => function (this: RTCPeerConnection) {
      if (disposed) return native.call(this);
      const result = native.call(this);
      closedConnections.add(this);
      for (const sender of connections.get(this) ?? []) bindings.delete(sender);
      connections.delete(this);
      publish();
      return result;
    }, restoreDescriptors, report);
  }

  if (senderPrototype) hook(senderPrototype, 'replaceTrack', (native) => function (this: RTCRtpSender, track: MediaStreamTrack | null) {
    if (disposed) return native.call(this, track);
    const sender = this;
    const routed = route(track);
    const operation = native.call(sender, routed).then((result) => {
      // A rejected replacement must leave the old binding intact. Read the
      // actual sender after resolution rather than trusting the requested track.
      remember(sender);
      publish();
      return result;
    });
    pendingReplacements.add(operation);
    void operation.then(() => pendingReplacements.delete(operation), () => pendingReplacements.delete(operation));
    return operation;
  }, restoreDescriptors, report);

  if (enabled) pipeline.setEnabled(true);
  else pipeline.suspend();

  async function restoreSenders(): Promise<CameraIntegrationResult> {
    const result = emptyResult();
    const restored = new Set<RTCRtpSender>();
    const attempted = new Map<RTCRtpSender, MediaStreamTrack>();
    // Include successful replacements that were in-flight when disable began.
    // Native gUM/permission promises are deliberately not part of this drain.
    while (pendingReplacements.size) await Promise.allSettled([...pendingReplacements]);
    for (let pass = 0; pass < 3; pass += 1) {
      refreshObservedSenders();
      const work: Promise<void>[] = [];
      for (const [sender, binding] of bindings) {
        if (binding.connection && (closedConnections.has(binding.connection) || binding.connection.connectionState === 'closed')) {
          bindings.delete(sender);
          continue;
        }
        const track = sender.track;
        if (!track || !pipeline.isProcessedTrack(track) || attempted.get(sender) === track) continue;
        attempted.set(sender, track);
        const original = pipeline.getOriginalTrack(track);
        const replacement = original?.readyState === 'live' ? original : null;
        work.push((async () => {
          try {
            if (!nativeReplace) throw new Error('Native sender replacement is unavailable.');
            await nativeReplace.call(sender, replacement);
            if (sender.track === replacement) restored.add(sender);
          } catch (error) { report(error); }
          remember(sender);
        })());
      }
      await Promise.all(work);
      if (!pendingReplacements.size) break;
      while (pendingReplacements.size) await Promise.allSettled([...pendingReplacements]);
    }
    refreshObservedSenders();
    failedOutputs = new Set();
    for (const [sender, binding] of bindings) {
      if (binding.connection && (closedConnections.has(binding.connection) || binding.connection.connectionState === 'closed')) continue;
      const track = sender.track;
      if (track?.readyState === 'live' && pipeline.isProcessedTrack(track)) {
        failedOutputs.add(track);
        result.failedSenders += 1;
      }
    }
    result.restoredSenders = restored.size;
    result.restoredStreams = pipeline.restoreOutputStreams();
    // Failed senders must NEVER be given a stopped/frozen canvas. Keep only their
    // exact tracks live, with the same frame loop but no models/effects.
    pipeline.deactivate({ preserveInputs: true, retainOutputs: failedOutputs });
    result.reloadRequired = failedOutputs.size > 0;
    pipeline.setReloadRequired(result.reloadRequired);
    publish();
    return result;
  }

  function disable(): Promise<CameraIntegrationResult> {
    enabled = false;
    generation += 1;
    for (const cancel of [...authorizations]) cancel();
    // This is synchronous: no pending permission or frame wait can resurrect ML.
    pipeline.suspend();
    const operation = transition.then(restoreSenders, restoreSenders);
    transition = operation;
    return operation;
  }

  return {
    get currentState() { return state(); },
    setActive(value) {
      if (disposed) return disposePromise ?? Promise.resolve(emptyResult());
      if (!value) return disable();
      // An authorization handshake commonly confirms an already armed early
      // hook. Do not invalidate that hook's in-flight native acquisition.
      if (enabled) return transition;
      const epoch = ++generation;
      const operation = transition.then(() => {
        if (!disposed && epoch === generation) {
          enabled = true;
          failedOutputs.clear();
          pipeline.setReloadRequired(false);
          pipeline.setEnabled(true);
          publish();
        }
        return emptyResult();
      });
      transition = operation;
      return operation;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      // A site's later wrappers/descriptors are its property. Captured wrappers
      // are inert from this point onward, even when restoration is still pending.
      for (const restore of restoreDescriptors.reverse()) restore();
      disposePromise = disable();
      return disposePromise;
    }
  };
}

/** Preserve own/inherited descriptor shape; restore only if our exact wrapper remains. */
function hook<T extends object, K extends keyof T>(target: T, name: K, wrap: (native: Extract<T[K], Function>) => T[K], restores: Array<() => void>, report: (error: unknown) => void): void {
  try {
    const originalDescriptor = Object.getOwnPropertyDescriptor(target, name);
    const native = target[name];
    if (typeof native !== 'function') return;
    const wrapper = wrap(native as Extract<T[K], Function>);
    Object.defineProperty(target, name, {
      configurable: originalDescriptor?.configurable ?? true,
      enumerable: originalDescriptor?.enumerable ?? false,
      writable: originalDescriptor && 'writable' in originalDescriptor ? originalDescriptor.writable : true,
      value: wrapper
    });
    restores.push(() => {
      if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) return;
      try {
        if (originalDescriptor) Object.defineProperty(target, name, originalDescriptor);
        else Reflect.deleteProperty(target, name);
      } catch (error) { report(error); }
    });
  } catch (error) { report(error); }
}
