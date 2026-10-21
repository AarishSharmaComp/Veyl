import { BackgroundPlate, DEFAULT_STATUS, PipelineStatus, SiteDescriptor, VeylSettings } from '../shared/types';
import { DisappearanceEffect } from '../effects/disappearance-effect';
import { HandGestureDetector, HandGestureResult } from '../gestures/hand-gesture-detector';
import { HandGestureWorkerClient } from '../gestures/hand-gesture-worker-client';
import { BackgroundManager } from './background-manager';
import { Compositor } from './compositor';
import { PerformanceManager } from './performance-manager';
import { PersonSegmenter, SegmentationFrame } from './person-segmenter';

export type PipelineEvent =
  | { type: 'STATUS'; status: PipelineStatus }
  | { type: 'BACKGROUND_CAPTURED'; background: BackgroundPlate }
  | { type: 'BACKGROUND_DELETED' }
  | { type: 'GESTURE_DETECTED' }
  | { type: 'ERROR'; error: string };

export type PipelineEventHandler = (event: PipelineEvent) => void;

export interface CameraDeactivationOptions {
  /** Transfer native video ownership back to the website. Audio is always website-owned. */
  preserveInputs?: boolean;
  /** Omit to keep all consumers live in passthrough mode. Pass [] after restoring all senders. */
  retainOutputs?: Iterable<MediaStreamTrack>;
}

interface CameraSource {
  track: MediaStreamTrack;
  video: HTMLVideoElement;
  leases: Set<OutputLease>;
  preserveInput: boolean;
  order: number;
  cleanup: () => void;
  getSettings: () => MediaTrackSettings;
  getConstraints: () => MediaTrackConstraints;
  getCapabilities: () => MediaTrackCapabilities;
  applyConstraints: (constraints?: MediaTrackConstraints) => Promise<void>;
}

interface OutputLease {
  track: MediaStreamTrack;
  source: CameraSource;
  released: boolean;
}

interface HandInferenceClient {
  initialize(wasmBaseUrl: string, modelUrl: string): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number, sensitivity: number, cooldownMs: number): HandGestureResult | Promise<HandGestureResult>;
  reset(): void;
  close(): void;
  readonly ready: boolean;
  readonly offloaded: boolean;
  readonly offloadError: string | null;
}

/**
 * One active processed camera view per tab, shared by independently stoppable
 * output tracks. The newest live acquisition supplies that view; an older live
 * acquisition takes over if a probe is stopped. Only attach() inputs are known
 * cameras: screen shares, remote tracks and the website's canvases are untouched.
 */
export class CameraPipeline {
  private readonly compositor = new Compositor();
  private readonly backgroundManager = new BackgroundManager();
  private readonly segmenter = new PersonSegmenter();
  private handDetector: HandInferenceClient;
  private handWorkerSelected = false;
  private readonly performance = new PerformanceManager();
  private readonly disappearance = new DisappearanceEffect();
  private readonly sources = new Map<MediaStreamTrack, CameraSource>();
  private readonly originals = new WeakMap<MediaStreamTrack, CameraSource>();
  private readonly outputs = new WeakMap<MediaStreamTrack, OutputLease>();
  private readonly leases = new Set<OutputLease>();
  private readonly outputStreams = new Set<MediaStream>();
  private readonly registeredStreams = new WeakSet<MediaStream>();
  private readonly pendingAttaches = new Set<AbortController>();
  private readonly outboundTracks = new Set<MediaStreamTrack>();
  private activeSource: CameraSource | null = null;
  private captureTrack: MediaStreamTrack | null = null;
  private captureFrameRate = 30;
  private sourceOrder = 0;
  private lifecycle = 0;
  private disposed = false;
  private processingEnabled = true;
  private frameHandle = 0;
  private videoFrameHandle = 0;
  private scheduledVideo: HTMLVideoElement | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private attachQueue: Promise<void> = Promise.resolve();
  // Keep in-flight promises until they settle, including after close(). This
  // prevents a rapid off/on from constructing overlapping model instances.
  private modelInit: Promise<void> | null = null;
  private handModelInit: Promise<void> | null = null;
  private modelEpoch = 0;
  private handEpoch = 0;
  private modelFailed = false;
  private handModelFailed = false;
  private assetBaseUrl = '';
  private latestMask: SegmentationFrame | null = null;
  private latestMaskAt = -Infinity;
  private lastRenderedTimestamp = -Infinity;
  private mismatchCheckPending = false;
  private lastMismatchCheck = 0;
  private lastStatusSent = 0;
  private lastToggleAt = -Infinity;
  private cameraEnabled = false;
  private lastHandInferenceAt = -Infinity;
  private lastHandInferenceRequestAt = -Infinity;
  private handInferenceInFlight: Promise<void> | null = null;
  private handInferenceGeneration = 0;
  private lastCompletedHandTimestamp = -Infinity;
  private handInferenceSamples = 0;
  private reloadRequired = false;
  private settingsValue: VeylSettings;
  private status: PipelineStatus = { ...DEFAULT_STATUS };

  constructor(settings: VeylSettings, private readonly onEvent: PipelineEventHandler) {
    this.settingsValue = { ...settings };
    this.performance.setMode(settings.performanceMode);
    this.handWorkerSelected = typeof Worker === 'function' && typeof createImageBitmap === 'function';
    this.handDetector = this.handWorkerSelected ? new HandGestureWorkerClient() : new HandGestureDetector();
  }

  async setAssetBaseUrl(assetBaseUrl: string): Promise<void> {
    if (this.assetBaseUrl !== assetBaseUrl) {
      this.closeModels();
      this.modelFailed = false;
      this.handModelFailed = false;
    }
    this.assetBaseUrl = assetBaseUrl;
    await Promise.all([this.ensureModel(), this.ensureHandModel()]);
  }

  async setSettings(settings: VeylSettings): Promise<void> {
    const previous = this.settingsValue;
    this.settingsValue = { ...settings };
    this.performance.setMode(settings.performanceMode);
    if (previous.realTimeRemoval && !settings.realTimeRemoval) this.restoreVisibleLiveFrame();
    if (!settings.gestureDetection && previous.gestureDetection) this.closeHands();
    if (settings.realTimeRemoval !== previous.realTimeRemoval) this.modelFailed = false;
    if (settings.gestureDetection !== previous.gestureDetection) this.handModelFailed = false;
    await Promise.all([this.ensureModel(), this.ensureHandModel()]);
    this.emitStatus(true);
  }

  setSiteContext(site: SiteDescriptor | null, siteEnabled: boolean, hostPermissionGranted: boolean, bridgeReady = true): void {
    this.status.siteKey = site?.siteKey ?? null;
    this.status.siteLabel = site?.label ?? 'Current website';
    this.status.siteDetected = site !== null;
    this.status.siteEnabled = siteEnabled;
    this.status.hostPermissionGranted = hostPermissionGranted;
    this.status.bridgeReady = bridgeReady;
    this.emitStatus(true);
  }

  setEnabled(enabled: boolean): void {
    this.status.siteEnabled = enabled;
    if (!enabled) {
      this.deactivate();
      return;
    }
    if (this.disposed) return;
    this.processingEnabled = true;
    this.updateActivity();
    this.updateRoute();
    this.emitStatus(true);
  }

  async setBackground(background: BackgroundPlate | null): Promise<void> {
    try {
      await this.backgroundManager.setPlate(background);
      this.emitStatus(true);
    } catch (error) {
      this.fail(`The saved background could not be loaded: ${toErrorMessage(error)}`);
    }
  }

  private restoreVisibleLiveFrame(): void {
    // Turning removal off is an immediate visible-mode transition. Keep the
    // current segmentation model/mask alive for a later disappearance, but
    // cancel any removal/disappearance render state and put the source frame
    // back on the shared output now.
    this.status.effectActive = false;
    this.disappearance.reset();
    this.compositor.resetVisualEffects();
    this.status.usingBackgroundPlate = false;
    const video = this.activeSource?.video;
    if (video && usableVideo(video)) this.safeLiveFrame(video);
  }

  async attach(stream: MediaStream, videoConstraints?: MediaTrackConstraints): Promise<MediaStream> {
    const lifecycle = this.lifecycle;
    const operation = this.attachQueue.then(() => this.attachInternal(stream, lifecycle, videoConstraints));
    this.attachQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async attachInternal(stream: MediaStream, lifecycle: number, _constraints?: MediaTrackConstraints): Promise<MediaStream> {
    const track = stream.getVideoTracks()[0];
    if (!track || this.isProcessedTrack(track) || !this.canAttach(lifecycle)) return stream;
    const existing = this.sources.get(track);
    if (existing && track.readyState === 'live') {
      const output = this.createOutput(existing);
      existing.order = ++this.sourceOrder;
      this.selectSource();
      return this.createOutputStream(stream, track, output);
    }

    const video = document.createElement('video');
    const abort = new AbortController();
    this.pendingAttaches.add(abort);
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    // Audio tracks belong to the calling website. Never clone or stop them for
    // processing, including preparation failures, switches and deactivation.
    video.srcObject = new MediaStream([track]);
    let source: CameraSource | null = null;
    let output: MediaStreamTrack | null = null;
    try {
      await waitForVideo(video, 900, abort.signal);
      if (!this.canAttach(lifecycle)) return stream;
      if (track.readyState !== 'live') throw new Error('The camera stopped before its first frame.');
      // Draw a real, usable live frame BEFORE capture or returning a stream.
      // Metadata/constraint hints alone are not evidence of a usable frame.
      this.drawLiveFrame(video);
      if (!this.captureTrack || this.captureTrack.readyState !== 'live') {
        this.captureFrameRate = 30;
        this.captureTrack = this.compositor.canvas.captureStream(this.captureFrameRate).getVideoTracks()[0] ?? null;
        if (!this.captureTrack) throw new Error('The processed camera stream has no video track.');
      }
      source = this.createSource(track, video);
      this.sources.set(track, source);
      this.originals.set(track, source);
      output = this.createOutput(source);
      const result = this.createOutputStream(stream, track, output);
      this.selectSource();
      this.status.error = null;
      this.running = true;
      this.updateActivity();
      this.updateRoute();
      this.emitStatus(true);
      this.scheduleFrame();
      return result;
    } catch (error) {
      // Failed preparation never takes ownership of the native stream/audio.
      if (source) source.preserveInput = true;
      output?.stop();
      if (source && source.leases.size === 0) this.removeSource(source);
      if (!this.leases.size) this.releaseCapture();
      if (!this.canAttach(lifecycle)) return stream;
      if (this.activeSource) this.safeLiveFrame(this.activeSource.video);
      throw error;
    } finally {
      this.pendingAttaches.delete(abort);
      if (!source || this.sources.get(track) !== source) detachVideo(video);
    }
  }

  private canAttach(lifecycle: number): boolean {
    return !this.disposed && this.processingEnabled && lifecycle === this.lifecycle;
  }

  private createSource(track: MediaStreamTrack, video: HTMLVideoElement): CameraSource {
    const source: CameraSource = {
      track, video, leases: new Set(), preserveInput: false, order: ++this.sourceOrder,
      cleanup: () => undefined,
      getSettings: () => track.getSettings(),
      getConstraints: () => track.getConstraints(),
      getCapabilities: () => track.getCapabilities(),
      applyConstraints: track.applyConstraints.bind(track)
    };
    const changed = () => {
      if (this.sources.get(track) !== source) return;
      this.selectSource();
      this.updateActivity();
      this.emitStatus(true);
    };
    for (const name of ['ended', 'mute', 'unmute']) track.addEventListener(name, changed);
    source.cleanup = () => {
      for (const name of ['ended', 'mute', 'unmute']) track.removeEventListener(name, changed);
      detachVideo(video);
    };
    return source;
  }

  private createOutput(source: CameraSource): MediaStreamTrack {
    if (!this.captureTrack) throw new Error('Canvas capture is unavailable.');
    const track = this.captureTrack.clone();
    track.enabled = source.track.enabled;
    track.contentHint = source.track.contentHint;
    this.registerOutput(track, source);
    return track;
  }

  private registerOutput(track: MediaStreamTrack, source: CameraSource): void {
    if (this.outputs.has(track)) return;
    const lease: OutputLease = { track, source, released: track.readyState !== 'live' };
    this.outputs.set(track, lease);
    if (!lease.released) {
      source.leases.add(lease);
      this.leases.add(lease);
    }
    const nativeStop = track.stop;
    const nativeClone = track.clone;
    const pipeline = this;
    // Native stop() intentionally does not dispatch ended. Release synchronously.
    try {
      Object.defineProperties(track, {
        stop: { configurable: true, writable: true, value: function (this: MediaStreamTrack) {
          try { nativeStop.call(this); } finally {
            const stopped = pipeline.outputs.get(this);
            if (stopped) pipeline.releaseLease(stopped);
          }
        } },
        clone: { configurable: true, writable: true, value: function (this: MediaStreamTrack) {
          const clone = nativeClone.call(this);
          const parent = pipeline.outputs.get(this);
          if (parent) pipeline.registerOutput(clone, parent.source);
          return clone;
        } }
      });
    } catch (error) {
      // A sealed host object cannot safely participate in stop()/clone() leases.
      // Roll back the clone without taking the native camera away from its owner.
      lease.released = true;
      this.leases.delete(lease);
      source.leases.delete(lease);
      nativeStop.call(track);
      throw error;
    }
    track.addEventListener('ended', () => this.releaseLease(lease), { once: true });
    // Forward source controls, but report actual canvas dimensions/frame rate,
    // not an impossible native-camera resolution on the processed track. On a
    // switch, settings describe the shared active view; constraints still belong
    // to this lease's original acquisition (also used for restoration).
    const nativeSettings = track.getSettings.bind(track);
    defineDefensively(track, 'getSettings', () => {
      const settings = safeRead(() => (this.activeSource ?? source).getSettings(), {});
      const canvasSettings = safeRead(nativeSettings, {});
      return {
        ...settings, ...canvasSettings,
        width: this.compositor.canvas.width,
        height: this.compositor.canvas.height,
        aspectRatio: this.compositor.canvas.width / this.compositor.canvas.height,
        frameRate: Math.min(this.captureFrameRate, canvasSettings.frameRate ?? this.captureFrameRate)
      };
    });
    defineDefensively(track, 'getConstraints', () => safeRead(source.getConstraints, {}));
    defineDefensively(track, 'getCapabilities', () => {
      const capabilities = { ...safeRead(source.getCapabilities, {}) };
      if (capabilities.frameRate) capabilities.frameRate = {
        min: Math.min(capabilities.frameRate.min ?? 0, this.captureFrameRate),
        max: Math.min(capabilities.frameRate.max ?? this.captureFrameRate, this.captureFrameRate)
      };
      return capabilities;
    });
    defineDefensively(track, 'applyConstraints', async (constraints?: MediaTrackConstraints) => {
      await source.applyConstraints(constraints);
      if (this.activeSource === source) this.resetSourceState();
    });
  }

  private createOutputStream(input: MediaStream, original: MediaStreamTrack, output: MediaStreamTrack): MediaStream {
    const stream = new MediaStream(input.getTracks().map((track) => track === original ? output : track));
    this.registerStream(stream);
    return stream;
  }

  private registerStream(stream: MediaStream): void {
    if (this.registeredStreams.has(stream)) return;
    this.registeredStreams.add(stream);
    this.outputStreams.add(stream);
    const nativeClone = stream.clone;
    // Native MediaStream.clone need not call the JS track.clone override.
    defineDefensively(stream, 'clone', () => {
      const clone = nativeClone.call(stream);
      const from = stream.getVideoTracks();
      clone.getVideoTracks().forEach((track, index) => {
        const lease = this.outputs.get(from[index]!);
        if (lease) this.registerOutput(track, lease.source);
      });
      this.registerStream(clone);
      return clone;
    });
  }

  private releaseLease(lease: OutputLease): void {
    if (lease.released) return;
    lease.released = true;
    this.leases.delete(lease);
    lease.source.leases.delete(lease);
    const source = lease.source;
    if (!source.leases.size && !source.preserveInput) {
      // Never enumerate/stop an input stream: it can also contain a microphone.
      if (source.track.readyState === 'live') source.track.stop();
      this.removeSource(source);
    }
    if (!this.leases.size) {
      this.finishConsumers();
    } else {
      this.selectSource();
      this.updateActivity();
    }
    this.updateRoute();
    this.emitStatus(true);
  }

  private removeSource(source: CameraSource): void {
    if (this.sources.get(source.track) !== source) return;
    this.sources.delete(source.track);
    source.cleanup();
  }

  private selectSource(): void {
    let next: CameraSource | null = null;
    for (const source of this.sources.values()) {
      if (source.track.readyState !== 'live' || (!source.leases.size && !source.preserveInput)) continue;
      if (!next || source.order > next.order) next = source;
    }
    if (this.activeSource === next) return;
    this.activeSource = next;
    this.resetSourceState();
    if (next && next.track.enabled && !next.track.muted) this.safeLiveFrame(next.video);
    else this.drawCameraOff();
  }

  private resetSourceState(): void {
    this.latestMask = null;
    this.latestMaskAt = -Infinity;
    this.lastRenderedTimestamp = -Infinity;
    this.compositor.resetMask();
    this.compositor.resetVisualEffects();
    this.disappearance.reset();
    this.handDetector.reset();
    this.handInferenceGeneration += 1;
    this.lastHandInferenceAt = -Infinity;
    this.lastHandInferenceRequestAt = -Infinity;
    this.handInferenceInFlight = null;
    this.lastCompletedHandTimestamp = -Infinity;
    this.handInferenceSamples = 0;
    this.lastToggleAt = -Infinity;
    this.status.lastGestureAt = null;
    this.status.handTracked = false;
    this.status.gestureReason = 'camera-reset';
    this.status.gesturePinchDistance = null;
    this.status.gestureFistScore = null;
    this.status.gestureDistanceDelta = null;
    this.status.gestureMiddleRadius = null;
    this.status.gestureMiddleRadiusDelta = null;
    this.status.gestureSampleGapMs = null;
    this.status.gestureContactFrames = 0;
    this.status.gestureReleaseFrames = 0;
    this.status.gestureCooldownRemainingMs = 0;
    this.status.gestureLandmarksUsable = false;
    this.status.handInferenceHz = 0;
    this.status.handInferenceInFlight = false;
    this.status.lastGestureApplied = null;
    this.status.effectActive = false;
    this.status.backgroundMismatch = false;
    this.status.usingBackgroundPlate = false;
  }

  getOriginalTrack(track: MediaStreamTrack): MediaStreamTrack | null {
    return this.outputs.get(track)?.source.track ?? (this.originals.has(track) ? track : null);
  }

  isProcessedTrack(track: MediaStreamTrack): boolean {
    return this.outputs.has(track);
  }

  get processedVideoTrack(): MediaStreamTrack | null {
    const source = this.activeSource;
    return [...(source?.leases ?? []), ...this.leases].find((lease) => !lease.released && lease.track.readyState === 'live')?.track ?? null;
  }

  get inputCameraTrack(): MediaStreamTrack | null {
    return this.activeSource?.track ?? null;
  }

  routeVideoTrack(track: MediaStreamTrack): MediaStreamTrack {
    if (!this.processingEnabled || this.isProcessedTrack(track)) return track;
    const source = this.sources.get(track);
    return source ? [...source.leases].find((lease) => lease.track.readyState === 'live')?.track ?? track : track;
  }

  /** Restore only known processed videos, preserving every exact audio object. */
  restoreOutputStreams(): number {
    let restored = 0;
    for (const stream of this.outputStreams) {
      for (const track of stream.getVideoTracks()) {
        const original = this.outputs.get(track)?.source.track;
        if (!original) continue;
        const source = this.outputs.get(track)!.source;
        source.preserveInput = true;
        stream.removeTrack(track);
        if (original.readyState === 'live' && !stream.getTracks().includes(original)) stream.addTrack(original);
        restored += 1;
      }
    }
    return restored;
  }

  restoreOriginalVideoTrack(): void {
    this.restoreOutputStreams();
  }

  /** Immediately cancel attaches/models; leave all outputs rendering live video. */
  suspend(): void {
    this.processingEnabled = false;
    this.status.siteEnabled = false;
    this.invalidateAttaches();
    for (const source of this.sources.values()) source.preserveInput = true;
    this.closeModels();
    this.cameraEnabled = false;
    this.resetSourceState();
    if (this.activeSource?.track.enabled && !this.activeSource.track.muted) this.safeLiveFrame(this.activeSource.video);
    else if (this.leases.size) this.drawCameraOff();
    this.updateRoute();
    this.emitStatus(true);
  }

  /**
   * Call suspend before async sender restoration. Only release outputs proved
   * unused; rejected replacements must remain in retainOutputs until stopped.
   * With no retainOutputs argument, deactivation safely keeps every output live.
   */
  deactivate(options: CameraDeactivationOptions = {}): void {
    const preserve = options.preserveInputs ?? true;
    const previousOwnership = new Map([...this.sources.values()].map((source) => [source, source.preserveInput]));
    this.suspend();
    if (!preserve) for (const [source, owned] of previousOwnership) source.preserveInput = owned;
    this.restoreOutputStreams();
    if (!preserve) for (const [source, owned] of previousOwnership) source.preserveInput = owned;
    if (options.retainOutputs !== undefined) {
      const retained = new Set(options.retainOutputs);
      for (const lease of [...this.leases]) if (!retained.has(lease.track)) lease.track.stop();
    }
    this.updateRoute();
    this.emitStatus(true);
  }

  // Kept for existing callers. releaseOutputAudio is intentionally a no-op:
  // audio is never owned by this video pipeline.
  stop(options: { releaseOutputAudio?: boolean; preserveInputVideo?: boolean } = {}): void {
    this.invalidateAttaches();
    if (options.preserveInputVideo) for (const source of this.sources.values()) source.preserveInput = true;
    for (const lease of [...this.leases]) lease.track.stop();
    if (!this.leases.size) this.finishConsumers();
    this.updateRoute();
    this.emitStatus(true);
  }

  /** Final owner teardown. Integrations must restore senders before using this. */
  dispose(): void {
    this.disposed = true;
    this.processingEnabled = false;
    this.stop();
    this.assetBaseUrl = '';
  }

  private invalidateAttaches(): void {
    this.lifecycle += 1;
    for (const controller of this.pendingAttaches) controller.abort();
  }

  private finishConsumers(): void {
    this.running = false;
    this.cancelFrame();
    this.closeModels();
    this.releaseCapture();
    for (const source of [...this.sources.values()]) {
      if (!source.preserveInput && source.track.readyState === 'live') source.track.stop();
      this.removeSource(source);
    }
    this.activeSource = null;
    this.outputStreams.clear();
    this.cameraEnabled = false;
    if (this.reloadRequired) this.status.error = null;
    this.reloadRequired = false;
    this.resetSourceState();
    this.status.cameraAvailable = false;
    this.status.pipelineInitialized = false;
  }

  private releaseCapture(): void {
    this.captureTrack?.stop();
    this.captureTrack = null;
  }

  setOutboundTracks(tracks: Iterable<MediaStreamTrack | null>): void {
    this.outboundTracks.clear();
    for (const track of tracks) if (track && this.getOriginalTrack(track)) this.outboundTracks.add(track);
    this.updateRoute();
    this.emitStatus(true);
  }

  markOutboundTrack(track: MediaStreamTrack | null): void {
    if (track && !this.getOriginalTrack(track)) return;
    if (track) this.outboundTracks.add(track);
    else this.outboundTracks.clear();
    this.updateRoute();
    this.emitStatus(true);
  }

  markOriginalFallback(): void {
    if (this.leases.size) return;
    this.status.cameraRoute = 'original';
    this.status.cameraAvailable = true;
    this.status.pipelineInitialized = false;
    this.status.message = 'The website is using the original camera because local processing was unavailable.';
    this.emitStatus(true);
  }

  setReloadRequired(required: boolean): void {
    this.reloadRequired = required;
    this.status.reloadRequired = required;
    if (!required && this.status.error?.startsWith('Reload required:')) this.status.error = null;
    this.updateRoute();
    this.emitStatus(true);
  }

  private updateRoute(): void {
    const outbound = [...this.outboundTracks].filter((track) => track.readyState === 'live');
    const processed = outbound.some((track) => this.isProcessedTrack(track));
    this.status.pipelineInitialized = this.processingEnabled && this.leases.size > 0;
    this.status.cameraRoute = processed ? 'outbound' : this.leases.size ? 'processed' : outbound.length ? 'original' : 'waiting';
    if (this.reloadRequired && this.leases.size) {
      this.status.error = 'Reload required: the website refused to restore a camera sender.';
      this.status.message = 'Effects are off. Live camera passthrough is retained until the website releases its track; reload to fully detach Veyl.';
    } else if (!this.processingEnabled) {
      this.status.message = this.leases.size ? 'Effects are off; the camera remains live in passthrough mode.' : 'Effects are off. The website owns its original camera.';
    } else {
      this.status.message = processed ? 'Processed camera track is attached to the website.' : this.leases.size ? 'Processed camera track is ready for the website.' : 'Waiting for the website camera';
    }
  }

  get currentStatus(): PipelineStatus {
    return { ...this.status, modelReady: this.segmenter.ready, backgroundAvailable: this.backgroundManager.ready };
  }

  async captureBackground(): Promise<BackgroundPlate> {
    const video = this.activeSource?.video;
    if (!video || !usableVideo(video)) throw new Error('Turn on the website camera before capturing a background.');
    if (this.status.effectActive) throw new Error('Reappear before capturing so the hidden frame is not saved.');
    const background = this.backgroundManager.capture(video, this.compositor.canvas.width, this.compositor.canvas.height);
    await this.backgroundManager.setPlate(background);
    this.status.backgroundMismatch = false;
    this.emitStatus(true);
    this.onEvent({ type: 'BACKGROUND_CAPTURED', background });
    return background;
  }

  async deleteBackground(): Promise<void> {
    await this.backgroundManager.setPlate(null);
    this.status.backgroundMismatch = false;
    this.emitStatus(true);
    this.onEvent({ type: 'BACKGROUND_DELETED' });
  }

  toggleEffect(): boolean {
    if (!this.cameraEnabled || !this.processedVideoTrack || !this.processingEnabled) return false;
    const now = performance.now();
    if (this.disappearance.state === 'reappearing') return false;
    if (now - this.lastToggleAt < 400) {
      this.status.gestureReason = 'effect-debounce-suppressed';
      return false;
    }
    this.lastToggleAt = now;
    const nextActive = !this.status.effectActive;
    const sourceVideo = this.activeSource?.video;
    if (!sourceVideo) return false;
    const transition = nextActive ? 'disappear' : 'reappear';
    const mask = this.latestMask && this.lastRenderedTimestamp - this.latestMaskAt <= 300 ? this.latestMask : null;
    this.compositor.beginDisintegration(
      sourceVideo,
      mask,
      this.settingsValue.animationIntensity,
      transition
    );
    this.disappearance.start(transition, this.settingsValue.animations ? (nextActive ? 760 : 360) : 1);
    this.status.effectActive = nextActive;
    this.status.message = this.status.effectActive ? this.hiddenMessage(mask) : 'You are visible again.';
    this.emitStatus(true);
    return true;
  }

  private canInfer(): boolean {
    const source = this.activeSource;
    return this.processingEnabled && this.running && !!source && source.track.readyState === 'live' &&
      source.track.enabled && !source.track.muted && usableVideo(source.video) &&
      [...this.leases].some((lease) => lease.track.readyState === 'live' && lease.track.enabled);
  }

  private updateActivity(): void {
    const enabled = this.canInfer();
    const changed = enabled !== this.cameraEnabled;
    if (changed) {
      this.cameraEnabled = enabled;
      if (!enabled) this.closeModels();
      else {
        this.modelFailed = false;
        this.handModelFailed = false;
      }
    }
    this.status.cameraAvailable = !!this.activeSource && this.activeSource.track.readyState === 'live' &&
      this.activeSource.track.enabled && !this.activeSource.track.muted;
    if (enabled) {
      void this.ensureModel();
      void this.ensureHandModel();
    }
    if (changed) this.emitStatus(true);
  }

  private closeSegmentation(): void {
    this.modelEpoch += 1;
    this.segmenter.close();
    this.latestMask = null;
    this.latestMaskAt = -Infinity;
    this.compositor.resetMask();
    this.status.modelReady = false;
  }

  private closeHands(): void {
    this.handEpoch += 1;
    this.handInferenceGeneration += 1;
    this.handDetector.close();
    this.lastHandInferenceAt = -Infinity;
    this.lastHandInferenceRequestAt = -Infinity;
    this.handInferenceInFlight = null;
    this.handInferenceSamples = 0;
    this.status.gestureDetectionActive = false;
    this.status.handTracked = false;
    this.status.gestureState = 'idle';
    this.status.gestureCandidate = false;
    this.status.gestureReleaseVelocity = 0;
    this.status.gestureFistScore = null;
    this.status.handInferenceMs = 0;
    this.status.handInferenceHz = 0;
    this.status.handInferenceInFlight = false;
    this.status.handInferenceOffloaded = false;
    this.status.handInferenceOffloadError = null;
    this.status.lastHandInferenceAt = null;
  }

  private closeModels(): void {
    this.closeSegmentation();
    this.closeHands();
  }

  private async ensureModel(): Promise<void> {
    if (!this.canInfer() || !this.assetBaseUrl || this.segmenter.ready || this.modelFailed) return;
    if (this.modelInit) return this.modelInit;
    const epoch = this.modelEpoch;
    const operation = (async () => {
      try {
        await this.segmenter.initialize(new URL('wasm/', this.assetBaseUrl).toString(), new URL('models/selfie_segmenter.tflite', this.assetBaseUrl).toString());
        if (epoch !== this.modelEpoch || !this.canInfer()) {
          this.segmenter.close();
          return;
        }
        this.status.modelReady = this.segmenter.ready;
        this.emitStatus(true);
      } catch (error) {
        if (epoch !== this.modelEpoch) return;
        this.modelFailed = true;
        this.latestMask = null;
        this.fail(`Segmentation could not start: ${toErrorMessage(error)}. Live camera fallback remains available.`);
      }
    })();
    this.modelInit = operation;
    try { await operation; } finally { if (this.modelInit === operation) this.modelInit = null; }
  }

  private async ensureHandModel(): Promise<void> {
    if (!this.canInfer() || !this.settingsValue.gestureDetection || !this.assetBaseUrl || this.handDetector.ready || this.handModelFailed) return;
    if (this.handModelInit) return this.handModelInit;
    const epoch = this.handEpoch;
    const operation = (async () => {
      try {
        const wasmUrl = new URL('wasm/', this.assetBaseUrl).toString();
        const modelUrl = new URL('models/hand_landmarker.task', this.assetBaseUrl).toString();
        try {
          await this.handDetector.initialize(wasmUrl, modelUrl);
        } catch (workerError) {
          if (!this.handWorkerSelected) throw workerError;
          // A site may block worker creation independently of its script/URL
          // policy. Preserve functionality with the existing main-thread path,
          // while leaving the worker failure visible in the console.
          console.warn('[Veyl] Hand worker unavailable; falling back to main-thread inference.', workerError);
          this.status.handInferenceOffloadError = toErrorMessage(workerError);
          this.handDetector.close();
          this.handDetector = new HandGestureDetector();
          this.handWorkerSelected = false;
          await this.handDetector.initialize(wasmUrl, modelUrl);
        }
        if (epoch !== this.handEpoch || !this.canInfer() || !this.settingsValue.gestureDetection) {
          this.handDetector.close();
          return;
        }
        this.status.gestureDetectionActive = this.handDetector.ready;
        this.emitStatus(true);
      } catch (error) {
        if (epoch !== this.handEpoch) return;
        this.handModelFailed = true;
        this.fail(`Hand gesture detection could not start: ${toErrorMessage(error)}. Manual controls remain available.`);
      }
    })();
    this.handModelInit = operation;
    try { await operation; } finally { if (this.handModelInit === operation) this.handModelInit = null; }
  }

  private scheduleFrame(): void {
    if (!this.running || this.frameTimer !== null) return;
    let finished = false;
    const frame = (timestamp: number) => {
      if (finished || !this.running) return;
      finished = true;
      this.cancelFrame();
      void this.renderFrame(timestamp).catch((error) => {
        this.latestMask = null;
        this.latestMaskAt = -Infinity;
        this.handInferenceGeneration += 1;
        this.handDetector.reset();
        if (this.activeSource) this.safeLiveFrame(this.activeSource.video);
        this.fail(`Camera processing recovered from a frame error: ${toErrorMessage(error)}`);
      }).finally(() => this.scheduleFrame());
    };
    const video = this.activeSource?.video;
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      this.scheduledVideo = video;
      this.videoFrameHandle = video.requestVideoFrameCallback(frame);
    } else {
      this.frameHandle = requestAnimationFrame(frame);
    }
    // Also poll lifecycle/enabled while video frames or animation frames stall.
    this.frameTimer = setTimeout(() => frame(performance.now()), 150);
  }

  private cancelFrame(): void {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    if (this.videoFrameHandle) this.scheduledVideo?.cancelVideoFrameCallback(this.videoFrameHandle);
    if (this.frameTimer !== null) clearTimeout(this.frameTimer);
    this.frameHandle = this.videoFrameHandle = 0;
    this.scheduledVideo = null;
    this.frameTimer = null;
  }

  private scheduleHandInference(video: HTMLVideoElement, timestamp: number, frameLifecycle: number, source: CameraSource): void {
    if (!this.settingsValue.gestureDetection || !this.handDetector.ready || this.handInferenceInFlight ||
      timestamp - this.lastHandInferenceRequestAt < this.handInferenceIntervalMs()) return;

    this.lastHandInferenceRequestAt = timestamp;
    const generation = this.handInferenceGeneration;
    this.status.handInferenceInFlight = true;
    // Worker inference can start immediately because its detector is async.
    // Defer the synchronous main-thread fallback by one microtask so a
    // segmentation/render pass is never entered from inside detector work.
    const detect = () => this.handDetector.detect(video, timestamp, this.settingsValue.gestureSensitivity, this.settingsValue.gestureCooldownMs);
    const detected = this.handWorkerSelected
      ? (() => {
        try { return Promise.resolve(detect()); } catch (error) { return Promise.reject(error); }
      })()
      : Promise.resolve().then(detect);
    let operation: Promise<void>;
    operation = detected
      .then((gesture) => this.applyHandResult(gesture, timestamp, frameLifecycle, generation, source))
      .catch((error) => this.handleHandInferenceError(error, generation))
      .finally(() => {
        if (this.handInferenceInFlight === operation) {
          this.handInferenceInFlight = null;
          this.status.handInferenceInFlight = false;
        }
      });
    this.handInferenceInFlight = operation;
  }

  private applyHandResult(
    gesture: HandGestureResult,
    timestamp: number,
    frameLifecycle: number,
    generation: number,
    source: CameraSource
  ): void {
    if (generation !== this.handInferenceGeneration || frameLifecycle !== this.lifecycle || !this.running ||
      !this.processingEnabled || this.activeSource !== source || !this.settingsValue.gestureDetection) return;
    this.status.handTracked = gesture.handTracked;
    this.status.gestureState = gesture.state;
    this.status.gestureCandidate = gesture.candidate;
    this.status.gestureReleaseVelocity = gesture.releaseVelocity;
    this.status.handInferenceMs = Number.isFinite(gesture.inferenceMs) ? Math.round(gesture.inferenceMs) : 0;
    this.status.handInferenceOffloaded = this.handDetector.offloaded;
    this.handInferenceSamples += 1;
    if (this.lastCompletedHandTimestamp !== -Infinity && timestamp > this.lastCompletedHandTimestamp) {
      this.status.handInferenceHz = Math.round((1000 / (timestamp - this.lastCompletedHandTimestamp)) * 10) / 10;
    }
    this.lastCompletedHandTimestamp = timestamp;
    this.status.lastHandInferenceAt = timestamp;
    if (gesture.diagnostics) {
      this.status.gestureReason = gesture.diagnostics.reason;
      this.status.gesturePinchDistance = gesture.diagnostics.pinchDistance;
      this.status.gestureFistScore = gesture.diagnostics.fistScore;
      this.status.gestureDistanceDelta = gesture.diagnostics.distanceDelta;
      this.status.gestureMiddleRadius = gesture.diagnostics.middleRadius;
      this.status.gestureMiddleRadiusDelta = gesture.diagnostics.middleRadiusDelta;
      this.status.gestureSampleGapMs = gesture.diagnostics.sampleGapMs;
      this.status.gestureContactFrames = gesture.diagnostics.contactFrames;
      this.status.gestureReleaseFrames = gesture.diagnostics.releaseFrames;
      this.status.gestureCooldownRemainingMs = gesture.diagnostics.cooldownRemainingMs;
      this.status.gestureLandmarksUsable = gesture.diagnostics.landmarksUsable;
    }
    if (this.status.error?.startsWith('A hand gesture frame was skipped:') || this.status.error?.startsWith('Hand worker failed:')) {
      this.status.error = null;
    }
    if (gesture.confirmed) {
      this.status.lastGestureAt = timestamp;
      const applied = this.toggleEffect();
      this.status.lastGestureApplied = applied;
      const kind = gesture.confirmedGesture ?? 'gesture';
      this.status.gestureReason = applied ? `confirmed-${kind}-effect-applied` : `confirmed-${kind}-effect-not-applied`;
      if (applied) this.onEvent({ type: 'GESTURE_DETECTED' });
    }
    this.emitStatus(true);
  }

  private handleHandInferenceError(error: unknown, generation: number): void {
    if (generation !== this.handInferenceGeneration) return;
    const message = toErrorMessage(error);
    if (this.handWorkerSelected) {
      this.status.handInferenceOffloadError = message;
      this.status.error = `Hand worker failed: ${message}. Switching to main-thread hand tracking.`;
      this.switchToMainThreadHandDetector(message);
      return;
    }
    this.handDetector.reset();
    this.status.gestureState = 'idle';
    this.status.gestureCandidate = false;
    this.status.gestureReleaseVelocity = 0;
    this.status.gestureFistScore = null;
    this.status.handTracked = false;
    this.status.gestureReason = 'inference-error';
    this.status.gestureLandmarksUsable = false;
    this.status.error = `A hand gesture frame was skipped: ${message}`;
    this.emitStatus(true);
  }

  private switchToMainThreadHandDetector(reason: string): void {
    if (!this.handWorkerSelected) return;
    this.handWorkerSelected = false;
    this.handEpoch += 1;
    this.handInferenceGeneration += 1;
    this.handDetector.close();
    this.handDetector = new HandGestureDetector();
    this.handModelFailed = false;
    this.status.handInferenceOffloadError = reason;
    if (this.canInfer() && this.settingsValue.gestureDetection) void this.ensureHandModel();
  }

  private async renderFrame(timestamp: number): Promise<void> {
    // Native input stop() has no ended event either; never rely on events alone.
    for (const lease of [...this.leases]) if (lease.track.readyState !== 'live') this.releaseLease(lease);
    if (!this.leases.size) return;
    this.selectSource();
    this.updateActivity();
    const source = this.activeSource;
    if (!source) {
      // A terminal native input cannot be restored or represented by a live
      // black canvas. End only the processed leases owned by that dead source;
      // unrelated live acquisitions have already been considered by selectSource().
      for (const lease of [...this.leases]) {
        if (lease.source.track.readyState !== 'live') lease.track.stop();
      }
      return;
    }
    if (!source.track.enabled || source.track.muted) {
      this.drawCameraOff();
      return;
    }
    const video = source.video;
    const frameLifecycle = this.lifecycle;
    if (!usableVideo(video)) return;
    if (![...this.leases].some((lease) => lease.track.enabled)) return;
    if (!this.processingEnabled) {
      this.drawLiveFrame(video);
      return;
    }
    if (this.compositor.canvas.width !== video.videoWidth || this.compositor.canvas.height !== video.videoHeight) {
      this.compositor.resize(video.videoWidth, video.videoHeight);
      this.resetSourceState();
    }

    let segmentationError = false;
    // Start hand inference before synchronous segmentation, but do not await it:
    // a slow mask frame must not delay the next camera frame or invalidate a
    // temporal hand sequence. Only one worker request is in flight at a time.
    this.scheduleHandInference(video, timestamp, frameLifecycle, source);
    if (this.segmenter.ready && this.performance.shouldInfer(timestamp)) {
      this.performance.beginInference(timestamp);
      const started = performance.now();
      try {
        const mask = this.segmenter.segment(video, timestamp);
        this.latestMask = validMask(mask) ? mask : null;
        this.latestMaskAt = this.latestMask ? timestamp : -Infinity;
        if (this.status.error?.startsWith('A segmentation frame was skipped:')) this.status.error = null;
      } catch (error) {
        segmentationError = true;
        this.latestMask = null;
        this.latestMaskAt = -Infinity;
        this.status.error = `A segmentation frame was skipped: ${toErrorMessage(error)}`;
      }
      this.performance.recordInference(performance.now() - started);
    }
    const effectFrame = this.disappearance.sample(timestamp);
    const strength = effectFrame.visibility;
    const freshMask = this.latestMask && timestamp - this.latestMaskAt <= 300 ? this.latestMask : null;
    this.lastRenderedTimestamp = timestamp;
    const normalLivePassthrough = !this.settingsValue.realTimeRemoval && effectFrame.state === 'none';
    if (segmentationError || normalLivePassthrough) this.drawLiveFrame(video);
    else {
      this.compositor.render(video, this.backgroundManager, freshMask, {
        hidden: effectFrame.state !== 'none' && strength > 0,
        transitionStrength: strength,
        realTimeRemoval: this.settingsValue.realTimeRemoval,
        useBackgroundPlate: this.settingsValue.useBackgroundPlate,
        effectState: effectFrame.state,
        backgroundMismatch: this.status.backgroundMismatch
      });
      if (this.settingsValue.animations) this.compositor.renderDisintegration(this.compositor.canvas.getContext('2d')!, effectFrame);
    }
    this.performance.recordFrame(timestamp);
    if (this.backgroundManager.ready && timestamp - this.lastMismatchCheck > 1800 && !this.mismatchCheckPending) {
      this.lastMismatchCheck = timestamp;
      this.mismatchCheckPending = true;
      const lifecycle = this.lifecycle;
      void this.backgroundManager.compareToVideo(video, this.compositor.canvas.width, this.compositor.canvas.height)
        .then((mismatch) => {
          if (this.activeSource === source && lifecycle === this.lifecycle && this.processingEnabled) this.status.backgroundMismatch = mismatch;
        }).catch(() => undefined).finally(() => { this.mismatchCheckPending = false; });
    }
    this.status.gestureDetectionActive = this.settingsValue.gestureDetection && this.handDetector.ready;
    const usingLiveRemovalPlate = this.settingsValue.realTimeRemoval && effectFrame.state === 'none' && !!freshMask;
    const usingEffectPlate = strength > 0;
    this.status.usingBackgroundPlate = !segmentationError && (usingLiveRemovalPlate || usingEffectPlate) &&
      this.settingsValue.useBackgroundPlate && this.backgroundManager.ready && !this.status.backgroundMismatch;
    this.status.fps = this.performance.getFps();
    this.status.inferenceMs = this.performance.getInferenceMs();
    if (this.status.effectActive && !segmentationError) this.status.message = this.hiddenMessage(freshMask);
    if (timestamp - this.lastStatusSent > 450) this.emitStatus();
  }

  private drawLiveFrame(video: HTMLVideoElement): void {
    if (!usableVideo(video)) throw new Error('The camera has not supplied a usable video frame.');
    this.compositor.resize(video.videoWidth, video.videoHeight);
    const context = this.compositor.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D rendering is unavailable.');
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
    context.drawImage(video, 0, 0, this.compositor.canvas.width, this.compositor.canvas.height);
  }

  private safeLiveFrame(video: HTMLVideoElement): void {
    try { this.drawLiveFrame(video); } catch { /* Keep the last valid frame during a transient decode gap. */ }
  }

  private drawCameraOff(): void {
    const context = this.compositor.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
    context.fillStyle = '#000';
    context.fillRect(0, 0, this.compositor.canvas.width, this.compositor.canvas.height);
  }

  private hiddenMessage(mask: SegmentationFrame | null = this.latestMask): string {
    if (!this.settingsValue.useBackgroundPlate || !this.backgroundManager.ready) return 'No clean plate is available; live pixels are softened instead of reconstructed.';
    if (this.status.backgroundMismatch) return 'Background mismatch detected — recapture for a cleaner effect.';
    if (!this.segmenter.ready) return 'Waiting for segmentation; the captured plate is being used safely.';
    if (!mask) return 'Waiting for a recent person mask; the captured plate is being used safely.';
    return 'You are hidden locally. Use the control or hand gesture again to reappear.';
  }

  private handInferenceIntervalMs(): number {
    const base = (() => {
      switch (this.settingsValue.performanceMode) {
        case 'quality': return 50;
        case 'performance': return 100;
        case 'balanced': return 66;
      }
    })();
    // The first real inference can include GPU/kernel warm-up. Do not turn
    // that one-time cost into a multi-second cadence, but avoid asking a
    // synchronous fallback detector to run faster than its measured duration.
    if (this.handInferenceSamples < 2 || !Number.isFinite(this.status.handInferenceMs) || this.status.handInferenceMs <= 0) return base;
    return Math.max(base, Math.ceil(this.status.handInferenceMs * 1.2));
  }

  private emitStatus(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastStatusSent < 300) return;
    this.lastStatusSent = now;
    this.onEvent({ type: 'STATUS', status: this.currentStatus });
  }

  private fail(message: string): void {
    this.status.error = message;
    this.status.message = message;
    this.onEvent({ type: 'ERROR', error: message });
    this.emitStatus(true);
  }
}

function usableVideo(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

function validMask(mask: SegmentationFrame | null): mask is SegmentationFrame {
  return !!mask && mask.width > 0 && mask.height > 0 && mask.data.length === mask.width * mask.height && mask.data.every(Number.isFinite);
}

function detachVideo(video: HTMLVideoElement): void {
  video.pause();
  video.srcObject = null;
}

function defineDefensively(target: object, name: string, value: unknown): void {
  try { Object.defineProperty(target, name, { configurable: true, writable: true, value }); } catch { /* Some hosts seal optional metadata methods. */ }
}

function safeRead<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

async function waitForVideo(video: HTMLVideoElement, timeoutMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const events = ['loadeddata', 'canplay', 'playing', 'resize'];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(poll);
      for (const event of events) video.removeEventListener(event, check);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (usableVideo(video)) finish();
    };
    const aborted = () => finish(new Error('Camera preparation was cancelled.'));
    const timeout = setTimeout(() => finish(new Error('The camera did not supply a usable video frame in time.')), timeoutMs);
    const tick = () => {
      check();
      if (!settled) poll = setTimeout(tick, 20);
    };
    for (const event of events) video.addEventListener(event, check);
    signal.addEventListener('abort', aborted, { once: true });
    // play() itself may never settle. It shares the same bounded frame deadline.
    try { void Promise.resolve(video.play()).then(check, () => undefined); } catch { /* Wait for an actual frame, not autoplay's promise. */ }
    if (signal.aborted) aborted(); else tick();
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
